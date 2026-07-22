import { describe, expect, it } from 'vitest'

import {
  ASSET_PREFIXES,
  createKeyBuilders,
  hashBytes,
  metaKey,
  originalKey,
  originalPrefix,
  publicKey,
  slugifyFilename,
  stagingKey,
} from './keys'

describe('hashBytes', () => {
  it('is deterministic for identical input', () => {
    const data = new TextEncoder().encode('hello world')
    expect(hashBytes(data)).toBe(hashBytes(data))
  })

  it('differs for different input', () => {
    const a = new TextEncoder().encode('hello')
    const b = new TextEncoder().encode('world')
    expect(hashBytes(a)).not.toBe(hashBytes(b))
  })

  it('truncates sha-256 to 32 hex chars', () => {
    const hash = hashBytes(new TextEncoder().encode('hello world'))
    expect(hash).toHaveLength(32)
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    // Known sha-256("hello world") = b94d27b9934d3e08a52e52d7da7dabfa...
    // truncated to the first 32 hex chars.
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfa')
  })

  it('is empty-input safe', () => {
    const hash = hashBytes(new Uint8Array())
    expect(hash).toHaveLength(32)
  })
})

describe('slugifyFilename', () => {
  it('lowercases and normalizes a simple filename', () => {
    expect(slugifyFilename('IMG_1234.PNG')).toEqual({ slug: 'img-1234', ext: 'png' })
  })

  it('collapses spaces and punctuation into single dashes', () => {
    expect(slugifyFilename('My Photo (1).jpeg')).toEqual({ slug: 'my-photo-1', ext: 'jpeg' })
  })

  it('strips diacritics via NFKD decomposition', () => {
    const { slug, ext } = slugifyFilename('café münchen.png')
    expect(slug).toBe('cafe-munchen')
    expect(ext).toBe('png')
  })

  it('falls back to a fixed slug when the basename has no ascii-safe characters', () => {
    // CJK characters have no NFKD ascii decomposition, so the slug portion
    // collapses to empty and the fallback kicks in. The extension is untouched.
    const { slug, ext } = slugifyFilename('日本語.png')
    expect(slug).toBe('file')
    expect(ext).toBe('png')
  })

  it('falls back to a fixed slug for an empty filename', () => {
    expect(slugifyFilename('')).toEqual({ slug: 'file', ext: '' })
  })

  it('drops directory components instead of leaking them into the slug', () => {
    expect(slugifyFilename('/etc/passwd')).toEqual({ slug: 'passwd', ext: '' })
  })

  it('neutralizes path traversal sequences', () => {
    const { slug } = slugifyFilename('../../evil.txt')
    expect(slug).not.toContain('..')
    expect(slug).not.toContain('/')
    expect(slug).toBe('evil')
  })

  it('neutralizes windows-style path separators', () => {
    expect(slugifyFilename('C:\\Users\\name\\report.pdf')).toEqual({ slug: 'report', ext: 'pdf' })
  })

  it('treats a filename ending in a separator as empty (fallback slug)', () => {
    expect(slugifyFilename('evil/')).toEqual({ slug: 'file', ext: '' })
  })

  it('caps slug length to ~80 chars', () => {
    const longName = `${'a'.repeat(200)}.png`
    const { slug, ext } = slugifyFilename(longName)
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(ext).toBe('png')
  })

  it('does not leave a trailing dash after length capping', () => {
    // Construct a name whose 80th character lands right after a run of
    // separators, so naive slicing would leave a trailing dash.
    const longName = `${'a'.repeat(79)} ${'b'.repeat(50)}.gif`
    const { slug } = slugifyFilename(longName)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('treats a leading-dot dotfile as having no extension', () => {
    expect(slugifyFilename('.gitignore')).toEqual({ slug: 'gitignore', ext: '' })
  })

  it('keeps only the last extension for multi-dot filenames', () => {
    expect(slugifyFilename('archive.tar.gz')).toEqual({ slug: 'archive-tar', ext: 'gz' })
  })

  it('strips unsafe characters from the extension and caps its length', () => {
    const { ext } = slugifyFilename('weird.p!n?g'.padEnd(20, 'x'))
    expect(ext).toMatch(/^[a-z0-9]*$/)
    expect(ext.length).toBeLessThanOrEqual(10)
  })

  it('never trusts the extension for header/path use (no separators survive)', () => {
    const { ext } = slugifyFilename('name.png/../../etc')
    expect(ext).not.toContain('/')
    expect(ext).not.toContain('.')
  })
})

describe('key builders', () => {
  it('build the documented prefix layout', () => {
    expect(originalKey('abc123', 'png')).toBe('asset-originals/abc123.png')
    expect(originalPrefix('abc123')).toBe('asset-originals/abc123.')
    expect(stagingKey('uuid-1')).toBe('asset-staging/uuid-1')
    expect(metaKey('abc123')).toBe('asset-meta/abc123.json')
    expect(publicKey('abc123', 'my-slug', 'svg')).toBe('assets/abc123/my-slug.svg')
  })

  it('exposes exactly the five documented prefixes as constants', () => {
    expect(ASSET_PREFIXES).toEqual({
      originals: 'asset-originals',
      staging: 'asset-staging',
      meta: 'asset-meta',
      public: 'assets',
      transform: 'assets/t',
    })
  })

  it('supports building keys against an overridden prefix set', () => {
    const custom = createKeyBuilders({
      originals: 'custom-originals',
      staging: 'custom-staging',
      meta: 'custom-meta',
      public: 'custom-assets',
      transform: 'custom-assets/t',
    })
    expect(custom.originalKey('h', 'png')).toBe('custom-originals/h.png')
    expect(custom.stagingKey('u')).toBe('custom-staging/u')
    expect(custom.metaKey('h')).toBe('custom-meta/h.json')
    expect(custom.metaPrefix()).toBe('custom-meta/')
    expect(custom.publicKey('h', 's', 'svg')).toBe('custom-assets/h/s.svg')
  })
})
