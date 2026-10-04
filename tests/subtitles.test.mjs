/**
 * Offline checks for the subtitle read-back.
 *
 * The comparison is the part that decides whether a delivery is acceptable, so it is tested
 * against the two failure modes that actually occur: a missing or wrong glyph (which must score
 * below the threshold) and a frame full of unrelated interface text behind a perfectly legible
 * subtitle (which must not).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MATCH_RATIO,
  normaliseSubtitleText,
  parseSrt,
  pickCues,
  textSimilarity,
  verifySubtitles,
} from '../src/core/subtitles.mjs'

/** A temporary directory the caller is expected to remove. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-ocr-srt-'))
}

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  '跑通你的第一个任务。',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  '给它最小的权限，',
  '',
  '3',
  '00:00:07,500 --> 00:00:09,000',
  '现在去官网下载',
  '',
].join('\n')

test('an SRT is parsed forgivingly, because a foreign one is still a specification', () => {
  const cues = parseSrt(SRT)
  assert.equal(cues.length, 3)
  assert.deepEqual(cues[0], { index: 1, start: 1, end: 3, text: '跑通你的第一个任务。' })
  assert.equal(cues[2].start, 7.5)

  // A BOM, CRLF, a missing cue number, a dot separator and stray spaces around the arrow.
  const messy = '\uFEFF1\r\n00:00:01.500 -->  00:00:02.250\r\n第一句\r\n\r\n第二句（没有序号）'
  const parsed = parseSrt(messy)
  assert.equal(parsed.length, 1, 'a block with no time line is skipped rather than fatal')
  assert.equal(parsed[0].start, 1.5)
  assert.equal(parsed[0].end, 2.25)

  assert.deepEqual(parseSrt(''), [])
  assert.deepEqual(parseSrt('1\n\n'), [])
  assert.deepEqual(parseSrt(null), [])
})

test('normalisation makes an OCR read-back comparable with the SRT it came from', () => {
  assert.equal(normaliseSubtitleText('给它最小的权限，'), '给它最小的权限')
  assert.equal(normaliseSubtitleText('ＡＢ　Ｃ'), 'abc')
  assert.equal(normaliseSubtitleText('Hello, World!'), 'helloworld')
})

test('similarity measures a wrong glyph, not a different sentence', () => {
  assert.equal(textSimilarity('跑通你的第一个任务。', '跑通你的第一个任务'), 1)
  // One wrong character inside eight: the LCS still finds seven of them, so the score stays
  // high — well above the 0.6 threshold, which is the point. A tracker that failed on a single
  // misread glyph would be unusable.
  const oneWrong = textSimilarity('跑通你的第一个任务', '跑通你的第一个住所')
  assert.ok(oneWrong > DEFAULT_MATCH_RATIO && oneWrong < 1, `one wrong glyph should still clear the threshold, got ${oneWrong}`)
  assert.ok(textSimilarity('现在去官网下载', '完全不相干的一句话') < 0.3)
  assert.equal(textSimilarity('现在去官网下载', ''), 0)
  assert.equal(textSimilarity('', ''), 1)
})

test('the cues read back are spread through the file, and always include the last one', () => {
  const cues = Array.from({ length: 12 }, (_, index) => ({ index: index + 1, start: index, end: index + 1, text: `c${index}` }))
  const picked = pickCues(cues, 4)
  assert.equal(picked.length, 4)
  assert.equal(picked[picked.length - 1], cues[cues.length - 1], 'a track that stops early is the defect worth catching')
  assert.deepEqual(pickCues(cues, 100).length, 12, 'asking for more cues than exist reads them all')
  assert.deepEqual(pickCues([cues[0]], 6), [cues[0]])
})

test('a read-back is compared against the best line, not against the whole frame', async () => {
  const directory = scratch()
  try {
    const srt = join(directory, 'subs.srt')
    writeFileSync(srt, SRT, { encoding: 'utf8' })

    const readText = async (_target, options) => ({
      kind: 'video',
      engine: 'rapidocr-json',
      frames: options.times.map((at, index) => ({
        at,
        engine: 'rapidocr-json',
        // Every frame carries a screenful of unrelated interface text plus the subtitle itself.
        text: `文件  编辑  查看\n${['跑通你的第一个任务', '给它最小的权限', '现在去官网下载'][index]}`,
        lines: [
          { text: '文件  编辑  查看', score: 0.99, x: 0, y: 0, width: 300, height: 20 },
          { text: ['跑通你的第一个任务', '给它最小的权限', '现在去官网下载'][index], score: 0.97, x: 0, y: 800, width: 500, height: 40 },
        ],
      })),
    })

    const result = await verifySubtitles({ target: 'ignored.mp4', srtPath: srt, readText, sampleFrames: 3 })
    assert.equal(result.engine, 'rapidocr-json')
    assert.equal(result.sampledCues, 3)
    assert.equal(result.totalCues, 3)
    assert.equal(result.failures.length, 0, 'interface text behind a legible subtitle must not fail it')
    assert.ok(result.minSimilarity >= DEFAULT_MATCH_RATIO)
    assert.equal(result.cues[0].matchedLine, 'line')
    assert.equal(result.cues[0].matched, '跑通你的第一个任务')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a cue that did not reach the screen is reported as a failure', async () => {
  const directory = scratch()
  try {
    const srt = join(directory, 'subs.srt')
    writeFileSync(srt, SRT, { encoding: 'utf8' })

    const result = await verifySubtitles({
      target: 'ignored.mp4',
      srtPath: srt,
      sampleFrames: 3,
      readText: async (_target, options) => ({
        kind: 'video',
        engine: 'rapidocr-json',
        frames: options.times.map((at) => ({
          at,
          engine: 'rapidocr-json',
          // Only the first cue made it onto the picture.
          text: '跑通你的第一个任务',
          lines: [{ text: '跑通你的第一个任务', score: 0.97, x: 0, y: 800, width: 500, height: 40 }],
        })),
      }),
    })

    assert.equal(result.failures.length, 2)
    assert.deepEqual(result.failures.map((row) => row.expected), ['给它最小的权限，', '现在去官网下载'])
    assert.equal(result.cues[0].ok, true)
    assert.equal(result.cues[1].ok, false)
    assert.ok(result.minSimilarity < DEFAULT_MATCH_RATIO)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a wrapped subtitle matches as a pair of lines', async () => {
  const directory = scratch()
  try {
    const srt = join(directory, 'subs.srt')
    writeFileSync(srt, ['1', '00:00:01,000 --> 00:00:03,000', '给它最小的权限，', ''].join('\n'), { encoding: 'utf8' })

    const result = await verifySubtitles({
      target: 'ignored.mp4',
      srtPath: srt,
      readText: async (_target, options) => ({
        kind: 'video',
        engine: 'rapidocr-json',
        frames: options.times.map((at) => ({
          at,
          engine: 'rapidocr-json',
          text: '给它最小的\n权限',
          lines: [
            { text: '给它最小的', score: 0.9, x: 0, y: 800, width: 300, height: 40 },
            { text: '权限', score: 0.9, x: 0, y: 845, width: 120, height: 40 },
          ],
        })),
      }),
    })

    assert.equal(result.failures.length, 0)
    assert.equal(result.cues[0].matchedLine, 'pair')
    assert.equal(result.cues[0].matched, '给它最小的权限')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('nothing to measure is reported as a reason, never as a pass', async () => {
  const directory = scratch()
  try {
    const missing = await verifySubtitles({ target: 'x.mp4', srtPath: join(directory, 'nope.srt'), readText: async () => ({}) })
    assert.match(missing.skipped, /不存在/)

    const noSrt = await verifySubtitles({ target: 'x.mp4', readText: async () => ({}) })
    assert.match(noSrt.skipped, /没有给字幕文件/)

    const empty = join(directory, 'empty.srt')
    writeFileSync(empty, 'not an srt at all', { encoding: 'utf8' })
    const unparsed = await verifySubtitles({ target: 'x.mp4', srtPath: empty, readText: async () => ({}) })
    assert.match(unparsed.skipped, /没有解析出任何一条字幕/)

    const noReader = await verifySubtitles({ target: 'x.mp4', srtPath: empty })
    assert.match(noReader.skipped, /读取实现/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failing engine is reported as an error rather than an empty pass', async () => {
  const directory = scratch()
  try {
    const srt = join(directory, 'subs.srt')
    writeFileSync(srt, SRT, { encoding: 'utf8' })
    const result = await verifySubtitles({
      target: 'ignored.mp4',
      srtPath: srt,
      readText: async () => {
        throw new Error('OCR 的输入不存在：ignored.mp4\n更多细节在第二行')
      },
    })
    assert.equal(result.error, 'OCR 的输入不存在：ignored.mp4', 'only the first line is kept: it is the actionable one')
    assert.deepEqual(result.cues, [])
    assert.equal(result.minSimilarity, null)
    // An empty cue list looks like a pass to a careless caller, which is exactly why `error` exists.
    assert.equal(result.ok, undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
