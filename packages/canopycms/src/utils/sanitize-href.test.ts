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

  // Regression: an earlier version of this function rejected protocol-relative
  // input with `trimmed.startsWith('//')`, which only catches the literal ASCII
  // spelling. WHATWG URL treats a backslash as equivalent to a slash for
  // special schemes, so every form below is protocol-relative in effect and
  // each resolved to `https://evil.com/` -- an open redirect out of the one
  // function whose job is to prevent that. Enumerating spellings is not a fix;
  // the guard now tests whether the input declares a scheme at all.
  it.each([
    ['backslash after slash', '/\\evil.com'],
    ['double backslash', '\\\\evil.com'],
    ['backslash then slash', '\\/evil.com'],
    ['tab inside', '/\t/evil.com'],
    ['newline inside', '/\n/evil.com'],
    ['carriage return inside', '/\r/evil.com'],
    ['mixed slashes with path', '/\\evil.com/path?a=1'],
  ])('never returns an off-site absolute URL for %s', (_label, input) => {
    const result = sanitizeHref(input)
    // The precise return value is not the contract -- "never off-site" is.
    // Some spellings are legitimately salvageable as a same-origin path.
    expect(result).not.toMatch(/^https?:\/\/evil\.com/)
    expect(result === '#' || result.startsWith('/')).toBe(true)
  })

  it('still allows a genuinely absolute https URL to another origin', () => {
    // The guard must reject INFERRED off-site origins, not declared ones --
    // otherwise it would break the documented primary use (an author linking out).
    expect(sanitizeHref('https://example.com/page')).toBe('https://example.com/page')
    expect(sanitizeHref('http://example.com/page')).toBe('http://example.com/page')
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
