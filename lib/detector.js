/**
 * Detector service — long-lived, owned by the plugin.
 *
 * Why a service instead of an in-process watcher: the plugin can read the
 * notification store inside DSH, but nothing inside DSH can *wake a model turn*
 * on its own. So the detection half runs as a process that is always listening,
 * and the agent half polls it. The service is started and stopped by the plugin,
 * so it is not a separate thing for the user to manage.
 *
 * Responsibilities
 *   watch   poll the notification store; a new record is queued immediately
 *   scan    every `intervalMinutes`, also read the screen (catches muted chats)
 *   serve   expose the queue over a loopback HTTP API
 *
 * The queue is persisted, so a restart does not lose unread messages.
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MessageNotifier } from './notifier.js'
import { MessageDedupe, shouldReply } from './dedupe.js'
import { contentKey } from './dedupe.js'

const QUEUE_VERSION = 1

export class DetectorService {
  /**
   * @param {object} options
   * @param {string} options.stateDir       where the queue and token live
   * @param {(reason: string) => Promise<object>} options.readScreen  screen fallback reader
   * @param {object} options.policy         atKeywords / jargonKeywords / probability
   * @param {string} options.expectedGroup
   * @param {number} [options.port]         0 = ephemeral
   * @param {number} [options.scanIntervalMinutes]
   */
  constructor(options) {
    this.stateDir = options.stateDir
    this.readScreen = options.readScreen
    this.policy = options.policy || {}
    this.expectedGroup = options.expectedGroup || ''
    this.port = options.port ?? 0
    this.notificationEnabled = options.notificationEnabled !== false
    this.scanEnabled = options.scanEnabled !== false
    this.scanIntervalMinutes = Math.max(1, options.scanIntervalMinutes ?? 5)

    this.queuePath = join(this.stateDir, 'queue.json')
    this.metaPath = join(this.stateDir, 'detector.json')

    this.notifier = new MessageNotifier()
    this.dedupe = new MessageDedupe()
    this.server = null
    this.scanTimer = null
    this.startedAt = null
    this.stats = { queued: 0, scanned: 0, served: 0, lastError: null, lastEventAt: null }
    // Called with the messages just queued, so the plugin can start a turn.
    this.onQueued = null
    // The first sweep after start records what already exists; it must not fire
    // a turn, or starting the service replays the whole backlog at once.
    this.baselineDone = false
    this.columns = { notifications: 0, screen: 0 }

    mkdirSync(this.stateDir, { recursive: true })
    this.queue = this.loadQueue()
    // Seed the dedupe set from the persisted queue. Without this a restart
    // re-queues everything already waiting: the watcher is fresh, so the first
    // scan sees the same messages as new and the queue grows on every restart.
    if (this.queue.length > 0) {
      this.dedupe.seed(this.queue)
      // Keep the per-column counts meaningful across restarts.
      for (const m of this.queue) {
        if (m.source === 'scan') this.columns.screen += 1
        else this.columns.notifications += 1
      }
    }
  }

  // ------------------------------------------------------------ persistence

  loadQueue() {
    try {
      if (!existsSync(this.queuePath)) return []
      const data = JSON.parse(readFileSync(this.queuePath, 'utf8'))
      if (data.version !== QUEUE_VERSION) return []
      return Array.isArray(data.messages) ? data.messages : []
    } catch {
      return []
    }
  }

  saveQueue() {
    try {
      writeFileSync(this.queuePath, JSON.stringify({ version: QUEUE_VERSION, messages: this.queue }, null, 2), 'utf8')
    } catch (error) {
      this.stats.lastError = `queue save: ${error.message}`
    }
  }

  saveMeta() {
    try {
      writeFileSync(this.metaPath, JSON.stringify({
        port: this.port,
        url: this.url,
        startedAt: this.startedAt,
        scanIntervalMinutes: this.scanIntervalMinutes,
        stats: this.stats,
        columns: this.columns,
      }, null, 2), 'utf8')
    } catch { /* best effort */ }
  }

  // ---------------------------------------------------------------- queue

  /**
   * Queue messages that pass dedupe and relevance.
   *
   * Relevance means the configured group: a bot pointed at one chat must not
   * answer another, and the screen scan sees everything on display.
   */
  enqueue(messages, source) {
    let added = 0
    for (const raw of messages || []) {
      // The bot's own bubbles come back from a screen read; answering them would
      // be talking to itself.
      if (raw.own === true) continue
      const msg = { ...raw, source, queuedAt: Date.now() }
      if (this.expectedGroup) {
        const group = String(msg.groupName || '')
        const aliases = [this.expectedGroup, ...(this.policy.whitelistGroups || [])]
        const relevant = aliases.some((name) => {
          const a = normalize(name)
          const g = normalize(group)
          return Boolean(a && g && (g.includes(a) || a.startsWith(g)))
        })
        if (!relevant) continue
      }
      if (!this.dedupe.claim(msg)) continue
      const decision = shouldReply(msg, this.policy)
      this.queue.push({ ...msg, decision })
      added += 1
    }
    if (added > 0) {
      // Bound the in-memory queue; the agent drains it, but a wedged consumer
      // must not grow the file without limit.
      if (this.queue.length > 500) this.queue = this.queue.slice(-500)
      this.saveQueue()
      this.stats.queued += added
      this.stats.lastEventAt = Date.now()
      if (this.onQueued && this.baselineDone) {
        try {
          this.onQueued(this.queue.slice(-added))
        } catch (error) {
          this.stats.lastError = `onQueued: ${error.message}`
        }
      }
    }
    return added
  }

  /** Take everything, leaving the queue empty. */
  drain() {
    const out = this.queue.slice()
    this.queue = []
    this.saveQueue()
    return out
  }

  // -------------------------------------------------------------- sources

  /** Notification half: a new record means a new message. */
  async pollNotifications() {
    const recent = await this.notifier.read({ limit: 30, sinceSeconds: 300 })
    this.columns.notifications += this.enqueue(recent, 'notification')
  }

  /** Scan half: read the screen on a fixed interval. */
  async scan(reason = 'scan') {
    this.stats.scanned += 1
    try {
      const read = await this.readScreen(reason)
      const added = this.enqueue(read?.messages ?? [], 'scan')
      this.columns.screen += added
      this.saveMeta()
      return added
    } catch (error) {
      this.stats.lastError = `scan: ${error.message}`
      return 0
    }
  }

  // ----------------------------------------------------------------- http

  /**
   * Loopback-only API.
   *
   * The token exists so another local process cannot drain messages by guessing
   * the port; it is written next to the queue for the plugin to read.
   */
  async startServer() {
    this.token = randomToken()
    this.server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }

      if (url.pathname !== '/health' && req.headers['x-dsh-wechatbot'] !== this.token) {
        send(401, { ok: false, error: 'unauthorized' })
        return
      }

      if (url.pathname === '/health') {
        send(200, { ok: true, startedAt: this.startedAt, stats: this.stats, columns: this.columns })
        return
      }
      if (url.pathname === '/queue') {
        this.stats.served += 1
        if (req.method === 'POST' && url.searchParams.get('drain') === '1') {
          send(200, { ok: true, messages: this.drain() })
          return
        }
        send(200, { ok: true, count: this.queue.length, messages: this.queue })
        return
      }
      if (url.pathname === '/scan' && req.method === 'POST') {
        this.scan().then((added) => send(200, { ok: true, added, queued: this.queue.length }))
        return
      }
      send(404, { ok: false, error: 'not found' })
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port
        this.url = `http://127.0.0.1:${this.port}`
        resolve()
      })
    })
    this.saveMeta()
  }

  // ------------------------------------------------------------ lifecycle

  async start() {
    if (this.startedAt) return { alreadyRunning: true, url: this.url }
    this.startedAt = Date.now()

    await this.startServer()

    if (this.notificationEnabled) {
      await this.notifier.resolveAppId()
      this.notifier.onMessage(() => {
        this.pollNotifications().catch((error) => { this.stats.lastError = error.message })
      })
      this.notifier.start()
      await this.pollNotifications().catch(() => {})
    }
    if (this.scanEnabled) {
      // Seed the visible history before the first scheduled scan.
      try {
        const read = await this.readScreen('baseline')
        this.dedupe.seed(read?.messages ?? [])
      } catch (error) {
        this.stats.lastError = `baseline screen: ${error.message}`
      }
      this.scanTimer = setInterval(() => {
        this.scan().catch(() => {})
      }, this.scanIntervalMinutes * 60 * 1000)
      this.scanTimer.unref?.()
    }
    this.baselineDone = true

    this.saveMeta()
    return { started: true, url: this.url, scanIntervalMinutes: this.scanIntervalMinutes }
  }

  async stop() {
    this.notifier.stop()
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve))
      this.server = null
    }
    this.startedAt = null
    this.saveMeta()
    return { stopped: true }
  }

  status() {
    return {
      running: Boolean(this.startedAt),
      url: this.url,
      port: this.port,
      startedAt: this.startedAt,
      scanIntervalMinutes: this.scanIntervalMinutes,
      queued: this.queue.length,
      notificationMode: this.notificationEnabled ? this.notifier.mode : 'off',
      scanEnabled: this.scanEnabled,
      columns: this.columns,
      stats: this.stats,
    }
  }
}

function normalize(text) {
  return String(text || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

function randomToken() {
  // Not a credential: it only separates this process from an unrelated local one.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export { contentKey }
