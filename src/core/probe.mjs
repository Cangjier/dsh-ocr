/**
 * The little bit of media inspection this plugin needs: how big is it, and how long.
 *
 * Only two answers matter here. An image's dimensions decide the `scale: "auto"` factor, and a
 * video's duration decides where the frames are taken from. Both come from ffprobe, and both
 * are normalized because ffprobe reports them inconsistently: a still image has no duration at
 * all, rotation can hide in a tag or in a display-matrix side-data entry, and a container may
 * report a size on the stream rather than the format.
 *
 * @module dsh-ocr/core/probe
 */
import { statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { runProbe } from './ffmpeg.mjs'

/** Extensions treated as still images. */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.gif', '.heic', '.heif', '.avif',
])

/** Extensions treated as audio. */
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'])

/** Extensions treated as video. */
export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv', '.wmv', '.ts', '.mpg', '.mpeg',
])

/** Raised when a file cannot be inspected at all. */
export class ProbeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProbeError'
  }
}

/**
 * Classify a path by extension.
 *
 * Extension alone, deliberately: the caller's question is "can this be read as a picture", and
 * a wrong answer costs one clear error message rather than a wrong reading.
 *
 * @param {string} path - the file path.
 * @returns {'image'|'video'|'audio'|'unknown'} the media kind.
 */
export function classify(path) {
  const extension = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'unknown'
}

/**
 * Extract the rotation angle from a video stream, in degrees.
 *
 * ffmpeg reports this in two places depending on version and container: a `rotate` tag, or a
 * `displaymatrix` side-data entry whose value is a matrix.
 *
 * @param {object} stream - an ffprobe stream object.
 * @returns {number} a normalized angle in [0, 360).
 */
export function rotationOf(stream) {
  const tag = stream?.tags?.rotate
  if (tag !== undefined && Number.isFinite(Number(tag))) {
    return ((Number(tag) % 360) + 360) % 360
  }
  for (const entry of stream?.side_data_list ?? []) {
    if (typeof entry.rotation === 'number') return ((entry.rotation % 360) + 360) % 360
  }
  return 0
}

/**
 * Inspect one media file.
 *
 * @param {string} path - the file to inspect.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<object>} the normalized media info.
 * @throws {ProbeError} when the file does not exist.
 */
export async function probe(path, config = {}) {
  const absolute = resolve(path)
  try {
    statSync(absolute)
  } catch {
    throw new ProbeError(`文件不存在：${absolute}`)
  }
  const document = await runProbe(
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absolute],
    config,
  )

  const streams = Array.isArray(document?.streams) ? document.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const format = document?.format ?? {}

  let sizeBytes = Number(format.size) || 0
  if (sizeBytes === 0) {
    try {
      sizeBytes = statSync(absolute).size
    } catch {
      sizeBytes = 0
    }
  }

  const rotation = video === undefined ? 0 : rotationOf(video)
  const rotated = rotation === 90 || rotation === 270
  const width = Number(video?.width) || 0
  const height = Number(video?.height) || 0

  return {
    path: absolute,
    name: basename(absolute),
    kind: classify(absolute),
    // A still has no duration; a container that reports one anyway keeps it.
    duration: Number(format.duration) || Number(video?.duration) || 0,
    sizeBytes,
    hasVideo: video !== undefined,
    // Display dimensions after rotation, which is what a viewer actually sees.
    width: rotated ? height : width,
    height: rotated ? width : height,
    rotation,
  }
}
