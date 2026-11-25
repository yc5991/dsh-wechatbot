import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NativeStickerPicker } from '../lib/native-picker.js'
import { StickerLibrary } from '../lib/stickers.js'

const picture = (name) => Buffer.from(name).toString('base64')

test('legacy duplicate crops preserve labels, then removal deletes the asset without reimporting it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechatbot-sticker-migration-'))
  t.after(() => rmSync(dir, { force: true, recursive: true }))
  const legacyPath = join(dir, 'native-stickers.json')
  const catalog = join(dir, 'agent', 'stickers', 'catalog.json')
  const image = picture('one image')
  const makeRow = (id, source, tags, description, value) => ({ id, image: value, source, tags, description, revision: 1, available: true })
  const original = JSON.stringify({ version: 1, items: [
    makeRow('aaaaaaaa', 'ai', ['开心'], '模型标注', image),
    makeRow('bbbbbbbb', 'manual', ['应援'], '手动标注', image),
    makeRow('cccccccc', 'manual', ['应援'], '不同的表情', picture('different image')),
  ] })
  writeFileSync(legacyPath, original)

  const library = new StickerLibrary(catalog, { legacyPath })
  await library.ready()
  const [merged, distinct] = library.load().items
  assert.equal(merged.id, 'aaaaaaaa')
  assert.equal(merged.description, '手动标注')
  assert.deepEqual(merged.tags, ['应援', '开心'])
  assert.equal(distinct.id, 'cccccccc')
  assert.equal(readFileSync(legacyPath, 'utf8'), original)
  const asset = join(dir, 'agent', 'stickers', merged.asset)
  assert.equal(existsSync(asset), true)

  library.remove(merged.id)
  assert.equal(existsSync(asset), false)
  const reopened = new StickerLibrary(catalog, { legacyPath })
  await reopened.ready()
  reopened.synchronize({ items: [{ image }, { image: distinct.image }], complete: true })
  assert.deepEqual(reopened.load().items.map((item) => item.id), [distinct.id])
})

test('when the viewport stops moving, animation frames cannot keep adding favorite tiles', async (t) => {
  const picker = new NativeStickerPicker({})
  const page = (animation) => ({ cells: [
    { image: picture('first still'), x: 57, y: 80 },
    { image: picture('second still'), x: 145, y: 80 },
    { image: picture(animation), x: 233, y: 80 },
  ] })
  const pages = [page('frame one'), page('frame two')]
  t.mock.method(picker, 'snapshot', async () => {})
  const scroll = t.mock.method(picker, 'scroll', async () => {})
  t.mock.method(picker, 'helper', async () => pages.shift())
  const seen = []
  const result = await picker.eachPage({ path: '', frame: {}, heart: {} }, (_picker, cells) => { seen.push(...cells) })
  assert.equal(result.complete, true)
  assert.equal(seen.length, 3)
  assert.equal(scroll.mock.callCount(), 1)
})

test('pagination drops a clipped row and adds only newly exposed logical tiles', async (t) => {
  const picker = new NativeStickerPicker({})
  const row = (y, names) => names.map((name, index) => ({ image: picture(name), x: 57 + 88 * index, y }))
  const first = [...row(73, ['a', 'b']), ...row(161, ['c', 'd']), ...row(249, ['e', 'f'])]
  const next = [...row(50, ['clipped a', 'clipped b']), ...row(124, ['c', 'd']),
    ...row(212, ['e', 'f']), ...row(300, ['g', 'h'])]
  const pages = [first, next, next]
  t.mock.method(picker, 'open', async () => ({ path: '', frame: {}, heart: {} }))
  t.mock.method(picker, 'snapshot', async () => {})
  t.mock.method(picker, 'scroll', async () => {})
  t.mock.method(picker, 'act', async () => {})
  t.mock.method(picker, 'helper', async () => ({ cells: pages.shift() }))
  const result = await picker.collect()
  assert.equal(result.complete, true)
  assert.deepEqual(result.items.map((item) => Buffer.from(item.image, 'base64').toString()), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
})
