import { describe, expect, it } from 'vitest'

import {
  BUNDLE_HEADER_MAX_BYTES,
  BundleHeaderError,
  expectedHead,
  hasOnlyHead,
  scanBundleHeader,
} from './bundle-header'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

const bytes = (...parts: (string | Buffer)[]) =>
  Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : part)),
  )

describe('scanBundleHeader', () => {
  it('reads a v2 header: prerequisites with their comments, one head, the length to the blank line', () => {
    const header = bytes(
      '# v2 git bundle\n',
      `-${B} a subject\n`,
      `-${C}\n`,
      `${A} refs/heads/x\n`,
      '\n',
    )
    const scanned = scanBundleHeader(bytes(header, 'PACK...'))
    expect(scanned).toEqual({
      length: header.length,
      prerequisites: [B, C],
      heads: [Buffer.from(`${A} refs/heads/x`)],
    })
  })

  it('accepts a v3 header whose only capability is the SHA-1 object format', () => {
    const scanned = scanBundleHeader(
      bytes('# v3 git bundle\n@object-format=sha1\n', `${A} refs/heads/x\n\n`),
    )
    expect(scanned?.heads).toHaveLength(1)
  })

  it('takes a prerequisite comment as opaque bytes: a tab, a CR, non-UTF-8', () => {
    const subject = Buffer.from([0x09, 0x22, 0xff, 0xfe, 0x0d])
    const scanned = scanBundleHeader(
      bytes('# v2 git bundle\n', `-${B} `, subject, '\n', `${A} refs/heads/x\n\n`),
    )
    expect(scanned?.prerequisites).toEqual([B])
  })

  it('waits for more bytes while the header may still be completed', () => {
    expect(scanBundleHeader(bytes('# v2 git'))).toBeNull()
    expect(scanBundleHeader(bytes('# v2 git bundle\n', `${A} refs/heads/x\n`))).toBeNull()
  })

  it.each([
    ['another signature', bytes('# v4 git bundle\n')],
    ['a signature that cannot become one', bytes('PK\x03\x04')],
    ['a signature ending in CR LF', bytes('# v2 git bundle\r\n')],
    ['a filter capability', bytes('# v3 git bundle\n@filter=blob:none\n', `${A} refs/heads/x\n\n`)],
    [
      'another object format',
      bytes('# v3 git bundle\n@object-format=sha256\n', `${A} refs/heads/x\n\n`),
    ],
    ['a capability in a v2 header', bytes('# v2 git bundle\n@object-format=sha1\n')],
    ['no head', bytes('# v2 git bundle\n', `-${B}\n`, '\n')],
    ['a short prerequisite', bytes('# v2 git bundle\n', `-${B.slice(1)}\n`)],
    ['a prerequisite with a tab before its comment', bytes('# v2 git bundle\n', `-${B}\tx\n`)],
    ['an uppercase object ID', bytes('# v2 git bundle\n', `${A.toUpperCase()} refs/heads/x\n`)],
    ['a head with no refname', bytes('# v2 git bundle\n', `${A} \n`)],
    ['a prerequisite after a head', bytes('# v2 git bundle\n', `${A} refs/heads/x\n`, `-${B}\n`)],
    ['a blank line ending in CR', bytes('# v2 git bundle\n', `${A} refs/heads/x\n`, '\r\n')],
  ])('refuses %s', (_label, input) => {
    expect(() => scanBundleHeader(input)).toThrow(BundleHeaderError)
  })

  it('refuses a header that has not ended within its bound, holding no more than it', () => {
    const line = Buffer.alloc(2 * 1024 * 1024, 0x61)
    expect(() => scanBundleHeader(bytes('# v2 git bundle\n', `-${B} `, line))).toThrow(
      `does not end within ${BUNDLE_HEADER_MAX_BYTES} bytes`,
    )
    // At the bound itself, not only past it.
    const atBound = bytes('# v2 git bundle\n', `-${B} `, line).subarray(0, BUNDLE_HEADER_MAX_BYTES)
    expect(() => scanBundleHeader(atBound)).toThrow(BundleHeaderError)
    expect(scanBundleHeader(atBound.subarray(0, BUNDLE_HEADER_MAX_BYTES - 1))).toBeNull()
  })
})

describe('hasOnlyHead', () => {
  const scan = (...heads: string[]) =>
    scanBundleHeader(bytes('# v2 git bundle\n', ...heads.map((h) => `${h}\n`), '\n'))!

  it('accepts exactly `<sha> refs/heads/<branch>`, byte for byte', () => {
    expect(hasOnlyHead(scan(`${A} refs/heads/feature/x`), A, 'feature/x')).toBe(true)
    expect(expectedHead(A, 'feature/x').toString()).toBe(`${A} refs/heads/feature/x`)
  })

  it.each([
    ['an extra head', [`${A} refs/heads/feature`, `${B} refs/heads/other`]],
    ['a renamed head', [`${A} refs/heads/other`]],
    ['a space-embedded refname', [`${A} refs/heads/feature extra`]],
    ['a tab-embedded refname', [`${A} refs/heads/feature\textra`]],
    ['an option for a refname', [`${A} --filter=blob:none`]],
    ['another commit', [`${B} refs/heads/feature`]],
    ['a head outside refs/heads', [`${A} refs/tags/feature`]],
  ])('refuses %s', (_label, heads) => {
    expect(hasOnlyHead(scan(...heads), A, 'feature')).toBe(false)
  })
})
