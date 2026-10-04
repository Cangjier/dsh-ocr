/**
 * Provisioning the offline OCR engine.
 *
 * An engine is not a package this plugin can depend on, so it is fetched once into
 * `vendor/ocr/<source>/` and pinned. Two things are pinned:
 *
 *   1. **The archive.** Release assets are immutable, so the SHA-256 published for the package
 *      is checked and a mismatch is a hard failure. A tampered or truncated download must never
 *      become the thing that reads text out of the user's screenshots.
 *   2. **The extractor.** These packages are 7-Zip archives and Windows ships no tool that can
 *      read them: `tar.exe` reports "LZMA codec is unsupported", and 7-Zip itself is usually not
 *      installed. So a standalone `7zr.exe` is fetched from 7-zip.org. That URL always serves
 *      the current release, so its hash is *recorded* rather than enforced — a new upstream
 *      release would otherwise break the installer, which is a worse failure than a logged hash
 *      change.
 *
 * @module dsh-ocr/core/install
 */
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PLUGIN_ROOT } from './env.mjs'
import { InstallError, download, sha256Of } from './net.mjs'

const runFile = promisify(execFile)

/**
 * Where a vendored engine lives.
 *
 * Defined here rather than in `engine.mjs` because installing is what creates the directory;
 * the client imports the constant from this module, and this module imports nothing from the
 * client.
 */
export const OCR_VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'ocr')

/** The manifest that records what is installed and which source is active. */
export const OCR_MANIFEST = join(OCR_VENDOR_DIR, 'SOURCE.json')

/** Scratch paths used while installing. */
export const OCR_TOOLS_DIR = join(OCR_VENDOR_DIR, 'tools')
export const OCR_SEVEN_ZIP = join(OCR_TOOLS_DIR, '7zr.exe')
export const OCR_ARCHIVE = join(OCR_VENDOR_DIR, 'download.7z')
export const OCR_SCRATCH_DIR = join(OCR_VENDOR_DIR, 'extract')

/**
 * The standalone 7-Zip reader used to unpack an engine.
 *
 * `7zr.exe` is the vendor's own reduced build: it reads `.7z` and nothing else, which is all
 * this needs, and it is 0.6 MB rather than an installer.
 */
export const SEVEN_ZIP = {
  url: 'https://www.7-zip.org/a/7zr.exe',
  bytes: 602_624,
  sha256: 'ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d',
  license: 'LGPL / BSD-3-Clause（7-Zip 自带许可）',
}

/**
 * The engine packages this plugin can install.
 *
 * Both speak the same stdin/stdout JSON protocol, so the client in `engine.mjs` does not care
 * which one is present. They differ in model generation, speed, and licence, and the measured
 * numbers below are why one is the default: on the development machine the ONNX build read the
 * same 1200x1013 screenshot in 1.77 s with a higher average score than the Paddle build managed
 * in 15.9 s.
 */
export const OCR_SOURCES = {
  'rapidocr-json': {
    label: 'RapidOCR-json v0.2.0（ONNX Runtime + PP-OCRv4 简体中文）',
    kind: 'rapidocr-json',
    executables: ['RapidOCR-json.exe', 'RapidOCR_json.exe'],
    url: 'https://github.com/hiroi-sora/RapidOCR-json/releases/download/v0.2.0/RapidOCR-json_v0.2.0.7z',
    bytes: 73_461_693,
    sha256: '7ad9b283d03436c6cd0296723188699299cb4e5cf9140b410c59543aa5793c40',
    license: 'MIT',
    measured: '本机 1200x1013 截图 1.77 s，平均置信度 0.929；解包约 95 MB；不要求 AVX。',
  },
  'paddleocr-ppocrv5': {
    label: 'PaddleOCR-json + PP-OCRv5 mobile（第三方构建，Paddle Inference）',
    kind: 'paddleocr-json',
    executables: ['PaddleOCR-json.exe', 'PaddleOCR_json.exe'],
    url: 'https://github.com/OneDongua/PaddleOCR-json_PP-OCRv5_umi_plugin/releases/download/v1.0/win7_x64_PaddleOCR-json_PP-OCRv5_lite_v1.0.7z',
    bytes: 80_109_123,
    sha256: '7c40b20445545931122cd900798f1fac7c27c912140ba8c6ee0ecec695a97857',
    license: '构建者未声明许可；模型来自 PaddleOCR（Apache-2.0）',
    measured: '本机同一张截图 15.9 s（约 9 倍慢），但个别小字更准（`gap` 未读成 `qap`）；要求 AVX。',
  },
}

/** The source installed when none is named. */
export const DEFAULT_OCR_SOURCE = 'rapidocr-json'

/**
 * Read the install manifest.
 * @returns {object} `{ active: string|null, installed: object[], sevenZip: object|null }`, empty when nothing is installed.
 */
export function readManifest() {
  if (!existsSync(OCR_MANIFEST)) return { active: null, installed: [], sevenZip: null }
  try {
    const parsed = JSON.parse(readFileSync(OCR_MANIFEST, 'utf8'))
    return {
      active: typeof parsed.active === 'string' ? parsed.active : null,
      installed: Array.isArray(parsed.installed) ? parsed.installed : [],
      sevenZip: parsed.sevenZip ?? null,
    }
  } catch {
    // A corrupt manifest must not make the plugin unusable: the directory listing below still
    // proves what is on disk.
    return { active: null, installed: [], sevenZip: null }
  }
}

/**
 * Report what is installed, by reading the disk rather than trusting the manifest.
 *
 * The manifest says what an installer *intended*; the executable either exists or it does not,
 * and only the second fact decides whether text can be read.
 *
 * @returns {{active: string|null, totalBytes: number, sources: object[], sevenZip: boolean}} the state.
 */
export function ocrInstallState() {
  const manifest = readManifest()
  const sources = []
  let totalBytes = 0
  for (const [id, source] of Object.entries(OCR_SOURCES)) {
    const directory = join(OCR_VENDOR_DIR, id)
    const executable = source.executables.map((name) => join(directory, name)).find((path) => existsSync(path)) ?? null
    const sizeBytes = directorySize(directory)
    totalBytes += sizeBytes
    sources.push({
      id,
      label: source.label,
      license: source.license,
      measured: source.measured,
      directory,
      installed: executable !== null,
      executable,
      sizeBytes,
      bytes: source.bytes,
      sha256: source.sha256,
      url: source.url,
    })
  }
  totalBytes += directorySize(OCR_TOOLS_DIR)
  return { active: manifest.active, totalBytes, sources, sevenZip: existsSync(OCR_SEVEN_ZIP) }
}

/**
 * Total size of a directory tree, in bytes.
 * @param {string} directory - the root.
 * @returns {number} the sum, 0 when the directory is absent.
 */
function directorySize(directory) {
  if (!existsSync(directory)) return 0
  let total = 0
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      try {
        total += statSync(path).size
      } catch {
        // A file that vanished mid-listing simply does not count.
      }
    }
  }
  walk(directory)
  return total
}

/**
 * Make sure the 7-Zip reader is available.
 *
 * @param {(message: string) => void} [onProgress] - progress notes.
 * @param {boolean} [force] - download again even when the tool is present.
 * @returns {Promise<{path: string, downloaded: boolean, sha256: string, expected: string, hashMatches: boolean}>} the tool's state.
 * @throws {InstallError} when it cannot be fetched.
 */
export async function ensureSevenZip(onProgress, force = false) {
  if (existsSync(OCR_SEVEN_ZIP) && !force) {
    const sha256 = await sha256Of(OCR_SEVEN_ZIP)
    return { path: OCR_SEVEN_ZIP, downloaded: false, sha256, expected: SEVEN_ZIP.sha256, hashMatches: sha256 === SEVEN_ZIP.sha256 }
  }
  mkdirSync(OCR_TOOLS_DIR, { recursive: true })
  onProgress?.(`下载解包工具 7zr.exe（${SEVEN_ZIP.url}）`)
  let lastReported = 0
  const { sha256 } = await download(SEVEN_ZIP.url, OCR_SEVEN_ZIP, (received) => {
    // Report on whole 256 KB steps: a callback per chunk turns one download into hundreds of
    // log lines, which buries everything else the installer has to say.
    if (received - lastReported < 256 * 1024) return
    lastReported = received
    onProgress?.(`  7zr.exe 已下载 ${(received / 1024).toFixed(0)} KB`)
  })
  return { path: OCR_SEVEN_ZIP, downloaded: true, sha256, expected: SEVEN_ZIP.sha256, hashMatches: sha256 === SEVEN_ZIP.sha256 }
}

/**
 * Unpack a `.7z` archive into a directory.
 *
 * @param {string} archive - the archive to read.
 * @param {string} target - where to unpack it.
 * @param {string} sevenZip - path to `7zr.exe`.
 * @param {(message: string) => void} [onProgress] - progress notes.
 * @returns {Promise<string[]>} the entries at the archive's top level.
 * @throws {InstallError} when extraction fails or produces nothing.
 */
export async function extractArchive(archive, target, sevenZip, onProgress) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  try {
    const { stdout } = await runFile(sevenZip, ['x', archive, `-o${target}`, '-y'], {
      timeout: 15 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 16 << 20,
    })
    onProgress?.(stdout.trim().split('\n').pop() ?? '解包完成')
  } catch (error) {
    throw new InstallError(
      `解包失败（${sevenZip}）：${String(error?.stderr ?? error?.message ?? error).trim().slice(0, 400)}`,
    )
  }

  const entries = readdirSync(target)
  if (entries.length === 0) throw new InstallError(`解包后目录是空的：${target}`)
  return entries
}

/**
 * Install one OCR source into `vendor/ocr/<id>`.
 *
 * The package can equally be downloaded here or supplied as a local file. That second route
 * exists because it is sometimes the only one: GitHub's release CDN throttled this very
 * download to about 20 KB/s during development, and a 70 MB package at that rate is an hour.
 * A caller who has the archive — from another machine, a mirror, or a download manager — gets
 * the same result, and the SHA-256 is checked either way, so "local" never means "unverified".
 *
 * @param {object} [options] - install options.
 * @param {string} [options.source] - a key of {@link OCR_SOURCES}. Defaults to the default source.
 * @param {boolean} [options.force] - reinstall even when the engine is present.
 * @param {boolean} [options.prune] - delete recognition libraries for languages this plugin does not use.
 * @param {string} [options.archive] - a local `.7z` to unpack instead of downloading it.
 * @param {(message: string) => void} [options.onProgress] - progress notes.
 * @returns {Promise<object>} what was installed.
 * @throws {InstallError} when the source is unknown, the archive fails its checksum, or unpacking fails.
 */
export async function installOcr(options = {}) {
  const id = options.source ?? DEFAULT_OCR_SOURCE
  const source = OCR_SOURCES[id]
  if (source === undefined) {
    throw new InstallError(`未知的 OCR 来源 ${JSON.stringify(id)}；可选：${Object.keys(OCR_SOURCES).join(', ')}`)
  }

  const directory = join(OCR_VENDOR_DIR, id)
  const existing = source.executables.map((name) => join(directory, name)).find((path) => existsSync(path))
  if (existing !== undefined && options.force !== true) {
    return { installed: false, reason: '已安装', source: id, directory, executable: existing, state: ocrInstallState() }
  }

  const sevenZip = await ensureSevenZip(options.onProgress, false)
  const notes = []
  if (!sevenZip.hashMatches) {
    // Expected when 7-zip.org publishes a new 7zr.exe: the URL always serves the current
    // release. Recorded rather than enforced, because refusing to install over an upstream
    // release bump would be a worse failure than a changed hash in the report.
    notes.push(
      `解包工具 7zr.exe 的 sha256 与清单不同（清单 ${SEVEN_ZIP.sha256}，实际 ${sevenZip.sha256}）；` +
        '这通常意味着上游发布了新版本，已继续安装。',
    )
  }

  const local = typeof options.archive === 'string' && options.archive.trim() !== '' ? resolve(options.archive) : null
  let archivePath = OCR_ARCHIVE
  let bytes
  let sha256
  if (local !== null) {
    if (!existsSync(local)) throw new InstallError(`指定的 OCR 引擎包不存在：${local}`)
    bytes = statSync(local).size
    sha256 = await sha256Of(local)
    archivePath = local
    options.onProgress?.(`使用本地引擎包 ${local}（${(bytes / 1048576).toFixed(1)} MB）`)
  } else {
    options.onProgress?.(`下载 ${source.label}`)
    let lastMegabyte = 0
    const downloaded = await download(source.url, OCR_ARCHIVE, (received, total) => {
      // One line per megabyte, not per chunk.
      const megabyte = Math.floor(received / (1024 * 1024))
      if (megabyte === lastMegabyte) return
      lastMegabyte = megabyte
      options.onProgress?.(
        total > 0
          ? `  已下载 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
          : `  已下载 ${megabyte} MB`,
      )
    })
    bytes = downloaded.bytes
    sha256 = downloaded.sha256
  }

  if (sha256 !== source.sha256) {
    if (local === null) rmSync(OCR_ARCHIVE, { force: true })
    throw new InstallError(
      `OCR 引擎包的 sha256 与清单不符，已拒绝安装：\n  期望 ${source.sha256}\n  实际 ${sha256}\n` +
        `  来源 ${local ?? source.url}`,
    )
  }
  options.onProgress?.(
    local === null ? `下载完成 ${(bytes / 1048576).toFixed(1)} MB，sha256 校验通过` : 'sha256 校验通过',
  )

  const entries = await extractArchive(archivePath, OCR_SCRATCH_DIR, sevenZip.path, options.onProgress)
  // Every package here wraps its contents in one top-level folder; the engine is lifted out of
  // it so the executable and `models/` sit together directly under `vendor/ocr/<id>`.
  const root = entries.length === 1 ? join(OCR_SCRATCH_DIR, entries[0]) : OCR_SCRATCH_DIR
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  cpSync(root, directory, { recursive: true })
  rmSync(OCR_SCRATCH_DIR, { recursive: true, force: true })
  if (local === null) rmSync(OCR_ARCHIVE, { force: true })

  const pruned = options.prune === true ? pruneLanguages(directory) : []
  const executable = source.executables.map((name) => join(directory, name)).find((path) => existsSync(path))
  if (executable === undefined) {
    throw new InstallError(`解包后没有找到 ${source.executables.join(' / ')}：${directory}`)
  }

  writeManifest({
    source: id,
    url: source.url,
    bytes,
    sha256,
    license: source.license,
    directory,
    executable,
    pruned,
    installedAt: new Date().toISOString(),
    sevenZip,
  })
  options.onProgress?.(`已安装到 ${directory}`)
  return { installed: true, source: id, directory, executable, pruned, bytes, sha256, notes, state: ocrInstallState() }
}

/**
 * Record an installation and make it the active source.
 * @param {object} record - what was installed.
 * @returns {void}
 */
function writeManifest(record) {
  const manifest = readManifest()
  const installed = manifest.installed.filter((entry) => entry.source !== record.source)
  installed.push(record)
  mkdirSync(OCR_VENDOR_DIR, { recursive: true })
  writeFileSync(
    OCR_MANIFEST,
    `${JSON.stringify({ active: record.source, installed, sevenZip: record.sevenZip ?? manifest.sevenZip }, null, 2)}\n`,
    { encoding: 'utf8' },
  )
}

/**
 * Delete recognition libraries for languages this plugin never asks for.
 *
 * The RapidOCR package ships six languages and each recogniser is 9-11 MB. Only the shared
 * detector, the direction classifier, and the Simplified Chinese recogniser and dictionary are
 * kept, which removes about 50 MB of files that would otherwise sit on disk unread.
 *
 * @param {string} directory - the installed engine directory.
 * @returns {string[]} the file names removed.
 */
export function pruneLanguages(directory) {
  const models = join(directory, 'models')
  if (!existsSync(models)) return []
  // The Simplified Chinese recognisers (v4, and the v3 the engine falls back to when v4 is
  // absent), the dictionary, and the shared detector and classifier are the whole keep list.
  const keep = /^(ch_PP-OCRv\d_det_infer\.onnx|ch_ppocr_mobile_v2\.0_cls_infer\.onnx|ch_PP-OCRv3_rec_infer\.onnx|rec_ch_PP-OCRv4_infer\.onnx|dict_chinese\.txt|ppocr_keys_v1\.txt|configs\.txt|config_universal\.txt)$/i
  const removed = []
  for (const entry of readdirSync(models, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    if (keep.test(entry.name)) continue
    rmSync(join(models, entry.name), { force: true })
    removed.push(entry.name)
  }
  return removed
}

/**
 * Remove one installed source, or all of them.
 * @param {string} [id] - the source to remove. Omit to remove every source and the tools directory.
 * @returns {{removed: string[], active: string|null}} what was removed.
 */
export function removeOcr(id) {
  const targets = id === undefined ? Object.keys(OCR_SOURCES) : [id]
  const removed = []
  for (const target of targets) {
    const directory = join(OCR_VENDOR_DIR, target)
    if (!existsSync(directory)) continue
    rmSync(directory, { recursive: true, force: true })
    removed.push(target)
  }
  const manifest = readManifest()
  const installed = manifest.installed.filter((entry) => !removed.includes(entry.source))
  mkdirSync(OCR_VENDOR_DIR, { recursive: true })
  writeFileSync(
    OCR_MANIFEST,
    `${JSON.stringify({ active: installed[0]?.source ?? null, installed, sevenZip: manifest.sevenZip }, null, 2)}\n`,
    { encoding: 'utf8' },
  )
  if (id === undefined) rmSync(OCR_TOOLS_DIR, { recursive: true, force: true })
  return { removed, active: installed[0]?.source ?? null }
}

/**
 * The source id the plugin should prefer.
 * @param {object} [config] - normalized plugin config.
 * @returns {string} an installed source id, or the default when none is installed.
 */
export function preferredSourceId(config) {
  const manifest = readManifest()
  const requested = config?.ocr?.source
  if (typeof requested === 'string' && requested !== '' && OCR_SOURCES[requested] !== undefined) {
    const directory = join(OCR_VENDOR_DIR, requested)
    if (OCR_SOURCES[requested].executables.some((name) => existsSync(join(directory, name)))) return requested
  }
  if (manifest.active !== null) {
    const directory = join(OCR_VENDOR_DIR, manifest.active)
    if (OCR_SOURCES[manifest.active]?.executables.some((name) => existsSync(join(directory, name)))) return manifest.active
  }
  for (const id of Object.keys(OCR_SOURCES)) {
    const directory = join(OCR_VENDOR_DIR, id)
    if (OCR_SOURCES[id].executables.some((name) => existsSync(join(directory, name)))) return id
  }
  return requested ?? DEFAULT_OCR_SOURCE
}
