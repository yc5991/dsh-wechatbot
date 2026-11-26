/**
 * Platform-neutral WeChat transcript, OCR layout, and selection helpers.
 *
 * WeChat 4.x on macOS and Windows shares the same Qt/mmui message column layout
 * and copy-to-clipboard transcript format. Keeping these parsers in one place
 * lets both platform clients reuse identical heuristics and capture-free fallbacks.
 */

import { createHash } from 'node:crypto'

export const TIMESTAMP_RE =
  /^(?:昨天|前天|今天|星期[一二三四五六日天])?\s*\d{1,2}:\d{2}$|^\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}$|^\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?.*$/

/**
 * Loose timestamp test for OCR leftovers such as `）：46` or `+：39`, which are
 * a session-list clock glyph fused with a prefix.
 */
export const TIMESTAMP_LOOSE_RE = /^[\s）)+：:]*\d{1,2}[：:]\d{2}\s*$/

export function normalizeText(text) {
  return String(text || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

export function fingerprint(group, sender, content) {
  return createHash('md5').update(`${group}::${sender}::${content}`).digest('hex')
}

export function pickGroupName(title, items, { expectedGroup = '', whitelistGroups = [] } = {}) {
  const headerLines = (items || []).filter((i) => Number(i.y ?? 1) < 0.12).map((i) => String(i.text || ''))
  const candidates = [title, ...headerLines].filter(Boolean)
  for (const name of [expectedGroup, ...whitelistGroups].filter(Boolean)) {
    if (candidates.some((candidate) => candidate.includes(name))) return name
  }
  const header = headerLines.find((line) => !/^\d+$/.test(line) && line.length <= 40)
  return header || title || ''
}

/**
 * Turn OCR lines from a group chat capture into structured messages.
 */
export function parseGroupOcrMessages(title, items, options = {}) {
  const {
    expectedGroup = '',
    whitelistGroups = [],
    atKeywords = ['@豆包', '豆包'],
    minGlyphHeight = 0.014,
    senderColMin = 0.125,
    senderColMax = 0.155,
  } = options

  const group = pickGroupName(title, items, { expectedGroup, whitelistGroups })
  const isImageText = (item) => Number(item.h ?? 1) < minGlyphHeight

  const body = (items || [])
    .filter((item) => {
      const y = Number(item.y ?? 0)
      const x = Number(item.x ?? 0)
      return y >= 0.10 && x < 0.30 && !isImageText(item)
    })
    .slice()
    .sort((a, b) => {
      const dy = Number(a.y ?? 0) - Number(b.y ?? 0)
      if (Math.abs(dy) > 1e-4) return dy
      return Number(a.x ?? 0) - Number(b.x ?? 0)
    })

  const imageLines = (items || [])
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

  const flush = () => {
    const content = buffer.join(' ').trim()
    buffer = []
    if (!content) return
    messages.push({
      groupName: group,
      sender,
      content,
      isAtMe: atKeywords.some((kw) => content.toLowerCase().includes(String(kw).toLowerCase())),
      fingerprint: fingerprint(group, sender, content),
    })
  }

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
    buffer.push(line.replace(/\s*[）)\]+：]{0,3}\d{1,2}[：:]\d{2}\s*$/, '').trim())
  }
  flush()

  return { group, messages, hasSender, imageLines, skippedImageLines: imageLines.length }
}

/**
 * Parse a one-to-one chat from OCR lines.
 */
export function parsePrivateOcrMessages(title, items) {
  const lines = (items || [])
    .filter((item) => {
      const y = Number(item.y ?? 0)
      const text = String(item.text || '').trim()
      if (y < 0.12 || !text) return false
      if (TIMESTAMP_RE.test(text) || TIMESTAMP_LOOSE_RE.test(text)) return false
      if (/^(微信电脑版|昨天|今天|前天|星期[一二三四五六日天])/.test(text)) return false
      if (/^\d+(\.\d+)?\s*[KM]$/i.test(text)) return false
      if (/\.(md|zip|png|jpe?g|gif|pdf|dat|mp4)$/i.test(text)) return false
      if (/^(MD|ZIP|PDF)$/i.test(text)) return false
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

/**
 * OCR text boxes for the ends of a drag-copy selection, in screen coordinates.
 */
export function selectionAnchors(region, items) {
  const rows = (items || []).filter((item) => {
    const text = String(item.text || '').trim()
    if (!text) return false
    const y = Number(item.y ?? 0)
    const h = Number(item.h ?? 0)
    const x = Number(item.x ?? 0)
    const w = Number(item.w ?? 0)
    if (y * region.h < Math.max(42, region.h * 0.10) || y + h >= 1) return false
    if (h < 0.013 || h > 0.06 || x <= 0 || w <= 0 || x + w >= 1) return false
    if (!normalizeText(text)) return false
    if (TIMESTAMP_RE.test(text) || TIMESTAMP_LOOSE_RE.test(text)) return false
    if (/^以下为新消息$|撤回了一条消息$|加入了群聊$|退出了群聊$/.test(text)) return false
    return true
  })
  const isCardText = (text) => /https?:\/\/|^[[【(（]?文件|微信电脑版|\.(md|zip|png|jpe?g|gif|pdf|dat)\b|^\d+(\.\d+)?\s*[KM]$/i.test(String(text || ''))
  const cardBands = rows.filter((row) => isCardText(row.text)).map((row) => Number(row.y))
  const plain = rows.filter((row) => {
    if (isCardText(row.text)) return false
    return !cardBands.some((y) => Math.abs(y - Number(row.y)) < 0.045)
  })
    .sort((a, b) => a.y - b.y)
  return plain.filter((row, index) => {
    const next = plain[index + 1]
    return !(next && row.x >= 0.125 && row.x <= 0.155
      && next.x > row.x && next.x - row.x < 0.055 && next.y - row.y < 0.045)
  }).map((row) => ({
    text: normalizeText(row.text),
    left: region.x + Math.round(row.x * region.w),
    right: region.x + Math.round((row.x + row.w) * region.w),
    middle: region.y + Math.round((row.y + row.h / 2) * region.h),
    bottom: region.y + Math.round((row.y + row.h) * region.h),
  }))
}

/**
 * Geometry-only drag-select rectangles inside the message column when screen
 * capture is disabled or blocked by OS window sharing protection.
 */
export function fallbackDragSelections(region) {
  const minTop = region.y + Math.max(48, Math.round(region.h * 0.14))
  const maxBottom = region.y + Math.max(minTop + 32 - region.y, Math.min(region.h - 6, Math.round(region.h * 0.90)))
  const altTop = region.y + Math.max(56, Math.round(region.h * 0.20))
  const altBottom = region.y + Math.max(altTop + 28 - region.y, Math.min(region.h - 10, Math.round(region.h * 0.85)))
  return [
    {
      x1: region.x + Math.round(region.w * 0.18),
      y1: minTop,
      x2: region.x + Math.round(region.w * 0.82),
      y2: maxBottom,
    },
    {
      x1: region.x + Math.round(region.w * 0.22),
      y1: altTop,
      x2: region.x + Math.round(region.w * 0.78),
      y2: altBottom,
    },
  ].filter(({ x1, y1, x2, y2 }) =>
    x1 > region.x && x2 < region.x + region.w
    && y1 >= region.y + Math.max(42, Math.round(region.h * 0.10))
    && y2 < region.y + region.h - 2
    && Math.hypot(x2 - x1, y2 - y1) >= 20,
  )
}

export function composerLooksWrong(composer, draft) {
  const text = String(composer || '')
  if (/\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?/.test(text)) return true
  if (/在群聊中@了你|撤回了一条消息/.test(text)) return true
  const limit = Math.max(60, String(draft).length * 2.5)
  return text.replace(/\s+/g, '').length > limit
}

/**
 * Parse WeChat's copy-to-clipboard transcript.
 *
 * Supports both two-line headers (`昵称\n2026年11月24日 14:45\n内容`) and
 * single-line headers (`昵称 2026/11/24 14:45\n内容` or `昵称 14:45\n内容`).
 */
export function parseClipboardTranscript(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return { messages: [], parsed: false, senders: [] }

  const lines = raw.split('\n')
  const standaloneDateRe =
    /^\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?\s+\d{1,2}:\d{2}(?::\d{2})?$|^(?:昨天|前天|今天)\s*\d{1,2}:\d{2}(?::\d{2})?$|^\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}(?::\d{2})?$/
  const inlineHeaderRe =
    /^(.{1,32}?)\s+(\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?\s+\d{1,2}:\d{2}(?::\d{2})?|(?:昨天|前天|今天)\s*\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}:\d{2}(?::\d{2})?)$/

  const marks = []
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (standaloneDateRe.test(trimmed)) {
      marks.push({ index: i, inlineSender: null, stampText: trimmed })
      continue
    }
    const inline = trimmed.match(inlineHeaderRe)
    if (inline && !/[。！？!?]/.test(inline[1])) {
      marks.push({ index: i, inlineSender: inline[1].trim(), stampText: inline[2].trim() })
    }
  }
  if (marks.length === 0) return { messages: [], parsed: false, senders: [] }

  const messages = []
  const senders = []
  for (let m = 0; m < marks.length; m += 1) {
    const mark = marks[m]
    const dateIdx = mark.index
    const nextMark = m + 1 < marks.length ? marks[m + 1] : null
    const nextIdx = nextMark ? nextMark.index : lines.length

    let sender = mark.inlineSender || ''
    if (!sender) {
      for (let i = dateIdx - 1; i >= 0; i -= 1) {
        const t = lines[i].trim()
        if (t) { sender = t; break }
      }
    }

    let bodyEnd = nextIdx
    for (let i = nextIdx - 1; i > dateIdx; i -= 1) {
      if (lines[i].trim()) { bodyEnd = i + 1; break }
    }
    if (nextMark && !nextMark.inlineSender) {
      for (let i = nextMark.index - 1; i > dateIdx; i -= 1) {
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
      sentAt: clipboardTimestamp(mark.stampText),
      isAtMe: false,
      hasImage: /\[(图片|动画表情|视频|文件|语音)\]/.test(content) || /\.dat\b/.test(content),
      fingerprint: fingerprint('', sender, content),
    })
  }

  return { messages, parsed: messages.length > 0, senders }
}

export function clipboardTimestamp(text) {
  const absolute = text.match(/^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::\d{2})?$/)
  const monthDay = text.match(/^(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})(?::\d{2})?$/)
  const relative = text.match(/^(昨天|前天|今天)\s*(\d{1,2}):(\d{2})(?::\d{2})?$/)
  const clockOnly = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  const date = new Date()
  if (absolute) {
    const [, year, month, day, hours, minutes] = absolute
    if (+hours > 23 || +minutes > 59) return null
    date.setFullYear(+year, +month - 1, +day)
    if (date.getMonth() !== +month - 1 || date.getDate() !== +day) return null
    date.setHours(+hours, +minutes, 0, 0)
  } else if (monthDay) {
    const [, month, day, hours, minutes] = monthDay
    if (+hours > 23 || +minutes > 59) return null
    date.setMonth(+month - 1, +day)
    if (date.getMonth() !== +month - 1 || date.getDate() !== +day) return null
    date.setHours(+hours, +minutes, 0, 0)
  } else if (relative) {
    const [, day, hours, minutes] = relative
    if (+hours > 23 || +minutes > 59) return null
    date.setDate(date.getDate() - { 今天: 0, 昨天: 1, 前天: 2 }[day])
    date.setHours(+hours, +minutes, 0, 0)
  } else if (clockOnly) {
    const [, hours, minutes] = clockOnly
    if (+hours > 23 || +minutes > 59) return null
    date.setHours(+hours, +minutes, 0, 0)
  } else {
    return null
  }
  return date.getTime()
}
