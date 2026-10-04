/**
 * `text_read` actions: reading a picture's text as data, and proving burned subtitles.
 *
 * `read` and `verify` sit in one tool because they answer the same shape of question — what do
 * the pixels actually say — and differ only in where the expectation comes from. `read` has no
 * expectation: it reports every line it saw. `verify` has one, in an SRT file, and reports the
 * distance between the two.
 *
 * The result of `read` carries every line with its box and score, so one call answers both "what
 * does it say" and "where does it say it". `text` is the filtered view that honours `minScore`;
 * `lines` is never filtered, because silently dropping a line the caller wanted is worse than
 * making the caller skip one.
 *
 * @module dsh-ocr/tools/read-actions
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { OcrError, findLines, parseRegion, readText } from '../core/engine.mjs'
import { verifySubtitles } from '../core/subtitles.mjs'
import { OcrPluginError } from './shared.mjs'

/** How many files one `read` call will take. A page of screenshots, not a library. */
const MAX_READ_FILES = 12

/**
 * Resolve one caller-supplied path against the working directory.
 *
 * @param {string} value - the path as given.
 * @param {string} cwd - the working directory.
 * @returns {string} an absolute path.
 */
function pathOf(value, cwd) {
  const text = String(value)
  return isAbsolute(text) ? resolve(text) : resolve(cwd, text)
}

/**
 * Build the core reader options from a tool call.
 *
 * @param {object} args - the tool arguments.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} options for the core reader.
 */
function readOptions(args, config, logger) {
  return {
    config,
    engine: typeof args.engine === 'string' && args.engine !== '' ? args.engine : undefined,
    region: parseRegion(args.region),
    scale: args.scale === undefined ? undefined : args.scale,
    language: typeof args.language === 'string' && args.language !== '' ? args.language : undefined,
    maxSideLen: Number.isFinite(args.maxSideLen) ? args.maxSideLen : undefined,
    minScore: Number.isFinite(args.minScore) ? args.minScore : undefined,
    frames: Number.isFinite(args.frames) ? args.frames : undefined,
    times: Array.isArray(args.times) ? args.times : undefined,
    onLog: (message) => logger.info(`dsh-ocr: ${message}`),
  }
}

/**
 * Reduce one reading to the shape a tool result carries.
 *
 * @param {object} result - a core reading.
 * @returns {object} the summary.
 */
function summarise(result) {
  return {
    path: result.path,
    kind: result.kind,
    engine: result.engine,
    elapsedMs: result.elapsedMs,
    lineCount: result.lines.length,
    dropped: result.dropped ?? 0,
    text: result.text,
    lines: result.lines,
    ...(result.kind === 'video'
      ? {
          duration: result.duration,
          frames: result.frames.map((frame) => ({
            at: frame.at,
            engine: frame.engine,
            lineCount: frame.lines.length,
            text: frame.text,
          })),
        }
      : {}),
    notes: result.notes ?? [],
  }
}

/**
 * Build the `text_read` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createReadActions(config, logger) {
  return {
    /**
     * Read text off one or more images, or off frames of a video.
     *
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the recognised text and lines.
     */
    async read(args, context) {
      const requested = []
      if (typeof args.target === 'string' && args.target !== '') requested.push(args.target)
      if (Array.isArray(args.paths)) {
        requested.push(...args.paths.filter((path) => typeof path === 'string' && path !== ''))
      }
      if (requested.length === 0) {
        throw new OcrPluginError('text_read read: 需要 "target"（图片或视频）或 "paths"（多张图片）。')
      }
      if (requested.length > MAX_READ_FILES) {
        throw new OcrPluginError(`text_read read: 一次最多 ${MAX_READ_FILES} 个文件，收到 ${requested.length} 个。`)
      }

      const options = readOptions(args, config, logger)
      const results = []
      for (const path of requested) {
        const absolute = pathOf(path, context.cwd)
        if (!existsSync(absolute)) throw new OcrPluginError(`text_read read: 文件不存在：${absolute}`)
        try {
          results.push(await readText(absolute, options))
        } catch (error) {
          if (error instanceof OcrError) throw new OcrPluginError(`text_read read: ${error.message}`)
          throw error
        }
      }

      if (results.length === 1) return { ok: true, ...summarise(results[0]) }
      return { ok: true, count: results.length, files: results.map(summarise) }
    },

    /**
     * Read burned-in subtitles back and compare them with the SRT that specified them.
     *
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the per-cue comparison.
     */
    async verify(args, context) {
      if (typeof args.target !== 'string' || args.target === '') {
        throw new OcrPluginError('text_read verify: 需要 "target"（成片路径）。')
      }
      if (typeof args.srt !== 'string' || args.srt === '') {
        throw new OcrPluginError('text_read verify: 需要 "srt"（字幕文件路径，期望值来自它）。')
      }
      const target = pathOf(args.target, context.cwd)
      if (!existsSync(target)) throw new OcrPluginError(`text_read verify: 文件不存在：${target}`)

      const options = {
        ...readOptions({ ...args, times: undefined, frames: undefined }, config, logger),
        target,
        srtPath: pathOf(args.srt, context.cwd),
        sampleFrames: Number.isFinite(args.sampleFrames) ? args.sampleFrames : undefined,
        leadSeconds: Number.isFinite(args.leadSeconds) ? args.leadSeconds : undefined,
        matchRatio: Number.isFinite(args.matchRatio) ? args.matchRatio : undefined,
        readText,
      }
      const result = await verifySubtitles(options)
      if (result.skipped !== undefined) return { ok: false, ...result }
      if (result.error !== undefined) return { ok: false, ...result }
      return {
        ok: result.failures.length === 0,
        target,
        ...result,
        notes: [
          '相似度是逐字符的最长公共子序列占比，先做全角转半角并去掉标点空白——OCR 读回的是字形，不是 SRT 里的逗号。',
          ...(result.failures.length > 0
            ? [`${result.failures.length}/${result.sampledCues} 条抽样字幕没读回预期文本，逐条看 failures 里的 expected 与 read。`]
            : []),
        ],
      }
    },

    /**
     * Find one or more strings and report where each occurrence is.
     *
     * Matching must see every line the engine produced, including low-confidence ones: a
     * 0.4-score line that says exactly what was asked for is a hit, not noise. That is why this
     * call passes `minScore: 0` and reports `searched` separately.
     *
     * The body lives in {@link findInFile} so `text_find` and `text_read` cannot drift into two
     * different notions of what a match is.
     *
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the matches, in reading order.
     */
    async find(args, context) {
      return findInFile(args, context, config, logger)
    },
  }
}

/**
 * The shared body of `text_find {action:"find"}`.
 *
 * A module-level function rather than a closure so `text_read` and `text_find` cannot drift into
 * two different notions of what a match is.
 *
 * @param {object} args - the tool arguments.
 * @param {object} context - the tool context.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Promise<object>} the matches.
 */
export async function findInFile(args, context, config, logger) {
  if (typeof args.target !== 'string' || args.target === '') {
    throw new OcrPluginError('text_find find: 需要 "target"（要搜索的图片或视频）。')
  }
  const target = pathOf(args.target, context.cwd)
  if (!existsSync(target)) throw new OcrPluginError(`text_find find: 文件不存在：${target}`)

  const needles = (Array.isArray(args.needle) ? args.needle : [args.needle]).filter(
    (needle) => typeof needle === 'string' && needle.trim() !== '',
  )
  if (needles.length === 0) {
    throw new OcrPluginError('text_find find: 需要 "needle"（要查找的文字，可给数组）。')
  }

  const options = { ...readOptions(args, config, logger), minScore: 0 }
  let result
  try {
    result = await readText(target, options)
  } catch (error) {
    if (error instanceof OcrError) throw new OcrPluginError(`text_find find: ${error.message}`)
    throw error
  }

  const matches = findLines(result.lines, needles, { match: args.match })
  return {
    ok: matches.length > 0,
    target,
    engine: result.engine,
    elapsedMs: result.elapsedMs,
    needles,
    lineCount: result.lines.length,
    matchCount: matches.length,
    best: matches[0] ?? null,
    matches,
    searched: result.lines.map((line) => line.text),
    notes: [
      ...(result.notes ?? []),
      ...(matches.length === 0
        ? [
            `没有找到 ${needles.map((needle) => JSON.stringify(needle)).join(' / ')}。` +
              '已识别的每一行都在 searched 里；若目标文字很小，先用 region 只截取它周围一块再试，' +
              '小字在整屏里会被缩小到读不出来。',
          ]
        : []),
    ],
  }
}
