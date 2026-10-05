/**
 * Provisioning ffmpeg, into the one directory the whole plugin family shares.
 *
 * This plugin does **not** need its own ffmpeg: the shared home, a sibling video-factory
 * checkout's build, `DSH_OCR_FFMPEG`, or PATH all work, and reading a still image with no region
 * needs no ffmpeg at all. So this installer exists for the one machine where none of those is
 * true — a host that only ever reads screenshots and has no video project beside it — and it
 * writes to `~/.dsh-plugins/ffmpeg/bin`, where the other five plugins will then find it.
 *
 * It is deliberately the same release the sibling projects pin, so a machine does not end up with
 * two ffmpeg generations that behave differently on the same file. The archive's digest is
 * recorded rather than enforced, because the release tag is `latest`: a new upstream build
 * legitimately changes the bytes.
 *
 * The extractor is deliberately narrow: it writes only the entries whose base name is one of the
 * wanted binaries, and refuses absolute or parent-relative names, so a hostile archive cannot
 * escape the target directory.
 *
 * @module dsh-ocr/core/ffmpeg-install
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { InstallError, download } from './net.mjs'
import { SHARED_FFMPEG_BIN, SHARED_FFMPEG_DIR } from './home.mjs'

/** Where the shared build lives: the same directory `ffmpeg_setup {action:"install"}` writes. */
export const FFMPEG_VENDOR_DIR = SHARED_FFMPEG_DIR

/** The binary directory discovery looks in first. */
export const FFMPEG_VENDOR_BIN_DIR = SHARED_FFMPEG_BIN

/** BtbN's Windows GPL static build release feed, the same one the sibling plugin pins. */
export const DEFAULT_RELEASE_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download'

/** The release tag used. A tagged build beats master for reproducibility. */
export const DEFAULT_RELEASE_TAG = 'latest'

/** Archive names to try, most specific first. */
export const ARCHIVE_CANDIDATES = [
  'ffmpeg-n9.0-latest-win64-gpl-9.0.zip',
  'ffmpeg-master-latest-win64-gpl.zip',
]

/** Only these executables are extracted from the archive. */
export const WANTED_BINARIES = ['ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe']

/**
 * Locate the end-of-central-directory record in a zip file.
 *
 * Scanned from the end because the archive comment makes the offset variable. The signature is
 * `PK\x05\x06`.
 *
 * @param {Buffer} buffer - the whole archive.
 * @returns {{centralOffset: number, centralSize: number, entryCount: number}|null} the record.
 */
function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 66_000)
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue
    return {
      entryCount: buffer.readUInt16LE(offset + 10),
      centralSize: buffer.readUInt32LE(offset + 12),
      centralOffset: buffer.readUInt32LE(offset + 16),
    }
  }
  return null
}

/**
 * Extract the wanted executables from a zip archive into the vendor bin directory.
 *
 * Only stored and deflated entries are handled, which is what a release archive uses. Names are
 * validated before use so an archive cannot write outside the target.
 *
 * @param {string} archivePath - the downloaded zip.
 * @param {string} targetDir - the directory to write binaries into.
 * @param {(message: string) => void} [onProgress] - progress notes.
 * @returns {Promise<string[]>} the extracted file names.
 * @throws {InstallError} when the archive is unreadable or contains none of the wanted files.
 */
export async function extractBinaries(archivePath, targetDir, onProgress) {
  const buffer = await readFile(archivePath)
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd === null) throw new InstallError(`不是有效的 zip 文件：${archivePath}`)

  const { inflateRawSync } = await import('node:zlib')
  mkdirSync(targetDir, { recursive: true })

  const extracted = []
  let offset = eocd.centralOffset
  for (let index = 0; index < eocd.entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    const base = name.split('/').pop()
    if (!WANTED_BINARIES.includes(base)) continue
    // Reject anything that could escape the destination, even though only the base name is used,
    // so a malformed archive is refused rather than silently normalized.
    if (name.startsWith('/') || name.includes('..')) {
      throw new InstallError(`压缩包里的路径不可信：${name}`)
    }

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new InstallError(`压缩包结构损坏（本地头缺失）：${name}`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let contents
    if (method === 0) contents = raw
    else if (method === 8) contents = inflateRawSync(raw)
    else throw new InstallError(`不支持的压缩方式 ${method}：${name}`)

    const destination = join(targetDir, base)
    await writeFile(destination, contents)
    extracted.push(base)
    onProgress?.(`解压 ${base}（${contents.length} 字节）`)
  }

  if (extracted.length === 0) {
    throw new InstallError(`压缩包里没有 ${WANTED_BINARIES.join(' / ')}；下载的可能是错误的构建。`)
  }
  return extracted
}

/**
 * Report what the shared build currently looks like.
 * @returns {{present: boolean, directory: string, files: string[], sizeBytes: number}} the state.
 */
export function ffmpegVendoredState() {
  if (!existsSync(FFMPEG_VENDOR_BIN_DIR)) {
    return { present: false, directory: FFMPEG_VENDOR_BIN_DIR, files: [], sizeBytes: 0 }
  }
  const files = readdirSync(FFMPEG_VENDOR_BIN_DIR)
  let sizeBytes = 0
  for (const file of files) {
    try {
      sizeBytes += statSync(join(FFMPEG_VENDOR_BIN_DIR, file)).size
    } catch {
      // A file that vanished mid-listing simply does not count.
    }
  }
  return { present: true, directory: FFMPEG_VENDOR_BIN_DIR, files, sizeBytes }
}

/**
 * Remove the shared build.
 *
 * The directory belongs to the family rather than to this plugin — `dsh-ffmpeg` installs it — so
 * removing it here is a deliberate act that breaks every plugin until one reinstalls it.
 *
 * @returns {boolean} whether anything was removed.
 */
export function removeFfmpegVendored() {
  if (!existsSync(FFMPEG_VENDOR_DIR)) return false
  rmSync(FFMPEG_VENDOR_DIR, { recursive: true, force: true })
  return true
}

/**
 * Download and install ffmpeg into the shared home.
 *
 * @param {object} [options] - install options.
 * @param {(message: string) => void} [options.onProgress] - progress notes.
 * @param {boolean} [options.force] - reinstall even when a build is present.
 * @returns {Promise<object>} what was installed.
 * @throws {InstallError} when no candidate archive can be fetched.
 */
export async function installFfmpeg(options = {}) {
  const state = ffmpegVendoredState()
  if (state.present && options.force !== true) {
    return { installed: false, reason: '已存在', ...state }
  }

  mkdirSync(FFMPEG_VENDOR_DIR, { recursive: true })
  const scratch = join(FFMPEG_VENDOR_DIR, 'download.zip')
  const failures = []
  for (const archive of ARCHIVE_CANDIDATES) {
    const url = `${DEFAULT_RELEASE_BASE}/${DEFAULT_RELEASE_TAG}/download/${archive}`
    options.onProgress?.(`尝试下载 ${url}`)
    try {
      const { bytes, sha256 } = await download(url, scratch, (received, total) => {
        if (options.onProgress === undefined) return
        if (total > 0 && received % (8 * 1024 * 1024) < 64 * 1024) {
          options.onProgress(`已下载 ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`)
        }
      })
      options.onProgress?.(`下载完成 ${(bytes / 1024 / 1024).toFixed(1)} MB，sha256 ${sha256}`)
      const files = await extractBinaries(scratch, FFMPEG_VENDOR_BIN_DIR, options.onProgress)
      writeFileSync(
        join(FFMPEG_VENDOR_DIR, 'SOURCE.json'),
        `${JSON.stringify({ url, bytes, sha256, files, installedAt: new Date().toISOString(), ownedBy: 'dsh-ffmpeg' }, null, 2)}\n`,
        { encoding: 'utf8' },
      )
      rmSync(scratch, { force: true })
      return { installed: true, url, bytes, sha256, files, directory: FFMPEG_VENDOR_DIR }
    } catch (error) {
      failures.push(`${archive}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  rmSync(scratch, { force: true })
  throw new InstallError(
    `所有候选构建都安装失败：\n${failures.map((line) => `  - ${line}`).join('\n')}\n` +
      `可以手动下载 ffmpeg 静态构建，把 ffmpeg.exe / ffprobe.exe 放进 ${FFMPEG_VENDOR_BIN_DIR}。`,
  )
}
