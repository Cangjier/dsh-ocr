/**
 * Environment facts: where this plugin lives, and how it finds the tools it borrows.
 *
 * The plugin owns exactly one external dependency — an OCR engine — and borrows one more,
 * ffmpeg, which it needs only to crop/upscale an image and to pull frames out of a video.
 * Borrowing rather than owning is deliberate: ffmpeg is a few hundred megabytes, and reading text
 * off a still image needs none of it.
 *
 * Both live in **the shared plugin home** now (`~/.dsh-plugins`): the engine under `ocr/`, and the
 * one ffmpeg build the whole family shares under `ffmpeg/bin`. Discovery still accepts the layouts
 * that existed before it — this plugin's own `vendor/`, then a sibling `video-factory` checkout's
 * `vendor/ffmpeg/bin` — because a machine that installed a build earlier must not be asked to
 * download 200 MB again. The candidate that answered is always named in the report, so "it worked
 * on my machine" stays explainable.
 *
 * @module dsh-ocr/core/env
 */
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PLUGIN_ROOT, SHARED_FFMPEG_BIN, SHARED_FFMPEG_DIR, SHARED_OCR_DIR, binaryName, sharedHomeState } from './home.mjs'

const runFile = promisify(execFile)

export { PLUGIN_ROOT }

const BINARY_NAME = binaryName('ffmpeg')
const PROBE_NAME = binaryName('ffprobe')

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
 * and a `link:` install whose real path is the sibling directory. The shared home is tried first
 * by {@link findBinary}; these follow it so an older install keeps working.
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
 * then the shared plugin home, then a sibling plugin's vendored build, then PATH.
 *
 * @param {'ffmpeg'|'ffprobe'} stem - which binary.
 * @param {string|null} explicit - a configured path.
 * @returns {{path: string, source: 'config'|'env'|'vendor'|'home'|'sibling'|'path'}|null} where it was found, or null.
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

  const shared = join(SHARED_FFMPEG_BIN, name)
  if (existsSync(shared)) return { path: shared, source: 'home' }

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
 * The shared home, as a report.
 * @returns {object} where the root came from, and the two directories inside it this plugin uses.
 */
export function sharedAssetsState() {
  return {
    ...sharedHomeState(),
    ocrDir: SHARED_OCR_DIR,
    ffmpegDir: SHARED_FFMPEG_DIR,
  }
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
