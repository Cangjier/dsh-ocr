/**
 * Checking burned-in subtitles by reading them back off the picture.
 *
 * The question this answers is not "is this beautiful typography" but "did the glyphs that were
 * supposed to ship actually reach the screen, and are they legible enough to be recognised".
 * Both halves are measurements: the expected text and its times come from an SRT file, and the
 * read-back happens at those times.
 *
 * Two details make the comparison mean something rather than merely run:
 *
 * 1. **Compare against the best single line, not against everything the recogniser saw.** A
 *    tutorial video has a screen full of interface text behind a one-line subtitle. Comparing
 *    the cue with the whole frame scores near zero even when the subtitle is perfectly legible,
 *    which measures the video's other contents instead of the subtitle.
 * 2. **Normalise before comparing.** An OCR of a subtitle returns glyphs, not the SRT's commas:
 *    `给它最小的权限，` and `给它最小的权限` are the same subtitle to a viewer. Full-width
 *    characters, punctuation and spacing are therefore removed, and comparison is
 *    character-level, because the failure being looked for is a missing or wrong glyph
 *    (`跑通你的第一个任务` versus `跑通你的第一个住所`), not a different sentence.
 *
 * @module dsh-ocr/core/subtitles
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Default share of sampled cues to read back. */
export const DEFAULT_SAMPLE_FRAMES = 6

/** Read this far into a cue: the subtitle has appeared, and has not yet begun to fade. */
export const DEFAULT_LEAD_SECONDS = 0.35

/** Character similarity a read-back must reach to count as the right line. */
export const DEFAULT_MATCH_RATIO = 0.6

/** `00:00:01,000 --> 00:00:04,000`, tolerating `.` as the millisecond separator and stray spaces. */
const TIME_LINE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

/**
 * Convert one SRT timestamp to seconds.
 * @param {string} hours - hours field.
 * @param {string} minutes - minutes field.
 * @param {string} seconds - seconds field.
 * @param {string} milliseconds - milliseconds field.
 * @returns {number} seconds.
 */
function toSeconds(hours, minutes, seconds, milliseconds) {
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds.padEnd(3, '0')) / 1000
  )
}

/**
 * Parse an SRT document.
 *
 * Deliberately forgiving: a BOM, `\r\n`, a missing or out-of-order cue number, and both `.`
 * and `,` as the millisecond separator are all accepted, because an SRT that came from another
 * tool is still a usable specification of what should be on screen. A block with no time line
 * or no text is skipped rather than fatal; unparseable input yields an empty list.
 *
 * @param {string} text - the file's contents.
 * @returns {{index: number, start: number, end: number, text: string}[]} cues, in file order.
 */
export function parseSrt(text) {
  if (typeof text !== 'string' || text.trim() === '') return []

  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const cues = []

  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    const timeLineIndex = lines.findIndex((line) => TIME_LINE.test(line))
    if (timeLineIndex === -1) continue

    const match = TIME_LINE.exec(lines[timeLineIndex])
    if (match === null) continue

    const body = lines.slice(timeLineIndex + 1).join('\n')
    if (body === '') continue

    cues.push({
      index: cues.length + 1,
      start: toSeconds(match[1], match[2], match[3], match[4]),
      end: toSeconds(match[5], match[6], match[7], match[8]),
      text: body,
    })
  }
  return cues
}

/**
 * Normalise text for comparison: full-width to half-width, drop punctuation and spacing.
 *
 * @param {string} value - the text.
 * @returns {string} the comparable form.
 */
export function normaliseSubtitleText(value) {
  return String(value ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

/**
 * Similarity of two texts, as the length of their longest common subsequence over the longer
 * length.
 *
 * @param {string} a - first text.
 * @param {string} b - second text.
 * @returns {number} 0..1.
 */
export function textSimilarity(a, b) {
  const left = normaliseSubtitleText(a)
  const right = normaliseSubtitleText(b)
  if (left.length === 0 && right.length === 0) return 1
  if (left.length === 0 || right.length === 0) return 0
  // Rolling two-row LCS: short strings, but a 24-cue run should not allocate 24 tables of n*m.
  let previous = new Int32Array(right.length + 1)
  let current = new Int32Array(right.length + 1)
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return previous[right.length] / Math.max(left.length, right.length)
}

/**
 * Choose which cues to read back, spread evenly through the file.
 *
 * Evenly spread rather than the first N: a subtitle track that is correct at the start and
 * broken later is exactly the failure worth catching, and the first N cues are the ones most
 * likely to have been checked by eye.
 *
 * @param {object[]} cues - every cue.
 * @param {number} sampleFrames - how many to read.
 * @returns {object[]} the chosen cues, in file order.
 */
export function pickCues(cues, sampleFrames) {
  const count = Math.max(1, Math.min(sampleFrames, cues.length))
  const stride = Math.max(1, Math.ceil(cues.length / count))
  const picked = []
  for (let index = 0; index < cues.length && picked.length < count; index += stride) picked.push(cues[index])
  // The last cue is always worth reading: a track that stops early is a real defect, and the
  // stride above can step over it.
  if (picked[picked.length - 1] !== cues[cues.length - 1]) picked[picked.length - 1] = cues[cues.length - 1]
  return picked
}

/**
 * Read burned-in subtitles back and compare them with what an SRT says should be there.
 *
 * @param {object} options - the check.
 * @param {string} options.target - the delivered video.
 * @param {string} options.srtPath - the SRT the expectations come from.
 * @param {Function} options.readText - the OCR entry point, injected so this module is testable.
 * @param {object} [options.config] - normalized plugin config, forwarded to the reader.
 * @param {number} [options.sampleFrames] - how many cues to read; default 6.
 * @param {number} [options.leadSeconds] - read this far into each cue; default 0.35.
 * @param {number} [options.matchRatio] - similarity a cue must reach; default 0.6.
 * @param {string} [options.language] - recognition language; default `ch`.
 * @param {(message: string) => void} [options.onLog] - progress notes.
 * @returns {Promise<object>} per-cue results, or a `{ skipped }` explanation when there is
 *   nothing to read. Never throws: an unusable SRT or a failing engine is a measurement that
 *   could not be taken, which the caller reports as such rather than as a pass.
 */
export async function verifySubtitles(options) {
  if (typeof options?.readText !== 'function') {
    return { skipped: '没有可用的 OCR 读取实现（本插件内部错误）。' }
  }

  const srtPath = typeof options.srtPath === 'string' && options.srtPath !== '' ? resolve(options.srtPath) : null
  if (srtPath === null) return { skipped: '没有给字幕文件（srt），无法知道画面上应该是什么。' }
  if (!existsSync(srtPath)) return { skipped: `字幕文件不存在：${srtPath}` }

  const cues = parseSrt(readFileSync(srtPath, 'utf8'))
  if (cues.length === 0) return { skipped: `字幕文件里没有解析出任何一条字幕：${srtPath}` }

  const picked = pickCues(cues, options.sampleFrames ?? DEFAULT_SAMPLE_FRAMES)
  const lead = options.leadSeconds ?? DEFAULT_LEAD_SECONDS
  const matchRatio = options.matchRatio ?? DEFAULT_MATCH_RATIO
  const times = picked.map((cue) => Number((cue.start + lead).toFixed(3)))

  let recognised
  try {
    recognised = await options.readText(options.target, {
      times,
      config: options.config,
      language: options.language ?? 'ch',
      onLog: options.onLog,
    })
  } catch (error) {
    // This module never imports the engine, so an error that can describe itself as an
    // environment fault is asked to, rather than being recognised by class: a failing read-back
    // that was really a missing engine must not look like a subtitle problem.
    const fault = typeof error?.toFault === 'function' ? error.toFault() : null
    return {
      engine: null,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      ...(fault === null ? {} : { fault }),
      cues: [],
      minSimilarity: null,
      meanSimilarity: null,
      matchRatio,
    }
  }

  const frames = recognised.frames ?? []
  const rows = picked.map((cue, index) => {
    const at = times[index]
    const frame = frames.reduce(
      (best, entry) => (best === null || Math.abs(entry.at - at) < Math.abs(best.at - at) ? entry : best),
      null,
    )
    const lines = Array.isArray(frame?.lines)
      ? frame.lines.map((line) => line.text ?? '').filter((text) => text !== '')
      : []
    const candidates = []
    for (const line of lines) candidates.push({ kind: 'line', text: line })
    // A wrapped subtitle arrives as two lines, so adjacent pairs are candidates too.
    for (let position = 0; position + 1 < lines.length; position += 1) {
      candidates.push({ kind: 'pair', text: `${lines[position]}${lines[position + 1]}` })
    }
    if (frame?.text) candidates.push({ kind: 'frame', text: frame.text })
    if (candidates.length === 0) candidates.push({ kind: 'empty', text: '' })

    let best = { kind: 'empty', text: '', similarity: 0 }
    for (const candidate of candidates) {
      const similarity = textSimilarity(cue.text, candidate.text)
      if (similarity > best.similarity) best = { ...candidate, similarity }
    }

    return {
      at,
      cueStart: Number(cue.start.toFixed(3)),
      cueEnd: Number(cue.end.toFixed(3)),
      expected: cue.text.replace(/\s+/g, ' ').trim(),
      read: (frame?.text ?? '').replace(/\s+/g, ' ').trim(),
      matched: best.text.replace(/\s+/g, ' ').trim().slice(0, 120),
      matchedLine: best.kind,
      similarity: Number(best.similarity.toFixed(3)),
      ok: best.similarity >= matchRatio,
    }
  })

  const similarities = rows.map((row) => row.similarity)
  return {
    srt: srtPath,
    engine: recognised.engine ?? null,
    // A read-back that came from the fallback recogniser measures the recogniser as much as the
    // subtitles; the fault travels with the numbers so the two can be told apart.
    ...(recognised.fault === undefined || recognised.fault === null ? {} : { fault: recognised.fault }),
    sampledCues: rows.length,
    totalCues: cues.length,
    cues: rows,
    failures: rows.filter((row) => !row.ok),
    minSimilarity: similarities.length === 0 ? null : Math.min(...similarities),
    meanSimilarity:
      similarities.length === 0
        ? null
        : Number((similarities.reduce((sum, value) => sum + value, 0) / similarities.length).toFixed(3)),
    matchRatio,
  }
}
