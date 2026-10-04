/**
 * `text_setup` actions: what is installed, what would answer a call, and how to change it.
 *
 * Every handler here reports what it actually did. An install that found an engine already
 * present says so instead of claiming to have installed one, and `status` never starts an engine
 * — it answers "which engine would answer" from the file system alone, which is the difference
 * between a diagnostic you can run at any time and one that costs half a gigabyte of resident
 * memory. `preflight` is the deliberate opposite: the one action that *does* start the engine,
 * because a missing runtime DLL or an unpacked-incomplete model set is invisible until it runs.
 *
 * @module dsh-ocr/tools/setup-actions
 */
import { OCR_SOURCES, installOcr, ocrInstallState, removeOcr } from '../core/install.mjs'
import { InstallError } from '../core/net.mjs'
import { ocrReport } from '../core/engine.mjs'
import { inspectFfmpeg, preflightOcr } from '../core/preflight.mjs'
import { installFfmpeg } from '../core/ffmpeg-install.mjs'
import { OcrPluginError } from './shared.mjs'

/**
 * The source an engine operation refers to when the caller names none.
 * @param {object} config - normalized plugin config.
 * @returns {string|undefined} a source id, or undefined for "every source".
 */
function defaultSource(config) {
  const requested = config?.ocr?.source
  return typeof requested === 'string' && requested !== '' ? requested : undefined
}

/**
 * Build the `text_setup` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createSetupActions(config, logger) {
  return {
    /**
     * Report engine availability without reading anything.
     * @returns {object} the report.
     */
    status() {
      return ocrReport(config)
    },

    /**
     * Report whether ffmpeg and ffprobe were found, and how.
     * @returns {Promise<object>} the report.
     */
    async probe() {
      return inspectFfmpeg(config)
    },

    /**
     * Start the engine once and report whether this machine can read text right now.
     *
     * @returns {Promise<object>} the preflight report, with `verdict` ready / degraded / unusable.
     */
    async preflight() {
      return preflightOcr(config, {})
    },

    /**
     * Install an engine, optionally with a private ffmpeg.
     *
     * @param {object} args - the tool arguments.
     * @returns {Promise<object>} what was installed.
     */
    async install(args) {
      const id = typeof args.source === 'string' && args.source !== '' ? args.source : undefined
      if (id !== undefined && OCR_SOURCES[id] === undefined) {
        throw new OcrPluginError(
          `text_setup install: 未知的 source ${JSON.stringify(id)}；可选：${Object.keys(OCR_SOURCES).join(', ')}`,
        )
      }
      if (args.prune !== undefined && typeof args.prune !== 'boolean') {
        throw new OcrPluginError('text_setup install: "prune" 必须是布尔值。')
      }

      const result = { ok: true, notes: [] }
      try {
        result.engine = await installOcr({
          source: id,
          prune: args.prune === true,
          force: args.force === true,
          archive: typeof args.archive === 'string' && args.archive !== '' ? args.archive : undefined,
          onProgress: (line) => logger.info(`dsh-ocr install: ${line}`),
        })
      } catch (error) {
        if (error instanceof InstallError) throw new OcrPluginError(`安装 OCR 引擎失败：${error.message}`)
        throw error
      }
      result.notes.push(...(result.engine.notes ?? []))

      if (args.ffmpeg === true) {
        try {
          result.ffmpeg = await installFfmpeg({
            force: args.force === true,
            onProgress: (line) => logger.info(`dsh-ocr ffmpeg: ${line}`),
          })
        } catch (error) {
          if (error instanceof InstallError) throw new OcrPluginError(`安装 ffmpeg 失败：${error.message}`)
          throw error
        }
      }

      result.state = ocrInstallState()
      result.ocr = ocrReport(config)
      return result
    },

    /**
     * Remove an engine, or every engine.
     *
     * @param {object} args - the tool arguments.
     * @returns {Promise<object>} what was removed.
     */
    async remove(args) {
      const id = typeof args.source === 'string' && args.source !== '' ? args.source : defaultSource(config)
      if (id !== undefined && OCR_SOURCES[id] === undefined) {
        throw new OcrPluginError(
          `text_setup remove: 未知的 source ${JSON.stringify(id)}；可选：${Object.keys(OCR_SOURCES).join(', ')}`,
        )
      }
      const result = removeOcr(id)
      return { ok: true, ...result, state: ocrInstallState(), ocr: ocrReport(config) }
    },
  }
}
