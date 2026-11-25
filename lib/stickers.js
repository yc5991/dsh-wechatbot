import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const vectors = new WeakMap()

function vector(item) {
  if (!vectors.has(item)) {
    const pixels = typeof item.visual === 'string' ? Buffer.from(item.visual, 'base64') : null
    vectors.set(item, pixels?.length === 24 * 24 * 3 ? pixels : null)
  }
  return vectors.get(item)
}

function alignedMatch(left, right) {
  const a = vector(left), b = vector(right)
  if (!a || !b) return false
  for (let dy = -7; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      let distance = 0
      let count = 0
      let variance = 0
      for (let y = Math.max(2, 2 - dy); y < Math.min(22, 22 - dy); y += 2) {
        for (let x = 2; x < 22; x += 2) {
          const i = (y * 24 + x) * 3
          const j = ((y + dy) * 24 + x + dx) * 3
          distance += Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2])
          variance += Math.abs(a[i] - a[i + 6])
          count += 1
        }
      }
      // Align shifted crops while requiring enough detail to distinguish them
      // from blank space or another sticker with the same background.
      if (count && variance / count >= 10 && distance / (count * 3) <= 13) return true
    }
  }
  return false
}

export function sameSticker(left, right) {
  if (left.image && left.image === right.image) return true
  const a = left.signature, b = right.signature
  if (a?.length === 300 && b?.length === a.length) {
    let distance = 0
    for (let index = 0; index < a.length; index += 1) distance += Math.abs(a[index] - b[index])
    if (distance / a.length <= 12) return true
  }
  return alignedMatch(left, right)
}

function uniqueCells(items) {
  const unique = []
  for (const cell of items) if (!unique.some((other) => sameSticker(other, cell))) unique.push(cell)
  return unique
}

function legacyDuplicates(items) {
  const parents = items.map((_, index) => index)
  const root = (index) => {
    while (parents[index] !== index) index = parents[index]
    return index
  }
  const union = (left, right) => {
    const a = root(left), b = root(right)
    parents[Math.max(a, b)] = Math.min(a, b)
  }

  // Older scans appended another viewport whenever a crop or an animation
  // changed. Multiple matching thumbnails at one offset identify a repeated
  // run, including animated stickers in between its matching neighbors.
  for (let offset = 1; offset < items.length; offset += 1) {
    let anchors = []
    const mergeRun = () => {
      if (offset < 5 || anchors.length < 3) return
      const start = anchors[0], end = anchors.at(-1)
      if (end - start >= offset || end - start > 24) return
      for (let index = start; index <= end; index += 1) union(index, index + offset)
    }
    for (let index = 0; index + offset < items.length; index += 1) {
      if (!sameSticker(items[index], items[index + offset])) continue
      if (anchors.length && index - anchors.at(-1) > 3) { mergeRun(); anchors = [] }
      anchors.push(index)
      union(index, index + offset)
    }
    mergeRun()
  }
  const representatives = new Map()
  items.forEach((item, index) => {
    const key = root(index)
    const known = representatives.get(key)
    representatives.set(key, known ? mergeLabels(known, item) : item)
  })
  return [...representatives.values()]
}

export function stickerLabel(input) {
  const raw = Array.isArray(input.tags) ? input.tags : String(input.tags ?? '').split(/[,，、\n]/)
  const distinct = new Map()
  for (const tag of raw) {
    if (typeof tag !== 'string' || !tag.trim()) continue
    const label = tag.trim().slice(0, 24)
    const key = label.normalize('NFKC').toLocaleLowerCase()
    if (!distinct.has(key)) distinct.set(key, label)
  }
  return {
    tags: [...distinct.values()].slice(0, 6),
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 240) : '',
  }
}

function mergeLabels(known, duplicate) {
  const rank = { manual: 2, ai: 1 }
  const preferred = (rank[duplicate.source] ?? 0) > (rank[known.source] ?? 0) ? duplicate : known
  const secondary = preferred === known ? duplicate : known
  const label = stickerLabel({ tags: [...preferred.tags, ...secondary.tags], description: preferred.description || secondary.description })
  return { ...known, ...label, available: known.available || duplicate.available,
    source: preferred.source, revision: Math.max(known.revision, duplicate.revision) }
}

const assetPattern = /^[a-f0-9]{8}-[a-f0-9]{16}\.png$/
const hashImage = (image) => createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex').slice(0, 16)
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null }
}

function writeAtomic(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

export class StickerLibrary {
  constructor(path, { legacyPath, fingerprints } = {}) {
    this.path = path
    this.dir = dirname(path)
    this.legacyPath = legacyPath
    this.fingerprints = fingerprints
  }

  ready() {
    this.migration ??= this.migrate().catch((error) => { this.migration = null; throw error })
    return this.migration
  }

  async migrate() {
    if (readJson(this.path) || !this.legacyPath) return
    const library = readJson(this.legacyPath)
    if (!library) return
    if (library.version !== 1 || !Array.isArray(library.items)) throw new Error('旧表情库格式无法读取')
    const visual = await this.fingerprints?.(library.items).catch(() => ({})) ?? {}
    const needsRescan = library.complete !== true
    const items = legacyDuplicates(library.items.map((row) => ({ ...row, visual: visual[row.id], legacy: true,
      available: !needsRescan && row.available })))
    this.save({ version: 2, items, ignored: [], scannedAt: library.scannedAt, complete: !needsRescan, needsRescan })
  }

  manifest() {
    const library = readJson(this.path)
    if (!library) return { version: 2, items: [], ignored: [], scannedAt: null, complete: false }
    if (library.version !== 2 || !Array.isArray(library.items)) throw new Error('表情库格式无法读取')
    return library
  }

  load() {
    const library = this.manifest()
    return { ...library, items: library.items.map((item) => {
      if (!assetPattern.test(item.asset)) throw new Error('表情文件名无效')
      return { ...item, image: readFileSync(join(this.dir, item.asset)).toString('base64') }
    }) }
  }

  save(library) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const previous = this.manifest()
    const assets = new Set()
    const items = library.items.map(({ image, x, y, ...item }) => {
      const data = Buffer.from(image, 'base64')
      const asset = `${item.id}-${hashImage(image)}.png`
      if (!assetPattern.test(asset)) throw new Error('表情文件名无效')
      assets.add(asset)
      if (item.asset !== asset) writeAtomic(join(this.dir, asset), data)
      return { ...item, asset }
    })
    writeAtomic(this.path, JSON.stringify({ ...library, version: 2, items }, null, 2))
    for (const { asset } of previous.items) {
      if (assetPattern.test(asset) && !assets.has(asset)) rmSync(join(this.dir, asset), { force: true })
    }
  }

  synchronize({ items, complete }) {
    const library = this.load()
    const previous = library.items.slice()
    const current = []
    for (const cell of uniqueCells(items)) {
      const hash = library.ignored.length ? hashImage(cell.image) : null
      if (library.ignored.some((item) => item.hash === hash || sameSticker(item, cell))) continue
      const matching = previous.findIndex((item) => sameSticker(item, cell))
      const [known] = matching < 0 ? [] : previous.splice(matching, 1)
      current.push({
        ...(known ?? { id: randomUUID().slice(0, 8), revision: 0, tags: [], description: '', source: null }),
        image: cell.image,
        signature: cell.signature,
        visual: cell.visual,
        available: true,
        legacy: false,
      })
    }
    library.items = [...current, ...previous.map((item) => ({ ...item, available: !complete && !item.legacy && item.available }))]
    library.complete = complete
    library.needsRescan = library.needsRescan && !current.length && !complete
    library.scannedAt = Date.now()
    this.save(library)
    return library
  }

  edit(id, input) {
    const library = this.load()
    const item = library.items.find((row) => row.id === id)
    if (!item) throw new Error('找不到该表情，请刷新表情库')
    Object.assign(item, stickerLabel(input), { source: 'manual', revision: item.revision + 1 })
    this.save(library)
    return item
  }

  remove(id) {
    const library = this.load()
    const index = library.items.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('找不到该表情，请刷新表情库')
    const [removed] = library.items.splice(index, 1)
    library.ignored.push({ hash: hashImage(removed.image), signature: removed.signature, visual: removed.visual })
    this.save(library)
  }

  applyLabels(batch, labels) {
    const library = this.load()
    const requested = new Map(batch.map((item) => [item.id, item.revision]))
    const byId = new Map(labels.filter((row) => row && typeof row.id === 'string').map((row) => [row.id, stickerLabel(row)]))
    let updated = 0
    for (const item of library.items) {
      const label = byId.get(item.id)
      if (!item.available || item.source === 'manual' || requested.get(item.id) !== item.revision
        || !label?.tags.length || !label.description) continue
      Object.assign(item, label, { source: 'ai', revision: item.revision + 1 })
      updated += 1
    }
    if (updated > 0) this.save(library)
    return updated
  }
}

export function parseStickerLabels(text) {
  const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const labels = JSON.parse(json)
  if (!Array.isArray(labels)) throw new Error('DSH 返回的表情标注不是列表')
  return labels
}
