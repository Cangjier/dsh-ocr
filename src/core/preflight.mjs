/**
 * The pre-flight check: can this machine read text *right now*?
 *
 * `status` answers a question about files — which engine is on disk, which one a call would use —
 * and deliberately starts nothing. That is the right check most of the time and the wrong one
 * exactly when it matters: an engine whose executable is present but whose runtime DLL is missing,
 * whose models did not finish unpacking, or whose CPU lacks the instruction set it was built for
 * looks *installed* from the outside. Its failure does not surface as an environment error at all;
 * it surfaces as a worse transcript, because `engine: "auto"` falls back to the Windows recogniser
 * and the reading still comes back.
 *
 * So this module does the one thing a listing cannot: it starts the engine and waits for the
 * banner it prints once its models are loaded, then reports the outcome as data — `ready`,
 * `degraded` or `unusable` — with the named fault attached. It reads no image, and it is meant to
 * be run once before the first real read: the engine it starts stays warm, so the cold start is
 * paid here instead of inside the first reading.
 *
 * @module dsh-ocr/core/preflight
 */
import { existsSync } from 'node:fs'
import { FFMPEG_ENV, FFPROBE_ENV, findBinary, versionOf } from './env.mjs'
import { SHARED_FFMPEG_BIN } from './home.mjs'
import {
  OCR_FAULTS,
  OCR_SCRIPT,
  OcrEnvironmentError,
  checkEngineStartup,
  noEngineFault,
  resolveOcrEngine,
} from './engine.mjs'

/**
 * Describe one discovered ffmpeg-family binary, including its version line.
 *
 * @param {'ffmpeg'|'ffprobe'} stem - which binary.
 * @param {object} config - normalized plugin config.
 * @returns {Promise<object|null>} the description, or null when it is not installed.
 */
async function describeBinary(stem, config) {
  const explicit = stem === 'ffmpeg' ? config.ffmpegPath : config.ffprobePath
  const found = findBinary(stem, explicit ?? null)
  if (found === null) return null
  return { path: found.path, source: found.source, version: await versionOf(found.path) }
}

/**
 * Report whether ffmpeg and ffprobe were found, and how.
 *
 * Shared with `text_setup {action:"probe"}` so the two can never report different things: probe
 * is this report on its own, preflight is this report with the engine started as well.
 *
 * @param {object} config - normalized plugin config.
 * @returns {Promise<{ok: boolean, ffmpeg: object|null, ffprobe: object|null, notes: string[]}>} the report.
 */
export async function inspectFfmpeg(config = {}) {
  const ffmpeg = await describeBinary('ffmpeg', config)
  const ffprobe = await describeBinary('ffprobe', config)
  const notes = []
  if (ffmpeg === null || ffprobe === null) {
    notes.push(
      '没有找到 ffmpeg/ffprobe。读单张图片（不给 region）不需要它们；读视频帧和裁剪放大需要。' +
        `把它们放进共享目录 ${SHARED_FFMPEG_BIN}，或设置 ` +
        `${FFMPEG_ENV} / ${FFPROBE_ENV}，或用 text_setup {action:"install", ffmpeg:true} 装一份。`,
    )
  } else if (ffmpeg.source === 'sibling' || ffprobe.source === 'sibling') {
    notes.push(
      'ffmpeg 来自同目录的 video-factory 检出。能用，但那份检出被移走就会失效——' +
        '要长期依赖它，请显式设置 ffmpegPath 或 DSH_OCR_FFMPEG；也可以用 ' +
        'ffmpeg_setup {action:"install"}（dsh-ffmpeg）装进共享目录。',
    )
  }
  return { ok: ffmpeg !== null && ffprobe !== null, ffmpeg, ffprobe, notes }
}

/**
 * The cheap, synchronous half of a preflight: what is on disk, without starting anything.
 *
 * Used by the plugin at activation, where starting a 500 MB engine because a profile loaded would
 * be absurd, and by nothing else — a caller that wants certainty wants {@link preflightOcr}.
 *
 * @param {object} config - normalized plugin config.
 * @returns {{verdict: 'ready'|'degraded'|'unusable', message: string, fault: object|null, engine: object|null}} the summary.
 */
export function environmentSummary(config = {}) {
  const winrt = existsSync(OCR_SCRIPT)
  let engine = null
  try {
    engine = resolveOcrEngine(config, { language: config?.ocr?.language })
  } catch (error) {
    if (!(error instanceof OcrEnvironmentError)) throw error
    const fault = error.toFault()
    return {
      verdict: winrt ? 'degraded' : 'unusable',
      message: `${fault.label}：${fault.reason}。${fault.hint}`,
      fault,
      engine: null,
    }
  }
  if (engine === null) {
    const fault = noEngineFault()
    return {
      verdict: winrt ? 'degraded' : 'unusable',
      message: `${fault.reason}：read/find 会退回 Windows 自带 OCR，中文小字与中英混排会读错。${fault.hint}`,
      fault,
      engine: null,
    }
  }
  const missing = engine.models?.missing ?? []
  return {
    verdict: 'ready',
    message:
      `离线引擎就绪：${engine.kind}（来自 ${engine.source}，${engine.executable}）` +
      (missing.length > 0 ? `；但缺少模型文件：${missing.join('、')}` : ''),
    fault: null,
    engine,
  }
}

/**
 * Check that OCR can actually run on this machine, by starting the engine.
 *
 * Never throws for an environment problem: an unusable machine is the answer, not an exception.
 * `ok` means "some recogniser can read text", `verdict` says which quality of recogniser that is,
 * and `engine.start.fault` names what went wrong when the offline engine was supposed to work.
 *
 * @param {object} [config] - normalized plugin config.
 * @param {object} [options] - `{ start, timeoutMs, idleMs }`. `start: false` keeps the file-level
 *   half only, which is `text_setup {action:"status"}` with a verdict.
 * @returns {Promise<object>} the report.
 */
export async function preflightOcr(config = {}, options = {}) {
  const recognition = { language: config?.ocr?.language, maxSideLen: config?.ocr?.maxSideLen }
  const checks = []
  const notes = []

  const platform = {
    ok: process.platform === 'win32',
    name: `${process.platform} ${process.arch}`,
    detail: '两个离线引擎都是 Windows 可执行文件，零安装回退是 WinRT。',
  }
  checks.push({ id: 'platform', ok: platform.ok, detail: platform.name })
  if (!platform.ok) notes.push(`当前平台不是 Windows（${platform.name}）：${OCR_FAULTS['not-windows'].hint}`)

  const winrt = { present: existsSync(OCR_SCRIPT), script: OCR_SCRIPT }
  checks.push({
    id: 'winrt-fallback',
    ok: winrt.present,
    detail: winrt.present ? 'Windows 自带 OCR 可用（零安装，但小字与中英混排会错）' : '找不到 WinRT OCR 脚本',
  })

  let engine = null
  let fault = null
  try {
    engine = resolveOcrEngine(config, recognition)
  } catch (error) {
    if (!(error instanceof OcrEnvironmentError)) throw error
    fault = error.toFault()
  }
  if (engine === null && fault === null) {
    fault = noEngineFault()
  }
  checks.push({
    id: 'engine-installed',
    ok: engine !== null,
    detail: engine === null ? `${fault.label}：${fault.reason}` : `${engine.kind}（${engine.source}）：${engine.executable}`,
  })
  if (engine === null) notes.push(`离线引擎不可用（${fault.code}）：${fault.reason}。${fault.hint}`)

  let start = null
  if (engine !== null) {
    const missing = engine.models?.missing ?? []
    checks.push({
      id: 'models-present',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `模型文件齐全：${(engine.models?.required ?? []).join('、')}`
          : `缺少模型文件：${missing.join('、')}`,
    })
    if (missing.length > 0) {
      notes.push(
        `引擎目录里缺少这些模型文件：${missing.join('、')}。` +
          '缺识别模型时引擎可能仍能启动，但读出的字会不对——重装一次（text_setup {action:"install", force:true}）。',
      )
    }

    if (options.start === false) {
      start = { attempted: false, ok: null, elapsedMs: 0 }
      notes.push('没有启动引擎：只检查了文件。缺运行库 DLL、模型损坏这类问题只有真正启动时才看得见。')
    } else {
      start = await checkEngineStartup(engine, { config, timeoutMs: options.timeoutMs, idleMs: options.idleMs })
      if (start.ok) {
        notes.push(
          `引擎已真的启动一次并加载完模型（${start.elapsedMs} ms），进程保持温热，随后的 read 不再付冷启动。`,
        )
      } else {
        notes.push(`引擎装在那里但起不来（${start.fault?.code}）：${start.fault?.reason}。${start.fault?.hint ?? ''}`)
        // Only a process that actually ran can have been stopped by a model file: a launch
        // failure (missing DLL, blocked executable) is about the binary, not the models.
        const modelCouldBeTheCause = ['engine-crashed', 'init-timeout'].includes(start.fault?.code)
        if (missing.length > 0 && modelCouldBeTheCause) {
          notes.push(`目录里同时缺少模型文件：${missing.join('、')}——这很可能就是起不来的原因，重装一次即可。`)
        }
      }
    }
    checks.push({
      id: 'engine-starts',
      ok: start.ok === true,
      detail:
        start.attempted === false
          ? '未尝试启动'
          : start.ok
            ? `初始化完成，用时 ${start.elapsedMs} ms`
            : `${start.fault?.code}：${start.fault?.reason}`,
    })
  }

  const ffmpeg = await inspectFfmpeg(config)
  checks.push({
    id: 'ffmpeg',
    ok: ffmpeg.ok,
    detail: ffmpeg.ok
      ? `ffmpeg（${ffmpeg.ffmpeg.source}）/ ffprobe（${ffmpeg.ffprobe.source}）；只有 region、scale 和视频抽帧需要它们`
      : '没有 ffmpeg/ffprobe：静态图、不给 region 的 read 不受影响',
  })
  notes.push(...ffmpeg.notes)

  const engineUsable = engine !== null && start?.ok === true
  const verdict = engineUsable ? 'ready' : (winrt.present && platform.ok ? 'degraded' : 'unusable')
  if (verdict === 'degraded') {
    notes.push('结论：能读字，但只有 Windows 自带识别——找大按钮够用，引用原文不行。engine:"local" 会直接失败而不是这样降级。')
  } else if (verdict === 'unusable') {
    notes.push('结论：这台机器现在读不了字。先按上面第一条处理，然后重跑一次 preflight。')
  }
  notes.push('预检证明的是"引擎能起来、模型加载了"，不是"某张图读得清"——后者只有一次真实 read 能回答。')

  return {
    ok: verdict !== 'unusable',
    verdict,
    platform,
    engine:
      engine === null
        ? { available: false, fault }
        : {
            available: true,
            kind: engine.kind,
            label: engine.label,
            executable: engine.executable,
            source: engine.source,
            models: engine.models,
            start,
          },
    fallback: { winrt: winrt.present, script: winrt.script },
    ffmpeg,
    checks,
    notes,
  }
}
