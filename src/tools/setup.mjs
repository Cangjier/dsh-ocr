/**
 * `text_setup` — what would answer a call, and how to change it.
 *
 * The engine package ids are enumerated from the core installer rather than typed twice, so a
 * source added there cannot go missing here; that is the same rule the `video-factory` sibling
 * learned the hard way when its schema enum drifted from its installer.
 *
 * @module dsh-ocr/tools/setup
 */
import { OCR_SOURCES } from '../core/install.mjs'
import { CWD_PROPERTY, FORCE_PROPERTY, defineFamilyTool } from './shared.mjs'

/** Every action `text_setup` dispatches. */
export const SETUP_ACTIONS = ['status', 'probe', 'install', 'remove']

/** Installable engine ids, mirrored from the core installer so the enum cannot drift. */
const OCR_SOURCE_IDS = Object.keys(OCR_SOURCES)

/**
 * Build the `text_setup` tool definition.
 * @param {Record<string, Function>} handlers - action implementations.
 * @returns {object} a raw tool definition.
 */
export function createSetupTool(handlers) {
  return defineFamilyTool({
    name: 'text_setup',
    actions: SETUP_ACTIONS,
    handlers,
    extraProperties: {
      source: {
        type: 'string',
        enum: OCR_SOURCE_IDS,
        description:
          'install: which engine package. "rapidocr-json" (default) is ONNX Runtime with PP-OCRv4, MIT, no AVX requirement, 1.77s on a 1200x1013 screenshot here. ' +
          '"paddleocr-ppocrv5" is a third-party Paddle Inference build with the newer models, slightly better on some small text, about nine times slower on the same image, and it needs AVX. ' +
          'remove: which installation to delete; omit to remove every engine and the unpacking tools.',
      },
      prune: {
        type: 'boolean',
        description:
          'install: delete the recognition libraries for languages this plugin never asks for. Saves about 50MB and keeps Simplified Chinese, its dictionary, the detector and the classifier.',
      },
      archive: {
        type: 'string',
        description:
          'install: use a local .7z instead of downloading. For a host where the release CDN is throttled — the SHA-256 is still checked, so local never means unverified.',
      },
      ffmpeg: {
        type: 'boolean',
        description:
          'install: also install a private copy of ffmpeg into this plugin\'s own vendor/ffmpeg (about 194MB) instead of borrowing a sibling video-factory build, DSH_OCR_FFMPEG, or PATH.',
      },
      force: FORCE_PROPERTY,
      cwd: CWD_PROPERTY,
    },
  })
}
