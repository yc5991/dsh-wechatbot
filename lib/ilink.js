/**
 * Native WeChat Official ClawBot (iLink Bot API) channel client, login state machine,
 * credential store, and CDN AES-128-ECB media helpers. Zero third-party dependencies.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { composingDelaySeconds, interBubblePauseSeconds } from './humanize.js'
import { stateDir } from './quota.js'
import { qrSvgDataUrl } from './qrcode-svg.js'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const DEFAULT_BOT_TYPE = '3'
export const STALE_TOKEN_ERRCODE = -14

const CHANNEL_VERSION = '2.4.10'
const BOT_AGENT = 'dsh-wechatbot/0.5.0'
const ILINK_APP_ID = 'bot'
const ILINK_CLIENT_VERSION = ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | 10

const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const CONFIG_TIMEOUT_MS = 10_000
const LOGIN_TTL_MS = 5 * 60_000
const MAX_QR_REFRESH = 3
const PAUSE_DURATION_MS = 60 * 60_000
const CONFIG_TTL_MS = 24 * 60 * 60_000
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id'])

export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }
export const MessageType = { NONE: 0, USER: 1, BOT: 2 }
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 }
export const TypingStatus = { TYPING: 1, CANCEL: 2 }

export function normalizeAccountId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function writePrivateFile(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

function readJson(path, fallback = null) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
  } catch {
    return fallback
  }
}

/**
 * Quote uint64 identifiers before `JSON.parse` sees them so IDs never lose precision.
 */
export function parseWeixinJson(rawText) {
  const src = String(rawText ?? '')
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] !== '"') {
      out += src[i++]
      continue
    }
    const start = i++
    let escaped = false
    while (i < src.length) {
      const ch = src[i++]
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') break
    }
    const token = src.slice(start, i)
    out += token

    let cursor = i
    while (/\s/.test(src[cursor] ?? '')) cursor += 1
    if (src[cursor] !== ':') continue

    let key
    try {
      key = JSON.parse(token)
    } catch {
      continue
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue

    out += src.slice(i, cursor + 1)
    cursor += 1
    while (/\s/.test(src[cursor] ?? '')) out += src[cursor++]

    const numStart = cursor
    if (src[cursor] === '-') cursor += 1
    while (/\d/.test(src[cursor] ?? '')) cursor += 1
    if (cursor > numStart && !(cursor === numStart + 1 && src[numStart] === '-')) {
      out += `"${src.slice(numStart, cursor)}"`
      i = cursor
    } else {
      i = numStart
    }
  }
  return JSON.parse(out)
}

export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Parse Weixin `CDNMedia.aes_key` (either 16 raw bytes or 32-char ASCII hex encoded in base64).
 */
export function parseWeixinAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 || ''), 'base64')
  if (decoded.length === 16) return decoded
  const asHex = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(asHex)) {
    return Buffer.from(asHex, 'hex')
  }
  throw new Error(`无效的微信媒体 AES 密钥长度 (${decoded.length})`)
}

function sniffImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return 'image/jpeg'
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}

function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
  }
}

function randomWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

function postHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...commonHeaders(),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function endpointUrl(baseUrl, endpoint) {
  const normalized = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + '/'
  return new URL(endpoint, normalized).toString()
}

function linkAbort(timeoutMs, externalSignal) {
  const internal = timeoutMs != null && timeoutMs > 0 ? new AbortController() : null
  const timer = internal ? setTimeout(() => internal.abort(new Error('timeout')), timeoutMs) : null
  timer?.unref?.()
  let onExternal = null
  if (externalSignal) {
    if (internal) {
      if (externalSignal.aborted) internal.abort(externalSignal.reason)
      else {
        onExternal = () => internal.abort(externalSignal.reason)
        externalSignal.addEventListener('abort', onExternal, { once: true })
      }
    }
  }
  return {
    signal: internal?.signal ?? externalSignal,
    cleanup() {
      if (timer) clearTimeout(timer)
      if (externalSignal && onExternal) externalSignal.removeEventListener('abort', onExternal)
    },
  }
}

async function apiGet(fetchFn, { baseUrl, endpoint, timeoutMs, signal, label }) {
  const url = endpointUrl(baseUrl, endpoint)
  const linked = linkAbort(timeoutMs, signal)
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: commonHeaders(),
      ...(linked.signal ? { signal: linked.signal } : {}),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${label} ${res.status}: ${text.slice(0, 200)}`)
    return text
  } finally {
    linked.cleanup()
  }
}

async function apiPost(fetchFn, { baseUrl, endpoint, payload, token, timeoutMs, signal, label }) {
  const url = endpointUrl(baseUrl, endpoint)
  const linked = linkAbort(timeoutMs, signal)
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: postHeaders(token),
      body: JSON.stringify(payload),
      ...(linked.signal ? { signal: linked.signal } : {}),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${label} ${res.status}: ${text.slice(0, 200)}`)
    return text
  } finally {
    linked.cleanup()
  }
}

function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${String(cdnBaseUrl || CDN_BASE_URL).replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

function buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
  return `${String(cdnBaseUrl || CDN_BASE_URL).replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

// ---------------------------------------------------------------------------
// Credential & state store
// ---------------------------------------------------------------------------

export class IlinkStore {
  constructor(rootDir = stateDir()) {
    this.dir = join(rootDir, 'ilink')
    this.accountsDir = join(this.dir, 'accounts')
    this.indexPath = join(this.dir, 'accounts.json')
    this.onAccountSaved = null
  }

  ensureDirs() {
    mkdirSync(this.accountsDir, { recursive: true })
  }

  listAccounts() {
    const parsed = readJson(this.indexPath, [])
    return Array.isArray(parsed) ? parsed : []
  }

  getAccount(accountId) {
    const normalized = normalizeAccountId(accountId)
    return this.listAccounts().find((row) => row.accountId === normalized) ?? null
  }

  latestTokens(limit = 10) {
    return this.listAccounts()
      .map((row) => row.token?.trim())
      .filter(Boolean)
      .slice(-limit)
      .reverse()
  }

  saveAccount({ rawBotId, accountId, token, baseUrl, cdnBaseUrl, userId }) {
    this.ensureDirs()
    const id = normalizeAccountId(accountId || rawBotId)
    if (!id) throw new Error('无效的账号 ID')
    let rows = this.listAccounts()
    const trimmedUser = String(userId || '').trim()
    if (trimmedUser) {
      for (const stale of rows) {
        if (stale.accountId !== id && stale.userId === trimmedUser) {
          this.removeAccountFiles(stale.accountId)
        }
      }
      rows = rows.filter((row) => row.accountId === id || row.userId !== trimmedUser)
    }
    const existing = rows.find((row) => row.accountId === id) ?? {}
    const entry = {
      accountId: id,
      rawBotId: rawBotId || existing.rawBotId || id,
      token: token?.trim() || existing.token || '',
      baseUrl: baseUrl?.trim() || existing.baseUrl || DEFAULT_BASE_URL,
      cdnBaseUrl: cdnBaseUrl?.trim() || existing.cdnBaseUrl || CDN_BASE_URL,
      userId: trimmedUser || existing.userId || '',
      savedAt: new Date().toISOString(),
    }
    rows = [...rows.filter((row) => row.accountId !== id), entry]
    writePrivateFile(this.indexPath, JSON.stringify(rows, null, 2))
    this.onAccountSaved?.(entry)
    return entry
  }

  removeAccountFiles(accountId) {
    for (const suffix of ['.sync.json', '.context.json']) {
      try {
        unlinkSync(join(this.accountsDir, `${accountId}${suffix}`))
      } catch { /* ignore */ }
    }
  }

  syncPath(accountId) {
    return join(this.accountsDir, `${accountId}.sync.json`)
  }

  getSyncBuf(accountId) {
    const data = readJson(this.syncPath(accountId), null)
    return typeof data?.get_updates_buf === 'string' ? data.get_updates_buf : ''
  }

  saveSyncBuf(accountId, buf) {
    this.ensureDirs()
    writePrivateFile(this.syncPath(accountId), JSON.stringify({ get_updates_buf: String(buf || '') }))
  }

  contextPath(accountId) {
    return join(this.accountsDir, `${accountId}.context.json`)
  }

  readContextMap(accountId) {
    const data = readJson(this.contextPath(accountId), {})
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }

  getContextToken(accountId, userId) {
    const map = this.readContextMap(accountId)
    if (userId && typeof map[userId] === 'string') return map[userId]
    return undefined
  }

  latestContextUser(accountId) {
    const keys = Object.keys(this.readContextMap(accountId))
    return keys.length ? keys[keys.length - 1] : ''
  }

  setContextToken(accountId, userId, token) {
    if (!userId || !token) return
    this.ensureDirs()
    const map = this.readContextMap(accountId)
    map[userId] = token
    writePrivateFile(this.contextPath(accountId), JSON.stringify(map, null, 2))
  }
}

// ---------------------------------------------------------------------------
// Non-blocking QR login state machine
// ---------------------------------------------------------------------------

export class IlinkLoginManager {
  constructor({ store, fetchImpl = null, sleepImpl = null } = {}) {
    this.store = store
    this.fetchImpl = fetchImpl
    this.sleepImpl = sleepImpl
    this.sessions = new Map()
  }

  get fetchFn() {
    return this.fetchImpl || globalThis.fetch
  }

  async sleep(ms, signal) {
    if (this.sleepImpl) return this.sleepImpl(ms, signal)
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      timer.unref?.()
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  purgeExpired() {
    const now = Date.now()
    for (const [key, session] of this.sessions) {
      if (now - session.updatedAt > LOGIN_TTL_MS * 2 && session.done) {
        this.sessions.delete(key)
      }
    }
  }

  async fetchQRCode(baseUrl = DEFAULT_BASE_URL, signal) {
    const raw = await apiGet(this.fetchFn, {
      baseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`,
      timeoutMs: API_TIMEOUT_MS,
      signal,
      label: 'getBotQRCode',
    })
    const parsed = JSON.parse(raw)
    if (!parsed?.qrcode || !parsed?.qrcode_img_content) {
      throw new Error('微信接口未返回有效的二维码内容')
    }
    return parsed
  }

  async pollStatus(baseUrl, qrcode, verifyCode, signal) {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
    try {
      const raw = await apiGet(this.fetchFn, {
        baseUrl,
        endpoint,
        timeoutMs: LONG_POLL_TIMEOUT_MS,
        signal,
        label: 'getQRCodeStatus',
      })
      return JSON.parse(raw)
    } catch (error) {
      if (signal?.aborted) throw error
      if (error?.name === 'AbortError' || /timeout/i.test(String(error?.message))) {
        return { status: 'wait' }
      }
      return { status: 'wait' }
    }
  }

  async start({ accountId = '', force = false } = {}) {
    this.purgeExpired()
    const key = accountId ? `rebind:${accountId}` : ''
    if (!force && key) {
      const existing = this.sessions.get(key)
      if (existing && !existing.done && Date.now() - existing.startedAt < LOGIN_TTL_MS) {
        return this.snapshot(existing)
      }
    }
    const sessionKey = key || randomUUID()
    if (this.sessions.get(sessionKey)) {
      this.cancel({ sessionKey })
    }

    const qr = await this.fetchQRCode(DEFAULT_BASE_URL)
    const abortController = new AbortController()
    const session = {
      sessionKey,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      qrImage: qrSvgDataUrl(qr.qrcode_img_content),
      currentBaseUrl: DEFAULT_BASE_URL,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'wait',
      message: '请用手机微信扫描二维码',
      needVerifyCode: false,
      verifyError: false,
      pendingVerifyCode: '',
      verifyResolver: null,
      connected: false,
      alreadyConnected: false,
      done: false,
      error: '',
      accountId: '',
      userId: '',
      abortController,
    }
    this.sessions.set(sessionKey, session)
    void this.runLoop(session)
    return this.snapshot(session)
  }

  snapshot(session) {
    return {
      ok: true,
      sessionKey: session.sessionKey,
      status: session.status,
      qrImage: session.qrImage,
      qrcodeUrl: session.qrcodeUrl,
      needVerifyCode: session.needVerifyCode,
      verifyError: session.verifyError,
      connected: session.connected,
      alreadyConnected: session.alreadyConnected,
      done: session.done,
      accountId: session.accountId,
      userId: session.userId,
      message: session.message,
      error: session.error || undefined,
    }
  }

  status({ sessionKey } = {}) {
    const session = this.sessions.get(sessionKey)
    if (!session) throw new Error('扫码会话不存在或已结束，请重新生成二维码')
    return this.snapshot(session)
  }

  verify({ sessionKey, code } = {}) {
    const session = this.sessions.get(sessionKey)
    if (!session || session.done) throw new Error('扫码会话已结束，请重新扫码')
    const cleaned = String(code ?? '').trim()
    if (!cleaned) throw new Error('请输入手机微信显示的数字配对码')
    session.pendingVerifyCode = cleaned
    session.needVerifyCode = false
    session.verifyError = false
    session.updatedAt = Date.now()
    session.message = '正在提交配对码校验…'
    if (session.verifyResolver) {
      const resolve = session.verifyResolver
      session.verifyResolver = null
      resolve(cleaned)
    }
    return this.snapshot(session)
  }

  cancel({ sessionKey } = {}) {
    const session = this.sessions.get(sessionKey)
    if (!session) return { ok: true, cancelled: false }
    session.done = true
    session.status = 'cancelled'
    session.message = '已取消扫码'
    session.updatedAt = Date.now()
    session.abortController.abort(new Error('cancelled'))
    if (session.verifyResolver) {
      session.verifyResolver('')
      session.verifyResolver = null
    }
    return { ok: true, cancelled: true }
  }

  stopAll() {
    for (const sessionKey of this.sessions.keys()) this.cancel({ sessionKey })
  }

  async waitForVerifyCode(session) {
    return new Promise((resolve) => {
      if (session.abortController.signal.aborted || session.done) return resolve('')
      session.verifyResolver = resolve
      const onAbort = () => {
        if (session.verifyResolver === resolve) session.verifyResolver = null
        resolve('')
      }
      session.abortController.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async refreshQr(session, refreshCount, reasonMessage) {
    session.status = 'refreshing'
    session.message = `${reasonMessage}，正在刷新二维码 (${refreshCount}/${MAX_QR_REFRESH})…`
    session.updatedAt = Date.now()
    const qr = await this.fetchQRCode(DEFAULT_BASE_URL, session.abortController.signal)
    session.qrcode = qr.qrcode
    session.qrcodeUrl = qr.qrcode_img_content
    session.qrImage = qrSvgDataUrl(qr.qrcode_img_content)
    session.currentBaseUrl = DEFAULT_BASE_URL
    session.startedAt = Date.now()
    session.updatedAt = Date.now()
    session.status = 'wait'
    session.message = '二维码已刷新，请用手机微信扫描'
  }

  async runLoop(session) {
    let refreshCount = 1
    const deadline = Date.now() + 8 * 60_000
    try {
      while (!session.done && !session.abortController.signal.aborted && Date.now() < deadline) {
        const resp = await this.pollStatus(
          session.currentBaseUrl,
          session.qrcode,
          session.pendingVerifyCode || undefined,
          session.abortController.signal,
        )
        if (session.done || session.abortController.signal.aborted) return
        session.updatedAt = Date.now()
        const state = resp?.status || 'wait'

        if (state === 'wait') {
          await this.sleep(800, session.abortController.signal)
          continue
        }
        if (state === 'scaned') {
          session.pendingVerifyCode = ''
          session.needVerifyCode = false
          session.verifyError = false
          session.status = 'scaned'
          session.message = '已扫码，请在手机微信上确认授权…'
          await this.sleep(500, session.abortController.signal)
          continue
        }
        if (state === 'scaned_but_redirect') {
          if (resp.redirect_host) session.currentBaseUrl = `https://${resp.redirect_host}`
          session.status = 'scaned'
          session.message = '正在切换接入节点，请稍候…'
          continue
        }
        if (state === 'need_verifycode') {
          const hadAttempt = Boolean(session.pendingVerifyCode)
          session.pendingVerifyCode = ''
          session.status = 'need_verifycode'
          session.needVerifyCode = true
          session.verifyError = hadAttempt
          session.message = hadAttempt
            ? '输入的配对码不匹配，请重新输入手机微信上的数字'
            : '请输入手机微信上显示的配对数字'
          const nextCode = await this.waitForVerifyCode(session)
          if (!nextCode || session.done) return
          continue
        }
        if (state === 'expired' || state === 'verify_code_blocked') {
          session.pendingVerifyCode = ''
          session.needVerifyCode = false
          refreshCount += 1
          if (refreshCount > MAX_QR_REFRESH) {
            session.status = 'error'
            session.done = true
            session.error = state === 'expired' ? '二维码多次过期，请重试' : '配对码错误次数过多，请稍后再试'
            session.message = session.error
            return
          }
          await this.refreshQr(session, refreshCount, state === 'expired' ? '二维码已过期' : '配对码验证受阻')
          continue
        }
        if (state === 'binded_redirect') {
          const saved = this.store.listAccounts().at(-1)
          session.status = 'confirmed'
          session.done = true
          if (saved) {
            session.connected = true
            session.alreadyConnected = true
            session.accountId = saved.accountId
            session.userId = saved.userId
            session.message = '该微信已绑定，已沿用现有凭证'
          } else {
            session.connected = false
            session.error = '该微信号已绑定过但本地未找到凭证，请在手机上解除旧连接或稍后重试'
            session.message = session.error
          }
          return
        }
        if (state === 'confirmed') {
          if (!resp.ilink_bot_id || !resp.bot_token) {
            session.status = 'error'
            session.done = true
            session.error = '微信服务端未返回完整的绑定凭证'
            session.message = session.error
            return
          }
          const saved = this.store.saveAccount({
            rawBotId: resp.ilink_bot_id,
            token: resp.bot_token,
            baseUrl: resp.baseurl || DEFAULT_BASE_URL,
            userId: resp.ilink_user_id || '',
          })
          session.status = 'confirmed'
          session.done = true
          session.connected = true
          session.accountId = saved.accountId
          session.userId = saved.userId
          session.message = '扫码绑定成功！'
          return
        }
      }
      if (!session.done) {
        session.status = 'error'
        session.done = true
        session.error = '扫码超时，请重新获取二维码'
        session.message = session.error
      }
    } catch (error) {
      if (session.done || session.abortController.signal.aborted) return
      session.status = 'error'
      session.done = true
      session.error = error.message || '扫码轮询异常'
      session.message = session.error
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound / ChatClient adapter for an iLink clawbot target
// ---------------------------------------------------------------------------

export class IlinkChatClient {
  constructor({ bridge, chat, delayMin = 0.8, delayMax = 2.4, antiDetection = {} }) {
    this.bridge = bridge
    this.chat = chat
    this.accountId = normalizeAccountId(chat.accountId)
    this.userId = chat.userId || ''
    this.expectedGroup = chat.name
    this.delayMin = delayMin
    this.delayMax = delayMax
    this.antiDetection = antiDetection
    this.state = 'ready'
  }

  static get platform() {
    return 'ilink'
  }

  get appName() {
    return '微信官方私聊'
  }

  async isRunning() {
    return this.bridge.isAccountReady(this.accountId)
  }

  resolveAccountAndPeer() {
    const account = this.bridge.store.getAccount(this.accountId)
    if (!account?.token) throw new Error(`官方私聊账号 ${this.chat.name} 凭证缺失，请重新扫码绑定`)
    if (this.bridge.isTokenStale(this.accountId)) throw new Error('官方私聊凭证已失效，请在设置中重新扫码')
    const peerId = this.userId || this.chat.userId || account.userId || this.bridge.store.latestContextUser(this.accountId)
    if (!peerId) throw new Error('请先在手机微信向该机器人发送一条消息以激活私聊对话')
    const contextToken = this.bridge.store.getContextToken(this.accountId, peerId)
    return { account, peerId, contextToken }
  }

  nextBubblePause(previousText, nextText = '') {
    return interBubblePauseSeconds(previousText, nextText, { typed: false })
  }

  async setTyping(active, explicitUserId = '') {
    try {
      const account = this.bridge.store.getAccount(this.accountId)
      const peerId = explicitUserId || this.userId || this.chat.userId || account?.userId
      if (!account?.token || !peerId || this.bridge.isTokenStale(this.accountId)) return false
      const contextToken = this.bridge.store.getContextToken(this.accountId, peerId)
      const ticket = await this.bridge.getTypingTicket(account, peerId, contextToken)
      if (!ticket) return false
      await apiPost(this.bridge.fetchFn, {
        baseUrl: account.baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        token: account.token,
        timeoutMs: CONFIG_TIMEOUT_MS,
        label: 'sendTyping',
        payload: {
          ilink_user_id: peerId,
          typing_ticket: ticket,
          status: active ? TypingStatus.TYPING : TypingStatus.CANCEL,
          base_info: baseInfo(),
        },
      })
      return true
    } catch {
      return false
    }
  }

  async waitComposing(text) {
    if ((this.delayMax ?? 0) <= 0) return 0
    const delaySeconds = this.antiDetection?.naturalCadence === false
      ? Number((this.delayMin + Math.random() * Math.max(0, this.delayMax - this.delayMin)).toFixed(2))
      : composingDelaySeconds(text, { minSeconds: this.delayMin, maxSeconds: this.delayMax, typed: false })
    if (delaySeconds > 0) await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000))
    return delaySeconds
  }

  async send(text, { beforeSubmit } = {}) {
    const content = String(text || '').trim()
    if (!content) throw new Error('不能发送空消息')
    const { account, peerId, contextToken } = this.resolveAccountAndPeer()
    const delaySeconds = await this.waitComposing(content)
    if (beforeSubmit) await beforeSubmit()

    const clientId = `dsh-ilink-${randomUUID()}`
    const raw = await apiPost(this.bridge.fetchFn, {
      baseUrl: account.baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      token: account.token,
      timeoutMs: API_TIMEOUT_MS,
      label: 'sendMessage',
      payload: {
        msg: {
          from_user_id: '',
          to_user_id: peerId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: content } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
        base_info: baseInfo(),
      },
    })
    const resp = raw ? parseWeixinJson(raw) : {}
    if (resp?.ret && resp.ret !== 0) {
      if (resp.ret === STALE_TOKEN_ERRCODE) this.bridge.markStale(this.accountId)
      throw new Error(`发送失败 (ret=${resp.ret} ${resp.errmsg || ''})`.trim())
    }
    return { sent: content, delaySeconds, messageId: resp?.message_id || clientId }
  }

  async sendImageBuffer(plaintext, { beforeSubmit } = {}) {
    const { account, peerId, contextToken } = this.resolveAccountAndPeer()
    if (beforeSubmit) await beforeSubmit()
    const aesKey = randomBytes(16)
    const aesHex = aesKey.toString('hex')
    const filekey = randomBytes(16).toString('hex')
    const rawsize = plaintext.length
    const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
    const filesize = aesEcbPaddedSize(rawsize)

    const urlRespRaw = await apiPost(this.bridge.fetchFn, {
      baseUrl: account.baseUrl,
      endpoint: 'ilink/bot/getuploadurl',
      token: account.token,
      timeoutMs: API_TIMEOUT_MS,
      label: 'getUploadUrl',
      payload: {
        filekey,
        media_type: UploadMediaType.IMAGE,
        to_user_id: peerId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aesHex,
        base_info: baseInfo(),
      },
    })
    const urlResp = JSON.parse(urlRespRaw)
    const uploadUrl = urlResp?.upload_full_url?.trim()
      || (urlResp?.upload_param ? buildCdnUploadUrl(account.cdnBaseUrl || CDN_BASE_URL, urlResp.upload_param, filekey) : '')
    if (!uploadUrl) throw new Error('微信接口未返回图片上传地址')

    const ciphertext = encryptAesEcb(plaintext, aesKey)
    const cdnRes = await this.bridge.fetchFn(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
    })
    if (!cdnRes.ok) throw new Error(`微信 CDN 上传失败 (${cdnRes.status})`)
    const downloadParam = cdnRes.headers.get('x-encrypted-param')
    if (!downloadParam) throw new Error('微信 CDN 未返回加密下载参数')

    const clientId = `dsh-ilink-${randomUUID()}`
    const sendRaw = await apiPost(this.bridge.fetchFn, {
      baseUrl: account.baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      token: account.token,
      timeoutMs: API_TIMEOUT_MS,
      label: 'sendImageMessage',
      payload: {
        msg: {
          from_user_id: '',
          to_user_id: peerId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{
            type: MessageItemType.IMAGE,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: Buffer.from(aesHex, 'utf8').toString('base64'),
                encrypt_type: 1,
              },
              mid_size: ciphertext.length,
            },
          }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
        base_info: baseInfo(),
      },
    })
    const resp = sendRaw ? parseWeixinJson(sendRaw) : {}
    if (resp?.ret && resp.ret !== 0) {
      if (resp.ret === STALE_TOKEN_ERRCODE) this.bridge.markStale(this.accountId)
      throw new Error(`发送图片失败 (ret=${resp.ret} ${resp.errmsg || ''})`.trim())
    }
    return { messageId: resp?.message_id || clientId }
  }

  async sendSticker(sticker, options = {}) {
    if (!sticker?.image) throw new Error('无效的表情图片')
    await this.sendImageBuffer(Buffer.from(sticker.image, 'base64'), options)
    return { submitted: true, id: sticker.id }
  }

  async sendImage(filePath, options = {}) {
    const buf = readFileSync(filePath)
    await this.sendImageBuffer(buf, options)
    return { sent: basename(filePath), submitted: true }
  }

  async readVisible() {
    return { source: 'ilink', group: this.chat.name, messages: [] }
  }
}

// ---------------------------------------------------------------------------
// Long-poll bridge (runs per active iLink account in DetectorService)
// ---------------------------------------------------------------------------

export class IlinkBridge {
  constructor({ store, fetchImpl = null, sleepImpl = null, onError = null } = {}) {
    this.store = store
    this.fetchImpl = fetchImpl
    this.sleepImpl = sleepImpl
    this.onError = onError
    this.staleUntil = new Map()
    this.typingTickets = new Map()
    this.activeLoops = new Map()
    this.stopping = false

    const prevHook = this.store.onAccountSaved
    this.store.onAccountSaved = (entry) => {
      prevHook?.(entry)
      this.staleUntil.delete(entry.accountId)
    }
  }

  get fetchFn() {
    return this.fetchImpl || globalThis.fetch
  }

  markStale(accountId) {
    this.staleUntil.set(normalizeAccountId(accountId), Date.now() + PAUSE_DURATION_MS)
  }

  isTokenStale(accountId) {
    const id = normalizeAccountId(accountId)
    const until = this.staleUntil.get(id)
    if (!until) return false
    if (Date.now() >= until) {
      this.staleUntil.delete(id)
      return false
    }
    return true
  }

  isAccountReady(accountId) {
    const id = normalizeAccountId(accountId)
    const acc = this.store.getAccount(id)
    return Boolean(acc?.token && !this.isTokenStale(id))
  }

  hasContextToken(accountId, userId = '') {
    const id = normalizeAccountId(accountId)
    const acc = this.store.getAccount(id)
    const peer = userId || acc?.userId || this.store.latestContextUser(id)
    return Boolean(peer && this.store.getContextToken(id, peer))
  }

  clientFor(chat, options = {}) {
    return new IlinkChatClient({ bridge: this, chat, ...options })
  }

  async getTypingTicket(account, peerId, contextToken) {
    const key = `${account.accountId}:${peerId}`
    const cached = this.typingTickets.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.ticket
    try {
      const raw = await apiPost(this.fetchFn, {
        baseUrl: account.baseUrl,
        endpoint: 'ilink/bot/getconfig',
        token: account.token,
        timeoutMs: CONFIG_TIMEOUT_MS,
        label: 'getConfig',
        payload: {
          ilink_user_id: peerId,
          ...(contextToken ? { context_token: contextToken } : {}),
          base_info: baseInfo(),
        },
      })
      const resp = JSON.parse(raw)
      if (resp?.ret === 0 && resp.typing_ticket) {
        this.typingTickets.set(key, { ticket: resp.typing_ticket, expiresAt: Date.now() + CONFIG_TTL_MS })
        return resp.typing_ticket
      }
    } catch { /* best effort */ }
    return cached?.ticket || ''
  }

  async downloadInboundImage(imgItem, account) {
    const media = imgItem?.media
    if (!media?.encrypt_query_param && !media?.full_url) return null
    const aesBase64 = imgItem.aeskey
      ? Buffer.from(imgItem.aeskey, 'hex').toString('base64')
      : media.aes_key
    const url = media.full_url || buildCdnDownloadUrl(media.encrypt_query_param, account.cdnBaseUrl || CDN_BASE_URL)
    const res = await this.fetchFn(url)
    if (!res.ok) return null
    const encrypted = Buffer.from(await res.arrayBuffer())
    const buf = aesBase64 ? decryptAesEcb(encrypted, parseWeixinAesKey(aesBase64)) : encrypted
    return { data: buf.toString('base64'), mediaType: sniffImageMime(buf) }
  }

  async normalizeInboundMessage(msg, target, account) {
    if (!msg || msg.message_type === MessageType.BOT || !msg.from_user_id) return null
    if (target.userId && target.userId !== msg.from_user_id) return null
    if (!target.userId) target.userId = msg.from_user_id
    if (msg.context_token) this.store.setContextToken(account.accountId, msg.from_user_id, msg.context_token)

    const items = Array.isArray(msg.item_list) ? msg.item_list : []
    const parts = []
    let inboundImage = null
    let hasImage = false

    for (const item of items) {
      if (item.ref_msg) {
        const refParts = [item.ref_msg.title?.trim(), item.ref_msg.message_item?.text_item?.text?.trim()].filter(Boolean)
        if (refParts.length) parts.push(`[引用: ${refParts.join(' | ')}]`)
      }
      if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
        parts.push(String(item.text_item.text))
      } else if (item.type === MessageItemType.VOICE) {
        parts.push(item.voice_item?.text ? `[语音] ${item.voice_item.text}` : '[语音消息]')
      } else if (item.type === MessageItemType.IMAGE) {
        hasImage = true
        if (!inboundImage) {
          inboundImage = await this.downloadInboundImage(item.image_item, account).catch(() => null)
        }
        parts.push('[图片]')
      } else if (item.type === MessageItemType.VIDEO) {
        parts.push('[视频消息]')
      } else if (item.type === MessageItemType.FILE) {
        parts.push(item.file_item?.file_name ? `[文件: ${item.file_item.file_name}]` : '[文件]')
      }
    }

    const content = parts.join('\n').trim() || (hasImage ? '[图片]' : '')
    if (!content) return null
    const messageId = msg.message_id?.trim() || items.find((i) => i.msg_id?.trim())?.msg_id?.trim()
    return {
      groupName: target.name,
      targetId: target.id,
      sender: target.name,
      fromUserId: msg.from_user_id,
      content,
      isAtMe: true,
      hasImage,
      ...(inboundImage ? { inboundImage } : {}),
      ...(messageId ? { messageId } : {}),
      sentAt: Number(msg.create_time_ms) || Date.now(),
    }
  }

  async notifyLifecycle(account, endpoint) {
    try {
      await apiPost(this.fetchFn, {
        baseUrl: account.baseUrl,
        endpoint,
        token: account.token,
        timeoutMs: 3000,
        label: endpoint,
        payload: { base_info: baseInfo() },
      })
    } catch { /* best effort */ }
  }

  async sleep(ms, signal) {
    if (this.sleepImpl) return this.sleepImpl(ms, signal)
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      timer.unref?.()
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async start(targets, onMessages) {
    await this.stop()
    this.stopping = false
    const byAccount = new Map()
    for (const chat of targets || []) {
      const id = normalizeAccountId(chat.accountId)
      if (!id) continue
      const list = byAccount.get(id) || []
      list.push(chat)
      byAccount.set(id, list)
    }

    for (const [accountId, accountTargets] of byAccount) {
      const account = this.store.getAccount(accountId)
      if (!account?.token) {
        this.onError?.(`官方私聊「${accountTargets[0]?.name}」缺少登录凭证，请重新扫码`)
        continue
      }
      const abortController = new AbortController()
      const loopPromise = this.runAccountLoop({ account, accountTargets, abortController, onMessages })
      this.activeLoops.set(accountId, { account, abortController, loopPromise })
    }
  }

  async runAccountLoop({ account, accountTargets, abortController, onMessages }) {
    await this.notifyLifecycle(account, 'ilink/bot/msg/notifystart')
    let syncBuf = this.store.getSyncBuf(account.accountId)
    let pollTimeoutMs = LONG_POLL_TIMEOUT_MS
    let failures = 0

    while (!this.stopping && !abortController.signal.aborted) {
      try {
        let raw = ''
        try {
          raw = await apiPost(this.fetchFn, {
            baseUrl: account.baseUrl,
            endpoint: 'ilink/bot/getupdates',
            token: account.token,
            timeoutMs: pollTimeoutMs,
            signal: abortController.signal,
            label: 'getUpdates',
            payload: { get_updates_buf: syncBuf, base_info: baseInfo() },
          })
        } catch (err) {
          if (abortController.signal.aborted || this.stopping) return
          if (err?.name === 'AbortError' || /timeout/i.test(String(err?.message))) {
            continue
          }
          throw err
        }

        const resp = raw ? parseWeixinJson(raw) : {}
        if (resp.longpolling_timeout_ms > 0) pollTimeoutMs = resp.longpolling_timeout_ms

        const apiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)
        if (apiError) {
          if (resp.ret === STALE_TOKEN_ERRCODE || resp.errcode === STALE_TOKEN_ERRCODE) {
            this.markStale(account.accountId)
            this.onError?.('官方私聊凭证已过期 (-14)，请在面板重新扫码绑定')
            return
          }
          throw new Error(`getUpdates ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg || ''}`.trim())
        }

        failures = 0
        if (resp.get_updates_buf) {
          syncBuf = resp.get_updates_buf
          this.store.saveSyncBuf(account.accountId, syncBuf)
        }

        const normalized = []
        for (const msg of resp.msgs || []) {
          for (const target of accountTargets) {
            const entry = await this.normalizeInboundMessage(msg, target, account)
            if (entry) normalized.push(entry)
          }
        }
        if (normalized.length) await onMessages(normalized)
      } catch (error) {
        if (abortController.signal.aborted || this.stopping) return
        failures += 1
        this.onError?.(error.message)
        await this.sleep(failures >= 3 ? 15_000 : 2_000, abortController.signal)
      }
    }
  }

  async stop() {
    this.stopping = true
    const entries = [...this.activeLoops.values()]
    this.activeLoops.clear()
    for (const { abortController } of entries) abortController.abort(new Error('stopped'))
    await Promise.allSettled(entries.map(async ({ account, loopPromise }) => {
      await loopPromise
      await this.notifyLifecycle(account, 'ilink/bot/msg/notifystop')
    }))
  }
}
