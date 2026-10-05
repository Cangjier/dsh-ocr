/**
 * The deterministic core of `dsh-ocr`: pure ESM, no harness import, one barrel file.
 *
 * Nothing in this tree imports DSH. That is what makes the plugin's central claims checkable
 * offline — the coordinate arithmetic, the engine protocol, the similarity measure and the
 * archive verification are all ordinary functions and can be tested without a harness, a
 * network, or a 73 MB download.
 *
 * @module dsh-ocr/core
 */

export {
  FFPROBE_ENV,
  FFMPEG_ENV,
  FONT_CANDIDATES,
  PLUGIN_ROOT,
  findBinary,
  findCjkFont,
  fontDirectories,
  resolveCwd,
  sharedAssetsState,
  versionOf,
} from './env.mjs'

export {
  HOME_DIR_NAME,
  HOME_ENV,
  SHARED_FFMPEG_BIN,
  SHARED_FFMPEG_DIR,
  SHARED_LIB_DIR,
  SHARED_MATTE_DIR,
  SHARED_MODELS_DIR,
  SHARED_OCR_DIR,
  SHARED_ROOT,
  SHARED_RUNTIME_DIR,
  SHARED_YAMNET_DIR,
  binaryName,
  sharedHomeState,
  sharedPath,
} from './home.mjs'

export { FfmpegError, FfmpegNotFound, resetToolCache, resolveTool, run, runProbe } from './ffmpeg.mjs'

export { ProbeError, classify, probe, rotationOf } from './probe.mjs'

export {
  connectThroughProxy,
  download,
  httpFetch,
  InstallError,
  sha256Of,
  systemProxy,
} from './net.mjs'

export {
  DEFAULT_OCR_SOURCE,
  LEGACY_OCR_DIR,
  OCR_ARCHIVE,
  OCR_MANIFEST,
  OCR_SCRATCH_DIR,
  OCR_SEVEN_ZIP,
  OCR_SOURCES,
  OCR_TOOLS_DIR,
  OCR_VENDOR_DIR,
  SEVEN_ZIP,
  ensureSevenZip,
  extractArchive,
  installOcr,
  installedEngine,
  ocrDirs,
  ocrInstallState,
  preferredSourceId,
  pruneLanguages,
  readManifest,
  removeOcr,
} from './install.mjs'

export {
  HOME_DIR_NAME,
  HOME_ENV,
  SHARED_FFMPEG_BIN,
  SHARED_FFMPEG_DIR,
  SHARED_LIB_DIR,
  SHARED_MATTE_DIR,
  SHARED_MODELS_DIR,
  SHARED_OCR_DIR,
  SHARED_ROOT,
  SHARED_RUNTIME_DIR,
  SHARED_YAMNET_DIR,
  binaryName,
  sharedHomeState,
  sharedPath,
} from './home.mjs'

export {
  AUTO_TARGET_LONG_SIDE,
  DEFAULT_MAX_SIDE_LEN,
  DEFAULT_MIN_SCORE,
  DEFAULT_TIMEOUT_MS,
  ENGINES,
  ENGINE_PREFERENCES,
  IDLE_SHUTDOWN_MS,
  INIT_TIMEOUT_MS,
  INSTALL_HINT,
  OCR_FAULTS,
  OcrEnvironmentError,
  OcrError,
  OCR_SCRIPT,
  OCR_TMP_DIR,
  RAPID_LANGUAGES,
  asciiJson,
  checkEngineStartup,
  describeEngineCode,
  describeEngineFailure,
  disposeOcrSessions,
  engineState,
  findLines,
  modelRequirements,
  noEngineFault,
  normaliseEngineResult,
  normaliseText,
  ocrReport,
  parseRegion,
  prepareImage,
  preprocessFilter,
  readText,
  recogniseImage,
  recogniseViaWinRT,
  resolveOcrEngine,
  resolveScale,
  winrtArguments,
} from './engine.mjs'

export { environmentSummary, inspectFfmpeg, preflightOcr } from './preflight.mjs'

export {
  DEFAULT_LEAD_SECONDS,
  DEFAULT_MATCH_RATIO,
  DEFAULT_SAMPLE_FRAMES,
  normaliseSubtitleText,
  parseSrt,
  pickCues,
  textSimilarity,
  verifySubtitles,
} from './subtitles.mjs'

export {
  ARCHIVE_CANDIDATES,
  DEFAULT_RELEASE_BASE,
  DEFAULT_RELEASE_TAG,
  FFMPEG_VENDOR_BIN_DIR,
  FFMPEG_VENDOR_DIR,
  WANTED_BINARIES,
  extractBinaries,
  ffmpegVendoredState,
  installFfmpeg,
  removeFfmpegVendored,
} from './ffmpeg-install.mjs'
