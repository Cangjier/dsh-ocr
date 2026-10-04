/**
 * Reading text — and where it sits — off a still image or frames of a video.
 *
 * ## Two engines, one contract
 *
 * The vendored engines are separate programs with the same shape: a persistent child that reads
 * `{"image_path": "..."}` lines on stdin and answers one JSON object per line on stdout. One
 * client therefore speaks to both:
 *
 * | engine           | runtime          | models    | measured on the development machine |
 * | ---------------- | ---------------- | --------- | ----------------------------------- |
 * | `rapidocr-json`  | ONNX Runtime     | PP-OCRv4  | init 0.33 s, 1.77 s / 1200x1013 screenshot, avg score 0.929 |
 * | `paddleocr-json` | Paddle Inference | PP-OCRv5  | init 0.42 s, 15.9 s / same screenshot, avg score 0.833 |
 *
 * The ONNX build is the default because it is nine times faster here and its scores were higher
 * on the same image; the Paddle build is offered for the cases where the newer model generation
 * wins on some small text. The numbers above are measurements, not estimates.
 *
 * ## Windows' own recogniser is the fallback, not the default
 *
 * Windows ships `Windows.Media.Ocr`, wrapped in `src/bin/ocr.ps1`. It answers in about 200 ms
 * and needs nothing installed, but it cannot read data out of an image: on a real 1200x1013
 * screenshot it read `TypeScript` as `TvpeScript`, `执行` as `执 彳 亍`, and `自动化任务` as
 * `自 动 化 亻 壬 务`. That is fine for finding a large labelled button and useless for
 * extracting text, so it stays the zero-install fallback and a real engine does the work when
 * one is installed.
 *
 * ## Coordinates
 *
 * Every engine result carries a four-point box per text line. This module reduces that to an
 * axis-aligned rectangle **in the coordinates of the file the caller named**, undoing any crop
 * and upscale it applied itself. That single rule is what makes the same call usable for both
 * jobs: read the text, and know where to click.
 *
 * @module dsh-ocr/core/engine
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PLUGIN_ROOT } from './env.mjs'
import { FfmpegNotFound, run } from './ffmpeg.mjs'
import { classify, probe } from './probe.mjs'
import { OCR_VENDOR_DIR, OCR_SOURCES, preferredSourceId } from './install.mjs'

/** Where a vendored engine lives. Re-exported so a caller can inspect it without a second import. */
export { OCR_VENDOR_DIR }

/** The WinRT wrapper script, kept as the no-install fallback. */
export const OCR_SCRIPT = resolve(PLUGIN_ROOT, 'src', 'bin', 'ocr.ps1')

/** The action that installs an engine, named in every message that reports one missing. */
export const INSTALL_HINT = 'text_setup {action:"install"}'

/**
 * Scratch directory for the cropped/upscaled copies and extracted frames this module makes.
 *
 * Outside the plugin tree on purpose: a linked install may live in a read-only or version
 * controlled directory, and scratch files are not something a plugin should be writing into its
 * own source. Each file is removed as soon as its reading is done, and the directory is
 * cleaned up on the way out, so this never accumulates.
 */
export const OCR_TMP_DIR = join(tmpdir(), 'dsh-ocr')

/** Default long-side limit handed to the engine. 1024 measured better than 960 on screenshots. */
export const DEFAULT_MAX_SIDE_LEN = 1024

/**
 * Long side `scale: "auto"` aims for, in pixels.
 *
 * The RapidOCR project ships `limit_type: min` with `limit_side_len: 736` for exactly this
 * reason: a small crop of 11 px UI text has to be enlarged before a detector can find it.
 */
export const AUTO_TARGET_LONG_SIDE = 1000

/** Default patience for one recognition. The Paddle build needs tens of seconds on a busy machine. */
export const DEFAULT_TIMEOUT_MS = 180_000

/** Lines below this score are dropped from the joined `text`, but never from `lines`. */
export const DEFAULT_MIN_SCORE = 0.5

/** Stop an idle engine so a ~500 MB resident process does not outlive the work. */
export const IDLE_SHUTDOWN_MS = 120_000

/** Model load takes well under a second; a minute of silence means the engine will never answer. */
export const INIT_TIMEOUT_MS = 60_000

/** How an OCR call chooses an engine. */
export const ENGINE_PREFERENCES = ['auto', 'local', 'winrt']

/** Raised when OCR cannot be carried out. */
export class OcrError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OcrError'
  }
}

/**
 * The environment faults this plugin can tell apart, and what each one means for the caller.
 *
 * The distinction that matters is not "which error" but "whose problem": everything here is a
 * property of the machine, not of the picture being read, and every one of them has a different
 * fix. They are named because the alternative is what this vocabulary replaced — a fallback to
 * the Windows recogniser whose only trace was a note, which reads as a successful call.
 */
export const OCR_FAULTS = {
  'no-engine': {
    label: '没有安装离线 OCR 引擎',
    hint: `运行 ${INSTALL_HINT} 安装一个（约 73MB，解包后约 44MB），或明确用 engine:"winrt" 接受 Windows 自带识别的精度。`,
  },
  'engine-missing': {
    label: '引擎可执行文件不存在',
    hint: '配置里的 enginePath 指向的文件已经不在，或 vendor/ocr 下的安装被移走。用 text_setup {action:"status"} 看现在会走哪一个，然后重装或修正路径。',
  },
  'cannot-execute': {
    label: '引擎可执行文件无法运行',
    hint: '文件损坏、被杀软/EDR 拦截，或权限不足。重装引擎；装了杀软就把 vendor/ocr 目录加进白名单。',
  },
  'runtime-missing': {
    label: '引擎启动时缺少运行库 DLL',
    hint: '引擎依赖的运行库没装或版本不符（常见是 VC++ 运行库，或杀软隔离了 DLL）。装上对应运行库，或改用 rapidocr-json（它只依赖 ONNX Runtime 自带的 DLL）。',
  },
  'unsupported-cpu': {
    label: 'CPU 不支持该引擎要求的指令集',
    hint: 'paddleocr-ppocrv5 要求 AVX。换用 rapidocr-json，或换一台支持 AVX 的机器。',
  },
  'models-missing': {
    label: '引擎缺少模型文件',
    hint: `安装没有解压完整。运行 ${INSTALL_HINT.replace('}', ', force:true}')} 重装（带 prune 时只保留简中模型）。`,
  },
  'init-timeout': {
    label: '引擎没有在限定时间内完成初始化',
    hint: '首次加载模型很慢或进程卡住。看 detail 里的引擎输出；确认模型文件完整，并检查杀软是否在扫描它。',
  },
  'engine-crashed': {
    label: '引擎进程崩溃或提前退出',
    hint: '看 detail 里的引擎输出尾部，那是它自己的抱怨。重装引擎通常能解决解压不完整导致的崩溃。',
  },
  'ffmpeg-missing': {
    label: '缺少 ffmpeg / ffprobe',
    hint: `只有裁剪放大（region / scale）和视频抽帧需要它们。把它们放进 vendor/ffmpeg/bin/，设置 DSH_OCR_FFMPEG / DSH_OCR_FFPROBE，或用 text_setup {action:"install", ffmpeg:true} 装一份。`,
  },
  'not-windows': {
    label: '当前平台不是 Windows',
    hint: '两个离线引擎都是 Windows 可执行文件，零安装回退是 WinRT。',
  },
  unusable: {
    label: '离线引擎和 Windows 自带识别都不可用',
    hint: `先修好其中之一：${INSTALL_HINT}，或让 Windows 的 OCR 组件可用。`,
  },
}

/** Windows NTSTATUS exit codes that a failed engine launch actually produces, and what they mean. */
const WINDOWS_EXIT_FAULTS = new Map([
  [0xc0000135, { code: 'runtime-missing', reason: '进程缺少运行库 DLL（STATUS_DLL_NOT_FOUND，0xC0000135）' }],
  [0xc000007b, { code: 'runtime-missing', reason: '依赖的 DLL 架构不符或已损坏（STATUS_INVALID_IMAGE_FORMAT，0xC000007B）' }],
  [0xc000001d, { code: 'unsupported-cpu', reason: 'CPU 不支持该引擎要求的指令集（STATUS_ILLEGAL_INSTRUCTION，0xC000001D，通常是 AVX）' }],
  [0xc0000005, { code: 'engine-crashed', reason: '引擎在启动时访问冲突（0xC0000005）' }],
  [0xc0000409, { code: 'engine-crashed', reason: '引擎被系统的堆栈保护终止（0xC0000409）' }],
])

/**
 * Raised when the machine, not the picture, is why OCR cannot be done.
 *
 * It carries a machine-readable `code` from {@link OCR_FAULTS} plus the observed reason, so a
 * caller can act on it: `auto` reports it in the result as `fault`, `local` fails with it, and
 * `text_setup {action:"preflight"}` returns the same shape as data.
 */
export class OcrEnvironmentError extends OcrError {
  /**
   * @param {string} code - one of {@link OCR_FAULTS}, or `unusable`.
   * @param {string} reason - what was actually observed, in the words of this machine.
   * @param {object} [context] - `{ engine, executable, detail, hint }`.
   */
  constructor(code, reason, context = {}) {
    const known = OCR_FAULTS[code] ?? { label: code, hint: '' }
    const hint = context.hint ?? known.hint
    super(
      [
        `OCR 环境问题（${code}，${known.label}）：${reason}`,
        context.detail ? `引擎输出（尾部）：\n${context.detail}` : null,
        hint ? `怎么办：${hint}` : null,
      ]
        .filter((line) => line !== null && line !== '')
        .join('\n'),
    )
    this.name = 'OcrEnvironmentError'
    this.code = code
    this.reason = reason
    this.engine = context.engine ?? null
    this.executable = context.executable ?? null
    this.detail = context.detail ?? null
    this.hint = hint
  }

  /**
   * The plain, model-facing form of this fault — the same shape `preflight` returns.
   * @returns {{code: string, label: string, engine: string|null, executable: string|null, reason: string, hint: string, detail?: string}} the fault.
   */
  toFault() {
    return {
      code: this.code,
      label: OCR_FAULTS[this.code]?.label ?? this.code,
      engine: this.engine,
      executable: this.executable,
      reason: this.reason,
      hint: this.hint,
      ...(this.detail ? { detail: this.detail } : {}),
    }
  }
}

/**
 * The fault for "no offline engine at all".
 *
 * This is the one condition here that is a *supported configuration* rather than a broken
 * machine — the Windows recogniser is always there — so the wording says where it looked rather
 * than implying something failed. Written once because `status`, `preflight` and the activation
 * log all report it, and three spellings of one fact is how a diagnostic starts to disagree with
 * itself.
 *
 * @returns {{code: string, label: string, engine: null, executable: null, reason: string, hint: string}} the fault.
 */
export function noEngineFault() {
  return {
    code: 'no-engine',
    label: OCR_FAULTS['no-engine'].label,
    engine: null,
    executable: null,
    reason: 'vendor/ocr 下没有离线引擎，PATH 里也没有 RapidOCR-json / PaddleOCR-json',
    hint: OCR_FAULTS['no-engine'].hint,
  }
}

/**
 * Turn what a failed engine launch actually said into a named fault.
 *
 * Pure, and tested directly, because this is the difference between "退出码 3221225781" and
 * "缺少运行库 DLL": the first tells a caller nothing it can act on. The exit-code table comes
 * first because it is exact; stderr is only consulted when there is no code to trust.
 *
 * @param {object} [failure] - the observation.
 * @param {number|string|null} [failure.code] - the process exit code, or a spawn error code.
 * @param {string} [failure.stderr] - what the engine wrote before it died.
 * @param {string|null} [failure.engine] - the engine family.
 * @param {string|null} [failure.executable] - the executable path.
 * @param {{missing: string[]}|null} [failure.models] - the model files found to be absent.
 * @returns {{code: string, reason: string}} a code from {@link OCR_FAULTS} and why.
 */
export function describeEngineFailure(failure = {}) {
  const code = failure.code ?? null
  const stderr = String(failure.stderr ?? '')
  const numeric = typeof code === 'number' && Number.isFinite(code) ? code >>> 0 : null

  const known = numeric === null ? undefined : WINDOWS_EXIT_FAULTS.get(numeric)
  if (known !== undefined) return { ...known }

  const missing = Array.isArray(failure.models?.missing) ? failure.models.missing : []
  if (/avx|illegal instruction|不支持的指令/i.test(stderr)) {
    return { code: 'unsupported-cpu', reason: '引擎报错提示 CPU 指令集不受支持（可能是 AVX）' }
  }
  if (/\.dll|cannot find|找不到指定|无法加载|not a valid win32/i.test(stderr)) {
    return { code: 'runtime-missing', reason: '引擎输出提到缺少或无法加载 DLL' }
  }
  // A spawn error means the process was never created, so nothing was loaded and the model files
  // have nothing to do with it: the executable itself is the problem. This is checked before the
  // model list because a launch failure is the more specific fact of the two.
  if (typeof code === 'string') {
    if (code === 'ENOENT') return { code: 'engine-missing', reason: '可执行文件不存在（ENOENT）' }
    if (code === 'UNKNOWN') {
      return { code: 'cannot-execute', reason: '可执行文件无法加载（文件损坏、缺少依赖 DLL，或被安全软件拦截）' }
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { code: 'cannot-execute', reason: `可执行文件无法运行（${code}：权限被拒绝或被安全软件拦截）` }
    }
    return { code: 'cannot-execute', reason: `引擎进程无法启动（${code}）` }
  }
  if (missing.length > 0) {
    return { code: 'models-missing', reason: `引擎缺少模型文件：${missing.join('、')}` }
  }
  if (/model|模型/i.test(stderr)) {
    return { code: 'models-missing', reason: '引擎输出提到模型文件（model）' }
  }
  if (numeric !== null) {
    return { code: 'engine-crashed', reason: `引擎启动失败（退出码 ${numeric}，0x${numeric.toString(16)}）` }
  }
  return { code: 'engine-missing', reason: '引擎进程无法启动，且没有退出码可判断原因' }
}

/**
 * The engine families this client knows how to start.
 *
 * `executables` are tried in order; `argsFor` turns a discovered layout into the process
 * arguments. Both engines take the same stdin protocol, so nothing below this table is
 * engine-specific except the switch names.
 */
export const ENGINES = {
  'rapidocr-json': {
    label: 'RapidOCR-json（ONNX Runtime，PP-OCRv4 模型）',
    executables: ['RapidOCR-json.exe', 'RapidOCR_json.exe'],
    argsFor: (layout, options) => rapidArgs(layout, options),
  },
  'paddleocr-json': {
    label: 'PaddleOCR-json（Paddle Inference，PP-OCRv5/v4 模型）',
    executables: ['PaddleOCR-json.exe', 'PaddleOCR_json.exe'],
    argsFor: (layout, options) => paddleArgs(layout, options),
  },
}

/** Recogniser files per language, for the RapidOCR package layout. */
export const RAPID_LANGUAGES = {
  ch: { rec: 'rec_ch_PP-OCRv4_infer.onnx', keys: 'dict_chinese.txt' },
  cht: { rec: 'rec_chinese_cht_PP-OCRv3_infer.onnx', keys: 'dict_chinese_cht.txt' },
  en: { rec: 'rec_en_PP-OCRv3_infer.onnx', keys: 'dict_chinese.txt' },
  japan: { rec: 'rec_japan_PP-OCRv3_infer.onnx', keys: 'dict_japan.txt' },
  korean: { rec: 'rec_korean_PP-OCRv3_infer.onnx', keys: 'dict_korean.txt' },
  cyrillic: { rec: 'rec_cyrillic_PP-OCRv3_infer.onnx', keys: 'dict_cyrillic.txt' },
}

/**
 * Build the RapidOCR-json argument list from the files that actually exist.
 *
 * The package's own `cmd.txt` names `ch_PP-OCRv4_rec_infer.onnx`, which is not the file it
 * ships (`rec_ch_PP-OCRv4_infer.onnx`). Arguments are therefore assembled from real paths and
 * anything missing is simply left at the engine's default rather than passed as a broken name.
 *
 * @param {object} layout - `{ modelsDir, has: (name: string) => boolean }`.
 * @param {object} options - recognition options.
 * @returns {string[]} engine arguments.
 */
function rapidArgs(layout, options) {
  const args = []
  if (layout.modelsDir !== null) args.push(`--models=${layout.modelsDir}`)

  const det = ['ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv3_det_infer.onnx'].find((name) => layout.has(name))
  if (det !== undefined) args.push(`--det=${det}`)
  if (layout.has('ch_ppocr_mobile_v2.0_cls_infer.onnx')) args.push('--cls=ch_ppocr_mobile_v2.0_cls_infer.onnx')

  const language = RAPID_LANGUAGES[options.language] ?? RAPID_LANGUAGES.ch
  if (layout.has(language.rec)) args.push(`--rec=${language.rec}`)
  if (layout.has(language.keys)) args.push(`--keys=${language.keys}`)

  if (options.maxSideLen !== undefined) args.push(`--maxSideLen=${options.maxSideLen}`)
  // The angle classifier is worth its cost on screenshots rotated by a phone camera or a
  // sideways dialog; it is the direction vote that must be turned on with it.
  const angle = options.angleCls === false ? 0 : 1
  args.push(`--doAngle=${angle}`, `--mostAngle=${angle}`)
  if (options.threads !== undefined) args.push(`--numThread=${options.threads}`)
  return args
}

/**
 * Build the PaddleOCR-json argument list.
 *
 * Its package always loads a language config file that in turn names model directories relative
 * to the process working directory, so the config path is the one thing that must be passed.
 *
 * @param {object} layout - `{ configPath, has: (name: string) => boolean }`.
 * @param {object} options - recognition options.
 * @returns {string[]} engine arguments.
 */
function paddleArgs(layout, options) {
  const args = []
  if (layout.configPath !== null) args.push(`-config_path=${layout.configPath}`)
  if (options.maxSideLen !== undefined) args.push(`-limit_side_len=${options.maxSideLen}`)
  const angle = options.angleCls === false ? 'false' : 'true'
  args.push(`-cls=${angle}`, `-use_angle_cls=${angle}`)
  if (options.threads !== undefined) args.push(`-cpu_threads=${options.threads}`)
  return args
}

/**
 * List files under a directory, at most `depth` levels deep.
 *
 * A configured engine path may point into a large application directory, so the walk gives up
 * after `limit` entries: this looks for executables and model files, and an install large
 * enough to exceed the cap is not one whose contents we should be enumerating anyway.
 *
 * @param {string} root - directory to walk.
 * @param {number} depth - remaining levels to descend.
 * @param {number} [limit] - stop after this many files.
 * @returns {string[]} absolute file paths.
 */
function walkFiles(root, depth, limit = 2000) {
  const found = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (found.length >= limit) return found
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0) found.push(...walkFiles(path, depth - 1, limit - found.length))
      continue
    }
    found.push(path)
  }
  return found
}

/**
 * The files an engine needs on disk before it can read anything.
 *
 * This is a *static* check, and it is deliberately reported as a shortfall rather than a verdict:
 * a recogniser the caller did not name may still be present under the engine's own default, so
 * "missing" here means "the file this client would pass is not there". What decides whether the
 * engine really works is starting it — which is what `text_setup {action:"preflight"}` does.
 *
 * @param {'rapidocr-json'|'paddleocr-json'} kind - the engine family.
 * @param {{has: (name: string) => boolean}} layout - the files found beside the executable.
 * @param {object} [recognition] - recognition options; `language` selects the recogniser.
 * @returns {{required: string[], missing: string[]}} the file names, and those absent.
 */
export function modelRequirements(kind, layout, recognition = {}) {
  if (kind === 'rapidocr-json') {
    const detector = ['ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv3_det_infer.onnx'].find((name) => layout.has(name))
    const language = RAPID_LANGUAGES[recognition.language] ?? RAPID_LANGUAGES.ch
    // The preferred detector name is what gets reported when neither version is present.
    const required = [detector ?? 'ch_PP-OCRv4_det_infer.onnx', language.rec, language.keys]
    return { required, missing: required.filter((name) => !layout.has(name)) }
  }
  if (kind === 'paddleocr-json') {
    // The Paddle package names its model directories inside this config file, so its absence is
    // the only thing that can be seen from the outside; the engine validates the rest itself.
    const required = ['config_universal.txt']
    return { required, missing: required.filter((name) => !layout.has(name)) }
  }
  return { required: [], missing: [] }
}

/**
 * Describe one installed (or explicitly configured) engine.
 *
 * @param {object} candidate - the candidate.
 * @param {string} candidate.executable - absolute path to the engine executable.
 * @param {'rapidocr-json'|'paddleocr-json'} candidate.kind - which family it belongs to.
 * @param {'config'|'vendor'|'path'} candidate.source - where it was found.
 * @param {object} [recognition] - recognition options, used to freeze the argument list later.
 * @returns {object} the engine descriptor.
 */
function describeEngine({ executable, kind, source }, recognition = {}) {
  const home = dirname(executable)
  // The models directory sits beside the executable in both packages, but the Paddle build
  // keeps its config one level down, under `models/`.
  const files = walkFiles(home, 3)
  const names = new Set(files.map((path) => path.split(/[\\/]/).pop()))
  const has = (name) => names.has(name)
  const modelsDir = files.find((path) => /[\\/]models[\\/]/.test(path))
  const layout = {
    home,
    executable,
    kind,
    source,
    configPath: has('config_universal.txt') ? 'models/config_universal.txt' : null,
    modelsDir: modelsDir === undefined ? null : 'models',
    has,
  }
  return {
    kind,
    label: ENGINES[kind].label,
    executable,
    cwd: home,
    source,
    modelsDir: layout.modelsDir === null ? null : join(home, 'models'),
    models: modelRequirements(kind, layout, recognition),
    args: ENGINES[kind].argsFor(layout, recognition),
  }
}

/**
 * Report what the vendored engine directory holds, without starting anything.
 *
 * `present` means an engine executable is there — the only fact that decides whether the vendored
 * copy can read anything. A directory that holds only a leftover manifest is reported as absent,
 * with `files` showing that something is in it anyway.
 *
 * @returns {{present: boolean, directory: string, engines: string[], files: number, sizeBytes: number}} the state.
 */
export function engineState() {
  if (!existsSync(OCR_VENDOR_DIR)) {
    return { present: false, directory: OCR_VENDOR_DIR, engines: [], files: 0, sizeBytes: 0 }
  }
  const files = walkFiles(OCR_VENDOR_DIR, 4)
  const engines = []
  let sizeBytes = 0
  for (const path of files) {
    const base = path.split(/[\\/]/).pop()
    for (const [kind, engine] of Object.entries(ENGINES)) {
      if (engine.executables.includes(base) && !engines.includes(kind)) engines.push(kind)
    }
    try {
      sizeBytes += statSync(path).size
    } catch {
      // A file that vanished mid-listing simply does not count.
    }
  }
  return { present: engines.length > 0, directory: OCR_VENDOR_DIR, engines, files: files.length, sizeBytes }
}

/**
 * Locate an OCR engine.
 *
 * Precedence: explicit configuration, then the vendored builds (the manifest's active one
 * first), then PATH — because a vendored engine is what makes the result the same on every
 * machine while a PATH engine keeps a developer's own install usable.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} [options] - recognition options that affect the argument list.
 * @returns {object|null} an engine descriptor, or null when none is installed.
 * @throws {OcrEnvironmentError} when a configured engine path no longer exists.
 * @throws {OcrError} when a configured engine cannot be classified.
 */
export function resolveOcrEngine(config, options = {}) {
  const explicit = config?.ocr?.enginePath
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const path = resolve(explicit)
    // A configured path that has gone missing is a *stated intent that cannot be honoured*.
    // Falling through to the vendored engine here would answer from an engine the caller did not
    // ask for, which is exactly the kind of silent substitution this plugin refuses.
    if (!existsSync(path)) {
      throw new OcrEnvironmentError('engine-missing', `config.ocr.enginePath 指向的文件不存在：${path}`, {
        executable: path,
      })
    }
    const kind = kindOf(path, config?.ocr?.kind)
    if (kind === null) {
      throw new OcrError(
        `无法判断 OCR 引擎类型：${path}\n` +
          '请把它命名为 PaddleOCR-json.exe / RapidOCR-json.exe，或显式设置 config.ocr.kind。',
      )
    }
    return describeEngine({ executable: path, kind, source: 'config' }, options)
  }

  // The vendored engines live one directory per source, and the manifest names the active one:
  // without that, two installed engines would make the choice depend on directory order.
  const preferred = preferredSourceId(config)
  const ordered = [preferred, ...Object.keys(OCR_SOURCES).filter((id) => id !== preferred)]
  for (const id of ordered) {
    const source = OCR_SOURCES[id]
    for (const name of source?.executables ?? []) {
      const candidate = join(OCR_VENDOR_DIR, id, name)
      if (existsSync(candidate)) {
        return describeEngine({ executable: candidate, kind: source.kind ?? id, source: 'vendor' }, options)
      }
    }
  }
  // A hand-placed engine, or a source this version no longer lists, still has to work.
  if (existsSync(OCR_VENDOR_DIR)) {
    for (const path of walkFiles(OCR_VENDOR_DIR, 4)) {
      const kind = kindOf(path)
      if (kind !== null) return describeEngine({ executable: path, kind, source: 'vendor' }, options)
    }
  }

  const entries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const [kind, engine] of Object.entries(ENGINES)) {
    for (const entry of entries) {
      if (entry.trim() === '') continue
      for (const name of engine.executables) {
        const candidate = join(entry, name)
        if (existsSync(candidate)) return describeEngine({ executable: candidate, kind, source: 'path' }, options)
      }
    }
  }
  return null
}

/**
 * Classify a path as one of the known engines by its file name.
 * @param {string} path - a candidate executable path.
 * @param {string} [forced] - an explicitly configured engine family.
 * @returns {'rapidocr-json'|'paddleocr-json'|null} the engine family.
 */
function kindOf(path, forced) {
  if (typeof forced === 'string' && ENGINES[forced] !== undefined) return forced
  return kindOfName(path.split(/[\\/]/).pop())
}

/**
 * Classify a file name as one of the known engines.
 * @param {string} name - a bare file name.
 * @returns {'rapidocr-json'|'paddleocr-json'|null} the engine family.
 */
function kindOfName(name) {
  for (const [kind, engine] of Object.entries(ENGINES)) {
    if (engine.executables.includes(name)) return kind
  }
  return null
}

/**
 * A short, model-facing summary of OCR availability.
 *
 * @param {object} config - normalized plugin config.
 * @returns {object} the report used by `text_setup {action:"status"}`.
 */
export function ocrReport(config) {
  const state = engineState()
  const configured = typeof config?.ocr?.enginePath === 'string' && config.ocr.enginePath !== ''
  const report = {
    vendored: state,
    configuredPath: configured ? config.ocr.enginePath : null,
    prefer: config?.ocr?.defaultEngine ?? 'auto',
    winrtFallback: existsSync(OCR_SCRIPT),
  }

  let engine = null
  try {
    engine = resolveOcrEngine(config)
  } catch (error) {
    // A diagnostic must not fail on the fault it exists to report.
    if (!(error instanceof OcrEnvironmentError)) throw error
    report.available = false
    report.fault = error.toFault()
    report.note =
      `${error.reason}。识别会退回 Windows 自带的 WinRT 引擎（中文小字与中英混排会出错）。${error.hint}`
    return report
  }

  if (engine === null) {
    report.available = false
    report.fault = noEngineFault()
    report.note =
      '没有可用的离线 OCR 引擎，识别会退回 Windows 自带的 WinRT 引擎（中文小字与中英混排会出错）。' +
      `运行 ${INSTALL_HINT} 下载并解包一个高精度引擎（约 73MB，解包后约 44MB）。`
    return report
  }
  report.available = true
  report.kind = engine.kind
  report.label = engine.label
  report.executable = engine.executable
  report.source = engine.source
  report.args = engine.args
  report.models = engine.models
  return report
}

/* ------------------------------------------------------------------ *
 * The persistent engine session
 * ------------------------------------------------------------------ */

/** Live sessions, keyed by executable plus arguments, so repeated calls reuse a warm process. */
const sessions = new Map()

/**
 * One running engine process.
 *
 * The engine is started once and asked many times: model load dominates the cold cost (0.33 s
 * for the ONNX build, 0.42 s for the Paddle build), and the process exits after an idle period
 * so a resident 500 MB engine does not outlive the work that needed it.
 */
class EngineSession {
  /**
   * @param {object} engine - an engine descriptor from {@link resolveOcrEngine}.
   * @param {object} [options] - `{ timeoutMs, idleMs, onLog }`.
   */
  constructor(engine, options = {}) {
    this.engine = engine
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.idleMs = options.idleMs ?? IDLE_SHUTDOWN_MS
    this.onLog = options.onLog
    this.child = null
    this.reader = null
    this.ready = null
    this.pending = null
    this.idleTimer = null
    this.stderrTail = []
    this.queue = Promise.resolve()
  }

  /** @returns {void} */
  start() {
    if (this.child !== null) return
    let child
    try {
      child = spawn(this.engine.executable, this.engine.args, {
        cwd: this.engine.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      // Windows raises some launch failures synchronously (a corrupt image reports `spawn
      // UNKNOWN` through a throw rather than an `error` event). Both roads must end in the same
      // named fault, or the diagnosis depends on which one the OS chose.
      this.child = null
      this.ready = Promise.reject(this.#launchError(error?.code ?? 'UNKNOWN', false))
      this.ready.catch(() => undefined)
      return
    }
    this.child = child
    this.stderrTail = []

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue
        this.stderrTail.push(line.trim())
        if (this.stderrTail.length > 20) this.stderrTail.shift()
      }
    })

    this.ready = new Promise((resolveReady, rejectReady) => {
      let settled = false
      this.reader = createInterface({ input: child.stdout })
      this.reader.on('line', (line) => {
        const text = line.trim()
        if (text.startsWith('{')) {
          try {
            this.#resolve(JSON.parse(text))
            return
          } catch {
            // A banner that merely starts with a brace is not a result; fall through.
          }
        }
        if (!settled && text.includes('OCR init completed')) {
          settled = true
          resolveReady()
        }
      })
      child.on('error', (error) => {
        if (!settled) {
          settled = true
          rejectReady(this.#launchError(error.code ?? 'UNKNOWN', false))
        }
        this.#fail(this.#launchError(error.code ?? 'UNKNOWN', true))
      })
      child.on('close', (code) => {
        // A close before the banner means the engine died on startup: the arguments or the
        // model files are wrong, and the process' own complaint is the useful part.
        if (!settled) {
          settled = true
          rejectReady(this.#launchError(code, true))
        }
        const wasRunning = this.child === child
        this.child = null
        this.reader?.close()
        this.reader = null
        if (wasRunning) {
          this.#fail(this.#launchError(code, true))
        }
      })
      // The engine announces itself on stdout. Model load takes well under a second on both
      // engines, so a minute of silence means it is not going to answer at all.
      setTimeout(() => {
        if (settled) return
        settled = true
        rejectReady(
          new OcrEnvironmentError('init-timeout', `引擎在 ${Math.round(INIT_TIMEOUT_MS / 1000)} 秒内没有完成初始化`, {
            engine: this.engine.kind,
            executable: this.engine.executable,
            detail: this.stderrTail.slice(-8).join('\n'),
          }),
        )
      }, INIT_TIMEOUT_MS).unref?.()
    })
  }

  /**
   * Name the fault behind a failed launch, from the exit code and what the engine wrote.
   *
   * @param {number|string|null} code - the exit code, or the spawn error code.
   * @param {boolean} launched - whether the OS actually started the process. A process that never
   *   started cannot have been stopped by a missing model file, so that suspicion is only raised
   *   for one that did.
   * @returns {OcrEnvironmentError} the fault, ready to throw.
   */
  #launchError(code, launched) {
    const detail = this.stderrTail.slice(-8).join('\n')
    const failure = describeEngineFailure({
      code,
      stderr: detail,
      engine: this.engine.kind,
      executable: this.engine.executable,
      models: launched ? this.engine.models : null,
    })
    return new OcrEnvironmentError(failure.code, failure.reason, {
      engine: this.engine.kind,
      executable: this.engine.executable,
      detail,
    })
  }

  /**
   * Start the process and wait until it announces that it is ready.
   *
   * The one place readiness is waited for, so a preflight and a real recognition cannot disagree
   * about what "the engine started" means.
   *
   * @returns {Promise<void>} resolves once the engine can answer.
   * @throws {OcrEnvironmentError} when it cannot be started.
   */
  async ensureReady() {
    this.start()
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    await this.ready
    this.#scheduleIdle()
  }

  /**
   * Hand a result to whoever is waiting for it.
   * @param {object} value - the parsed engine answer.
   * @returns {void}
   */
  #resolve(value) {
    const pending = this.pending
    this.pending = null
    if (pending !== null) {
      clearTimeout(pending.timer)
      pending.resolve(value)
    }
  }

  /**
   * Fail the in-flight request, if any.
   * @param {Error} error - what to reject with.
   * @returns {void}
   */
  #fail(error) {
    const pending = this.pending
    this.pending = null
    if (pending !== null) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  /**
   * Recognise one image file.
   *
   * Calls are serialised: the protocol is one request, one answer line, so two overlapping
   * writes would make the answers indistinguishable.
   *
   * @param {string} imagePath - absolute path to an image the engine can decode.
   * @returns {Promise<object>} the engine's parsed answer.
   */
  async recognise(imagePath) {
    const runOne = this.queue.then(() => this.#ask(imagePath))
    // Keep the chain alive after a failure: one bad image must not poison every later call.
    this.queue = runOne.then(
      () => undefined,
      () => undefined,
    )
    return runOne
  }

  /**
   * @param {string} imagePath - the image to read.
   * @returns {Promise<object>} the parsed answer.
   */
  async #ask(imagePath) {
    await this.ensureReady()

    const child = this.child
    if (child === null || child.stdin === null) throw new OcrError('OCR 引擎没有可用的输入通道')

    const answer = new Promise((resolveAnswer, rejectAnswer) => {
      const timer = setTimeout(() => {
        this.pending = null
        // A hung engine is not recoverable in place: kill it so the next call starts clean.
        this.dispose()
        rejectAnswer(
          new OcrError(
            `OCR 识别超时（${Math.round(this.timeoutMs / 1000)} 秒）：${imagePath}\n` +
              '大图或低配机器请调小 config.ocr.maxSideLen，或用 region 只识别需要的区域。',
          ),
        )
      }, this.timeoutMs)
      timer.unref?.()
      this.pending = { resolve: resolveAnswer, reject: rejectAnswer, timer }
    })

    // Non-ASCII paths are escaped rather than sent literally: the engine's JSON parser accepts
    // \uXXXX on every Windows code page, which removes an entire class of mojibake report.
    child.stdin.write(`${asciiJson({ image_path: imagePath })}\n`)
    const result = await answer
    this.#scheduleIdle()
    return result
  }

  /** @returns {void} */
  #scheduleIdle() {
    if (this.idleMs <= 0) return
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.dispose(), this.idleMs)
    this.idleTimer.unref?.()
  }

  /** Stop the process and release its memory. @returns {void} */
  dispose() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const child = this.child
    this.child = null
    this.pending = null
    this.reader?.close()
    this.reader = null
    if (child !== null) {
      try {
        child.stdin?.end()
        child.kill()
      } catch {
        // Killing an already-dead process is not an error worth reporting.
      }
    }
  }
}

/**
 * Serialise a value as ASCII-only JSON.
 *
 * `JSON.stringify` leaves non-ASCII characters literal, which is fine over UTF-8 pipes in
 * theory and a known source of mojibake in practice. Escaping every code point above 0x7f costs
 * a few bytes and removes the failure mode entirely.
 *
 * @param {object} value - the object to serialise.
 * @returns {string} one line of JSON, ASCII only.
 */
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0')
    return `\\u${code}`
  })
}

/**
 * Get, or start, the session for one engine.
 * @param {object} engine - an engine descriptor.
 * @param {object} [options] - `{ timeoutMs, idleMs }`.
 * @returns {EngineSession} the session.
 */
function sessionFor(engine, options = {}) {
  const key = [engine.executable, ...engine.args].join('\u0000')
  let session = sessions.get(key)
  if (session === undefined) {
    session = new EngineSession(engine, options)
    sessions.set(key, session)
  }
  return session
}

/** Stop every engine process this module started. @returns {void} */
export function disposeOcrSessions() {
  for (const session of sessions.values()) session.dispose()
  sessions.clear()
}

/**
 * Start an engine and wait for it to announce that it is ready, without recognising anything.
 *
 * This is the check a file listing cannot make. A missing VC++ runtime, a DLL quarantined by an
 * antivirus, a model that did not finish unpacking and a CPU without AVX all look identical from
 * the outside — the executable is there, the directory has files — and all four only become
 * visible when the process is actually started. It never throws: the fault is the return value.
 *
 * @param {object} engine - an engine descriptor from {@link resolveOcrEngine}.
 * @param {object} [options] - `{ config, timeoutMs, idleMs }`.
 * @returns {Promise<{attempted: boolean, ok: boolean, engine: string, executable: string, elapsedMs: number, fault?: object}>} the outcome.
 */
export async function checkEngineStartup(engine, options = {}) {
  const started = Date.now()
  const session = sessionFor(engine, {
    timeoutMs: options.timeoutMs ?? options.config?.ocr?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    idleMs: options.idleMs ?? options.config?.ocr?.idleMs ?? IDLE_SHUTDOWN_MS,
  })
  try {
    await session.ensureReady()
    return {
      attempted: true,
      ok: true,
      engine: engine.kind,
      executable: engine.executable,
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    const base = { engine: engine.kind, executable: engine.executable }
    const fault =
      error instanceof OcrEnvironmentError
        ? error.toFault()
        : {
            code: 'engine-crashed',
            label: OCR_FAULTS['engine-crashed'].label,
            ...base,
            reason: error instanceof Error ? error.message : String(error),
            hint: OCR_FAULTS['engine-crashed'].hint,
          }
    return { attempted: true, ok: false, ...base, elapsedMs: Date.now() - started, fault }
  }
}

/* ------------------------------------------------------------------ *
 * Results: one shape, and the arithmetic that puts boxes back where they belong
 * ------------------------------------------------------------------ */

/**
 * Explain an engine status code in terms a caller can act on.
 * @param {number} code - the engine's `code`.
 * @param {*} data - the engine's `data`, a string on failures.
 * @returns {string} a Chinese explanation.
 */
export function describeEngineCode(code, data) {
  const detail = typeof data === 'string' ? `（引擎原文：${data}）` : ''
  const table = {
    100: '识别成功',
    101: '图片里没有文字',
    200: `图片路径不存在${detail}`,
    201: `图片路径无法转换为 UTF-16${detail}`,
    202: `图片存在但打不开，通常是权限问题${detail}`,
    203: `图片无法解码，可能不是图片或已损坏${detail}`,
    299: `引擎内部未知错误${detail}`,
    300: `Base64 内容无法解析${detail}`,
    301: `Base64 内容无法解码为图片${detail}`,
    400: `引擎解析输入 JSON 失败${detail}`,
    401: `引擎输出无法编码为 JSON${detail}`,
    402: `引擎解析输入字段失败${detail}`,
    403: `输入里没有有效任务${detail}`,
  }
  return table[code] ?? `引擎返回未知状态码 ${code}${detail}`
}

/**
 * Turn one engine answer into the shape the rest of the plugin uses.
 *
 * Pure: no process, no disk. `offset` and `scale` undo whatever {@link prepareImage} did, so a
 * box is always reported in the coordinates of the file the caller named — the single rule that
 * keeps "read the text" and "click the label" from disagreeing.
 *
 * @param {object} raw - the parsed engine answer.
 * @param {object} [options] - mapping options.
 * @param {{x: number, y: number}} [options.offset] - top-left of the crop, in source pixels.
 * @param {number} [options.scale] - how much the image was enlarged before recognition.
 * @param {number} [options.minScore] - score below which a line's text is excluded from `text`.
 * @returns {{code: number, lines: object[], text: string, dropped: number}} normalised result.
 * @throws {OcrError} when the engine reports a failure.
 */
export function normaliseEngineResult(raw, options = {}) {
  const code = Number(raw?.code)
  if (code === 101) return { code, lines: [], text: '', dropped: 0 }
  if (code !== 100) throw new OcrError(`OCR 失败：${describeEngineCode(code, raw?.data)}`)
  if (!Array.isArray(raw?.data)) {
    throw new OcrError(`OCR 返回了成功状态却没有结果数组：${JSON.stringify(raw).slice(0, 200)}`)
  }

  const offset = options.offset ?? { x: 0, y: 0 }
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE

  const lines = []
  for (const item of raw.data) {
    const text = typeof item?.text === 'string' ? item.text : ''
    if (text.trim() === '') continue
    const box = Array.isArray(item?.box) ? item.box : []
    const xs = []
    const ys = []
    for (const point of box) {
      if (!Array.isArray(point) || point.length < 2) continue
      xs.push(Number(point[0]))
      ys.push(Number(point[1]))
    }
    const x = xs.length > 0 ? Math.min(...xs) : 0
    const y = ys.length > 0 ? Math.min(...ys) : 0
    const width = xs.length > 0 ? Math.max(...xs) - x : 0
    const height = ys.length > 0 ? Math.max(...ys) - y : 0
    lines.push({
      text,
      score: typeof item?.score === 'number' ? Number(item.score.toFixed(4)) : null,
      // The polygon is kept as the engine reported it, already mapped back, because a rotated
      // label's rectangle alone would place a click in the wrong spot.
      box: box.map((point) => [
        Math.round(offset.x + Number(point[0]) / scale),
        Math.round(offset.y + Number(point[1]) / scale),
      ]),
      x: Math.round(offset.x + x / scale),
      y: Math.round(offset.y + y / scale),
      width: Math.round(width / scale),
      height: Math.round(height / scale),
    })
  }

  lines.sort((left, right) => left.y - right.y || left.x - right.x)
  const kept = lines.filter((line) => line.score === null || line.score >= minScore)
  return {
    code,
    lines,
    text: kept.map((line) => line.text).join('\n'),
    dropped: lines.length - kept.length,
  }
}

/**
 * Normalise text for matching: lower case, and with the spacing both engines and WinRT may
 * insert between CJK glyphs removed, so `音 频` matches `音频`.
 * @param {string} value - the text.
 * @returns {string} the comparable form.
 */
export function normaliseText(value) {
  return String(value).toLowerCase().replace(/\s+/g, '')
}

/**
 * Find needles among recognised lines.
 *
 * Pure. Matching ignores case and whitespace because every engine here inserts spaces between
 * CJK glyphs on some inputs and not others; nothing else is normalised, so a caller who wants a
 * fuzzy match can post-process the lines itself.
 *
 * @param {object[]} lines - normalised lines.
 * @param {string|string[]} needles - text to look for.
 * @param {object} [options] - `{ match: 'contains'|'exact' }`.
 * @returns {object[]} matches, in reading order, each with a `center` point.
 */
export function findLines(lines, needles, options = {}) {
  const wanted = (Array.isArray(needles) ? needles : [needles])
    .filter((needle) => typeof needle === 'string' && needle.trim() !== '')
    .map((needle) => ({ raw: needle, key: normaliseText(needle) }))
  if (wanted.length === 0) return []

  const exact = options.match === 'exact'
  const matches = []
  lines.forEach((line, index) => {
    const key = normaliseText(line.text)
    for (const needle of wanted) {
      const hit = exact ? key === needle.key : key.includes(needle.key)
      if (!hit) continue
      matches.push({
        needle: needle.raw,
        lineIndex: index,
        text: line.text,
        score: line.score ?? null,
        x: line.x,
        y: line.y,
        width: line.width,
        height: line.height,
        center: { x: Math.round(line.x + line.width / 2), y: Math.round(line.y + line.height / 2) },
      })
    }
  })
  return matches.sort((left, right) => left.y - right.y || left.x - right.x)
}

/* ------------------------------------------------------------------ *
 * Preprocessing, and reading a file of any kind
 * ------------------------------------------------------------------ */

/**
 * Build the ffmpeg filter for a crop and an upscale.
 *
 * Upscaling before recognition is the cheapest accuracy win available on small UI text. It is
 * also why the boxes have to be mapped back, which {@link normaliseEngineResult} does.
 *
 * @param {object} [options] - `{ region: {x,y,width,height}, scale: number|'auto', width, height }`.
 * @returns {string} a filter string, or an empty string when nothing is asked for.
 * @throws {OcrError} when the region has no positive size.
 */
export function preprocessFilter(options = {}) {
  const parts = []
  const region = options.region
  if (region !== undefined && region !== null) {
    const { x = 0, y = 0, width, height } = region
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new OcrError(`region 必须带正整数 width 与 height，收到 ${JSON.stringify(region)}`)
    }
    parts.push(`crop=${Math.round(width)}:${Math.round(height)}:${Math.round(x)}:${Math.round(y)}`)
  }
  const scale = resolveScale(options)
  if (scale !== 1) parts.push(`scale=iw*${scale}:ih*${scale}:flags=lanczos`)
  return parts.join(',')
}

/**
 * Accept a region as an object or as an `x,y,width,height` string.
 *
 * Both spellings exist because a model writing tool arguments naturally emits the string it
 * read in a screenshot description, while code emits the object. One parser means one set of
 * error messages.
 *
 * @param {object|string|null|undefined} value - the caller's region.
 * @returns {{x: number, y: number, width: number, height: number}|null} a normalized region, or null when absent.
 * @throws {OcrError} when the shape is wrong or the numbers are not positive.
 */
export function parseRegion(value) {
  if (value === undefined || value === null || value === '') return null
  let region
  if (typeof value === 'string') {
    const parts = value.split(',').map((part) => Number(part.trim()))
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
      throw new OcrError(`region 字符串必须是 "x,y,width,height"，收到 ${JSON.stringify(value)}`)
    }
    region = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
  } else if (typeof value === 'object') {
    region = {
      x: Number(value.x ?? 0),
      y: Number(value.y ?? 0),
      width: Number(value.width),
      height: Number(value.height),
    }
  } else {
    throw new OcrError(`region 必须是对象或 "x,y,width,height" 字符串，收到 ${typeof value}`)
  }

  if (!(region.width > 0) || !(region.height > 0)) {
    throw new OcrError(`region 的 width 与 height 必须为正数，收到 ${JSON.stringify(value)}`)
  }
  return {
    x: Math.max(0, Math.round(region.x)),
    y: Math.max(0, Math.round(region.y)),
    width: Math.round(region.width),
    height: Math.round(region.height),
  }
}

/**
 * Decide the upscale factor for one image.
 *
 * `auto` follows the rule the RapidOCR project itself uses for small text — grow a small image
 * until its long side is worth recognising — expressed as a factor because that is what the
 * ffmpeg filter takes. Three times is the ceiling: past that, interpolation invents more detail
 * than it recovers.
 *
 * @param {object} options - `{ scale, width, height }`, dimensions in pixels.
 * @returns {number} the factor, 1 when nothing should change.
 */
export function resolveScale(options = {}) {
  const scale = options.scale
  if (scale === 'auto') {
    const long = Math.max(Number(options.width ?? 0), Number(options.height ?? 0))
    if (!(long > 0)) return 1
    return Math.min(3, Math.max(1, Math.round((AUTO_TARGET_LONG_SIDE / long) * 100) / 100))
  }
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/**
 * Write the image an engine should actually read: cropped, upscaled, or the original path.
 *
 * @param {string} source - the caller's image.
 * @param {object} options - `{ region, scale, config }`. `scale: "auto"` enlarges a small image
 *   (or a small crop) toward {@link AUTO_TARGET_LONG_SIDE}.
 * @returns {Promise<{path: string, temporary: boolean, scale: number, offset: {x: number, y: number}}>} what to read, and how to map its boxes back.
 * @throws {OcrError} when ffmpeg fails or the size cannot be determined.
 */
export async function prepareImage(source, options = {}) {
  let width = options.region?.width
  let height = options.region?.height
  if (options.scale === 'auto' && !(width > 0 && height > 0)) {
    // The dimensions decide the factor, so they have to come from the image itself.
    let info
    try {
      info = await probe(source, options.config ?? {})
    } catch (error) {
      if (error instanceof FfmpegNotFound) throw ffmpegFault(error)
      throw new OcrError(`无法读取图片尺寸以决定放大倍数：${error instanceof Error ? error.message : String(error)}`)
    }
    width = info.width
    height = info.height
  }

  const scale = resolveScale({ scale: options.scale, width, height })
  const filter = preprocessFilter({ region: options.region, scale })
  const offset =
    options.region === undefined || options.region === null
      ? { x: 0, y: 0 }
      : { x: Math.round(options.region.x ?? 0), y: Math.round(options.region.y ?? 0) }
  if (filter === '') return { path: source, temporary: false, scale: 1, offset }

  mkdirSync(OCR_TMP_DIR, { recursive: true })
  const target = join(OCR_TMP_DIR, `crop-${randomBytes(4).toString('hex')}.png`)
  try {
    await run({
      tool: 'ffmpeg',
      args: ['-i', source, '-vf', filter, '-frames:v', '1', '-update', '1', target],
      config: options.config ?? {},
      timeoutMs: 120_000,
    })
  } catch (error) {
    if (error instanceof FfmpegNotFound) throw ffmpegFault(error)
    throw new OcrError(`OCR 预处理失败（裁剪/放大）：${error instanceof Error ? error.message : String(error)}`)
  }
  return { path: target, temporary: true, scale, offset }
}

/**
 * Turn a missing ffmpeg into the named environment fault it is.
 *
 * Cropping and frame extraction are the only two things that need ffmpeg, and a machine without
 * it is not broken — it simply cannot do those two, which is worth saying in those terms.
 *
 * @param {Error} error - the `FfmpegNotFound` that was raised.
 * @returns {OcrEnvironmentError} the fault, ready to throw.
 */
function ffmpegFault(error) {
  return new OcrEnvironmentError('ffmpeg-missing', error instanceof Error ? error.message.split('\n')[0] : String(error))
}

/**
 * Read text off one image with the installed engine.
 *
 * @param {string} imagePath - the image.
 * @param {object} [options] - `{ config, region, scale, language, maxSideLen, timeoutMs, minScore, onLog }`.
 * @returns {Promise<object>} `{ engine, source, lines, text, elapsedMs, dropped }`.
 * @throws {OcrEnvironmentError} when no engine is installed, or ffmpeg is missing and needed.
 * @throws {OcrError} when recognition fails.
 */
export async function recogniseImage(imagePath, options = {}) {
  if (!existsSync(imagePath)) throw new OcrError(`OCR 的输入图片不存在：${imagePath}`)
  const engine = resolveOcrEngine(options.config ?? {}, options)
  if (engine === null) {
    throw new OcrEnvironmentError(
      'no-engine',
      '没有安装离线 OCR 引擎',
      { hint: `运行 ${INSTALL_HINT} 安装一个（约 73MB），或用 engine:"winrt" 明确要求 Windows 自带的引擎。` },
    )
  }

  const prepared = await prepareImage(imagePath, options)
  const started = Date.now()
  try {
    const session = sessionFor(engine, {
      timeoutMs: options.timeoutMs ?? options.config?.ocr?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      idleMs: options.idleMs ?? options.config?.ocr?.idleMs ?? IDLE_SHUTDOWN_MS,
    })
    options.onLog?.(`OCR 引擎 ${engine.kind}（${engine.source}）识别 ${prepared.path}`)
    const raw = await session.recognise(prepared.path)
    const normalised = normaliseEngineResult(raw, {
      offset: prepared.offset,
      scale: prepared.scale,
      minScore: options.minScore,
    })
    return { engine: engine.kind, source: engine.source, elapsedMs: Date.now() - started, ...normalised }
  } finally {
    if (prepared.temporary) rmSync(prepared.path, { force: true })
  }
}

/**
 * Build the argument list for `src/bin/ocr.ps1`.
 *
 * Pure, and separate from the call, because one bug class lives here: the helper takes an
 * *integer* scale, so the shared `scale: "auto"` spelling must be resolved to a number before
 * it is passed. Handing the word through makes PowerShell fail to convert the parameter, which
 * surfaces as "OCR failed" rather than "bad argument" — a misleading report that this function
 * now makes impossible.
 *
 * @param {string} imagePath - the image to read.
 * @param {object} [options] - `{ scale, language, region }`.
 * @param {{width: number, height: number}} [dimensions] - the image or region size, used for `auto`.
 * @returns {string[]} the helper's arguments, after the script path.
 */
export function winrtArguments(imagePath, options = {}, dimensions = {}) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, '-Path', imagePath]

  let scale = options.scale
  if (scale === 'auto') {
    const width = Number(options.region?.width ?? dimensions.width ?? 0)
    const height = Number(options.region?.height ?? dimensions.height ?? 0)
    scale = Math.max(1, Math.round(resolveScale({ scale: 'auto', width, height })))
  }
  if (Number.isFinite(scale) && scale > 1) args.push('-Scale', String(Math.round(scale)))
  if (typeof options.language === 'string' && options.language !== '') args.push('-Language', options.language)
  if (options.region !== undefined && options.region !== null) {
    const { x = 0, y = 0, width, height } = options.region
    args.push('-Region', `${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`)
  }
  return args
}

/**
 * Read text with Windows' own recogniser, through `src/bin/ocr.ps1`.
 *
 * Kept because it needs nothing installed and answers in ~200 ms, which is the right trade for
 * locating a large label in an automation loop. Its known weakness is small mixed-script text,
 * so it is the fallback rather than the default.
 *
 * @param {string} imagePath - the image.
 * @param {object} [options] - `{ region, scale, language, timeoutMs, config }`.
 * @returns {Promise<object>} `{ engine, lines, text, elapsedMs, dropped }`.
 * @throws {OcrError} when the helper is missing or fails.
 */
export async function recogniseViaWinRT(imagePath, options = {}) {
  if (!existsSync(imagePath)) throw new OcrError(`OCR 的输入图片不存在：${imagePath}`)
  if (process.platform !== 'win32') {
    throw new OcrEnvironmentError('not-windows', `当前平台是 ${process.platform}，而两个识别器都是 Windows 的`)
  }
  if (!existsSync(OCR_SCRIPT)) throw new OcrError(`找不到 WinRT OCR 脚本：${OCR_SCRIPT}`)

  // `auto` needs the size, so it is probed only when it was actually asked for and the region
  // does not already say how big the picture is.
  let dimensions = {}
  if (options.scale === 'auto' && !(options.region?.width > 0 && options.region?.height > 0)) {
    try {
      const info = await probe(imagePath, options.config ?? {})
      dimensions = { width: info.width, height: info.height }
    } catch {
      dimensions = {}
    }
  }
  const args = winrtArguments(imagePath, options, dimensions)

  const started = Date.now()
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectRun(new OcrError(`WinRT OCR 超过 ${Math.round((options.timeoutMs ?? 60_000) / 1000)} 秒未返回`))
    }, options.timeoutMs ?? 60_000)
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectRun(new OcrError(`无法启动 WinRT OCR：${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        rejectRun(new OcrError(`WinRT OCR 失败（退出码 ${code}）：${stderr.trim().slice(0, 400)}`))
        return
      }
      resolveRun(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim())
    })
  })

  if (result === '') throw new OcrError('WinRT OCR 没有输出')
  let parsed
  try {
    parsed = JSON.parse(result)
  } catch (error) {
    throw new OcrError(`WinRT OCR 的输出不是合法 JSON：${error.message}`)
  }
  const lines = (Array.isArray(parsed.lines) ? parsed.lines : []).map((line) => ({
    text: line.text,
    score: null,
    x: line.x,
    y: line.y,
    width: line.width,
    height: line.height,
    box: [
      [line.x, line.y],
      [line.x + line.width, line.y],
      [line.x + line.width, line.y + line.height],
      [line.x, line.y + line.height],
    ],
  }))
  return {
    engine: 'winrt',
    source: 'windows',
    language: parsed.language ?? null,
    elapsedMs: Date.now() - started,
    code: 100,
    lines,
    text: lines.map((line) => line.text).join('\n'),
    dropped: 0,
  }
}

/**
 * Read text off any supported file, choosing an engine.
 *
 * `engine` may be `auto` (installed engine first, WinRT when there is none or it fails), `local`
 * (the engine only, failing loudly when absent) or `winrt` (Windows only).
 *
 * @param {string} target - an image or a video.
 * @param {object} [options] - `{ config, engine, region, scale, language, maxSideLen, timeoutMs, minScore, frames, times, onLog }`.
 * @returns {Promise<object>} `{ kind, engine, text, lines, frames?, elapsedMs, notes, fault? }`.
 *   `fault` is present when the answer came from the Windows recogniser because the engine could
 *   not be used — an environment problem, named and explained.
 * @throws {OcrError} when the file is missing, unsupported, or no engine can read it.
 */
export async function readText(target, options = {}) {
  const path = resolve(target)
  if (!existsSync(path)) throw new OcrError(`OCR 的输入不存在：${path}`)
  const kind = classify(path)
  if (kind === 'audio' || kind === 'unknown') {
    throw new OcrError(`OCR 只支持图片和视频，收到的是 ${kind}：${path}`)
  }

  const notes = []

  if (kind === 'video') {
    const { duration, frames } = await readVideoFrames(path, options)
    const results = []
    for (const frame of frames) {
      try {
        const read = await recogniseOne(frame.path, options, notes)
        results.push({ at: frame.at, ...read })
      } finally {
        if (frame.temporary) rmSync(frame.path, { force: true })
      }
    }
    const engines = [...new Set(results.map((result) => result.engine))]
    // One fault is enough to qualify the whole video: every frame was read by the same fallback.
    const fault = results.map((result) => result.fault).find((entry) => entry !== undefined) ?? null
    return {
      kind: 'video',
      path,
      duration,
      engine: engines.length === 1 ? engines[0] : engines,
      ...(fault === null ? {} : { fault }),
      frames: results.map((result) => ({
        at: result.at,
        engine: result.engine,
        text: result.text,
        lines: result.lines,
        elapsedMs: result.elapsedMs,
      })),
      text: results.map((result) => result.text).join('\n---\n'),
      lines: results.flatMap((result) => result.lines.map((line) => ({ ...line, at: result.at }))),
      elapsedMs: results.reduce((total, result) => total + result.elapsedMs, 0),
      notes,
    }
  }

  const read = await recogniseOne(path, options, notes)
  return { kind: 'image', path, ...read, notes }
}

/**
 * Recognise one file with the configured preference, appending notes about fallbacks.
 *
 * Degrading is still allowed — a machine with no engine is a supported machine — but it is never
 * silent any more. An environment fault is carried out of here as a structured `fault` on the
 * result, so a caller that needs the exact characters can tell "Windows read this" from "the
 * engine read this" without parsing a note.
 *
 * @param {string} path - an image path.
 * @param {object} options - the caller's options.
 * @param {string[]} notes - notes collected for the caller.
 * @returns {Promise<object>} the recognition result.
 * @throws {OcrError} when the chosen engine cannot be used, or no recogniser can read the file.
 */
async function recogniseOne(path, options, notes) {
  const preference = options.engine ?? options.config?.ocr?.defaultEngine ?? 'auto'
  if (preference === 'winrt') return recogniseViaWinRT(path, options)

  let failure = null
  try {
    return await recogniseImage(path, options)
  } catch (error) {
    if (preference === 'local') throw error
    failure = error
  }

  const reason = failure instanceof Error ? failure.message.split('\n')[0] : String(failure)
  const fault = failure instanceof OcrEnvironmentError ? failure.toFault() : null
  if (fault !== null) {
    notes.push(
      `离线引擎不可用（${fault.code}：${fault.label}）——${fault.reason}。` +
        `已退回 Windows 自带 OCR，它读不出小字与中英混排，不要把它当作原文引用。${fault.hint}`,
    )
  } else {
    notes.push(`离线引擎不可用，已退回 Windows 自带 OCR：${reason}`)
  }

  try {
    const read = await recogniseViaWinRT(path, options)
    return { ...read, ...(fault === null ? {} : { fault }) }
  } catch (winrtError) {
    // Both recognisers are unusable: this is not a fallback any more, it is a machine that
    // cannot read text, and the caller must be told that rather than handed an empty reading.
    throw new OcrEnvironmentError(
      'unusable',
      `离线引擎失败（${reason}），Windows 自带 OCR 也不可用（${
        winrtError instanceof Error ? winrtError.message.split('\n')[0] : String(winrtError)
      }）`,
      { engine: fault?.engine ?? null, executable: fault?.executable ?? null, hint: fault?.hint },
    )
  }
}

/**
 * Extract the frames a video should be read at.
 *
 * Times are spread through the video rather than taken from the first second, because the
 * opening frames of a screen recording are usually a title card with no text worth having.
 *
 * @param {string} path - the video.
 * @param {object} options - `{ frames, times, config }`.
 * @returns {Promise<{duration: number, frames: {at: number, path: string, temporary: boolean}[]}>} the extracted frames.
 * @throws {OcrError} when frames cannot be extracted.
 */
async function readVideoFrames(path, options) {
  const info = await probe(path, options.config ?? {})
  const duration = info.duration ?? 0
  if (!(duration > 0)) throw new OcrError(`无法确定视频时长，不能抽帧 OCR：${path}`)

  const requested =
    Array.isArray(options.times) && options.times.length > 0
      ? options.times.map(Number).filter((at) => Number.isFinite(at) && at >= 0 && at <= duration)
      : null
  const count = requested === null ? Math.max(1, Math.min(24, Math.round(options.frames ?? 4))) : requested.length
  const times = requested ?? Array.from({ length: count }, (_, index) => (duration * (index + 0.5)) / count)

  mkdirSync(OCR_TMP_DIR, { recursive: true })
  const frames = []
  try {
    for (const at of times) {
      const target = join(OCR_TMP_DIR, `frame-${at.toFixed(3).replace('.', '_')}-${randomBytes(3).toString('hex')}.png`)
      await run({
        tool: 'ffmpeg',
        args: ['-ss', at.toFixed(3), '-i', path, '-frames:v', '1', '-update', '1', target],
        config: options.config ?? {},
        timeoutMs: 300_000,
      })
      frames.push({ at: Number(at.toFixed(3)), path: target, temporary: true })
    }
  } catch (error) {
    for (const frame of frames) rmSync(frame.path, { force: true })
    if (error instanceof FfmpegNotFound) throw ffmpegFault(error)
    throw new OcrError(`抽帧失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { duration, frames }
}
