#!/usr/bin/env node
/**
 * The command line for `dsh-ocr`.
 *
 * It exposes the same operations the `text_*` tools do, for two reasons: a reading can be checked
 * without an agent in the loop, and the test suite can drive the real code paths. It deliberately
 * has no "read everything and summarise it" subcommand — deciding what the text means is the
 * caller's job, which is the whole point of the plugin's design.
 *
 * Usage: node src/bin/ocr.mjs <command> [options]
 *
 * @module dsh-ocr/bin
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { findBinary, versionOf } from '../core/env.mjs'
import {
  OCR_SOURCES,
  installOcr,
  ocrInstallState,
  removeOcr,
} from '../core/install.mjs'
import {
  ENGINE_PREFERENCES,
  OcrError,
  findLines,
  ocrReport,
  parseRegion,
  readText,
  resolveOcrEngine,
} from '../core/engine.mjs'
import { normalizeConfig } from '../../index.mjs'

/** Print a JSON result. */
const emit = (value) => console.log(JSON.stringify(value, null, 2))

/** Parse the shared reading options into the core's option shape. */
function readOptions(values) {
  return {
    config: normalizeConfig({}),
    engine: values.engine,
    region: parseRegion(values.region),
    scale: values.scale === undefined ? undefined : values.scale === 'auto' ? 'auto' : Number(values.scale),
    language: values.language,
    maxSideLen: values['max-side'] === undefined ? undefined : Number(values['max-side']),
    minScore: values['min-score'] === undefined ? undefined : Number(values['min-score']),
    frames: values.frames === undefined ? undefined : Number(values.frames),
    onLog: (message) => console.error(message),
  }
}

/** Render one reading as a human table. */
function printReading(read) {
  console.log(`引擎 ${read.engine}，${read.lines.length} 行，${read.elapsedMs} ms`)
  for (const line of read.lines) {
    const score = String(line.score ?? '-').padEnd(6)
    const box = `[${line.x},${line.y} ${line.width}x${line.height}]`
    const at = line.at === undefined ? '' : `@${line.at}s `
    console.log(`  ${score} ${at}${box} ${line.text}`)
  }
}

const COMMANDS = {
  /** Report the environment: which engine and which ffmpeg. */
  async doctor() {
    const ffmpeg = findBinary('ffmpeg', null)
    const ffprobe = findBinary('ffprobe', null)
    const report = {
      ok: true,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      engine: ocrReport(normalizeConfig({})),
      ffmpeg: ffmpeg === null ? { found: false } : { found: true, path: ffmpeg.path, source: ffmpeg.source },
      ffprobe: ffprobe === null ? { found: false } : { found: true, path: ffprobe.path, source: ffprobe.source },
      state: ocrInstallState(),
      notes: [],
    }
    if (ffmpeg !== null) report.ffmpeg.version = await versionOf(ffmpeg.path)
    if (ffprobe !== null) report.ffprobe.version = await versionOf(ffprobe.path)
    if (ffmpeg === null || ffprobe === null) {
      report.notes.push('没有找到 ffmpeg/ffprobe：读单张静态图（不给 region）不需要它们；读视频帧和裁剪放大需要。')
    }
    if (!report.engine.available) {
      report.notes.push(report.engine.note)
      // A missing engine is not a failure: the Windows recogniser always answers.
      report.ok = report.engine.winrtFallback
    }
    emit(report)
    return report.ok ? 0 : 1
  },

  /** Report which engine is installed, without reading anything. */
  async engines() {
    emit(ocrReport(normalizeConfig({})))
    return 0
  },

  /** Install, or remove, an offline engine. */
  async setup(values) {
    if (values.remove === true) {
      const id = values.source
      const result = removeOcr(id)
      emit({ ...result, reason: result.removed.length === 0 ? '本来就没有安装' : '已删除', state: ocrInstallState() })
      return 0
    }
    if (values.source !== undefined && OCR_SOURCES[values.source] === undefined) {
      throw new Error(`未知的 source ${JSON.stringify(values.source)}；可选：${Object.keys(OCR_SOURCES).join(', ')}`)
    }
    const result = await installOcr({
      source: values.source,
      force: values.force === true,
      prune: values.prune === true,
      archive: values.archive,
      onProgress: (message) => console.error(message),
    })
    emit({ ...result, state: ocrInstallState(), engine: ocrReport(normalizeConfig({})) })
    return 0
  },

  /** Read text off an image, or frames of a video, and optionally locate a string in it. */
  async read(values) {
    const target = values.paths?.[0]
    if (target === undefined) throw new Error('read: <文件> is required')
    const read = await readText(resolve(target), readOptions(values))
    const matches = values.find === undefined ? null : findLines(read.lines, [values.find], { match: values.match })
    if (values.json === true) emit({ ...read, matches })
    else {
      printReading(read)
      for (const note of read.notes ?? []) console.log(`注意：${note}`)
      if (matches !== null) {
        console.log(`\n找到 ${matches.length} 处 "${values.find}"：`)
        for (const match of matches) console.log(`  ${match.center.x},${match.center.y}  ${match.text}`)
      }
    }
    return values.find === undefined || matches.length > 0 ? 0 : 1
  },

  /** Locate strings and print only the coordinates. */
  async find(values) {
    const target = values.paths?.[0]
    if (target === undefined) throw new Error('find: <文件> is required')
    const needle = values.needle ?? values.find
    if (needle === undefined) throw new Error('find: --needle "<文字>" is required')
    const read = await readText(resolve(target), { ...readOptions(values), minScore: 0 })
    const matches = findLines(read.lines, [needle], { match: values.match })
    if (values.json === true) emit({ ok: matches.length > 0, target: resolve(target), needle, matches, searched: read.lines.map((line) => line.text) })
    else {
      console.log(`引擎 ${read.engine}，识别 ${read.lines.length} 行，匹配 ${matches.length} 处`)
      for (const match of matches) console.log(`  ${match.center.x},${match.center.y}  ${match.text}`)
      if (matches.length === 0) {
        console.log('已识别的每一行：')
        for (const line of read.lines) console.log(`  [${line.x},${line.y} ${line.width}x${line.height}] ${line.text}`)
      }
    }
    return matches.length > 0 ? 0 : 1
  },
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(`dsh-ocr — 从像素里读出文字与坐标

用法：node src/bin/ocr.mjs <命令> [选项]

命令：
  doctor                             体检：装了哪个引擎、ffmpeg 在哪、WinRT 回退是否可用
  engines                            只报引擎状态，不读任何东西
  setup [--source <id>] [--archive <本地.7z>] [--prune] [--force] [--remove]
                                     装/卸离线 OCR 引擎（默认 rapidocr-json，MIT）
  read <文件> [--region x,y,w,h] [--scale auto|<倍数>] [--engine ${ENGINE_PREFERENCES.join('|')}]
              [--language ch] [--max-side 1024] [--min-score 0.5] [--frames 4]
              [--find "<文字>"] [--match contains|exact] [--json]
                                     读图片/视频里的文字，每行带像素框与置信度
  find <文件> --needle "<文字>" [--region x,y,w,h] [--scale auto] [--json]
                                     按文字找位置，给可直接点击的中心点

没有"看懂画面"命令：描述画面用视觉模型，本插件只报字符和坐标。`)
    return 0
  }

  const handler = COMMANDS[command]
  if (handler === undefined) {
    console.error(`未知命令：${command}（可用：${Object.keys(COMMANDS).join(', ')}）`)
    return 1
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      region: { type: 'string' },
      scale: { type: 'string' },
      engine: { type: 'string' },
      language: { type: 'string' },
      'max-side': { type: 'string' },
      'min-score': { type: 'string' },
      frames: { type: 'string' },
      find: { type: 'string' },
      needle: { type: 'string' },
      match: { type: 'string' },
      source: { type: 'string' },
      archive: { type: 'string' },
      prune: { type: 'boolean' },
      remove: { type: 'boolean' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  })

  const options = { ...values }
  if (positionals.length > 0) options.paths = positionals

  try {
    return await handler(options)
  } catch (error) {
    if (error instanceof OcrError) console.error(`错误：${error.message}`)
    else console.error(`错误：${error instanceof Error ? error.message : String(error)}`)
    // A missing file is worth distinguishing from a bad argument: it is the common typo.
    if (error instanceof Error && /不存在/.test(error.message) && options.paths?.[0] !== undefined) {
      console.error(`（检查路径：${resolve(options.paths[0])}${existsSync(resolve(options.paths[0])) ? ' 存在' : ' 不存在'}）`)
    }
    return 1
  }
}

process.exitCode = await main()
