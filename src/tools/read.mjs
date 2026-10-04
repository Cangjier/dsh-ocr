/**
 * `text_read` — reading text off a picture, and proving burned subtitles.
 *
 * The schema here declares only the shape of a call. What each action does, what it costs and
 * how it can mislead is in `registry.mjs`, and is rendered into the `action` description and the
 * on-demand `text_guide` from there, so there is exactly one place to change.
 *
 * @module dsh-ocr/tools/read
 */
import { ENGINE_PREFERENCES } from '../core/engine.mjs'
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

/** Every action `text_read` dispatches. */
export const READ_ACTIONS = ['read', 'verify']

/**
 * Build the `text_read` tool definition.
 * @param {Record<string, Function>} handlers - action implementations.
 * @returns {object} a raw tool definition.
 */
export function createReadTool(handlers) {
  return defineFamilyTool({
    name: 'text_read',
    actions: READ_ACTIONS,
    handlers,
    extraProperties: {
      target: {
        type: 'string',
        description: 'read / verify: the image or video to read. verify: the delivered video whose burned subtitles are checked.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'read: up to 12 images to read in one call, instead of target. The result is then keyed by file.',
      },
      srt: {
        type: 'string',
        description: 'verify: the subtitle file the expectations come from — usually the one the plan named as subtitles.source. Times and text both come from it.',
      },
      region: {
        type: 'string',
        description:
          'read: read only this part of the image, as {x,y,width,height} or "x,y,width,height", in the file\'s own pixels. ' +
          'A small crop is both faster and much more accurate on small text.',
      },
      scale: {
        type: ['number', 'string'],
        description:
          'read: enlarge before recognising. "auto" (recommended with region) grows a small crop until its long side is about 1000px, at most 3x. A number is used as-is.',
      },
      engine: {
        type: 'string',
        enum: ENGINE_PREFERENCES,
        description:
          'read: "auto" (default) uses the installed engine and falls back to Windows; "local" requires the installed engine and fails loudly without one; ' +
          '"winrt" uses Windows only — fast, but it misreads small mixed-script text.',
      },
      language: {
        type: 'string',
        description: 'read: recognition language for the installed engine: ch (default), cht, en, japan, korean, cyrillic.',
      },
      maxSideLen: {
        type: 'number',
        description: 'read: long-side pixel limit handed to the engine. Lower is faster; default 1024.',
      },
      minScore: {
        type: 'number',
        description:
          'read: confidence below which a line is left out of the joined "text" (default 0.5). "lines" always contains every line, so nothing is hidden.',
      },
      frames: {
        type: 'number',
        description: 'read: for a video, how many frames to read, spread evenly. Default 4, at most 24.',
      },
      times: {
        type: 'array',
        items: { type: 'number' },
        description: 'read: for a video, the exact seconds to read instead of evenly spread frames. This is how defined moments are read back.',
      },
      sampleFrames: {
        type: 'number',
        description: 'verify: how many cues to read back. Default 6, spread evenly through the file, last cue always included.',
      },
      leadSeconds: {
        type: 'number',
        description: 'verify: read this far into each cue. Default 0.35 — after the subtitle has appeared, before it starts to fade.',
      },
      matchRatio: {
        type: 'number',
        description:
          'verify: character similarity a cue must reach to count as correct. Default 0.6, which tolerates OCR noise but not a missing glyph.',
      },
      cwd: CWD_PROPERTY,
    },
  })
}
