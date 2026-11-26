/**
 * Notification-source WeChat messages (macOS & Windows).
 *
 * macOS storage:
 *   ~/Library/Group Containers/group.com.apple.usernoted/db2/db
 *   Each `record.data` is a binary plist whose `req` dictionary holds titl/body/cate/iden.
 *
 * Windows storage:
 *   %LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db
 *   Each `Notification.Payload` is Toast XML whose `<text>` nodes hold title and body,
 *   linked to `NotificationHandler.PrimaryId` (`Weixin` / `WeChat`).
 */

import { existsSync, readdirSync, watch } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const NOTIFICATION_DB = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db')
  : join(homedir(), 'Library/Group Containers/group.com.apple.usernoted/db2/db')

/** Apple epoch (2001-01-01) offset in seconds. */
const APPLE_EPOCH_OFFSET = 978307200

/** Windows FILETIME (1601-01-01) offset in 100-ns intervals. */
const WIN_FILETIME_EPOCH_TICKS = '116444736000000000'

const MAC_READER_SCRIPT = `
import sqlite3, plistlib, json, sys
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8")
db, app_id, limit, since = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = con.execute(
    "SELECT rec_id, delivered_date, data FROM record "
    "WHERE app_id = ? AND delivered_date >= ? ORDER BY delivered_date DESC LIMIT ?",
    (app_id, since, limit),
).fetchall()
out = []
for rec_id, delivered, blob in rows:
    try:
        p = plistlib.loads(bytes(blob))
        req = p.get("req", {}) or {}
        out.append({
            "recId": rec_id,
            "delivered": delivered + ${APPLE_EPOCH_OFFSET},
            "title": req.get("titl"),
            "body": req.get("body"),
            "category": req.get("cate"),
            "identifier": req.get("iden"),
        })
    except Exception:
        continue
print(json.dumps(out, ensure_ascii=False))
`

const MAC_SNAPSHOT_SCRIPT = `
import sqlite3, json, sys
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8")
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
rows = con.execute(
    "SELECT rec_id FROM record WHERE app_id = ? ORDER BY delivered_date DESC LIMIT ?",
    (int(sys.argv[2]), int(sys.argv[3])),
).fetchall()
print(json.dumps([r[0] for r in rows]))
`

const MAC_APP_ID_SCRIPT = `
import sqlite3, sys
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8")
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
row = con.execute("SELECT app_id FROM app WHERE identifier = ?", (sys.argv[2],)).fetchone()
print(row[0] if row else "")
`

const WIN_HANDLER_FILTER = `
def is_wechat_handler(primary_id, wanted):
    s = (primary_id or "").lower()
    if not s:
        return False
    if wanted and wanted.lower() not in ("com.tencent.xinwechat", "weixin", "wechat"):
        return wanted.lower() in s
    if any(ex in s for ex in ("yourphone", "microsoftedge", "chrome", "firefox", "weixinshare", "mpkf.weixin")):
        return False
    return any(k in s for k in ("weixin", "wechat", "xinwechat"))
`

const WIN_READER_SCRIPT = `
import sqlite3, xml.etree.ElementTree as ET, json, sys
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8")
${WIN_HANDLER_FILTER}
db, wanted, limit, since_epoch = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
since_ft = int(since_epoch * 10000000) + ${WIN_FILETIME_EPOCH_TICKS}
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
handlers = [
    r[0] for r in con.execute("SELECT RecordId, PrimaryId FROM NotificationHandler").fetchall()
    if is_wechat_handler(r[1], wanted)
]
out = []
if handlers:
    q_marks = ",".join("?" for _ in handlers)
    rows = con.execute(
        f"SELECT Id, ArrivalTime, Type, Payload FROM Notification "
        f"WHERE HandlerId IN ({q_marks}) AND ArrivalTime >= ? "
        f"ORDER BY ArrivalTime DESC LIMIT ?",
        (*handlers, since_ft, limit),
    ).fetchall()
    for rec_id, arrival, ntype, payload in rows:
        try:
            xml_str = payload.decode("utf-8", "replace") if isinstance(payload, (bytes, bytearray)) else str(payload or "")
            if not xml_str.strip():
                continue
            root = ET.fromstring(xml_str)
            texts = [(el.text or "").strip() for el in root.iter("text")]
            texts = [t for t in texts if t]
            if not texts:
                continue
            title = texts[0]
            body = "\\n".join(texts[1:]) if len(texts) > 1 else ""
            delivered = (int(arrival) - ${WIN_FILETIME_EPOCH_TICKS}) / 10000000.0
            out.append({
                "recId": rec_id,
                "delivered": delivered,
                "title": title,
                "body": body,
                "category": ntype or "toast",
                "identifier": f"win-{rec_id}",
            })
        except Exception:
            continue
print(json.dumps(out, ensure_ascii=False))
`

const WIN_SNAPSHOT_SCRIPT = `
import sqlite3, json, sys
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8")
${WIN_HANDLER_FILTER}
db, wanted, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
handlers = [
    r[0] for r in con.execute("SELECT RecordId, PrimaryId FROM NotificationHandler").fetchall()
    if is_wechat_handler(r[1], wanted)
]
if not handlers:
    print("[]")
else:
    q_marks = ",".join("?" for _ in handlers)
    rows = con.execute(
        f"SELECT Id FROM Notification WHERE HandlerId IN ({q_marks}) ORDER BY ArrivalTime DESC LIMIT ?",
        (*handlers, limit),
    ).fetchall()
    print(json.dumps([r[0] for r in rows]))
`

const WIN_APP_ID_SCRIPT = `
import sqlite3, sys
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8")
${WIN_HANDLER_FILTER}
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
handlers = [
    r[0] for r in con.execute("SELECT RecordId, PrimaryId FROM NotificationHandler").fetchall()
    if is_wechat_handler(r[1], sys.argv[2])
]
print(handlers[0] if handlers else "")
`

async function runPython(script, args, timeout = 12_000) {
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']
  let lastError
  for (const bin of candidates) {
    try {
      return await execFileAsync(bin, ['-c', script, ...args], {
        timeout,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      lastError = error
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw lastError
}

/** Whether this process may attach a directory watcher. */
function canWatch(dir) {
  try {
    readdirSync(dir)
    return true
  } catch {
    return false
  }
}

/**
 * Split `sender: text`. WeChat also emits system-shaped notifications for
 * mentions, e.g. "张三在群聊中@了你" — those carry no message text, so the caller
 * knows to read the screen instead.
 */
export function splitNotificationBody(body) {
  const raw = String(body || '').trim()

  const mention = raw.match(/^(.{1,32}?)在群聊中@了你$/)
  if (mention) {
    return { sender: mention[1].trim(), content: '', isMention: true, needsOcr: true, mentionNotice: raw }
  }
  const atYou = raw.match(/^(.{1,32}?)[:：]?\s*@了你/)
  if (atYou) {
    return { sender: atYou[1].trim(), content: '', isMention: true, needsOcr: true, mentionNotice: raw }
  }

  // Strip WeChat unread count prefix like "[3条] 张三: 你好"
  const stripped = raw.replace(/^\[(\d+条?)\]\s*/, '')
  const idx = stripped.search(/[:：]/)
  if (idx <= 0 || idx > 32) return { sender: '', content: stripped, isMention: false }
  return {
    sender: stripped.slice(0, idx).trim(),
    content: stripped.slice(idx + 1).trim(),
    isMention: false,
  }
}

/**
 * True when the text addresses the bot by one of its aliases.
 */
export function mentionsBot(text, atKeywords = ['@豆包', '豆包']) {
  const raw = String(text || '')
  if (!raw) return false
  return atKeywords.some((kw) => {
    const token = String(kw)
    const alias = token.replace(/^@/, '')
    if (!alias) return false
    if (token.startsWith('@') && raw.includes(token)) return true
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[\\s@])${escaped}($|[\\s，。！？、,.!?])`).test(raw)
  })
}

export class MessageNotifier {
  /**
   * @param {object} options
   * @param {string} [options.dbPath]
   * @param {number} [options.appId]
   * @param {string} [options.appIdentifier]
   * @param {string} [options.platform]
   * @param {number} [options.debounceMs] coalesce bursts of writes
   */
  constructor(options = {}) {
    this.platform = options.platform || process.platform
    this.dbPath = options.dbPath || (this.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db')
      : join(homedir(), 'Library/Group Containers/group.com.apple.usernoted/db2/db'))
    this.appId = options.appId ?? 64
    this.appIdentifier = options.appIdentifier || (this.platform === 'win32' ? 'Weixin' : 'com.tencent.xinwechat')
    this.debounceMs = options.debounceMs ?? 250

    this.watcher = null
    this.interval = null
    this.timer = null
    this.mode = null
    this.listeners = new Set()
    this.lastSnapshot = null
    this.stats = { checks: 0, fired: 0, lastFireAt: null, lastError: null }
  }

  get available() {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return false
    try {
      if (this.platform === 'win32') return existsSync(this.dbPath)
      readdirSync(dirname(this.dbPath))
      return true
    } catch {
      return false
    }
  }

  async resolveAppId() {
    try {
      const script = this.platform === 'win32' ? WIN_APP_ID_SCRIPT : MAC_APP_ID_SCRIPT
      const { stdout } = await runPython(script, [this.dbPath, this.appIdentifier], 10_000)
      const trimmed = String(stdout).trim()
      if (trimmed) {
        const id = Number(trimmed)
        if (Number.isFinite(id)) this.appId = id
      }
    } catch { /* keep the configured id */ }
    return this.appId
  }

  /** Recent messages, newest first. */
  async read({ limit = 50, sinceSeconds = 3600 } = {}) {
    if (!this.available) return []
    let stdout = ''
    if (this.platform === 'win32') {
      const sinceEpoch = Date.now() / 1000 - sinceSeconds
      const res = await runPython(
        WIN_READER_SCRIPT,
        [this.dbPath, this.appIdentifier, String(limit), String(sinceEpoch)],
        15_000,
      )
      stdout = res.stdout
    } else {
      const since = Date.now() / 1000 - sinceSeconds - APPLE_EPOCH_OFFSET
      const res = await runPython(
        MAC_READER_SCRIPT,
        [this.dbPath, String(this.appId), String(limit), String(since)],
        15_000,
      )
      stdout = res.stdout
    }

    let rows = []
    try {
      rows = JSON.parse(String(stdout).trim() || '[]')
    } catch {
      return []
    }
    return rows.map((row) => {
      const { sender, content, isMention, needsOcr, mentionNotice } = splitNotificationBody(row.body)
      return {
        groupName: row.title || '',
        sender,
        content,
        isAtMe: isMention === true,
        needsOcr: needsOcr === true,
        mentionNotice: mentionNotice || undefined,
        deliveredAt: Math.round(row.delivered * 1000),
        notificationId: row.identifier || `rec-${row.recId}`,
        category: row.category || '',
        fingerprint: createHash('md5')
          .update(`${row.identifier || row.recId}::${sender}::${content}`)
          .digest('hex'),
      }
    })
  }

  /** Newest record ids. */
  async readSnapshot(limit = 8) {
    if (!this.available) return []
    const script = this.platform === 'win32' ? WIN_SNAPSHOT_SCRIPT : MAC_SNAPSHOT_SCRIPT
    const keyArg = this.platform === 'win32' ? this.appIdentifier : String(this.appId)
    const { stdout } = await runPython(script, [this.dbPath, keyArg, String(limit)], 10_000)
    try {
      const ids = JSON.parse(String(stdout).trim() || '[]')
      return Array.isArray(ids) ? ids : []
    } catch {
      return []
    }
  }

  onMessage(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async check() {
    this.stats.checks += 1
    let snapshot
    try {
      snapshot = await this.readSnapshot()
    } catch (error) {
      this.stats.lastError = error.message
      return
    }
    if (this.lastSnapshot === null) {
      this.lastSnapshot = snapshot
      return
    }
    const previous = new Set(this.lastSnapshot)
    const added = snapshot.filter((id) => !previous.has(id))
    this.lastSnapshot = snapshot
    if (added.length === 0) return

    this.stats.fired += 1
    this.stats.lastFireAt = Date.now()
    for (const listener of this.listeners) {
      try {
        await listener({ addedRecordIds: added })
      } catch (error) {
        this.stats.lastError = error.message
      }
    }
  }

  schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.check().catch(() => {})
    }, this.debounceMs)
    this.timer.unref?.()
  }

  start(intervalMs = 1000) {
    if (this.watcher || this.interval) return
    if (!this.available) {
      this.stats.lastError = 'notification store not readable from this process'
      return
    }
    this.lastSnapshot = null
    const dir = dirname(this.dbPath)
    const dbBase = basename(this.dbPath)

    if (!canWatch(dir)) {
      this.stats.lastError = 'directory not watchable; polling instead'
      this.startPolling(intervalMs)
      return
    }

    try {
      this.watcher = watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename) return
        const changed = String(filename)
        if (changed !== dbBase && !changed.startsWith(`${dbBase}-`)) return
        this.schedule()
      })
      this.watcher.on('error', () => {
        try { this.watcher?.close() } catch { /* ignore */ }
        this.watcher = null
        this.startPolling(intervalMs)
      })
      this.mode = 'watch'
      this.check().catch(() => {})
    } catch {
      this.watcher = null
      this.startPolling(intervalMs)
    }
  }

  startPolling(intervalMs = 1000) {
    if (this.interval) return
    this.check().catch(() => {})
    this.interval = setInterval(() => {
      this.check().catch(() => {})
    }, intervalMs)
    this.interval.unref?.()
    this.mode = 'poll'
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (this.watcher) {
      try { this.watcher.close() } catch { /* ignore */ }
      this.watcher = null
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.mode = null
  }
}
