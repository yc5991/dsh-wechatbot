import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'
import { sameSticker } from './stickers.js'

const capture = promisify(execFile)
const helper = 'native-sticker-v3'
const binary = join(tmpdir(), `dsh-wechatbot-${helper}`)
const nativeTitle = (value) => String(value ?? '').trim().replace(/\s*[（(]\d+[）)]\s*$/, '').trim()
const screenPoint = (frame, point) => ({ x: frame.x + point.x, y: frame.y + point.y })
const maxPages = 24

function pageShift(previous, current) {
  const anchors = []
  for (const cell of previous) {
    const compatible = current.filter((other) => Math.abs(other.x - cell.x) <= 2 && sameSticker(cell, other))
    if (compatible.length === 1) anchors.push(cell.y - compatible[0].y)
  }
  let consensus = []
  for (const offset of anchors) {
    const inliers = anchors.filter((candidate) => Math.abs(candidate - offset) <= 4)
    if (inliers.length > consensus.length) consensus = inliers
  }
  const needed = Math.min(2, previous.length, current.length)
  if (!needed || consensus.length < needed || consensus.length * 2 <= anchors.length) return null
  return Math.round(consensus.reduce((sum, value) => sum + value, 0) / consensus.length)
}

export class NativeStickerPicker {
  constructor(client) {
    this.client = client
  }

  async helper(...args) {
    if (typeof this.client.runStickerHelper === 'function') {
      return this.client.runStickerHelper(...args)
    }
    return JSON.parse(await this.client.runHelper(binary, helper, args.map(String)))
  }

  async prepareHelper() {
    if (typeof this.client.prepareStickerHelper === 'function') {
      await this.client.prepareStickerHelper()
      return
    }
    await this.client.compileHelper(binary, readFileSync(new URL('./sticker-vision.swift', import.meta.url), 'utf8'), helper)
  }

  async fingerprints(items) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-fingerprints-'))
    try {
      await this.prepareHelper()
      const results = {}
      for (let start = 0; start < items.length; start += 64) {
        const files = {}
        items.slice(start, start + 64).forEach(({ id, image }, index) => {
          const file = join(dir, `${index}.png`)
          writeFileSync(file, Buffer.from(image, 'base64'), { mode: 0o600 })
          files[id] = file
        })
        const manifest = join(dir, 'batch.json')
        writeFileSync(manifest, JSON.stringify(files), { mode: 0o600 })
        Object.assign(results, await this.helper('fingerprints', manifest))
      }
      return results
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  async assertChat(target) {
    const front = await this.client.frontWindowTitle({ requireFrontmost: true })
    if (!front || front !== target.title.trim()) throw new Error('微信目标窗口不在前台，操作已取消')
    const current = (await this.client.listWindows()).find((row) => row.id === target.id)
    if (!current?.onscreen || ['x', 'y', 'width', 'height'].some((key) => current[key] !== target[key])) {
      throw new Error('微信窗口位置已变化，请重试')
    }
    const title = this.client.layoutOf(target).detached ? front : (await this.client.readGroupTitleOf(target)).title
    if (nativeTitle(title) !== nativeTitle(this.client.expectedGroup)) {
      throw new Error('无法确认当前微信聊天，操作已取消')
    }
  }

  async act(target, point, scroll) {
    const args = [target.id, target.x, target.y, target.width, target.height, point.x, point.y, target.title.trim()]
    const result = scroll === undefined
      ? await this.helper('click', ...args) : await this.helper('scroll', ...args, scroll)
    if (!result.acted) throw new Error('微信窗口失去焦点或表情面板超出窗口，请重试')
  }

  async open(dir) {
    await this.prepareHelper()
    const target = await this.client.prepareSend()
    if (this.client.isCaptureProtected?.(target)) {
      throw new Error('防截屏模式下无法抓取微信表情面板画面；请使用本地图片工具 wechat_send_image 或先关闭防截屏模式')
    }
    await this.assertChat(target)

    const windowImage = join(dir, 'window.png')
    const grabbed = await this.captureWindow(target, windowImage)
    const detached = this.client.layoutOf(target).detached
    const left = detached ? 15 : 65
    const right = detached ? 54 : Math.round(target.width * 0.60)
    const button = await this.helper('toolbar', windowImage, target.width, target.height,
      left, right, target.height - 74, target.height - 13)
    if (!button.found) {
      // The last resort grab takes whatever is on screen at the window's frame.
      // When WeChat sits on another desktop or Space that is the wallpaper, and
      // "button not found" would blame the wrong thing.
      throw new Error(grabbed.viaRegion
        ? '截不到微信聊天窗口：它可能被微信设成不可截屏（防截屏），或在其他桌面/被最小化。请确认微信窗口可被截图后重试'
        : '未识别到微信输入框的表情按钮，请确认聊天窗口完整可见')
    }
    const toolbar = screenPoint(target, button)
    const x = Math.max(target.x, toolbar.x - 32)
    const y = Math.max(target.y, toolbar.y - 500)
    const frame = { x, y, width: Math.min(490, target.x + target.width - x), height: toolbar.y - y - 9 }
    if (frame.width < 466 || frame.height < 455) throw new Error('微信表情面板显示空间不足，请放大聊天窗口')
    const picker = { target, toolbar, frame, path: join(dir, 'picker.png') }
    const heartX = toolbar.x - frame.x + 104
    const heartY = toolbar.y - frame.y - 41
    const findFavorites = async () => {
      await this.snapshot(picker)
      return this.helper('favorites', picker.path, frame.width, frame.height, heartX - 21, heartX + 21, heartY - 25, heartY + 20)
    }
    let heart = await findFavorites()
    if (!heart.found) {
      await this.act(target, toolbar)
      await pause(270)
      heart = await findFavorites()
    }
    if (!heart.found) throw new Error('未识别到微信表情面板的收藏标签，请将窗口放大后重试')
    picker.heart = heart
    await this.act(target, screenPoint(frame, heart))
    await pause(180)
    await this.scroll(picker, 4800)
    return picker
  }

  /**
   * Screenshot one WeChat window for OCR.
   *
   * `screencapture -l` needs a window id that still exists: WeChat recreates its
   * window on some actions, and the id taken at prepareSend time then fails with
   * "could not create image from window". Re-list first, and fall back to a
   * region grab, which needs coordinates rather than a live window id.
   */
  async captureWindow(target, path) {
    if (typeof this.client.captureWindowToFile === 'function') {
      return this.client.captureWindowToFile(target, path)
    }
    const windows = await this.client.listWindows()
    const live = windows.find((row) => row.id === target.id && row.onscreen)
      ?? windows.find((row) => row.onscreen && row.title && row.title.trim() === String(target.title || '').trim())
    if (live) {
      try {
        await capture('screencapture', ['-x', '-o', '-l', String(live.id), path], { timeout: 6000 })
        return { window: live, viaRegion: false }
      } catch { /* the window may have been recreated mid-call; try the region */ }
    }
    if (!windows.some((row) => row.id === target.id)) {
      throw new Error('微信聊天窗口已关闭或不可见，请重新打开聊天窗口后重试')
    }
    // Still there but nothing was captured by id: the window is on another
    // desktop/Space or was recreated mid-call. Raise it and retry the id grab.
    try {
      await this.client.activateApp(target)
      await pause(400)
      const raised = (await this.client.listWindows()).find((row) => row.id === target.id && row.onscreen)
      if (raised) {
        await capture('screencapture', ['-x', '-o', '-l', String(raised.id), path], { timeout: 6000 })
        return { window: raised, viaRegion: false }
      }
    } catch { /* the region grab below still has a chance */ }
    const rect = [target.x, target.y, target.width, target.height].join(',')
    await capture('screencapture', ['-x', '-R', rect, path], { timeout: 6000 })
    return { window: target, viaRegion: true }
  }

  async snapshot({ target, frame, path }) {
    if (await this.client.frontWindowTitle({ requireFrontmost: true }) !== target.title.trim()) {
      throw new Error('微信目标窗口不在前台，操作已取消')
    }
    if (typeof this.client.captureRectToFile === 'function') {
      await this.client.captureRectToFile(frame, path)
      return
    }
    const rect = [frame.x, frame.y, frame.width, frame.height].join(',')
    await capture('screencapture', ['-x', '-R', rect, path], { timeout: 6000 })
  }

  async scroll({ target, frame, heart }, amount) {
    await this.act(target, screenPoint(frame, { x: heart.x + 50, y: heart.y - 155 }), amount)
    await pause(230)
  }

  async eachPage(picker, visit) {
    let previous = null
    let offset = 0
    for (let page = 0; page < maxPages; page += 1) {
      await this.snapshot(picker)
      const { path, frame, heart } = picker
      const grid = await this.helper('grid', path, frame.width, frame.height, heart.x, heart.y)
      const cells = grid.cells ?? []
      if (!cells.length) return { complete: previous === null }
      if (previous) {
        const shift = pageShift(previous, cells)
        if (shift === null || shift < -4 || shift > 270) return { complete: false }
        if (Math.abs(shift) <= 4) return { complete: true }
        offset += shift
      }
      const value = await visit(picker, cells, offset)
      if (value) return { value, complete: true }
      previous = cells
      await this.scroll(picker, -152)
    }
    return { complete: false }
  }

  async collect() {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-stickers-'))
    let picker
    try {
      picker = await this.open(dir)
      const items = []
      let firstRow
      const { complete } = await this.eachPage(picker, (_picker, cells, offset) => {
        const onRowGrid = (y, reference) => Math.abs(y - reference - Math.round((y - reference) / 88) * 88) <= 9
        if (firstRow === undefined) {
          const scores = cells.map(({ y }) => ({ y, count: cells.filter((cell) => onRowGrid(cell.y, y)).length }))
          firstRow = scores.sort((a, b) => b.count - a.count)[0]?.y
        }
        for (const cell of cells) {
          const pageCell = { ...cell, y: cell.y + offset }
          // A clipped row can be detected as a new band after scrolling. Its
          // estimated center falls between the logical rows of the favorites grid.
          if (!onRowGrid(pageCell.y, firstRow)) continue
          if (!items.some((item) => (Math.abs(item.x - pageCell.x) <= 2 && Math.abs(item.y - pageCell.y) <= 12)
            || sameSticker(item, pageCell))) items.push(pageCell)
        }
      })
      return { items, complete }
    } finally {
      if (picker) await this.act(picker.target, picker.toolbar).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async send(sticker, { beforeSubmit } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-stickers-'))
    try {
      const reference = join(dir, 'reference.png')
      writeFileSync(reference, Buffer.from(sticker.image, 'base64'))
      const picker = await this.open(dir)
      const { target, frame, heart, path } = picker
      const match = () => this.helper('sticker', path, frame.width, frame.height, reference, heart.x, heart.y)
      const { value, complete } = await this.eachPage(picker, async () => {
        const marker = await match()
        return marker.found ? marker : null
      })
      if (!value) throw new Error(complete ? '未能唯一定位该收藏表情，请重新获取表情库' : '表情列表未扫描完，请从收藏中整理后重试')
      await beforeSubmit?.()
      await this.assertChat(target)
      await this.snapshot(picker)
      const confirmed = await match()
      if (!confirmed.found || confirmed.x !== value.x || confirmed.y !== value.y) {
        throw new Error('表情位置或画面发生变化，发送已取消')
      }
      // A native favorites tile sends on click. There is no keyboard send and
      // no retry after this click, since WeChat provides no delivery receipt.
      await this.act(target, screenPoint(frame, confirmed))
      return { submitted: true, id: sticker.id, kind: 'native-sticker' }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
