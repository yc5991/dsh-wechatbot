import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply } from '../index.js'
import { DetectorService } from '../lib/detector.js'
import { MemoryStore } from '../lib/memory.js'
import { SessionTrigger } from '../lib/trigger.js'
import { MacOSWeChatClient } from '../lib/wechat-macos.js'

function workspaceFixture(path) {
  const workspace = {
    id: 'test-workspace', path, sessionIds: [],
    getSessionHeaders() { return this.sessionIds.map((id) => ({ id })) },
    async detachSession(id) { this.sessionIds = this.sessionIds.filter((value) => value !== id) },
  }
  const registry = {
    archivedSessionIds: [],
    list: () => [workspace],
    resolveByPath: () => workspace,
    async archiveSession(id) { this.archivedSessionIds.push(id) },
  }
  return { workspace, registry }
}

test('older config and visible history stay out of a new session after sidebar archive or panel removal', { timeout: 5000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-test-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  const dispose = []
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  t.mock.property(process, 'platform', 'darwin')
  const groupName = '测试群'
  const row = (content) => ({ groupName, sender: '测试成员', content })
  let detector
  t.mock.method(DetectorService.prototype, 'start', async function () {
    detector = this
    this.baselineDone = true
  })
  t.mock.method(DetectorService.prototype, 'stop', async () => ({ running: false }))
  t.mock.method(MacOSWeChatClient.prototype, 'ensureTargetWindow', async () => ({ ok: true }))
  t.mock.method(MacOSWeChatClient.prototype, 'findWindow', async () => null)
  let screenshotAnchor
  t.mock.method(MacOSWeChatClient.prototype, 'captureChatImage', async ({ fromMessage }) => {
    screenshotAnchor = fromMessage
    return null
  })
  t.mock.method(MacOSWeChatClient.prototype, 'readVisible', async () => ({
    source: 'ocr', group: groupName, messages: [row('上一段对话'), row('本轮问题')],
  }))
  const agentDir = join(home, 'test-agent')
  const { registry, workspace } = workspaceFixture(agentDir)
  const memory = new MemoryStore({ dir: agentDir })
  memory.ensure()
  memory.write('测试长期摘要', [{ stamp: '2024-01-01 12:34', body: '测试近期摘要' }])
  assert.match(memory.contextForPrompt({ entries: 3 }), /测试长期摘要/)
  assert.equal(memory.contextForPrompt({ entries: 0 }), '')

  let sequence = 0
  let prompted
  const controller = {
    async create() {
      const sessionId = `test-session-${++sequence}`
      workspace.sessionIds.push(sessionId)
      return { sessionId }
    },
    async prompt(prompt) { prompted(prompt) },
    async rename() {},
    async state() { return { running: false } },
  }
  const tools = new Map()
  let panel
  const ctx = {
    get: (key) => ({ sessionController: controller, workspaceRegistry: registry })[key],
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    webServer: { register: (route) => { panel = route } },
    effect: (fn) => {
      const cleanup = fn()
      if (cleanup) dispose.push(cleanup)
    },
    inject: (_names, fn) => fn(ctx),
  }
  apply(ctx, { agentDir, expectedGroup: groupName, memoryPromptEntries: 3 })
  async function request(path, body) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    Object.assign(req, { method: body ? 'POST' : 'GET', url: panel.path + path, headers: { 'content-type': 'application/json' } })
    let result
    await panel.handler(req, { writeHead() {}, end: (data) => { result = JSON.parse(data) } })
    return result
  }
  async function receive(content) {
    const delivered = new Promise((resolve) => { prompted = resolve })
    assert.equal(detector.enqueue([{ ...row(content), isAtMe: true }], 'notification'), 1)
    let timer
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500) })
    const prompt = await Promise.race([delivered, timeout])
    clearTimeout(timer)
    assert.ok(prompt, prompt ? '' : JSON.stringify((await request('/status')).trigger))
    return prompt
  }

  try {
    assert.equal((await request('/detector', { action: 'start' })).ok, true)
    const previous = await receive('上一段对话')
    await registry.archiveSession(previous.sessionId)
    const current = await receive('本轮问题')
    assert.notEqual(current.sessionId, previous.sessionId)
    assert.doesNotMatch(current.content[0].text, /测试长期摘要|测试近期摘要|上一段对话/)
    assert.match(current.content[0].text, /本轮问题/)
    assert.equal(screenshotAnchor.content, '本轮问题')
    const read = tools.get('wechat_read')
    const scoped = JSON.parse(await read.execute({}, { agent: { id: current.sessionId } }))
    assert.deepEqual(scoped.messages.map((item) => item.content), ['本轮问题'])
    assert.deepEqual(JSON.parse(await read.execute({}, { agent: { id: previous.sessionId } })).messages, [])

    const removed = await request('/sessions', { action: 'remove', sessionId: current.sessionId })
    assert.equal(removed.removed, true)
    assert.ok(registry.archivedSessionIds.includes(current.sessionId))
    assert.ok(!(await request('/sessions')).sessions.some((item) => item.sessionId === current.sessionId))
    const next = await receive('移出后的新消息')
    assert.notEqual(next.sessionId, current.sessionId)
  } finally {
    await request('/detector', { action: 'stop' })
    for (const cleanup of dispose) cleanup()
  }
})

test('panel removal surfaces detach errors and leaves the host archive guard on', async (t) => {
  const { registry, workspace } = workspaceFixture('/test-agent')
  workspace.sessionIds.push('target')
  t.mock.method(workspace, 'detachSession', async () => { throw new Error('workspace write failed') })
  const trigger = new SessionTrigger({
    ctx: { get: (key) => ({ workspaceRegistry: registry, sessionController: { state: async () => ({ running: false }) } })[key] },
    agentDir: workspace.path,
  })
  assert.equal(trigger.canReuse('target'), true)
  const result = await trigger.removeSession('target')
  assert.equal(result.removed, false)
  assert.match(result.error, /workspace write failed/)
  assert.equal(trigger.canReuse('target'), false)
  await assert.rejects(trigger.wake('target', 'test'), /会话已归档或移除/)
})

test('group drag ends at the last bubble and falls back when the clipboard is truncated', async (t) => {
  const client = new MacOSWeChatClient({ expectedGroup: '测试群' })
  const target = { id: 1, title: '测试群', x: 80, y: 30, width: 800, height: 600, onscreen: true }
  const region = { x: 80, y: 30, w: 800, h: 516 }
  const items = [
    { text: '测试群', x: 0.1, y: 0.05, w: 0.1, h: 0.02 },
    { text: '第一条消息', x: 0.17, y: 0.22, w: 0.15, h: 0.02 },
    { text: '最后一条消息', x: 0.17, y: 0.95, w: 0.18, h: 0.02 },
  ]
  t.mock.method(client, 'getChatWindow', async () => target)
  t.mock.method(client, 'captureChatRegion', async () => ({ title: target.title, region, items }))
  t.mock.method(client, 'ensureDragBinary', async () => {})
  t.mock.method(client, 'activateApp', async () => {})
  let frontTitle = target.title
  t.mock.method(client, 'frontWindowTitle', async () => frontTitle)
  t.mock.method(client, 'listWindows', async () => [target])
  const head = '甲\n2024年1月1日 12:34\n第一条消息'
  const tail = '乙\n2024年1月1日 12:35\n最后一条消息'
  let clipboard = `${head}\n\n${tail}`
  const drag = t.mock.method(client, 'runHelper', async (_path, _kind, args) => {
    assert.ok(Number(args[3]) > target.y + target.height * 0.8)
    assert.ok(Number(args[3]) < region.y + region.h)
    return clipboard
  })
  const copy = await client.readVisible({ mode: 'auto' })
  assert.equal(copy.source, 'copy')
  assert.equal(copy.messages.at(-1).sentAt, new Date(2024, 0, 1, 12, 35).getTime())
  clipboard = head
  const fallback = await client.readVisible({ mode: 'auto' })
  assert.notEqual(fallback.source, 'copy')
  assert.match(fallback.copyIssue, /缺少可见消息/)
  assert.ok(drag.mock.callCount() >= 2)

  const dragCalls = drag.mock.callCount()
  frontTitle = ''
  const background = await client.readVisible({ mode: 'copy' })
  assert.match(background.copyIssue, /未置于前面/)
  assert.equal(drag.mock.callCount(), dragCalls)
})
