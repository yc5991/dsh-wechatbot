import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { apply, Config } from '../index.js'
import { configuredTargets } from '../lib/targets.js'
import { DetectorService } from '../lib/detector.js'
import { MacOSWeChatClient } from '../lib/wechat-macos.js'
import { MemoryStore } from '../lib/memory.js'
import { QuotaTracker } from '../lib/quota.js'
import { StickerLibrary, parseStickerLabels } from '../lib/stickers.js'

test('migration honors explicit empty lists and rejects indistinguishable chats and an eleventh target', () => {
  const old = Config({ expectedGroup: '原目标', chatMode: 'private' })
  assert.equal(configuredTargets(old)[0].mode, 'private')
  assert.deepEqual(configuredTargets(Config({ ...old, targets: [] })), [])
  assert.throws(() => configuredTargets({ targets: [{ name: '测试（12）', mode: 'group' }, { name: '测试', mode: 'private' }] }), /同名/)
  const targets = Array.from({ length: 10 }, (_, index) => ({ name: `会话 ${index}`, mode: 'group' }))
  assert.equal(configuredTargets({ targets }).length, 10)
  assert.throws(() => configuredTargets({ targets: [...targets, { name: '额外会话', mode: 'private' }] }), /10/)
})

test('imported memory survives archive writes and generated memory stays inside its chat', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-scope-'))
  t.after(() => rmSync(dir, { force: true, recursive: true }))
  const memory = new MemoryStore({ dir, maxEntries: 1 })
  const [first, second] = configuredTargets({ targets: [{ name: '甲', mode: 'group' }, { name: '乙', mode: 'private' }] })
  writeFileSync(memory.path, '# 用户笔记\n\n原先导入的说明\n')
  memory.append('甲方历史摘要', '2024-01-01 11:01', first.id)
  memory.append('乙方独立记忆', '2024-01-01 11:02', second.id)
  memory.append('甲方今日摘要', '2024-01-01 11:03', first.id)
  const a = memory.contextForPrompt({ entries: 3, targetId: first.id, includeLegacy: false })
  const b = memory.contextForPrompt({ entries: 3, targetId: second.id, includeLegacy: false })
  assert.match(a, /甲方历史摘要/)
  assert.match(b, /乙方独立记忆/)
  assert.match(b, /原先导入的说明/)
  assert.doesNotMatch(b, /甲方/)
})

test('sync preserves sticker identities and an in-flight AI label cannot replace a manual edit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sticker-labels-'))
  t.after(() => rmSync(dir, { force: true, recursive: true }))
  const library = new StickerLibrary(join(dir, 'stickers.json'))
  const cell = { image: 'example', signature: Array(300).fill(75) }
  const [sticker] = library.synchronize({ items: [cell], complete: true }).items
  library.edit(sticker.id, { tags: '收到，认同', description: '用来简短回应' })
  const ai = parseStickerLabels(JSON.stringify([{ id: sticker.id, tags: ['惊讶'], description: '不确定' }]))
  assert.equal(library.applyLabels([sticker], ai), 0)
  const [synced] = library.synchronize({ items: [{ ...cell, signature: Array(300).fill(77) }], complete: true }).items
  assert.equal(synced.id, sticker.id)
  assert.deepEqual(synced.tags, ['收到', '认同'])
  assert.equal(synced.source, 'manual')
})

test('a switch during a batch stops later sends and the quota covers both chats', { timeout: 6000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-multi-chat-'))
  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    rmSync(home, { force: true, recursive: true })
  })
  t.mock.property(process, 'platform', 'darwin')
  let detector
  t.mock.method(DetectorService.prototype, 'start', async function () { detector = this; this.baselineDone = true })
  t.mock.method(DetectorService.prototype, 'stop', async () => ({}))
  t.mock.method(MacOSWeChatClient.prototype, 'isRunning', async () => true)
  t.mock.method(MacOSWeChatClient.prototype, 'targetReadiness', async (targets) => ({ [targets[0].id]: true }))
  const localReads = []
  t.mock.method(MacOSWeChatClient.prototype, 'captureChatImage', async function () {
    localReads.push('vision:' + this.expectedGroup)
    return null
  })
  t.mock.method(MacOSWeChatClient.prototype, 'readVisible', async function () {
    localReads.push('ocr:' + this.expectedGroup)
    return { source: 'ocr', group: this.expectedGroup, messages: [] }
  })
  t.mock.method(MacOSWeChatClient.prototype, 'readByCopy', async function () {
    localReads.push('copy:' + this.expectedGroup)
    return { source: 'copy', group: this.expectedGroup, messages: [] }
  })
  t.mock.method(MacOSWeChatClient.prototype, 'collectStickers', async function () {
    assert.equal(this.expectedGroup, '测试群')
    return { complete: true, items: [{ image: 'aW1hZ2U=', signature: Array(300).fill(100) }] }
  })
  const sends = []
  t.mock.method(MacOSWeChatClient.prototype, 'send', async function (text, options) {
    if (options.requireFront) throw new Error('微信窗口已切换')
    await options.beforeSubmit()
    sends.push([this.expectedGroup, text])
    return { sent: text, delaySeconds: 0 }
  })
  const agentDir = join(home, 'agent')
  const config = {
    agentDir, targets: [{ name: '测试群', mode: 'group' }, { name: '测试私聊', mode: 'private' }],
    dailyProactiveLimit: 2, ocrEnabled: false, dragCopyEnabled: false, attachScreenshot: false,
  }
  const workspace = { id: 'test', path: agentDir, sessionIds: [], getSessionHeaders() { return this.sessionIds.map((id) => ({ id })) } }
  const registry = { archivedSessionIds: [], resolveByPath: () => workspace, list: () => [workspace], async archiveSession(id) { this.archivedSessionIds.push(id) } }
  const prompts = []
  const controller = {
    async create(request) {
      const sessionId = `test-session-${workspace.sessionIds.length + 1}`
      workspace.sessionIds.push(sessionId)
      if (workspace.sessionIds.length === 3) assert.equal(request.agentPreset, 'wechatbot-sticker-labels')
      return { sessionId }
    },
    async prompt(value) { prompts.push(value) },
    async rename() {},
    async state() { return { running: false } },
    async openWorkspacePath(request) {
      assert.deepEqual(request, { path: agentDir })
      return { opened: true }
    },
    async wait({ sessionId }) {
      const prompt = prompts.find((row) => row.sessionId === sessionId)
      assert.equal(prompt.content.at(-1).type, 'image')
      const id = prompt.content.at(-2).text.split(' ').at(-1)
      const text = JSON.stringify([{ id, tags: ['高兴', '赞同'], description: '用来表达认可' }])
      return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message', data: { content: [{ type: 'text', text }] } } }] } }
    },
  }
  const editor = { entries: () => [{ options: { id: 'dsh-wechatbot' } }], edit: async (_entry, update) => update(config) }
  const tools = new Map()
  const cleanup = []
  let panel
  const ctx = {
    get: (key) => ({ workspaceRegistry: registry, sessionController: controller, configEditor: editor })[key],
    effect: (fn) => { const end = fn(); if (end) cleanup.push(end) },
    inject: (_keys, fn) => fn(ctx),
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    webServer: { register: (route) => { panel = route } },
  }
  apply(ctx, config)
  const request = async (path, body) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []),
      { url: panel.path + path, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } })
    let result
    await panel.handler(req, { writeHead() {}, end(data) { result = JSON.parse(data) } })
    return result
  }
  const call = async (tool, args, sessionId) => JSON.parse(await tools.get(tool).execute(args, { agent: { id: sessionId } }))
  try {
    const original = await request('/documents/agent')
    assert.equal(original.name, 'AGENT.md')
    assert.ok(original.text.length > 0)
    assert.equal((await request('/workspace/open', { path: '/tmp/ignored-by-route' })).ok, true)
    assert.equal((await request('/documents/unknown')).error, '接口不可用')
    assert.equal((await request('/settings', { documents: { agent: '# 导入角色\n' } })).ok, true)
    assert.equal((await request('/documents/agent')).text, '# 导入角色\n')
    assert.equal((await request('/detector', { action: 'start' })).ok, true)
    assert.equal(detector.scanEnabled, false)
    assert.equal(detector.enqueue([
      { groupName: '测试群', sender: '成员', content: '重复文字', isAtMe: true },
      { groupName: '测试私聊', sender: '成员', content: '重复文字', isAtMe: true },
      { groupName: '测试', sender: '成员', content: '疑似前缀', isAtMe: true },
    ], 'notification'), 2)
    for (let index = 0; prompts.length < 2 && index < 40; index += 1) await sleep(20)
    assert.equal(prompts.length, 2)
    assert.match(prompts[0].content[0].text, /导入角色/)
    assert.deepEqual(localReads, [])
    const [a, b] = prompts.map((prompt) => prompt.sessionId)
    const read = await call('wechat_read', { mode: 'auto' }, a)
    assert.equal(read.ok, false)
    assert.deepEqual(localReads, [])
    const batch = await call('wechat_send_many', { messages: ['第一条', '不会提交'], isAtMe: true }, a)
    assert.equal(batch.sentCount, 1)
    assert.match(batch.results[1].error, /窗口已切换/)
    assert.equal((await call('wechat_send', { text: '另一个聊天', isAtMe: true }, b)).ok, true)
    assert.match((await call('wechat_send', { text: '超过额度', isAtMe: true }, b)).results[0].error, /额度/)
    assert.deepEqual(sends, [['测试群', '第一条'], ['测试私聊', '另一个聊天']])
    const status = await request('/status')
    assert.deepEqual(status.targets.map(({ pending, ready }) => [pending, ready]), [[0, true], [0, false]])
    assert.deepEqual(status.recentSends.map((row) => row.targetName), ['测试私聊', '测试群'])
    assert.equal(status.totals.submitted, 2)
    assert.equal(status.totals.received, 2)
    const quota = new QuotaTracker(join(home, '.dsh', 'dsh-wechatbot', 'quota.json'), 2)
    assert.equal(quota.remaining, 0)
    const synced = await request('/stickers/sync', { targetId: status.targets[0].id })
    assert.equal(synced.stickers.length, 1)
    assert.equal((await request('/stickers/auto-label', {})).ok, true)
    let labelState
    for (let attempt = 0; attempt < 20; attempt += 1) {
      labelState = await request('/stickers')
      if (labelState.job.state !== 'running') break
      await sleep(15)
    }
    assert.equal(labelState.job.state, 'done')
    assert.deepEqual(labelState.stickers[0].tags, ['高兴', '赞同'])
    assert.equal(labelState.stickers[0].source, 'ai')
  } finally {
    await request('/detector', { action: 'stop' })
    for (const finish of cleanup) finish()
  }
})
