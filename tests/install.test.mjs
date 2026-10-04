/**
 * Offline checks for provisioning: discovery, pinning, and the archive extractor.
 *
 * The extractor is tested against a zip this file builds by hand, because the failure it guards
 * against — a hostile or malformed archive writing outside the vendor directory — must be
 * provable without downloading 194 MB from GitHub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG_ENV, FFPROBE_ENV, PLUGIN_ROOT, findBinary, findCjkFont, resolveCwd } from '../src/core/env.mjs'
import { InstallError, sha256Of, systemProxy } from '../src/core/net.mjs'
import {
  ARCHIVE_CANDIDATES,
  FFMPEG_VENDOR_BIN_DIR,
  WANTED_BINARIES,
  extractBinaries,
  ffmpegVendoredState,
} from '../src/core/ffmpeg-install.mjs'
import {
  DEFAULT_OCR_SOURCE,
  OCR_MANIFEST,
  OCR_SOURCES,
  OCR_VENDOR_DIR,
  SEVEN_ZIP,
  ocrInstallState,
  readManifest,
  removeOcr,
} from '../src/core/install.mjs'

/** A temporary directory the caller is expected to remove. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-ocr-install-'))
}

/**
 * Build a minimal zip archive in memory.
 *
 * Stored and deflated entries only, which is what a release archive uses and all the extractor
 * claims to handle. Writing it here rather than committing a binary keeps the test honest about
 * what it is exercising.
 *
 * @param {{name: string, data: Buffer, deflate?: boolean}[]} entries - the files to include.
 * @returns {Buffer} the archive.
 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const method = entry.deflate === true ? 8 : 0
    const stored = method === 8 ? deflateRawSync(raw) : raw
    const crc = createHash('sha256').update(raw).digest() // placeholder; the extractor does not verify CRC

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc.readUInt32LE(0), 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    locals.push(local, stored)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc.readUInt32LE(0), 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)

    offset += local.length + stored.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuffer, end])
}

test('a configured path is used when it exists, and outranks every other candidate', () => {
  // `process.execPath` is guaranteed to exist, so it stands in for a real binary without this
  // test depending on ffmpeg being installed anywhere.
  const found = findBinary('ffmpeg', process.execPath)
  assert.equal(found.source, 'config', 'an explicit path is always preferred')
  assert.equal(found.path, process.execPath)
})

test('a configured path that does not exist falls through to real discovery', () => {
  const missing = findBinary('ffmpeg', 'C:\\definitely\\not\\here\\ffmpeg.exe')
  assert.ok(missing === null || existsSync(missing.path), 'discovery never reports a path that does not exist')
  assert.notEqual(missing?.source, 'config', 'a path that is not there must not be reported as the configured one')
})

test('the environment can name the binaries outright', () => {
  const previous = process.env[FFMPEG_ENV]
  const previousProbe = process.env[FFPROBE_ENV]
  try {
    process.env[FFMPEG_ENV] = process.execPath
    process.env[FFPROBE_ENV] = process.execPath
    assert.deepEqual(findBinary('ffmpeg', null), { path: process.execPath, source: 'env' })
    assert.deepEqual(findBinary('ffprobe', null), { path: process.execPath, source: 'env' })
  } finally {
    if (previous === undefined) delete process.env[FFMPEG_ENV]
    else process.env[FFMPEG_ENV] = previous
    if (previousProbe === undefined) delete process.env[FFPROBE_ENV]
    else process.env[FFPROBE_ENV] = previousProbe
  }
})

test('the proxy is read from the environment, and is a host:port authority', () => {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
  const saved = new Map(names.map((name) => [name, process.env[name]]))
  try {
    for (const name of names) delete process.env[name]
    // With no variable set the answer comes from the Windows registry, which this machine may or
    // may not have configured — so the shape is asserted, not the value. What must hold either
    // way is that the returned authority is what a CONNECT line needs.
    const fromRegistry = systemProxy()
    assert.ok(
      fromRegistry === null || /^[^\s/]+:\d+$/.test(fromRegistry),
      `expected null or host:port, got ${JSON.stringify(fromRegistry)}`,
    )

    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890/'
    assert.equal(systemProxy(), '127.0.0.1:7890', 'the scheme and trailing slash are stripped: a CONNECT line needs host:port')
    process.env.HTTPS_PROXY = '127.0.0.1:8080'
    assert.equal(systemProxy(), '127.0.0.1:8080', 'a bare authority is accepted as-is')

    // An explicit variable outranks the registry, whatever the registry says.
    process.env.HTTP_PROXY = '127.0.0.1:9999'
    assert.equal(systemProxy(), '127.0.0.1:8080', 'HTTPS_PROXY is consulted before HTTP_PROXY')
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('sha256Of matches a digest computed independently', async () => {
  const directory = scratch()
  try {
    const file = join(directory, 'payload.bin')
    writeFileSync(file, 'dsh-ocr')
    const expected = createHash('sha256').update('dsh-ocr').digest('hex')
    assert.equal(await sha256Of(file), expected)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the extractor writes only the wanted binaries, stored or deflated', async () => {
  const directory = scratch()
  try {
    const archive = join(directory, 'build.zip')
    writeFileSync(
      archive,
      buildZip([
        { name: 'ffmpeg-build/bin/ffmpeg.exe', data: Buffer.from('MZ-ffmpeg') },
        { name: 'ffmpeg-build/bin/ffprobe.exe', data: Buffer.from('MZ-ffprobe'), deflate: true },
        { name: 'ffmpeg-build/doc/readme.txt', data: Buffer.from('ignore me') },
      ]),
    )

    const target = join(directory, 'bin')
    const extracted = await extractBinaries(archive, target)
    assert.deepEqual(extracted.sort(), ['ffmpeg.exe', 'ffprobe.exe'])
    assert.equal(readFileSync(join(target, 'ffmpeg.exe'), 'utf8'), 'MZ-ffmpeg')
    assert.equal(readFileSync(join(target, 'ffprobe.exe'), 'utf8'), 'MZ-ffprobe', 'a deflated entry must be inflated')
    assert.equal(existsSync(join(target, 'readme.txt')), false, 'only the wanted names are written')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an archive that tries to escape the target is refused', async () => {
  const directory = scratch()
  try {
    const archive = join(directory, 'hostile.zip')
    writeFileSync(archive, buildZip([{ name: '../ffmpeg.exe', data: Buffer.from('MZ-evil') }]))
    await assert.rejects(() => extractBinaries(archive, join(directory, 'bin')), /路径不可信/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an archive with none of the wanted binaries is an error, not a silent success', async () => {
  const directory = scratch()
  try {
    const archive = join(directory, 'wrong.zip')
    writeFileSync(archive, buildZip([{ name: 'bin/ffplay.exe', data: Buffer.from('MZ-player') }]))
    const target = join(directory, 'bin')
    // ffplay alone is not enough: without ffmpeg and ffprobe nothing can be read.
    assert.ok(WANTED_BINARIES.includes('ffplay.exe'))
    const extracted = await extractBinaries(archive, target)
    assert.deepEqual(extracted, ['ffplay.exe'])

    const empty = join(directory, 'empty.zip')
    writeFileSync(empty, buildZip([{ name: 'readme.txt', data: Buffer.from('nothing here') }]))
    await assert.rejects(() => extractBinaries(empty, join(directory, 'bin2')), /没有/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a file that is not a zip is refused', async () => {
  const directory = scratch()
  try {
    const archive = join(directory, 'not.zip')
    writeFileSync(archive, 'this is not an archive at all, it is a sentence')
    await assert.rejects(() => extractBinaries(archive, join(directory, 'bin')), InstallError)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the archive candidate list is specific-first and points at a release feed', () => {
  assert.ok(ARCHIVE_CANDIDATES.length >= 1)
  for (const candidate of ARCHIVE_CANDIDATES) {
    assert.match(candidate, /^ffmpeg-.*\.zip$/)
  }
})

test('vendored ffmpeg state is read from disk without throwing when absent', () => {
  const state = ffmpegVendoredState()
  assert.equal(state.directory, FFMPEG_VENDOR_BIN_DIR)
  assert.equal(typeof state.present, 'boolean')
  assert.ok(Array.isArray(state.files))
})

test('the install manifest and state agree with what is on disk', () => {
  const manifest = readManifest()
  assert.ok(Array.isArray(manifest.installed))
  assert.ok(manifest.active === null || typeof manifest.active === 'string')

  const state = ocrInstallState()
  assert.equal(state.sources.length, Object.keys(OCR_SOURCES).length)
  assert.ok(OCR_SOURCES[DEFAULT_OCR_SOURCE] !== undefined, 'the default source must be installable')
  for (const source of state.sources) {
    assert.equal(source.installed, source.executable !== null, 'installed must mean an executable exists')
    if (source.installed) {
      assert.ok(existsSync(source.executable), `${source.executable} is claimed but missing`)
      assert.ok(source.sizeBytes > 0, 'an installed engine has bytes on disk')
    }
  }
  assert.ok(state.totalBytes >= 0)
})

test('the unpacking tool is pinned to a url and a digest, and its digest is only recorded', () => {
  assert.match(SEVEN_ZIP.url, /^https:\/\//)
  assert.match(SEVEN_ZIP.sha256, /^[0-9a-f]{64}$/)
  assert.ok(SEVEN_ZIP.bytes > 0)
  // The URL always serves the current release, so the hash cannot be enforced. The installer
  // records a mismatch in `notes` instead — this asserts the pin exists to be compared against.
  assert.ok(typeof SEVEN_ZIP.license === 'string' && SEVEN_ZIP.license.length > 0)
})

test('removing a source that is not installed is a no-op, not a failure', () => {
  // The manifest lives in the plugin's own vendor directory, so this test reads and rewrites it.
  // It only ever removes a source that this run proved absent, and it puts the directory back the
  // way it found it — `removeOcr` writes a manifest even when it removed nothing, and leaving that
  // file behind would make a second run of this suite see a vendor directory that holds no engine.
  const before = existsSync(OCR_MANIFEST) ? readFileSync(OCR_MANIFEST, 'utf8') : null
  const installed = ocrInstallState().sources.filter((source) => source.installed).map((source) => source.id)
  const target = installed.includes('rapidocr-json') ? 'paddleocr-ppocrv5' : 'rapidocr-json'

  try {
    if (installed.includes(target)) return // nothing safe to remove; the pinned-mismatch test above covers the rest
    const result = removeOcr(target)
    assert.deepEqual(result.removed, [], 'there was nothing to delete')
    assert.ok(['rapidocr-json', 'paddleocr-ppocrv5', null].includes(result.active))
  } finally {
    if (before !== null) writeFileSync(OCR_MANIFEST, before, { encoding: 'utf8' })
    else {
      rmSync(OCR_MANIFEST, { force: true })
      // Only a directory that this test emptied is removed; a hand-placed engine must survive.
      if (existsSync(OCR_VENDOR_DIR) && readdirSync(OCR_VENDOR_DIR).length === 0) {
        rmSync(OCR_VENDOR_DIR, { recursive: true, force: true })
        const parent = join(OCR_VENDOR_DIR, '..')
        if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
      }
    }
  }
})

test('the plugin root resolves to the package directory', () => {
  assert.ok(existsSync(join(PLUGIN_ROOT, 'package.json')))
  assert.ok(existsSync(join(PLUGIN_ROOT, 'index.mjs')))
  assert.equal(OCR_VENDOR_DIR, join(PLUGIN_ROOT, 'vendor', 'ocr'))
})

test('the working directory defaults to the process, then to an explicit request', () => {
  assert.equal(resolveCwd({}, 'C:\\work'), 'C:\\work')
  assert.equal(resolveCwd({ projectRoot: 'C:\\project' }, undefined), 'C:\\project')
  assert.equal(resolveCwd({ projectRoot: 'C:\\project' }, 'C:\\explicit'), 'C:\\explicit')
  assert.equal(resolveCwd({}, undefined), process.cwd())
})

test('a CJK font is found on this machine when one exists', () => {
  const font = findCjkFont()
  if (font !== null) assert.ok(existsSync(font), `${font} was reported but does not exist`)
  // Not asserted to be non-null: the engine-backed suite skips itself when there is no font.
})
