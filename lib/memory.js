/**
 * Long-term memory for the bot.
 *
 * Three documents make up the bot's identity, all living in the agent working
 * directory:
 *
 *   PERSONA.md  who it is
 *   AGENT.md    what it should do
 *   MEMORY.md   what it remembers   ← this module
 *
 * A conversation window is summarized when it ends, appended to MEMORY.md, and
 * the oldest entries are folded into a running digest once the file grows past
 * `maxEntries`, so memory stays bounded while the bot keeps a sense of history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HEADER = '# 记忆\n\n> 每段对话结束后自动追加。最新在上。\n'

const DIGEST_HEADER = '## 长期摘要'

export class MemoryStore {
  constructor({ dir, maxEntries = 40, digestChars = 1200 } = {}) {
    this.dir = dir
    this.path = join(dir, 'MEMORY.md')
    this.maxEntries = maxEntries
    this.digestChars = digestChars
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.path)) writeFileSync(this.path, HEADER, 'utf8')
  }

  read() {
    try {
      return readFileSync(this.path, 'utf8')
    } catch {
      return HEADER
    }
  }

  /** Preserve user-authored Markdown and separate generated memory by chat. */
  parse() {
    const text = this.read()
    const saved = text.match(/\n<!-- dsh-wechatbot:memory -->\n([\s\S]*)$/)
    const history = saved?.[1] ?? text
    const digests = {}
    const entries = []
    // Match headings first. A multiline body can include ordinary Markdown.
    const headings = [...history.matchAll(/^## (长期摘要|\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:-\d{2}:\d{2})?)(?: \[([a-f0-9]{20})\])?\r?\n/gm)]
    for (const [index, heading] of headings.entries()) {
      const [, stamp, scope = ''] = heading
      const body = history.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim()
      if (stamp === '长期摘要') digests[scope] = body
      else if (body) entries.push({ stamp, body, ...(scope ? { scope } : {}) })
    }
    const notes = (saved ? text.slice(0, saved.index) : history.slice(0, headings[0]?.index)).trim()
    return { digest: digests[''] ?? '', entries, notes, digests }
  }

  /** Append one summarized conversation window. */
  append(summary, stamp = nowStamp(), scope = '') {
    this.ensure()
    const body = String(summary || '').trim().replace(/\s*\n\s*/g, ' ')
    if (!body) return false
    const { entries, notes, digests } = this.parse()
    const match = entries.filter((entry) => (entry.scope ?? '') === scope)
    const bounded = this.bound([{ stamp, body, ...(scope ? { scope } : {}) }, ...match], digests[scope])
    digests[scope] = bounded.digest
    this.write(digests[''], [...bounded.entries, ...entries.filter((entry) => (entry.scope ?? '') !== scope)], { notes, digests })
    return true
  }

  /**
   * Fold the oldest entries into the digest once past the cap.
   *
   * A cheap local fold rather than a model call: the digest is a running record,
   * and the per-entry detail is already written to disk in the session log.
   */
  bound(entries, previous = '') {
    if (entries.length <= this.maxEntries) {
      // Nothing to fold; keep whatever digest already exists.
      return { entries, digest: previous }
    }
    const keep = entries.slice(0, this.maxEntries)
    const fold = entries.slice(this.maxEntries)
    const folded = fold.map((e) => `- ${e.stamp}: ${e.body.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
    let digest = [folded, previous].filter(Boolean).join('\n')
    if (digest.length > this.digestChars) digest = digest.slice(-this.digestChars)
    return { entries: keep, digest }
  }

  write(digest, entries, { notes = HEADER, digests = { '': digest } } = {}) {
    const parts = [notes || HEADER, '<!-- dsh-wechatbot:memory -->\n']
    for (const [scope, body] of Object.entries(digests)) {
      if (body) parts.push(`${DIGEST_HEADER}${scope ? ` [${scope}]` : ''}\n${body}\n`)
    }
    for (const e of entries) parts.push(`## ${e.stamp}${e.scope ? ` [${e.scope}]` : ''}\n${e.body}\n`)
    writeFileSync(this.path, parts.join('\n'), 'utf8')
  }

  /**
   * Text to inject into a new conversation: the digest plus the most recent
   * entries, bounded so memory never dominates the prompt.
   */
  contextForPrompt({ entries = 0, maxChars = 1500, targetId, includeLegacy = true } = {}) {
    if (entries <= 0 || maxChars <= 0) return ''
    const { digest, entries: list, notes, digests } = this.parse()
    const recent = list.filter((entry) => entry.scope ? entry.scope === targetId : includeLegacy).slice(0, entries)
    const parts = []
    const noteText = notes.replace(/^# 记忆\s*\n(?:> 每段对话结束后自动追加。[^\n]*\n?)?/, '').trim()
    if (noteText) parts.push(noteText)
    const relevantDigest = [digests[targetId], includeLegacy ? digest : ''].filter(Boolean).join('\n')
    if (relevantDigest) parts.push(`长期记忆：\n${relevantDigest}`)
    if (recent.length > 0) {
      parts.push(`最近聊过：\n${recent.map((e) => `- ${e.stamp}: ${e.body}`).join('\n')}`)
    }
    let text = parts.join('\n\n')
    if (text.length > maxChars) text = text.slice(0, maxChars) + '…'
    return text
  }

}

export function nowStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
