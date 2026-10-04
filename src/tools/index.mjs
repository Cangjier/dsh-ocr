/**
 * Registers every model-facing `text_*` tool.
 *
 * The surface is deliberately small: three working tools plus one reference. Each working tool
 * dispatches on an `action`, because every schema enters the model context on every turn, and
 * the detail that does not decide a call lives in `text_guide` instead.
 *
 * The tool list itself comes from `registry.mjs`, so a tool cannot be registered without being
 * documented and cannot be documented without being registered — a mismatch fails at load time
 * rather than surfacing later as an under-documented schema.
 *
 * @module dsh-ocr/tools
 */
import { createFindTool } from './find.mjs'
import { createGuideActions, createGuideTool } from './guide.mjs'
import { createReadActions } from './read-actions.mjs'
import { createReadTool } from './read.mjs'
import { createSetupActions } from './setup-actions.mjs'
import { createSetupTool } from './setup.mjs'
import { TOOL_ORDER } from './registry.mjs'

/** Every tool name this plugin registers, in the order the surface presents them. */
export const TOOL_NAMES = [...TOOL_ORDER]

/**
 * Build every tool definition.
 *
 * Each family pairs a schema module (what the model sees) with an actions module (what actually
 * runs). Keeping them apart means the schema can be read and reviewed on its own, and that the
 * deterministic core is never reachable except through an action.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object[]} raw tool definitions.
 */
export function toolDefinitions(config, logger) {
  const readActions = createReadActions(config, logger)
  const setupActions = createSetupActions(config, logger)

  const definitions = [
    createReadTool(readActions),
    createFindTool({ find: readActions.find }),
    createSetupTool(setupActions),
    createGuideTool(createGuideActions()),
  ]

  const rank = (definition) => {
    const index = TOOL_ORDER.indexOf(definition.name)
    return index < 0 ? TOOL_ORDER.length : index
  }
  return definitions.sort((left, right) => rank(left) - rank(right))
}

/**
 * Register every tool on a context that already carries the `tools` service.
 *
 * A failing registration must not take the whole plugin down: the others are still useful, and
 * the failure is reported to the log.
 *
 * @param {object} toolsCtx - the sub-context providing `tools`.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {{registered: string[], failed: {name: string, error: string}[]}} the outcome.
 */
export function registerTools(toolsCtx, config, logger) {
  const registered = []
  const failed = []
  for (const definition of toolDefinitions(config, logger)) {
    try {
      toolsCtx.tools.register(definition)
      registered.push(definition.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ name: definition.name, error: message })
      logger.error(`dsh-ocr: 注册工具 ${definition.name} 失败：${message}`)
    }
  }
  logger.info(`dsh-ocr: 已注册 ${registered.length} 个工具：${registered.join(', ')}`)
  return { registered, failed }
}
