import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { SessionDeletion } from '../lib/session-deletion.js'

test('offline deletion waits for the host and removes only the authorized session', { skip: process.platform !== 'darwin', timeout: 25_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-deletion-test-'))
  t.after(() => rmSync(home, { force: true, recursive: true }))
  const root = join(home, '.dsh')
  const bucket = '--users-fixture-.dsh-dsh-wechatbot-agent--'
  const id = 'authorized-test-session'
  const jobDir = join(root, 'dsh-wechatbot', 'pending-deletions')
  const documents = join(root, 'agent')
  const folder = join(root, 'sessions', bucket, id)
  const untouched = join(root, 'sessions', bucket, 'other-session')
  const cacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
  for (const path of [jobDir, folder, untouched, cacheRoot, documents]) mkdirSync(path, { recursive: true })
  const log = join(folder, 'test.jsonl.zstd')
  const cache = join(cacheRoot, id + '.json')
  writeFileSync(log, 'simulated data')
  writeFileSync(join(folder, 'session.lock'), '')
  writeFileSync(cache, '{}')
  writeFileSync(join(documents, 'MEMORY.md'), 'keep this summary')
  const job = join(jobDir, id + '.json')
  writeFileSync(job, JSON.stringify({ id, bucket, stage: 'waiting' }))
  const deletion = new SessionDeletion({ home, trigger: {}, ctx: {} })
  assert.equal(deletion.logBucket({ kind: 'jsonl', path: log }, id), bucket)

  const worker = join(home, 'delete-worker')
  execFileSync('/usr/bin/swiftc', ['-O', fileURLToPath(new URL('../lib/session-deletion.swift', import.meta.url)), '-o', worker])
  const host = spawn('/bin/sleep', ['60'])
  const stopped = once(host, 'exit')
  const purge = spawn(worker, [root, id, String(host.pid)])
  const completed = once(purge, 'exit')
  t.after(() => { if (host.exitCode === null) host.kill(); if (purge.exitCode === null) purge.kill() })
  await sleep(150)
  assert.equal(existsSync(log), true)
  assert.equal(existsSync(cache), true)
  host.kill()
  await stopped
  assert.equal((await completed)[0], 0)
  assert.equal(JSON.parse(readFileSync(job)).stage, 'purged')
  assert.equal(existsSync(folder), false)
  assert.equal(existsSync(cache), false)
  assert.equal(existsSync(untouched), true)
  assert.equal(readFileSync(join(documents, 'MEMORY.md'), 'utf8'), 'keep this summary')

  let archived = true
  let foundBySearch = true
  const trigger = {
    registry: { list: () => [] },
    controller: { list: async () => ({ items: [] }), search: async () => ({ items: foundBySearch ? [{ sessionId: id }] : [] }) },
    isArchived: () => archived,
    unarchive: async () => { archived = false; return { archived: false } },
  }
  const verifier = new SessionDeletion({ home, trigger, ctx: { get: () => ({ stat: async () => undefined }) } })
  await verifier.visitJobs()
  assert.equal(JSON.parse(readFileSync(job)).stage, 'purged')
  foundBySearch = false
  await verifier.visitJobs()
  assert.equal(JSON.parse(readFileSync(job)).stage, 'verified')
  assert.equal(archived, false)
})
