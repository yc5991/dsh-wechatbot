import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Persisted aggregate counters. Recent message content stays in memory. */
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
    const empty = { date: this.today(), submitted: 0, received: 0, failed: 0 }
    try {
      if (!existsSync(this.statePath)) return empty
      const data = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (data.date !== this.today()) return empty
      return { ...empty, received: data.received || 0, failed: data.failed || 0,
        submitted: data.submitted ?? ((data.proactive || 0) + (data.at || 0)) }
    } catch {
      return empty
    }
  }

  rollover() {
    if (this.state.date !== this.today()) {
      this.state = { date: this.today(), submitted: 0, received: 0, failed: 0 }
      this.save()
    }
  }

  save() {
    const temporary = `${this.statePath}.${process.pid}.tmp`
    try {
      mkdirSync(join(this.statePath, '..'), { recursive: true })
      writeFileSync(temporary, JSON.stringify({ ...this.state, limit: this.dailyLimit }, null, 2), { mode: 0o600 })
      renameSync(temporary, this.statePath)
    } catch {
      /* best-effort persistence */
    } finally {
      try { rmSync(temporary, { force: true }) } catch { /* cleanup may be unavailable */ }
    }
  }

  refresh() {
    this.rollover()
    const stored = this.load()
    for (const key of ['submitted', 'received', 'failed']) this.state[key] = Math.max(this.state[key], stored[key])
  }

  get remaining() {
    this.refresh()
    return this.dailyLimit <= 0 ? null : Math.max(0, this.dailyLimit - this.state.submitted)
  }

  canSpeak() {
    this.refresh()
    return this.dailyLimit <= 0 || this.state.submitted < this.dailyLimit
  }

  record(kind = 'submitted', count = 1) {
    this.refresh()
    this.state[kind] += count
    this.save()
  }

  totals() {
    this.refresh()
    return { ...this.state }
  }
}

export const stateDir = () => join(homedir(), '.dsh', 'dsh-wechatbot')
