import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { SessionDeletion } from '../lib/session-deletion.js'
import { SessionManager } from '../lib/sessions.js'
import { SessionTrigger } from '../lib/trigger.js'
import { NativeStickerPicker } from '../lib/native-picker.js'
import { StickerLibrary, parseStickerLabels } from '../lib/stickers.js'
import { encryptAesEcb } from '../lib/ilink.js'

function withTempHome(t, prefix = 'dsh-wb-') {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile
    rmSync(home, { force: true, recursive: true })
  })
  return home
}

function createHarness(config, { withSystemPrompt = false, controllerOverrides = {} } = {}) {
  const agentDir = config.agentDir
  const workspace = {
    id: 'ws-test',
    path: agentDir,
    sessionIds: [],
    getSessionHeaders() { return this.sessionIds.map((id) => ({ id })) },
    async detachSession(id) { this.sessionIds = this.sessionIds.filter((v) => v !== id) },
  }
  const registry = {
    archivedSessionIds: [],
    list: () => [workspace],
    resolveByPath: () => workspace,
    async archiveSession(id) { this.archivedSessionIds.push(id) },
  }
  const prompts = []
  let onPrompt = null
  const controller = {
    async create(req) {
      const sessionId = `session-${workspace.sessionIds.length + 1}`
      workspace.sessionIds.push(sessionId)
      controllerOverrides.onCreate?.(req, sessionId)
      return { sessionId }
    },
    async prompt(val) { prompts.push(val); onPrompt?.(val) },
    async rename() {},
    async state() { return { running: false } },
    async events() { return { records: [] } },
    ...controllerOverrides,
  }
  const editor = { entries: () => [{ options: { id: 'dsh-wechatbot' } }], edit: async (_e, fn) => fn(config) }
  const tools = new Map()
  const toolMeta = new Map()
  const listeners = new Map()
  const cleanup = []
  let panel
  const services = { workspaceRegistry: registry, sessionController: controller, configEditor: editor }
  if (withSystemPrompt) services.systemPrompt = {}
  const ctx = {
    get: (k) => services[k],
    on: withSystemPrompt ? (ev, fn) => { listeners.set(ev, fn); return () => listeners.delete(ev) } : undefined,
    effect: (fn) => { const end = fn(); if (typeof end === 'function') cleanup.push(end) },
    inject: (_k, fn) => fn(ctx),
    tools: { register: (tool, meta) => { tools.set(tool.name, tool); toolMeta.set(tool.name, meta) } },
    webServer: { register: (route) => { panel = route } },
  }
  apply(ctx, config)
  const request = async (path, body) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      url: panel.path + path,
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
    })
    let status = 200
    let data
    await panel.handler(req, { writeHead(c) { status = c }, end(raw) { data = JSON.parse(raw) } })
    return { status, data }
  }
  const callTool = async (name, args, sessionId) =>
    JSON.parse(await tools.get(name).execute(args, { agent: { id: sessionId } }))
  const toolVisible = (name, sessionId) => toolMeta.get(name)?.when?.({ agent: { id: sessionId } }) ?? true
  const waitNextPrompt = () => new Promise((resolve) => { onPrompt = resolve })
  const disposeAll = () => { for (const fn of cleanup) fn() }
  return { workspace, registry, prompts, listeners, request, callTool, toolVisible, waitNextPrompt, disposeAll }
}

test('targets config migration, memory per-chat scoping, and sticker catalog deduplication/labeling', async (t) => {
  const dir = withTempHome(t, 'dsh-core-')

  // Targets validation
  const old = Config({ expectedGroup: '原目标', chatMode: 'private' })
  assert.equal(configuredTargets(old)[0].mode, 'private')
  assert.deepEqual(configuredTargets(Config({ ...old, targets: [] })), [])
  assert.throws(() => configuredTargets({ targets: [{ name: '测试（12）', mode: 'group' }, { name: '测试', mode: 'private' }] }), /同名/)
  const ten = Array.from({ length: 10 }, (_, i) => ({ name: `会话 ${i}`, mode: 'group' }))
  assert.equal(configuredTargets({ targets: ten }).length, 10)
  assert.throws(() => configuredTargets({ targets: [...ten, { name: '溢出', mode: 'private' }] }), /10/)

  // Per-chat memory isolation
  const memDir = join(dir, 'mem')
  const memory = new MemoryStore({ dir: memDir, maxEntries: 1 })
  const [first, second] = configuredTargets({ targets: [{ name: '甲', mode: 'group' }, { name: '乙', mode: 'private' }] })
  mkdirSync(memDir, { recursive: true })
  writeFileSync(memory.path, '# 用户笔记\n\n原先导入的说明\n')
  memory.append('甲方历史摘要', '2024-01-01 11:01', first.id)
  memory.append('乙方独立记忆', '2024-01-01 11:02', second.id)
  memory.append('甲方今日摘要', '2024-01-01 11:03', first.id)
  assert.match(memory.contextForPrompt({ entries: 3, targetId: first.id, includeLegacy: false }), /甲方历史摘要/)
  const bCtx = memory.contextForPrompt({ entries: 3, targetId: second.id, includeLegacy: false })
  assert.match(bCtx, /乙方独立记忆/)
  assert.match(bCtx, /原先导入的说明/)
  assert.doesNotMatch(bCtx, /甲方/)

  // Legacy sticker migration, manual-over-AI priority, and picker pagination
  const legacyPath = join(dir, 'native-stickers.json')
  const catalogPath = join(dir, 'stickers', 'catalog.json')
  const imgA = Buffer.from('one image').toString('base64')
  const imgB = Buffer.from('two image').toString('base64')
  writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    items: [
      { id: 'aaaaaaaa', image: imgA, source: 'ai', tags: ['开心'], description: '模型标注', revision: 1, available: true },
      { id: 'bbbbbbbb', image: imgA, source: 'manual', tags: ['应援'], description: '手动标注', revision: 1, available: true },
      { id: 'cccccccc', image: imgB, source: 'manual', tags: ['不同'], description: '另一张', revision: 1, available: true },
    ],
  }))
  const lib = new StickerLibrary(catalogPath, { legacyPath })
  await lib.ready()
  const [merged, distinct] = lib.load().items
  assert.equal(merged.description, '手动标注')
  assert.deepEqual(merged.tags, ['应援', '开心'])
  const ai = parseStickerLabels(JSON.stringify([{ id: merged.id, tags: ['覆盖失败'], description: 'x' }]))
  assert.equal(lib.applyLabels([merged], ai), 0)
  lib.remove(merged.id)
  lib.synchronize({ items: [{ image: imgA }, { image: distinct.image }], complete: true })
  assert.deepEqual(lib.load().items.map((i) => i.id), [distinct.id])

  const picker = new NativeStickerPicker({})
  const row = (y, names) => names.map((n, i) => ({ image: Buffer.from(n).toString('base64'), x: 57 + 88 * i, y }))
  const pages = [
    [...row(73, ['a', 'b']), ...row(161, ['c', 'd'])],
    [...row(50, ['clip1', 'clip2']), ...row(124, ['c', 'd']), ...row(212, ['e', 'f'])],
    [...row(50, ['clip1', 'clip2']), ...row(124, ['c', 'd']), ...row(212, ['e', 'f'])],
  ]
  t.mock.method(picker, 'open', async () => ({ path: '', frame: {}, heart: {} }))
  t.mock.method(picker, 'snapshot', async () => {})
  t.mock.method(picker, 'scroll', async () => {})
  t.mock.method(picker, 'act', async () => {})
  t.mock.method(picker, 'helper', async () => ({ cells: pages.shift() }))
  const collected = await picker.collect()
  assert.equal(collected.complete, true)
  assert.deepEqual(collected.items.map((i) => Buffer.from(i.image, 'base64').toString()), ['a', 'b', 'c', 'd', 'e', 'f'])
})

test('multi-chat batch send guard, shared quota, and AI sticker labeling', { timeout: 8000 }, async (t) => {
  const home = withTempHome(t, 'dsh-multi-')
  t.mock.property(process, 'platform', 'darwin')
  let detector
  t.mock.method(DetectorService.prototype, 'start', async function () { detector = this; this.baselineDone = true })
  t.mock.method(DetectorService.prototype, 'stop', async () => ({}))
  t.mock.method(MacOSWeChatClient.prototype, 'isRunning', async () => true)
  t.mock.method(MacOSWeChatClient.prototype, 'targetReadiness', async (targets) => ({ [targets[0].id]: true }))
  t.mock.method(MacOSWeChatClient.prototype, 'collectStickers', async () => ({
    complete: true, items: [{ image: 'aW1hZ2U=', signature: Array(300).fill(100) }],
  }))
  const sends = []
  t.mock.method(MacOSWeChatClient.prototype, 'send', async function (text, options) {
    if (options.requireFront) throw new Error('微信窗口已切换')
    await options.beforeSubmit()
    sends.push([this.expectedGroup, text])
    return { sent: text, delaySeconds: 0 }
  })

  const agentDir = join(home, 'agent')
  const config = {
    agentDir,
    targets: [{ name: '测试群', mode: 'group' }, { name: '测试私聊', mode: 'private' }],
    dailyProactiveLimit: 2,
    ocrEnabled: false,
    dragCopyEnabled: false,
    attachScreenshot: false,
    replyDelayMinSeconds: 0,
    replyDelayMaxSeconds: 0,
  }
  let harness
  harness = createHarness(config, {
    controllerOverrides: {
      onCreate(req, id) { if (id === 'session-3') assert.equal(req.agentPreset, 'wechatbot-sticker-labels') },
      async openWorkspacePath(req) { assert.deepEqual(req, { path: agentDir }); return { opened: true } },
      async wait({ sessionId }) {
        const p = harness.prompts.find((r) => r.sessionId === sessionId)
        const id = p.content.at(-2).text.split(' ').at(-1)
        const text = JSON.stringify([{ id, tags: ['高兴', '赞同'], description: '用来表达认可' }])
        return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message', data: { content: [{ type: 'text', text }] } } }] } }
      },
    },
  })

  try {
    assert.equal((await harness.request('/workspace/open', {})).data.ok, true)
    assert.equal((await harness.request('/settings', { documents: { agent: '# 导入角色\n' } })).data.ok, true)
    assert.equal((await harness.request('/detector', { action: 'start' })).data.ok, true)
    assert.equal(detector.enqueue([
      { groupName: '测试群', sender: '成员', content: '重复文字', isAtMe: true },
      { groupName: '测试私聊', sender: '成员', content: '重复文字', isAtMe: true },
      { groupName: '测试', sender: '成员', content: '非目标群', isAtMe: true },
    ], 'notification'), 2)
    for (let i = 0; harness.prompts.length < 2 && i < 40; i += 1) await sleep(20)
    assert.match(harness.prompts[0].content[0].text, /导入角色/)

    const [a, b] = harness.prompts.map((p) => p.sessionId)
    const batch = await harness.callTool('wechat_send_many', { messages: ['第一条', '切窗失败'] }, a)
    assert.equal(batch.sentCount, 1)
    assert.match(batch.results[1].error, /窗口已切换/)
    assert.equal((await harness.callTool('wechat_send', { text: '另一个聊天' }, b)).ok, true)
    assert.match((await harness.callTool('wechat_send', { text: '超额' }, b)).results[0].error, /额度/)
    assert.deepEqual(sends, [['测试群', '第一条'], ['测试私聊', '另一个聊天']])
    assert.equal(new QuotaTracker(join(home, '.dsh', 'dsh-wechatbot', 'quota.json'), 2).remaining, 0)

    const status = (await harness.request('/status')).data
    await harness.request('/stickers/sync', { targetId: status.targets[0].id })
    await harness.request('/stickers/auto-label', {})
    let st
    for (let i = 0; i < 20; i += 1) {
      st = (await harness.request('/stickers')).data
      if (st.job.state !== 'running') break
      await sleep(15)
    }
    assert.equal(st.job.state, 'done')
    assert.deepEqual(st.stickers[0].tags, ['高兴', '赞同'])
  } finally {
    await harness.request('/detector', { action: 'stop' })
    harness.disposeAll()
  }
})

test('session isolation, workspace detach guard, maxTurns auto-rotation, and system-prompt/assemble injection', { timeout: 6000 }, async (t) => {
  const home = withTempHome(t, 'dsh-sess-')
  t.mock.property(process, 'platform', 'darwin')
  let detector
  t.mock.method(DetectorService.prototype, 'start', async function () { detector = this; this.baselineDone = true })
  t.mock.method(DetectorService.prototype, 'stop', async () => ({ running: false }))
  const ensureWin = t.mock.method(MacOSWeChatClient.prototype, 'ensureTargetWindow', async () => ({ ok: true }))
  t.mock.method(MacOSWeChatClient.prototype, 'readVisible', async () => ({
    source: 'ocr',
    group: '测试群',
    messages: [
      { groupName: '测试群', sender: '甲', content: '旧消息' },
      { groupName: '测试群', sender: '甲', content: '@豆包 第二轮' },
    ],
  }))

  // Direct SessionManager maxTurns unit check
  const unitMem = new MemoryStore({ dir: join(home, 'u-mem') })
  const mgr = new SessionManager({ memory: unitMem, maxTurns: 3, stateOf: async () => false })
  mgr.register('w1')
  for (let i = 0; i < 3; i += 1) {
    assert.equal(mgr.openWindow()?.sessionId, 'w1')
    mgr.touch('w1', { messages: 1 })
  }
  assert.equal(mgr.openWindow(), null)

  // Detach failure guard check
  const failServices = {
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [{ id: 'w', path: '/a', sessionIds: ['s1'], detachSession: async () => { throw new Error('write failed') } }],
      async archiveSession(id) { this.archivedSessionIds.push(id) },
    },
    sessionController: { state: async () => ({ running: false }), prompt: async () => {} },
  }
  const failTrigger = new SessionTrigger({ ctx: { get: (k) => failServices[k] }, agentDir: '/a' })
  const failedRemove = await failTrigger.removeSession('s1')
  assert.equal(failedRemove.removed, false)
  await assert.rejects(failTrigger.wake('s1', 'hi'), /会话已归档或移除/)

  // End-to-end system-prompt/assemble + maxTurnsPerSession=2 proactive archive + wechat_read scoping
  const agentDir = join(home, 'bot-agent')
  const harness = createHarness({
    agentDir,
    expectedGroup: '测试群',
    maxTurnsPerSession: 2,
    captureProtected: true,
    replyCooldownSeconds: 0,
  }, { withSystemPrompt: true })

  const incoming = async (content) => {
    const next = harness.waitNextPrompt()
    detector.enqueue([{ groupName: '测试群', sender: '甲', content, isAtMe: true }], 'notification')
    return next
  }

  try {
    await harness.request('/detector', { action: 'start' })
    const p1 = await incoming('@豆包 第一轮')
    assert.equal(p1.sessionId, 'session-1')
    assert.doesNotMatch(p1.content[0].text, /AGENT\.md|PERSONA\.md/)
    assert.equal(ensureWin.mock.callCount(), 0)

    const assemble = harness.listeners.get('system-prompt/assemble')
    const botSys = await assemble(null, { agent: { id: 'session-1' } }, async () => ({ sections: [{ name: 'persona', text: 'old' }] }))
    assert.match(botSys.sections[0].text, /AGENT\.md[\s\S]*PERSONA\.md/)
    const otherSys = await assemble(null, { agent: { id: 'unrelated' } }, async () => ({ sections: [{ name: 'persona', text: 'keep' }] }))
    assert.equal(otherSys.sections[0].text, 'keep')

    const p2 = await incoming('@豆包 第二轮')
    assert.equal(p2.sessionId, 'session-1')

    // Turn 3 rotates: session-1 proactively archived & summarized into MEMORY.md, session-2 opened
    const p3 = await incoming('@豆包 第三轮')
    assert.equal(p3.sessionId, 'session-2')
    assert.ok(harness.registry.archivedSessionIds.includes('session-1'))
    assert.match(new MemoryStore({ dir: agentDir }).read(), /这段聊了 2 条消息/)
    assert.deepEqual((await harness.callTool('wechat_read', { mode: 'ocr' }, 'session-1')).messages, [])
  } finally {
    await harness.request('/detector', { action: 'stop' })
    harness.disposeAll()
  }
})

test('offline session deletion worker waits for host exit and removes only authorized files', {
  skip: process.platform !== 'darwin' && process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const home = withTempHome(t, 'dsh-del-')
  const root = join(home, '.dsh')
  const bucket = '--users-fixture-.dsh-dsh-wechatbot-agent--'
  const id = 'authorized-test-session'
  const jobDir = join(root, 'dsh-wechatbot', 'pending-deletions')
  const folder = join(root, 'sessions', bucket, id)
  const untouched = join(root, 'sessions', bucket, 'other-session')
  const cacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
  for (const p of [jobDir, folder, untouched, cacheRoot]) mkdirSync(p, { recursive: true })
  const log = join(folder, 'test.jsonl.zstd')
  const cache = join(cacheRoot, `${id}.json`)
  const job = join(jobDir, `${id}.json`)
  writeFileSync(log, 'simulated')
  writeFileSync(join(folder, 'session.lock'), '')
  writeFileSync(cache, '{}')
  writeFileSync(job, JSON.stringify({ id, bucket, stage: 'waiting' }))

  const deletion = new SessionDeletion({ home, trigger: {}, ctx: {} })
  assert.equal(deletion.logBucket({ kind: 'jsonl', path: log }, id), bucket)

  const worker = await deletion.worker()
  const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true })
  const stopped = once(host, 'exit')
  const purge = spawn(worker, [root, id, String(host.pid)], { windowsHide: true })
  const completed = once(purge, 'exit')
  t.after(() => { if (host.exitCode === null) host.kill(); if (purge.exitCode === null) purge.kill() })

  await sleep(250)
  assert.equal(existsSync(log), true)
  host.kill()
  await stopped
  assert.equal((await completed)[0], 0)
  assert.equal(JSON.parse(readFileSync(job, 'utf8')).stage, 'purged')
  assert.equal(existsSync(folder), false)
  assert.equal(existsSync(cache), false)
  assert.equal(existsSync(untouched), true)

  let archived = true
  let inSearch = true
  const verifier = new SessionDeletion({
    home,
    trigger: {
      registry: { list: () => [] },
      controller: { list: async () => ({ items: [] }), search: async () => ({ items: inSearch ? [{ sessionId: id }] : [] }) },
      isArchived: () => archived,
      unarchive: async () => { archived = false; return { archived: false } },
    },
    ctx: { get: () => ({ stat: async () => undefined }) },
  })
  await verifier.visitJobs()
  assert.equal(existsSync(job), true)
  inSearch = false
  await verifier.visitJobs()
  assert.equal(archived, false)
  assert.equal(existsSync(job), false)
})

test('headless clawbot QR bind, typing indicator, AES image inbound/sticker outbound without desktop WeChat', {
  timeout: 10_000,
}, async (t) => {
  const home = withTempHome(t, 'dsh-claw-')
  t.mock.property(process, 'platform', 'darwin')
  t.mock.method(MacOSWeChatClient.prototype, 'isRunning', async () => false)

  const inboundPng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const mediaKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const encryptedInbound = encryptAesEcb(inboundPng, mediaKey)
  let pushed = false
  const apiCalls = []

  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    apiCalls.push({ url: String(url), body })
    if (String(url).includes('get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'q-1', qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/1' }), { status: 200 })
    }
    if (String(url).includes('get_qrcode_status')) {
      return new Response(JSON.stringify({
        status: 'confirmed', bot_token: 'bot-tok-1', ilink_bot_id: 'claw01@im.bot', ilink_user_id: 'peer01@im.wechat',
      }), { status: 200 })
    }
    if (String(url).includes('getupdates')) {
      if (pushed) {
        await new Promise((resolve) => init.signal?.addEventListener('abort', resolve, { once: true }))
        return new Response(JSON.stringify({ ret: 0, msgs: [] }), { status: 200 })
      }
      pushed = true
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: 'buf-2',
        msgs: [{
          message_id: 9007199254740999,
          from_user_id: 'peer01@im.wechat',
          message_type: 1,
          context_token: 'ctx-tok-1',
          item_list: [
            { type: 1, text_item: { text: '帮我看看这张图' } },
            { type: 2, image_item: { aeskey: mediaKey.toString('hex'), media: { encrypt_query_param: 'dl-1' } } },
          ],
        }],
      }), { status: 200 })
    }
    if (String(url).includes('/download?encrypted_query_param=dl-1')) {
      return new Response(encryptedInbound, { status: 200 })
    }
    if (String(url).includes('getconfig')) {
      return new Response(JSON.stringify({ ret: 0, typing_ticket: 'ticket-1' }), { status: 200 })
    }
    if (String(url).includes('getuploadurl')) {
      return new Response(JSON.stringify({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/mock-up' }), { status: 200 })
    }
    if (String(url).includes('mock-up')) {
      assert.equal(init.method, 'POST')
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl-out-1' } })
    }
    return new Response(JSON.stringify({ ret: 0, message_id: 8801 }), { status: 200 })
  })

  const agentDir = join(home, 'claw-agent')
  mkdirSync(join(agentDir, 'stickers'), { recursive: true })
  const stickerImg = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
  const lib = new StickerLibrary(join(agentDir, 'stickers', 'catalog.json'))
  lib.synchronize({ items: [{ image: stickerImg }], complete: true })
  const stickerId = lib.load().items[0].id
  lib.edit(stickerId, { tags: ['点头'], description: '收到赞同' })

  const config = {
    agentDir,
    targets: [],
    maxMessageChars: 20,
    replyDelayMinSeconds: 0,
    replyDelayMaxSeconds: 0,
  }
  const harness = createHarness(config, { withSystemPrompt: true })

  try {
    const startQr = await harness.request('/ilink/login/start', {})
    assert.equal(startQr.status, 200)
    let qrState = startQr.data
    for (let i = 0; i < 30 && !qrState.connected; i += 1) {
      await sleep(15)
      qrState = (await harness.request('/ilink/login/status', { sessionKey: startQr.data.sessionKey })).data
    }
    assert.equal(qrState.connected, true)

    await harness.request('/settings', {
      targets: [{ name: '测试官方私聊', mode: 'clawbot', accountId: qrState.accountId, userId: qrState.userId }],
    })
    const status = (await harness.request('/status')).data
    assert.equal(status.connected, false)
    assert.equal(status.canStart, true)
    assert.equal(status.targets[0].mode, 'clawbot')
    assert.equal(status.targets[0].ready, true)

    const nextPrompt = harness.waitNextPrompt()
    assert.equal((await harness.request('/detector', { action: 'start' })).data.ok, true)
    const wake = await nextPrompt
    assert.equal(wake.content[1].type, 'image')
    assert.equal(wake.content[1].mediaType, 'image/png')
    assert.equal(wake.content[1].data, inboundPng.toString('base64'))

    await sleep(30)
    assert.ok(apiCalls.some((c) => c.url.includes('sendtyping') && c.body.status === 1))

    const readOut = await harness.callTool('wechat_read', {}, wake.sessionId)
    assert.equal(readOut.source, 'ilink')
    assert.match(readOut.messages[0].content, /帮我看看这张图/)

    const sent = await harness.callTool('wechat_send_many', {
      messages: ['这条超过二十个字符的回复必须被全局字数上限拦住', '短句秒回'],
    }, wake.sessionId)
    assert.equal(sent.sentCount, 1)
    assert.match(sent.results[0].error, /20 字/)
    const sendTextCall = apiCalls.find((c) => c.url.includes('sendmessage') && c.body.msg.item_list[0].type === 1)
    assert.equal(sendTextCall.body.msg.context_token, 'ctx-tok-1')
    assert.equal(sendTextCall.body.msg.item_list[0].text_item.text, '短句秒回')

    const stickerRes = await harness.callTool('wechat_stickers', { action: 'send', id: stickerId }, wake.sessionId)
    assert.equal(stickerRes.ok, true)
    const sendImgCall = apiCalls.find((c) => c.url.includes('sendmessage') && c.body.msg.item_list[0].type === 2)
    assert.equal(sendImgCall.body.msg.item_list[0].image_item.media.encrypt_query_param, 'dl-out-1')
  } finally {
    await harness.request('/detector', { action: 'stop' })
    harness.disposeAll()
    assert.ok(apiCalls.some((c) => c.url.includes('notifystop')))
  }
})

test('admin dual-layer remote control, slash commands, bidirectional files, memory schedule, and empty-@ debounce', {
  timeout: 12_000,
}, async (t) => {
  const home = withTempHome(t, 'dsh-admin-')
  t.mock.property(process, 'platform', 'darwin')
  t.mock.method(MacOSWeChatClient.prototype, 'isRunning', async () => false)

  const fileKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const fileBuf = Buffer.from('console.log("hello remote")', 'utf8')
  const encFile = encryptAesEcb(fileBuf, fileKey)
  const storeDir = join(home, '.dsh', 'dsh-wechatbot')
  const { IlinkStore } = await import('../lib/ilink.js')
  const ilinkStore = new IlinkStore(storeDir)
  ilinkStore.saveAccount({ rawBotId: 'adm@im.bot', token: 'adm-tok', userId: 'boss@im.wechat' })

  const outSent = []
  let pollIdx = 0
  let devReply = '**已完成**：检查了 `index.js`'
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    if (u.includes('getupdates')) {
      pollIdx += 1
      if (pollIdx === 1) {
        return new Response(JSON.stringify({
          ret: 0,
          get_updates_buf: 'b1',
          msgs: [
            { message_id: '101', from_user_id: 'intruder@im.wechat', message_type: 1, context_token: 'c-bad', item_list: [{ type: 1, text_item: { text: '/status' } }] },
            { message_id: '102', from_user_id: 'boss@im.wechat', message_type: 1, context_token: 'c-adm', item_list: [
              { type: 4, file_item: { file_name: 'report.txt', media: { encrypt_query_param: 'f1', aes_key: fileKey.toString('base64') } } },
              { type: 1, text_item: { text: '帮我写到备忘并发个回执' } },
            ] },
          ],
        }), { status: 200 })
      }
      if (pollIdx === 2) {
        await sleep(30)
        return new Response(JSON.stringify({
          ret: 0, get_updates_buf: 'b2',
          msgs: [{ message_id: '103', from_user_id: 'boss@im.wechat', message_type: 1, context_token: 'c-adm', item_list: [{ type: 1, text_item: { text: '/help' } }] }],
        }), { status: 200 })
      }
      if (pollIdx === 3) {
        await sleep(30)
        return new Response(JSON.stringify({
          ret: 0, get_updates_buf: 'b3',
          msgs: [{ message_id: '104', from_user_id: 'boss@im.wechat', message_type: 1, context_token: 'c-adm', item_list: [{ type: 1, text_item: { text: '/dev on' } }] }],
        }), { status: 200 })
      }
      if (pollIdx === 4) {
        await sleep(30)
        return new Response(JSON.stringify({
          ret: 0, get_updates_buf: 'b4',
          msgs: [{ message_id: '105', from_user_id: 'boss@im.wechat', message_type: 1, context_token: 'c-adm', item_list: [{ type: 1, text_item: { text: '直接帮我跑一下单测' } }] }],
        }), { status: 200 })
      }
      await new Promise((resolve) => init.signal?.addEventListener('abort', resolve, { once: true }))
      return new Response(JSON.stringify({ ret: 0, msgs: [] }), { status: 200 })
    }
    if (u.includes('encrypted_query_param=f1')) return new Response(encFile, { status: 200 })
    if (u.includes('getuploadurl')) return new Response(JSON.stringify({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/up-file' }), { status: 200 })
    if (u.includes('up-file')) return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl-out-file' } })
    if (u.includes('sendmessage')) {
      outSent.push(body.msg)
      return new Response(JSON.stringify({ ret: 0, message_id: '999' }), { status: 200 })
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
  })

  const agentDir = join(home, 'admin-agent')
  const projectWs = join(home, 'my-proj')
  mkdirSync(projectWs, { recursive: true })
  const config = {
    agentDir,
    targets: [
      { name: '主人遥控', mode: 'clawbot', accountId: 'adm-im-bot', userId: 'boss@im.wechat', role: 'admin', workspacePath: projectWs },
    ],
    replyDelayMinSeconds: 0,
    replyDelayMaxSeconds: 0,
  }
  let createdReqs = []
  let harness
  harness = createHarness(config, {
    withSystemPrompt: true,
    controllerOverrides: {
      onCreate(req) { createdReqs.push(req) },
      async wait({ sessionId }) {
        await sleep(25)
        const text = sessionId === 'session-1' ? '' : devReply
        return { reason: 'idle', output: { records: [{ event: { type: 'assistant/message', data: { content: [{ type: 'text', text }] } } }] } }
      },
    },
  })

  try {
    const firstWake = harness.waitNextPrompt()
    await harness.request('/detector', { action: 'start' })
    const p1 = await firstWake
    assert.equal(p1.sessionId, 'session-1')
    assert.equal(createdReqs[0].agentPreset, 'standard')
    assert.match(p1.content[0].text, /report\.txt/)
    assert.equal(readFileSync(join(projectWs, '.wechatbot-inbox', 'report.txt'), 'utf8'), 'console.log("hello remote")')

    assert.equal(harness.toolVisible('wechat_send_file', 'session-1'), true)
    assert.equal(harness.toolVisible('wechat_schedule', 'session-1'), true)
    assert.equal(harness.toolVisible('wechat_notify_admin', 'external-dsh-session'), true)

    assert.equal((await harness.callTool('wechat_memory', { action: 'note', text: '以后早上问好' }, 'session-1')).ok, true)
    assert.equal((await harness.callTool('wechat_schedule', { action: 'add', label: '早安问候', kind: 'daily', time: '09:00' }, 'session-1')).ok, true)
    const outFile = join(projectWs, 'summary.txt')
    writeFileSync(outFile, 'done', 'utf8')
    assert.equal((await harness.callTool('wechat_send_file', { path: 'summary.txt' }, 'session-1')).ok, true)
    assert.equal((await harness.callTool('wechat_notify_admin', { text: '后台编译完成' }, 'external-dsh-session')).ok, true)

    const devWake = harness.waitNextPrompt()
    const p2 = await devWake
    assert.equal(p2.sessionId, 'session-2')
    assert.equal(p2.content[0].text, '直接帮我跑一下单测')
    assert.equal(harness.toolVisible('wechat_schedule', 'session-2'), false)
    assert.equal(harness.toolVisible('wechat_send_file', 'session-2'), true)
    const assemble = harness.listeners.get('system-prompt/assemble')
    const devSys = await assemble(null, { agent: { id: 'session-2' } }, async () => ({ sections: [{ name: 'persona', text: 'raw-harness' }] }))
    assert.equal(devSys.sections[0].text, 'raw-harness')

    for (let i = 0; i < 30 && !outSent.some((m) => m.item_list?.[0]?.text_item?.text?.includes('已完成：检查了')); i += 1) {
      await sleep(20)
    }
    assert.ok(outSent.some((m) => m.item_list?.[0]?.text_item?.text?.includes('/dev')))
    assert.ok(outSent.some((m) => m.item_list?.[0]?.file_item?.file_name === 'summary.txt'))
    assert.ok(outSent.some((m) => m.item_list?.[0]?.text_item?.text === '后台编译完成'))
    assert.ok(outSent.some((m) => m.item_list?.[0]?.text_item?.text?.includes('已完成：检查了')))
    assert.ok(!outSent.some((m) => m.to_user_id === 'intruder@im.wechat'))
  } finally {
    await harness.request('/detector', { action: 'stop' })
    harness.disposeAll()
  }
})

test('desktop empty-@ 3.5s debounce merges follow-up content into a single wake turn', async (t) => {
  const home = withTempHome(t, 'dsh-debounce-')
  t.mock.property(process, 'platform', 'darwin')
  let detector
  t.mock.method(DetectorService.prototype, 'start', async function () { detector = this; this.baselineDone = true })
  t.mock.method(DetectorService.prototype, 'stop', async () => ({ running: false }))

  const harness = createHarness({
    agentDir: join(home, 'agent'),
    targets: [{ name: '水群', mode: 'group' }],
    mentionMergeSeconds: 0.25,
    captureProtected: true,
    dragCopyEnabled: false,
    attachScreenshot: false,
  })
  try {
    await harness.request('/detector', { action: 'start' })
    const wake = harness.waitNextPrompt()
    detector.enqueue([{ groupName: '水群', sender: '老王', content: '', isAtMe: true, needsOcr: true }], 'notification')
    await sleep(60)
    assert.equal(harness.prompts.length, 0)
    detector.enqueue([{ groupName: '水群', sender: '老王', content: '扎啤走起', isAtMe: false }], 'notification')
    const p = await wake
    assert.match(p.content[0].text, /通知未提供正文[\s\S]*扎啤走起/)
  } finally {
    await harness.request('/detector', { action: 'stop' })
    harness.disposeAll()
  }
})
