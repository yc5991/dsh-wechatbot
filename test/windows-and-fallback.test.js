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

test('defaults align to wechatbot preset and captureProtected=false, and clipboard parser accepts slash and inline timestamps', () => {
  const defaults = Config({})
  assert.equal(defaults.agentPreset, 'wechatbot')
  assert.equal(defaults.captureProtected, false)

  const parsed = parseClipboardTranscript([
    '张三 2026/11/26 02:30',
    '第一行消息',
    '第二行消息',
    '',
    '李四',
    '2026年11月26日 02:31',
    '[图片]',
  ].join('\n'))
  assert.equal(parsed.parsed, true)
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].sender, '张三')
  assert.equal(parsed.messages[0].content, '第一行消息\n第二行消息')
  assert.equal(parsed.messages[1].sender, '李四')
  assert.equal(parsed.messages[1].hasImage, true)
})

test('macOS sharing=0 and captureProtected bypass all screenshots on read, text send, and image send', async (t) => {
  t.mock.property(process, 'platform', 'darwin')
  const client = new MacOSWeChatClient({
    expectedGroup: '测试群',
    replyDelayMinSeconds: 0,
    replyDelayMaxSeconds: 0,
  })
  const protectedWin = {
    id: 42,
    title: '测试群 (8)',
    x: 10,
    y: 30,
    width: 760,
    height: 580,
    onscreen: true,
    sharing: 0,
  }
  t.mock.method(client, 'listWindows', async () => [protectedWin])
  t.mock.method(client, 'frontWindowTitle', async () => protectedWin.title)
  t.mock.method(client, 'activateApp', async () => {})
  t.mock.method(client, 'ensureDragBinary', async () => {})
  t.mock.method(client, 'clickComposer', async () => {})
  t.mock.method(client, 'pasteIntoComposer', async () => {})
  t.mock.method(client, 'clearComposer', async () => {})
  t.mock.method(client, 'pressReturn', async () => {})
  let clip = ''
  t.mock.method(client, 'setClipboard', async (val) => { clip = val })
  t.mock.method(client, 'readClipboardText', async () => clip)

  // If any screenshot/OCR path were called under sharing=0, fail immediately.
  const forbiddenCapture = t.mock.method(client, 'withChatCapture', async () => {
    throw new Error('withChatCapture should not be called when sharing=0')
  })
  t.mock.method(client, 'ocrImage', async () => {
    throw new Error('ocrImage should not be called when sharing=0')
  })

  t.mock.method(client, 'runHelper', async (_bin, _tag, args) => {
    assert.equal(args.at(-1), 'copy')
    return '王五\n2026年11月26日 03:10\n@豆包 防截屏下也能读到'
  })

  assert.equal(await client.hasCaptureProtectedWindow([{ id: '1', name: '测试群' }]), true)
  assert.equal(await client.captureChatImage(), null)

  const read = await client.readVisible({ mode: 'auto' })
  assert.equal(read.source, 'copy')
  assert.equal(read.group, '测试群')
  assert.equal(read.messages.length, 1)
  assert.equal(read.messages[0].sender, '王五')
  assert.match(read.messages[0].content, /防截屏下也能读到/)

  const sent = await client.send('**收到**，没问题')
  assert.equal(sent.sent, '收到，没问题')
  assert.equal(forbiddenCapture.mock.callCount(), 0)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-protected-img-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const imgFile = join(dir, 'meme.png')
  writeFileSync(imgFile, Buffer.from('89504e470d0a1a0a', 'hex'))
  t.mock.method(client, 'setClipboardImage', async () => {})
  assert.equal(await client.composerSignature(protectedWin), null)
  assert.equal(await client.readComposerText(protectedWin), '')
  const imgSent = await client.sendImage(imgFile)
  assert.equal(imgSent.kind, 'image')
  assert.equal(imgSent.sent, imgFile)
  assert.equal(forbiddenCapture.mock.callCount(), 0)
})

test('Overview panel API toggles captureProtected and blocks /screenshot when enabled', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-panel-protected-'))
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  const cleanup = []
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
    rmSync(home, { recursive: true, force: true })
  })
  t.mock.property(process, 'platform', 'darwin')
  t.mock.method(MacOSWeChatClient.prototype, 'isRunning', async () => true)
  t.mock.method(MacOSWeChatClient.prototype, 'targetReadiness', async () => ({}))
  t.mock.method(MacOSWeChatClient.prototype, 'hasCaptureProtectedWindow', async () => true)

  const config = { agentDir: join(home, 'agent'), targets: [{ name: '测试群', mode: 'group' }] }
  const editor = { entries: () => [{ options: { id: 'dsh-wechatbot' } }], edit: async (_e, fn) => fn(config) }
  let panel
  const ctx = {
    get: (k) => ({ configEditor: editor })[k],
    effect: (fn) => { const end = fn(); if (end) cleanup.push(end) },
    inject: (_k, fn) => fn(ctx),
    tools: { register: () => {} },
    webServer: { register: (route) => { panel = route } },
  }
  apply(ctx, config)

  const callPanel = async (path, body) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      url: panel.path + path,
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
    })
    let status = 200
    let payload
    await panel.handler(req, {
      writeHead(code) { status = code },
      end(data) { payload = JSON.parse(data) },
    })
    return { status, payload }
  }

  try {
    const initial = await callPanel('/status')
    assert.equal(initial.payload.captureProtected, false)
    assert.equal(initial.payload.windowCaptureProtected, true)

    const saved = await callPanel('/settings', { captureProtected: true })
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.settings.captureProtected, true)

    const updated = await callPanel('/status')
    assert.equal(updated.payload.captureProtected, true)

    const shot = await callPanel('/screenshot', { targetId: initial.payload.targets[0].id })
    assert.equal(shot.status, 409)
    assert.match(shot.payload.error, /防截屏模式/)
  } finally {
    for (const finish of cleanup) finish()
  }
})

test('WindowsWeChatClient prefers UIA, falls back to capture-free copy, and aborts send on window switch', async (t) => {
  t.mock.property(process, 'platform', 'win32')
  const client = new WindowsWeChatClient({
    expectedGroup: '开发群',
    captureProtected: true,
    replyDelayMinSeconds: 0,
    replyDelayMaxSeconds: 0,
  })

  const detachedWin = {
    id: 1001,
    title: '开发群 (24)',
    className: 'mmui::ChatSingleWindow',
    x: 0,
    y: 0,
    width: 800,
    height: 640,
    onscreen: true,
    sharing: 1,
    frontmost: true,
  }

  let uiaAvailable = true
  let frontTitle = detachedWin.title
  let clipText = ''
  t.mock.method(client, 'callHelper', async (args, opts) => {
    const cmd = args[0]
    if (cmd === 'windows') return { running: true, windows: [detachedWin] }
    if (cmd === 'display') return { x: 0, y: 0, width: 1920, height: 1080 }
    if (cmd === 'front') return { isWeChat: Boolean(frontTitle), id: detachedWin.id, title: frontTitle }
    if (cmd === 'activate') return { ok: true, frontId: detachedWin.id }
    if (cmd === 'uia-read') {
      return uiaAvailable
        ? {
          available: true,
          title: '开发群',
          items: [
            { text: '甲', x: 0.14, y: 0.25, w: 0.05, h: 0.025 },
            { text: '@豆包 Windows 跑通了吗', x: 0.17, y: 0.28, w: 0.30, h: 0.03 },
          ],
        }
        : { available: false, title: '开发群', items: [] }
    }
    if (cmd === 'drag-copy') {
      return { ok: true, text: '乙\n2026/11/26 03:20\n拖选降级也通了' }
    }
    if (cmd === 'clipboard-set-text') {
      clipText = opts.stdin
      return { ok: true }
    }
    if (cmd === 'clipboard-get') return { text: clipText }
    if (cmd === 'composer-action') return { ok: true }
    throw new Error(`Unexpected helper call: ${cmd}`)
  })

  // 1. UIA path
  const uiaRead = await client.readVisible({ mode: 'auto' })
  assert.equal(uiaRead.source, 'uia')
  assert.equal(uiaRead.group, '开发群')
  assert.equal(uiaRead.messages.length, 1)
  assert.equal(uiaRead.messages[0].sender, '甲')
  assert.equal(uiaRead.messages[0].isAtMe, true)

  // 2. Capture-free drag-copy fallback when UIA tree is slim
  uiaAvailable = false
  const copyRead = await client.readVisible({ mode: 'auto' })
  assert.equal(copyRead.source, 'copy')
  assert.equal(copyRead.messages[0].sender, '乙')
  assert.equal(copyRead.messages[0].content, '拖选降级也通了')

  // 3. Normal send succeeds, then mid-flight window switch aborts
  const okSend = await client.send('已经跑通了')
  assert.equal(okSend.sent, '已经跑通了')

  frontTitle = '别的群'
  await assert.rejects(client.send('这条不该发出去'), /窗口已切换/)
})

test('Windows native C# helper compiles and executes display, fingerprints, grid vision, and WinRT OCR', {
  skip: process.platform !== 'win32',
  timeout: 45_000,
}, async (t) => {
  const client = new WindowsWeChatClient({ expectedGroup: '测试群' })
  const bin = await client.ensureHelperBinary()
  assert.ok(bin.endsWith('.exe'))

  const display = await client.callHelper(['display'])
  assert.ok(display.width > 0 && display.height > 0)

  const procInfo = await client.queryProcessAndWindows()
  assert.equal(typeof procInfo.running, 'boolean')

  // Generate a synthetic PNG with Chinese text and a sticker tile to verify C# Raster + WinRT OCR
  const dir = mkdtempSync(join(tmpdir(), 'dsh-win-native-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ocrPng = join(dir, 'ocr-sample.png')
  const tilePng = join(dir, 'tile.png')

  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap(480, 160)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $font = New-Object System.Drawing.Font('Microsoft YaHei', 22, [System.Drawing.FontStyle]::Regular)
    $g.DrawString('测试群消息识别', $font, [System.Drawing.Brushes]::Black, 24, 50)
    $g.Dispose()
    $bmp.Save('${ocrPng.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    $tile = New-Object System.Drawing.Bitmap(64, 64)
    $gt = [System.Drawing.Graphics]::FromImage($tile)
    $gt.Clear([System.Drawing.Color]::White)
    $gt.FillEllipse([System.Drawing.Brushes]::DodgerBlue, 8, 8, 48, 48)
    $gt.Dispose()
    $tile.Save('${tilePng.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
    $tile.Dispose()
    `,
  ], { windowsHide: true })

  const manifest = join(dir, 'manifest.json')
  writeFileSync(manifest, JSON.stringify({ s1: tilePng }), 'utf8')
  const fp = await client.callHelper(['fingerprints', manifest])
  assert.equal(typeof fp.s1, 'string')
  assert.equal(Buffer.from(fp.s1, 'base64').length, 24 * 24 * 3)

  const ocrLines = await client.ocrImage(ocrPng)
  assert.ok(ocrLines.length >= 1)
  assert.match(ocrLines.map((l) => l.text).join(''), /测试群消息识别/)
})

test('Windows MessageNotifier parses wpndatabase.db Toast XML and filters non-WeChat handlers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-win-notifier-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'wpndatabase.db')

  const nowEpoch = Date.now() / 1000
  const filetime = BigInt(Math.round(nowEpoch * 10_000_000)) + 116444736000000000n

  execFileSync(process.platform === 'win32' ? 'python' : 'python3', [
    '-c',
    `
import sqlite3, sys
db, ft = sys.argv[1], int(sys.argv[2])
con = sqlite3.connect(db)
con.execute("CREATE TABLE NotificationHandler (RecordId INTEGER PRIMARY KEY, PrimaryId TEXT)")
con.execute("CREATE TABLE Notification ([Order] INTEGER PRIMARY KEY, Id INTEGER, HandlerId INTEGER, Type TEXT, Payload BLOB, ArrivalTime INTEGER)")
con.execute("INSERT INTO NotificationHandler VALUES (10, 'Tencent.Weixin.Desktop')")
con.execute("INSERT INTO NotificationHandler VALUES (11, 'Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_com.tencent.xin')")
con.execute("INSERT INTO Notification VALUES (1, 501, 10, 'toast', ?, ?)", (
    '<toast><visual><binding template="ToastGeneric"><text>核心开发群</text><text>[2条] 张三: @豆包 看看这个</text></binding></visual></toast>'.encode('utf-8'),
    ft,
))
con.execute("INSERT INTO Notification VALUES (2, 502, 10, 'toast', ?, ?)", (
    '<toast><visual><binding template="ToastGeneric"><text>核心开发群</text><text>李四在群聊中@了你</text></binding></visual></toast>'.encode('utf-8'),
    ft + 10000000,
))
con.execute("INSERT INTO Notification VALUES (3, 503, 11, 'toast', ?, ?)", (
    '<toast><visual><binding template="ToastGeneric"><text>手机同步群</text><text>王五: 不该被读取</text></binding></visual></toast>'.encode('utf-8'),
    ft + 20000000,
))
con.commit()
con.close()
`,
    dbPath,
    filetime.toString(),
  ], { windowsHide: true })

  const notifier = new MessageNotifier({ dbPath, platform: 'win32' })
  assert.equal(notifier.available, true)
  assert.equal(await notifier.resolveAppId(), 10)

  const snapshot = await notifier.readSnapshot()
  assert.deepEqual(snapshot, [502, 501])

  const messages = await notifier.read({ limit: 10, sinceSeconds: 600 })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].groupName, '核心开发群')
  assert.equal(messages[0].sender, '李四')
  assert.equal(messages[0].isAtMe, true)
  assert.equal(messages[0].needsOcr, true)

  assert.equal(messages[1].groupName, '核心开发群')
  assert.equal(messages[1].sender, '张三')
  assert.equal(messages[1].content, '@豆包 看看这个')
})
