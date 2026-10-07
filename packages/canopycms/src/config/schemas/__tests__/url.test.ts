import { describe, expect, it } from 'vitest'

import { uploadTargetUrlSchema } from '../url'

const ACCEPTED = [
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
const REJECTED: [string, string][] = [
  ['///x', 'resolves to host "x", not to pathname "/x"'],
  ['////x', 'same, with more slashes'],
  // Ambiguous, not unsafe: it resolves to http or https depending on the editor page issuing
  // the upload, so the config would not determine where a live credential is sent.
  ['//cdn.example.com', 'protocol-relative: the scheme is left to the page'],
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
  ['https:cdn.example.com', 'no authority: resolved against the page DIRECTORY, /admin/cdn…'],
  ['https:/cdn.example.com/asset-upload/', 'one slash: resolved against the page ROOT, /cdn…'],
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
  it.each(ACCEPTED)('accepts %j', (value) => {
    expect(uploadTargetUrlSchema.parse(value)).toBe(value)
  })

  it.each(REJECTED)('rejects %j (%s)', (value) => {
    expect(() => uploadTargetUrlSchema.parse(value)).toThrow()
  })

  it('trims surrounding whitespace, so a templated env var with a trailing newline still parses', () => {
    expect(uploadTargetUrlSchema.parse('  /asset-upload/\n')).toBe('/asset-upload/')
  })
})
