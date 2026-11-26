/**
 * Cross-source deduplication.
 *
 * Two sources deliver the same WeChat message: the notification store (exact id,
 * no text for mentions) and a screen read (text, no id). Without a shared
 * identity the plugin answers the same message twice — once per source — which is
 * exactly the "I already replied" follow-up a real group notices.
 *
 * The key is the message content plus its sender. Ids are used only when a source
 * offers one, because the two sources never share an id.
 */

import { createHash } from 'node:crypto'

/** Content identity that both sources can produce. */
export function contentKey(sender, content) {
  return createHash('md5')
    .update(`${String(sender || '').trim()}::${String(content || '').trim()}`)
    .digest('hex')
}

/**
 * Decide whether a message is new.
 *
 * Keys from a notification are registered alongside the content key, so a later
 * screen read of the same text is recognized. Entries expire so a chat that
 * legitimately repeats itself hours later is not swallowed forever.
 */
export class MessageDedupe {
  constructor({ ttlMs = 2 * 60 * 60 * 1000, maxEntries = 2000 } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.seen = new Map()
  }

  prune(now = Date.now()) {
    for (const [key, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(key)
    }
    if (this.seen.size > this.maxEntries) {
      const overflow = this.seen.size - this.maxEntries
      let removed = 0
      for (const key of this.seen.keys()) {
        this.seen.delete(key)
        removed += 1
        if (removed >= overflow) break
      }
    }
  }

  has(msg) {
    const scope = msg.targetId ?? ''
    return (msg.notificationId && this.seen.has(`${scope}:n:${msg.notificationId}`))
      || Boolean(String(msg.content ?? '').trim() && this.seen.has(`${scope}:${contentKey(msg.sender, msg.content)}`))
  }

  /**
   * Record a message as handled.
   * @returns {boolean} true when it was new
   */
  claim(msg) {
    this.prune()
    if (this.has(msg)) return false
    this.seed([msg])
    return true
  }

  /** Record without claiming, e.g. when seeding a baseline. */
  seed(messages) {
    const now = Date.now()
    for (const msg of messages || []) {
      const scope = msg.targetId ?? ''
      if (String(msg.content ?? '').trim()) this.seen.set(`${scope}:${contentKey(msg.sender, msg.content)}`, now)
      if (msg.notificationId) this.seen.set(`${scope}:n:${msg.notificationId}`, now)
    }
  }

  reset() {
    this.seen.clear()
  }
}

function parseClockMinutes(str) {
  const match = String(str ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hh = Number(match[1])
  const mm = Number(match[2])
  if (hh > 23 || mm > 59) return null
  return hh * 60 + mm
}

/** Check whether `nowDate` falls inside configured quietHours `{ enabled, start, end }`. */
export function isInQuietHours(nowDate = new Date(), quietHours = {}) {
  if (!quietHours || quietHours.enabled !== true) return false
  const startMin = parseClockMinutes(quietHours.start ?? '01:00')
  const endMin = parseClockMinutes(quietHours.end ?? '08:00')
  if (startMin === null || endMin === null || startMin === endMin) return false
  const cur = nowDate.getHours() * 60 + nowDate.getMinutes()
  return startMin < endMin ? (cur >= startMin && cur < endMin) : (cur >= startMin || cur < endMin)
}

/**
 * Trigger decision for one message.
 *
 * Kept separate from dedupe so the policy is testable without any I/O.
 */
export function shouldReply(msg, options = {}) {
  const {
    atKeywords = ['@豆包', '豆包'],
    jargonKeywords = [],
    proactiveProbability = 0.35,
    quietHours = null,
    nowDate = new Date(),
    adminChat = false,
    random = Math.random,
  } = options

  const content = String(msg.content || '')
  const isAt = msg.isAtMe === true
    || atKeywords.some((kw) => {
      const token = String(kw)
      const alias = token.replace(/^@/, '')
      if (token.startsWith('@') && content.includes(token)) return true
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[\\s@])${escaped}($|[\\s，。！？、,.!?])`).test(content)
    })

  if (!adminChat && quietHours?.enabled === true && isInQuietHours(nowDate, quietHours)) {
    const allowAt = quietHours.allowAt !== false
    if (!(allowAt && isAt)) {
      return { reply: false, trigger: null, reason: '免打扰时段', quotaExempt: false }
    }
  }

  // A private chat is a conversation with one person: every message from them
  // is addressed to the bot, so there is no @ to wait for.
  if (options.privateChat === true) {
    return { reply: true, trigger: 'private', reason: '私聊消息', quotaExempt: false }
  }

  if (isAt) return { reply: true, trigger: 'at', reason: '被 @', quotaExempt: true }

  const matched = jargonKeywords.filter((kw) => content.toLowerCase().includes(String(kw).toLowerCase()))
  const isQuestion = /[?？]|啥意思|是什么|怎么|求教|不懂|啥叫|为什么|如何/.test(content)
  if (matched.length > 0 && isQuestion) {
    return { reply: true, trigger: 'jargon', reason: `黑话提问：${matched.join('、')}`, quotaExempt: false }
  }
  if (matched.length > 0) {
    return { reply: true, trigger: 'topic', reason: `技术话题：${matched.join('、')}`, quotaExempt: false }
  }
  if (random() < proactiveProbability) {
    return { reply: true, trigger: 'idle', reason: '日常接话', quotaExempt: false }
  }
  return { reply: false, trigger: null, reason: '', quotaExempt: false }
}
