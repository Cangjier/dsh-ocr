/**
 * `text_guide` — the long tail, on demand.
 *
 * Everything here is *derived*: the tool and action reference comes out of `registry.mjs`, the
 * engine table out of the core installer, and the measured costs out of the module-level
 * constants the code itself uses. Nothing is paraphrased a second time, so the guide cannot
 * describe a plugin that does not exist — which is the failure mode a hand-written manual
 * always eventually has.
 *
 * It renders as JSON rather than prose on purpose: every value here is also a value a caller
 * might branch on (`available`, `defaults.minScore`, `engines[].id`), and a table of markdown
 * would have to be parsed back out to be used. `text_read` is where prose belongs.
 *
 * @module dsh-ocr/tools/guide
 */
import {
  AUTO_TARGET_LONG_SIDE,
  DEFAULT_MAX_SIDE_LEN,
  DEFAULT_MIN_SCORE,
  DEFAULT_TIMEOUT_MS,
  IDLE_SHUTDOWN_MS,
  INSTALL_HINT,
  OCR_TMP_DIR,
} from '../core/engine.mjs'
import { OCR_SOURCES } from '../core/install.mjs'
import { DEFAULT_LEAD_SECONDS, DEFAULT_MATCH_RATIO, DEFAULT_SAMPLE_FRAMES } from '../core/subtitles.mjs'
import { TOOLS, TOOL_ORDER } from './registry.mjs'
import { CWD_PROPERTY, OcrPluginError, defineFamilyTool } from './shared.mjs'

/** Every action this family exposes, in dispatch order. */
export const GUIDE_ACTIONS = ['overview', 'tool', 'action', 'rules']

/** The measured numbers this plugin's prose quotes, kept next to the code that produces them. */
export const MEASURED = {
  rapidocrScreenshotSeconds: 1.77,
  rapidocrSmallCropSeconds: 0.2,
  rapidocrInitSeconds: 0.33,
  rapidocrAverageScore: 0.929,
  paddleScreenshotSeconds: 15.9,
  paddleInitSeconds: 0.42,
  paddleAverageScore: 0.833,
  winrtScreenshotSeconds: 0.2,
}

/**
 * The rules that decide what a reading is worth.
 *
 * Each one is a mechanical or measured consequence of the implementation, not advice: they exist
 * because the alternative is a confident wrong answer, which is the worst kind.
 *
 * @returns {{id: string, rule: string, why: string}[]} the rules.
 */
export function rules() {
  return [
    {
      id: 'engine-precedence',
      rule:
        'An explicit config path wins; then a vendored engine in vendor/ocr/ (the manifest\'s active source first); then PATH. ' +
        'A configured path that no longer exists is a fault, not a reason to use a different engine. ' +
        '`text_setup {action:"status"}` names which one answered.',
      why:
        'Two installed engines would otherwise make the choice depend on directory order, and a reading you cannot attribute is a reading you cannot debug.',
    },
    {
      id: 'preflight-before-reading',
      rule:
        'Before the first read of a session, run `text_setup {action:"preflight"}` once. It starts the engine and ' +
        'returns a verdict — ready / degraded / unusable — plus a named fault for whatever stops it.',
      why:
        'A missing runtime DLL, a model set that did not finish unpacking and a CPU without the required instruction set ' +
        'are all invisible from the file system: the executable is there and the directory has files. They do not surface ' +
        'as an environment error either — they surface as a worse transcript, because the fallback reads the picture anyway.',
    },
    {
      id: 'environment-faults-are-named',
      rule:
        'When an environment problem forces a fallback, the result carries `fault` ({code, label, engine, executable, reason, hint}) ' +
        'and a leading note says the reading is not the accurate kind. `engine:"local"` fails instead of falling back at all.',
      why:
        'A silent downgrade turns a wrong transcript into a confident one. The fault codes exist so a caller can act: ' +
        'no-engine means install, runtime-missing means a runtime, unsupported-cpu means a different engine, ffmpeg-missing means only crops and video are affected.',
    },
    {
      id: 'coordinate-space',
      rule:
        'Every box and centre point is in the coordinates of the file you named — never of the crop or the enlarged copy the plugin actually fed to the engine.',
      why:
        'Crop offset is added and the upscale factor is divided, in that order. Getting this wrong aims a click at the wrong place while the text reads perfectly, so it is the one piece of arithmetic here that has dedicated tests from several directions.',
    },
    {
      id: 'lines-are-unfiltered',
      rule:
        '`text` honours minScore (default 0.5); `lines` never does. A low-confidence line is still returned, and `text_find` still searches it.',
      why:
        'A 0.4-score line that says exactly what you asked for is a hit, not noise. Silently dropping it would make a match unreachable and unexplainable.',
    },
    {
      id: 'local-means-local',
      rule:
        '`engine: "local"` fails loudly when no engine is installed instead of degrading to the Windows recogniser. `engine: "auto"` degrades, and says so in `fault` and `notes`.',
      why:
        'A silent downgrade turns a wrong transcript into a confident one. When a reading has to be right, ask for the engine and take the error.',
    },
    {
      id: 'winrt-has-no-score',
      rule: 'The Windows recogniser returns no confidence at all: `score` is null and minScore cannot filter it.',
      why: 'There is nothing to threshold, so `score: null` means "unknown", never "perfect".',
    },
    {
      id: 'small-text-needs-a-crop',
      rule:
        'Give `region` and `scale: "auto"` for anything under about 20px. The engine downsizes a full screen toward its long-side limit, and a small label does not survive that.',
      why: `Enlarging before recognition is the cheapest accuracy win available. The ceiling is 3x (long side toward ${AUTO_TARGET_LONG_SIDE}px) because past that interpolation invents more detail than it recovers.`,
    },
    {
      id: 'video-times-are-spread',
      rule:
        'A video is read at `frames` moments spread evenly through it (default 4), not from the start. Name `times` when you know the moments.',
      why:
        'The opening frames of a screen recording are usually a title card with no text worth having, and a subtitle that is on screen for 0.4s can be missed by even spacing.',
    },
    {
      id: 'find-misses-are-not-absence',
      rule:
        'A miss from `text_find` is not proof the text is absent. `searched` lists every line that was seen, so a miss can be told apart from a misread.',
      why: 'The two have different fixes: one is a crop, the other is a language or engine setting.',
    },
    {
      id: 'no-semantic-reading',
      rule:
        'This plugin reports what characters are on the pixels and where. It does not describe the picture, does not decide whether a reading is good enough, and does not click anything.',
      why:
        'A vision model answers "what is in this picture" better and needs no setup — use it for that. OCR is for the exact characters, and for the coordinate, which a vision model does not give you reliably.',
    },
    {
      id: 'not-a-renderer',
      rule:
        'Reading text is independent of any video project. Only video-frame reads, region crops and subtitle checks borrow ffmpeg; a still image with no region needs nothing but the engine.',
      why: 'A plugin that reads screenshots should not require a video toolchain to do it.',
    },
    {
      id: 'sessions-are-disposable',
      rule:
        `A warm engine is a real process holding a few hundred megabytes. It exits after ${Math.round(IDLE_SHUTDOWN_MS / 1000)}s idle, ` +
        'and the host stops it when the plugin unloads.',
      why:
        'Model load dominates the cold cost, so the process is reused — but a resident recogniser must not outlive the work that needed it.',
    },
    {
      id: 'windows-only',
      rule: 'Requires Windows. The vendored engines are Windows executables and the zero-install fallback is WinRT.',
      why: 'Stated rather than discovered: on another platform every call fails at the same place.',
    },
  ]
}

/**
 * The engine table, built from the installer's own entries.
 * @returns {object[]} one row per engine.
 */
function engines() {
  return Object.entries(OCR_SOURCES).map(([id, source]) => ({
    id,
    label: source.label,
    kind: source.kind,
    license: source.license,
    downloadBytes: source.bytes,
    sha256: source.sha256,
    url: source.url,
    usableWithoutAvx: id === 'rapidocr-json',
    measured: source.measured,
  }))
}

/** The measured cost table, kept as data so a caller can read it rather than grep for it. */
function costs() {
  return [
    { item: 'read: 1200x1013 screenshot, RapidOCR', value: `${MEASURED.rapidocrScreenshotSeconds}s` },
    { item: 'read: same screenshot, PaddleOCR', value: `${MEASURED.paddleScreenshotSeconds}s` },
    { item: 'read: a small region cropped and enlarged', value: `${MEASURED.rapidocrSmallCropSeconds}s` },
    { item: 'read: Windows recogniser, whole screen', value: `${MEASURED.winrtScreenshotSeconds}s` },
    {
      item: 'engine cold start (model load)',
      value: `${MEASURED.rapidocrInitSeconds}s RapidOCR / ${MEASURED.paddleInitSeconds}s PaddleOCR`,
    },
    { item: 'verify: per sampled cue', value: 'one frame extraction + one recognition' },
  ]
}

/**
 * Build the `text_guide` tool definition.
 * @param {Record<string, Function>} handlers - action implementations.
 * @returns {object} a raw tool definition.
 */
export function createGuideTool(handlers) {
  return defineFamilyTool({
    name: 'text_guide',
    actions: GUIDE_ACTIONS,
    handlers,
    extraProperties: {
      tool: {
        type: 'string',
        description: '`tool` action: which tool to describe — text_read, text_find, text_setup or text_guide.',
      },
      actionName: {
        type: 'string',
        description:
          '`action` action: the action to describe in full, for example "read" or "install". It goes here, not in "action" — "action" selects this reference action.',
      },
      cwd: CWD_PROPERTY,
    },
  })
}

/**
 * Build the `text_guide` action table.
 * @returns {Record<string, Function>} action handlers.
 */
export function createGuideActions() {
  return {
    /**
     * Everything at once: the surface, the engines, the measured costs, the rules and the limits.
     * @returns {object} the overview.
     */
    overview() {
      return {
        tools: TOOL_ORDER.filter((name) => name !== 'text_guide').map((name) => ({
          name,
          purpose: TOOLS[name].purpose,
          actions: Object.keys(TOOLS[name].actions),
        })),
        engines: engines(),
        measured: MEASURED,
        costs: costs(),
        defaults: {
          maxSideLen: DEFAULT_MAX_SIDE_LEN,
          minScore: DEFAULT_MIN_SCORE,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          idleShutdownMs: IDLE_SHUTDOWN_MS,
          subtitleSampleFrames: DEFAULT_SAMPLE_FRAMES,
          subtitleLeadSeconds: DEFAULT_LEAD_SECONDS,
          subtitleMatchRatio: DEFAULT_MATCH_RATIO,
        },
        rules: rules(),
        limits: [
          '一次 read 最多 12 个文件；一个视频最多读 24 帧。',
          `临时裁剪件与抽帧写在 ${OCR_TMP_DIR}，用完即删。`,
          `没有引擎时：${INSTALL_HINT}（约 73MB，解包后 44MB 起）。`,
          '不装引擎也能用：退回 Windows 自带识别，找大标签够用，读小字会错；这次退回会在结果的 fault 与 notes 里写明。',
          '第一次 read 之前先预检：text_setup {action:"preflight"}（真的启动一次引擎，约 0.3–0.5 s，随后保持热进程）。',
          '本插件不提供云端 OCR：视觉模型给不出逐行文字的像素框。',
        ],
      }
    },

    /**
     * One tool in full.
     * @param {object} args - the tool arguments.
     * @returns {object} the entry.
     */
    tool(args) {
      const name = typeof args.tool === 'string' ? args.tool : ''
      const entry = TOOLS[name]
      if (entry === undefined) {
        throw new OcrPluginError(`text_guide tool: 未知工具 ${JSON.stringify(args.tool)}；可选：${Object.keys(TOOLS).join(', ')}`)
      }
      return { name, ...entry }
    },

    /**
     * One action in full.
     * @param {object} args - the tool arguments.
     * @returns {object} the entry, with its tool named.
     */
    action(args) {
      const wanted = typeof args.actionName === 'string' ? args.actionName : ''
      const candidates = []
      for (const [tool, entry] of Object.entries(TOOLS)) {
        if (entry.actions[wanted] === undefined) continue
        candidates.push({ tool, entry: entry.actions[wanted] })
      }
      if (typeof args.tool === 'string' && args.tool !== '') {
        const filtered = candidates.filter((candidate) => candidate.tool === args.tool)
        if (filtered.length === 0) {
          throw new OcrPluginError(
            `text_guide action: 工具 ${JSON.stringify(args.tool)} 里没有 action ${JSON.stringify(wanted)}。`,
          )
        }
        return { tool: filtered[0].tool, action: wanted, ...filtered[0].entry }
      }
      if (candidates.length === 0) {
        throw new OcrPluginError(
          `text_guide action: 未知 action ${JSON.stringify(args.actionName)}；可选：${Object.values(TOOLS)
            .flatMap((entry) => Object.keys(entry.actions))
            .join(', ')}`,
        )
      }
      if (candidates.length > 1) {
        throw new OcrPluginError(
          `text_guide action: ${JSON.stringify(wanted)} 在多个工具里都存在（${candidates
            .map((candidate) => candidate.tool)
            .join(', ')}）；请给 "tool"。`,
        )
      }
      return { tool: candidates[0].tool, action: wanted, ...candidates[0].entry }
    },

    /**
     * The trust rules on their own.
     * @returns {object} the rules.
     */
    rules() {
      return { rules: rules() }
    },
  }
}
