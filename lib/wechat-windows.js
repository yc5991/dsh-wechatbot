/**
 * Windows WeChat client — skeleton.
 *
 * The interface mirrors `wechat-macos.js`. Nothing here has been exercised on a
 * real Windows host; `state` reports `skeleton` so the plugin can tell the user
 * rather than failing obscurely.
 *
 * Intended implementation, when someone picks this up:
 *
 *   findWindow     — FindWindow / EnumWindows by class `WeChatMainWndForPC`,
 *                    then GetWindowRect. No accessibility tree needed.
 *   readVisible    — UI Automation: walk the chat pane's list items. Each item
 *                    exposes the sender and the message text as separate text
 *                    nodes, which is more reliable than any OCR path.
 *   readGroupTitle — the title bar's static text through UIA.
 *   send           — clipboard write, then SendInput Ctrl+V followed by Enter.
 *                    Prefer WM_PASTE over synthesized keystrokes when the input
 *                    box has focus, since some IME states swallow Ctrl+V.
 *   verifyTarget   — compare the UIA title against `expectedGroup`.
 *
 * A PowerShell or C# helper added as a resource is the pragmatic way to reach
 * UIA from Node; a native addon is unnecessary.
 */

import { WeChatClient, UnsupportedError } from './wechat-client.js'

export class WindowsWeChatClient extends WeChatClient {
  static get platform() {
    return 'windows'
  }

  get appName() {
    return this._appName
  }

  /** Marks this implementation as not yet usable. */
  get state() {
    return 'skeleton'
  }

  constructor(config = {}) {
    super(config)
    this._appName = config.appName || 'WeChat'
    this.expectedGroup = config.expectedGroup || ''
    this.whitelistGroups = config.whitelistGroups || []
    this.delayMin = Number(config.replyDelayMinSeconds ?? 0.8)
    this.delayMax = Number(config.replyDelayMaxSeconds ?? 2.4)
  }

  async findWindow() {
    throw new UnsupportedError('Windows window discovery')
  }

  async readVisible() {
    throw new UnsupportedError('Windows chat reading')
  }

  async readGroupTitle() {
    throw new UnsupportedError('Windows title reading')
  }

  async verifyTarget() {
    throw new UnsupportedError('Windows target verification')
  }

  async send() {
    throw new UnsupportedError('Windows sending')
  }
}
