/**
 * Persistent reminder & greeting schedule store driven by explicit user requests.
 * Respects per-account persistence with 0o600 permissions and atomic temp renames.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './quota.js'

const SCHEDULE_VERSION = 1

function parseClock(str) {
  const m = String(str ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  return { hh, mm, label: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` }
}

function localDayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class ScheduleStore {
  constructor(rootDir = stateDir()) {
    this.dir = rootDir
    this.path = join(rootDir, 'schedules.json')
  }

  load() {
    try {
      if (!existsSync(this.path)) return []
      const data = JSON.parse(readFileSync(this.path, 'utf8'))
      return Array.isArray(data?.items) ? data.items : []
    } catch {
      return []
    }
  }

  save(items) {
    mkdirSync(this.dir, { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ version: SCHEDULE_VERSION, items }, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, this.path)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  list(targetId = '') {
    const items = this.load()
    return targetId ? items.filter((item) => item.targetId === targetId) : items
  }

  add({ targetId, accountId = '', label, kind = 'once', time = '', inMinutes = null, runAt = null, intervalHours = null }) {
    const cleanLabel = String(label ?? '').trim()
    if (!targetId || !cleanLabel) throw new Error('提醒需要 targetId 和内容说明')
    if (!['once', 'daily', 'weekdays', 'interval'].includes(kind)) throw new Error('不支持的定时类型')

    const entry = {
      id: randomUUID().slice(0, 8),
      targetId,
      accountId,
      label: cleanLabel.slice(0, 200),
      kind,
      enabled: true,
      createdAt: Date.now(),
      lastTriggeredAt: 0,
      lastDayKey: '',
    }

    if (kind === 'once') {
      const targetTs = runAt != null
        ? Number(runAt)
        : Date.now() + Math.max(1, Number(inMinutes ?? 30)) * 60_000
      if (!Number.isFinite(targetTs)) throw new Error('无效的触发时间')
      entry.runAt = targetTs
    } else if (kind === 'daily' || kind === 'weekdays') {
      const parsed = parseClock(time || '09:00')
      if (!parsed) throw new Error('时间格式需要 HH:MM，例如 09:00')
      entry.time = parsed.label
    } else if (kind === 'interval') {
      const hours = Math.max(1, Math.min(24 * 30, Number(intervalHours ?? 24)))
      entry.intervalHours = hours
      entry.nextRunAt = Date.now() + hours * 3_600_000
    }

    const items = [...this.load(), entry]
    this.save(items)
    return entry
  }

  remove(id) {
    const items = this.load()
    const next = items.filter((item) => item.id !== id)
    if (next.length === items.length) return false
    this.save(next)
    return true
  }

  dueJobs(now = Date.now()) {
    const d = new Date(now)
    const day = d.getDay()
    const curMin = d.getHours() * 60 + d.getMinutes()
    const dayKey = localDayKey(now)
    const due = []

    for (const item of this.load()) {
      if (!item.enabled) continue
      if (item.kind === 'once') {
        if (!item.lastTriggeredAt && Number(item.runAt) <= now) due.push(item)
      } else if (item.kind === 'daily' || item.kind === 'weekdays') {
        if (item.kind === 'weekdays' && (day === 0 || day === 6)) continue
        if (item.lastDayKey === dayKey) continue
        const parsed = parseClock(item.time)
        if (!parsed) continue
        const targetMin = parsed.hh * 60 + parsed.mm
        if (curMin >= targetMin && curMin - targetMin <= 15) due.push(item)
      } else if (item.kind === 'interval') {
        const nextAt = Number(item.nextRunAt ?? 0)
        if (nextAt > 0 && nextAt <= now) due.push(item)
      }
    }
    return due
  }

  markTriggered(id, now = Date.now()) {
    const items = this.load()
    let updated = null
    const next = items.flatMap((item) => {
      if (item.id !== id) return [item]
      if (item.kind === 'once') {
        updated = { ...item, lastTriggeredAt: now, enabled: false }
        return []
      }
      updated = {
        ...item,
        lastTriggeredAt: now,
        lastDayKey: localDayKey(now),
        ...(item.kind === 'interval' ? { nextRunAt: now + Math.max(1, Number(item.intervalHours || 24)) * 3_600_000 } : {}),
      }
      return [updated]
    })
    this.save(next)
    return updated
  }

  formatSummary(targetId = '') {
    const items = this.list(targetId).filter((i) => i.enabled)
    if (!items.length) return ''
    return items.map((i) => {
      if (i.kind === 'once') return `[#${i.id}] 一次性 ${new Date(i.runAt).toLocaleString()}：${i.label}`
      if (i.kind === 'daily') return `[#${i.id}] 每天 ${i.time}：${i.label}`
      if (i.kind === 'weekdays') return `[#${i.id}] 工作日 ${i.time}：${i.label}`
      return `[#${i.id}] 每 ${i.intervalHours} 小时：${i.label}`
    }).join('\n')
  }
}
