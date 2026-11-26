import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
const validBucket = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,255}$/.test(value) && value !== '.' && value !== '..'

function resolveCscPath() {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((p) => existsSync(p)) || 'csc.exe'
}

export class SessionDeletion {
  constructor({ ctx, trigger, home = homedir() }) {
    this.ctx = ctx
    this.trigger = trigger
    this.root = join(home, '.dsh')
    this.jobs = join(this.root, 'dsh-wechatbot', 'pending-deletions')
    this.active = new Set()
  }

  get persistence() { return this.ctx.get('sessionPersistence') }

  get supported() {
    return (process.platform === 'darwin' || process.platform === 'win32')
      && typeof this.persistence?.stat === 'function'
  }

  list() {
    let files
    try { files = readdirSync(this.jobs) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return []
    }
    return files.filter((path) => path.endsWith('.json')).map((file) => JSON.parse(readFileSync(join(this.jobs, file), 'utf8')))
  }

  path(id) {
    if (!validId(id)) throw new Error('无效的 DSH 会话 ID')
    return join(this.jobs, `${id}.json`)
  }

  save(job) {
    mkdirSync(this.jobs, { recursive: true, mode: 0o700 })
    const path = this.path(job.id)
    const temp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(job), { mode: 0o600 })
      renameSync(temp, path)
    } finally { rmSync(temp, { force: true }) }
  }

  /** Drop a finished job and its worker lock file. */
  remove(id) {
    if (!validId(id)) return
    rmSync(this.path(id), { force: true })
    rmSync(join(this.jobs, `${id}.worker-lock`), { force: true })
  }

  logBucket(location, id) {
    if (location?.kind !== 'jsonl' || typeof location.path !== 'string') throw new Error('当前会话存储格式不支持离线清理')
    const sessions = realpathSync(join(this.root, 'sessions'))
    const path = realpathSync(location.path)
    const [bucket, storedId, file, ...rest] = relative(sessions, path).split(sep)
    if (!validBucket(bucket) || !validId(id) || storedId !== id || !file || !/\.jsonl(?:\.zstd)?$/.test(file) || rest.length
      || !lstatSync(location.path).isFile() || basename(dirname(location.path)) !== id) {
      throw new Error('会话日志不在已验证的 DSH 存储目录中')
    }
    return bucket
  }

  async prepare(id, targetName) {
    if (!this.supported) throw new Error('当前 DSH 未提供可验证的会话存储接口')
    const stat = await this.persistence.stat(id)
    if (!stat || stat.header?.id !== id) throw new Error('未找到这个会话的持久化日志')
    const state = await this.trigger.state(id)
    if (!state || state.running || state.queue?.length || state.pendingInput?.length) throw new Error('会话仍有任务，请在完成后删除')
    const bucket = this.logBucket(stat.location, id)
    const worker = await this.worker()
    const job = { id, bucket, targetName, stage: 'preparing', requestedAt: Date.now() }
    this.save(job)
    try {
      const result = await this.trigger.removeSession(id)
      if (!result.removed) throw new Error(result.error || '无法解除工作区关联')
      this.save({ ...job, stage: 'waiting' })
      this.launch(id, worker)
    } catch (error) {
      this.save({ ...job, error: error.message })
      throw error
    }
    return { ok: true, pending: true, sessionId: id }
  }

  worker() {
    this.compiling ??= (async () => {
      mkdirSync(this.jobs, { recursive: true, mode: 0o700 })
      if (process.platform === 'win32') {
        const source = fileURLToPath(new URL('./session-deletion.cs', import.meta.url))
        const output = join(this.jobs, `worker-${process.pid}.exe`)
        const binary = join(this.jobs, 'worker-v1.exe')
        try {
          await run(resolveCscPath(), [
            '/nologo', '/optimize+', '/target:exe',
            `/out:${output}`,
            '/r:System.Web.Extensions.dll',
            source,
          ], { timeout: 60_000, windowsHide: true })
          try { renameSync(output, binary) } catch { if (!existsSync(binary)) throw new Error('无法写入清理程序') }
          return binary
        } finally { rmSync(output, { force: true }) }
      }
      const source = fileURLToPath(new URL('./session-deletion.swift', import.meta.url))
      const output = join(this.jobs, `worker-${process.pid}`)
      const binary = join(this.jobs, 'worker-v1')
      try {
        await run('/usr/bin/swiftc', ['-O', source, '-o', output], { timeout: 90_000 })
        renameSync(output, binary)
        return binary
      } finally { rmSync(output, { force: true }) }
    })().catch((error) => {
      this.compiling = null
      throw new Error(`无法编译离线删除程序：${error.message}`)
    })
    return this.compiling
  }

  launch(id, worker) {
    if (this.active.has(id)) return
    this.active.add(id)
    const child = spawn(worker, [this.root, id, String(process.pid)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('exit', () => this.active.delete(id))
    child.on('error', () => this.active.delete(id))
    child.unref()
  }

  visitJobs() {
    this.visiting ??= this.checkJobs().finally(() => { this.visiting = null })
    return this.visiting
  }

  /**
   * Whether the worker's purge really removed the stored session.
   *
   * The persistence service is not always available, and its stat can still
   * report a stale header. The filesystem is the ground truth the panel row is
   * waiting for, and checking it keeps finished jobs from lingering forever as
   * "已清理，待核对".
   */
  logGone(job) {
    const root = join(this.root, 'sessions')
    try {
      if (job?.bucket && validBucket(job.bucket)) {
        return !existsSync(join(root, job.bucket, job.id))
      }
      for (const bucket of readdirSync(root)) {
        if (existsSync(join(root, bucket, job.id))) return false
      }
      return true
    } catch {
      return false
    }
  }

  async checkJobs() {
    const jobs = this.list()
    for (const job of jobs) {
      // A finished job has no purpose beyond proving the cleanup; keeping it
      // leaves a permanent "已清理，待核对" row in the panel.
      if (job.stage === 'verified') {
        this.remove(job.id)
        continue
      }
      if (job.stage === 'waiting') {
        try { this.launch(job.id, await this.worker()) } catch { /* retried next time */ }
        continue
      }
      if (job.stage !== 'purged') continue
      if (!this.supported) {
        if (this.logGone(job)) {
          this.save({ ...job, stage: 'verified' })
          this.remove(job.id)
        }
        continue
      }
      const stat = await this.persistence.stat(job.id)
      const visible = await this.trigger.controller?.list?.({}, new AbortController().signal)
      const linked = this.trigger.registry?.list().some((workspace) => workspace.sessionIds.includes(job.id))
      if (stat || linked || !Array.isArray(visible?.items)) continue
      const stillIndexed = visible.items.some((row) => row.sessionId === job.id || row.id === job.id || row.header?.id === job.id || row.session?.id === job.id)
      if (stillIndexed) continue
      if (this.trigger.controller?.search) {
        const matches = await this.trigger.controller.search({ query: (job.targetName || job.id).slice(0, 100) }, new AbortController().signal)
        if (matches.items?.some((row) => row.sessionId === job.id)) continue
      }
      const archive = await this.trigger.unarchive(job.id)
      if (!archive.error && !this.trigger.isArchived(job.id)) {
        this.save({ ...job, stage: 'verified' })
        // Verified means nothing is left to reconcile: remove the row instead of
        // leaving it to accumulate next to the jobs that still need attention.
        this.remove(job.id)
      }
    }
  }
}
