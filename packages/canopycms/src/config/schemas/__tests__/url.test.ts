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
  // Dots that are NOT whole segments must survive the dot-segment guard. Hostnames are full
  // of them, and so are ordinary paths — this is the over-rejection the guard could cause.
  'https://cdn.example.com/v1.0/upload/',
  'http://[::1]:9000/bucket',
  '/v1.0/upload',
  '/.well-known/upload',
  '/file..name',
  '/a.b/c.d',
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
  // A scheme that parses to an http(s) URL server-side but that a browser resolves RELATIVE,
  // because it carries no `//` authority. `new URL('https:cdn.example.com')` reports
  // https://cdn.example.com/, while a browser on https://editor.example.com/admin/media sends
  // it to https://editor.example.com/admin/cdn.example.com. Dropping the `//` is an ordinary
  // typo, and the two readings differ by origin.
  ['https:cdn.example.com', 'scheme with no // authority; browser resolves it relative'],
  ['https:/cdn.example.com/asset-upload/', 'one slash, same problem'],
  ['http:cdn.example.com', 'same, on http'],
  // Backslash: WHATWG treats it as a path separator for special schemes.
  ['/\\', 'new URL() rejects it, so it slips past the off-origin check and joins to //assets'],
  ['/\\/', 'same'],
  ['/asset\\upload/', 'sent as /asset/upload/ — the stored value is not what is requested'],
  ['https://cdn.example.com/x\\y', 'sent as /x/y'],
  // Dot segments resolve away before the request leaves the browser.
  ['/asset-upload/..', 'sent as /'],
  ['/./x', 'sent as /x'],
  // WHATWG percent-decodes case-insensitively when identifying dot segments, so a
  // literal-only guard reads as complete and is one encoding away from useless.
  ['/asset-upload/%2e%2e/', 'encoded .. — also sent as /'],
  ['/asset-upload/%2E%2E/', 'uppercase encoding'],
  ['/asset-upload/.%2e/', 'mixed literal and encoded'],
  ['/asset-upload/%2e./', 'mixed, other order'],
  ['/asset-upload/%2e/', 'encoded single dot'],
  ['/a/%2e%2e/%2e%2e/b', 'sent as /b'],
  ['https://cdn.example.com/asset-upload/%2e%2e/', 'absolute form, sent as the origin root'],
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
