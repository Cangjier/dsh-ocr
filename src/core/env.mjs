/**
 * Environment facts: where this plugin lives, and how it finds the tools it borrows.
 *
 * The plugin owns exactly one external dependency — an OCR engine — and borrows one more,
 * ffmpeg, which it needs only to crop/upscale an image and to pull frames out of a video.
 * Borrowing rather than owning is deliberate: ffmpeg is a few hundred megabytes, a machine
 * that already renders video has it, and reading text off a still image needs none of it.
 *
 * Discovery follows the precedence the sibling video-factory plugin established — explicit
 * configuration, then a vendored build, then PATH — extended by one case: this plugin will
 * use a sibling `video-factory` checkout's vendored ffmpeg, because the two plugins are
 * normally developed and installed next to each other and re-downloading 194 MB to read a
 * screenshot would be absurd. The sibling candidate is only ever a *candidate*: the report
 * always names which one was found, so "it worked on my machine" stays explainable.
 *
 * @module dsh-ocr/core/env
 */
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

/** Plugin package root, resolved from this module so a `link:` install still works. */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const BINARY_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const PROBE_NAME = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

/** Environment variable that overrides ffmpeg discovery outright. */
export const FFMPEG_ENV = 'DSH_OCR_FFMPEG'

/** Environment variable that overrides ffprobe discovery outright. */
export const FFPROBE_ENV = 'DSH_OCR_FFPROBE'

/**
 * Resolve the working directory for one request.
 *
 * @param {object} config - normalized plugin config.
 * @param {string} [requested] - a caller-supplied directory.
 * @returns {string} an absolute working directory.
 */
export function resolveCwd(config, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return resolve(requested)
  if (typeof config?.projectRoot === 'string' && config.projectRoot.trim() !== '') return resolve(config.projectRoot)
  return process.cwd()
}

/**
 * Where a sibling plugin's vendored ffmpeg would be.
 *
 * The two hits are the two layouts that actually occur: repositories checked out side by side,
 * and a `link:` install whose real path is the sibling directory.
 *
 * @returns {string[]} candidate `.../vendor/ffmpeg/bin` directories.
 */
function siblingBinaryDirectories() {
  return [
    resolve(PLUGIN_ROOT, '..', 'video-factory', 'vendor', 'ffmpeg', 'bin'),
    resolve(PLUGIN_ROOT, '..', '..', 'video-factory', 'vendor', 'ffmpeg', 'bin'),
  ]
}

/**
 * Locate one borrowed binary: explicit config, then the environment, then a vendored build,
 * then a sibling plugin's vendored build, then PATH.
 *
 * @param {'ffmpeg'|'ffprobe'} stem - which binary.
 * @param {string|null} explicit - a configured path.
 * @returns {{path: string, source: string}|null} where it was found, or null.
 */
export function findBinary(stem, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '' && existsSync(explicit)) {
    return { path: resolve(explicit), source: 'config' }
  }

  const fromEnv = stem === 'ffmpeg' ? process.env[FFMPEG_ENV] : process.env[FFPROBE_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && existsSync(fromEnv)) {
    return { path: resolve(fromEnv), source: 'env' }
  }

  const name = stem === 'ffmpeg' ? BINARY_NAME : PROBE_NAME
  const vendored = join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'bin', name)
  if (existsSync(vendored)) return { path: vendored, source: 'vendor' }

  for (const directory of siblingBinaryDirectories()) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return { path: candidate, source: 'sibling' }
  }

  // PATH lookup without spawning a shell: on Windows a bare name would otherwise let the
  // shell resolve it and lose the absolute path the report needs.
  const entries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const entry of entries) {
    if (entry.trim() === '') continue
    const candidate = join(entry, name)
    if (existsSync(candidate)) return { path: candidate, source: 'path' }
  }
  return null
}

/**
 * CJK-capable font directories, in preference order.
 *
 * Only the test suite needs a font — it renders its own fixture image rather than committing a
 * binary — but the lookup lives here so the suite and any future overlay code agree.
 *
 * @returns {string[]} candidate directories.
 */
export function fontDirectories() {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  return [join(windir, 'Fonts')]
}

/** CJK-capable fonts, in preference order. */
export const FONT_CANDIDATES = ['msyh.ttc', 'msyhbd.ttc', 'simhei.ttf', 'simsun.ttc', 'Deng.ttf']

/**
 * Locate a CJK-capable font on this machine.
 * @param {boolean} [bold] - prefer a bold face.
 * @returns {string|null} the font path, or null when none exists.
 */
export function findCjkFont(bold = false) {
  const order = bold ? ['msyhbd.ttc', 'msyh.ttc', 'simhei.ttf', 'simsun.ttc', 'Deng.ttf'] : FONT_CANDIDATES
  for (const directory of fontDirectories()) {
    for (const name of order) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Read the first line of a binary's `-version` output.
 * @param {string} binary - absolute path to an executable.
 * @returns {Promise<string|null>} the version line, or null on failure.
 */
export async function versionOf(binary) {
  try {
    const { stdout, stderr } = await runFile(binary, ['-version'], { timeout: 15000, windowsHide: true })
    const text = `${stdout}${stderr}`.split('\n').find((line) => line.trim() !== '')
    return text ? text.trim() : null
  } catch {
    return null
  }
}
