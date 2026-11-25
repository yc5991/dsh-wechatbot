import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
