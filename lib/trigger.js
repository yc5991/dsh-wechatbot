/**
 * Wake a DSH session from outside any agent turn.
 *
 * A plugin cannot "call the model" directly: a model turn needs an Agent, and an
 * ordinary Agent only runs while a session is being driven. Two mechanisms were
 * tried in this project:
 *
 *   subagents.startActivation  creates a child, but requires a *live parent*
 *                              Agent. When DSH sits idle there is none, so the
 *                              bot could not start itself.
 *   sessionController          the same service the Web GUI uses for "new
 *                              session" and "send message". It can create an
 *                              ordinary session and admit a prompt into it,
 *                              which is exactly "wake the bot with this text".
 *
 * The session is a real DSH session: it shows up in the sidebar under the bot
 * workspace, its transcript is durable, and it can be archived and restored like
 * any other session. That is what makes "one conversation window = one session"
 * possible without inventing a second session model inside the plugin.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const normalizePath = (path) => String(path || '').replace(/\/+$/, '')

export class SessionTrigger {
  /**
   * @param {object} options
   * @param {object} options.ctx              plugin context, for service lookup
   * @param {string} options.agentDir         workspace path of the bot sessions
   * @param {string} [options.agentPreset]    preset used for bot sessions
   * @param {string} [options.workspaceTitle] title when the workspace is created
   */
  constructor(options) {
    this.ctx = options.ctx
    this.agentDir = options.agentDir
    this.agentPreset = options.agentPreset || 'standard'
    this.workspaceTitle = options.workspaceTitle || 'dsh-wechatbot'

    this.lastError = null
    this.lastSessionId = null
    this.lastPromptAt = null
    this.lastWake = null
    this.sequence = 0
  }

  /** The DSH service behind `ctx.remote.session`, or null when the profile lacks it. */
  get controller() {
    return this.ctx.get('sessionController') ?? null
  }

  get registry() {
    return this.ctx.get('workspaceRegistry') ?? null
  }

  /** Whether waking is possible at all in this composition. */
  get available() {
    return Boolean(this.controller)
  }

  /**
   * Ensure the bot workspace exists, so its sessions are grouped in the sidebar
   * instead of disappearing into "no workspace".
   */
  async ensureWorkspace() {
    const registry = this.registry
    if (!registry) return null
    try {
      const found = await registry.resolveByPath?.(this.agentDir)
      if (found) return found
    } catch (error) {
      this.lastError = `workspace lookup: ${error.message}`
    }
    try {
      return await registry.create(this.agentDir, this.workspaceTitle)
    } catch (error) {
      // A concurrent creation (or a path race) is not fatal: resolve again.
      this.lastError = `workspace create: ${error.message}`
      try {
        return (await registry.resolveByPath?.(this.agentDir)) ?? null
      } catch {
        return null
      }
    }
  }

  /** Create a fresh ordinary session for a new conversation window. */
  async createSession({ title } = {}) {
    const controller = this.controller
    if (!controller) throw new Error('sessionController 不可用：这个 profile 没有装载 DSH Web 会话 API')
    // Creating through the workspace id (not just cwd) also attaches the session
    // to it, which is what makes it appear under the bot workspace in the
    // sidebar instead of floating unattached.
    const workspace = await this.ensureWorkspace()
    this.sequence += 1
    const value = await controller.create(workspace
      ? { workspaceId: workspace.id, agentPreset: this.agentPreset }
      : { cwd: this.agentDir, agentPreset: this.agentPreset })
    this.lastSessionId = value.sessionId
    return { ...value, title: title || `微信窗口 ${this.sequence}` }
  }

  /**
   * Admit prompt text into a session.
   *
   * `queue` delivers at the next turn, which is what a burst of chat messages
   * wants: several messages that arrive while the bot is thinking become one
   * more turn instead of interrupting the reply in progress.
   */
  async wake(sessionId, text, { mode = 'queue', image = null } = {}) {
    const controller = this.controller
    if (!controller) throw new Error('sessionController 不可用：这个 profile 没有装载 DSH Web 会话 API')
    const body = String(text || '').trim()
    if (!body) throw new Error('没有可注入的内容')
    const requestId = randomUUID()
    const content = [{ type: 'text', text: body }]
    // The model can look at the chat itself: a sticker, a meme or a screenshot of
    // an error is information OCR cannot carry.
    if (image?.data) {
      content.push({
        type: 'image',
        mediaType: image.mediaType || 'image/png',
        data: image.data,
        ...(image.name ? { name: image.name } : {}),
      })
    }
    try {
      // The Host API methods take an explicit AbortSignal, like the browser does.
      const signal = new AbortController().signal
      await controller.prompt({ sessionId, mode, requestId, content }, signal)
    } catch (error) {
      this.lastError = error.message
      throw error
    }
    this.lastPromptAt = Date.now()
    this.lastWake = { sessionId, requestId, mode, chars: body.length, withImage: Boolean(image?.data), at: this.lastPromptAt }
    return this.lastWake
  }

  /**
   * Rename the session.
   *
   * The sidebar title otherwise stays a generic "new session" string, which
   * makes a workspace full of bot conversations impossible to browse. Renaming
   * is best-effort: a failure here never blocks the turn.
   */
  async rename(sessionId, title) {
    const controller = this.controller
    if (!controller?.rename) return false
    try {
      await controller.rename({ sessionId, title: String(title || '').slice(0, 60) })
      return true
    } catch (error) {
      this.lastError = `rename: ${error.message}`
      return false
    }
  }

  /** Passive state: `running` tells whether the bot is mid-turn. */
  async state(sessionId) {
    const controller = this.controller
    if (!controller) return null
    try {
      return await controller.state({ sessionId }, new AbortController().signal)
    } catch (error) {
      this.lastError = `state: ${error.message}`
      return null
    }
  }

  /**
   * Wait for the session to go idle and return its tail.
   *
   * Used by the manual wake tool; the detector path does not wait, because the
   * bot must stay responsive while a reply is being written.
   */
  async wait(sessionId, timeoutMs = 180_000) {
    const controller = this.controller
    if (!controller) throw new Error('sessionController 不可用')
    return controller.wait({ sessionId, timeoutMs, maxMessages: 40 }, new AbortController().signal)
  }

  /**
   * Whether the session is archived right now.
   *
   * The plugin's window table is in-memory and can drift from the registry — a
   * session archived from the sidebar, or by a previous plugin instance, is
   * still "open" here. A prompt admitted to an archived session is silently
   * dropped by the archived-session gate (the turn ends `blocked`), which looks
   * exactly like the bot going quiet, so callers must check this first.
   */
  isArchived(sessionId) {
    const registry = this.registry
    if (!registry) return false
    try {
      return (registry.archivedSessionIds ?? []).includes(sessionId)
    } catch {
      return false
    }
  }

  async archive(sessionId) {
    const registry = this.registry
    if (!registry) return { archived: false, error: 'workspaceRegistry 不可用' }
    await registry.archiveSession(sessionId, { stopActivity: true })
    return { archived: true }
  }

  async unarchive(sessionId) {
    const registry = this.registry
    if (!registry) return { archived: false, error: 'workspaceRegistry 不可用' }
    await registry.unarchiveSession(sessionId)
    return { archived: false }
  }

  /**
   * Delete a bot session for real.
   *
   * DSH only exposes archive, so "delete" has to be assembled: drop the archive
   * flag, detach the session from its workspace accounting, then remove the
   * persisted log and its projection cache from disk. Anything less leaves the
   * transcript recoverable, which is not what the button promises.
   *
   * Refused while the session is mid-turn: its agent would keep writing to a log
   * that no longer exists.
   */
  async deleteSession(sessionId) {
    const registry = this.registry
    if (!registry) return { deleted: false, error: 'workspaceRegistry 不可用' }
    const state = await this.state(sessionId)
    if (state?.running) {
      return { deleted: false, error: '会话正在运行，等它这轮结束再删' }
    }
    // Archive first: an archived session cannot start a new turn, so nothing can
    // append to the log between the checks below and the removal.
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      this.lastError = `archive before delete: ${error.message}`
    }
    try {
      await registry.unarchiveSession(sessionId)
    } catch (error) {
      this.lastError = `unarchive: ${error.message}`
    }
    for (const workspace of registry.list?.() ?? []) {
      if (typeof workspace.detachSession !== 'function') continue
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        this.lastError = `detach: ${error.message}`
      }
    }
    const logs = removeSessionLogs(sessionId)
    const cache = removeProjectionCache(sessionId)
    return { deleted: true, sessionId, logs, projectionCache: cache }
  }

  /**
   * Bot sessions, live and archived.
   *
   * The workspace registry is the only place that knows an archived session, so
   * the bot workspace's headers are the source of truth; `archivedSessionIds`
   * supplies the flag.
   */
  listBotSessions() {
    const registry = this.registry
    if (!registry) return []
    let archived = new Set()
    try {
      archived = new Set(registry.archivedSessionIds ?? [])
    } catch { /* optional */ }
    const rows = []
    for (const workspace of registry.list?.() ?? []) {
      if (normalizePath(workspace.path) !== normalizePath(this.agentDir)) continue
      for (const header of workspace.getSessionHeaders?.() ?? []) {
        rows.push({
          sessionId: header.id,
          createdAt: header.createdAt,
          cwd: header.cwd,
          archived: archived.has(header.id),
        })
      }
    }
    rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return rows
  }

  /** Compact report for `wechat_status`. */
  status() {
    return {
      available: this.available,
      workspace: normalizePath(this.agentDir),
      workspaceTitle: this.workspaceTitle,
      agentPreset: this.agentPreset,
      lastSessionId: this.lastSessionId,
      lastPromptAt: this.lastPromptAt,
      lastError: this.lastError,
    }
  }
}

/** Pull assistant text out of `sessionController.wait` output records. */
export function assistantTextFromWait(value) {
  const records = value?.output?.records ?? []
  const parts = []
  for (const record of records) {
    const event = record?.event ?? record
    if (event?.type !== 'assistant/message') continue
    for (const block of event?.data?.message?.content ?? []) {
      if (block?.type === 'text' && block.text) parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** Remove every persisted log directory for one session id. */
export function removeSessionLogs(sessionId) {
  const removed = []
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId))) return removed
  const roots = [join(homedir(), '.dsh', 'sessions')]
  for (const root of roots) {
    let buckets = []
    try {
      buckets = readdirSync(root)
    } catch {
      continue
    }
    for (const bucket of buckets) {
      const dir = join(root, bucket, sessionId)
      try {
        if (!statSync(dir).isDirectory()) continue
        rmSync(dir, { recursive: true, force: true })
        removed.push(dir)
      } catch { /* a missing or locked directory is not fatal */ }
    }
  }
  return removed
}

/** Remove one session's projection cache file. */
export function removeProjectionCache(sessionId) {
  const path = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    if (!existsSync(path)) return null
    rmSync(path, { force: true })
    return path
  } catch {
    return null
  }
}
