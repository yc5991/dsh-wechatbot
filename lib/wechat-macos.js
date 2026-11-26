/**
 * macOS WeChat bridge: window discovery, screen capture, OCR, chat parsing, and
 * human-like send. Zero injection: the OS-level window list, `screencapture`,
 * Apple's Vision OCR, and `osascript` keyboard events.
 *
 * Window geometry comes from CGWindowList, which needs only Screen Recording.
 * The accessibility API is required only for keyboard input (sending).
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
  TIMESTAMP_LOOSE_RE,
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
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    let sharing = w[kCGWindowSharingState as String] as? Int ?? 1
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    out.append([
        "id": w[kCGWindowNumber as String] as? Int ?? 0,
        "title": name,
        "layer": layer,
        "onscreen": onscreen,
        "sharing": sharing,
        "x": (b["X"] as? Double) ?? 0,
        "y": (b["Y"] as? Double) ?? 0,
        "width": (b["Width"] as? Double) ?? 0,
        "height": (b["Height"] as? Double) ?? 0,
    ])
}
if let data = try? JSONSerialization.data(withJSONObject: out), let s = String(data: data, encoding: .utf8) { print(s) }
`

const DRAG_HELPER = 'drag-copy-v4'
const DRAG_COPY_SOURCE = `
import Cocoa
let args = CommandLine.arguments
guard args.count >= 5 else { print("usage: x1 y1 x2 y2 [copy|drag]"); exit(1) }
let x1 = Double(args[1])!, y1 = Double(args[2])!, x2 = Double(args[3])!, y2 = Double(args[4])!
let mode = args.count > 5 ? args[5] : "copy"
let src = CGEventSource(stateID: .hidSystemState)
func post(_ t: CGEventType, _ x: Double, _ y: Double, clickState: Int64 = 0) {
    guard let ev = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { return }
    if clickState > 0 { ev.setIntegerValueField(.mouseEventClickState, value: clickState) }
    ev.post(tap: .cghidEventTap)
}
func curveMove(from p0: CGPoint, to p3: CGPoint, mouseType: CGEventType, steps: Int, minUs: UInt32, maxUs: UInt32) {
    let dx = Double(p3.x - p0.x), dy = Double(p3.y - p0.y)
    let dist = hypot(dx, dy)
    if dist < 3 || steps <= 1 {
        post(mouseType, Double(p3.x), Double(p3.y))
        return
    }
    let nx = -dy / dist, ny = dx / dist
    let arc = Double.random(in: -0.14...0.14) * dist
    let c1 = CGPoint(x: Double(p0.x) + dx * 0.30 + nx * arc, y: Double(p0.y) + dy * 0.30 + ny * arc)
    let c2 = CGPoint(x: Double(p0.x) + dx * 0.72 + nx * arc * 0.6, y: Double(p0.y) + dy * 0.72 + ny * arc * 0.6)
    for i in 1...steps {
        let u = Double(i) / Double(steps)
        // Minimum-jerk human velocity profile (accelerates then decelerates smoothly)
        let t = u * u * u * (10.0 + u * (-15.0 + 6.0 * u))
        let mt = 1.0 - t
        var x = mt*mt*mt*Double(p0.x) + 3*mt*mt*t*Double(c1.x) + 3*mt*t*t*Double(c2.x) + t*t*t*Double(p3.x)
        var y = mt*mt*mt*Double(p0.y) + 3*mt*mt*t*Double(c1.y) + 3*mt*t*t*Double(c2.y) + t*t*t*Double(p3.y)
        if i < steps {
            x += Double.random(in: -0.9...0.9)
            y += Double.random(in: -0.9...0.9)
        }
        post(mouseType, x, y)
        usleep(UInt32.random(in: minUs...maxUs))
    }
}
let currentPos = CGEvent(source: nil)?.location ?? CGPoint(x: x1, y: y1)
let approachSteps = max(6, min(18, Int(hypot(x1 - Double(currentPos.x), y1 - Double(currentPos.y)) / 36.0)))
curveMove(from: currentPos, to: CGPoint(x: x1, y: y1), mouseType: .mouseMoved, steps: approachSteps, minUs: 7_000, maxUs: 16_000)
usleep(UInt32.random(in: 85_000...155_000))
post(.leftMouseDown, x1, y1, clickState: 1)
usleep(UInt32.random(in: 95_000...165_000))
let dragSteps = Int.random(in: 24...34)
curveMove(from: CGPoint(x: x1, y: y1), to: CGPoint(x: x2, y: y2), mouseType: .leftMouseDragged, steps: dragSteps, minUs: 14_000, maxUs: 28_000)
usleep(UInt32.random(in: 170_000...280_000))
post(.leftMouseUp, x2, y2, clickState: 1)
usleep(UInt32.random(in: 190_000...310_000))
if mode == "copy" {
    let clipboard = NSPasteboard.general
    let previousCount = clipboard.changeCount
    let cKey: CGKeyCode = 0x08
    let down = CGEvent(keyboardEventSource: src, virtualKey: cKey, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: cKey, keyDown: false)
    down?.flags = .maskCommand
    up?.flags = .maskCommand
    down?.post(tap: .cghidEventTap)
    usleep(UInt32.random(in: 52_000...110_000))
    up?.post(tap: .cghidEventTap)
    var copied: String? = nil
    for _ in 0..<16 {
        if clipboard.changeCount != previousCount, let text = clipboard.string(forType: .string), !text.isEmpty {
            copied = text
            break
        }
        usleep(50_000)
    }
    usleep(UInt32.random(in: 75_000...150_000))
    let escKey: CGKeyCode = 0x35
    let escDown = CGEvent(keyboardEventSource: src, virtualKey: escKey, keyDown: true)
    let escUp = CGEvent(keyboardEventSource: src, virtualKey: escKey, keyDown: false)
    escDown?.post(tap: .cghidEventTap)
    usleep(UInt32.random(in: 45_000...95_000))
    escUp?.post(tap: .cghidEventTap)
    usleep(UInt32.random(in: 120_000...210_000))
    if let text = copied { print(text) }
}
`

const TYPE_HELPER = 'human-type-v1'
const HUMAN_TYPE_SOURCE = `
import Cocoa
import ApplicationServices

struct Chunk: Decodable { let text: String; let delayMs: Int }
let args = CommandLine.arguments
guard args.count >= 6,
      let winId = Int(args[1]),
      let wx = Double(args[2]),
      let wy = Double(args[3]) else { exit(2) }
let expectedTitle = args[4].trimmingCharacters(in: .whitespacesAndNewlines)
let appName = args[5]

func guardFront() -> Bool {
    guard let front = NSWorkspace.shared.frontmostApplication,
          front.localizedName == appName || front.bundleIdentifier == "com.tencent.xinWeChat",
          let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let win = list.first(where: { ($0[kCGWindowNumber as String] as? Int) == winId }),
          let b = win[kCGWindowBounds as String] as? [String: Any] else { return false }
    let cx = (b["X"] as? Double) ?? -99999
    let cy = (b["Y"] as? Double) ?? -99999
    if abs(cx - wx) > 2 || abs(cy - wy) > 2 { return false }
    let title = (win[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !expectedTitle.isEmpty && !title.isEmpty && title != expectedTitle { return false }
    return true
}

let stdinData = FileHandle.standardInput.readDataToEndOfFile()
guard let chunks = try? JSONDecoder().decode([Chunk].self, from: stdinData) else { exit(2) }
let src = CGEventSource(stateID: .hidSystemState)

for chunk in chunks {
    guard guardFront() else {
        fputs("WeChat window focus changed during typing\\n", stderr)
        exit(3)
    }
    let utf16 = Array(chunk.text.utf16)
    if !utf16.isEmpty {
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { exit(1) }
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        down.post(tap: .cghidEventTap)
        usleep(UInt32.random(in: 32_000...78_000))
        up.post(tap: .cghidEventTap)
    }
    let waitUs = UInt32(max(25, chunk.delayMs) * 1000)
    usleep(waitUs)
}
print("ok")
`

const run = (cmd, args, options = {}) => execFileAsync(cmd, args, { timeout: 20_000, ...options })

/** Quote a string for safe embedding in an AppleScript double-quoted literal. */
const asQuote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

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
    this.captureProtected = config.captureProtected === true
    // Manual drag rectangle (absolute screen points), when the user supplies one.
    const manual = config.dragPoints
    this.dragPoints = manual && [manual.x1, manual.y1, manual.x2, manual.y2].every((v) => Number.isFinite(Number(v)))
      && ![manual.x1, manual.y1, manual.x2, manual.y2].every((v) => Number(v) === 0)
      ? { x1: Number(manual.x1), y1: Number(manual.y1), x2: Number(manual.x2), y2: Number(manual.y2) }
      : null
    this.atKeywords = config.atKeywords || ['@豆包', '豆包']
    this.botNickname = config.botNickname || '豆包'
    this.antiDetection = normalizeAntiDetection(config.antiDetection)
    this.delayMin = Number(config.replyDelayMinSeconds ?? 0.8)
    this.delayMax = Number(config.replyDelayMaxSeconds ?? 2.4)
    this.ocrBinPath = join(tmpdir(), 'dsh-wechatbot-vision-ocr')
    this.winBinPath = join(tmpdir(), 'dsh-wechatbot-window-list-v3')
    this.dragBinPath = join(tmpdir(), 'dsh-wechatbot-drag-v4')
    this.typeBinPath = join(tmpdir(), 'dsh-wechatbot-type-v1')
    this.lastOcrError = ''
    this.lastWindowError = ''
  }

  isCaptureProtected(win = null) {
    return Boolean(this.captureProtected || (win && win.sharing === 0))
  }

  async hasCaptureProtectedWindow(targets = []) {
    const windows = await this.listWindows()
    const relevant = targets.length
      ? windows.filter((win) => targets.some(({ name }) => chatName(win.title) === chatName(name))
        || /^(微信|WeChat|Weixin)$/i.test(String(win.title || '').trim()))
      : windows
    return relevant.some((win) => win.sharing === 0)
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
    const ok = await this.compileHelper(this.winBinPath, WINDOW_LIST_SOURCE, 'window-list-v3')
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
    const raw = String(await this.runHelper(this.winBinPath, 'window-list-v3', [alias])).trim()
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
        sharing: Number(win.sharing ?? 1),
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

  async isRunning() {
    try {
      await run('/usr/bin/pgrep', ['-x', 'WeChat'], { timeout: 2000 })
      return true
    } catch (error) {
      return error.code === 1 ? false : null
    }
  }

  matchingWindows(windows, name) {
    return windows.filter((window) => this.layoutOf(window).detached
      && chatName(window.title) === chatName(name))
  }

  atLeft(window, display) {
    return Boolean(window?.onscreen && display
      && Math.abs(window.x - display.x) <= 24
      && window.x + window.width / 2 <= display.x + display.width / 2)
  }

  async targetReadiness(targets) {
    const windows = await this.listWindows()
    const display = mainDisplayBounds()
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
    return windows.find((window) => !this.layoutOf(window).detached && /^(微信|WeChat|Weixin)$/i.test(window.title.trim())) ?? null
  }

  async prepareWindow() {
    const opened = await this.openChatWindow(this.expectedGroup)
    if (!opened.ok) return opened
    const display = mainDisplayBounds()
    let window = await this.getChatWindow({ detachedOnly: true })
    if (window && !this.atLeft(window, display)) {
      await this.tileWindow(window.title, 'left')
      window = await this.getChatWindow({ detachedOnly: true })
    }
    if (window && display && !this.atLeft(window, display)) {
      // A second tiled chat may be assigned its own slot. Move it to the same
      // left-hand area so all configured chats can be raised independently.
      const width = Math.min(window.width, Math.floor(display.width / 2))
      await this.moveWindow(window.title, { x: display.x + 8, y: Math.max(display.y + 32, window.y), width })
      window = await this.getChatWindow({ detachedOnly: true })
    }
    return this.atLeft(window, display)
      ? { ok: true, id: window.id } : { ok: false, reason: '独立窗口已打开，尚未定位到屏幕左侧' }
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
  async setClipboardImage(path) {
    const escaped = String(path).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    await run('osascript', ['-e', `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`])
  }

  async sendImage(path, { beforeSubmit } = {}) {
    this.assertSupported()
    if (!this.expectedGroup) throw new Error('Refusing to send: no expectedGroup configured.')
    if (!path || !existsSync(path)) throw new Error(`图片不存在：${path}`)
    const target = await this.prepareSend()

    await this.setClipboardImage(path)
    // The input box only accepts the paste when it has focus, and focus can be
    // stolen between the target check and the keystroke. Click it and verify the
    // paste actually changed the box, retrying once before giving up.
    let pasted = false
    for (let attempt = 1; attempt <= 2 && !pasted; attempt += 1) {
      await this.assertFrontChat(target)
      await this.clickComposer(target)
      await sleep(250)
      // Start from an empty input so "before" cannot already contain an image
      // left over from an earlier attempt.
      await this.assertFrontChat(target)
      await this.clearComposer(target)
      await sleep(150)
      const before = await this.composerSignature(target)
      await this.assertFrontChat(target)
      await this.pasteIntoComposer(target)
      await sleep(900)
      const after = await this.composerSignature(target)
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
      await this.assertFrontChat(target)
      await this.clearComposer(target)
      throw new Error('Send aborted: the paste did not put an image in the input box.')
    }
    await beforeSubmit?.()
    await this.assertFrontChat(target)
    await this.pressReturn(target)
    await sleep(400)
    return { sent: path, kind: 'image' }
  }

  async collectStickers() {
    this.assertSupported()
    return new NativeStickerPicker(this).collect()
  }

  async sendSticker(sticker, options) {
    this.assertSupported()
    return new NativeStickerPicker(this).send(sticker, options)
  }

  /** Click the composer at a Gaussian-jittered point so keystrokes land naturally. */
  async clickComposer(target = null) {
    target ??= await this.getChatWindow()
    if (!target) return
    const layout = this.layoutOf(target)
    const { x, y } = this.antiDetection.curvedMouse
      ? jitterComposerPoint(layout, target.height, target.y)
      : { x: layout.x + Math.round(layout.w * 0.5), y: target.y + Math.round(target.height * 0.9) }
    await this.helperClick(x, y)
  }

  /** A cheap fingerprint of the composer area (mean luminance). */
  async composerSignature(target = null) {
    target ??= await this.getChatWindow()
    if (!target || this.isCaptureProtected(target)) return null
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

  /** Glide along a human Bézier curve from the current cursor and click with clickState=1. */
  async helperClick(x, y) {
    const bin = join(tmpdir(), 'dsh-wechatbot-click-v2')
    if (!existsSync(bin)) {
      const src = join(tmpdir(), 'dsh-wechatbot-click-v2.swift')
      writeFileSync(src, `
import Cocoa
let a = CommandLine.arguments
let tx = Double(a[1])!, ty = Double(a[2])!
let src = CGEventSource(stateID: .hidSystemState)
let p0 = CGEvent(source: nil)?.location ?? CGPoint(x: tx, y: ty)
let dx = tx - Double(p0.x), dy = ty - Double(p0.y)
let dist = hypot(dx, dy)
if dist >= 4 {
    let steps = max(6, min(20, Int(dist / 34.0)))
    let nx = -dy / dist, ny = dx / dist
    let arc = Double.random(in: -0.15...0.15) * dist
    let c1x = Double(p0.x) + dx * 0.30 + nx * arc, c1y = Double(p0.y) + dy * 0.30 + ny * arc
    let c2x = Double(p0.x) + dx * 0.72 + nx * arc * 0.5, c2y = Double(p0.y) + dy * 0.72 + ny * arc * 0.5
    for i in 1...steps {
        let u = Double(i) / Double(steps)
        let t = u * u * u * (10.0 + u * (-15.0 + 6.0 * u))
        let mt = 1.0 - t
        let px = mt*mt*mt*Double(p0.x) + 3*mt*mt*t*c1x + 3*mt*t*t*c2x + t*t*t*tx
        let py = mt*mt*mt*Double(p0.y) + 3*mt*mt*t*c1y + 3*mt*t*t*c2y + t*t*t*ty
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: px, y: py), mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(UInt32.random(in: 7_000...16_000))
    }
}
let p = CGPoint(x: tx, y: ty)
usleep(UInt32.random(in: 45_000...95_000))
if let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left),
   let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left) {
    down.setIntegerValueField(.mouseEventClickState, value: 1)
    up.setIntegerValueField(.mouseEventClickState, value: 1)
    down.post(tap: .cghidEventTap)
    usleep(UInt32.random(in: 58_000...130_000))
    up.post(tap: .cghidEventTap)
}
`, 'utf8')
      try {
        await run('swiftc', ['-O', src, '-o', bin], { timeout: 120_000 })
      } catch {
        return
      }
    }
    await run(bin, [String(x), String(y)]).catch(() => {})
  }

  /** Type plain text in IME-like phrase chunks via Quartz Unicode key events. */
  async typeIntoComposer(text, target) {
    await this.compileHelper(this.typeBinPath, HUMAN_TYPE_SOURCE, TYPE_HELPER)
    const chunks = splitTypingChunks(text)
    const args = [
      String(target.id),
      String(target.x),
      String(target.y),
      String(target.title || '').trim(),
      this.appName,
    ]
    const cmd = existsSync(this.typeBinPath) ? this.typeBinPath : 'swift'
    const fullArgs = existsSync(this.typeBinPath)
      ? args
      : [join(tmpdir(), `dsh-wechatbot-${TYPE_HELPER}.swift`), ...args]
    await new Promise((resolve, reject) => {
      const child = spawn(cmd, fullArgs)
      const err = []
      child.stderr.on('data', (d) => err.push(d))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(Buffer.concat(err).toString('utf8').trim() || '微信窗口焦点变化，输入已中止'))
      })
      child.stdin.end(JSON.stringify(chunks), 'utf8')
    })
  }

  /**
   * Capture the chat pane as a PNG the model can actually look at.
   *
   * OCR tells the bot that a bubble exists; only an image tells it what the
   * bubble shows — a photo, a screenshot of an error, a sticker. The capture is
   * downscaled first: a 2x window shot is ~2MB, and the model does not need that
   * resolution to read a sticker.
   */
  async captureChatImage({ maxWidth = 1000, fromMessage = null } = {}) {
    const target = await this.getChatWindow({ detachedOnly: Boolean(this.expectedGroup) })
    if (!target?.id || this.isCaptureProtected(target)) return null
    return this.withChatCapture(target, maxWidth, (path) => ({
      mediaType: 'image/png', data: readFileSync(path).toString('base64'), name: 'wechat-chat.png',
    }), fromMessage)
  }

  async screenshotStart(target, path, message) {
    const content = normalizeText(message.content)
    if (message.needsOcr || !content) return null
    const items = await this.ocrImage(path)
    const group = this.pickGroupName(target.title, items)
    const messageGroup = String(message.groupName ?? '').replace(/\s*[（(]\d+[）)]\s*$/, '')
    if (!group || normalizeText(group) !== normalizeText(messageGroup)) return null
    const matches = items.filter((item) => item.y >= 0.12 && item.y + item.h < 1
      && item.x < 0.35 && item.h >= 0.013 && !TIMESTAMP_RE.test(item.text)
      && normalizeText(item.text) === content)
    return matches.length === 1 ? matches[0].y : null
  }

  async withChatCapture(target, maxWidth, read, fromMessage = null) {
    const layout = this.layoutOf(target)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-vision-'))
    const raw = join(dir, 'window.png')
    const cropped = join(dir, 'chat.png')
    const scoped = join(dir, 'current-messages.png')
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
      const chatHeight = Math.round(height * 0.86)
      await run('sips', [
        '-c', String(chatHeight), String(chatWidth),
        '--cropOffset', '0', String(left), raw, '--out', cropped,
      ])
      let source = cropped
      if (fromMessage) {
        const beginning = await this.screenshotStart(target, cropped, fromMessage)
        if (beginning === null) return null
        const top = Math.floor(chatHeight * beginning)
        // sips can silently return the input when an offset crop touches the
        // bottom edge. Keep one pixel of margin and verify before attaching.
        const scopedHeight = chatHeight - top - 1
        await run('sips', ['-c', String(scopedHeight), String(chatWidth),
          '--cropOffset', String(top), '0', cropped, '--out', scoped])
        const { stdout: properties } = await run('sips', ['-g', 'pixelHeight', scoped])
        if (Number(properties.match(/pixelHeight:\s*(\d+)/)?.[1]) !== scopedHeight) return null
        source = scoped
      }
      const path = chatWidth > maxWidth ? resized : source
      if (path === resized) await run('sips', ['--resampleWidth', String(maxWidth), source, '--out', resized])
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
    return parseGroupOcrMessages(title, items, {
      expectedGroup: this.expectedGroup,
      whitelistGroups: this.whitelistGroups,
      atKeywords: this.atKeywords,
      ...options,
    })
  }

  parsePrivate(title, items) {
    return parsePrivateOcrMessages(title, items)
  }

  pickGroupName(title, items) {
    return selectGroupName(title, items, {
      expectedGroup: this.expectedGroup,
      whitelistGroups: this.whitelistGroups,
    })
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

  /**
   * Title of the WeChat window the window manager has in front.
   *
   * CGWindowList's optionAll answer is *not* in z-order: "the first visible
   * window" reported a background chat whenever two were open, which made the
   * send guard abort on a correctly targeted window and made openChatWindow
   * refuse to drag. AXMain is the window server's own answer.
   */
  async frontWindowTitle({ requireFrontmost = false } = {}) {
    try {
      const out = await run('osascript', ['-e', `
tell application "System Events"
    tell process ${asQuote(this.appName)}
        ${requireFrontmost ? 'if frontmost is false then return ""' : ''}
        repeat with w in windows
            try
                if (value of attribute "AXMain" of w) is true then return (name of w as string)
            end try
        end repeat
        return ""
    end tell
end tell
`])
      return String(out.stdout ?? '').trim()
    } catch {
      return ''
    }
  }

  /** Bring WeChat forward only when the target window is not already the frontmost window. */
  async activateApp(target = null) {
    try {
      if (this.antiDetection.minimalTouch && target?.title) {
        const currentFront = await this.frontWindowTitle({ requireFrontmost: true })
        if (currentFront && currentFront === String(target.title).trim()) return
      }
      await this.raiseChatWindow(target)
      await run('osascript', ['-e', `tell application "System Events" to set frontmost of process ${asQuote(this.appName)} to true`])
      await sleep(180 + Math.round(Math.random() * 90))
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

  async keystroke(script, target) {
    const guard = target ? `
        if frontmost is false then error "WeChat has lost focus"
        set matched to false
        repeat with w in windows
            try
                if (value of attribute "AXMain" of w) is true and (name of w as string) is ${asQuote(target.title.trim())} and (position of w) is {${target.x}, ${target.y}} then
                    set matched to true
                    exit repeat
                end if
            end try
        end repeat
        if matched is false or frontmost is false then error "WeChat chat has changed"
    ` : ''
    await run('osascript', ['-e', `
tell application "System Events"
    tell process ${asQuote(this.appName)}
        ${guard}
        ${script}
    end tell
end tell
`])
  }

  async pasteIntoComposer(target) {
    await this.keystroke('keystroke "v" using command down', target)
  }

  async pressReturn(target) {
    await this.keystroke('key code 36', target)
  }

  /** Clear the composer after a bad paste: select all, then delete. */
  async clearComposer(target) {
    try {
      await this.keystroke('keystroke "a" using command down', target)
      await sleep(120)
      await this.keystroke('key code 51', target)
    } catch { /* best effort: a stuck selection is still better than a wrong send */ }
  }

  /** OCR the input box so a paste can be checked before Return is pressed. */
  async readComposerText(target = null) {
    target ??= await this.getChatWindow()
    if (!target || this.isCaptureProtected(target)) return ''
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

  composerLooksWrong(composer, draft) {
    return isComposerWrong(composer, draft)
  }

  /** Copy only from a verified, foreground chat window. */
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
      const anchors = this.selectionAnchors(region, capture.items)
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

    await this.ensureDragBinary()
    await this.activateApp(target)
    let reason = '剪贴板没有收到新的文字'
    for (const { x1, y1, x2, y2 } of selections) {
      const frontTitle = await this.frontWindowTitle({ requireFrontmost: true })
      const current = (await this.listWindows()).find((window) => window.id === target.id)
      if (!current?.onscreen || !frontTitle || frontTitle !== String(target.title || '').trim()
          || current.x !== target.x || current.y !== target.y
          || current.width !== target.width || current.height !== target.height) {
        throw new Error('微信聊天窗口已移动或未置于前面，已取消拖选')
      }
      if (!detached) {
        if (this.isCaptureProtected(current)) {
          throw new Error('防截屏模式下无法确认主窗口聊天标题，请打开独立聊天窗口')
        }
        const { title } = await this.readGroupTitleOf(current)
        const name = String(title).replace(/\s*[（(]\d+[）)]\s*$/, '')
        if (!group || normalizeText(name) !== normalizeText(group)
          || frontTitle !== await this.frontWindowTitle({ requireFrontmost: true })) {
          throw new Error('无法确认主窗口中的目标聊天，已取消拖选')
        }
      }
      const raw = await this.runHelper(this.dragBinPath, DRAG_HELPER, [x1, y1, x2, y2].map(String).concat('copy'))
      const parsed = parseClipboardTranscript(raw)
      if (parsed.parsed) {
        if (!boundaryLines.length) return parsed.messages
        const content = parsed.messages.flatMap((message) => [message.content, ...message.content.split('\n')])
          .map(normalizeText)
        if (boundaryLines.every((line) => content.some((body) => body === line
          || (line.length >= 4 && body.includes(line))))) return parsed.messages
        reason = '复制结果缺少可见消息的开头或末尾'
      } else if (raw.trim()) reason = '复制内容没有可识别的微信聊天记录格式'
    }
    throw new Error(reason)
  }

  selectionAnchors(region, items) {
    return computeSelectionAnchors(region, items)
  }

  /**
   * Read the group title from the window header.
   *
   * The chat-region crop starts after the session sidebar, but WeChat draws the
   * conversation title across the full window width. Cropping that way cut the
   * leading characters ("项目开发讨论…" became "开发讨论…"), which then failed the
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
    if (!target || this.isCaptureProtected(target)) return []
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
    const target = win ?? (await this.mainWindow())
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
    const matches = this.matchingWindows(await this.listWindows(), name)
    if (matches.length > 1) return { ok: false, reason: '有多个同名的独立聊天窗口' }
    const [existing] = matches
    if (existing) {
      await this.activateApp(existing)
      return { ok: true, title: existing.title, window: existing, alreadyOpen: true }
    }
    if (!this.dragBinPath || !existsSync(this.dragBinPath)) {
      await this.ensureDragBinary()
    }
    const main = await this.mainWindow()
    if (!main?.id) return { ok: false, reason: '没有找到微信主窗口，请先打开微信主窗口。' }
    if (this.isCaptureProtected(main)) {
      return { ok: false, reason: `防截屏模式下无法截图识别侧边栏，请先在微信中双击打开「${name}」独立窗口，再点「准备窗口」。` }
    }
    await this.activateApp(main)
    // AXMain, not list order: optionAll lists a background chat first whenever
    // two WeChat windows are open, so reading that as "front" refused a drag
    // that would have worked.
    const frontTitle = await this.frontWindowTitle()
    if (frontTitle && frontTitle !== String(main.title || '').trim()) {
      return { ok: false, reason: '无法将微信主窗口置于前台，请打开主窗口后重试。' }
    }
    const row = await this.findSidebarRow(name, main)
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

    const current = (await this.listWindows()).find((win) => win.id === main.id)
    const stillFront = await this.frontWindowTitle()
    if (!current
        || (stillFront && stillFront !== String(main.title || '').trim())
        || current.x !== main.x || current.y !== main.y
        || current.width !== main.width || current.height !== main.height) {
      return { ok: false, reason: '微信主窗口位置或前台窗口发生变化，请重试。' }
    }
    await this.runHelper(this.dragBinPath, DRAG_HELPER, [String(row.x), String(row.y), String(targetX), String(targetY), 'drag'])
    await sleep(700)

    const windows = await this.listWindows()
    const opened = windows.find((w) => this.layoutOf(w).detached
      && String(w.title || '').replace(/\s*[（(]\d+[）)]\s*$/, '').trim() === name.trim())
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
   * Make the configured chat the window the bot can read and type into.
   *
   * A wake can arrive while any chat is open, and WeChat never switches chats by
   * itself: the send path then aborts — correctly, rather than typing into the
   * wrong person — and the reply is lost, leaving the bot mute until a person
   * opens the chat by hand. The wake path calls this first so the bot heals
   * itself: an existing detached window is raised, otherwise one is torn out of
   * the sidebar and placed.
   *
   * @returns {Promise<{ok: boolean, opened?: boolean, alreadyFront?: boolean, raised?: boolean, reason?: string}>}
   */
  async ensureTargetWindow({ allowOpen = true, requireDetached = false } = {}) {
    const target = String(this.expectedGroup || '').trim()
    if (!target) return { ok: false, reason: 'No target chat configured.' }

    if (requireDetached) {
      const window = await this.getChatWindow({ detachedOnly: true })
      if (window?.onscreen) return { ok: true, windowId: window.id }
      return allowOpen ? this.openChatWindow(target) : { ok: false, reason: '请先打开目标独立窗口' }
    }
    const check = await this.verifyTargetGroup()
    if (check.ok) {
      if (!check.windowId) return { ok: true, alreadyFront: true }
      const windows = await this.listWindows()
      const frontTitle = await this.frontWindowTitle()
      if (frontTitle && normalizeText(frontTitle) === normalizeText(check.detected || target)) {
        return { ok: true, alreadyFront: true }
      }
      // The right chat is open but buried behind another window: raising it is
      // enough and costs less than tearing out or dragging anything.
      const win = windows.find((candidate) => candidate.id === check.windowId)
      if (win) {
        await this.activateApp(win)
        const raised = await this.verifyTargetGroup()
        if (raised.ok) return { ok: true, raised: true, alreadyFront: false }
      }
    }

    if (!allowOpen) return check

    const opened = await this.openChatWindow(target)
    if (!opened.ok) return { ok: false, reason: opened.reason || 'Could not open the target chat window.' }
    if (opened.window) await this.activateApp(opened.window)
    // The window appears before its title settles, so give the read a few tries
    // instead of calling a freshly opened chat "not the target".
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await this.verifyTargetGroup()
      if (again.ok) return { ok: true, opened: !opened.alreadyOpen, windowId: again.windowId }
      await sleep(250)
    }
    return { ok: false, reason: `Opened "${target}" but the front chat still does not match.` }
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
  nextBubblePause(previousText, nextText = '') {
    const mode = this.antiDetection.phraseTyping ? 'human' : 'paste'
    return interBubblePauseSeconds(previousText, nextText, {
      typed: shouldTypeViaKeyboard(nextText, mode),
    })
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
    const win = await this.getChatWindow({ detachedOnly: Boolean(this.expectedGroup) })
    if (!win?.id) return { source: 'unavailable', group: '', messages: [], copyIssue: '未找到微信聊天窗口' }
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
          ? '防截屏模式下私聊不支持截图 OCR，仅通过系统通知接收新消息'
          : '防截屏模式下已跳过截图 OCR，请开启拖选复制并使用独立聊天窗口',
      }
    }

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
    if (this.isCaptureProtected(win)) {
      return { ok: false, reason: '防截屏模式下无法截图核对主窗口标题，请将目标聊天打开为独立窗口。' }
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

    // A narrow window truncates the title in the header ("技术交流与项目开发讨论"
    // for a longer name). Accept a shortened reading when it still agrees
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
      const pasted = await this.readClipboardText()
      if (pasted !== clean) {
        await this.setClipboard(clean)
        if ((await this.readClipboardText()) !== clean) {
          throw new Error('Send aborted: the clipboard changed before pasting, so the draft would not be what gets sent.')
        }
      }
      await this.assertFrontChat(window)
      await this.pasteIntoComposer(window)
      await sleep(this.delayMax > 0 ? 190 + Math.round(Math.random() * 180) : 40)

      const composer = await this.readComposerText(window)
      if (composer && this.composerLooksWrong(composer, clean)) {
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
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export { fingerprint, parseClipboardTranscript }


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

