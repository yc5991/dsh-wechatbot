/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level L, Versions 1-14).
 * Produces an SVG data URL so QR login works in any Node + Web environment without external packages.
 */

// [ecPerBlock, numBlocks1, dataPerBlock1, numBlocks2, dataPerBlock2, alignmentPositions]
const VERSION_TABLE = [
  null,
  [7, 1, 19, 0, 0, []],
  [10, 1, 34, 0, 0, [6, 18]],
  [15, 1, 55, 0, 0, [6, 22]],
  [20, 1, 80, 0, 0, [6, 26]],
  [26, 1, 108, 0, 0, [6, 30]],
  [18, 2, 68, 0, 0, [6, 34]],
  [20, 2, 78, 0, 0, [6, 22, 38]],
  [24, 2, 97, 0, 0, [6, 24, 42]],
  [30, 2, 116, 0, 0, [6, 26, 46]],
  [18, 2, 68, 2, 69, [6, 28, 50]],
  [20, 4, 81, 0, 0, [6, 30, 54]],
  [24, 2, 92, 2, 93, [6, 32, 58]],
  [26, 4, 107, 0, 0, [6, 34, 62]],
  [30, 3, 115, 1, 116, [6, 26, 46, 66]],
]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x = x & 0x80 ? (x << 1) ^ 0x11d : x << 1
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1)
    const root = GF_EXP[i]
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], root)
    }
    poly = next
  }
  return poly
}

function rsRemainder(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen)
  const buf = new Uint8Array(data.length + ecLen)
  buf.set(data)
  for (let i = 0; i < data.length; i += 1) {
    const factor = buf[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j += 1) buf[i + j] ^= gfMul(gen[j], factor)
  }
  return buf.slice(data.length)
}

function encodeDataCodewords(bytes) {
  let version = -1
  let totalDataCap = 0
  for (let v = 1; v < VERSION_TABLE.length; v += 1) {
    const [, n1, d1, n2, d2] = VERSION_TABLE[v]
    const cap = n1 * d1 + n2 * d2
    const countBits = v < 10 ? 8 : 16
    const neededBits = 4 + countBits + bytes.length * 8
    if (neededBits <= cap * 8) {
      version = v
      totalDataCap = cap
      break
    }
  }
  if (version === -1) throw new Error('QR 内容过长，超出版本 1-14 容量')

  const bits = []
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1)
  }

  pushBits(0b0100, 4) // Byte mode
  pushBits(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) pushBits(byte, 8)

  const maxBits = totalDataCap * 8
  const terminator = Math.min(4, maxBits - bits.length)
  for (let i = 0; i < terminator; i += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b]
    codewords.push(byte)
  }
  const padBytes = [0xec, 0x11]
  for (let i = 0; codewords.length < totalDataCap; i += 1) codewords.push(padBytes[i & 1])

  const [ecLen, n1, d1, n2, d2] = VERSION_TABLE[version]
  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (let i = 0; i < n1 + n2; i += 1) {
    const len = i < n1 ? d1 : d2
    const block = Uint8Array.from(codewords.slice(offset, offset + len))
    offset += len
    dataBlocks.push(block)
    ecBlocks.push(rsRemainder(block, ecLen))
  }

  const interleaved = []
  const maxDataLen = Math.max(d1, d2)
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) if (i < block.length) interleaved.push(block[i])
  }
  for (let i = 0; i < ecLen; i += 1) {
    for (const block of ecBlocks) interleaved.push(block[i])
  }
  return { version, codewords: interleaved, align: VERSION_TABLE[version][5] }
}

function drawFinder(grid, fixed, r0, c0) {
  const size = grid.length
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const r = r0 + dr
      const c = c0 + dc
      if (r < 0 || r >= size || c < 0 || c >= size) continue
      const inSquare = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
      const dark = inSquare && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4))
      grid[r][c] = dark ? 1 : 0
      fixed[r][c] = 1
    }
  }
}

function drawAlignment(grid, fixed, r0, c0) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
      grid[r0 + dr][c0 + dc] = dark ? 1 : 0
      fixed[r0 + dr][c0 + dc] = 1
    }
  }
}

function bchEncode(data, poly, dataBits, totalBits) {
  let d = data << (totalBits - dataBits)
  const polyBits = poly.toString(2).length
  for (let shift = totalBits - polyBits; shift >= 0; shift -= 1) {
    if ((d >>> (shift + polyBits - 1)) & 1) d ^= poly << shift
  }
  return ((data << (totalBits - dataBits)) | d) >>> 0
}

function drawFormatBits(grid, mask) {
  const size = grid.length
  const format = bchEncode((0b01 << 3) | mask, 0x537, 5, 15) ^ 0x5412
  for (let i = 0; i < 15; i += 1) {
    const bit = (format >>> i) & 1
    if (i < 6) grid[i][8] = bit
    else if (i < 8) grid[i + 1][8] = bit
    else grid[size - 15 + i][8] = bit

    if (i < 8) grid[8][size - 1 - i] = bit
    else if (i < 9) grid[8][7] = bit
    else grid[8][14 - i] = bit
  }
}

function drawVersionBits(grid, fixed, version) {
  if (version < 7) return
  const size = grid.length
  const verInfo = bchEncode(version, 0x1f25, 6, 18)
  for (let i = 0; i < 18; i += 1) {
    const bit = (verInfo >>> i) & 1
    const a = Math.floor(i / 3)
    const b = size - 11 + (i % 3)
    grid[a][b] = bit
    fixed[a][b] = 1
    grid[b][a] = bit
    fixed[b][a] = 1
  }
}

function applyMask(base, fixed, mask) {
  const size = base.length
  const out = base.map((row) => Uint8Array.from(row))
  const cond = (r, c) => {
    switch (mask) {
      case 0: return (r + c) % 2 === 0
      case 1: return r % 2 === 0
      case 2: return c % 3 === 0
      case 3: return (r + c) % 3 === 0
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
      default: return false
    }
  }
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!fixed[r][c] && cond(r, c)) out[r][c] ^= 1
    }
  }
  drawFormatBits(out, mask)
  return out
}

function penaltyScore(grid) {
  const size = grid.length
  let score = 0
  for (let r = 0; r < size; r += 1) {
    let runColor = grid[r][0]
    let runLen = 1
    let colColor = grid[0][r]
    let colLen = 1
    for (let c = 1; c < size; c += 1) {
      if (grid[r][c] === runColor) {
        runLen += 1
        if (runLen === 5) score += 3
        else if (runLen > 5) score += 1
      } else {
        runColor = grid[r][c]
        runLen = 1
      }
      if (grid[c][r] === colColor) {
        colLen += 1
        if (colLen === 5) score += 3
        else if (colLen > 5) score += 1
      } else {
        colColor = grid[c][r]
        colLen = 1
      }
    }
  }
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const sum = grid[r][c] + grid[r][c + 1] + grid[r + 1][c] + grid[r + 1][c + 1]
      if (sum === 0 || sum === 4) score += 3
    }
  }
  let dark = 0
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (grid[r][c]) dark += 1
      if (c <= size - 7) {
        const rowHit = (
          grid[r][c] && !grid[r][c + 1] && grid[r][c + 2] && grid[r][c + 3] && grid[r][c + 4] && !grid[r][c + 5] && grid[r][c + 6]
        )
        if (rowHit) {
          const leftLight = c >= 4 && !grid[r][c - 1] && !grid[r][c - 2] && !grid[r][c - 3] && !grid[r][c - 4]
          const rightLight = c + 10 < size && !grid[r][c + 7] && !grid[r][c + 8] && !grid[r][c + 9] && !grid[r][c + 10]
          if (leftLight || rightLight) score += 40
        }
        const colHit = (
          grid[c][r] && !grid[c + 1][r] && grid[c + 2][r] && grid[c + 3][r] && grid[c + 4][r] && !grid[c + 5][r] && grid[c + 6][r]
        )
        if (colHit) {
          const topLight = c >= 4 && !grid[c - 1][r] && !grid[c - 2][r] && !grid[c - 3][r] && !grid[c - 4][r]
          const botLight = c + 10 < size && !grid[c + 7][r] && !grid[c + 8][r] && !grid[c + 9][r] && !grid[c + 10][r]
          if (topLight || botLight) score += 40
        }
      }
    }
  }
  const pct = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(pct - 50) / 5) * 10
  return score
}

/** Encode a UTF-8 string into a square QR bit matrix `{ size, modules }`. */
export function encodeQrMatrix(text) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8')
  const { version, codewords, align } = encodeDataCodewords(bytes)
  const size = 17 + version * 4
  const grid = Array.from({ length: size }, () => new Uint8Array(size))
  const fixed = Array.from({ length: size }, () => new Uint8Array(size))

  drawFinder(grid, fixed, 0, 0)
  drawFinder(grid, fixed, 0, size - 7)
  drawFinder(grid, fixed, size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0
    grid[6][i] = bit
    fixed[6][i] = 1
    grid[i][6] = bit
    fixed[i][6] = 1
  }

  for (const r of align) {
    for (const c of align) {
      if ((r === 6 && (c === 6 || c === size - 7)) || (r === size - 7 && c === 6)) continue
      drawAlignment(grid, fixed, r, c)
    }
  }

  grid[4 * version + 9][8] = 1
  fixed[4 * version + 9][8] = 1

  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      fixed[8][i] = 1
      fixed[i][8] = 1
    }
    if (i < 8) {
      fixed[8][size - 1 - i] = 1
      if (i < 7) fixed[size - 1 - i][8] = 1
    }
  }
  drawVersionBits(grid, fixed, version)

  let bitIdx = 0
  const totalBits = codewords.length * 8
  let upward = true
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step
      for (const c of [col, col - 1]) {
        if (fixed[r][c]) continue
        if (bitIdx < totalBits) {
          grid[r][c] = (codewords[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1
          bitIdx += 1
        }
      }
    }
    upward = !upward
  }

  let bestGrid = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(grid, fixed, mask)
    const score = penaltyScore(candidate)
    if (score < bestScore) {
      bestScore = score
      bestGrid = candidate
    }
  }
  return { size, modules: bestGrid }
}

/** Encode a string into a crisp base64 SVG data URL ready for `<img>` rendering. */
export function qrSvgDataUrl(text, { margin = 4 } = {}) {
  const { size, modules } = encodeQrMatrix(text)
  const total = size + margin * 2
  const paths = []
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) paths.push(`M${c + margin},${r + margin}h1v1h-1z`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/>`
    + `<path d="${paths.join('')}" fill="#000"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
