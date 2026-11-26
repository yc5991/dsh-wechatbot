import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply, Config } from '../index.js'
import { MacOSWeChatClient } from '../lib/wechat-macos.js'
import { WindowsWeChatClient } from '../lib/wechat-windows.js'
import { MessageNotifier } from '../lib/notifier.js'
import { parseClipboardTranscript } from '../lib/transcript.js'
import { jitterComposerPoint, normalizeAntiDetection, shouldTypeViaKeyboard, splitTypingChunks } from '../lib/humanize.js'
import { encodeQrMatrix, qrSvgDataUrl } from '../lib/qrcode-svg.js'
import { decryptAesEcb, encryptAesEcb, IlinkLoginManager, IlinkStore, parseWeixinAesKey, parseWeixinJson } from '../lib/ilink.js'

test('defaults, multi-format clipboard parser, and anti-detection humanize primitives', () => {
  const defaults = Config({})
  assert.equal(defaults.agentPreset, 'wechatbot')
  assert.equal(defaults.captureProtected, false)
  assert.equal(defaults.maxTurnsPerSession, 30)
  assert.deepEqual(normalizeAntiDetection(defaults.antiDetection), {
    enabled: true, phraseTyping: true, curvedMouse: true, naturalCadence: true, minimalTouch: true,
  })

  const parsed = parseClipboardTranscript('张三 2026/11/26 02:30\n第一行\n第二行\n\n李四\n2026年11月26日 02:31\n[图片]')
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].content, '第一行\n第二行')
  assert.equal(parsed.messages[1].hasImage, true)

  assert.equal(shouldTypeViaKeyboard('日常短句直接敲字'), true)
  assert.equal(shouldTypeViaKeyboard('带链接走粘贴 https://example.com'), false)
  assert.equal(shouldTypeViaKeyboard('日常短句', 'paste'), false)

  const sample = '说白了就是 API 代购中转站，懂了吧？'
  const chunks = splitTypingChunks(sample)
  assert.equal(chunks.map((c) => c.text).join(''), sample)
  assert.ok(chunks.length >= 5 && chunks.every((c) => c.delayMs >= 50))

  const pts = Array.from({ length: 12 }, () => jitterComposerPoint({ x: 100, y: 50, w: 600, h: 560 }, 560, 50))
  assert.ok(new Set(pts.map((p) => p.x)).size > 3)
})

test('macOS drag-copy truncation fallback and sharing=0 capture-free read/type/paste/image pipeline', async (t) => {
  t.mock.property(process, 'platform', 'darwin')

  // 1. Normal mode: OCR-anchored drag falls back when clipboard misses tail
  const normal = new MacOSWeChatClient({ expectedGroup: '测试群' })
  const win = { id: 1, title: '测试群', x: 80, y: 30, width: 800, height: 600, onscreen: true, sharing: 1 }
  const region = { x: 80, y: 30, w: 800, h: 516 }
  const items = [
    { text: '测试群', x: 0.1, y: 0.05, w: 0.1, h: 0.02 },
    { text: '首条消息', x: 0.17, y: 0.22, w: 0.15, h: 0.02 },
    { text: '末尾消息', x: 0.17, y: 0.95, w: 0.18, h: 0.02 },
  ]
  t.mock.method(normal, 'getChatWindow', async () => win)
  t.mock.method(normal, 'captureChatRegion', async () => ({ title: win.title, region, items }))
  t.mock.method(normal, 'ensureDragBinary', async () => {})
  t.mock.method(normal, 'activateApp', async () => {})
  t.mock.method(normal, 'frontWindowTitle', async () => win.title)
  t.mock.method(normal, 'listWindows', async () => [win])
  let rawClip = '甲\n2024年1月1日 12:34\n首条消息\n\n乙\n2024年1月1日 12:35\n末尾消息'
  t.mock.method(normal, 'runHelper', async () => rawClip)
  assert.equal((await normal.readVisible({ mode: 'auto' })).source, 'copy')
  rawClip = '甲\n2024年1月1日 12:34\n首条消息'
  const fb = await normal.readVisible({ mode: 'auto' })
  assert.notEqual(fb.source, 'copy')
  assert.match(fb.copyIssue, /缺少可见消息/)

  // 2. Protected mode (sharing=0): zero screenshots on read, phrase-type, URL paste, and image send
  const client = new MacOSWeChatClient({ expectedGroup: '测试群', replyDelayMinSeconds: 0, replyDelayMaxSeconds: 0 })
  const pWin = { ...win, id: 42, title: '测试群 (8)', sharing: 0 }
  t.mock.method(client, 'listWindows', async () => [pWin])
  t.mock.method(client, 'frontWindowTitle', async () => pWin.title)
  t.mock.method(client, 'activateApp', async () => {})
  t.mock.method(client, 'ensureDragBinary', async () => {})
  const clickSpy = t.mock.method(client, 'clickComposer', async () => {})
  const pasteSpy = t.mock.method(client, 'pasteIntoComposer', async () => {})
  const typed = []
  t.mock.method(client, 'typeIntoComposer', async (txt) => typed.push(txt))
  t.mock.method(client, 'clearComposer', async () => {})
  t.mock.method(client, 'pressReturn', async () => {})
  t.mock.method(client, 'setClipboardImage', async () => {})
  let sysClip = ''
  t.mock.method(client, 'setClipboard', async (v) => { sysClip = v })
  t.mock.method(client, 'readClipboardText', async () => sysClip)
  const forbidden = t.mock.method(client, 'withChatCapture', async () => { throw new Error('must not capture') })
  t.mock.method(client, 'runHelper', async () => '王五\n2026年11月26日 03:10\n@豆包 防截屏可读')

  assert.equal((await client.readVisible({ mode: 'auto' })).messages[0].sender, '王五')
  assert.equal((await client.send('**收到**，没问题')).mode, 'type')
  assert.equal((await client.send('连发不重点击输入框', { requireFront: true })).mode, 'type')
  assert.equal(clickSpy.mock.callCount(), 1)
  assert.equal(pasteSpy.mock.callCount(), 0)
  assert.equal((await client.send('链接自动走粘贴 https://example.com', { requireFront: true })).mode, 'paste')
  assert.equal(pasteSpy.mock.callCount(), 1)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-img-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const img = join(dir, 'a.png')
  writeFileSync(img, Buffer.from('89504e470d0a1a0a', 'hex'))
  assert.equal((await client.sendImage(img)).kind, 'image')
  assert.equal(forbidden.mock.callCount(), 0)
})

test('panel API saves captureProtected and antiDetection settings and blocks /screenshot', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-panel-'))
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE
  process.env.HOME = home; process.env.USERPROFILE = home
  const cleanup = []
  t.after(() => {
    if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH
    if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU
    rmSync(home, { recursive: true, force: true })
  })
  t.mock.property(process, 'platform', 'darwin')
  t.mock.method(MacOSWeChatClient.prototype, 'isRunning', async () => true)
  t.mock.method(MacOSWeChatClient.prototype, 'targetReadiness', async () => ({}))
  t.mock.method(MacOSWeChatClient.prototype, 'hasCaptureProtectedWindow', async () => true)

  const config = { agentDir: join(home, 'agent'), targets: [{ name: '测试群', mode: 'group' }] }
  let panel
  const ctx = {
    get: (k) => ({ configEditor: { entries: () => [{ options: { id: 'dsh-wechatbot' } }], edit: async (_e, fn) => fn(config) } })[k],
    effect: (fn) => { const end = fn(); if (end) cleanup.push(end) },
    inject: (_k, fn) => fn(ctx),
    tools: { register: () => {} },
    webServer: { register: (r) => { panel = r } },
  }
  apply(ctx, config)
  const call = async (path, body) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      url: panel.path + path, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
    })
    let status = 200, payload
    await panel.handler(req, { writeHead(c) { status = c }, end(d) { payload = JSON.parse(d) } })
    return { status, payload }
  }

  try {
    assert.equal((await call('/status')).payload.windowCaptureProtected, true)
    const saved = await call('/settings', { captureProtected: true, antiDetection: { phraseTyping: false } })
    assert.equal(saved.payload.settings.captureProtected, true)
    assert.equal(saved.payload.settings.antiDetection.phraseTyping, false)
    assert.equal((await call('/screenshot', { targetId: saved.payload.settings.targets?.[0]?.id })).status, 409)
  } finally {
    for (const end of cleanup) end()
  }
})

test('WindowsWeChatClient UIA/copy fallback, C# helper + WinRT OCR, and Windows Toast SQLite notifier', {
  timeout: 45_000,
}, async (t) => {
  // 1. Mocked behavioral verification (runs on any OS)
  const origPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    const client = new WindowsWeChatClient({ expectedGroup: '开发群', captureProtected: true, replyDelayMinSeconds: 0, replyDelayMaxSeconds: 0 })
    const dWin = { id: 1001, title: '开发群 (24)', className: 'mmui::ChatSingleWindow', x: 0, y: 0, width: 800, height: 640, onscreen: true, sharing: 1, frontmost: true }
    let uiaOk = true, front = dWin.title
    t.mock.method(client, 'callHelper', async (args, opts) => {
      const cmd = args[0]
      if (cmd === 'windows') return { running: true, windows: [dWin] }
      if (cmd === 'front') return { isWeChat: Boolean(front), id: dWin.id, title: front }
      if (cmd === 'uia-read') return uiaOk ? { available: true, title: '开发群', items: [{ text: '甲', x: 0.14, y: 0.25, w: 0.05, h: 0.025 }, { text: '@豆包 测试', x: 0.17, y: 0.28, w: 0.3, h: 0.03 }] } : { available: false, items: [] }
      if (cmd === 'drag-copy') return { ok: true, text: '乙\n2026/11/26 03:20\n拖选兜底' }
      if (cmd === 'composer-action') return { ok: true }
      if (cmd === 'type-chunks') { assert.equal(JSON.parse(opts.stdin).map((c) => c.text).join(''), '搞定了'); return { ok: true } }
      throw new Error(`Unexpected: ${cmd}`)
    })
    assert.equal((await client.readVisible({ mode: 'auto' })).source, 'uia')
    uiaOk = false
    assert.equal((await client.readVisible({ mode: 'auto' })).source, 'copy')
    assert.equal((await client.send('搞定了')).mode, 'type')
    front = '其他窗口'
    await assert.rejects(client.send('中止'), /窗口已切换/)
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  }

  // 2. Windows Toast SQLite notification store parsing
  const dir = mkdtempSync(join(tmpdir(), 'dsh-win-all-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'wpndatabase.db')
  const ft = BigInt(Math.round((Date.now() / 1000) * 10_000_000)) + 116444736000000000n
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE NotificationHandler (RecordId INT PRIMARY KEY, PrimaryId TEXT)")
con.execute("CREATE TABLE Notification ([Order] INTEGER PRIMARY KEY, Id INT, HandlerId INT, Type TEXT, Payload BLOB, ArrivalTime INT)")
con.execute("INSERT INTO NotificationHandler VALUES (10, 'Tencent.Weixin.Desktop'), (11, 'Microsoft.YourPhone!com.tencent.xin')")
con.execute("INSERT INTO Notification VALUES (1, 501, 10, 'toast', ?, ?)", ('<toast><visual><binding><text>核心群</text><text>[2条] 张三: @豆包 在吗</text></binding></visual></toast>'.encode(), int(sys.argv[2])))
con.execute("INSERT INTO Notification VALUES (2, 502, 11, 'toast', ?, ?)", ('<toast><visual><binding><text>噪音</text><text>王五: 忽略</text></binding></visual></toast>'.encode(), int(sys.argv[2]) + 1000))
con.commit(); con.close()
`, dbPath, ft.toString()], { windowsHide: true })
  const notifier = new MessageNotifier({ dbPath, platform: 'win32' })
  const msgs = await notifier.read({ limit: 5, sinceSeconds: 600 })
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].sender, '张三')
  assert.equal(msgs[0].content, '@豆包 在吗')

  // 3. Real C# helper compilation + WinRT Chinese OCR on Windows hosts
  if (process.platform === 'win32') {
    const liveClient = new WindowsWeChatClient({ expectedGroup: '测试群' })
    assert.ok((await liveClient.ensureHelperBinary()).endsWith('.exe'))
    assert.ok((await liveClient.callHelper(['display'])).width > 0)
    const ocrPng = join(dir, 'ocr.png'), tilePng = join(dir, 'tile.png'), manifest = join(dir, 'm.json')
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `
      Add-Type -AssemblyName System.Drawing
      $b = New-Object System.Drawing.Bitmap(420, 140); $g = [System.Drawing.Graphics]::FromImage($b)
      $g.Clear([System.Drawing.Color]::White)
      $g.DrawString('测试群消息识别', (New-Object System.Drawing.Font('Microsoft YaHei', 22)), [System.Drawing.Brushes]::Black, 20, 45)
      $g.Dispose(); $b.Save('${ocrPng.replace(/'/g, "''")}'); $b.Dispose()
      $t = New-Object System.Drawing.Bitmap(64, 64); $gt = [System.Drawing.Graphics]::FromImage($t)
      $gt.Clear([System.Drawing.Color]::White); $gt.FillEllipse([System.Drawing.Brushes]::DodgerBlue, 8, 8, 48, 48)
      $gt.Dispose(); $t.Save('${tilePng.replace(/'/g, "''")}'); $t.Dispose()
    `], { windowsHide: true })
    writeFileSync(manifest, JSON.stringify({ s1: tilePng }))
    assert.equal(Buffer.from((await liveClient.callHelper(['fingerprints', manifest])).s1, 'base64').length, 24 * 24 * 3)
    const lines = await liveClient.ocrImage(ocrPng)
    assert.match(lines.map((l) => l.text).join(''), /测试群消息识别/)
  }
})

test('qrcode-svg generator, lossless uint64/AES helpers, and iLink QR login state machine', async (t) => {
  const qr = encodeQrMatrix('https://ilinkai.weixin.qq.com/q/test-bot-001')
  assert.ok(qr.size >= 21 && qr.size % 2 === 1)
  assert.equal(qr.modules[0][0], 1)
  assert.equal(qr.modules[0][qr.size - 7], 1)
  assert.equal(qr.modules[qr.size - 7][0], 1)
  const svgUrl = qrSvgDataUrl('https://ilinkai.weixin.qq.com/q/test-bot-001')
  assert.ok(svgUrl.startsWith('data:image/svg+xml;base64,'))
  assert.match(Buffer.from(svgUrl.split(',')[1], 'base64').toString('utf8'), /^<svg[\s\S]*<\/svg>$/)

  const parsed = parseWeixinJson('{"message_id":9007199254740993,"msg_id":1234567890123456789,"text":"message_id:99"}')
  assert.equal(parsed.message_id, '9007199254740993')
  assert.equal(parsed.msg_id, '1234567890123456789')
  assert.equal(parsed.text, 'message_id:99')

  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const cipher = encryptAesEcb(Buffer.from('hello ilink'), key)
  assert.equal(decryptAesEcb(cipher, parseWeixinAesKey(key.toString('base64'))).toString(), 'hello ilink')
  assert.equal(decryptAesEcb(cipher, parseWeixinAesKey(Buffer.from(key.toString('hex'), 'utf8').toString('base64'))).toString(), 'hello ilink')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-ilink-qr-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new IlinkStore(dir)
  const calls = []
  let pollStep = 0
  const login = new IlinkLoginManager({
    store,
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.includes('get_bot_qrcode')) {
        return new Response(JSON.stringify({ qrcode: 'qr-abc', qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/abc' }), { status: 200 })
      }
      if (url.includes('get_qrcode_status')) {
        pollStep += 1
        if (pollStep === 1) return new Response(JSON.stringify({ status: 'wait' }), { status: 200 })
        if (pollStep === 2) return new Response(JSON.stringify({ status: 'scaned_but_redirect', redirect_host: 'idc2.ilinkai.weixin.qq.com' }), { status: 200 })
        if (pollStep === 3) return new Response(JSON.stringify({ status: 'need_verifycode' }), { status: 200 })
        assert.match(url, /^https:\/\/idc2\.ilinkai\.weixin\.qq\.com\/.*verify_code=8842/)
        return new Response(JSON.stringify({ status: 'confirmed', bot_token: 'tok-xyz', ilink_bot_id: 'bot01@im.bot', ilink_user_id: 'usr01@im.wechat' }), { status: 200 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    },
  })

  const started = await login.start()
  assert.ok(started.qrImage.startsWith('data:image/svg+xml;base64,'))
  let st = started
  for (let i = 0; i < 20 && !st.needVerifyCode; i += 1) {
    await new Promise((r) => setTimeout(r, 10))
    st = login.status({ sessionKey: started.sessionKey })
  }
  assert.equal(st.needVerifyCode, true)
  login.verify({ sessionKey: started.sessionKey, code: '8842' })
  for (let i = 0; i < 20 && !st.done; i += 1) {
    await new Promise((r) => setTimeout(r, 10))
    st = login.status({ sessionKey: started.sessionKey })
  }
  assert.equal(st.connected, true)
  assert.equal(st.accountId, 'bot01-im-bot')
  assert.equal(store.getAccount('bot01-im-bot').token, 'tok-xyz')
})
