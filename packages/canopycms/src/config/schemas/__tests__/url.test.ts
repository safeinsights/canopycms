import { describe, expect, it } from 'vitest'

import { assetMountUrlSchema, uploadTargetUrlSchema } from '../url'

// Shapes both schemas agree on. Kept as one table so a change to either schema that
// accidentally diverges them on ordinary input shows up as a failure rather than as drift.
const ACCEPTED_BY_BOTH = [
  'https://cdn.example.com',
  'https://cdn.example.com/asset-upload/',
  // http is deliberately legal: a local S3-compatible endpoint (MinIO, LocalStack) is
  // http://localhost:9000, and that is where an adopter would first exercise this.
  'http://localhost:9000',
  '/asset-upload/',
  '/asset-upload',
  '/',
]

// Every one of these reads as harmless to a human or to a naive startsWith('/') check.
// The comments record what a browser ACTUALLY does with each, since that is the reason.
const REJECTED_BY_BOTH: [string, string][] = [
  ['///x', 'resolves to host "x", not to pathname "/x"'],
  ['////x', 'same, with more slashes'],
  ['//', 'empty authority; new URL() throws on it'],
  ['/\\evil.example.com', 'WHATWG treats backslash as slash: host evil.example.com'],
  ['\\\\evil.example.com', 'same'],
  ['\\/evil.example.com', 'same'],
  ['/\tx', 'tab is stripped during parsing, so the browser requests /x'],
  ['/x\ny', 'newline likewise'],
  ['javascript:alert(1)', 'not http(s)'],
  ['data:text/html,x', 'not http(s)'],
  ['mailto:a@b.c', 'not http(s)'],
  ['ftp://x/', 'not http(s)'],
  ['localhost:9000', 'scheme-shaped but protocol is "localhost:"'],
  ['not-a-url', 'no scheme and no leading slash'],
  ['asset-upload/', 'document-relative: resolves differently on every page'],
  [
    'https://cdn.example.com/?x=1',
    'POST Object takes no query; a prefix carrying one corrupts the join',
  ],
  ['https://cdn.example.com/#y', 'a fragment is never transmitted'],
  ['/asset-upload/?x=1', 'same, site-relative'],
  ['', 'empty'],
  ['   ', 'whitespace only (trimmed to empty)'],
]

describe('uploadTargetUrlSchema', () => {
  it.each(ACCEPTED_BY_BOTH)('accepts %j', (value) => {
    expect(uploadTargetUrlSchema.parse(value)).toBe(value)
  })

  it.each(REJECTED_BY_BOTH)('rejects %j (%s)', (value) => {
    expect(() => uploadTargetUrlSchema.parse(value)).toThrow()
  })

  // The difference between the two schemas, and the only one. A protocol-relative upload
  // target inherits the editor's scheme, so an http editor tier would silently downgrade an
  // upload carrying a live credential to plaintext.
  it('rejects a protocol-relative //host, which the mount schema accepts', () => {
    expect(() => uploadTargetUrlSchema.parse('//cdn.example.com')).toThrow()
    expect(assetMountUrlSchema.parse('//cdn.example.com')).toBe('//cdn.example.com')
  })

  it('trims surrounding whitespace, so a templated env var with a trailing newline still parses', () => {
    expect(uploadTargetUrlSchema.parse('  /asset-upload/\n')).toBe('/asset-upload/')
  })

  // Guard on the rejection table itself: the shape the adopter originally proposed must fail
  // on the rows that motivated writing our own predicate. If this passes with their union,
  // the table above is not discriminating and the rest of this file proves nothing.
  it('rejects the shapes a naive union of z.string().url() and startsWith("/") would accept', () => {
    for (const value of [
      '//evil.example.com/',
      '///x',
      '/\\evil.example.com',
      'javascript:alert(1)',
    ]) {
      const naivelyAccepted = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')
      expect(naivelyAccepted).toBe(true)
      expect(() => uploadTargetUrlSchema.parse(value)).toThrow()
    }
  })
})

describe('assetMountUrlSchema', () => {
  it.each(ACCEPTED_BY_BOTH)('accepts %j', (value) => {
    expect(assetMountUrlSchema.parse(value)).toBe(value)
  })

  it.each(REJECTED_BY_BOTH)('rejects %j (%s)', (value) => {
    expect(() => assetMountUrlSchema.parse(value)).toThrow()
  })

  // The relaxation: this is what editor-asset-mount-topology.md option 1 asks for, and what
  // AssetContext's basePath fallback exists only because the old z.string().url() forbade.
  it('accepts a site-relative mount point, which z.string().url() rejected', () => {
    expect(assetMountUrlSchema.parse('/preview-123')).toBe('/preview-123')
  })

  // The tightening, in the same change: z.string().url() accepted any scheme new URL() parses.
  it('rejects a non-http scheme that z.string().url() used to accept', () => {
    expect(() => assetMountUrlSchema.parse('mailto:a@b.c')).toThrow()
  })

  it('accepts a protocol-relative //host, which url-prefix.ts documents as intentional', () => {
    expect(assetMountUrlSchema.parse('//cdn.example.com')).toBe('//cdn.example.com')
  })
})
