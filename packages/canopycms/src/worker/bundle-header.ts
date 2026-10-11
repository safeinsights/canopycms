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
 * tab, a `\r`, non-UTF-8), never parsed and never logged. Every other line ends in LF alone. git
 * reads the comment only to display it, so its length is bounded on its own
 * ({@link PREREQUISITE_COMMENT_MAX_BYTES}) and the worker shortens it rather than send a bundle
 * the gateway would refuse: a boundary commit's subject can be any length. Shortening cuts bytes,
 * never characters, and only after the line's `-<oid> `; it removes bytes and adds none, so it
 * never adds an LF. A bundle has as many prerequisites as it has boundary commits, so the whole
 * header, comments included, has a fixed bound too ({@link BUNDLE_HEADER_TOTAL_MAX_BYTES}).
 */

/**
 * The header must end, with its blank line, within this many bytes, prerequisites' comments not
 * counted.
 * @internal Exported for tests.
 */
export const BUNDLE_HEADER_MAX_BYTES = 64 * 1024

/**
 * The longest prerequisite comment, in bytes, the space before it not counted.
 * @internal Exported for tests.
 */
export const PREREQUISITE_COMMENT_MAX_BYTES = 1024

/**
 * The header must end within this many bytes counting comments too: the most a reader takes,
 * and holds, of a header.
 * @internal Exported for tests.
 */
export const BUNDLE_HEADER_TOTAL_MAX_BYTES = 256 * 1024

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
const LF = 0x0a
const SPACE = 0x20
const DASH = 0x2d
/** `-`, 40 hex digits and the space a comment follows. */
const PREREQUISITE_PREFIX_BYTES = 42

type Section = 'signature' | 'capabilities' | 'prerequisites' | 'heads'

/** A complete header, as {@link BundleHeaderReader.push} returns it. */
export interface ReadBundleHeader {
  header: BundleHeader
  /** When shortening, the header's bytes as they are to be sent, each comment shortened; else empty. */
  bytes: Buffer
  /** What followed the header in the chunk that completed it. */
  rest: Buffer
}

/**
 * Reads a header from a bundle's bytes as they arrive, holding at most
 * {@link BUNDLE_HEADER_TOTAL_MAX_BYTES} of it, however long a comment is. A comment over
 * {@link PREREQUISITE_COMMENT_MAX_BYTES} is refused (`'refuse'`, the gateway, which keeps no copy
 * of the header) or cut to it (`'shorten'`, the worker, which sends {@link ReadBundleHeader.bytes}
 * in its place).
 */
export class BundleHeaderReader {
  private section: Section = 'signature'
  private sawCapability = false
  private readonly prerequisites: string[] = []
  private readonly heads: Buffer[] = []
  private readonly out: Buffer[] = []
  /** The current line, up to where its comment starts. */
  private line: Buffer[] = []
  private lineBytes = 0
  /** Header bytes outside comments. */
  private counted = 0
  /** Bytes taken from the bundle. */
  private consumed = 0
  /** In a comment: its bytes so far, and those kept to send. */
  private comment: { bytes: number; kept: Buffer[] } | null = null
  private done = false

  constructor(private readonly comments: 'refuse' | 'shorten') {}

  /**
   * Take the next bytes: null while the header may still be completed by more, the header once its
   * blank line has arrived. Throws {@link BundleHeaderError} once what has arrived breaks the
   * grammar or a bound.
   */
  push(chunk: Buffer): ReadBundleHeader | null {
    if (this.done) throw new Error('The bundle header was already read')
    let offset = 0
    while (offset < chunk.length) {
      const lf = chunk.indexOf(LF, offset)
      const end = lf === -1 ? chunk.length : lf
      if (this.comment !== null) {
        this.takeComment(chunk.subarray(offset, end))
      } else {
        // A prerequisite's comment starts after its first 42 bytes; nothing past them is counted
        // until the line says whether it is one.
        const take =
          this.mayBePrerequisite() && this.lineBytes < PREREQUISITE_PREFIX_BYTES
            ? Math.min(end - offset, PREREQUISITE_PREFIX_BYTES - this.lineBytes)
            : end - offset
        this.takeLine(chunk.subarray(offset, offset + take))
        offset += take
        if (this.lineBytes === PREREQUISITE_PREFIX_BYTES && this.startsComment()) {
          this.comment = { bytes: 0, kept: [] }
        }
        if (offset < end) continue
      }
      offset = end
      if (lf === -1) break
      offset += 1
      this.consumed += 1
      this.counted += 1
      const header = this.endLine()
      if (header !== null) {
        this.done = true
        return { header, bytes: Buffer.concat(this.out), rest: chunk.subarray(offset) }
      }
    }
    this.checkBound()
    if (this.section === 'signature' && this.comment === null) this.checkPartialSignature()
    return null
  }

  private mayBePrerequisite(): boolean {
    return (
      this.section !== 'signature' &&
      this.section !== 'heads' &&
      (this.lineBytes === 0 || this.line[0][0] === DASH)
    )
  }

  private startsComment(): boolean {
    const line = Buffer.concat(this.line)
    this.line = [line]
    return (
      line.length === PREREQUISITE_PREFIX_BYTES &&
      line[0] === DASH &&
      line[PREREQUISITE_PREFIX_BYTES - 1] === SPACE
    )
  }

  private takeLine(bytes: Buffer): void {
    this.line.push(bytes)
    this.lineBytes += bytes.length
    this.counted += bytes.length
    this.consumed += bytes.length
    this.checkBound()
  }

  private takeComment(bytes: Buffer): void {
    const comment = this.comment
    if (comment === null) return
    const room = PREREQUISITE_COMMENT_MAX_BYTES - comment.bytes
    if (bytes.length > room && this.comments === 'refuse') {
      throw new BundleHeaderError(
        `a prerequisite's comment is longer than ${PREREQUISITE_COMMENT_MAX_BYTES} bytes`,
      )
    }
    if (room > 0 && this.comments === 'shorten') comment.kept.push(bytes.subarray(0, room))
    comment.bytes += bytes.length
    this.consumed += bytes.length
    this.checkBound()
  }

  private checkBound(): void {
    if (this.counted >= BUNDLE_HEADER_MAX_BYTES) {
      throw new BundleHeaderError(`its header does not end within ${BUNDLE_HEADER_MAX_BYTES} bytes`)
    }
    if (this.consumed >= BUNDLE_HEADER_TOTAL_MAX_BYTES) {
      throw new BundleHeaderError(
        `its header, comments included, does not end within ${BUNDLE_HEADER_TOTAL_MAX_BYTES} bytes`,
      )
    }
  }

  /** Refuse a signature line that has not ended yet but already cannot become one. */
  private checkPartialSignature(): void {
    const text = Buffer.concat(this.line).toString('latin1')
    if (![...SIGNATURES].some((signature) => signature.startsWith(text))) {
      throw new BundleHeaderError('it is not a v2 or v3 git bundle')
    }
  }

  /** Check the line just ended: the header once it was the blank line, else null. */
  private endLine(): BundleHeader | null {
    const line = Buffer.concat(this.line)
    const comment = this.comment
    this.line = []
    this.lineBytes = 0
    this.comment = null
    if (this.comments === 'shorten')
      this.out.push(line, ...(comment?.kept ?? []), Buffer.from([LF]))
    // latin1 maps each byte to one character, so a pattern sees exactly the bytes.
    const text = line.toString('latin1')
    if (this.section === 'signature') {
      if (!SIGNATURES.has(text)) throw new BundleHeaderError('it is not a v2 or v3 git bundle')
      this.section = text === '# v3 git bundle' ? 'capabilities' : 'prerequisites'
      return null
    }
    if (text === '') {
      if (this.heads.length === 0) throw new BundleHeaderError('it names no head')
      return { length: this.consumed, prerequisites: this.prerequisites, heads: this.heads }
    }
    if (this.section === 'capabilities' && text.startsWith('@')) {
      if (text !== ALLOWED_CAPABILITY) {
        throw new BundleHeaderError(`it declares a capability other than ${ALLOWED_CAPABILITY}`)
      }
      if (this.sawCapability) throw new BundleHeaderError('it declares a capability twice')
      this.sawCapability = true
      return null
    }
    if (this.section !== 'heads' && text.startsWith('-')) {
      // `-<40 hex>`, then nothing, or a space and the comment (taken apart above).
      const id = text.slice(1, 41)
      if (!HEX_40.test(id) || (text.length > 41 && (text.length !== 42 || comment === null))) {
        throw new BundleHeaderError('a prerequisite line is malformed')
      }
      this.prerequisites.push(id)
      this.section = 'prerequisites'
      return null
    }
    if (!HEAD.test(text)) throw new BundleHeaderError('a line is neither a prerequisite nor a head')
    this.heads.push(line)
    this.section = 'heads'
    return null
  }
}

/**
 * Read the header at the start of `bytes` ({@link BundleHeaderReader}, refusing a long comment):
 * null while it may still be completed by more bytes, the header once its blank line has arrived.
 * @internal Exported for tests.
 */
export function scanBundleHeader(bytes: Buffer): BundleHeader | null {
  return new BundleHeaderReader('refuse').push(bytes)?.header ?? null
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
