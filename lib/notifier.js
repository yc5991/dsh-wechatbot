/**
 * Notification-source WeChat messages.
 *
 * One module owns both halves of "notify me when a message arrives": reading the
 * OS notification store, and watching it so a new record fires the plugin
 * immediately. Previously these lived in separate files with a standalone daemon
 * between them.
 *
 * macOS storage: ~/Library/Group Containers/group.com.apple.usernoted/db2/db
 * Each `record.data` is a binary plist whose `req` dictionary holds titl/body/cate/iden.
 */

import { readdirSync, watch } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const NOTIFICATION_DB = join(
  homedir(),
  'Library/Group Containers/group.com.apple.usernoted/db2/db',
)

/** Apple epoch (2001-01-01) offset in seconds. */
const APPLE_EPOCH_OFFSET = 978307200

const READER_SCRIPT = `
import sqlite3, plistlib, json, sys
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

const SNAPSHOT_SCRIPT = `
import sqlite3, json, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
rows = con.execute(
    "SELECT rec_id FROM record WHERE app_id = ? ORDER BY delivered_date DESC LIMIT ?",
    (int(sys.argv[2]), int(sys.argv[3])),
).fetchall()
print(json.dumps([r[0] for r in rows]))
`

const APP_ID_SCRIPT = `
import sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
row = con.execute("SELECT app_id FROM app WHERE identifier = ?", (sys.argv[2],)).fetchone()
print(row[0] if row else "")
`

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

  const idx = raw.search(/[:：]/)
  if (idx <= 0 || idx > 32) return { sender: '', content: raw, isMention: false }
  return {
    sender: raw.slice(0, idx).trim(),
    content: raw.slice(idx + 1).trim(),
    isMention: false,
  }
}

/**
 * True when the text addresses the bot by one of its aliases.
 *
 * A bare name inside a sentence ("豆包是广东的") is not an address, so the alias
 * must be an @ token or stand alone between delimiters.
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
   * @param {number} [options.debounceMs] coalesce bursts of writes
   */
  constructor(options = {}) {
    this.dbPath = options.dbPath || NOTIFICATION_DB
    this.appId = options.appId ?? 64
    this.appIdentifier = options.appIdentifier || 'com.tencent.xinwechat'
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
    if (process.platform !== 'darwin') return false
    try {
      readdirSync(dirname(this.dbPath))
      return true
    } catch {
      return false
    }
  }

  async resolveAppId() {
    try {
      const { stdout } = await execFileAsync(
        'python3',
        ['-c', APP_ID_SCRIPT, this.dbPath, this.appIdentifier],
        { timeout: 10_000 },
      )
      const id = Number(String(stdout).trim())
      if (Number.isFinite(id)) this.appId = id
    } catch { /* keep the configured id */ }
    return this.appId
  }

  /** Recent messages, newest first. */
  async read({ limit = 50, sinceSeconds = 3600 } = {}) {
    const since = Date.now() / 1000 - sinceSeconds - APPLE_EPOCH_OFFSET
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', READER_SCRIPT, this.dbPath, String(this.appId), String(limit), String(since)],
      { timeout: 15_000 },
    )
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

  /**
   * Newest record ids.
   *
   * A MAX(rec_id) comparison is wrong here: the store has a fixed capacity and
   * rotates, so ids are recycled and the maximum can move backwards. Comparing a
   * small set detects arrivals either way.
   */
  async readSnapshot(limit = 8) {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', SNAPSHOT_SCRIPT, this.dbPath, String(this.appId), String(limit)],
      { timeout: 10_000 },
    )
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

  /**
   * Start watching.
   *
   * `fs.watch` fails with EPERM under a LaunchAgent — the notification directory
   * is protected and a LaunchAgent does not inherit a terminal's privacy grants —
   * and the failure arrives asynchronously, so a try/catch cannot contain it.
   * The directory is probed first, and an interval poll of one indexed query is
   * the fallback.
   */
  start(intervalMs = 1000) {
    if (this.watcher || this.interval) return
    if (!this.available) {
      this.stats.lastError = 'notification store not readable from this process'
      return
    }
    this.lastSnapshot = null
    const dir = dirname(this.dbPath)

    if (!canWatch(dir)) {
      this.stats.lastError = 'directory not watchable; polling instead'
      this.startPolling(intervalMs)
      return
    }

    try {
      this.watcher = watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename) return
        if (!/^db(-wal|-shm)?$/.test(String(filename))) return
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
