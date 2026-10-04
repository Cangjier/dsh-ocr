/**
 * The `dsh-ocr` Host plugin: deterministic OCR tools for DSH.
 *
 * The plugin is a plain ESM module with no harness import, so a profile can install it without a
 * build step and without a dependency edge on the harness packages it composes with. It validates
 * its own config, because validating through the Loader would require the dependency this module
 * exists to avoid.
 *
 * Division of labour, which the rest of the code depends on:
 *   DSH decides what the picture means — whether the reading is good enough, which label to
 *   press, what the text implies.
 *   This plugin only executes: same input, same output. It reports characters and coordinates.
 *
 * @module dsh-ocr
 */
import { registerTools } from './src/tools/index.mjs'
import {
  DEFAULT_MAX_SIDE_LEN,
  DEFAULT_MIN_SCORE,
  DEFAULT_TIMEOUT_MS,
  ENGINE_PREFERENCES,
  IDLE_SHUTDOWN_MS,
  disposeOcrSessions,
} from './src/core/engine.mjs'
import { environmentSummary } from './src/core/preflight.mjs'

/** Stable Cordis plugin name. */
export const name = 'dsh-ocr'

/** Services required before tools can be registered. */
export const inject = ['tools']

/** Default recognition language: Simplified Chinese, which still reads Latin text correctly. */
export const DEFAULT_LANGUAGE = 'ch'

/** Default engine preference: the installed engine, falling back to the Windows recogniser. */
export const DEFAULT_ENGINE = 'auto'

export { ENGINE_PREFERENCES }

/**
 * Read an optional string field, allowing null to mean "use the default".
 * @param {object} raw - the raw config object.
 * @param {string} key - field name.
 * @param {string|null} fallback - value used when the field is absent or null.
 * @param {string} where - path used in the error message.
 * @returns {string|null} the resolved value.
 * @throws {TypeError} when the field is present and not a string.
 */
function optionalString(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new TypeError(`dsh-ocr: ${where} must be a string or null`)
  return value
}

/**
 * Read an optional positive number field.
 * @param {object} raw - the raw config object.
 * @param {string} key - field name.
 * @param {number} fallback - value used when the field is absent.
 * @param {string} where - path used in the error message.
 * @returns {number} the resolved value.
 * @throws {TypeError} when the field is present and not a positive number.
 */
function optionalPositiveNumber(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`dsh-ocr: ${where} must be a positive number`)
  }
  return value
}

/**
 * Read an optional boolean-ish field, rejecting anything that is not a boolean.
 * @param {object} raw - the raw config object.
 * @param {string} key - field name.
 * @param {boolean} fallback - value used when the field is absent.
 * @param {string} where - path used in the error message.
 * @returns {boolean} the resolved value.
 * @throws {TypeError} when the field is present and not a boolean.
 */
function optionalBoolean(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`dsh-ocr: ${where} must be a boolean`)
  return value
}

/**
 * Validate and normalize the row's config.
 *
 * Misconfiguration fails loud here, at activation, rather than surfacing later as a confusing
 * tool error. Nothing here is required: with an empty config and nothing installed, the plugin
 * still works through the Windows recogniser.
 *
 * @param {object} [raw] - the row's `config`.
 * @returns {object} the normalized config.
 * @throws {TypeError} when a field has the wrong type.
 * @throws {TypeError} when `ocr.defaultEngine` is not one of the known preferences.
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const ocr = config.ocr ?? {}
  const defaultEngine = optionalString(ocr, 'defaultEngine', DEFAULT_ENGINE, 'config.ocr.defaultEngine')
  if (!ENGINE_PREFERENCES.includes(defaultEngine)) {
    throw new TypeError(
      `dsh-ocr: config.ocr.defaultEngine must be one of ${ENGINE_PREFERENCES.join(', ')}; got ${JSON.stringify(defaultEngine)}`,
    )
  }

  return {
    projectRoot: optionalString(config, 'projectRoot', null, 'config.projectRoot'),
    ffmpegPath: optionalString(config, 'ffmpegPath', null, 'config.ffmpegPath'),
    ffprobePath: optionalString(config, 'ffprobePath', null, 'config.ffprobePath'),
    ocr: {
      // Everything here is optional: with no engine installed, recognition falls back to the
      // Windows recogniser and the rest of the plugin is unaffected.
      enginePath: optionalString(ocr, 'enginePath', null, 'config.ocr.enginePath'),
      kind: optionalString(ocr, 'kind', null, 'config.ocr.kind'),
      source: optionalString(ocr, 'source', null, 'config.ocr.source'),
      language: optionalString(ocr, 'language', DEFAULT_LANGUAGE, 'config.ocr.language'),
      defaultEngine,
      maxSideLen: optionalPositiveNumber(ocr, 'maxSideLen', DEFAULT_MAX_SIDE_LEN, 'config.ocr.maxSideLen'),
      timeoutMs: optionalPositiveNumber(ocr, 'timeoutMs', DEFAULT_TIMEOUT_MS, 'config.ocr.timeoutMs'),
      idleMs: optionalPositiveNumber(ocr, 'idleMs', IDLE_SHUTDOWN_MS, 'config.ocr.idleMs'),
      minScore: optionalPositiveNumber(ocr, 'minScore', DEFAULT_MIN_SCORE, 'config.ocr.minScore'),
      scale: optionalString(ocr, 'scale', null, 'config.ocr.scale'),
      pruneOnInstall: optionalBoolean(ocr, 'pruneOnInstall', false, 'config.ocr.pruneOnInstall'),
    },
  }
}

/**
 * Mount the tools.
 *
 * Registration is wrapped so a failure to reach the `tools` service is logged clearly instead of
 * looking like a silent no-op: a plugin that loads but exposes nothing is the hardest kind of
 * failure to notice.
 *
 * @param {object} ctx - plugin context.
 * @param {object} rawConfig - the row's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    ctx.logger.error(`dsh-ocr: 配置无效，插件未注册任何工具：${error.message}`)
    return
  }

  ctx.inject(['tools'], (toolsCtx) => {
    const outcome = registerTools(toolsCtx, config, ctx.logger)
    if (outcome.registered.length === 0) {
      ctx.logger.error('dsh-ocr: 没有注册任何工具，插件实际上不可用')
      return
    }
    // Say out loud what this machine can currently do. It costs a few stat() calls and starts
    // nothing: a missing engine is not an error (the Windows recogniser is a supported answer,
    // so it is logged as information), but an engine that is present and cannot be used is, and
    // a caller that never learns about either reads a worse transcript with no way to know.
    try {
      const environment = environmentSummary(config)
      const broken = environment.fault !== null && environment.fault.code !== 'no-engine'
      const line = `dsh-ocr: ${environment.message}`
      if (broken || environment.verdict === 'unusable') ctx.logger.warn(line)
      else ctx.logger.info(line)
    } catch (error) {
      ctx.logger.warn(`dsh-ocr: 环境检查失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // A warm engine is a real process holding hundreds of megabytes; it must not outlive the
  // plugin that started it. `on` is optional because a minimal composition need not expose it.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      disposeOcrSessions()
    })
  }
}
