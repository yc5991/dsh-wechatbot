/**
 * macOS WeChat bridge: window discovery, screen capture, OCR, chat parsing, and
 * human-like send. Zero injection: the OS-level window list, `screencapture`,
 * Apple's Vision OCR, and `osascript` keyboard events.
 *
 * Window geometry comes from CGWindowList, which needs only Screen Recording.
 * The accessibility API is required only for keyboard input (sending).
 */

import { WeChatClient, sanitizeForWeChat } from './wechat-client.js'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const VISION_OCR_SOURCE = `
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: vision_ocr <image_path>\\n", stderr)
    exit(1)
}
let imagePath = CommandLine.arguments[1]
guard let nsImage = NSImage(contentsOfFile: imagePath),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("Failed to load image: \\(imagePath)\\n", stderr)
    exit(1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do { try handler.perform([request]) } catch {
    fputs("Vision OCR failed: \\(error)\\n", stderr); exit(1)
}
struct LineItem: Codable { let text: String; let x: Double; let y: Double; let w: Double; let h: Double }
var results: [LineItem] = []
if let observations = request.results {
    for obs in observations {
        if let candidate = obs.topCandidates(1).first {
            let box = obs.boundingBox
            results.append(LineItem(
                text: candidate.string,
                x: Double(box.origin.x),
                y: 1.0 - Double(box.origin.y + box.size.height),
                w: Double(box.size.width),
                h: Double(box.size.height)))
        }
    }
}
results.sort { abs($0.y - $1.y) < 0.018 ? $0.x < $1.x : $0.y < $1.y }
if let data = try? JSONEncoder().encode(results), let s = String(data: data, encoding: .utf8) { print(s) }
`

const WINDOW_LIST_SOURCE = `
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1 else { print("[]"); exit(0) }
let wanted = CommandLine.arguments[1]
let opts = CGWindowListOption(arrayLiteral: .optionAll)
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    print("[]"); exit(0)
}
var out: [[String: Any]] = []
for w in list {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    if owner != wanted { continue }
    let name = w[kCGWindowName as String] as? String ?? ""
    let layer = w[kCGWindowLayer as String] as? Int ?? -1
    let onscreen = w[kCGWindowIsOnscreen as String] as? Bool ?? false
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    out.append([
        "id": w[kCGWindowNumber as String] as? Int ?? 0,
        "title": name,
        "layer": layer,
        "onscreen": onscreen,
        "x": (b["X"] as? Double) ?? 0,
        "y": (b["Y"] as? Double) ?? 0,
        "width": (b["Width"] as? Double) ?? 0,
        "height": (b["Height"] as? Double) ?? 0,
    ])
}
if let data = try? JSONSerialization.data(withJSONObject: out), let s = String(data: data, encoding: .utf8) { print(s) }
`

const DRAG_HELPER = 'drag-copy-v3'
const DRAG_COPY_SOURCE = `
import Cocoa
let args = CommandLine.arguments
guard args.count >= 5 else { print("usage: x1 y1 x2 y2 [copy|drag]"); exit(1) }
let x1 = Double(args[1])!, y1 = Double(args[2])!, x2 = Double(args[3])!, y2 = Double(args[4])!
let mode = args.count > 5 ? args[5] : "copy"
let src = CGEventSource(stateID: .hidSystemState)
func post(_ t: CGEventType, _ x: Double, _ y: Double) {
    CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
}
post(.mouseMoved, x1, y1); usleep(150_000)
post(.leftMouseDown, x1, y1); usleep(150_000)
let steps = 30
for i in 1...steps {
    let f = Double(i) / Double(steps)
    post(.leftMouseDragged, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f)
    usleep(22_000)
}
usleep(200_000)
post(.leftMouseUp, x2, y2)
usleep(250_000)
if mode == "copy" {
    let clipboard = NSPasteboard.general
    let previousCount = clipboard.changeCount
    let cKey: CGKeyCode = 0x08
    let down = CGEvent(keyboardEventSource: src, virtualKey: cKey, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: cKey, keyDown: false)
    down?.flags = .maskCommand
    up?.flags = .maskCommand
    down?.post(tap: .cghidEventTap); usleep(60_000); up?.post(tap: .cghidEventTap)
    var copied: String? = nil
    for _ in 0..<16 {
        if clipboard.changeCount != previousCount, let text = clipboard.string(forType: .string), !text.isEmpty {
            copied = text
            break
        }
        usleep(50_000)
    }
    // Copying puts the chat into multi-select mode, where the composer is replaced
    // by a toolbar. Leave it before any later paste would have nowhere to go.
    let escKey: CGKeyCode = 0x35
    let escDown = CGEvent(keyboardEventSource: src, virtualKey: escKey, keyDown: true)
    let escUp = CGEvent(keyboardEventSource: src, virtualKey: escKey, keyDown: false)
    escDown?.post(tap: .cghidEventTap); usleep(40_000); escUp?.post(tap: .cghidEventTap)
    usleep(150_000)
    if let text = copied { print(text) }
}
`

const TIMESTAMP_RE =
  /^(?:昨天|前天|今天|星期[一二三四五六日天])?\s*\d{1,2}:\d{2}$|^\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}$|^\d{4}年\d{1,2}月\d{1,2}日.*$/

/**
 * Loose timestamp test for OCR leftovers such as `）：46` or `+：39`, which are
 * a session-list clock glyph fused with a prefix. Matching only strict `HH:MM`
 * let these through into the transcript.
 */
const TIMESTAMP_LOOSE_RE = /^[\s）)+：:]*\d{1,2}[：:]\d{2}\s*$/

const run = (cmd, args, options = {}) => execFileAsync(cmd, args, { timeout: 20_000, ...options })

/** Quote a string for safe embedding in an AppleScript double-quoted literal. */
const asQuote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function normalizeText(text) {
  return String(text || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

const DISPLAY_SOURCE = String.raw`
import CoreGraphics
var count: UInt32 = 0
CGGetActiveDisplayList(0, nil, &count)
var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
CGGetActiveDisplayList(count, &ids, &count)
for id in ids where CGDisplayIsMain(id) != 0 {
    let b = CGDisplayBounds(id)
    print("\(Int(b.origin.x)),\(Int(b.origin.y)),\(Int(b.width)),\(Int(b.height))")
}
`

const displayBinPath = join(tmpdir(), 'dsh-wechatbot-display')

/**
 * Main display bounds in screen points, or null when unavailable.
 *
 * Compiled once into a small binary: `swift -e` re-parses the source on every
 * call, which is ~1s each time and far too slow to sit inside a drag sequence.
 */
function mainDisplayBounds() {
  try {
    if (!existsSync(displayBinPath)) {
      const srcPath = join(tmpdir(), 'dsh-wechatbot-display.swift')
      writeFileSync(srcPath, DISPLAY_SOURCE, 'utf8')
      execFileSync('swiftc', ['-O', srcPath, '-o', displayBinPath], { timeout: 90_000 })
    }
    const out = execFileSync(displayBinPath, [], { timeout: 10_000, encoding: 'utf8' })
    const [x, y, w, h] = String(out).trim().split(',').map(Number)
    if ([x, y, w, h].every(Number.isFinite)) return { x, y, width: w, height: h }
  } catch { /* fall through */ }
  return null
}

export class MacOSWeChatClient extends WeChatClient {
  static get platform() { return 'macos' }

  get appName() { return this._appName }

  constructor(config = {}) {
    super(config)
    // The macOS process is named 微信, not WeChat. Accept both.
    this._appName = config.appName || '微信'
    this.appAliases = config.appAliases || ['微信', 'WeChat']
    this.whitelistGroups = config.whitelistGroups || []
    this.expectedGroup = config.expectedGroup || ''
    this.privateChat = config.privateChat === true
    // Manual drag rectangle (absolute screen points), when the user supplies one.
    const manual = config.dragPoints
    this.dragPoints = manual && [manual.x1, manual.y1, manual.x2, manual.y2].every((v) => Number.isFinite(Number(v)))
      && ![manual.x1, manual.y1, manual.x2, manual.y2].every((v) => Number(v) === 0)
      ? { x1: Number(manual.x1), y1: Number(manual.y1), x2: Number(manual.x2), y2: Number(manual.y2) }
      : null
    this.atKeywords = config.atKeywords || ['@豆包', '豆包']
    this.botNickname = config.botNickname || '豆包'
    this.delayMin = Number(config.replyDelayMinSeconds ?? 0.8)
    this.delayMax = Number(config.replyDelayMaxSeconds ?? 2.4)
    this.ocrBinPath = join(tmpdir(), 'dsh-wechatbot-vision-ocr')
    this.winBinPath = join(tmpdir(), 'dsh-wechatbot-window-list-v2')
    this.dragBinPath = join(tmpdir(), 'dsh-wechatbot-drag-v3')
    this.lastOcrError = ''
    this.lastWindowError = ''
  }

  assertSupported() {
    if (process.platform !== 'darwin') {
      throw new Error(`dsh-wechatbot only runs on macOS (current platform: ${process.platform}).`)
    }
  }

  /** Compile a Swift helper once; fall back to `swift` interpretation. */
  async compileHelper(binPath, source, tag) {
    if (existsSync(binPath)) return true
    const srcPath = join(tmpdir(), `dsh-wechatbot-${tag}.swift`)
    writeFileSync(srcPath, source, 'utf8')
    try {
      await run('swiftc', ['-O', srcPath, '-o', binPath], { timeout: 120_000 })
      return true
    } catch (error) {
      writeFileSync(join(tmpdir(), `dsh-wechatbot-${tag}.failed`), error.message, 'utf8')
      return false
    }
  }

  async ensureOcrBinary() {
    const ok = await this.compileHelper(this.ocrBinPath, VISION_OCR_SOURCE, 'vision-ocr')
    if (!ok) this.lastOcrError = 'swiftc unavailable for the OCR helper; will interpret with swift.'
    return ok
  }

  async ensureDragBinary() {
    const ok = await this.compileHelper(this.dragBinPath, DRAG_COPY_SOURCE, DRAG_HELPER)
    if (!ok) this.lastWindowError = 'swiftc unavailable for the drag helper.'
    return ok
  }

  async ensureWindowListBinary() {
    const ok = await this.compileHelper(this.winBinPath, WINDOW_LIST_SOURCE, 'window-list-v2')
    if (!ok) this.lastWindowError = 'swiftc unavailable for the window-list helper; will interpret with swift.'
    return ok
  }

  async runHelper(binPath, tag, args) {
    const srcPath = join(tmpdir(), `dsh-wechatbot-${tag}.swift`)
    if (existsSync(binPath)) return (await run(binPath, args)).stdout
    return (await run('swift', [srcPath, ...args], { timeout: 30_000 })).stdout
  }

  // ------------------------------------------------------------------ window

  /**
   * List candidate top-level windows for WeChat via CGWindowList.
   *
   * This replaces an accessibility-based lookup that failed with error -25211
   * when the calling process lacks the Accessibility permission, and that also
   * used `window 1`, i.e. whatever window happened to be frontmost.
   */
  async listWindows() {
    this.assertSupported()
    this.windowListReady ??= this.ensureWindowListBinary()
    await this.windowListReady
    const alias = this.appName
    const raw = String(await this.runHelper(this.winBinPath, 'window-list-v2', [alias])).trim()
    let windows = []
    try {
      windows = JSON.parse(raw || '[]')
    } catch {
      throw new Error(`Window list returned unparseable output: ${raw.slice(0, 200)}`)
    }
    return windows
      .filter((win) => win.layer === 0 && Number(win.width) >= 400 && Number(win.height) >= 300)
      .filter((win) => win.onscreen === true || win.width > 0)
      .map((win) => ({
        id: Number(win.id) || null,
        title: win.title || '',
        x: Math.round(win.x),
        y: Math.round(win.y),
        width: Math.round(win.width),
        height: Math.round(win.height),
        onscreen: win.onscreen === true,
      }))
  }

  /**
   * Pick the WeChat main window: the largest on-screen layer-0 window. Titled
   * matches against the expected/whitelisted group are preferred when present.
   */
  /**
   * The main WeChat window, the only one with the session sidebar.
   *
   * Sidebar operations (listing chats, dragging a row out) must target it: a
   * detached chat window has no sidebar, and reading its left 28% produced
   * nonsense "chat names" taken from the conversation itself.
   */
  async mainWindow() {
    const windows = await this.listWindows()
    return windows.find((win) => /^(微信|WeChat|Weixin)$/i.test(String(win.title || '').trim())) ?? null
  }

  async getChatWindow() {
    const windows = await this.listWindows()
    if (windows.length === 0) return null
    const wanted = [this.expectedGroup, ...this.whitelistGroups].filter(Boolean)
    const titled = windows.find((win) => win.title && wanted.some((name) => win.title.includes(name)))
    if (titled) return { ...titled, matchedByTitle: true }
    const largest = [...windows].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    return { ...largest, matchedByTitle: false }
  }


  /**
   * Geometry of the chat pane inside a window.
   *
   * A detached chat window (title = the chat name) is the pane on its own: there
   * is no session sidebar, so the message column starts at the window's left
   * edge. Treating it like the main window cut 28% off the left, which cropped
   * the messages out of the OCR capture and started select-drags to the right of
   * every bubble — both looked like "the reader cannot see the conversation".
   */
  layoutOf(target) {
    const title = String(target?.title ?? '').trim()
    const detached = title.length > 0 && !/^(微信|WeChat|Weixin)$/i.test(title)
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

  // --------------------------------------------------------------------- OCR

  async ocrImage(imgPath) {
    let stdout = ''
    try {
      this.ocrReady ??= this.ensureOcrBinary()
      await this.ocrReady
      stdout = String(await this.runHelper(this.ocrBinPath, 'vision-ocr', [imgPath])).trim()
      this.lastOcrError = ''
    } catch (error) {
      this.lastOcrError = `OCR failed: ${error.message}`
      return []
    }
    try {
      return JSON.parse(stdout || '[]')
    } catch {
      this.lastOcrError = 'OCR returned non-JSON output.'
      return []
    }
  }

  /** Capture the chat region of the main window and OCR it. */
  async captureChatRegion(win) {
    const layout = this.layoutOf(win)
    const region = { x: layout.x, y: layout.y, w: layout.w, h: Math.round(win.height * 0.86) }
    const items = await this.withChatCapture(win, Infinity, (path) => this.ocrImage(path))
    if (this.lastOcrError) throw new Error(this.lastOcrError)
    return { title: win.title, items, region }
  }

  /**
   * Send one image file (a meme, a sticker, a screenshot).
   *
   * WeChat sends an image when the clipboard holds PICTURE data, so the file is
   * put on the clipboard as a picture rather than as a path. The composer is
   * screenshotted before and after the paste: if nothing changed, the paste did
   * not produce an image and Return is never pressed.
   */
  async sendImage(path) {
    this.assertSupported()
    if (!this.expectedGroup) throw new Error('Refusing to send: no expectedGroup configured.')
    if (!path || !existsSync(path)) throw new Error(`图片不存在：${path}`)
    const check = await this.verifyTargetGroup()
    if (!check.ok) throw new Error(`Send aborted, target not confirmed: ${check.reason}`)

    const escaped = String(path).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    await run('osascript', ['-e', `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`])
    // The input box only accepts the paste when it has focus, and focus can be
    // stolen between the target check and the keystroke. Click it and verify the
    // paste actually changed the box, retrying once before giving up.
    let pasted = false
    for (let attempt = 1; attempt <= 2 && !pasted; attempt += 1) {
      await this.activateApp()
      await this.clickComposer()
      await sleep(250)
      // Start from an empty input so "before" cannot already contain an image
      // left over from an earlier attempt.
      await this.clearComposer()
      await sleep(150)
      const before = await this.composerSignature()
      await this.keystroke('keystroke "v" using command down')
      await sleep(900)
      const after = await this.composerSignature()
      // A pasted image changes the input-box look measurably; an empty box does
      // not. 5% clears the encoder noise without demanding a huge change.
      if (before !== null && after !== null) {
        pasted = Math.abs(after - before) / Math.max(1, before) >= 0.05
      } else {
        // No signature available: assume the paste landed rather than refusing
        // every image on a platform where the measurement failed.
        pasted = true
      }
      if (!pasted) await sleep(300)
    }
    if (!pasted) {
      await this.clearComposer()
      throw new Error('Send aborted: the paste did not put an image in the input box.')
    }
    await this.pressReturn()
    await sleep(400)
    return { sent: path, kind: 'image' }
  }

  /** Click the composer so keystrokes land in the input box. */
  async clickComposer() {
    const target = await this.getChatWindow()
    if (!target) return
    const layout = this.layoutOf(target)
    const x = layout.x + Math.round(layout.w * 0.5)
    const y = target.y + Math.round(target.height * 0.9)
    await this.helperClick(x, y)
  }

  /** A cheap fingerprint of the composer area (mean luminance). */
  async composerSignature() {
    const target = await this.getChatWindow()
    if (!target) return null
    const layout = this.layoutOf(target)
    const img = join(tmpdir(), `dsh-wechatbot-composer-${process.pid}.png`)
    const jpg = join(tmpdir(), `dsh-wechatbot-composer-${process.pid}.jpg`)
    try {
      await run('screencapture', ['-x', '-R',
        `${layout.x + 10},${target.y + Math.round(target.height * 0.865)},${layout.w - 20},${Math.round(target.height * 0.07)}`,
        img])
      // A JPEG at a fixed size gives a stable size figure: an empty input and an
      // image preview differ by far more than the encoder's noise.
      await run('sips', ['-s', 'format', 'jpeg', '-Z', '160', img, '--out', jpg])
      return statSync(jpg).size
    } catch {
      return null
    }
  }

  /** Click one screen point through the compiled drag helper's sibling. */
  async helperClick(x, y) {
    const bin = join(tmpdir(), 'dsh-wechatbot-click')
    if (!existsSync(bin)) {
      const src = join(tmpdir(), 'dsh-wechatbot-click.swift')
      writeFileSync(src, `
import Cocoa
let a = CommandLine.arguments
let x = Double(a[1])!, y = Double(a[2])!
let src = CGEventSource(stateID: .hidSystemState)
let p = CGPoint(x: x, y: y)
CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(60_000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(40_000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
`, 'utf8')
      try {
        await run('swiftc', ['-O', src, '-o', bin], { timeout: 120_000 })
      } catch {
        return
      }
    }
    await run(bin, [String(x), String(y)]).catch(() => {})
  }

  /**
   * Capture the chat pane as a PNG the model can actually look at.
   *
   * OCR tells the bot that a bubble exists; only an image tells it what the
   * bubble shows — a photo, a screenshot of an error, a sticker. The capture is
   * downscaled first: a 2x window shot is ~2MB, and the model does not need that
   * resolution to read a sticker.
   */
  async captureChatImage({ maxWidth = 1000 } = {}) {
    const target = await this.getChatWindow()
    if (!target?.id) return null
    return this.withChatCapture(target, maxWidth, (path) => ({
      mediaType: 'image/png', data: readFileSync(path).toString('base64'), name: 'wechat-chat.png',
    }))
  }

  async withChatCapture(target, maxWidth, read) {
    const layout = this.layoutOf(target)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-vision-'))
    const raw = join(dir, 'window.png')
    const cropped = join(dir, 'chat.png')
    const resized = join(dir, 'preview.png')
    try {
      // Window capture excludes anything covering WeChat and leaves focus alone.
      await run('screencapture', ['-x', '-o', '-l', String(target.id), raw])
      const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', raw])
      const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1])
      const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1])
      if (!width || !height) throw new Error('无法读取微信窗口截图尺寸')
      const left = Math.round(width * layout.sidebarW / target.width)
      const chatWidth = width - left
      await run('sips', [
        '-c', String(Math.round(height * 0.86)), String(chatWidth),
        '--cropOffset', '0', String(left), raw, '--out', cropped,
      ])
      const path = chatWidth > maxWidth ? resized : cropped
      if (path === resized) await run('sips', ['--resampleWidth', String(maxWidth), cropped, '--out', resized])
      return await read(path)
    } catch (error) {
      throw new Error('无法截取微信窗口，请确认窗口已打开，并检查 DSH 的屏幕录制权限。', { cause: error })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // ----------------------------------------------------------------- parsing

  /**
   * Turn OCR lines into messages.
   *
   * A line opens a new sender block only when it is left-aligned, short,
   * punctuation-free, and content has already accumulated. The original heuristic
   * also fired on an empty buffer, so a first line like "收到" became the sender
   * and every later message was attributed to it.
   */
  parseMessages(title, items, options = {}) {
    const group = this.pickGroupName(title, items)
    // Vision reports text inside a shared image at a much smaller glyph height
    // than real chat bubbles (≈0.006–0.010 vs ≈0.015–0.021 of the capture
    // height). Dropping those lines keeps screenshot contents out of the
    // transcript; `includeImageText` returns them separately when wanted.
    const minGlyphHeight = options.minGlyphHeight ?? 0.014
    const isImageText = (item) => Number(item.h ?? 1) < minGlyphHeight

    const body = items
      .filter((item) => {
        const y = Number(item.y ?? 0)
        const x = Number(item.x ?? 0)
        // Right-hand bubbles are the bot's own messages: WeChat right-aligns them,
        // so anything past the middle of the chat column is outgoing. The old
        // cutoff (0.55) sat right of where outgoing bubbles actually start
        // (measured x≈0.488), so the bot's own lines were read back as incoming.
        return y >= 0.10 && x < 0.30 && !isImageText(item)
      })
      // A sender name and its first bubble can sit at nearly the same y. Sort by
      // the real vertical position (not Vision's lenient same-line grouping),
      // breaking ties by column so a name always precedes its own text.
      .slice()
      .sort((a, b) => {
        const dy = Number(a.y ?? 0) - Number(b.y ?? 0)
        if (Math.abs(dy) > 1e-4) return dy
        return Number(a.x ?? 0) - Number(b.x ?? 0)
      })
    const imageLines = items
      .filter((item) => {
        const y = Number(item.y ?? 0)
        const x = Number(item.x ?? 0)
        return y >= 0.10 && x < 0.30 && isImageText(item)
      })
      .map((item) => String(item.text || '').trim())
      .filter(Boolean)

    const messages = []
    let sender = '群友'
    let buffer = []
    let hasSender = false
    // WeChat Mac draws sender names in a fixed column and bubble text in a
    // second one. Measured on a 960px-wide window: names land at x≈0.144–0.146,
    // message text starts at x≈0.163. The old rule (`x < 0.18`) covered both
    // columns, so it both missed real names and swallowed message text as a
    // name. Test the column instead of a loose upper bound.
    const senderColMin = options.senderColMin ?? 0.125
    const senderColMax = options.senderColMax ?? 0.155

    const flush = () => {
      const content = buffer.join(' ').trim()
      buffer = []
      if (!content) return
      messages.push({
        groupName: group,
        sender,
        content,
        isAtMe: this.atKeywords.some((kw) => content.toLowerCase().includes(kw.toLowerCase())),
        fingerprint: fingerprint(group, sender, content),
      })
    }

    // The same person may post several bubbles in a row, each introduced by its
    // own name line: name, text, name, text. A sender line therefore closes any
    // pending message even when nothing followed it, and two names in a row are
    // legitimate. What is NOT a name is a line in the sender column that is long,
    // punctuated, or a known system notice.
    for (const item of body) {
      const line = String(item.text || '').trim()
      if (!line) continue
      if (TIMESTAMP_RE.test(line) || TIMESTAMP_LOOSE_RE.test(line)) continue
      if (/^以下为新消息$|撤回了一条消息$|加入了群聊$|退出了群聊$/.test(line)) continue

      const x = Number(item.x ?? 0)
      const inSenderColumn = x >= senderColMin && x <= senderColMax
      const looksLikeSender =
        inSenderColumn &&
        line.length <= 16 &&
        !/[，。？！、：；,?!.:;]|http/i.test(line)

      if (looksLikeSender) {
        flush()
        sender = line
        hasSender = true
        continue
      }
      // OCR sometimes fuses a session-list clock fragment (`）：46`) onto the end
      // of a message line. Strip that trailing fragment rather than dropping the
      // whole message.
      buffer.push(line.replace(/\s*[）)\]+：]{0,3}\d{1,2}[：:]\d{2}\s*$/, '').trim())
    }
    flush()

    return { group, messages, hasSender, imageLines, skippedImageLines: imageLines.length }
  }

  /**
   * Parse a one-to-one chat from OCR lines.
   *
   * A private chat looks nothing like a group: there are no sender names, the
   * incoming bubbles are left-aligned and the outgoing ones right-aligned, and a
   * drag-select copies nothing (WeChat only offers message multi-select in group
   * chats). So messages are rebuilt from bubble side and vertical grouping.
   */
  parsePrivate(title, items) {
    const lines = (items || [])
      .filter((item) => {
        const y = Number(item.y ?? 0)
        const text = String(item.text || '').trim()
        if (y < 0.12 || !text) return false
        if (TIMESTAMP_RE.test(text) || TIMESTAMP_LOOSE_RE.test(text)) return false
        if (/^(微信电脑版|昨天|今天|前天|星期[一二三四五六日天])/.test(text)) return false
        // File cards and link previews carry chrome that is not message text.
        if (/^\d+(\.\d+)?\s*[KM]$/i.test(text)) return false
        if (/\.(md|zip|png|jpe?g|gif|pdf|dat|mp4)$/i.test(text)) return false
        if (/^(MD|ZIP|PDF)$/i.test(text)) return false
        // File-card footer and bullet-only chrome from OCR.
        if (/^[●•·*]?\s*微信电脑版$/.test(text)) return false
        if (/^[●•·*]+$/.test(text)) return false
        return true
      })
      .map((item) => ({
        text: String(item.text).trim(),
        y: Number(item.y ?? 0),
        x: Number(item.x ?? 0),
        w: Number(item.w ?? 0),
      }))
      .sort((a, b) => a.y - b.y)

    const grouped = []
    let current = null
    for (const line of lines) {
      const center = line.x + line.w / 2
      const own = center > 0.55
      if (current && current.own === own && line.y - current.lastY < 0.045) {
        current.text += ` ${line.text}`
        current.lastY = line.y
        continue
      }
      if (current) grouped.push(current)
      current = { own, text: line.text, lastY: line.y }
    }
    if (current) grouped.push(current)

    return grouped.map((entry) => ({
      groupName: title,
      sender: entry.own ? '我' : title,
      content: entry.text,
      isAtMe: !entry.own,
      own: entry.own,
      fingerprint: fingerprint(title, entry.own ? '我' : title, entry.text),
    }))
  }

  pickGroupName(title, items) {
    const headerLines = items.filter((i) => Number(i.y ?? 1) < 0.12).map((i) => String(i.text || ''))
    const candidates = [title, ...headerLines].filter(Boolean)
    for (const name of [this.expectedGroup, ...this.whitelistGroups].filter(Boolean)) {
      if (candidates.some((candidate) => candidate.includes(name))) return name
    }
    // The header often renders the group name plus a member count suffix.
    const header = headerLines.find((line) => !/^\d+$/.test(line) && line.length <= 40)
    return header || title || ''
  }

  // -------------------------------------------------------------------- send

  /** Replacement clipboard contents, with a strict read-back by the caller. */
  async setClipboard(text) {
    await new Promise((resolve, reject) => {
      const child = spawn('pbcopy')
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))))
      child.stdin.end(String(text), 'utf8')
    })
  }

  async readClipboardText() {
    try {
      // execFileAsync resolves to { stdout, stderr }, not to the text.
      const { stdout } = await run('pbpaste')
      return String(stdout)
    } catch {
      return ''
    }
  }

  /**
   * Bring the chat window itself forward.
   *
   * Activating the app only raises whichever WeChat window macOS considers
   * frontmost: with a second window open (or any other app overlapping the chat
   * pane) the region capture then records the wrong pixels and the title check
   * reads garbage. AXRaise targets the exact window by its title.
   */
  async raiseChatWindow(target = null) {
    target ??= await this.getChatWindow()
    if (!target?.title) return
    try {
      await run('osascript', ['-e',
        `tell application "System Events" to tell process ${asQuote(this.appName)} to perform action "AXRaise" of window ${asQuote(target.title)}`])
      await sleep(180)
    } catch { /* the app-level activation below still helps */ }
  }

  /** Bring WeChat forward; keystrokes only reach the frontmost app. */
  async activateApp(target = null) {
    try {
      await this.raiseChatWindow(target)
      await run('osascript', ['-e', `tell application "System Events" to set frontmost of process ${asQuote(this.appName)} to true`])
      await sleep(220)
    } catch (error) {
      const message = String(error.message || '')
      if (message.includes('-25211') || message.includes('不允许辅助访问')) {
        throw new Error(
          'WeChat interaction needs the Accessibility permission. Grant it in System Settings, Privacy & Security, '
          + 'Accessibility, for the application running DSH, then retry.',
        )
      }
      throw error
    }
  }

  async keystroke(script) {
    await run('osascript', ['-e', `
tell application "System Events"
    tell process ${asQuote(this.appName)}
        ${script}
    end tell
end tell
`])
  }

  async pasteIntoComposer() {
    await this.keystroke('keystroke "v" using command down')
  }

  async pressReturn() {
    await this.keystroke('key code 36')
  }

  /** Clear the composer after a bad paste: select all, then delete. */
  async clearComposer() {
    try {
      await this.keystroke('keystroke "a" using command down')
      await sleep(120)
      await this.keystroke('key code 51')
    } catch { /* best effort: a stuck selection is still better than a wrong send */ }
  }

  /** OCR the input box so a paste can be checked before Return is pressed. */
  async readComposerText() {
    const target = await this.getChatWindow()
    if (!target) return ''
    // The composer belongs to the chat pane, not the whole window: in the main
    // window the session list sits to its left.
    const layout = this.layoutOf(target)
    const x = layout.x + 8
    const y = target.y + Math.round(target.height * 0.865)
    const w = Math.max(120, layout.w - 16)
    const h = Math.max(40, Math.round(target.height * 0.11))
    const imgPath = join(tmpdir(), `dsh-wechatbot-composer-${process.pid}.png`)
    try {
      await run('screencapture', ['-x', '-R', `${x},${y},${w},${h}`, imgPath])
      const items = await this.ocrImage(imgPath)
      return items.map((item) => String(item.text || '')).join('\n').trim()
    } catch {
      return ''
    }
  }

  /**
   * Heuristic for "the composer does not hold my draft".
   *
   * Only obvious mismatches count, so a language-model reply that OCR mangles a
   * little is still sent: a sent-date line means a transcript was pasted, and a
   * body far longer than the draft means the same thing.
   */
  composerLooksWrong(composer, draft) {
    const text = String(composer || '')
    if (/\d{4}年\d{1,2}月\d{1,2}日/.test(text)) return true
    if (/在群聊中@了你|撤回了一条消息/.test(text)) return true
    const limit = Math.max(60, String(draft).length * 2.5)
    return text.replace(/\s+/g, '').length > limit
  }

  /** Copy only from a verified, foreground chat window. */
  async copyVisibleTranscript(target, capture) {
    const { region } = capture
    const layout = this.layoutOf(target)
    const yEndMax = target.y + Math.round(target.height * 0.80)
    const yManualMax = target.y + Math.round(target.height * 0.84)
    const insideChat = (x, y) => x > layout.x && x < layout.x + layout.w
      && y >= region.y + Math.round(region.h * 0.12) && y <= yManualMax

    let selections
    if (this.dragPoints) {
      const { x1, y1, x2, y2 } = this.dragPoints
      if (!insideChat(x1, y1) || !insideChat(x2, y2) || Math.hypot(x2 - x1, y2 - y1) < 20) {
        throw new Error('手动拖选坐标不在当前聊天消息区，请重新设置坐标')
      }
      selections = [this.dragPoints]
    } else {
      selections = this.selectionAnchors(region, capture.items)
        .filter((point) => point.y <= yEndMax - 20)
        .slice(0, 3)
        .map(({ x, y }) => ({ x1: x, y1: y, x2: region.x + region.w - 20, y2: yEndMax }))
    }
    if (!selections.length) throw new Error('没有找到可拖选的文字气泡')

    await this.ensureDragBinary()
    await this.activateApp(target)
    let reason = '剪贴板没有收到新的文字'
    for (const { x1, y1, x2, y2 } of selections) {
      const front = (await this.listWindows()).find((window) => window.onscreen)
      if (front?.id !== target.id || front.x !== target.x || front.y !== target.y
          || front.width !== target.width || front.height !== target.height) {
        throw new Error('微信聊天窗口已移动或未置于前面，已取消拖选')
      }
      const raw = await this.runHelper(this.dragBinPath, DRAG_HELPER, [x1, y1, x2, y2].map(String).concat('copy'))
      const parsed = parseClipboardTranscript(raw)
      if (parsed.parsed) return parsed.messages
      if (raw.trim()) reason = '复制内容没有可识别的微信聊天记录格式'
    }
    throw new Error(reason)
  }

  /**
   * Screen point to start a select-drag on.
   *
   * The topmost message text line is used: dragging down from it reaches every
   * bubble below, including the newest ones, while a drag started lower leaves
   * the tail of the conversation out of the copy. Header items, timestamps and
   * the divide/notice rows are skipped, since none of them belongs to a message.
   */
  selectionAnchors(region, items) {
    const rows = (items || []).filter((item) => {
      const text = String(item.text || '').trim()
      if (!text) return false
      const y = Number(item.y ?? 0)
      const h = Number(item.h ?? 0)
      if (y < 0.13 || y > 0.9) return false
      if (h > 0.06) return false
      if (TIMESTAMP_RE.test(text) || TIMESTAMP_LOOSE_RE.test(text)) return false
      if (/^以下为新消息$|撤回了一条消息$|加入了群聊$|退出了群聊$/.test(text)) return false
      return true
    })
    // Rows that belong to a file card or a link preview are not selection anchors:
    // dragging from a card drags the FILE out of the chat instead of selecting,
    // and dragging from a link starts a text/link drag. Everything within the same
    // vertical band as such a marker is treated as part of that card.
    const isCardText = (text) => /https?:\/\/|^[[【(（]?文件|微信电脑版|\.(md|zip|png|jpe?g|gif|pdf|dat)\b|^\d+(\.\d+)?\s*[KM]$/i.test(String(text || ''))
    const cardBands = rows.filter((row) => isCardText(row.text)).map((row) => Number(row.y))
    const plain = rows.filter((row) => {
      if (isCardText(row.text)) return false
      return !cardBands.some((y) => Math.abs(y - Number(row.y)) < 0.09)
    })
    const toPoint = (row) => ({
      x: region.x + Math.round((Number(row.x ?? 0) + Number(row.w ?? 0) / 2) * region.w),
      y: region.y + Math.round((Number(row.y ?? 0) + Number(row.h ?? 0) / 2) * region.h),
    })
    const candidates = []
    for (const row of plain.sort((a, b) => Number(a.y) - Number(b.y))) {
      const point = toPoint(row)
      if (!candidates.some((candidate) => Math.abs(candidate.y - point.y) < 14)) {
        candidates.push(point)
      }
    }
    return candidates
  }

  /**
   * Read the group title from the window header.
   *
   * The chat-region crop starts after the session sidebar, but WeChat draws the
   * conversation title across the full window width. Cropping that way cut the
   * leading characters ("Tim转生…" became "专生…"), which then failed the
   * target-group check. Capture only the header strip, full width.
   */
  async readGroupTitleOf(win) {
    const target = win ?? (await this.getChatWindow())
    if (!target) return { title: '', items: [] }
    const items = await this.withChatCapture(target, Infinity, (path) => this.ocrImage(path))
    if (this.lastOcrError) throw new Error(this.lastOcrError)
    const left = items.filter((item) => Number(item.y ?? 1) < 0.14
      && Number(item.x ?? 1) < 0.55 && /[\p{L}\p{N}]/u.test(String(item.text || '')))
    const expected = normalizeText(this.expectedGroup)
    const matching = left.find((item) => expected && normalizeText(item.text).includes(expected))
    const title = String((matching ?? left.sort((a, b) => Number(a.y) - Number(b.y))[0])?.text ?? '').trim()
    return { title, items }
  }

  /**
   * Group names from the session sidebar.
   *
   * The sidebar is the leftmost column; each row renders the chat name on the
   * first line and a preview underneath. Taking the longer line of each vertical
   * band gives the name, and normalizing drops the member-count suffix.
   */
  async listGroups(win) {
    const target = win ?? (await this.mainWindow()) ?? (await this.getChatWindow())
    if (!target) return []
    const sidebarW = Math.round(target.width * 0.28)
    const h = Math.round(target.height * 0.9)
    const imgPath = join(tmpdir(), `dsh-wechatbot-sidebar-${process.pid}.png`)
    await run('screencapture', ['-x', '-R', `${target.x},${target.y},${sidebarW},${h}`, imgPath])
    const items = await this.ocrImage(imgPath)

    // Sidebar rows: a chat name near the left edge, then its preview underneath,
    // with a timestamp right-aligned. Only the left-hand texts are candidates.
    const rows = items
      .map((i) => ({
        text: String(i.text || '').trim(),
        y: Number(i.y ?? 0),
        x: Number(i.x ?? 0),
        w: Number(i.w ?? 0),
      }))
      .filter((i) => i.text && i.x < 0.75)
      .sort((a, b) => a.y - b.y)

    const names = []
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      const raw = row.text

      // Skip the search field and system chrome.
      if (/^(搜索|通讯录|聊天|收藏)$/.test(raw)) continue
      // Skip previews: they carry a "someone: text" colon or a bracket attachment.
      if (/^[^:：]{1,20}[:：]/.test(raw)) continue
      if (/^［.*］/.test(raw) || /^\[.*\]/.test(raw)) continue
      // Skip a line the previous entry already consumed as its preview.
      const prev = rows[i - 1]
      if (prev && row.y - prev.y < 0.02) continue

      // A chat name is followed by a preview line close below it.
      const next = rows[i + 1]
      const hasPreview = next && next.y - row.y < 0.05
      if (!hasPreview) continue

      const name = raw
        .replace(/[（(]\d+[)）]\s*$/, '')
        .replace(/\s*(昨天|前天)?\s*\d{1,2}:\d{2}\s*$/, '')
        .replace(/\s*\d{1,2}月\d{1,2}日\s*$/, '')
        .trim()
      if (name.length < 2 || name.length > 40) continue
      if (/^[\d\s:：/.-]+$/.test(name)) continue
      if (names.includes(name)) continue
      names.push(name)
    }
    return names
  }

  /**
   * Locate a chat row in the sidebar by name.
   *
   * Returns the screen point where the row should be grabbed. OCR gives the row
   * band; the click point is its left-third, away from the unread badge and the
   * timestamp column.
   */
  async findSidebarRow(name, win) {
    const target = win ?? (await this.mainWindow()) ?? (await this.getChatWindow())
    if (!target) return null
    const sidebarW = Math.round(target.width * 0.28)
    const h = Math.round(target.height * 0.9)
    const imgPath = join(tmpdir(), `dsh-wechatbot-find-${process.pid}.png`)
    await run('screencapture', ['-x', '-R', `${target.x},${target.y},${sidebarW},${h}`, imgPath])
    const items = await this.ocrImage(imgPath)
    const wanted = normalizeText(name)

    let best = null
    for (const item of items) {
      const text = normalizeText(item.text)
      if (!text) continue
      if (Number(item.x ?? 0) > 0.75) continue
      // A sidebar name is the row's first line; accept a prefix match since the
      // sidebar truncates long names.
      const hit = text.includes(wanted) || wanted.startsWith(text) || text.startsWith(wanted)
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
  }

  /**
   * Tear a chat out into its own window by dragging its sidebar row.
   *
   * WeChat opens a detached chat window when a session row is dragged out of the
   * sidebar. This keeps several chats visible at once and gives each a fixed
   * position, which is far more reliable than switching the main window.
   *
   * @returns {Promise<{ok: boolean, title?: string, window?: object, reason?: string}>}
   */
  async openChatWindow(name, { dropX, dropY } = {}) {
    if (!this.dragBinPath || !existsSync(this.dragBinPath)) {
      await this.ensureDragBinary()
    }
    const row = await this.findSidebarRow(name)
    if (!row) return { ok: false, reason: `侧边栏没找到「${name}」` }

    const display = mainDisplayBounds()
    const leftEdge = display ? display.x : 0
    const midY = display ? display.y + Math.round(display.height * 0.45) : 400

    // Dock to the left half using the system's own window manager: dragging a
    // window to the screen's left edge makes macOS tile it there. Hand-setting
    // coordinates fought WeChat's own no-overlap rule and produced flicker, so
    // the drop point does the tiling and no AppleScript resize follows.
    const targetX = dropX ?? leftEdge + 2
    const targetY = dropY ?? midY

    await this.runHelper(this.dragBinPath, DRAG_HELPER, [String(row.x), String(row.y), String(targetX), String(targetY), 'drag'])
    await sleep(700)

    const windows = await this.listWindows()
    const opened = windows.find((w) => normalizeText(w.title).includes(normalizeText(name)))
    if (!opened) return { ok: false, reason: '拖动后没有出现独立窗口', windows }

    // The window exists; place it with the OS window-management command rather
    // than a drag or a hand-written frame.
    const tiled = await this.tileWindow(opened.title, 'left')
    const settled = tiled ?? opened
    return {
      ok: true,
      title: settled.title,
      window: settled,
      tiledLeftHalf: settled.x <= leftEdge + 8,
    }
  }

  /**
   * Move and resize a WeChat window by title.
   *
   * Detached chat windows are addressed by title, which is the chat name, so this
   * targets exactly the intended window rather than "the front one".
   */
  async moveWindow(title, { x, y, width, height }) {
    // Position and size must be applied in separate passes. WeChat re-lays out the
    // window when its size changes, which overwrites a position set in the same
    // step; measuring after each write showed the size sticking and the position
    // silently reverting.
    const script = (body) => `
tell application "System Events"
    tell process ${asQuote(this.appName)}
        repeat with w in windows
            try
                if (name of w as string) is ${asQuote(title)} then
                    set win to w
                    ${body}
                    return "ok"
                end if
            end try
        end repeat
        return "not-found"
    end tell
end tell
`
    try {
      const sized = Number.isFinite(width) && Number.isFinite(height)
      if (sized) {
        const sizeOut = await run('osascript', ['-e', script(
          `set size of win to {${Math.round(width)}, ${Math.round(height)}}`,
        )])
        if (String(sizeOut.stdout).trim() !== 'ok') return null
        await sleep(180)
      }
      const posOut = await run('osascript', ['-e', script(
        `set position of win to {${Math.round(x)}, ${Math.round(y)}}`,
      )])
      if (String(posOut.stdout).trim() !== 'ok') return null
      await sleep(180)
      const windows = await this.listWindows()
      return windows.find((w) => normalizeText(w.title).includes(normalizeText(title))) ?? null
    } catch {
      return null
    }
  }

  /**
   * Shift the main WeChat window right when it occupies the left dock column.
   *
   * WeChat prevents two of its own windows overlapping, so leaving the main window
   * in the left half makes the chat window land somewhere arbitrary instead of the
   * dock position.
   */
  async makeRoomForChatWindow(leftEdge = 0, chatWidth = 600) {
    const display = mainDisplayBounds()
    const windows = await this.listWindows()
    const main = windows.find((w) => /^微信$|^WeChat$/.test(w.title))
    if (!main) return null
    if (main.x >= leftEdge + chatWidth) return main
    const targetX = display
      ? Math.max(leftEdge + chatWidth, display.x + display.width - main.width)
      : leftEdge + chatWidth
    return this.moveWindow(main.title, { x: targetX, y: main.y })
  }

  /**
   * Place a window using macOS's own window management commands.
   *
   * WeChat exposes the system tiling menu under 窗口 → 移动与调整大小 (Split, Left,
   * Right, Quarters, Arrange). Driving that menu is exactly what the user does by
   * hand — no drag, no coordinates — and it defers to the OS for the final frame,
   * so the result matches anything else the user tiles.
   *
   * @param {string} title window title (the chat name for a detached window)
   * @param {'left'|'right'|'top'|'bottom'|'half'|'quarter-tl'|'quarter-tr'|'quarter-bl'|'quarter-br'} placement
   */
  async tileWindow(title, placement = 'left') {
    const items = {
      left: ['移动与调整大小', '左侧'],
      right: ['移动与调整大小', '右侧'],
      top: ['移动与调整大小', '顶部'],
      bottom: ['移动与调整大小', '底部'],
      half: ['移动与调整大小', '二等分'],
      'quarter-tl': ['移动与调整大小', '左上'],
      'quarter-tr': ['移动与调整大小', '右上'],
      'quarter-bl': ['移动与调整大小', '左下'],
      'quarter-br': ['移动与调整大小', '右下'],
    }[placement] || ['移动与调整大小', '左侧']

    // The menu command acts on the focused window, so raise the target first.
    const activate = `
tell application "System Events"
    tell process ${asQuote(this.appName)}
        repeat with w in windows
            try
                if (name of w as string) is ${asQuote(title)} then
                    perform action "AXRaise" of w
                    set frontmost to true
                    return "raised"
                end if
            end try
        end repeat
        return "not-found"
    end tell
end tell
`
    try {
      const raised = await run('osascript', ['-e', activate])
      if (String(raised.stdout).trim() !== 'raised') return null
      await sleep(180)

      const click = `
tell application "System Events"
    tell process ${asQuote(this.appName)}
        click menu item ${asQuote(items[1])} of menu 1 of menu item ${asQuote(items[0])} of menu 1 of menu bar item ${asQuote('窗口')} of menu bar 1
        return "clicked"
    end tell
end tell
`
      await run('osascript', ['-e', click])
      await sleep(400)
      return (await this.listWindows()).find((w) => normalizeText(w.title).includes(normalizeText(title))) ?? null
    } catch {
      return null
    }
  }

  /**
   * Thought-pause between consecutive bubbles in one burst.
   *
   * A person does not paste nine lines at a fixed cadence: short thoughts come
   * fast, a longer one is preceded by a beat. `send()` adds its own typing delay;
   * this models the composing pause before the next bubble.
   */
  nextBubblePause(previousText) {
    const len = String(previousText || '').length
    // Base: 0.25-0.7s. Longer prior text implies more reading/rethinking after.
    const base = 0.25 + Math.random() * 0.45
    const tail = Math.min(1.2, len / 40)
    return Number((base + tail * Math.random()).toFixed(2))
  }

  /**
   * Confirm the chat on screen is the expected group, immediately before sending.
   * Cheap insurance against a chat switch while the model is composing.
   */

  // ------------------------------------------------------- interface shims

  /** Interface: findWindow */
  async findWindow() {
    const win = await this.getChatWindow()
    return win ?? null
  }

  async readByCopy() {
    return this.readVisible({ mode: 'copy' })
  }

  async readVisible({ mode = 'auto' } = {}) {
    const win = await this.getChatWindow()
    if (!win?.id) return { source: 'unavailable', group: '', messages: [], copyIssue: '未找到微信聊天窗口' }
    const capture = await this.captureChatRegion(win)
    const parsed = this.parseMessages(capture.title, capture.items)
    const group = parsed.group || capture.title
    let copyIssue

    if (mode !== 'ocr' && !this.privateChat) {
      const targets = [this.expectedGroup, ...this.whitelistGroups].filter(Boolean)
      if (targets.length && !targets.some((target) => normalizeText(target) === normalizeText(group))) {
        copyIssue = '当前微信窗口不是已配置的聊天'
      } else {
        try {
          const messages = await this.copyVisibleTranscript(win, capture)
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
      const messages = this.parsePrivate(group, capture.items)
      if (this.privateChat || messages.length) return { source: 'private-ocr', group, messages, copyIssue }
    }
    return { source: 'ocr', group, messages: parsed.messages, copyIssue }
  }

  /** Interface: readGroupTitle */
  async readGroupTitle() {
    const win = await this.getChatWindow()
    if (!win) return ''
    const { title } = await this.readGroupTitleOf(win)
    return title
  }

  /** Interface: verifyTarget */
  async verifyTarget() {
    return this.verifyTargetGroup()
  }

  async verifyTargetGroup() {
    if (!this.expectedGroup) return { ok: false, reason: 'No target chat configured.' }
    const win = await this.getChatWindow()
    if (!win) return { ok: false, reason: 'No WeChat chat window found.' }
    // Detached WeChat windows expose the current chat as their native title.
    // Strip only WeChat's trailing group-member count before exact comparison.
    const nativeTitle = String(win.title || '').replace(/\s*[（(]\d+[）)]\s*$/, '').trim()
    if (win.id && this.layoutOf(win).detached && nativeTitle === this.expectedGroup.trim()) {
      return { ok: true, detected: nativeTitle, windowId: win.id }
    }
    let title = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { title = (await this.readGroupTitleOf(win)).title } catch { title = '' }
      if (normalizeText(title)) break
      if (attempt === 0) await sleep(250)
    }
    if (!title) {
      return { ok: false, reason: 'Could not read the chat title, so the target group cannot be confirmed.' }
    }
    // Compare on a normalized form: OCR drops punctuation and the trailing
    // member count, so an exact string match is too brittle.
    const normalize = (text) => String(text).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
    const got = normalize(title)
    const want = normalize(this.expectedGroup)
    if (want && got.includes(want)) return { ok: true, detected: title, windowId: win.id }

    // A narrow window truncates the title in the header ("Tim转生！碳基生命也要
    // 拿出" for a longer name). Accept a shortened reading when it still agrees
    // on a substantial prefix; anything shorter is too weak to confirm.
    const shorter = got.length < want.length ? got : want
    const longer = got.length < want.length ? want : got
    if (shorter.length >= 6 && longer.startsWith(shorter)) {
      return { ok: true, detected: title, truncated: true, windowId: win.id }
    }
    return { ok: false, reason: `Front chat is "${title}", expected "${this.expectedGroup}".` }
  }

  /**
   * Send text with clipboard + Cmd+V + Return and a human-like pause.
   *
   * Keyboard events come from System Events, which needs the Accessibility
   * permission. A missing permission surfaces as AppleScript error -25211.
   */
  async send(text, options = {}) {
    this.assertSupported()
    // Without a named target there is nothing to verify against, and the send
    // would go to whatever chat happens to be open.
    if (!this.expectedGroup) {
      throw new Error('Refusing to send: no expectedGroup configured, so the target chat cannot be verified.')
    }
    const clean = sanitizeForWeChat(text)
    if (!clean) throw new Error('Refusing to send an empty message.')

    const delay = this.delayMin + Math.random() * Math.max(0, this.delayMax - this.delayMin)
    await sleep(delay * 1000)

    // Put the draft on the clipboard and prove it is still ours right before
    // pasting. A concurrent select-drag copy overwrites the clipboard, and then
    // the paste sends the *transcript* into the group instead of the reply.
    await this.setClipboard(clean)
    const pasted = await this.readClipboardText()
    if (pasted !== clean) {
      await this.setClipboard(clean)
      if ((await this.readClipboardText()) !== clean) {
        throw new Error('Send aborted: the clipboard changed before pasting, so the draft would not be what gets sent.')
      }
    }

    // `tell application "微信"` fails with -1728: the localized process name is
    // not resolvable as an application. Activate through System Events, which
    // addresses the running process directly.
    await this.activateApp()
    if (options.verifyTarget !== false) {
      const check = await this.verifyTargetGroup()
      if (!check.ok) throw new Error(`Send aborted, target group not confirmed: ${check.reason}`)
      const front = (await this.listWindows()).find((window) => window.onscreen)
      if (!check.windowId || front?.id !== check.windowId) {
        throw new Error('Send aborted: the verified chat window is not in front.')
      }
    }
    await this.pasteIntoComposer()
    await sleep(240)

    // Defence in depth: after pasting, the composer must look like our draft.
    // A transcript pasted by mistake is easy to spot — it carries sent dates or
    // is far longer than anything the bot writes.
    const composer = await this.readComposerText()
    if (composer && this.composerLooksWrong(composer, clean)) {
      await this.clearComposer()
      throw new Error('Send aborted: the input box did not contain the drafted message.')
    }

    await this.pressReturn()
    return { sent: clean, delaySeconds: Number(delay.toFixed(2)) }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function fingerprint(group, sender, content) {
  return createHash('md5').update(`${group}::${sender}::${content}`).digest('hex')
}

/** Strip Markdown so the chat receives what a person would type. */


/** Persisted daily quota. @-mentions are exempt by convention. */
export class QuotaTracker {
  constructor(statePath, dailyLimit = 1000) {
    this.statePath = statePath
    this.dailyLimit = dailyLimit
    this.state = this.load()
  }

  today() {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }

  load() {
    const empty = { date: this.today(), proactive: 0, at: 0 }
    try {
      if (!existsSync(this.statePath)) return empty
      const data = JSON.parse(readFileSync(this.statePath, 'utf8'))
      return data.date === this.today() ? { ...empty, ...data } : empty
    } catch {
      return empty
    }
  }

  rollover() {
    if (this.state.date !== this.today()) {
      this.state = { date: this.today(), proactive: 0, at: 0 }
      this.save()
    }
  }

  save() {
    try {
      mkdirSync(join(this.statePath, '..'), { recursive: true })
      writeFileSync(this.statePath, JSON.stringify({ ...this.state, limit: this.dailyLimit }, null, 2))
    } catch {
      /* best-effort persistence */
    }
  }

  get remaining() {
    this.rollover()
    return Math.max(0, this.dailyLimit - this.state.proactive)
  }

  canSpeak() {
    this.rollover()
    return this.dailyLimit <= 0 || this.state.proactive < this.dailyLimit
  }

  record(isAtMe) {
    this.rollover()
    if (isAtMe) this.state.at += 1
    else this.state.proactive += 1
    this.save()
  }
}

export const stateDir = () => join(homedir(), '.dsh', 'dsh-wechatbot')

/**
 * Phrases that try to turn chat text into instructions for this agent. Group
 * members can type anything, so chat content is untrusted input: these patterns
 * are surfaced to the model as a warning rather than silently treated as an
 * instruction.
 */
const INJECTION_PATTERNS = [
  /忘(?:掉|记)一切(?:上下文|设定|指令)/,
  /忽略(?:之前|以上|上面|前面)的?(?:所有)?(?:指令|设定|提示|规则)/,
  /ignore (?:all )?(?:previous|above|prior) (?:instructions?|prompts?|rules?)/i,
  /disregard (?:all )?(?:previous|above|prior)/i,
  /你(?:现在|从此)(?:是|就是)我(?:的)?主人/,
  /you are (?:now )?my (?:master|owner)/i,
  /(?:系统|system)\s*[:：]\s*你(?:现在|将)/,
  /从现在(?:开始|起)[，,]?\s*你(?:是|就是|要|必须|不能)/,
  /(?:执行|运行|调用|删除|rm -rf|curl .*\|.*sh).{0,12}(?:命令|脚本|tool|工具)/i,
  /(?:api[_\s-]?key|token|密码|密钥).{0,10}(?:发|告诉我|输出|打印)/i,
]

/** True when the text looks like an attempt to steer the agent through chat. */
export function looksLikeInjection(text) {
  const line = String(text || '')
  return INJECTION_PATTERNS.some((re) => re.test(line))
}

/** Split batch text into lines and flag every line that looks like an injection. */
export function scanForInjection(messages) {
  const flagged = []
  for (const msg of messages || []) {
    if (looksLikeInjection(msg.content)) {
      flagged.push({ sender: msg.sender, content: msg.content })
    }
  }
  return flagged
}

/**
 * Parse WeChat's own copy-to-clipboard transcript.
 *
 * Selecting messages in the chat and copying yields a plain-text block shaped
 * like:
 *
 *   昵称
 *   2026年11月24日 14:45
 *   消息内容
 *
 *   ＜下一人＞
 *
 * This is far more accurate than OCR: no glyph confusion, and the sender is
 * explicit. Copying fails when the selection includes an image, so callers
 * should treat an empty or malformed result as "fall back to OCR".
 */
export function parseClipboardTranscript(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return { messages: [], parsed: false, senders: [] }

  // WeChat emits: sender, timestamp, body (possibly multi-line), blank line.
  // Walk triples instead of guessing state from blank lines: find each timestamp
  // line, take the line above it as the sender and everything up to the next
  // sender/timestamp pair as the body.
  const lines = raw.split('\n')
  const dateRe = /^\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}$|^(?:昨天|前天|今天)\s*\d{1,2}:\d{2}$/

  const marks = []
  for (let i = 0; i < lines.length; i += 1) {
    if (dateRe.test(lines[i].trim())) marks.push(i)
  }
  if (marks.length === 0) return { messages: [], parsed: false, senders: [] }

  const messages = []
  const senders = []
  for (let m = 0; m < marks.length; m += 1) {
    const dateIdx = marks[m]
    const nextIdx = m + 1 < marks.length ? marks[m + 1] : lines.length

    // Sender is the nearest non-empty line above the timestamp.
    let sender = ''
    for (let i = dateIdx - 1; i >= 0; i -= 1) {
      const t = lines[i].trim()
      if (t) { sender = t; break }
    }
    // Body runs from after the timestamp to just before the next sender line.
    let bodyEnd = nextIdx
    for (let i = nextIdx - 1; i > dateIdx; i -= 1) {
      if (lines[i].trim()) { bodyEnd = i + 1; break }
    }
    // The next block's sender sits immediately before its timestamp.
    if (m + 1 < marks.length) {
      for (let i = marks[m + 1] - 1; i > dateIdx; i -= 1) {
        if (lines[i].trim()) { bodyEnd = i; break }
      }
    }

    const content = lines.slice(dateIdx + 1, bodyEnd).join('\n').trim()
    if (!sender || !content) continue
    if (!senders.includes(sender)) senders.push(sender)
    messages.push({
      groupName: '',
      sender,
      content,
      isAtMe: false,
      // A picture, a sticker or a file is information the text cannot carry; the
      // wake loop attaches a screenshot when one of these is in the batch.
      hasImage: /\[(图片|动画表情|视频|文件|语音)\]/.test(content) || /\.dat\b/.test(content),
      fingerprint: fingerprint('', sender, content),
    })
  }

  return { messages, parsed: messages.length > 0, senders }
}


/**
 * One pass of the polling loop: read the chat, decide whether a reply is worth
 * drafting, and return the new messages plus a trigger reason.
 *
 * This is deliberately a pure step rather than a daemon: DSH drives the cadence,
 * so a crash or a disabled plugin stops polling immediately.
 */
export function evaluateTriggers(messages, state, options = {}) {
  const {
    atKeywords = ['@豆包', '豆包'],
    jargonKeywords = [],
    veterans = [],
    proactiveProbability = 0.35,
    random = Math.random,
  } = options

  // Same identity rule as the caller's seen-set: prefer the notification id, so
  // a message seen through one path is still recognized through another.
  const keyOf = (msg) => (msg.notificationId
    ? `n:${msg.notificationId}`
    : `f:${msg.fingerprint || fingerprint(msg.groupName || '', msg.sender, msg.content)}`)

  const seen = state.seen ?? new Set()
  const fresh = messages.filter((msg) => {
    const key = keyOf(msg)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const decisions = []
  for (const msg of fresh) {
    const isAt =
      msg.isAtMe || atKeywords.some((kw) => msg.content.toLowerCase().includes(kw.toLowerCase()))
    const isVeteran = veterans.some((name) => msg.sender.includes(name))
    const matchedJargon = jargonKeywords.filter((kw) =>
      msg.content.toLowerCase().includes(kw.toLowerCase()))
    const isQuestion = /[?？]|啥意思|是什么|怎么|求教|不懂|啥叫|为什么|如何/.test(msg.content)

    let trigger = null
    let reason = ''
    if (isAt) {
      trigger = 'at'
      reason = '群友 @豆包'
    } else if (matchedJargon.length > 0 && isQuestion) {
      trigger = 'jargon'
      reason = `黑话提问：${matchedJargon.join('、')}`
    } else if (matchedJargon.length > 0) {
      trigger = 'topic'
      reason = `讨论技术话题：${matchedJargon.join('、')}`
    } else if (random() < proactiveProbability) {
      trigger = 'idle'
      reason = '日常接话'
    }

    if (!trigger) continue
    decisions.push({
      message: msg,
      trigger,
      reason,
      isAt,
      isVeteran,
      // @-mentions always get a reply and are exempt from the daily quota.
      quotaExempt: isAt,
    })
  }

  // Keep the seen-set bounded so a long-running loop does not grow forever.
  if (seen.size > 2000) {
    const trimmed = [...seen].slice(-1000)
    state.seen = new Set(trimmed)
  } else {
    state.seen = seen
  }
  return { fresh, decisions }
}


/**
 * Cap bracketed WeChat emoji per message.
 *
 * The persona allows one or two, but nothing enforced it, so replies arrived with
 * emoji on every sentence. Trim the surplus from the tail, where they cluster.
 */

