import { describe, expect, it } from 'vitest'

import {
  isAbsoluteUrl,
  isUnprefixablePath,
  joinUrlPrefix,
  sanitizeUnprefixedPath,
  stripTrailingSlashes,
  toSameOriginPath,
} from './url-prefix'

describe('joinUrlPrefix - path side', () => {
  it('passes a declared off-site path through untouched, prefix or not', () => {
    expect(joinUrlPrefix('/preview-123', 'https://other.org/page')).toBe('https://other.org/page')
    expect(joinUrlPrefix('https://example.com', 'https://other.org/page')).toBe(
      'https://other.org/page',
    )
    expect(joinUrlPrefix('/preview-123', '//cdn.example.com/x.png')).toBe('//cdn.example.com/x.png')
    expect(joinUrlPrefix(undefined, 'https://other.org/page')).toBe('https://other.org/page')
  })

  it('supplies a leading slash on a bare path even with no prefix', () => {
    expect(joinUrlPrefix(undefined, 'about')).toBe('/about')
    expect(joinUrlPrefix('', 'about')).toBe('/about')
  })

  it('neutralizes a backslash-spelled off-origin path rather than emitting it', () => {
    // These all resolve to another host in a browser despite looking site-relative.
    expect(joinUrlPrefix(undefined, '/\\evil.com/x')).toBe('/x')
    expect(joinUrlPrefix('/preview-123', '\\\\evil.com/x')).toBe('/preview-123/x')
    expect(joinUrlPrefix(undefined, '\\/evil.com/x')).toBe('/x')
  })

  // REGRESSION. Neutralizing returns pathname+search+hash, and a WHATWG pathname can itself begin
  // with '//': '/\evil.com//x' parses to host evil.com with pathname '//x'. Emitting that string
  // re-creates a protocol-relative reference to a host named 'x'. The cases above all happened to
  // neutralize to a SINGLE-segment path, which is why they missed this entirely.
  it('collapses a // pathname produced by neutralizing, instead of re-creating a protocol-relative URL', () => {
    expect(joinUrlPrefix(undefined, '/\\evil.com//x')).toBe('/x')
    expect(joinUrlPrefix('/preview-123', '/\\evil.com//x')).toBe('/preview-123/x')
    expect(joinUrlPrefix('https://example.com', '\\\\evil.com//x')).toBe('https://example.com/x')
    expect(joinUrlPrefix(undefined, '/\\evil.com///x')).toBe('/x')
    expect(joinUrlPrefix(undefined, '/\\evil.com//x?a=1#b')).toBe('/x?a=1#b')
  })

  it('exposes that collapse as toSameOriginPath, and leaves an ordinary path alone', () => {
    expect(toSameOriginPath('/\\evil.com//x')).toBe('/x')
    expect(toSameOriginPath('/a/b')).toBe('/a/b')
    expect(toSameOriginPath('a/b')).toBe('a/b')
  })

  // joinUrlPrefix ROOTS a scheme-bearing but non-absolute value, and must keep doing so: its
  // `prefix` can be a site ORIGIN (resolveSeoUrl), where the output has to end up absolute -- a
  // non-absolute sitemap <loc> invalidates the whole sitemap. Sharing a scheme pass-through with
  // the asset-mount case is what silently made resolveSeoUrl('mailto:a@b.c', { siteUrl }) return
  // 'mailto:a@b.c' with the origin dropped.
  it('roots a scheme-bearing but non-absolute value rather than passing it through', () => {
    expect(joinUrlPrefix('https://example.com', 'mailto:a@b.c')).toBe(
      'https://example.com/mailto:a@b.c',
    )
    expect(joinUrlPrefix('https://example.com', 'data:text/html,x')).toBe(
      'https://example.com/data:text/html,x',
    )
    expect(joinUrlPrefix(undefined, 'mailto:a@b.c')).toBe('/mailto:a@b.c')
  })

  // The pass-through the asset-mount case wants lives here instead, so only callers that opt in
  // get it. '/data:image/png;…' would be a broken <img src>.
  it('isUnprefixablePath / sanitizeUnprefixedPath keep scheme-bearing values byte-identical', () => {
    for (const value of [
      'data:image/png;base64,AAA',
      'blob:https://example.com/abc',
      'mailto:a@b.c',
      '//cdn.example.com/x.png',
      'https://other.org/page',
    ]) {
      expect(isUnprefixablePath(value)).toBe(true)
      expect(sanitizeUnprefixedPath(value)).toBe(value)
    }
    expect(isUnprefixablePath('/assets/x.png')).toBe(false)
    expect(isUnprefixablePath('images/x.png')).toBe(false)
  })
})

describe('joinUrlPrefix - prefix side', () => {
  it('joins an absolute origin, stripping any run of trailing slashes', () => {
    expect(joinUrlPrefix('https://example.com', '/a')).toBe('https://example.com/a')
    expect(joinUrlPrefix('https://example.com/', '/a')).toBe('https://example.com/a')
    expect(joinUrlPrefix('https://example.com///', '/a')).toBe('https://example.com/a')
  })

  it('joins an origin that itself carries a path', () => {
    expect(joinUrlPrefix('https://example.com/sub', '/a')).toBe('https://example.com/sub/a')
  })

  it('supplies a missing leading slash on a same-origin path prefix', () => {
    // Without this the result is document-relative and resolves differently per page.
    expect(joinUrlPrefix('preview-123', '/a')).toBe('/preview-123/a')
  })

  it('treats an empty or slash-only prefix as absent', () => {
    expect(joinUrlPrefix(undefined, '/a')).toBe('/a')
    expect(joinUrlPrefix('', '/a')).toBe('/a')
    expect(joinUrlPrefix('/', '/a')).toBe('/a')
    expect(joinUrlPrefix('///', '/a')).toBe('/a')
    // '//' must NOT survive as a prefix: `//` + `/a` reads as protocol-relative to host 'a'.
    expect(joinUrlPrefix('//', '/a')).toBe('/a')
  })

  it('preserves a literal protocol-relative prefix as an intentional off-site pointer', () => {
    expect(joinUrlPrefix('//cdn.example.com', '/a')).toBe('//cdn.example.com/a')
    expect(joinUrlPrefix('//cdn.example.com/', '/a')).toBe('//cdn.example.com/a')
  })
})

describe('isAbsoluteUrl', () => {
  it('accepts scheme-qualified and literal protocol-relative URLs', () => {
    expect(isAbsoluteUrl('https://other.org/page')).toBe(true)
    expect(isAbsoluteUrl('http://other.org/page')).toBe(true)
    expect(isAbsoluteUrl('//cdn.example.com/a.png')).toBe(true)
  })

  it('rejects site-relative paths and backslash-spelled off-origin values', () => {
    expect(isAbsoluteUrl('/page')).toBe(false)
    expect(isAbsoluteUrl('page')).toBe(false)
    // Narrower than "resolves off-origin" by design — callers neutralize these instead.
    expect(isAbsoluteUrl('/\\evil.com')).toBe(false)
    expect(isAbsoluteUrl('\\\\evil.com')).toBe(false)
  })
})

describe('stripTrailingSlashes', () => {
  it('strips a run of trailing slashes and nothing else', () => {
    expect(stripTrailingSlashes('https://example.com///')).toBe('https://example.com')
    expect(stripTrailingSlashes('/a/b/')).toBe('/a/b')
    expect(stripTrailingSlashes('/a/b')).toBe('/a/b')
    expect(stripTrailingSlashes('///')).toBe('')
    expect(stripTrailingSlashes('')).toBe('')
  })
})
