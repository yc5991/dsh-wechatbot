/**
 * Windows WeChat 4.x (`Weixin.exe`) bridge: window discovery, UIA inspection,
 * screen capture, built-in Windows OCR, drag-copy fallback, native favorites,
 * and guarded clipboard send.
 *
 * Zero injection: compiles `lib/win-helper.cs` once with Windows's built-in
 * `.NET Framework 4.x csc.exe` into `%TEMP%`, and invokes Windows Runtime OCR
 * (`Windows.Media.Ocr`) via PowerShell only when pixel OCR is needed.
 */

import { WeChatClient, sanitizeForWeChat } from './wechat-client.js'
import { NativeStickerPicker } from './native-picker.js'
import { chatName } from './targets.js'
import {
  normalizeAntiDetection,
  jitterComposerPoint,
  jitterDragSelection,
  shouldTypeViaKeyboard,
  splitTypingChunks,
  composingDelaySeconds,
  interBubblePauseSeconds,
} from './humanize.js'
import {
  TIMESTAMP_RE,
  normalizeText,
  fingerprint,
  pickGroupName as selectGroupName,
  parseGroupOcrMessages,
  parsePrivateOcrMessages,
  selectionAnchors as computeSelectionAnchors,
  fallbackDragSelections,
  composerLooksWrong as isComposerWrong,
  parseClipboardTranscript,
} from './transcript.js'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const run = (cmd, args, options = {}) => execFileAsync(cmd, args, { timeout: 25_000, windowsHide: true, ...options })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const HELPER_TAG = 'win-helper-v2'
const HELPER_SOURCE_PATH = fileURLToPath(new URL('./win-helper.cs', import.meta.url))

const WINRT_OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ImagePath = $env:DSH_OCR_IMAGE
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod
}
function Await-WinRT($op, [Type]$resultType) {
  $m = $asTaskMethods[0].MakeGenericMethod($resultType)
  $task = $m.Invoke($null, @($op))
  return $task.GetAwaiter().GetResult()
}

$file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $w = [double][Math]::Max(1, $bitmap.PixelWidth)
  $h = [double][Math]::Max(1, $bitmap.PixelHeight)

  $engine = $null
  foreach ($tag in @('zh-Hans-CN', 'zh-CN', 'en-US')) {
    $lang = New-Object Windows.Globalization.Language($tag)
    if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      if ($engine) { break }
    }
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { Write-Output '[]'; exit 0 }

  $ocr = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($line in $ocr.Lines) {
    if (-not $line.Words -or $line.Words.Count -eq 0) { continue }
    $minX = [double]::PositiveInfinity
    $minY = [double]::PositiveInfinity
    $maxX = 0.0
    $maxY = 0.0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    $out.Add(@{
      text = [string]$line.Text
      x = [Math]::Round($minX / $w, 5)
      y = [Math]::Round($minY / $h, 5)
      w = [Math]::Round(($maxX - $minX) / $w, 5)
      h = [Math]::Round(($maxY - $minY) / $h, 5)
    })
  }
  $sorted = @($out | Sort-Object @{ Expression = { [Math]::Round($_.y / 0.018) } }, @{ Expression = { $_.x } })
  if ($sorted.Count -eq 0) { Write-Output '[]' }
  else { ConvertTo-Json -InputObject $sorted -Compress }
} finally {
  if ($stream) { $stream.Dispose() }
}
`

function resolveCscPath() {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((p) => existsSync(p)) || 'csc.exe'
}

function wpfAssembly(name) {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const full = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF', name)
  return existsSync(full) ? full : name
}

export class WindowsWeChatClient extends WeChatClient {
  static get platform() {
    return 'windows'
  }

  get appName() {
    return this._appName
  }

  get state() {
    return 'ready'
  }

  constructor(config = {}) {
    super(config)
    this._appName = config.appName || 'Weixin'
    this.processSpec = 'Weixin'
    this.whitelistGroups = config.whitelistGroups || []
    this.expectedGroup = config.expectedGroup || ''
    this.privateChat = config.privateChat === true
    this.captureProtected = config.captureProtected === true
    const manual = config.dragPoints
    this.dragPoints = manual && [manual.x1, manual.y1, manual.x2, manual.y2].every((v) => Number.isFinite(Number(v)))
      && ![manual.x1, manual.y1, manual.x2, manual.y2].every((v) => Number(v) === 0)
      ? { x1: Math.round(Number(manual.x1)), y1: Math.round(Number(manual.y1)), x2: Math.round(Number(manual.x2)), y2: Math.round(Number(manual.y2)) }
      : null
    this.atKeywords = config.atKeywords || ['@豆包', '豆包']
    this.botNickname = config.botNickname || '豆包'
    this.antiDetection = normalizeAntiDetection(config.antiDetection)
    this.delayMin = Number(config.replyDelayMinSeconds ?? 0.8)
    this.delayMax = Number(config.replyDelayMaxSeconds ?? 2.4)
    this.helperBinPath = join(tmpdir(), `dsh-wechatbot-${HELPER_TAG}.exe`)
    this.lastOcrError = ''
  }

  assertSupported() {
    if (process.platform !== 'win32') {
      throw new Error(`WindowsWeChatClient only runs on Windows (current platform: ${process.platform}).`)
    }
  }

  isCaptureProtected(win = null) {
    return Boolean(this.captureProtected || (win && win.sharing === 0))
  }

  async hasCaptureProtectedWindow(targets = []) {
    const windows = await this.listWindows()
    const relevant = targets.length
      ? windows.filter((win) => targets.some(({ name }) => chatName(win.title) === chatName(name))
        || /^(微信|Weixin|WeChat)$/i.test(String(win.title || '').trim()))
      : windows
    return relevant.some((win) => win.sharing === 0)
  }

  async ensureHelperBinary() {
    if (existsSync(this.helperBinPath)) return this.helperBinPath
    this.compiling ??= (async () => {
      const csc = resolveCscPath()
      const tempOut = `${this.helperBinPath}.${process.pid}.exe`
      try {
        await run(csc, [
          '/nologo',
          '/optimize+',
          '/target:exe',
          `/out:${tempOut}`,
          '/r:System.Drawing.dll',
          '/r:System.Windows.Forms.dll',
          '/r:System.Web.Extensions.dll',
          `/r:${wpfAssembly('UIAutomationClient.dll')}`,
          `/r:${wpfAssembly('UIAutomationTypes.dll')}`,
          `/r:${wpfAssembly('WindowsBase.dll')}`,
          HELPER_SOURCE_PATH,
        ], { timeout: 60_000 })
        try {
          renameSync(tempOut, this.helperBinPath)
        } catch {
          if (!existsSync(this.helperBinPath)) throw new Error('无法写入 Windows 辅助程序')
        }
        return this.helperBinPath
      } finally {
        rmSync(tempOut, { force: true })
      }
    })().catch((error) => {
      this.compiling = null
      throw new Error(`无法编译 Windows 微信辅助组件：${error.message}`)
    })
    return this.compiling
  }

  async callHelper(args, { stdin } = {}) {
    this.assertSupported()
    const bin = await this.ensureHelperBinary()
    if (stdin !== undefined) {
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(bin, args.map(String), { windowsHide: true })
        const chunks = []
        const errChunks = []
        child.stdout.on('data', (d) => chunks.push(d))
        child.stderr.on('data', (d) => errChunks.push(d))
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
          else reject(new Error(Buffer.concat(errChunks).toString('utf8').trim() || `win-helper exited ${code}`))
        })
        child.stdin.end(String(stdin), 'utf8')
      })
      return JSON.parse(stdout.trim() || '{}')
    }
    const { stdout } = await run(bin, args.map(String))
    return JSON.parse(String(stdout).trim() || '{}')
  }

  // ------------------------------------------------------------------ window

  async queryProcessAndWindows() {
    const data = await this.callHelper(['windows', this.processSpec])
    const windows = (data.windows || []).map((win) => ({
      id: Number(win.id) || null,
      title: String(win.title || ''),
      className: String(win.className || ''),
      x: Math.round(Number(win.x) || 0),
      y: Math.round(Number(win.y) || 0),
      width: Math.round(Number(win.width) || 0),
      height: Math.round(Number(win.height) || 0),
      onscreen: win.onscreen === true,
      sharing: Number(win.sharing ?? 1),
      frontmost: win.frontmost === true,
    }))
    return { running: data.running === true, windows }
  }

  async isRunning() {
    try {
      const { running } = await this.queryProcessAndWindows()
      return running
    } catch {
      return null
    }
  }

  async listWindows() {
    const { windows } = await this.queryProcessAndWindows()
    return windows.filter((win) => win.onscreen && win.width >= 320 && win.height >= 240)
  }

  layoutOf(target) {
    const title = String(target?.title ?? '').trim()
    const cls = String(target?.className ?? '')
    const isMainTitle = /^(微信|Weixin|WeChat)$/i.test(title)
    const detached = cls.includes('ChatSingleWindow') || (title.length > 0 && !isMainTitle)
    const sidebarW = detached ? 0 : Math.round(target.width * 0.28)
    return {
      detached,
      sidebarW,
      x: target.x + sidebarW,
      y: target.y,
      w: target.width - sidebarW,
      h: target.height,
    }
  }

  async mainWindow() {
    const windows = await this.listWindows()
    return windows.find((win) => !this.layoutOf(win).detached && /^(微信|Weixin|WeChat)$/i.test(win.title.trim())) ?? null
  }

  matchingWindows(windows, name) {
    return windows.filter((window) => this.layoutOf(window).detached
      && chatName(window.title) === chatName(name))
  }

  async displayBounds() {
    try {
      const d = await this.callHelper(['display'])
      if ([d.x, d.y, d.width, d.height].every(Number.isFinite)) return d
    } catch { /* fall through */ }
    return null
  }

  atLeft(window, display) {
    return Boolean(window?.onscreen && display
      && Math.abs(window.x - display.x) <= 32
      && window.x + window.width / 2 <= display.x + display.width / 2 + 16)
  }

  async targetReadiness(targets) {
    const windows = await this.listWindows()
    const display = await this.displayBounds()
    return Object.fromEntries(targets.map(({ id, name }) => {
      const matched = this.matchingWindows(windows, name)
      return [id, matched.length === 1 && this.atLeft(matched[0], display)]
    }))
  }

  async getChatWindow({ detachedOnly = false } = {}) {
    const windows = await this.listWindows()
    if (this.expectedGroup) {
      const matches = this.matchingWindows(windows, this.expectedGroup)
      if (matches.length === 1) return { ...matches[0], matchedByTitle: true }
      if (matches.length > 1 || detachedOnly) return null
    }
    return windows.find((window) => !this.layoutOf(window).detached && /^(微信|Weixin|WeChat)$/i.test(window.title.trim())) ?? null
  }

  async frontWindowTitle({ requireFrontmost = false } = {}) {
    try {
      const front = await this.callHelper(['front', this.processSpec])
      if (requireFrontmost && !front.isWeChat) return ''
      if (front.isWeChat) return String(front.title || '').trim()
      if (requireFrontmost) return ''
      const windows = await this.listWindows()
      return windows[0]?.title?.trim() || ''
    } catch {
      return ''
    }
  }

  async activateApp(target = null) {
    target ??= await this.getChatWindow()
    if (!target?.id) return
    if (this.antiDetection.minimalTouch && target.frontmost) return
    await this.callHelper(['activate', target.id])
    await sleep(140 + Math.round(Math.random() * 80))
  }

  async moveWindow(titleOrWindow, { x, y, width, height }) {
    const windows = await this.listWindows()
    const target = typeof titleOrWindow === 'object' && titleOrWindow?.id
      ? titleOrWindow
      : windows.find((w) => normalizeText(w.title).includes(normalizeText(titleOrWindow)))
    if (!target?.id) return null
    const nextW = Number.isFinite(width) ? Math.round(width) : target.width
    const nextH = Number.isFinite(height) ? Math.round(height) : target.height
    const nextX = Number.isFinite(x) ? Math.round(x) : target.x
    const nextY = Number.isFinite(y) ? Math.round(y) : target.y
    await this.callHelper(['move', target.id, nextX, nextY, nextW, nextH])
    return (await this.listWindows()).find((w) => w.id === target.id) ?? null
  }

  async tileWindow(title, placement = 'left') {
    const display = await this.displayBounds()
    if (!display) return null
    const windows = await this.listWindows()
    const target = windows.find((w) => w.title.trim() === String(title || '').trim())
      ?? windows.find((w) => normalizeText(w.title).includes(normalizeText(title)))
    if (!target) return null
    await this.activateApp(target)

    const halfW = Math.floor(display.width / 2)
    const halfH = Math.floor(display.height / 2)
    const frames = {
      left: { x: display.x, y: display.y, width: halfW, height: display.height },
      right: { x: display.x + halfW, y: display.y, width: halfW, height: display.height },
      top: { x: display.x, y: display.y, width: display.width, height: halfH },
      bottom: { x: display.x, y: display.y + halfH, width: display.width, height: halfH },
      half: { x: display.x, y: display.y, width: halfW, height: display.height },
      'quarter-tl': { x: display.x, y: display.y, width: halfW, height: halfH },
      'quarter-tr': { x: display.x + halfW, y: display.y, width: halfW, height: halfH },
      'quarter-bl': { x: display.x, y: display.y + halfH, width: halfW, height: halfH },
      'quarter-br': { x: display.x + halfW, y: display.y + halfH, width: halfW, height: halfH },
    }
    return this.moveWindow(target, frames[placement] || frames.left)
  }

  async closeChatWindow(name) {
    const matches = this.matchingWindows(await this.listWindows(), name)
    if (!matches.length) return false
    const res = await this.callHelper(['close', matches[0].id])
    return res.ok === true
  }

  async findSidebarRow(name, win) {
    const target = win ?? (await this.mainWindow())
    if (!target || this.isCaptureProtected(target)) return null
    const sidebarW = Math.round(target.width * 0.28)
    const h = Math.round(target.height * 0.9)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-win-sidebar-'))
    const imgPath = join(dir, 'sidebar.png')
    try {
      await this.callHelper(['capture', target.id, imgPath, 0, 0, sidebarW, h, 0])
      const items = await this.ocrImage(imgPath)
      const wanted = normalizeText(name)
      let best = null
      for (const item of items) {
        const text = normalizeText(item.text)
        if (!text || Number(item.x ?? 0) > 0.75) continue
        const hit = text === wanted || (text.length >= 6 && wanted.startsWith(text))
        if (!hit) continue
        const score = Math.abs(text.length - wanted.length)
        if (!best || score < best.score) best = { item, score }
      }
      if (!best) return null
      const rowY = Number(best.item.y ?? 0)
      return {
        name: String(best.item.text || '').trim(),
        x: target.x + Math.round(sidebarW * 0.42),
        y: target.y + Math.round(h * rowY) + Math.round(h * 0.012),
        window: target,
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async openChatWindow(name) {
    const matches = this.matchingWindows(await this.listWindows(), name)
    if (matches.length > 1) return { ok: false, reason: '有多个同名的独立聊天窗口' }
    const [existing] = matches
    if (existing) {
      await this.activateApp(existing)
      return { ok: true, title: existing.title, window: existing, alreadyOpen: true }
    }

    const main = await this.mainWindow()
    if (!main?.id) return { ok: false, reason: '没有找到微信主窗口，请先打开微信（Weixin.exe）主窗口。' }

    // 1. Try UIA double-click on sidebar row (works even when screen capture is blocked).
    try {
      const uia = await this.callHelper(['uia-open', main.id, name])
      if (uia.ok) {
        await sleep(600)
        const [openedByUia] = this.matchingWindows(await this.listWindows(), name)
        if (openedByUia) {
          const tiled = await this.tileWindow(openedByUia.title, 'left')
          return { ok: true, title: (tiled ?? openedByUia).title, window: tiled ?? openedByUia }
        }
      }
    } catch { /* fall back to OCR drag/double-click when allowed */ }

    if (this.isCaptureProtected(main)) {
      return { ok: false, reason: `防截屏模式下无法截图识别侧边栏，请先在微信中双击打开「${name}」独立窗口，再点「准备窗口」。` }
    }

    await this.activateApp(main)
    const row = await this.findSidebarRow(name, main)
    if (!row) return { ok: false, reason: `侧边栏没找到「${name}」，可在微信中双击该聊天打开独立窗口后重试` }

    // Double-clicking a sidebar row in Windows WeChat 4.x pops out a detached ChatSingleWindow.
    await this.callHelper([
      'composer-action', main.id, main.title, main.x, main.y, main.width, main.height,
      'click', row.x, row.y,
    ])
    await sleep(60)
    await this.callHelper([
      'composer-action', main.id, main.title, main.x, main.y, main.width, main.height,
      'click', row.x, row.y,
    ])
    await sleep(650)

    let [opened] = this.matchingWindows(await this.listWindows(), name)
    if (!opened) {
      const display = await this.displayBounds()
      const dropX = (display ? display.x : 0) + 24
      const dropY = display ? display.y + Math.round(display.height * 0.45) : 400
      await this.callHelper([
        'drag-copy', main.id, main.title, main.x, main.y, main.width, main.height,
        row.x, row.y, dropX, dropY, 'drag',
      ]).catch(() => {})
      await sleep(650)
      ;[opened] = this.matchingWindows(await this.listWindows(), name)
    }
    if (!opened) return { ok: false, reason: `未能弹出「${name}」独立窗口，请在微信中双击该聊天打开独立窗口` }

    const tiled = await this.tileWindow(opened.title, 'left')
    return { ok: true, title: (tiled ?? opened).title, window: tiled ?? opened }
  }

  async prepareWindow() {
    const opened = await this.openChatWindow(this.expectedGroup)
    if (!opened.ok) return opened
    const display = await this.displayBounds()
    let window = await this.getChatWindow({ detachedOnly: true })
    if (window && !this.atLeft(window, display)) {
      await this.tileWindow(window.title, 'left')
      window = await this.getChatWindow({ detachedOnly: true })
    }
    return this.atLeft(window, display)
      ? { ok: true, id: window.id }
      : { ok: false, reason: '独立窗口已打开，尚未定位到屏幕左侧' }
  }

  async ensureTargetWindow({ allowOpen = true, requireDetached = false } = {}) {
    const target = String(this.expectedGroup || '').trim()
    if (!target) return { ok: false, reason: 'No target chat configured.' }

    if (requireDetached) {
      const window = await this.getChatWindow({ detachedOnly: true })
      if (window?.onscreen) return { ok: true, windowId: window.id }
      return allowOpen ? this.openChatWindow(target) : { ok: false, reason: '请先打开目标独立窗口' }
    }

    const check = await this.verifyTargetGroup()
    if (check.ok && check.windowId) {
      const windows = await this.listWindows()
      const win = windows.find((candidate) => candidate.id === check.windowId)
      if (win) {
        if (win.frontmost) return { ok: true, alreadyFront: true, windowId: win.id }
        await this.activateApp(win)
        return { ok: true, raised: true, windowId: win.id }
      }
    }
    if (!allowOpen) return check
    const opened = await this.openChatWindow(target)
    if (!opened.ok) return { ok: false, reason: opened.reason || '无法打开目标聊天独立窗口' }
    if (opened.window) await this.activateApp(opened.window)
    return { ok: true, opened: !opened.alreadyOpen, windowId: opened.window?.id }
  }

  async assertFrontChat(window) {
    const current = await this.getChatWindow({ detachedOnly: true })
    const front = await this.frontWindowTitle({ requireFrontmost: true })
    if (!current?.onscreen || current.id !== window.id || !front
      || chatName(front) !== chatName(this.expectedGroup) || chatName(current.title) !== chatName(front)) {
      throw new Error('微信窗口已切换，发送已取消')
    }
  }

  async prepareSend({ requireFront = false } = {}) {
    let target = await this.getChatWindow({ detachedOnly: true })
    if (!target && !requireFront) {
      const opened = await this.openChatWindow(this.expectedGroup)
      if (!opened.ok) throw new Error(opened.reason || '无法打开目标独立窗口')
      target = await this.getChatWindow({ detachedOnly: true })
    }
    if (!target?.id) throw new Error('未找到唯一的目标独立窗口')
    if (!requireFront) await this.activateApp(target)
    await this.assertFrontChat(target)
    return target
  }

  // ----------------------------------------------------------- capture & OCR

  async ocrImage(imgPath) {
    try {
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', WINRT_OCR_SCRIPT,
      ], {
        timeout: 25_000,
        env: { ...process.env, DSH_OCR_IMAGE: imgPath },
      })
      this.lastOcrError = ''
      const parsed = JSON.parse(String(stdout || '').trim() || '[]')
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      return rows.map((row) => ({
        ...row,
        text: String(row.text ?? '')
          .replace(/(?<=[\p{Script=Han}\u3000-\u303f\uff00-\uffef])\s+(?=[\p{Script=Han}\u3000-\u303f\uff00-\uffef])/gu, '')
          .trim(),
      }))
    } catch (error) {
      this.lastOcrError = `Windows OCR failed: ${error.message}`
      return []
    }
  }

  async screenshotStart(target, path, message) {
    const content = normalizeText(message.content)
    if (message.needsOcr || !content) return null
    const items = await this.ocrImage(path)
    const group = selectGroupName(target.title, items, { expectedGroup: this.expectedGroup, whitelistGroups: this.whitelistGroups })
    const messageGroup = String(message.groupName ?? '').replace(/\s*[（(]\d+[）)]\s*$/, '')
    if (!group || normalizeText(group) !== normalizeText(messageGroup)) return null
    const matches = items.filter((item) => item.y >= 0.12 && item.y + item.h < 1
      && item.x < 0.35 && item.h >= 0.013 && !TIMESTAMP_RE.test(item.text)
      && normalizeText(item.text) === content)
    return matches.length === 1 ? matches[0].y : null
  }

  async withChatCapture(target, maxWidth, read, fromMessage = null) {
    const layout = this.layoutOf(target)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-win-vision-'))
    const cropped = join(dir, 'chat.png')
    const scoped = join(dir, 'scoped.png')
    try {
      const chatWidth = Math.max(1, target.width - layout.sidebarW)
      const chatHeight = Math.max(1, Math.round(target.height * 0.86))
      const cap = await this.callHelper([
        'capture', target.id, cropped,
        layout.sidebarW, 0, chatWidth, chatHeight,
        fromMessage ? 0 : (Number.isFinite(maxWidth) ? maxWidth : 0),
      ])
      if (!cap.ok) throw new Error('无法截取微信窗口画面')
      let source = cropped
      if (fromMessage) {
        const beginning = await this.screenshotStart(target, cropped, fromMessage)
        if (beginning === null) return null
        const top = Math.floor(cap.height * beginning)
        const scopedHeight = cap.height - top - 1
        if (scopedHeight <= 10) return null
        await this.callHelper([
          'capture', target.id, scoped,
          layout.sidebarW, top, chatWidth, scopedHeight,
          Number.isFinite(maxWidth) ? maxWidth : 0,
        ])
        source = scoped
      }
      return await read(source)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async captureChatRegion(win) {
    const layout = this.layoutOf(win)
    const region = { x: layout.x, y: layout.y, w: layout.w, h: Math.round(win.height * 0.86) }
    const items = await this.withChatCapture(win, Infinity, (path) => this.ocrImage(path))
    if (this.lastOcrError) throw new Error(this.lastOcrError)
    return { title: win.title, items, region }
  }

  async captureChatImage({ maxWidth = 1000, fromMessage = null } = {}) {
    const target = await this.getChatWindow({ detachedOnly: Boolean(this.expectedGroup) })
    if (!target?.id || this.isCaptureProtected(target)) return null
    return this.withChatCapture(target, maxWidth, (path) => ({
      mediaType: 'image/png',
      data: readFileSync(path).toString('base64'),
      name: 'wechat-chat.png',
    }), fromMessage)
  }

  // ----------------------------------------------------------------- reading

  async readByUia(win) {
    const detached = this.layoutOf(win).detached
    const res = await this.callHelper(['uia-read', win.id, detached ? '1' : '0'])
    if (!res.available || !Array.isArray(res.items) || !res.items.length) return null
    const group = detached ? chatName(win.title) : chatName(res.title || win.title)
    if (this.privateChat) {
      const messages = parsePrivateOcrMessages(group, res.items)
      return messages.length ? { source: 'uia', group, messages } : null
    }
    const parsed = parseGroupOcrMessages(group, res.items, {
      expectedGroup: this.expectedGroup,
      whitelistGroups: this.whitelistGroups,
      atKeywords: this.atKeywords,
    })
    return parsed.messages.length ? { source: 'uia', group: parsed.group || group, messages: parsed.messages } : null
  }

  async copyVisibleTranscript(target, capture, group) {
    const { region } = capture
    const detached = this.layoutOf(target).detached
    const insideChat = (x, y) => x > region.x && x < region.x + region.w
      && y >= region.y + Math.max(42, Math.round(region.h * 0.10)) && y < region.y + region.h - 2

    let selections
    let boundaryLines = []
    if (this.dragPoints) {
      const { x1, y1, x2, y2 } = this.dragPoints
      if (!insideChat(x1, y1) || !insideChat(x2, y2) || Math.hypot(x2 - x1, y2 - y1) < 20) {
        throw new Error('手动拖选坐标不在当前聊天消息区，请重新设置坐标')
      }
      selections = [this.dragPoints]
    } else if (capture.captureProtected) {
      if (!detached) throw new Error('防截屏模式下请先将目标聊天打开为独立窗口')
      const base = fallbackDragSelections(region)
      selections = this.antiDetection.curvedMouse ? base.map((sel) => jitterDragSelection(sel, region)) : base
    } else {
      const anchors = computeSelectionAnchors(region, capture.items)
      const first = anchors[0]
      const last = anchors.at(-1)
      if (!first || !last) throw new Error('没有找到可拖选的文字气泡')
      boundaryLines = first === last ? [first.text] : [first.text, last.text]
      selections = [
        { x1: first.left - 4, y1: first.middle, x2: last.right + 4, y2: last.middle },
        { x1: first.left, y1: first.middle, x2: last.right, y2: last.bottom + 3 },
      ].filter(({ x1, y1, x2, y2 }) => insideChat(x1, y1) && insideChat(x2, y2)
        && Math.hypot(x2 - x1, y2 - y1) >= 20)
    }
    if (!selections.length) throw new Error('没有找到可拖选的文字气泡')

    await this.activateApp(target)
    let reason = '剪贴板没有收到新的文字'
    for (const { x1, y1, x2, y2 } of selections) {
      const dragRes = await this.callHelper([
        'drag-copy', target.id, target.title, target.x, target.y, target.width, target.height,
        x1, y1, x2, y2, 'copy',
      ])
      if (!dragRes.ok) throw new Error(dragRes.error || '微信聊天窗口未置于前面，已取消拖选')
      const raw = String(dragRes.text || '')
      const parsed = parseClipboardTranscript(raw)
      if (parsed.parsed) {
        if (!boundaryLines.length) return parsed.messages
        const content = parsed.messages.flatMap((message) => [message.content, ...message.content.split('\n')])
          .map(normalizeText)
        if (boundaryLines.every((line) => content.some((body) => body === line
          || (line.length >= 4 && body.includes(line))))) return parsed.messages
        reason = '复制结果缺少可见消息的开头或末尾'
      } else if (raw.trim()) {
        reason = '复制内容没有可识别的微信聊天记录格式'
      }
    }
    throw new Error(reason)
  }

  async readByCopy() {
    return this.readVisible({ mode: 'copy' })
  }

  async readVisible({ mode = 'auto' } = {}) {
    const win = await this.getChatWindow({ detachedOnly: Boolean(this.expectedGroup) })
    if (!win?.id) return { source: 'unavailable', group: '', messages: [], copyIssue: '未找到微信聊天窗口' }

    if (mode === 'auto' || mode === 'uia') {
      try {
        const uia = await this.readByUia(win)
        if (uia) return uia
      } catch { /* fall through to copy / OCR */ }
      if (mode === 'uia') {
        return {
          source: 'unavailable',
          group: chatName(win.title) || this.expectedGroup,
          messages: [],
          copyIssue: '当前微信窗口未暴露 UIA 消息节点',
        }
      }
    }

    const protectedWindow = this.isCaptureProtected(win)
    const layout = this.layoutOf(win)
    const fallbackRegion = { x: layout.x, y: layout.y, w: layout.w, h: Math.round(win.height * 0.86) }

    if (!this.privateChat && mode !== 'ocr' && (this.dragPoints || protectedWindow)) {
      const group = layout.detached ? chatName(win.title) : this.expectedGroup
      const targets = [this.expectedGroup, ...this.whitelistGroups].filter(Boolean)
      let copyIssue
      if (protectedWindow && !layout.detached) {
        copyIssue = '防截屏模式下请将目标聊天打开为独立窗口'
      } else if (targets.length && !targets.some((target) => normalizeText(target) === normalizeText(group))) {
        copyIssue = '当前微信窗口不是已配置的聊天'
      } else {
        try {
          const messages = await this.copyVisibleTranscript(
            win,
            { title: win.title, items: [], region: fallbackRegion, captureProtected: protectedWindow },
            group,
          )
          return { source: 'copy', group, messages: messages.map((message) => ({ ...message, groupName: group })) }
        } catch (error) {
          copyIssue = error.message
        }
      }
      if (mode === 'copy' || protectedWindow) {
        return { source: protectedWindow ? 'unavailable' : 'copy', group, messages: [], copyIssue }
      }
    }

    if (protectedWindow) {
      const group = layout.detached ? chatName(win.title) : this.expectedGroup
      return {
        source: 'unavailable',
        group,
        messages: [],
        copyIssue: this.privateChat
          ? '防截屏模式下私聊不支持截图 OCR，仅通过系统通知或 UIA 接收新消息'
          : '防截屏模式下已跳过截图 OCR，请开启拖选复制并使用独立聊天窗口',
      }
    }

    const capture = await this.captureChatRegion(win)
    const parsed = parseGroupOcrMessages(capture.title, capture.items, {
      expectedGroup: this.expectedGroup,
      whitelistGroups: this.whitelistGroups,
      atKeywords: this.atKeywords,
    })
    const group = parsed.group || chatName(capture.title)
    let copyIssue

    if (mode !== 'ocr' && !this.privateChat) {
      const targets = [this.expectedGroup, ...this.whitelistGroups].filter(Boolean)
      if (targets.length && !targets.some((target) => normalizeText(target) === normalizeText(group))) {
        copyIssue = '当前微信窗口不是已配置的聊天'
      } else {
        try {
          const messages = await this.copyVisibleTranscript(win, capture, group)
          return { source: 'copy', group, messages: messages.map((message) => ({ ...message, groupName: group })) }
        } catch (error) {
          copyIssue = error.message
        }
      }
    }
    if (mode === 'copy') {
      return { source: 'copy', group, messages: [], copyIssue: copyIssue || '私聊使用 OCR 读取文字' }
    }

    if (this.privateChat || !parsed.hasSender) {
      const messages = parsePrivateOcrMessages(group, capture.items)
      if (this.privateChat || messages.length) return { source: 'private-ocr', group, messages, copyIssue }
    }
    return { source: 'ocr', group, messages: parsed.messages, copyIssue }
  }

  async readGroupTitleOf(win) {
    const target = win ?? (await this.getChatWindow())
    if (!target) return { title: '', items: [] }
    if (this.layoutOf(target).detached) return { title: chatName(target.title), items: [] }
    if (this.isCaptureProtected(target)) return { title: '', items: [] }
    const items = await this.withChatCapture(target, Infinity, (path) => this.ocrImage(path))
    const left = items.filter((item) => Number(item.y ?? 1) < 0.14
      && Number(item.x ?? 1) < 0.55 && /[\p{L}\p{N}]/u.test(String(item.text || '')))
    const expected = normalizeText(this.expectedGroup)
    const matching = left.find((item) => expected && normalizeText(item.text).includes(expected))
    const title = String((matching ?? left.sort((a, b) => Number(a.y) - Number(b.y))[0])?.text ?? '').trim()
    return { title, items }
  }

  async readGroupTitle() {
    const win = await this.getChatWindow()
    if (!win) return ''
    const { title } = await this.readGroupTitleOf(win)
    return title
  }

  async listGroups(win) {
    const target = win ?? (await this.mainWindow()) ?? (await this.getChatWindow())
    if (!target) return []
    try {
      const uia = await this.callHelper(['uia-groups', target.id])
      if (uia.available && Array.isArray(uia.groups) && uia.groups.length) {
        return uia.groups.map((raw) => chatName(raw)).filter(Boolean)
      }
    } catch { /* fall back to sidebar OCR */ }

    if (this.isCaptureProtected(target)) return []
    const sidebarW = Math.round(target.width * 0.28)
    const h = Math.round(target.height * 0.9)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-win-groups-'))
    const imgPath = join(dir, 'sidebar.png')
    try {
      await this.callHelper(['capture', target.id, imgPath, 0, 0, sidebarW, h, 0])
      const items = await this.ocrImage(imgPath)
      const rows = items
        .map((i) => ({ text: String(i.text || '').trim(), y: Number(i.y ?? 0), x: Number(i.x ?? 0) }))
        .filter((i) => i.text && i.x < 0.75)
        .sort((a, b) => a.y - b.y)
      const names = []
      for (let i = 0; i < rows.length; i += 1) {
        const raw = rows[i].text
        if (/^(搜索|通讯录|聊天|收藏)$/.test(raw)) continue
        if (/^[^:：]{1,20}[:：]/.test(raw) || /^［.*］$/.test(raw) || /^\[.*\]$/.test(raw)) continue
        const prev = rows[i - 1]
        if (prev && rows[i].y - prev.y < 0.02) continue
        const next = rows[i + 1]
        if (!next || next.y - rows[i].y >= 0.05) continue
        const name = chatName(raw).replace(/\s*(昨天|前天)?\s*\d{1,2}:\d{2}\s*$/, '').trim()
        if (name.length >= 2 && name.length <= 40 && !/^[\d\s:：/.-]+$/.test(name) && !names.includes(name)) {
          names.push(name)
        }
      }
      return names
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async findWindow() {
    return (await this.getChatWindow()) ?? null
  }

  async verifyTarget() {
    return this.verifyTargetGroup()
  }

  async verifyTargetGroup() {
    if (!this.expectedGroup) return { ok: false, reason: 'No target chat configured.' }
    const win = await this.getChatWindow()
    if (!win) return { ok: false, reason: 'No WeChat chat window found.' }
    const nativeTitle = chatName(win.title)
    if (win.id && this.layoutOf(win).detached && nativeTitle === chatName(this.expectedGroup)) {
      return { ok: true, detected: nativeTitle, windowId: win.id }
    }
    if (this.isCaptureProtected(win)) {
      return { ok: false, reason: '防截屏模式下无法截图核对主窗口标题，请将目标聊天打开为独立窗口。' }
    }
    const { title } = await this.readGroupTitleOf(win)
    if (!title) return { ok: false, reason: 'Could not read the chat title.' }
    const got = normalizeText(title)
    const want = normalizeText(this.expectedGroup)
    if (want && got.includes(want)) return { ok: true, detected: title, windowId: win.id }
    const shorter = got.length < want.length ? got : want
    const longer = got.length < want.length ? want : got
    if (shorter.length >= 6 && longer.startsWith(shorter)) {
      return { ok: true, detected: title, truncated: true, windowId: win.id }
    }
    return { ok: false, reason: `Front chat is "${title}", expected "${this.expectedGroup}".` }
  }

  // ------------------------------------------------------------------ sending

  async setClipboard(text) {
    const res = await this.callHelper(['clipboard-set-text'], { stdin: text })
    if (!res.ok) throw new Error('无法写入 Windows 剪贴板')
  }

  async readClipboardText() {
    const res = await this.callHelper(['clipboard-get'])
    return String(res.text ?? '')
  }

  async composerAction(target, action, extra = []) {
    const res = await this.callHelper([
      'composer-action', target.id, target.title, target.x, target.y, target.width, target.height,
      action, ...extra,
    ])
    if (!res.ok) throw new Error(res.error || '微信窗口状态已变化，发送已取消')
  }

  async clickComposer(target) {
    const layout = this.layoutOf(target)
    const { x, y } = this.antiDetection.curvedMouse
      ? jitterComposerPoint(layout, target.height, target.y)
      : { x: layout.x + Math.round(layout.w * 0.5), y: target.y + Math.round(target.height * 0.91) }
    await this.composerAction(target, 'click', [x, y])
  }

  async typeIntoComposer(text, target) {
    const chunks = splitTypingChunks(text)
    const res = await this.callHelper([
      'type-chunks', target.id, target.title, target.x, target.y, target.width, target.height,
    ], { stdin: JSON.stringify(chunks) })
    if (!res.ok) throw new Error(res.error || '微信窗口状态已变化，发送已取消')
  }

  nextBubblePause(previousText, nextText = '') {
    const mode = this.antiDetection.phraseTyping ? 'human' : 'paste'
    return interBubblePauseSeconds(previousText, nextText, {
      typed: shouldTypeViaKeyboard(nextText, mode),
    })
  }

  async pasteIntoComposer(target) {
    await this.composerAction(target, 'paste')
  }

  async clearComposer(target) {
    await this.composerAction(target, 'clear').catch(() => {})
  }

  async pressReturn(target) {
    await this.composerAction(target, 'enter')
  }

  async readComposerText(target = null) {
    target ??= await this.getChatWindow()
    if (!target || this.isCaptureProtected(target)) return ''
    const layout = this.layoutOf(target)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-win-composer-'))
    const imgPath = join(dir, 'composer.png')
    try {
      const rx = layout.sidebarW + 8
      const ry = Math.round(target.height * 0.865)
      const rw = Math.max(120, layout.w - 16)
      const rh = Math.max(40, Math.round(target.height * 0.11))
      await this.callHelper(['capture', target.id, imgPath, rx, ry, rw, rh, 0])
      const items = await this.ocrImage(imgPath)
      return items.map((item) => String(item.text || '')).join('\n').trim()
    } catch {
      return ''
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async composerSignature(target = null) {
    target ??= await this.getChatWindow()
    if (!target || this.isCaptureProtected(target)) return null
    const layout = this.layoutOf(target)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-win-sig-'))
    const imgPath = join(dir, 'sig.png')
    try {
      const rx = layout.sidebarW + 10
      const ry = Math.round(target.height * 0.865)
      const rw = Math.max(80, layout.w - 20)
      const rh = Math.max(32, Math.round(target.height * 0.07))
      const cap = await this.callHelper(['capture', target.id, imgPath, rx, ry, rw, rh, 160])
      if (!cap.ok || cap.blank) return null
      return statSync(imgPath).size
    } catch {
      return null
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async send(text, options = {}) {
    this.assertSupported()
    if (!this.expectedGroup) {
      throw new Error('Refusing to send: no expectedGroup configured, so the target chat cannot be verified.')
    }
    const clean = sanitizeForWeChat(text)
    if (!clean) throw new Error('Refusing to send an empty message.')

    const window = await this.prepareSend({ requireFront: options.requireFront === true })
    if (!options.requireFront && await this.readComposerText(window)) {
      throw new Error('微信输入框中已有草稿，请先处理草稿')
    }
    const mode = this.antiDetection.phraseTyping ? 'human' : 'paste'
    const useTyping = shouldTypeViaKeyboard(clean, mode)
    const delay = this.antiDetection.naturalCadence
      ? composingDelaySeconds(clean, { minSeconds: this.delayMin, maxSeconds: this.delayMax, typed: useTyping })
      : this.delayMin + Math.random() * Math.max(0, this.delayMax - this.delayMin)
    if (delay > 0) await sleep(delay * 1000)

    await this.assertFrontChat(window)
    if (!options.requireFront || !this.antiDetection.curvedMouse) {
      await this.clickComposer(window)
      if (this.delayMax > 0) await sleep(65 + Math.round(Math.random() * 95))
    }

    if (useTyping) {
      await this.typeIntoComposer(clean, window)
      if (this.delayMax > 0) await sleep(140 + Math.round(Math.random() * 190))
    } else {
      await this.setClipboard(clean)
      if ((await this.readClipboardText()) !== clean) {
        await this.setClipboard(clean)
        if ((await this.readClipboardText()) !== clean) {
          throw new Error('Send aborted: the clipboard changed before pasting.')
        }
      }
      await this.assertFrontChat(window)
      await this.pasteIntoComposer(window)
      await sleep(this.delayMax > 0 ? 190 + Math.round(Math.random() * 180) : 40)

      const composer = await this.readComposerText(window)
      if (composer && isComposerWrong(composer, clean)) {
        await this.assertFrontChat(window)
        await this.clearComposer(window)
        throw new Error('Send aborted: the input box did not contain the drafted message.')
      }
    }

    await options.beforeSubmit?.()
    await this.assertFrontChat(window)
    await this.pressReturn(window)
    return { sent: clean, delaySeconds: Number(delay.toFixed(2)), mode: useTyping ? 'type' : 'paste' }
  }

  async sendImage(path, { beforeSubmit } = {}) {
    this.assertSupported()
    if (!this.expectedGroup) throw new Error('Refusing to send: no expectedGroup configured.')
    if (!path || !existsSync(path)) throw new Error(`图片不存在：${path}`)
    const target = await this.prepareSend()

    const clip = await this.callHelper(['clipboard-set-image', path])
    if (!clip.ok) throw new Error('无法将图片写入剪贴板')

    let pasted = false
    for (let attempt = 1; attempt <= 2 && !pasted; attempt += 1) {
      await this.assertFrontChat(target)
      await this.clickComposer(target)
      await sleep(180)
      await this.assertFrontChat(target)
      await this.clearComposer(target)
      await sleep(120)
      const before = await this.composerSignature(target)
      await this.assertFrontChat(target)
      await this.pasteIntoComposer(target)
      await sleep(750)
      const after = await this.composerSignature(target)
      if (before !== null && after !== null) {
        pasted = Math.abs(after - before) / Math.max(1, before) >= 0.05
      } else {
        pasted = true
      }
      if (!pasted) await sleep(250)
    }
    if (!pasted) {
      await this.assertFrontChat(target)
      await this.clearComposer(target)
      throw new Error('Send aborted: the paste did not put an image in the input box.')
    }
    await beforeSubmit?.()
    await this.assertFrontChat(target)
    await this.pressReturn(target)
    await sleep(350)
    return { sent: path, kind: 'image' }
  }

  // --------------------------------------------------------- native stickers

  async prepareStickerHelper() {
    await this.ensureHelperBinary()
  }

  async runStickerHelper(...args) {
    return this.callHelper(args)
  }

  async captureWindowToFile(target, path) {
    const cap = await this.callHelper(['capture', target.id, path, 0, 0, target.width, target.height, 0])
    return { window: target, viaRegion: Boolean(cap.viaRegion || cap.blank) }
  }

  async captureRectToFile(frame, path) {
    await this.callHelper(['capture', 0, path, frame.x, frame.y, frame.width, frame.height, 0])
  }

  async collectStickers() {
    this.assertSupported()
    return new NativeStickerPicker(this).collect()
  }

  async sendSticker(sticker, options) {
    this.assertSupported()
    return new NativeStickerPicker(this).send(sticker, options)
  }
}
