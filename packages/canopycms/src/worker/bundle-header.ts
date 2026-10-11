/**
 * A git bundle's header, read in node before git sees the bundle: the gateway refuses a pushed
 * bundle on it (worker/github-mirror.ts), and the worker checks the bundle it is about to send
 * (worker/github-transfer.ts). git's own parser reads everything after a head's first space as the
 * refname and accepts a tab, so nothing here is lenient: a header either matches this grammar
 * exactly or is refused.
 *
 * ```
 * "# v2 git bundle" LF  |  "# v3 git bundle" LF ("@object-format=sha1" LF)?    at most once
 * ("-" <40 hex> (" " <any bytes but LF>)? LF)*      prerequisites; the comment is a commit subject
 * (<40 hex> " " <refname> LF)+                      heads
 * LF
 * ```
 *
 * A prerequisite's comment is the subject of a commit anyone can write, so it is opaque bytes (a
 * tab, a `\r`, non-UTF-8), never parsed and never logged. Every other line ends in LF alone.
 */

/**
 * The header must end, with its blank line, within this many bytes.
 * @internal Exported for tests.
 */
export const BUNDLE_HEADER_MAX_BYTES = 64 * 1024

export interface BundleHeader {
  /** Bytes from the start of the bundle to the end of the header's blank line. */
  readonly length: number
  /** Prerequisite object IDs, in order. */
  readonly prerequisites: readonly string[]
  /** Each head line's bytes, without its LF. */
  readonly heads: readonly Buffer[]
}

/** A header that is not one this grammar accepts, or not one at all. */
export class BundleHeaderError extends Error {
  constructor(message: string) {
    super(`Refusing the bundle: ${message}`)
    this.name = 'BundleHeaderError'
  }
}

const SIGNATURES = new Set(['# v2 git bundle', '# v3 git bundle'])
const ALLOWED_CAPABILITY = '@object-format=sha1'
const HEX_40 = /^[0-9a-f]{40}$/
const HEAD = /^[0-9a-f]{40} [^\n]+$/

/**
 * Read the header at the start of `bytes`: null while it may still be completed by more bytes,
 * the header once its blank line has arrived. Throws {@link BundleHeaderError} once a complete
 * line breaks the grammar (the signature even before its LF), or when
 * {@link BUNDLE_HEADER_MAX_BYTES} pass without the blank line, so a caller never has to hold more
 * than that.
 */
export function scanBundleHeader(bytes: Buffer): BundleHeader | null {
  const window = bytes.subarray(0, BUNDLE_HEADER_MAX_BYTES)
  const prerequisites: string[] = []
  const heads: Buffer[] = []
  let section: 'signature' | 'capabilities' | 'prerequisites' | 'heads' = 'signature'
  let version = ''
  let sawCapability = false
  let offset = 0
  for (;;) {
    const lf = window.indexOf(0x0a, offset)
    if (lf === -1) {
      if (bytes.length >= BUNDLE_HEADER_MAX_BYTES) {
        throw new BundleHeaderError(
          `its header does not end within ${BUNDLE_HEADER_MAX_BYTES} bytes`,
        )
      }
      // A partial line can still be checked against what it must start as.
      checkPartialLine(window.subarray(offset), section)
      return null
    }
    const line = window.subarray(offset, lf)
    offset = lf + 1
    // latin1 maps each byte to one character, so a pattern sees exactly the bytes.
    const text = line.toString('latin1')
    if (section === 'signature') {
      if (!SIGNATURES.has(text)) throw new BundleHeaderError('it is not a v2 or v3 git bundle')
      version = text
      section = version === '# v3 git bundle' ? 'capabilities' : 'prerequisites'
      continue
    }
    if (text === '') {
      if (heads.length === 0) throw new BundleHeaderError('it names no head')
      return { length: offset, prerequisites, heads }
    }
    if (section === 'capabilities' && text.startsWith('@')) {
      if (text !== ALLOWED_CAPABILITY) {
        throw new BundleHeaderError(`it declares a capability other than ${ALLOWED_CAPABILITY}`)
      }
      if (sawCapability) throw new BundleHeaderError('it declares a capability twice')
      sawCapability = true
      continue
    }
    if (section !== 'heads' && text.startsWith('-')) {
      // `-<40 hex>`, then nothing or a space and the opaque comment.
      const id = text.slice(1, 41)
      if (!HEX_40.test(id) || (text.length > 41 && text[41] !== ' ')) {
        throw new BundleHeaderError('a prerequisite line is malformed')
      }
      prerequisites.push(id)
      section = 'prerequisites'
      continue
    }
    if (!HEAD.test(text)) throw new BundleHeaderError('a line is neither a prerequisite nor a head')
    heads.push(Buffer.from(line))
    section = 'heads'
  }
}

/** Refuse a line that has not ended yet but already cannot become a valid one. */
function checkPartialLine(partial: Buffer, section: string): void {
  if (section !== 'signature') return
  const text = partial.toString('latin1')
  if (![...SIGNATURES].some((signature) => signature.startsWith(text))) {
    throw new BundleHeaderError('it is not a v2 or v3 git bundle')
  }
}

/**
 * The one head line a bundle of `refs/heads/<branch>` at `sha` has, byte for byte.
 * @internal Exported for tests.
 */
export function expectedHead(sha: string, branch: string): Buffer {
  return Buffer.from(`${sha} refs/heads/${branch}`, 'utf8')
}

/** Whether `header` names exactly one head, and it is {@link expectedHead}'s. */
export function hasOnlyHead(header: BundleHeader, sha: string, branch: string): boolean {
  return header.heads.length === 1 && header.heads[0].equals(expectedHead(sha, branch))
}
