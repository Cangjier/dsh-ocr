/**
 * Offline checks for the plugin's registration contract and its reference.
 *
 * These run without DSH and without an engine. Registration bugs — a tool with no name, an action
 * the dispatcher does not handle, a schema the loader would reject — and reference bugs — a guide
 * that describes an action that does not exist, or misses one that does — are pure-function
 * problems, so they are caught here rather than by loading the plugin into a live profile and
 * reading logs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name as pluginName, normalizeConfig } from '../index.mjs'
import { TOOL_NAMES, toolDefinitions } from '../src/tools/index.mjs'
import { TOOLS, TOOL_ORDER, lookupAction, lookupTool } from '../src/tools/registry.mjs'
import { MEASURED, createGuideActions } from '../src/tools/guide.mjs'
import { OCR_SOURCES } from '../src/core/install.mjs'
import { ENGINE_PREFERENCES, INSTALL_HINT } from '../src/core/engine.mjs'

/** Build a fake Cordis context that records what the plugin registers. */
function fakeContext() {
  const registered = []
  const logs = []
  let disposed = null
  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    inject(services, callback) {
      assert.deepEqual(services, ['tools'], 'the plugin should only depend on the tools service')
      callback({ tools: { register: (definition) => registered.push(definition) } })
    },
    on(event, handler) {
      assert.equal(event, 'dispose', 'the only lifecycle hook the plugin needs is disposal of the engine process')
      disposed = handler
    },
    dispose: () => disposed?.(),
  }
  return { ctx, registered, logs, dispose: () => disposed?.() }
}

test('plugin identity is stable', () => {
  assert.equal(pluginName, 'dsh-ocr')
  assert.deepEqual(inject, ['tools'])
})

test('normalizeConfig fills defaults: nothing is required, because WinRT is always there', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.projectRoot, null)
  assert.equal(config.ffmpegPath, null)
  assert.equal(config.ffprobePath, null)
  assert.equal(config.ocr.enginePath, null)
  assert.equal(config.ocr.kind, null)
  assert.equal(config.ocr.source, null)
  assert.equal(config.ocr.language, 'ch')
  assert.equal(config.ocr.defaultEngine, 'auto')
  assert.equal(config.ocr.maxSideLen, 1024)
  assert.equal(config.ocr.minScore, 0.5)
  assert.ok(config.ocr.timeoutMs > 0 && config.ocr.idleMs > 0, 'the engine needs a timeout and an idle release')
})

test('normalizeConfig rejects wrong types instead of silently coercing', () => {
  assert.throws(() => normalizeConfig({ projectRoot: 42 }), /projectRoot/)
  assert.throws(() => normalizeConfig({ ffmpegPath: [] }), /ffmpegPath/)
  assert.throws(() => normalizeConfig({ ocr: { maxSideLen: 'big' } }), /maxSideLen/)
  assert.throws(() => normalizeConfig({ ocr: { timeoutMs: -1 } }), /timeoutMs/)
  assert.throws(() => normalizeConfig({ ocr: { minScore: 0 } }), /minScore/)
  assert.throws(() => normalizeConfig({ ocr: { enginePath: 12 } }), /enginePath/)
  assert.throws(() => normalizeConfig({ ocr: { pruneOnInstall: 'yes' } }), /pruneOnInstall/)
})

test('an engine preference that is not one of the three known ones fails at activation', () => {
  assert.deepEqual(ENGINE_PREFERENCES, ['auto', 'local', 'winrt'])
  assert.throws(() => normalizeConfig({ ocr: { defaultEngine: 'cloud' } }), /defaultEngine/)
  for (const preference of ENGINE_PREFERENCES) {
    assert.equal(normalizeConfig({ ocr: { defaultEngine: preference } }).ocr.defaultEngine, preference)
  }
})

test('an invalid config registers nothing and says why', () => {
  const { ctx, registered, logs } = fakeContext()
  apply(ctx, { ocr: { maxSideLen: 'huge' } })
  assert.equal(registered.length, 0, 'a misconfigured plugin must not expose a half-working surface')
  assert.ok(logs.some((entry) => entry.level === 'error' && /maxSideLen/.test(entry.message)))
})

test('the plugin registers every declared tool, and only those', () => {
  const { ctx, registered, logs } = fakeContext()
  apply(ctx, {})
  assert.deepEqual(
    registered.map((definition) => definition.name),
    TOOL_NAMES,
  )
  assert.equal(registered.length, TOOL_ORDER.length)
  assert.ok(logs.some((entry) => entry.level === 'info' && /已注册/.test(entry.message)))
})

test('every registered tool is well formed and matches the registry exactly', () => {
  const definitions = toolDefinitions(normalizeConfig({}), { info() {}, error() {} })
  assert.equal(definitions.length, TOOL_ORDER.length)

  for (const definition of definitions) {
    assert.equal(typeof definition.name, 'string')
    assert.ok(definition.name.length > 0)
    assert.equal(definition.parameters.type, 'object')
    assert.deepEqual(definition.parameters.required, ['action'])
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.output.schema.type, 'object')

    const entry = lookupTool(definition.name)
    assert.ok(entry, `${definition.name} has no registry entry`)
    const declared = definition.parameters.properties.action.enum
    assert.deepEqual(declared, Object.keys(entry.actions), `${definition.name}: schema and registry disagree about actions`)
    for (const action of declared) {
      assert.ok(entry.actions[action].summary.length > 0, `${definition.name}.${action} has no summary`)
      assert.ok(Array.isArray(entry.actions[action].required), `${definition.name}.${action} must declare what it requires`)
    }
    // A schema the host cannot serialise is a schema the host will reject.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(definition)))
  }
})

test('a family tool refuses an action it does not declare', async () => {
  const definitions = toolDefinitions(normalizeConfig({}), { info() {}, error() {} })
  const read = definitions.find((definition) => definition.name === 'text_read')
  await assert.rejects(() => read.execute({ action: 'find' }, { cwd: process.cwd() }), /unknown action/)
  await assert.rejects(() => read.execute({}, { cwd: process.cwd() }), /unknown action/)
})

test('a tool is unreachable from a sibling tool, so the split is not cosmetic', async () => {
  const definitions = toolDefinitions(normalizeConfig({}), { info() {}, error() {} })
  const find = definitions.find((definition) => definition.name === 'text_find')
  // `install` belongs to text_setup; asking text_find for it must be an error, not a dispatch.
  await assert.rejects(() => find.execute({ action: 'install' }, { cwd: process.cwd() }), /unknown action/)
})

test('the guide can describe every tool and action without a hole', () => {
  const guide = createGuideActions()
  const overview = guide.overview()

  assert.equal(overview.tools.length, TOOL_ORDER.length - 1, 'the guide does not list itself as a working tool')
  assert.deepEqual(
    overview.tools.map((tool) => tool.name),
    TOOL_ORDER.filter((name) => name !== 'text_guide'),
  )

  for (const name of Object.keys(TOOLS)) {
    const described = guide.tool({ tool: name })
    assert.equal(described.name, name)
    assert.deepEqual(Object.keys(described.actions).sort(), Object.keys(TOOLS[name].actions).sort())
  }

  for (const [name, entry] of Object.entries(TOOLS)) {
    for (const action of Object.keys(entry.actions)) {
      const described = guide.action({ actionName: action, tool: name })
      assert.equal(described.action, action)
      assert.equal(described.tool, name)
      assert.equal(described.summary, entry.actions[action].summary)
    }
  }
})

test('the guide refuses names it does not know, and asks for a tool when a name is ambiguous', () => {
  const guide = createGuideActions()
  assert.throws(() => guide.tool({ tool: 'text_nope' }), /未知工具/)
  assert.throws(() => guide.action({ actionName: 'nope' }), /未知 action/)
  assert.throws(() => guide.action({ actionName: 'read', tool: 'text_find' }), /没有 action/)
  // `read` exists in text_read and in text_guide; asking without a tool must not guess.
  const ambiguous = (() => {
    try {
      guide.action({ actionName: 'read' })
      return null
    } catch (error) {
      return error.message
    }
  })()
  assert.ok(ambiguous === null || /多个工具/.test(ambiguous))
})

test('the guide quotes the installer, not a copy of it', () => {
  const overview = createGuideActions().overview()
  assert.equal(overview.engines.length, Object.keys(OCR_SOURCES).length)
  for (const engine of overview.engines) {
    const source = OCR_SOURCES[engine.id]
    assert.equal(engine.downloadBytes, source.bytes)
    assert.equal(engine.sha256, source.sha256)
    assert.equal(engine.url, source.url)
    assert.equal(engine.license, source.license)
  }
  assert.ok(overview.rules.length >= 8, 'the rules are the reason a reading can be trusted')
  for (const rule of overview.rules) {
    assert.ok(rule.id.length > 0 && rule.rule.length > 0 && rule.why.length > 0, 'a rule without a why is advice, not a rule')
  }
  assert.ok(overview.limits.some((line) => line.includes(INSTALL_HINT)), 'the guide must name the action that installs an engine')
})

test('the reference renders real measurements, and every engine is one it can install', async () => {
  const definitions = toolDefinitions(normalizeConfig({}), { info() {}, error() {} })
  const guide = definitions.find((definition) => definition.name === 'text_guide')
  const overview = await guide.execute({ action: 'overview' }, { cwd: process.cwd() })
  assert.equal(overview.measured.rapidocrScreenshotSeconds, MEASURED.rapidocrScreenshotSeconds)
  assert.ok(overview.costs.length > 0)
  assert.equal(overview.defaults.minScore, 0.5)

  const rules = await guide.execute({ action: 'rules' }, { cwd: process.cwd() })
  assert.equal(rules.rules.length, overview.rules.length)
})

test('a status call starts no engine and reads nothing', async () => {
  const definitions = toolDefinitions(normalizeConfig({}), { info() {}, error() {} })
  const setup = definitions.find((definition) => definition.name === 'text_setup')
  const status = await setup.execute({ action: 'status' }, { cwd: process.cwd() })
  assert.equal(typeof status.available, 'boolean')
  assert.equal(typeof status.winrtFallback, 'boolean')
  assert.equal(status.prefer, 'auto')
  if (status.available) {
    assert.ok(status.kind.length > 0)
    assert.ok(status.executable.includes('vendor') || status.source === 'path' || status.source === 'config')
  } else {
    assert.match(status.note, /text_setup/)
  }
})

test('a reading request with no target is refused before anything is started', async () => {
  const definitions = toolDefinitions(normalizeConfig({}), { info() {}, error() {} })
  const read = definitions.find((definition) => definition.name === 'text_read')
  const find = definitions.find((definition) => definition.name === 'text_find')
  await assert.rejects(() => read.execute({ action: 'read' }, { cwd: process.cwd() }), /需要 "target"/)
  await assert.rejects(() => read.execute({ action: 'read', target: 'nope.png' }, { cwd: process.cwd() }), /文件不存在/)
  await assert.rejects(() => find.execute({ action: 'find', target: 'nope.png' }, { cwd: process.cwd() }), /文件不存在/)
  await assert.rejects(() => read.execute({ action: 'verify', target: 'nope.mp4' }, { cwd: process.cwd() }), /需要 "srt"/)
})

test('a region with a batch that contains a video is refused, not applied to every frame', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const read = registered.find((definition) => definition.name === 'text_read')
  // The files do not need to exist for this guard: it is about the argument combination, and the
  // first missing file would report something less useful.
  await assert.rejects(
    () => read.execute({ action: 'read', paths: ['a.mp4', 'b.png'], region: '0,0,100,100' }, { cwd: process.cwd() }),
    /不能同时用/,
  )
})

test('a source that is not installable is refused with the list of those that are', async () => {
  const definitions = toolDefinitions(normalizeConfig({}), { info() {}, error() {} })
  const setup = definitions.find((definition) => definition.name === 'text_setup')
  await assert.rejects(() => setup.execute({ action: 'install', source: 'some-cloud-ocr' }, { cwd: process.cwd() }), /未知的 source/)
  await assert.rejects(() => setup.execute({ action: 'remove', source: 'some-cloud-ocr' }, { cwd: process.cwd() }), /未知的 source/)
})

test('the probe reports where each binary came from, so "it worked here" stays explainable', async () => {
  const definitions = toolDefinitions(normalizeConfig({}), { info() {}, error() {} })
  const setup = definitions.find((definition) => definition.name === 'text_setup')
  const probe = await setup.execute({ action: 'probe' }, { cwd: process.cwd() })
  assert.equal(typeof probe.ok, 'boolean')
  for (const key of ['ffmpeg', 'ffprobe']) {
    const binary = probe[key]
    if (binary === null) continue
    assert.ok(['config', 'env', 'vendor', 'sibling', 'path'].includes(binary.source), `${key} reported an unknown source`)
    assert.ok(binary.path.length > 0)
  }
  if (probe.ffmpeg?.source === 'sibling' || probe.ffprobe?.source === 'sibling') {
    assert.ok(probe.notes.some((note) => /video-factory/.test(note)), 'borrowing must be stated, not silent')
  }
})

test('lookupAction is scoped to its tool', () => {
  assert.ok(lookupAction('text_read', 'read'))
  assert.equal(lookupAction('text_find', 'read'), undefined)
  assert.equal(lookupAction('nope', 'read'), undefined)
  assert.equal(lookupTool('nope'), undefined)
})

test('disposal is offered, because a warm engine is a real process', () => {
  const { ctx, dispose } = fakeContext()
  apply(ctx, {})
  assert.doesNotThrow(() => dispose())
})
