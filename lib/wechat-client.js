/**
 * Platform-neutral WeChat client interface.
 *
 * Both `wechat-macos.js` and `wechat-windows.js` implement this shape, so the
 * rest of the plugin never branches on the operating system. Anything a platform
 * cannot do yet throws with `code: 'UNSUPPORTED'` rather than lying.
 */

import { interBubblePauseSeconds, shouldTypeViaKeyboard } from './humanize.js'

export class UnsupportedError extends Error {
  constructor(what) {
    super(`${what} is not supported on this platform yet`)
    this.name = 'UnsupportedError'
    this.code = 'UNSUPPORTED'
  }
}

/**
 * @typedef {object} ChatWindow
 * @property {string} title     window title as the OS reports it
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} ChatMessage
 * @property {string} groupName
 * @property {string} sender
 * @property {string} content
 * @property {boolean} isAtMe
 * @property {string} [messageId]  stable id when the source provides one
 * @property {string} [fingerprint]
 * @property {number} [deliveredAt] epoch ms
 */

/**
 * @typedef {object} ReadResult
 * @property {'copy'|'ocr'|'uia'} source  how the text was obtained
 * @property {string} group
 * @property {ChatMessage[]} messages
 */

/**
 * @typedef {object} SendResult
 * @property {string} sent
 * @property {number} delaySeconds
 */

export class WeChatClient {
  constructor(config = {}) {
    this.config = config
  }

  /** 'macos' | 'windows' */
  static get platform() {
    throw new UnsupportedError('platform detection')
  }

  /** Human-readable app name used in messages and logs. */
  get appName() {
    throw new UnsupportedError('appName')
  }

  /** @returns {Promise<ChatWindow|null>} */
  async findWindow() {
    throw new UnsupportedError('findWindow')
  }

  /**
   * Read what is currently visible in the chat.
   * @returns {Promise<ReadResult>}
   */
  async readVisible() {
    throw new UnsupportedError('readVisible')
  }

  /**
   * Read just the group title, for target verification.
   * @returns {Promise<string>}
   */
  async readGroupTitle() {
    throw new UnsupportedError('readGroupTitle')
  }

  /**
   * Send one message and wait for the human-like pause.
   * @param {string} text
   * @param {{ verifyTarget?: boolean }} [options]
   * @returns {Promise<SendResult>}
   */
  async send(text, options) {
    throw new UnsupportedError('send')
  }

  /**
   * Confirm the chat on screen is the expected group.
   * @returns {Promise<{ ok: boolean, detected?: string, reason?: string }>}
   */
  async verifyTarget() {
    throw new UnsupportedError('verifyTarget')
  }

  /** Inter-bubble composing pause, in seconds. Shared by both platforms. */
  nextBubblePause(previousText, nextText = '') {
    const mode = this.antiDetection?.phraseTyping === false ? 'paste' : 'human'
    return interBubblePauseSeconds(previousText, nextText, {
      typed: shouldTypeViaKeyboard(nextText, mode),
    })
  }

  /** Release any long-lived resources. */
  async dispose() {}
}

/** Strip Markdown so the chat receives what a person would type. */
export function sanitizeForWeChat(text) {
  if (!text) return ''
  return String(text)
    .replace(/```[\w-]*\n?/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const WECHAT_EMOJI_RE = /\[[\u4e00-\u9fa5A-Za-z]{1,4}\]/g

/** Cap bracketed WeChat emoji; the surplus is dropped from the tail. */
export function limitWeChatEmoji(text, max = 2) {
  const found = String(text || '').match(WECHAT_EMOJI_RE)
  if (!found || found.length <= max) return String(text || '')
  const parts = String(text).split(WECHAT_EMOJI_RE)
  let budget = max
  let out = parts[0]
  for (let i = 0; i < found.length; i += 1) {
    if (budget > 0) {
      out += found[i]
      budget -= 1
    }
    out += parts[i + 1] ?? ''
  }
  return out.replace(/[ \t]+$/gm, '').trim()
}

/**
 * Pick the client for the current platform.
 *
 * Imported lazily so a broken optional platform module cannot stop the plugin
 * from loading on the other one.
 */
export async function createClient(config = {}) {
  if (process.platform === 'darwin') {
    const { MacOSWeChatClient } = await import('./wechat-macos.js')
    return new MacOSWeChatClient(config)
  }
  if (process.platform === 'win32') {
    const { WindowsWeChatClient } = await import('./wechat-windows.js')
    return new WindowsWeChatClient(config)
  }
  throw new UnsupportedError(`WeChat automation on ${process.platform}`)
}
