/**
 * The little bit of ffmpeg this plugin needs, and nothing more.
 *
 * Two operations use it: cropping/upscaling an image before recognition (the cheapest accuracy
 * win available on small UI text) and pulling frames out of a video so they can be read. Both
 * are pure functions of their arguments, so this module stays a thin, honest wrapper rather
 * than a pipeline.
 *
 * Two rules are enforced here because both were learned the hard way in the sibling plugin:
 *
 * 1. **Arguments are always an array.** Nothing is assembled into a shell string, so a Chinese
 *    filename or a space needs no escaping and cannot be mis-parsed.
 * 2. **`-nostdin` and `-y` are always both present on ffmpeg.** With `-nostdin` alone, ffmpeg
 *    cannot answer its own overwrite prompt when the output already exists, so it exits 1 with
 *    nothing on stderr but an unremarkable `Duration:` line — a rerun failure that reads as
 *    "the file is broken" rather than "it asked a question nobody could see".
 *
 * ffprobe rejects `-y` outright, so the two tools get different prefixes rather than one
 * shared one.
 *
 * @module dsh-ocr/core/ffmpeg
 */
import { spawn } from 'node:child_process'
import { findBinary } from './env.mjs'

/** Raised when no usable ffmpeg or ffprobe can be located. */
export class FfmpegNotFound extends Error {
  constructor(message) {
    super(message)
    this.name = 'FfmpegNotFound'
  }
}

/** Raised when ffmpeg or ffprobe exits non-zero. */
export class FfmpegError extends Error {
  /**
   * @param {string[]} args - the argument list that failed.
   * @param {number|null} returnCode - the process exit code, null when killed.
   * @param {string} stderr - captured standard error.
   * @param {string} [reason] - extra context, for example a timeout.
   */
  constructor(args, returnCode, stderr, reason) {
    const tail = String(stderr ?? '').trim().split('\n').slice(-25).join('\n')
    const safeArgs = args.map((argument) => (/[^\x20-\x7e]/.test(argument) ? JSON.stringify(argument) : argument))
    super(
      `${reason === undefined ? `ffmpeg 退出码 ${returnCode}` : reason}\n` +
        `命令：ffmpeg ${safeArgs.join(' ')}\n` +
        `stderr（尾部）：\n${tail}`,
    )
    this.name = 'FfmpegError'
    this.args = [...args]
    this.returnCode = returnCode
    this.stderr = String(stderr ?? '')
  }
}

/** Cache of resolved binaries, so discovery runs once per process. */
const resolved = new Map()

/**
 * Resolve an ffmpeg-family binary, honouring the configured paths.
 * @param {'ffmpeg'|'ffprobe'} stem - which binary.
 * @param {object} [config] - normalized plugin config, supplying explicit paths.
 * @returns {{path: string, source: string}} the binary and where it came from.
 * @throws {FfmpegNotFound} when no candidate exists.
 */
export function resolveTool(stem, config = {}) {
  const configured = stem === 'ffmpeg' ? config.ffmpegPath : config.ffprobePath
  const key = `${stem}:${configured ?? ''}`
  const cached = resolved.get(key)
  if (cached !== undefined) return cached

  const found = findBinary(stem, configured ?? null)
  if (found === null) {
    throw new FfmpegNotFound(
      `找不到 ${stem}。它只在两件事上需要：裁剪/放大图片，以及从视频里抽帧（读单张图用不到）。\n` +
        `请把它放到共享目录 ~/.dsh-plugins/ffmpeg/bin（六个插件共用一份），或设置环境变量 ${stem === 'ffmpeg' ? 'DSH_OCR_FFMPEG' : 'DSH_OCR_FFPROBE'}，` +
        `或让它出现在 PATH 里；装了 video-factory 的话，它自带的 ffmpeg 也会被自动使用。`,
    )
  }
  resolved.set(key, found)
  return found
}

/** Forget cached binary paths. Only useful in tests. @returns {void} */
export function resetToolCache() {
  resolved.clear()
}

/**
 * Run one ffmpeg-family process with an argument array.
 *
 * @param {object} options - the invocation.
 * @param {'ffmpeg'|'ffprobe'} options.tool - which binary to run.
 * @param {string[]} options.args - arguments, in order.
 * @param {string} [options.cwd] - working directory; filter graphs may reference files by
 *   relative path, so this matters.
 * @param {object} [options.config] - normalized plugin config for binary resolution.
 * @param {number} [options.timeoutMs] - kill after this long. Defaults to 2 minutes.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} the outcome.
 * @throws {FfmpegNotFound} when the binary is missing.
 * @throws {FfmpegError} when the process fails, is killed, or times out.
 */
export function run(options) {
  const { tool = 'ffmpeg', args, cwd, config = {} } = options
  const timeoutMs = options.timeoutMs ?? 2 * 60 * 1000
  const binary = resolveTool(tool, config)

  const argv = tool === 'ffmpeg' ? ['-hide_banner', '-nostdin', '-y', ...args] : ['-hide_banner', ...args]

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary.path, argv, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks = []
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      rejectRun(new FfmpegError(args, null, stderr, `无法启动 ${binary.path}：${error.message}`))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      if (timedOut) {
        rejectRun(new FfmpegError(args, code, stderr, `${tool} 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`))
        return
      }
      if (code !== 0) {
        rejectRun(new FfmpegError(args, code, stderr))
        return
      }
      resolveRun({ code, stdout, stderr })
    })
  })
}

/**
 * Read an ffprobe JSON document for one file.
 *
 * @param {string} path - the file to inspect.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<object>} the parsed document.
 * @throws {FfmpegNotFound} when ffprobe is missing.
 * @throws {FfmpegError} when ffprobe fails.
 */
export async function runProbe(args, config = {}) {
  const { stdout } = await run({ tool: 'ffprobe', args, config, timeoutMs: 60_000 })
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new FfmpegError(args, 0, stdout, `ffprobe 的输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}
