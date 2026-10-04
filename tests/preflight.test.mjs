/**
 * Checks for the pre-flight check and the environment-fault vocabulary.
 *
 * Two claims are worth testing, and both are the reason this module exists:
 *
 *   1. **A fault is named, not just reported.** "退出码 3221225781" is a number; "缺少运行库 DLL"
 *      is something a caller can act on. The mapping is a pure function, so it is tested directly
 *      rather than through a machine that happens to be broken in one particular way.
 *   2. **A degraded call says so.** An image read while the engine is unusable must come back with
 *      the fault attached, not merely with a friendlier `notes` line — that is the difference
 *      between "Windows read this" and "the engine read this".
 *
 * The engine that is started here is a deliberately broken one under a temporary directory, so no
 * test in this file needs a 73 MB install, and none of them can pass by accident on the author's
 * machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OCR_FAULTS,
  OcrEnvironmentError,
  describeEngineFailure,
  ocrReport,
  readText,
  resolveOcrEngine,
} from '../src/core/engine.mjs'
import { environmentSummary, preflightOcr } from '../src/core/preflight.mjs'
import { toolDefinitions } from '../src/tools/index.mjs'
import { normalizeConfig } from '../index.mjs'

const logger = { info() {}, warn() {}, error() {} }

/** A temporary directory the caller is expected to remove. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-ocr-preflight-'))
}

/**
 * Lay out an engine directory that looks installed, with whatever models are asked for.
 *
 * @param {string} directory - where to build it.
 * @param {string[]} models - model file names to create under `models/`.
 * @returns {string} the executable path.
 */
function fakeEngine(directory, models) {
  mkdirSync(join(directory, 'models'), { recursive: true })
  const executable = join(directory, 'RapidOCR-json.exe')
  writeFileSync(executable, 'RapidOCR-json.exe')
  for (const name of models) writeFileSync(join(directory, 'models', name), 'x')
  return executable
}

/** A config that points the plugin at one explicit engine, so nothing on the host can interfere. */
function configFor(enginePath) {
  const config = normalizeConfig({})
  return { ...config, ocr: { ...config.ocr, enginePath } }
}

/** A 1x1 white PNG, so the fallback recogniser has a real picture to decode. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('a launch failure becomes a named fault, whatever shape the OS reported it in', () => {
  // The Windows NTSTATUS codes an engine launch actually produces.
  assert.equal(describeEngineFailure({ code: 0xc0000135 }).code, 'runtime-missing')
  assert.equal(describeEngineFailure({ code: 3221225781 }).code, 'runtime-missing', 'the code arrives unsigned')
  assert.equal(describeEngineFailure({ code: 0xc000001d }).code, 'unsupported-cpu')
  assert.equal(describeEngineFailure({ code: 0xc000007b }).code, 'runtime-missing')
  assert.equal(describeEngineFailure({ code: 0xc0000005 }).code, 'engine-crashed')
  assert.match(describeEngineFailure({ code: 0xc000001d }).reason, /AVX/)

  // Spawn errors: the process never started, so the model files cannot be the cause.
  assert.equal(describeEngineFailure({ code: 'ENOENT' }).code, 'engine-missing')
  assert.equal(describeEngineFailure({ code: 'UNKNOWN', models: { missing: ['rec.onnx'] } }).code, 'cannot-execute')
  assert.equal(describeEngineFailure({ code: 'EACCES' }).code, 'cannot-execute')

  // Text is consulted only when there is no code to trust.
  assert.equal(describeEngineFailure({ stderr: 'VCRUNTIME140.dll was not found' }).code, 'runtime-missing')
  assert.equal(describeEngineFailure({ stderr: 'fail to load model file' }).code, 'models-missing')
  assert.equal(
    describeEngineFailure({ code: 1, models: { missing: ['rec_ch_PP-OCRv4_infer.onnx'] } }).code,
    'models-missing',
    'a process that ran and a file that is absent is the one case the model list decides',
  )
  assert.equal(describeEngineFailure({ code: 1 }).code, 'engine-crashed')
  assert.equal(describeEngineFailure({}).code, 'engine-missing')

  for (const code of ['runtime-missing', 'unsupported-cpu', 'models-missing', 'cannot-execute']) {
    assert.ok(OCR_FAULTS[code].label.length > 0, `${code} needs a label a caller can read`)
    assert.ok(OCR_FAULTS[code].hint.length > 0, `${code} needs a hint that says what to do`)
  }
})

test('an environment fault carries its code, its reason and what to do about it', () => {
  const error = new OcrEnvironmentError('models-missing', '缺少 rec.onnx', { engine: 'rapidocr-json', executable: 'C:/x/RapidOCR-json.exe' })
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'OcrEnvironmentError')
  assert.equal(error.code, 'models-missing')
  assert.match(error.message, /models-missing/)
  assert.match(error.message, /怎么办/)

  const fault = error.toFault()
  assert.equal(fault.code, 'models-missing')
  assert.equal(fault.engine, 'rapidocr-json')
  assert.equal(fault.reason, '缺少 rec.onnx')
  assert.ok(fault.label.length > 0 && fault.hint.length > 0)
  assert.ok(!('detail' in fault), 'an absent detail is omitted rather than reported as null')
})

test('the model files this client would pass are checked against what is on disk', () => {
  const directory = scratch()
  try {
    const complete = fakeEngine(join(directory, 'complete'), [
      'ch_PP-OCRv4_det_infer.onnx',
      'ch_ppocr_mobile_v2.0_cls_infer.onnx',
      'rec_ch_PP-OCRv4_infer.onnx',
      'dict_chinese.txt',
    ])
    const full = resolveOcrEngine(configFor(complete), { language: 'ch' })
    assert.deepEqual(full.models.missing, [])
    assert.ok(full.models.required.includes('rec_ch_PP-OCRv4_infer.onnx'))

    const partial = fakeEngine(join(directory, 'partial'), ['ch_PP-OCRv4_det_infer.onnx', 'dict_chinese.txt'])
    const short = resolveOcrEngine(configFor(partial), { language: 'ch' })
    assert.deepEqual(short.models.missing, ['rec_ch_PP-OCRv4_infer.onnx'], 'the named language decides which recogniser is required')

    // A different language asks for a different recogniser and dictionary, and says so.
    const japanese = resolveOcrEngine(configFor(partial), { language: 'japan' })
    assert.ok(japanese.models.missing.includes('rec_japan_PP-OCRv3_infer.onnx'))
    assert.ok(japanese.models.missing.includes('dict_japan.txt'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a configured engine that has gone missing is a fault, not a silent substitution', () => {
  const directory = scratch()
  try {
    const gone = join(directory, 'moved', 'RapidOCR-json.exe')
    assert.throws(
      () => resolveOcrEngine(configFor(gone)),
      (error) => {
        assert.ok(error instanceof OcrEnvironmentError)
        assert.equal(error.code, 'engine-missing')
        assert.match(error.message, /enginePath/)
        return true
      },
    )

    // `status` is a diagnostic: it reports the fault rather than failing on it.
    const report = ocrReport(configFor(gone))
    assert.equal(report.available, false)
    assert.equal(report.fault.code, 'engine-missing')
    assert.match(report.note, /text_setup/)

    // The cheap activation summary reports it too, and never throws.
    const summary = environmentSummary(configFor(gone))
    assert.equal(summary.verdict, 'degraded')
    assert.equal(summary.fault.code, 'engine-missing')
    assert.ok(summary.message.length > 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preflight starts the engine, and an engine that cannot run is reported, not thrown', async () => {
  const directory = scratch()
  try {
    const broken = fakeEngine(join(directory, 'broken'), ['ch_PP-OCRv4_det_infer.onnx', 'dict_chinese.txt'])
    // A file that is named like the engine but is not an executable image: the launch fails the
    // way a corrupted download or a quarantined binary fails, and nothing about the models is
    // to blame — which is exactly what the fault must say.
    const report = await preflightOcr(configFor(broken), {})

    assert.equal(report.engine.available, true)
    assert.equal(report.engine.models.missing.length, 1)
    assert.equal(report.engine.start.attempted, true)
    assert.equal(report.engine.start.ok, false)
    assert.ok(report.engine.start.elapsedMs >= 0)
    assert.ok(['cannot-execute', 'runtime-missing', 'engine-crashed', 'models-missing'].includes(report.engine.start.fault.code))
    assert.ok(report.engine.start.fault.reason.length > 0)

    assert.deepEqual(
      report.checks.map((check) => check.id),
      ['platform', 'winrt-fallback', 'engine-installed', 'models-present', 'engine-starts', 'ffmpeg'],
    )
    assert.equal(report.checks.find((check) => check.id === 'engine-starts').ok, false)
    assert.equal(report.checks.find((check) => check.id === 'models-present').ok, false)

    // On Windows the shipped WinRT wrapper is the fallback, so this machine can still read text.
    const fallback = process.platform === 'win32'
    assert.equal(report.verdict, fallback ? 'degraded' : 'unusable')
    assert.equal(report.ok, fallback)
    assert.equal(report.fallback.winrt, fallback)
    assert.ok(report.notes.some((note) => /引擎装在那里但起不来/.test(note)))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preflight with start:false inspects files without starting anything', async () => {
  const directory = scratch()
  try {
    const engine = fakeEngine(join(directory, 'engine'), [
      'ch_PP-OCRv4_det_infer.onnx',
      'rec_ch_PP-OCRv4_infer.onnx',
      'dict_chinese.txt',
    ])
    const report = await preflightOcr(configFor(engine), { start: false })
    assert.deepEqual(report.engine.models.missing, [])
    assert.equal(report.engine.start.attempted, false)
    assert.equal(report.engine.start.ok, null)
    assert.equal(report.checks.find((check) => check.id === 'engine-starts').detail, '未尝试启动')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a read that falls back because of an environment fault says so on the result', async () => {
  const directory = scratch()
  try {
    const image = join(directory, 'one.png')
    writeFileSync(image, ONE_PIXEL_PNG)
    const result = await readText(image, { config: configFor(join(directory, 'gone.exe')), engine: 'auto' })

    assert.equal(result.engine, 'winrt', 'the fallback still answers — the machine is not broken')
    assert.equal(result.fault.code, 'engine-missing')
    assert.ok(result.fault.hint.length > 0)
    assert.ok(
      result.notes.some((note) => /离线引擎不可用（engine-missing/.test(note)),
      'the note must name the fault, not merely say the engine was unavailable',
    )

    // …and asking for the engine explicitly refuses rather than degrading.
    await assert.rejects(
      () => readText(image, { config: configFor(join(directory, 'gone.exe')), engine: 'local' }),
      (error) => {
        assert.equal(error.code, 'engine-missing')
        return true
      },
    )

    // The same fault has to survive the tool layer, where the message is what a model reads and
    // the code is what a caller can branch on.
    const broken = toolDefinitions(configFor(join(directory, 'gone.exe')), logger)
    const tool = broken.find((definition) => definition.name === 'text_read')
    await assert.rejects(
      () => tool.execute({ action: 'read', target: image, engine: 'local' }, { cwd: directory }),
      (error) => {
        assert.equal(error.code, 'engine-missing')
        assert.match(error.message, /engine-missing/)
        return true
      },
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preflight is reachable as a text_setup action, and only there', async () => {
  const definitions = toolDefinitions(normalizeConfig({}), logger)
  const setup = definitions.find((definition) => definition.name === 'text_setup')
  assert.deepEqual(setup.parameters.properties.action.enum, ['status', 'probe', 'preflight', 'install', 'remove'])

  const read = definitions.find((definition) => definition.name === 'text_read')
  await assert.rejects(() => read.execute({ action: 'preflight' }, { cwd: process.cwd() }), /unknown action/)
})
