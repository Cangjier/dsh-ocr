/**
 * `text_find` — turning a string you can name into a coordinate you can act on.
 *
 * A separate tool from `text_read` rather than an action inside it, because the two are reached
 * for at different moments with different intentions: `read` answers "what does this picture
 * say", `find` answers "where is the thing that says this". Keeping them apart also keeps the
 * `find` schema free to describe the one thing that matters there — that a miss is not proof of
 * absence, and that `searched` is how you tell the two apart.
 *
 * @module dsh-ocr/tools/find
 */
import { ENGINE_PREFERENCES } from '../core/engine.mjs'
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

/** Every action `text_find` dispatches. */
export const FIND_ACTIONS = ['find']

/**
 * Build the `text_find` tool definition.
 * @param {Record<string, Function>} handlers - action implementations.
 * @returns {object} a raw tool definition.
 */
export function createFindTool(handlers) {
  return defineFamilyTool({
    name: 'text_find',
    actions: FIND_ACTIONS,
    handlers,
    extraProperties: {
      target: { type: 'string', description: 'the image or video to search.' },
      needle: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'the text to look for, or an array of them. Case and spacing are ignored, including the spaces engines insert between CJK glyphs, so 音频 also matches 音 频.',
      },
      match: {
        type: 'string',
        enum: ['contains', 'exact'],
        description: '"contains" (default) matches a line containing the needle; "exact" requires the whole recognised line to equal it.',
      },
      region: {
        type: 'string',
        description:
          'search only this part of the image, as {x,y,width,height} or "x,y,width,height". This is the small-text recipe: combine it with scale "auto".',
      },
      scale: {
        type: ['number', 'string'],
        description: 'enlarge before recognising. "auto" with a region is how an 11px label becomes readable.',
      },
      engine: {
        type: 'string',
        enum: ENGINE_PREFERENCES,
        description: '"auto" (default), "local" (installed engine only, fails loudly), or "winrt" (Windows only).',
      },
      language: {
        type: 'string',
        description: 'recognition language for the installed engine: ch (default), cht, en, japan, korean, cyrillic.',
      },
      maxSideLen: { type: 'number', description: 'long-side pixel limit handed to the engine. Default 1024.' },
      frames: { type: 'number', description: 'for a video, how many frames to search, spread evenly. Default 4.' },
      times: {
        type: 'array',
        items: { type: 'number' },
        description: 'for a video, the exact seconds to search instead of evenly spread frames.',
      },
      cwd: CWD_PROPERTY,
    },
  })
}
