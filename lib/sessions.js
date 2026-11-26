/**
 * Conversation windows for the bot.
 *
 * One WeChat conversation window maps to one DSH session, not one message to one
 * session: a burst of chatter needs shared context, and a session per message
 * would leave the sidebar full and the bot unable to follow a thread.
 *
 * Lifecycle
 *   open   first message of a window creates the session
 *   reuse  further messages join the same window while it is quiet no longer than
 *          `reuseWindowMs`
 *   close  after `archiveAfterMs` of silence, the window is summarized into
 *          MEMORY.md and the session is archived
 *
 * While a window is closing it is treated as finished: an arriving message opens
 * a new window instead of racing the archiver.
 */

import { nowStamp } from './memory.js'

const STATE = {
  IDLE: 'idle',
  ACTIVE: 'active',
  CLOSING: 'closing',
}

export class SessionManager {
  /**
   * @param {object} options
   * @param {object} options.memory  MemoryStore
   * @param {object} [options.workspaceRegistry]  DSH service, for archive
   * @param {object} [options.agents]  DSH service, for liveness
   * @param {(sessionId: string) => Promise<boolean>} [options.stateOf]  true while the session is mid-turn
   * @param {(sessionId: string) => Promise<string[]>} [options.digestOf]  what the window talked about
   * @param {(sessionId: string, title: string) => Promise<unknown>} [options.renameOf]  set the final sidebar title
   * @param {number} [options.reuseWindowMs] quiet period that still belongs to the open window
   * @param {number} [options.archiveAfterMs] quiet period before closing the window
   * @param {number} [options.checkIntervalMs]
   */
  constructor(options) {
    this.memory = options.memory
    this.workspaceRegistry = options.workspaceRegistry ?? null
    this.agents = options.agents ?? null
    this.stateOf = options.stateOf ?? null
    this.digestOf = options.digestOf ?? null
    this.renameOf = options.renameOf ?? null
    this.reuseWindowMs = options.reuseWindowMs ?? 3 * 60 * 1000
    this.archiveAfterMs = options.archiveAfterMs ?? 5 * 60 * 1000
    this.maxTurns = Math.max(0, Number(options.maxTurns ?? 30))
    this.checkIntervalMs = options.checkIntervalMs ?? 30 * 1000

    this.windows = new Map()   // sessionId -> window record
    this.currentId = null
    this.timer = null
    this.archiveLog = []
  }

  get current() {
    return this.currentId ? this.windows.get(this.currentId) ?? null : null
  }

  /** The live window new messages should join, or null when a new one is needed. */
  openWindow() {
    const win = this.current
    if (!win) return null
    if (win.state === STATE.CLOSING) return null
    if (Date.now() - win.lastActivityAt > this.reuseWindowMs) return null
    if (this.maxTurns > 0 && (win.turnCount || 0) >= this.maxTurns) return null
    return win
  }

  /** Register a freshly created session as the active window. */
  register(sessionId, { title } = {}) {
    const now = Date.now()
    const win = {
      sessionId,
      title: title || `豆包 ${nowStamp()}`,
      state: STATE.ACTIVE,
      openedAt: now,
      lastActivityAt: now,
      turnCount: 0,
      messageCount: 0,
      messages: [],
      replies: [],
      summarized: false,
    }
    this.windows.set(sessionId, win)
    this.currentId = sessionId
    return win
  }

  /** Note activity in the current window, creating the record if absent. */
  touch(sessionId, { messages = 0 } = {}) {
    const win = this.windows.get(sessionId)
    if (!win) return null
    win.lastActivityAt = Date.now()
    win.turnCount = (win.turnCount || 0) + 1
    win.messageCount += messages
    return win
  }

  /** Record what the bot said, for the closing summary. */
  rememberReply(sessionId, texts) {
    const win = this.windows.get(sessionId)
    if (!win) return
    for (const text of texts || []) {
      if (text && text.trim()) win.replies.push(text.trim())
    }
    win.lastActivityAt = Date.now()
  }

  /** Drop a window the registry no longer owns (archived behind our back). */
  forget(sessionId) {
    this.windows.delete(sessionId)
    if (this.currentId === sessionId) this.currentId = null
    this.archiveLog.push({ sessionId, at: Date.now(), reason: 'forgotten' })
  }

  markClosing(sessionId) {
    const win = this.windows.get(sessionId)
    if (!win) return
    win.state = STATE.CLOSING
    if (this.currentId === sessionId) this.currentId = null
  }

  /**
   * Summarize a window without a model call.
   *
   * The session log already holds the full transcript; memory only needs enough
   * to restore the bot's sense of history, so this records counts and its own
   * words rather than spending tokens on a second summarization pass.
   */
  summarize(win, digest = []) {
    // The stamp is supplied by the caller (memory.append), so the body must not
    // repeat it — that used to produce "2026-11-24 22:15: 2026-11-24 22:15 ...".
    const parts = [`这段聊了 ${win.messageCount} 条消息`]
    // What was actually said matters more than the count: without it the bot
    // "remembers" a conversation as an empty tally. The digest comes from the
    // session log, costs no model call, and is truncated by the caller.
    if (digest.length > 0) {
      parts.push(`群里说到：${digest.join('；')}`)
    }
    if (win.replies.length > 0) {
      const shown = win.replies.slice(-4).join(' / ')
      parts.push(`我说过：${shown}`)
    } else {
      parts.push('我没有插话')
    }
    return `${parts.join('，')}。`
  }

  /** Close one window: memory, then archive. */
  async close(sessionId, { reason = 'idle' } = {}) {
    const win = this.windows.get(sessionId)
    if (!win || win.state === STATE.CLOSING) return { closed: false, reason: 'not-active' }

    this.markClosing(sessionId)

    if (!win.summarized) {
      try {
        let digest = []
        try {
          digest = (await this.digestOf?.(sessionId)) ?? []
        } catch { /* a failed digest must not block archiving */ }
        this.memory.append(this.summarize(win, digest), nowStamp(new Date(win.openedAt)))
        win.summarized = true
      } catch (error) {
        return { closed: false, reason: `memory: ${error.message}` }
      }
    }

    // The first prompt usually triggers the title provider, which overwrites the
    // name given at creation. Re-apply it now: this is the last chance before the
    // session leaves the sidebar, and a generated "规则与接话" title is useless
    // when browsing archived windows later.
    try {
      await this.renameOf?.(sessionId, win.title)
    } catch { /* the title is cosmetic */ }

    // Only archive a session that is not mid-turn; archiving stops activity, and
    // an in-flight reply would be cut off. The session's own state is the source
    // of truth: asking the registry for a "status" of a live agent is not a thing.
    let running = false
    try {
      running = (await this.stateOf?.(sessionId)) === true
    } catch { /* a state read failure must not block the sweep forever */ }
    if (running) {
      win.state = STATE.ACTIVE
      win.lastActivityAt = Date.now()
      return { closed: false, reason: 'busy' }
    }

    try {
      await this.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })
    } catch (error) {
      this.archiveLog.push({ sessionId, at: Date.now(), error: error.message })
      return { closed: false, reason: `archive: ${error.message}` }
    }

    this.windows.delete(sessionId)
    this.archiveLog.push({ sessionId, at: Date.now(), reason })
    return { closed: true, reason }
  }

  /**
   * Close every open window now, regardless of how long it has been quiet.
   *
   * Stopping the bot ends the conversation window. Without this, a window opened
   * before the stop is never swept (the table is in memory and its timer goes
   * away), so its session never reaches MEMORY.md, stays unarchived in the
   * sidebar, and the next start can join that stale window.
   */
  async flush({ reason = 'stopped' } = {}) {
    const results = []
    for (const id of [...this.windows.keys()]) results.push(await this.close(id, { reason }))
    // A window that was mid-turn when the stop arrived refuses to close; give it
    // one short second chance so a normal reply is not cut off, then leave it.
    const retry = [...this.windows.keys()]
    if (retry.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      for (const id of retry) results.push(await this.close(id, { reason }))
    }
    return results
  }

  /** Sweep windows past their silence budget. */
  async sweep() {
    const now = Date.now()
    const due = []
    for (const [id, win] of this.windows) {
      if (win.state !== STATE.ACTIVE) continue
      if (now - win.lastActivityAt >= this.archiveAfterMs) due.push(id)
    }
    const results = []
    for (const id of due) results.push(await this.close(id, { reason: 'idle' }))
    return results
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.sweep().catch(() => {})
    }, this.checkIntervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  status() {
    return {
      currentSessionId: this.currentId,
      windows: [...this.windows.values()].map((w) => ({
        sessionId: w.sessionId,
        title: w.title,
        state: w.state,
        turnCount: w.turnCount || 0,
        messageCount: w.messageCount,
        idleSeconds: Math.round((Date.now() - w.lastActivityAt) / 1000),
      })),
      recentArchives: this.archiveLog.slice(-10),
    }
  }
}

export { STATE as SESSION_STATE }
