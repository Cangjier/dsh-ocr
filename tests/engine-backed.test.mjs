/**
 * Engine-backed checks: the accuracy claim, the coordinate claim, the video path and the tool
 * surface that fronts them.
 *
 * These need a real OCR engine in `vendor/ocr/`, so they skip cleanly when none is installed —
 * the plugin works without one (Windows' recogniser stands in), and a missing engine must not
 * look like a failing build. When one IS installed, four claims are checked against a rendered
 * image rather than asserted in prose:
 *
 *   1. Small mixed-script text is read correctly. The Windows recogniser reads the very same
 *      kind of line as `TvpeScript`, which is why the offline engine exists.
 *   2. A box reported for a cropped, enlarged copy lands inside the region in the caller's
 *      image. Getting this wrong aims clicks at the wrong place.
 *   3. A video is read frame by frame, and each frame keeps its own results.
 *   4. The same readings come back through the tool surface, with centres a caller can act on.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCjkFont } from '../src/core/env.mjs'
import { run } from '../src/core/ffmpeg.mjs'
import { disposeOcrSessions, findLines, readText, resolveOcrEngine } from '../src/core/engine.mjs'
import { toolDefinitions } from '../src/tools/index.mjs'
import { normalizeConfig } from '../index.mjs'

const config = normalizeConfig({})
const logger = { info() {}, warn() {}, error() {} }
const engine = (() => {
  try {
    return resolveOcrEngine(config)
  } catch {
    return null
  }
})()
const font = findCjkFont()
const skip =
  engine === null
    ? '没有安装离线 OCR 引擎（text_setup {action:"install"}）'
    : font === null
      ? '这台机器上没有可用的 CJK 字体，无法渲染测试用图'
      : false

// A warm engine is a real process: the plugin stops it when it unloads or goes idle, but a test
// process has no such moment, so without this the suite sits here until the idle timer fires.
after(() => {
  disposeOcrSessions()
})

/**
 * Render a still with two lines of text: a Chinese label and small Latin text.
 *
 * The Latin line is deliberately small — that is the case the Windows recogniser fails and this
 * engine has to pass.
 *
 * @param {string} directory - where to write the image and its text files.
 * @returns {Promise<string>} the image path.
 */
async function renderTextImage(directory) {
  writeFileSync(join(directory, 'cn.txt'), '自动化任务', { encoding: 'utf8' })
  writeFileSync(join(directory, 'en.txt'), 'TypeScript 解析', { encoding: 'utf8' })
  const fontArg = font.replace(/\\/g, '/').replace(':', '\\:')
  const filter =
    'drawtext=' +
    `textfile='cn.txt':fontfile='${fontArg}':fontcolor=black:fontsize=44:x=60:y=60,` +
    `drawtext=textfile='en.txt':fontfile='${fontArg}':fontcolor=black:fontsize=22:x=60:y=180`
  const target = join(directory, 'text.png')
  await run({
    tool: 'ffmpeg',
    args: ['-f', 'lavfi', '-i', 'color=c=white:s=900x280', '-vf', filter, '-frames:v', '1', '-update', '1', target],
    cwd: directory,
    config,
    timeoutMs: 120_000,
  })
  return target
}

test('the offline engine reads small Chinese and Latin text off a rendered image', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-engine-'))
  try {
    const image = await renderTextImage(directory)
    const result = await readText(image, { config, engine: 'local' })

    assert.equal(result.engine, 'rapidocr-json')
    assert.equal(result.kind, 'image')
    assert.ok(result.elapsedMs > 0)

    const chinese = findLines(result.lines, '自动化任务')
    assert.equal(chinese.length, 1, `expected the Chinese label, got: ${result.text}`)
    assert.ok(chinese[0].score > 0.8, 'a clean rendered label should be read with high confidence')

    const latin = findLines(result.lines, 'TypeScript')
    assert.equal(latin.length, 1, `expected the Latin label, got: ${result.text}`)
    assert.ok(latin[0].width > 0 && latin[0].height > 0, 'a match must carry a real box')
    assert.ok(latin[0].center.x > 0 && latin[0].center.y > 0, 'a match must carry a clickable centre')
    assert.equal(result.notes.length, 0, 'asking for the local engine must not fall back')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a box read from a cropped, enlarged copy lands in the caller image region', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-region-'))
  try {
    const image = await renderTextImage(directory)
    // The region covers the Latin line only, with room to spare.
    const region = { x: 40, y: 160, width: 500, height: 90 }
    const cropped = await readText(image, { config, engine: 'local', region, scale: 'auto' })

    const latin = findLines(cropped.lines, 'TypeScript')
    assert.equal(latin.length, 1, `expected the Latin label inside the crop, got: ${cropped.text}`)
    const box = latin[0]

    // Back in the caller's coordinates: inside the region, and roughly where the text was drawn
    // (x=60, y=180 in the original image).
    assert.ok(box.x >= region.x && box.x < region.x + region.width, `x ${box.x} is outside the region`)
    assert.ok(box.y >= region.y && box.y < region.y + region.height, `y ${box.y} is outside the region`)
    assert.ok(Math.abs(box.x - 60) < 25, `x ${box.x} should be near the drawn x=60`)
    assert.ok(Math.abs(box.y - 180) < 25, `y ${box.y} should be near the drawn y=180`)
    assert.ok(box.width < region.width, 'the mapped box must not keep the enlarged size')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a video is read frame by frame, each frame keeping its own text', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-video-'))
  try {
    writeFileSync(join(directory, 'cn.txt'), '自动化任务', { encoding: 'utf8' })
    const clip = join(directory, 'clip.mp4')
    const fontArg = font.replace(/\\/g, '/').replace(':', '\\:')
    await run({
      tool: 'ffmpeg',
      args: [
        '-f', 'lavfi', '-i', 'color=c=white:s=640x200:r=5:duration=2',
        '-vf', `drawtext=textfile='cn.txt':fontfile='${fontArg}':fontcolor=black:fontsize=40:x=40:y=70`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip,
      ],
      cwd: directory,
      config,
      timeoutMs: 120_000,
    })

    const result = await readText(clip, { config, engine: 'local', frames: 2 })
    assert.equal(result.kind, 'video')
    assert.equal(result.frames.length, 2)
    assert.ok(result.duration > 1.5)
    for (const frame of result.frames) {
      assert.ok(frame.at >= 0, 'each frame reports the time it was taken from')
      assert.ok(findLines(frame.lines, '自动化任务').length === 1, `frame at ${frame.at}s missed the label`)
    }
    assert.ok(result.lines.every((line) => typeof line.at === 'number'), 'flattened lines keep the frame time')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the tool surface returns the same reading, with a usable centre', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-tools-'))
  try {
    const image = await renderTextImage(directory)
    const definitions = toolDefinitions(config, logger)
    const context = { cwd: directory }
    const name = image.slice(directory.length + 1)

    const read = await definitions.find((definition) => definition.name === 'text_read').execute({ action: 'read', target: name }, context)
    assert.equal(read.ok, true)
    assert.equal(read.kind, 'image')
    assert.equal(read.lineCount, 2)
    assert.ok(read.text.includes('自动化任务'))

    const find = await definitions
      .find((definition) => definition.name === 'text_find')
      .execute({ action: 'find', target: name, needle: 'TypeScript' }, context)
    assert.equal(find.ok, true)
    assert.equal(find.matchCount, 1)
    assert.equal(find.best.text, 'TypeScript 解析')
    assert.ok(find.best.center.x > 0 && find.best.center.y > 0)
    assert.deepEqual(find.searched.length, find.lineCount)

    // The same call through a region, which is the small-text recipe.
    const located = await definitions
      .find((definition) => definition.name === 'text_find')
      .execute({ action: 'find', target: name, needle: 'TypeScript', region: '40,160,500,90', scale: 'auto' }, context)
    assert.equal(located.matchCount, 1)
    assert.ok(located.best.center.y >= 160 && located.best.center.y < 250, 'the centre is in the caller image')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a miss reports what it did see, so a miss can be told from a misread', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-miss-'))
  try {
    const image = await renderTextImage(directory)
    const definitions = toolDefinitions(config, logger)
    const find = await definitions
      .find((definition) => definition.name === 'text_find')
      .execute({ action: 'find', target: image, needle: '这个词不在图上' }, { cwd: directory })

    assert.equal(find.ok, false)
    assert.equal(find.best, null)
    assert.deepEqual(find.matches, [])
    assert.equal(find.searched.length, 2, 'every line that was seen is reported')
    assert.ok(find.notes.some((note) => /没有找到/.test(note)))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a region is ignored by verify, because cropping a film would measure the wrong thing', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-verify-region-'))
  try {
    writeFileSync(join(directory, 'cn.txt'), '给它最小的权限', { encoding: 'utf8' })
    const fontArg = font.replace(/\\/g, '/').replace(':', '\\:')
    const clip = join(directory, 'clip.mp4')
    await run({
      tool: 'ffmpeg',
      args: [
        '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=10:duration=2',
        '-vf', `drawtext=textfile='cn.txt':fontfile='${fontArg}':fontcolor=white:fontsize=36:x=(w-tw)/2:y=h-80`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip,
      ],
      cwd: directory,
      config,
      timeoutMs: 120_000,
    })
    writeFileSync(join(directory, 'subs.srt'), ['1', '00:00:00,200 --> 00:00:01,800', '给它最小的权限', ''].join('\n'), {
      encoding: 'utf8',
    })

    const definitions = toolDefinitions(config, logger)
    // A region that contains none of the subtitle: if it were honoured, the read-back would fail.
    const verify = await definitions
      .find((definition) => definition.name === 'text_read')
      .execute({ action: 'verify', target: 'clip.mp4', srt: 'subs.srt', region: '0,0,80,40', scale: 'auto' }, { cwd: directory })

    assert.equal(verify.ok, true, `region must not reach the reader: ${JSON.stringify(verify.cues)}`)
    assert.ok(verify.minSimilarity >= verify.matchRatio)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('subtitle read-back works end to end on a video with burned subtitles', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ocr-subs-'))
  try {
    writeFileSync(join(directory, 'cn.txt'), '给它最小的权限', { encoding: 'utf8' })
    const fontArg = font.replace(/\\/g, '/').replace(':', '\\:')
    const clip = join(directory, 'clip.mp4')
    await run({
      tool: 'ffmpeg',
      args: [
        '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=10:duration=3',
        '-vf', `drawtext=textfile='cn.txt':fontfile='${fontArg}':fontcolor=white:fontsize=36:x=(w-tw)/2:y=h-80`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip,
      ],
      cwd: directory,
      config,
      timeoutMs: 120_000,
    })

    const srt = join(directory, 'subs.srt')
    writeFileSync(srt, ['1', '00:00:00,200 --> 00:00:02,500', '给它最小的权限', ''].join('\n'), { encoding: 'utf8' })

    const definitions = toolDefinitions(config, logger)
    const verify = await definitions
      .find((definition) => definition.name === 'text_read')
      .execute({ action: 'verify', target: 'clip.mp4', srt: 'subs.srt' }, { cwd: directory })

    assert.equal(verify.error, undefined, `verify failed: ${verify.error ?? ''}`)
    assert.equal(verify.ok, true, `expected the burned line to be read back: ${JSON.stringify(verify.cues)}`)
    assert.equal(verify.sampledCues, 1)
    assert.ok(verify.minSimilarity >= verify.matchRatio)

    // And the same check against a subtitle that is not on the picture.
    const wrong = join(directory, 'wrong.srt')
    writeFileSync(wrong, ['1', '00:00:00,200 --> 00:00:02,500', '完全不相干的一句话在这里', ''].join('\n'), { encoding: 'utf8' })
    const failed = await definitions
      .find((definition) => definition.name === 'text_read')
      .execute({ action: 'verify', target: 'clip.mp4', srt: 'wrong.srt' }, { cwd: directory })
    assert.equal(failed.ok, false)
    assert.equal(failed.failures.length, 1)
    assert.ok(failed.minSimilarity < failed.matchRatio)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
