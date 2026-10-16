/**
 * Reassemble the RSC (flight) stream Next's App Router inlines into a page, so a URL the stream
 * splits across two scripts is scanned whole.
 *
 * Next writes each chunk of the stream as its own `<script>`, and React Flight cuts chunks at
 * arbitrary bytes (it fills fixed-size views and enqueues the partial one at every flush), so a URL
 * can straddle two scripts and the page text holds only its fragments. The format is the same in Next 15.5.21 and 16.1.7
 * (`createInlinedDataReadableStream` in `dist/server/app-render/use-flight-response.js`, read back
 * by `nextServerDataCallback` in `dist/client/app-index.js`):
 *
 * - `(self.__next_f=self.__next_f||[]).push([0])` starts the stream, followed in the same script by
 *   `;self.__next_f.push([2,formState])` when there is form state;
 * - each chunk is then `self.__next_f.push([1,text])`, or `[3,base64]` for a chunk that is not
 *   valid UTF-8, whose bytes join the same stream;
 * - every argument is `JSON.stringify` output passed through `htmlEscapeJsonString`, which only
 *   rewrites `& < > U+2028 U+2029` as `\uXXXX` escapes, so it parses as JSON and never holds
 *   `</script`.
 *
 * Every push on a page joins one stream: Next inlines one flight stream per page.
 */

import { getErrorMessage } from '../utils/error'

const PUSH_CALL_RE = /(?:\(self\.__next_f=self\.__next_f\|\|\[\]\)|self\.__next_f)\.push\(/y
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export interface InlineFlight {
  /** The page with each parsed flight script replaced by a space, so no fragment is scanned. */
  markup: string
  /** The stream's text, joined in document order, then each form state as JSON. */
  texts: string[]
  /** Scripts that name `__next_f` but are not flight pushes; their data cannot be scanned. */
  problems: { script: string; error: string }[]
}

/** The index just past the JSON array that opens at `start`; `JSON.parse` checks the rest. */
function jsonArrayEnd(body: string, start: number): number {
  if (body[start] !== '[') throw new Error(`expected a JSON array at ${start}`)
  let depth = 0
  let inString = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
    } else if (c === '[' || c === '{') {
      depth++
    } else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  throw new Error('unterminated JSON array')
}

/** The arguments of a script body that is nothing but `;`-joined `self.__next_f.push(...)` calls. */
function parsePushArguments(body: string): unknown[] {
  const args: unknown[] = []
  let pos = 0
  for (;;) {
    PUSH_CALL_RE.lastIndex = pos
    if (!PUSH_CALL_RE.test(body)) throw new Error(`expected self.__next_f.push( at ${pos}`)
    const end = jsonArrayEnd(body, PUSH_CALL_RE.lastIndex)
    args.push(JSON.parse(body.slice(PUSH_CALL_RE.lastIndex, end)))
    if (body[end] !== ')') throw new Error(`expected ) at ${end}`)
    pos = end + 1
    if (pos === body.length) return args
    if (body[pos] !== ';') throw new Error(`expected ; or the end of the script at ${pos}`)
    pos++
  }
}

/** A push's contribution: bytes of the stream, form state as JSON, or nothing (the bootstrap). */
function readSegment(arg: unknown): { bytes?: Buffer; formState?: string } {
  if (!Array.isArray(arg)) throw new Error('argument is not an array')
  const [kind, payload] = arg as unknown[]
  if (kind === 0 && arg.length === 1) return {}
  if (kind === 1 && arg.length === 2 && typeof payload === 'string') {
    return { bytes: Buffer.from(payload, 'utf8') }
  }
  if (kind === 2 && arg.length === 2) return { formState: JSON.stringify(payload) }
  if (kind === 3 && arg.length === 2 && typeof payload === 'string' && BASE64_RE.test(payload)) {
    return { bytes: Buffer.from(payload, 'base64') }
  }
  throw new Error(`unknown segment ${JSON.stringify(arg).slice(0, 40)}`)
}

/** Each script element's span and body, in document order; one pass, however the page ends. */
function* scriptElements(html: string): Generator<{ start: number; end: number; body: string }> {
  const openRe = /<script\b[^<>]*>/gi
  const closeRe = /<\/script\s*>/gi
  for (let open = openRe.exec(html); open; open = openRe.exec(html)) {
    closeRe.lastIndex = openRe.lastIndex
    const close = closeRe.exec(html)
    if (!close) return
    yield {
      start: open.index,
      end: closeRe.lastIndex,
      body: html.slice(openRe.lastIndex, close.index),
    }
    openRe.lastIndex = closeRe.lastIndex
  }
}

/**
 * Split `html` into its markup and its inline flight stream. Only a script whose body names
 * `__next_f` is flight; one that does but does not parse stays in the markup and is reported,
 * because skipping it could drop a reference.
 */
export function extractInlineFlight(html: string): InlineFlight {
  const stream: Buffer[] = []
  const formStates: string[] = []
  const problems: InlineFlight['problems'] = []

  let markup = ''
  let last = 0
  for (const { start, end, body } of scriptElements(html)) {
    if (!body.includes('__next_f')) continue
    let segments: ReturnType<typeof readSegment>[]
    try {
      segments = parsePushArguments(body).map(readSegment)
    } catch (err) {
      problems.push({
        script: `<script> at offset ${start}`,
        error: `Not a Next inline flight script (${getErrorMessage(err)}); its RSC payload cannot be scanned`,
      })
      continue
    }
    for (const { bytes, formState } of segments) {
      if (bytes) stream.push(bytes)
      if (formState !== undefined) formStates.push(formState)
    }
    markup += `${html.slice(last, start)} `
    last = end
  }
  const texts =
    stream.length > 0 ? [Buffer.concat(stream).toString('utf8'), ...formStates] : formStates
  return { markup: markup + html.slice(last), texts, problems }
}
