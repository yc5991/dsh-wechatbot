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

  /** Parse into digest and dated entries, newest first. */
  parse() {
    const text = this.read()
    const digestMatch = text.match(/## 长期摘要\n([\s\S]*?)(?=\n## |\n?$)/)
    const digest = digestMatch ? digestMatch[1].trim() : ''
    const entries = []
    const re = /## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:-\d{2}:\d{2})?)\n([\s\S]*?)(?=\n## |$)/g
    let m
    while ((m = re.exec(text)) !== null) {
      const body = m[2].trim()
      if (!body) continue
      entries.push({ stamp: m[1], body })
    }
    return { digest, entries }
  }

  /** Append one summarized conversation window. */
  append(summary, stamp = nowStamp()) {
    this.ensure()
    const body = String(summary || '').trim()
    if (!body) return false
    const { entries } = this.parse()
    const bounded = this.bound([{ stamp, body }, ...entries])
    this.write(bounded.digest, bounded.entries)
    return true
  }

  /**
   * Fold the oldest entries into the digest once past the cap.
   *
   * A cheap local fold rather than a model call: the digest is a running record,
   * and the per-entry detail is already written to disk in the session log.
   */
  bound(entries) {
    if (entries.length <= this.maxEntries) {
      // Nothing to fold; keep whatever digest already exists.
      return { entries, digest: this.parse().digest }
    }
    const keep = entries.slice(0, this.maxEntries)
    const fold = entries.slice(this.maxEntries)
    const previous = this.parse().digest
    const folded = fold.map((e) => `- ${e.stamp}: ${e.body.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
    let digest = [folded, previous].filter(Boolean).join('\n')
    if (digest.length > this.digestChars) digest = digest.slice(-this.digestChars)
    return { entries: keep, digest }
  }

  write(digest, entries) {
    const parts = [HEADER]
    if (digest) parts.push(`${DIGEST_HEADER}\n${digest}\n`)
    for (const e of entries) parts.push(`## ${e.stamp}\n${e.body}\n`)
    writeFileSync(this.path, parts.join('\n'), 'utf8')
  }

  /**
   * Text to inject into a new conversation: the digest plus the most recent
   * entries, bounded so memory never dominates the prompt.
   */
  contextForPrompt({ entries = 3, maxChars = 1500 } = {}) {
    const { digest, entries: list } = this.parse()
    const recent = list.slice(0, entries)
    const parts = []
    if (digest) parts.push(`长期记忆：\n${digest}`)
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
