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
  async createSession({ title, agentPreset = this.agentPreset } = {}) {
    const controller = this.controller
    if (!controller) throw new Error('sessionController 不可用：这个 profile 没有装载 DSH Web 会话 API')
    // Creating through the workspace id (not just cwd) also attaches the session
    // to it, which is what makes it appear under the bot workspace in the
    // sidebar instead of floating unattached.
    const workspace = await this.ensureWorkspace()
    this.sequence += 1
    const value = await controller.create(workspace
      ? { workspaceId: workspace.id, agentPreset }
      : { cwd: this.agentDir, agentPreset })
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
  async wake(sessionId, text, { mode = 'queue', image = null, images = [], requireMembership = false } = {}) {
    const controller = this.controller
    if (!controller) throw new Error('sessionController 不可用：这个 profile 没有装载 DSH Web 会话 API')
    const body = String(text || '').trim()
    if (!body) throw new Error('没有可注入的内容')
    if (this.isArchived(sessionId) || (requireMembership && !this.canReuse(sessionId))) {
      throw new Error('会话已归档或移除')
    }
    const requestId = randomUUID()
    const content = [{ type: 'text', text: body }]
    // The model can look at the chat itself: a sticker, a meme or a screenshot of
    // an error is information OCR cannot carry.
    for (const attachment of [image, ...images]) {
      if (!attachment?.data) continue
      if (attachment.label) content.push({ type: 'text', text: attachment.label })
      content.push({
        type: 'image',
        mediaType: attachment.mediaType || 'image/png',
        data: attachment.data,
        ...(attachment.name ? { name: attachment.name } : {}),
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
    this.lastWake = { sessionId, requestId, mode, chars: body.length, withImage: content.some((block) => block.type === 'image'), at: this.lastPromptAt }
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

  canReuse(sessionId) {
    const registry = this.registry
    if (!registry) return true
    try {
      return !(registry.archivedSessionIds ?? []).includes(sessionId)
        && registry.list().some((workspace) => workspace.sessionIds.includes(sessionId))
    } catch (error) {
      this.lastError = `workspace membership: ${error.message}`
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

  /** Remove a bot session from DSH's active sidebar and workspace membership. */
  async removeSession(sessionId) {
    const registry = this.registry
    if (!registry) return { removed: false, error: 'workspaceRegistry 不可用' }
    const workspaces = () => registry.list().filter((workspace) => workspace.sessionIds.includes(sessionId))
    let stage = '归档会话'
    try {
      const state = await this.state(sessionId)
      if (state?.running) return { removed: false, error: '会话正在运行，等它这轮结束再移除' }

      await registry.archiveSession(sessionId, { stopActivity: true })
      if (!this.isArchived(sessionId)) throw new Error('DSH 尚未确认归档状态')
      stage = '从工作区解绑'
      for (const workspace of workspaces()) await workspace.detachSession(sessionId)
      if (workspaces().length) throw new Error('DSH 仍保留此会话的工作区关联')
      if (!this.isArchived(sessionId)) throw new Error('DSH 中的归档状态已变化')
      return { removed: true, sessionId, archived: true }
    } catch (error) {
      this.lastError = `${stage}失败：${error.message}`
      return { removed: false, sessionId, error: this.lastError }
    }
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
  let latest = ''
  for (const record of records) {
    const event = record?.event ?? record
    if (event?.type !== 'assistant/message') continue
    const blocks = event?.data?.message?.content ?? event?.data?.content ?? []
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
    if (text) latest = text
  }
  return latest
}
