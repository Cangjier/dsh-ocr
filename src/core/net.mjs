/**
 * Downloading a pinned file, and hashing it.
 *
 * An OCR engine is not a package this plugin can depend on, so — exactly like the sibling
 * video-factory does with ffmpeg — it is fetched once into `vendor/ocr/` and pinned by
 * SHA-256. A tampered or truncated download must never become the thing that reads text out
 * of a user's screenshots, so the hash is checked before anything is unpacked.
 *
 * @module dsh-ocr/core/net
 */
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { connectThroughProxy, systemProxy } from './proxy.mjs'

// Re-exported so a caller needs one import to reason about "how this plugin reaches the
// network", and because the orchestrator in `read.mjs` double-checks the proxy for its own
// diagnostics.
export { connectThroughProxy, systemProxy }

/** Raised when provisioning fails. */
export class InstallError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InstallError'
  }
}

/**
 * Perform an HTTPS GET, through the system proxy when there is one, following redirects.
 *
 * Node 24 ships no importable `undici` (`import('undici')` fails and `node:undici` is not a
 * builtin), so proxying has to be built from `node:http`, `node:https`, and `node:tls`.
 *
 * Redirects are followed here rather than left to the caller because model hosts redirect on
 * purpose: a `/releases/download/` link answers 302 to a CDN, so a fetch that stopped at the
 * first response would download a 200-byte "Found" page and hash it as the engine.
 *
 * The returned shape matches `fetch` closely enough to be a drop-in for {@link download}.
 *
 * @param {string} url - the https URL.
 * @param {object} [options] - `{ timeoutMs, maxRedirects }`.
 * @returns {Promise<{ok: boolean, status: number, statusText: string, url: string, headers: {get(name: string): string|null}, body: AsyncIterable<Uint8Array>|null}>} the response.
 * @throws {Error} when the connection or the tunnel fails.
 */
export async function httpFetch(url, options = {}) {
  const maxRedirects = options.maxRedirects ?? 8
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchOnce(current, options)
    const location = response.headers.get('location')
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
    if (!isRedirect || location === null) return response
    // Drain the redirect body so the socket can be reused and nothing is left half-read.
    if (response.body !== null) for await (const _ of response.body) void _
    current = new URL(location, current).href
  }
  throw new Error(`重定向次数超过 ${maxRedirects} 次，已中止：${url}`)
}

/**
 * One request/response exchange, no redirect handling.
 *
 * @param {string} url - the https URL.
 * @param {object} [options] - `{ timeoutMs }`.
 * @returns {Promise<object>} the response.
 * @throws {Error} when the connection or the tunnel fails.
 */
async function fetchOnce(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const target = new URL(url)
  const proxy = systemProxy()

  const agent = proxy === null ? null : await connectThroughProxy(target, proxy, timeoutMs)
  return await new Promise((settle, fail) => {
    const request = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { 'user-agent': 'dsh-ocr', accept: '*/*' },
        ...(agent === null ? {} : { createConnection: () => agent.socket }),
      },
      (response) => {
        settle({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          url,
          headers: {
            get: (name) => {
              const value = response.headers[String(name).toLowerCase()]
              return Array.isArray(value) ? value[0] : value ?? null
            },
          },
          body: (async function* iterate() {
            for await (const chunk of response) yield chunk
          })(),
        })
        // Release the tunnelled socket once the body is done, whatever the caller did with it.
        // A kept-alive socket would hold the event loop open, which shows up as a CLI command
        // that finishes its work and then simply never exits.
        response.once('end', () => agent?.close())
        response.once('close', () => agent?.close())
        response.once('error', () => agent?.close())
      },
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`))
    })
    request.on('error', (error) => {
      agent?.close()
      fail(error)
    })
    request.end()
  })
}

/**
 * Download a URL to a file, hashing as it goes.
 *
 * @param {string} url - the source.
 * @param {string} target - the destination path.
 * @param {(received: number, total: number) => void} [onProgress] - progress callback.
 * @returns {Promise<{bytes: number, sha256: string}>} what was written.
 * @throws {InstallError} when the request fails.
 */
export async function download(url, target, onProgress) {
  const response = await httpFetch(url, { timeoutMs: 120_000 })
  if (!response.ok) throw new InstallError(`下载失败 ${response.status} ${response.statusText}：${url}`)
  if (response.body === null) throw new InstallError(`下载响应没有内容：${url}`)

  const total = Number(response.headers.get('content-length') ?? 0)
  mkdirSync(dirname(target), { recursive: true })

  const hash = createHash('sha256')
  const sink = createWriteStream(target)
  let bytes = 0
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value)
      bytes += chunk.byteLength
      hash.update(chunk)
      if (!sink.write(chunk)) await new Promise((resolveDrain) => sink.once('drain', resolveDrain))
      if (onProgress !== undefined) onProgress(bytes, total)
    }
  } finally {
    await new Promise((resolveEnd) => sink.end(resolveEnd))
  }
  if (bytes === 0) throw new InstallError(`下载得到空文件：${url}`)
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * Compute the SHA-256 of an existing file.
 * @param {string} path - the file to hash.
 * @returns {Promise<string>} the lowercase hex digest.
 */
export async function sha256Of(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
