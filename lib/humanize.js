/**
 * Human-like input cadence, phrase chunking, and spatial jitter for RPA anti-detection.
 *
 * Eliminates the primary client-side bot telemetry vectors in WeChat 4.x:
 *   1. 100% clipboard paste ratio with zero keydown/IME events -> phrase-chunked Unicode typing
 *   2. 0.0px variance dead-center composer clicks -> truncated 2D Gaussian target sampling
 *   3. Flat uniform Math.random() pauses detached from message length -> Box-Muller log-normal cadence
 */

/** Normalize antiDetection config object with all sub-features enabled by default. */
export function normalizeAntiDetection(raw = {}) {
  const enabled = raw?.enabled !== false
  return {
    enabled,
    phraseTyping: enabled && raw?.phraseTyping !== false,
    curvedMouse: enabled && raw?.curvedMouse !== false,
    naturalCadence: enabled && raw?.naturalCadence !== false,
    minimalTouch: enabled && raw?.minimalTouch !== false,
  }
}

/** Standard normal sample via Box-Muller transform, clamped to [-2.8, 2.8]. */
export function gaussianRandom(random = Math.random) {
  const u1 = Math.max(1e-7, random())
  const u2 = Math.max(1e-7, random())
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(-2.8, Math.min(2.8, z))
}

/** Right-skewed log-normal sample around `median`, clamped to `[min, max]`. */
export function logNormalBounded(median, min, max, sigma = 0.35, random = Math.random) {
  if (max <= 0 || (min <= 0 && max <= 0)) return 0
  const lo = Math.max(0, min)
  const hi = Math.max(lo, max)
  if (hi === lo) return lo
  const m = Math.max(0.05, median)
  const raw = m * Math.exp(sigma * gaussianRandom(random))
  return Math.max(lo, Math.min(hi, raw))
}

/**
 * Sample a human click point inside the composer box using truncated 2D Gaussian noise.
 * Never hits the exact geometric center pixel twice in a row.
 */
export function jitterComposerPoint(layout, windowHeight, windowY, random = Math.random) {
  const meanX = layout.x + layout.w * 0.44
  const sigmaX = Math.max(8, layout.w * 0.13)
  const minX = layout.x + Math.max(24, Math.round(layout.w * 0.14))
  const maxX = layout.x + Math.max(minX + 10 - layout.x, Math.round(layout.w * 0.80))

  const meanY = windowY + windowHeight * 0.908
  const sigmaY = Math.max(3, windowHeight * 0.014)
  const minY = windowY + Math.round(windowHeight * 0.885)
  const maxY = windowY + Math.round(windowHeight * 0.935)

  const x = Math.round(Math.max(minX, Math.min(maxX, meanX + gaussianRandom(random) * sigmaX)))
  const y = Math.round(Math.max(minY, Math.min(maxY, meanY + gaussianRandom(random) * sigmaY)))
  return { x, y }
}

/**
 * Add natural human jitter to fallback drag-select endpoints inside `region`
 * so capture-free drags never repeat identical start/end pixels.
 */
export function jitterDragSelection(sel, region, random = Math.random) {
  const minY = region.y + Math.max(44, Math.round(region.h * 0.11))
  const maxY = region.y + region.h - 4
  const minX = region.x + 16
  const maxX = region.x + region.w - 16
  const jx1 = Math.round(gaussianRandom(random) * 10)
  const jy1 = Math.round(gaussianRandom(random) * 7)
  const jx2 = Math.round(gaussianRandom(random) * 10)
  const jy2 = Math.round(gaussianRandom(random) * 7)
  return {
    x1: Math.max(minX, Math.min(maxX, sel.x1 + jx1)),
    y1: Math.max(minY, Math.min(maxY - 24, sel.y1 + jy1)),
    x2: Math.max(minX, Math.min(maxX, sel.x2 + jx2)),
    y2: Math.max(minY + 24, Math.min(maxY, sel.y2 + jy2)),
  }
}

/**
 * Decide whether a message should be entered via simulated IME phrase typing
 * rather than clipboard Cmd+V / Ctrl+V paste.
 *
 * Humans type conversational lines (< ~80 chars without URLs or multiline blocks)
 * and paste URLs, code snippets, or long paragraphs.
 */
export function shouldTypeViaKeyboard(text, mode = 'human') {
  if (mode === 'paste') return false
  const str = String(text || '')
  if (!str) return false
  const chars = [...str]
  if (chars.length > 85) return false
  if (/https?:\/\/|www\./i.test(str)) return false
  if (str.includes('\n')) return false
  // Avoid raw surrogates / astral emoji in synthetic key events on older OS bridges;
  // standard CJK, punctuation, and ASCII type cleanly via Unicode key events.
  if (chars.some((ch) => ch.codePointAt(0) > 0xFFFF)) return false
  return true
}

/**
 * Split plain text into 1-4 character IME-like phrase chunks with realistic
 * log-normal inter-phrase intervals (simulating Pinyin phrase selection cadence).
 *
 * @returns {Array<{ text: string, delayMs: number }>}
 */
export function splitTypingChunks(text, random = Math.random) {
  const chars = [...String(text || '')]
  const chunks = []
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    // Group contiguous ASCII alphanumerics as a word (up to 6 chars)
    if (/[A-Za-z0-9]/.test(ch)) {
      let end = i + 1
      while (end < chars.length && end - i < 6 && /[A-Za-z0-9._-]/.test(chars[end])) end += 1
      const word = chars.slice(i, end).join('')
      const delayMs = Math.round(logNormalBounded(95 + word.length * 28, 55, 340, 0.28, random))
      chunks.push({ text: word, delayMs })
      i = end
      continue
    }

    // Punctuation or whitespace stands alone with a slightly longer clause beat
    if (/[\s，。？！、：；,~!?:;…—()（）「」【】]/.test(ch)) {
      const delayMs = Math.round(logNormalBounded(210, 110, 460, 0.32, random))
      chunks.push({ text: ch, delayMs })
      i += 1
      continue
    }

    // CJK phrase chunk of 1 to 4 characters (weighted toward 2-3 char phrases)
    const r = random()
    const take = r < 0.20 ? 1 : r < 0.68 ? 2 : r < 0.92 ? 3 : 4
    let end = i + 1
    while (
      end < chars.length
      && end - i < take
      && !/[A-Za-z0-9\s，。？！、：；,~!?:;…—()（）]/.test(chars[end])
    ) {
      end += 1
    }
    const phrase = chars.slice(i, end).join('')
    const medianMs = 115 + phrase.length * 48
    const delayMs = Math.round(logNormalBounded(medianMs, 70, 380, 0.30, random))
    chunks.push({ text: phrase, delayMs })
    i = end
  }
  return chunks
}

/**
 * Initial composing delay before the first bubble, combining log-normal reaction
 * time with draft length when non-zero delays are configured.
 */
export function composingDelaySeconds(draftText, { minSeconds = 0.8, maxSeconds = 2.4, typed = false } = {}, random = Math.random) {
  const min = Math.max(0, Number(minSeconds ?? 0))
  const max = Math.max(min, Number(maxSeconds ?? 0))
  if (min === 0 && max === 0) return 0
  const len = [...String(draftText || '')].length
  // When phrase-typing will already spend ~150ms/char in the input box, keep pre-typing
  // pause focused on reading/thinking; when pasting, include composing time up front.
  const lengthBonus = typed ? Math.min(1.2, len * 0.03) : Math.min(3.2, len * 0.09)
  const effectiveMax = max + lengthBonus
  const median = min + (effectiveMax - min) * 0.45
  return Number(logNormalBounded(median, min, effectiveMax, 0.35, random).toFixed(2))
}

/**
 * Composing pause between consecutive bubbles in a multi-bubble burst (`wechat_send_many`).
 * Scales with the length of `nextText` so a 25-character second bubble is not sent 0.4s
 * after the first bubble.
 */
export function interBubblePauseSeconds(previousText, nextText = '', { typed = false } = {}, random = Math.random) {
  const prevLen = [...String(previousText || '')].length
  const nextLen = [...String(nextText || '')].length
  // If `nextText` will be typed chunk-by-chunk, typing itself adds natural duration;
  // still leave a realistic cognitive gap (0.45s - 1.6s) between pressing Return and starting next line.
  const perChar = typed ? 0.03 : 0.11
  const median = 0.55 + Math.min(0.6, prevLen * 0.015) + Math.min(3.5, nextLen * perChar)
  const min = 0.38
  const max = Math.max(1.2, median * 1.85)
  return Number(logNormalBounded(median, min, max, 0.30, random).toFixed(2))
}
