import { describe, expect, it } from 'vitest'
import { sanitizeHref } from './sanitize-href'

describe('sanitizeHref', () => {
  it('allows absolute http: URLs', () => {
    expect(sanitizeHref('http://example.com')).toBe('http://example.com/')
  })

  it('allows absolute https: URLs', () => {
    expect(sanitizeHref('https://example.com/x')).toBe('https://example.com/x')
  })

  it('resolves root-relative paths', () => {
    expect(sanitizeHref('/about')).toBe('/about')
  })

  it('resolves path-relative references as root-relative', () => {
    expect(sanitizeHref('docs/guide')).toBe('/docs/guide')
  })

  it('resolves fragment-only input as a same-page reference', () => {
    expect(sanitizeHref('#section')).toBe('#section')
  })

  it('resolves query-only input as a same-page reference', () => {
    expect(sanitizeHref('?q=1')).toBe('?q=1')
  })

  it('preserves the root path itself', () => {
    expect(sanitizeHref('/')).toBe('/')
  })

  it('blocks javascript: URLs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBe('#')
  })

  it('blocks data: URLs', () => {
    expect(sanitizeHref('data:text/html,<script>alert(1)</script>')).toBe('#')
  })

  it('blocks vbscript: URLs', () => {
    expect(sanitizeHref('vbscript:msgbox(1)')).toBe('#')
  })

  it('rejects protocol-relative URLs (treated as likely mistake/injection, not a safe absolute link)', () => {
    expect(sanitizeHref('//evil.com/x')).toBe('#')
  })

  it('returns the fallback for an empty string', () => {
    expect(sanitizeHref('')).toBe('#')
  })

  it('returns the fallback for whitespace-only input', () => {
    expect(sanitizeHref('   ')).toBe('#')
  })

  it('honors a custom fallback for disallowed schemes', () => {
    expect(sanitizeHref('javascript:alert(1)', '/safe')).toBe('/safe')
  })

  it('honors a custom fallback for empty input', () => {
    expect(sanitizeHref('', '/safe')).toBe('/safe')
  })

  it('does not use the custom fallback for allowed input', () => {
    expect(sanitizeHref('/about', '/safe')).toBe('/about')
  })
})
