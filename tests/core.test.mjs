/**
 * Offline checks for the OCR core.
 *
 * Everything here is a pure function: engine answers in, normalised lines out. The parts that
 * need a real engine live in `engine-backed.test.mjs`, because a unit test that cannot run
 * without a 44 MB install stops being a unit test.
 *
 * The one thing worth stating plainly: the arithmetic that maps a box from a cropped, enlarged
 * copy back into the caller's image is the difference between "read the text" and "click the
 * wrong place", so it is tested from several directions rather than once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_TARGET_LONG_SIDE,
  ENGINES,
  OcrError,
  asciiJson,
  describeEngineCode,
  engineState,
  findLines,
  normaliseEngineResult,
  normaliseText,
  parseRegion,
  preprocessFilter,
  resolveOcrEngine,
  resolveScale,
  winrtArguments,
} from '../src/core/engine.mjs'
import { OCR_SOURCES, OCR_VENDOR_DIR, preferredSourceId, pruneLanguages } from '../src/core/install.mjs'

/** A temporary directory the caller is expected to remove. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-ocr-'))
}

test('asciiJson escapes every non-ASCII code point and stays valid JSON', () => {
  const line = asciiJson({ image_path: 'C:\\素材\\截图.png', note: 'café' })
  assert.ok(/^[\x20-\x7e]*$/.test(line), 'serialised JSON must be pure ASCII')
  assert.ok(line.includes('\\u7d20'), 'Chinese must be escaped, not passed through')
  assert.deepEqual(JSON.parse(line), { image_path: 'C:\\素材\\截图.png', note: 'café' })
})

test('engine status codes are explained, including the unknown ones', () => {
  assert.match(describeEngineCode(100, []), /成功/)
  assert.match(describeEngineCode(101, 'No text found in image'), /没有文字/)
  assert.match(describeEngineCode(203, 'Image decode failed'), /无法解码/)
  assert.match(describeEngineCode(203, 'Image decode failed'), /Image decode failed/, 'the engine text must survive')
  assert.match(describeEngineCode(999, ''), /999/)
})

test('a successful answer becomes reading-ordered lines with boxes in source coordinates', () => {
  const raw = {
    code: 100,
    data: [
      // Deliberately out of order, and rotated: the polygon must survive and the sort must fix y.
      { text: 'second', score: 0.91, box: [[120, 210], [220, 210], [220, 240], [120, 240]] },
      { text: 'first', score: 0.99, box: [[20, 40], [140, 40], [140, 70], [20, 72]] },
      { text: '   ', score: 0.99, box: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    ],
  }
  const result = normaliseEngineResult(raw, { offset: { x: 100, y: 50 }, scale: 2, minScore: 0.5 })

  assert.equal(result.code, 100)
  assert.equal(result.lines.length, 2, 'blank text is not a line')
  assert.deepEqual(result.lines.map((line) => line.text), ['first', 'second'])
  // Every coordinate was measured on a 2x copy offset by (100, 50): undo both, divide then add.
  assert.deepEqual(
    { x: result.lines[0].x, y: result.lines[0].y, width: result.lines[0].width, height: result.lines[0].height },
    { x: 110, y: 70, width: 60, height: 16 },
  )
  assert.deepEqual(result.lines[0].box, [[110, 70], [170, 70], [170, 85], [110, 86]])
  assert.deepEqual(result.lines[1].box, [[160, 155], [210, 155], [210, 170], [160, 170]])
  assert.equal(result.text, 'first\nsecond')
})

test('the joined text honours minScore while lines keeps everything', () => {
  const raw = {
    code: 100,
    data: [
      { text: 'keep', score: 0.9, box: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      { text: 'junk', score: 0.2, box: [[0, 20], [10, 20], [10, 30], [0, 30]] },
    ],
  }
  const result = normaliseEngineResult(raw, { minScore: 0.5 })
  assert.equal(result.lines.length, 2, 'a low score is not a reason to hide a line')
  assert.equal(result.dropped, 1)
  assert.equal(result.text, 'keep')
})

test('an empty image is a result, a failure is an error', () => {
  assert.deepEqual(normaliseEngineResult({ code: 101, data: 'No text found' }), {
    code: 101,
    lines: [],
    text: '',
    dropped: 0,
  })
  assert.throws(() => normaliseEngineResult({ code: 203, data: 'Image decode failed' }), (error) => {
    assert.ok(error instanceof OcrError)
    assert.match(error.message, /无法解码/)
    assert.match(error.message, /Image decode failed/)
    return true
  })
  assert.throws(() => normaliseEngineResult({ code: 100, data: null }), /没有结果数组/)
})

test('matching ignores case and the spaces engines insert between CJK glyphs', () => {
  assert.equal(normaliseText(' 音 频 ABC '), '音频abc')

  const lines = [
    { text: '自 动 化 任 务', score: 0.9, x: 10, y: 20, width: 100, height: 20 },
    { text: '自动化任务', score: 0.8, x: 10, y: 60, width: 80, height: 18 },
    { text: 'TypeScript 解析', score: 0.95, x: 10, y: 100, width: 200, height: 22 },
  ]

  const contains = findLines(lines, '自动化任务')
  assert.equal(contains.length, 2, 'spacing must not hide a match')
  assert.deepEqual(contains[0].center, { x: 60, y: 30 })
  assert.equal(contains[0].needle, '自动化任务')

  const exact = findLines(lines, '自动化任务', { match: 'exact' })
  assert.equal(exact.length, 2, 'spacing is normalised before comparing, so both spellings are the whole line')
  assert.deepEqual(exact.map((match) => match.score), [0.9, 0.8])
  assert.equal(findLines(lines, '自动化', { match: 'exact' }).length, 0, '"exact" means the whole line, not a prefix')

  const many = findLines(lines, ['typescript', 'nothing here'])
  assert.equal(many.length, 1, 'unknown needles simply do not match')
  assert.equal(many[0].text, 'TypeScript 解析')
  assert.deepEqual(findLines(lines, []), [])
  assert.deepEqual(findLines(lines, '   '), [])
})

test('a region is accepted as an object or as a string, and refuses nonsense', () => {
  assert.deepEqual(parseRegion({ x: 10, y: 20, width: 30, height: 40 }), { x: 10, y: 20, width: 30, height: 40 })
  assert.deepEqual(parseRegion(' 10, 20 ,30,40 '), { x: 10, y: 20, width: 30, height: 40 })
  assert.deepEqual(parseRegion({ x: -5, y: -5, width: 10, height: 10 }).x, 0, 'a negative origin clamps at the edge')
  assert.equal(parseRegion(undefined), null)
  assert.equal(parseRegion(''), null)
  assert.throws(() => parseRegion('10,20,30'), /x,y,width,height/)
  assert.throws(() => parseRegion({ width: 0, height: 10 }), /width 与 height/)
  assert.throws(() => parseRegion(42), /必须是对象/)
})

test('the preprocess filter crops first, then enlarges', () => {
  assert.equal(preprocessFilter({}), '')
  assert.equal(preprocessFilter({ region: { x: 1, y: 2, width: 30, height: 40 } }), 'crop=30:40:1:2')
  assert.equal(preprocessFilter({ scale: 2 }), 'scale=iw*2:ih*2:flags=lanczos')
  assert.equal(
    preprocessFilter({ region: { x: 0, y: 0, width: 10, height: 10 }, scale: 3 }),
    'crop=10:10:0:0,scale=iw*3:ih*3:flags=lanczos',
  )
  assert.throws(() => preprocessFilter({ region: { width: 0, height: 10 } }), /width 与 height/)
})

test('automatic scaling enlarges small images only, and never past three times', () => {
  assert.equal(resolveScale({ scale: 'auto', width: 200, height: 100 }), 3, 'a tiny crop is grown as far as allowed')
  assert.equal(resolveScale({ scale: 'auto', width: AUTO_TARGET_LONG_SIDE, height: 400 }), 1)
  assert.equal(resolveScale({ scale: 'auto', width: 4000, height: 2000 }), 1, 'a big image is left alone')
  assert.equal(resolveScale({ scale: 'auto', width: 0, height: 0 }), 1, 'unknown dimensions change nothing')
  assert.equal(resolveScale({ scale: 2.5 }), 2.5)
  assert.equal(resolveScale({ scale: 'nonsense' }), 1)
})

test('an explicitly configured engine is described from the files beside it', () => {
  const directory = scratch()
  try {
    const home = join(directory, 'RapidOCR-json_v0.2.0')
    mkdirSync(join(home, 'models'), { recursive: true })
    for (const name of [
      'RapidOCR-json.exe',
      'ch_PP-OCRv4_det_infer.onnx',
      'ch_ppocr_mobile_v2.0_cls_infer.onnx',
      'rec_ch_PP-OCRv4_infer.onnx',
      'dict_chinese.txt',
    ]) {
      writeFileSync(join(home, name === 'RapidOCR-json.exe' ? name : join('models', name)), 'x')
    }

    const engine = resolveOcrEngine(
      { ocr: { enginePath: join(home, 'RapidOCR-json.exe') } },
      { language: 'ch', maxSideLen: 1024 },
    )
    assert.equal(engine.kind, 'rapidocr-json')
    assert.equal(engine.source, 'config')
    assert.equal(engine.cwd, home)
    assert.ok(engine.args.includes('--models=models'))
    assert.ok(engine.args.includes('--rec=rec_ch_PP-OCRv4_infer.onnx'), 'the v4 recogniser must be preferred when present')
    assert.ok(engine.args.includes('--keys=dict_chinese.txt'))
    assert.ok(engine.args.includes('--maxSideLen=1024'))

    // An engine whose name says nothing must not be guessed at silently.
    writeFileSync(join(home, 'mystery-engine.exe'), 'x')
    assert.throws(
      () => resolveOcrEngine({ ocr: { enginePath: join(home, 'mystery-engine.exe') } }),
      /无法判断 OCR 引擎类型/,
    )
    // …unless the caller says which family it is.
    const forced = resolveOcrEngine({ ocr: { enginePath: join(home, 'mystery-engine.exe'), kind: 'rapidocr-json' } })
    assert.equal(forced.kind, 'rapidocr-json')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the paddle package gets the switches its config file needs', () => {
  const directory = scratch()
  try {
    const home = join(directory, 'PaddleOCR-json')
    mkdirSync(join(home, 'models', 'PP-OCRv5_mobile_det_infer'), { recursive: true })
    writeFileSync(join(home, 'PaddleOCR-json.exe'), 'x')
    writeFileSync(join(home, 'models', 'config_universal.txt'), 'det_model_dir models/PP-OCRv5_mobile_det_infer\n')

    const engine = resolveOcrEngine({ ocr: { enginePath: join(home, 'PaddleOCR-json.exe') } }, { maxSideLen: 960 })
    assert.equal(engine.kind, 'paddleocr-json')
    assert.ok(engine.args.includes('-config_path=models/config_universal.txt'))
    assert.ok(engine.args.includes('-limit_side_len=960'))
    assert.ok(engine.args.includes('-cls=true'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('every installable source is pinned and consistent with the client', () => {
  const ids = Object.keys(OCR_SOURCES)
  assert.ok(ids.length >= 2)
  assert.ok(ids.includes('rapidocr-json'))

  for (const [id, source] of Object.entries(OCR_SOURCES)) {
    assert.match(source.url, /^https:\/\/github\.com\//, `${id} must come from a release download, not a moving branch`)
    assert.match(source.sha256, /^[0-9a-f]{64}$/, `${id} needs a pinned sha256`)
    assert.ok(source.bytes > 1_000_000, `${id} should know how large its package is`)
    assert.ok(typeof source.license === 'string' && source.license.length > 0, `${id} must state its licence`)
    assert.ok(source.measured.length > 0, `${id} must record what was measured, not what is hoped`)

    const engine = ENGINES[source.kind]
    assert.ok(engine, `${id} names engine family ${source.kind}, which the client does not know`)
    for (const name of source.executables) {
      assert.ok(engine.executables.includes(name), `${id}: ${name} is not one of ${source.kind}'s executables`)
    }
  }
})

test('pruning keeps the Simplified Chinese recogniser and drops the rest', () => {
  const directory = scratch()
  try {
    const models = join(directory, 'models')
    mkdirSync(models, { recursive: true })
    const files = [
      'RapidOCR-json.exe',
      'models/ch_PP-OCRv4_det_infer.onnx',
      'models/ch_ppocr_mobile_v2.0_cls_infer.onnx',
      'models/rec_ch_PP-OCRv4_infer.onnx',
      'models/dict_chinese.txt',
      'models/rec_japan_PP-OCRv3_infer.onnx',
      'models/rec_korean_PP-OCRv3_infer.onnx',
      'models/dict_japan.txt',
      'models/dict_korean.txt',
    ]
    for (const file of files) writeFileSync(join(directory, file), 'x')

    const removed = pruneLanguages(directory)
    assert.deepEqual(
      removed.sort(),
      ['dict_japan.txt', 'dict_korean.txt', 'rec_japan_PP-OCRv3_infer.onnx', 'rec_korean_PP-OCRv3_infer.onnx'],
    )
    for (const file of ['models/ch_PP-OCRv4_det_infer.onnx', 'models/rec_ch_PP-OCRv4_infer.onnx', 'models/dict_chinese.txt']) {
      assert.ok(existsSync(join(directory, file)), `${file} must survive pruning`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the WinRT helper never receives a non-numeric scale', () => {
  const helper = (options, dimensions) => {
    const args = winrtArguments('shot.png', options, dimensions)
    const index = args.indexOf('-Scale')
    return index === -1 ? null : args[index + 1]
  }

  assert.equal(helper({ scale: 'auto' }, { width: 200, height: 100 }), '3', 'a small capture is enlarged')
  assert.equal(helper({ scale: 'auto' }, { width: 4000, height: 2000 }), null, 'a big capture is left alone')
  assert.equal(helper({ scale: 2 }), '2')
  assert.equal(helper({ scale: 1 }), null, 'no enlargement means no switch at all')
  assert.equal(helper({ scale: 'auto', region: { x: 0, y: 0, width: 100, height: 50 } }), '3', 'a small region decides on its own size')
  assert.equal(helper({ scale: 'auto', region: { x: 0, y: 0, width: 900, height: 400 } }), null)

  const region = winrtArguments('shot.png', { region: { x: 1.4, y: 2.6, width: 30.2, height: 40.7 } })
  assert.deepEqual(region.slice(-2), ['-Region', '1,3,30,41'], 'the helper takes integers, so they are rounded here')
  assert.ok(winrtArguments('shot.png', { language: 'zh-Hans-CN' }).includes('zh-Hans-CN'))
})

test('the preferred source is always one the installer knows', () => {
  const id = preferredSourceId({})
  assert.ok(OCR_SOURCES[id] !== undefined, `${id} is not an installable source`)
  const requested = preferredSourceId({ ocr: { source: 'paddleocr-ppocrv5' } })
  assert.ok(['paddleocr-ppocrv5', 'rapidocr-json'].includes(requested), 'a source that is not installed falls back, never breaks')
})

test('engine state is read from the disk, not from the manifest', () => {
  const state = engineState()
  // The engine is optional, so this asserts the shape rather than a presence: a machine without
  // one must still get a well-formed answer instead of an exception.
  assert.equal(typeof state.present, 'boolean')
  assert.equal(typeof state.files, 'number')
  assert.equal(typeof state.sizeBytes, 'number')
  assert.equal(state.directory, OCR_VENDOR_DIR)
  assert.ok(Array.isArray(state.engines))
  if (state.present) assert.ok(state.engines.length > 0, 'a present directory with files must name at least one engine')
})
