import { describe, expect, it } from 'vitest'

import {
  displayPreviewPath,
  isSamePreviewPath,
  normalizePreviewPath,
  previewPageKey,
  siteChromeSrc,
} from './preview-path'

describe('normalizePreviewPath', () => {
  it.each([
    ['/blog/x/?branch=b', '/blog/x?branch=b'],
    ['/blog/x?branch=b', '/blog/x?branch=b'],
    ['/', '/'],
    ['/?branch=b', '/?branch=b'],
    ['/base/?branch=b', '/base?branch=b'],
    ['https://cms.example.com/p/x/?branch=b', '/p/x?branch=b'],
    ['https://cms.example.com?branch=b', '/?branch=b'],
    ['/blog/x/#top', '/blog/x'],
    ['preview-entry1', '/preview-entry1'],
  ])('reduces %s to %s', (input, expected) => {
    expect(normalizePreviewPath(input)).toBe(expected)
  })
})

describe('isSamePreviewPath', () => {
  it('matches spellings that differ only by a trailing slash or origin', () => {
    expect(isSamePreviewPath('/blog/x?branch=b', '/blog/x/?branch=b')).toBe(true)
    expect(isSamePreviewPath('https://cms.example.com/blog/x?branch=b', '/blog/x/?branch=b')).toBe(
      true,
    )
  })

  it('keeps paths and queries distinct', () => {
    expect(isSamePreviewPath('/blog/x?branch=b', '/blog/y?branch=b')).toBe(false)
    expect(isSamePreviewPath('/blog/x?branch=b', '/blog/x?branch=c')).toBe(false)
    expect(isSamePreviewPath('/blog/x?branch=b', '/blog/x')).toBe(false)
    expect(isSamePreviewPath('/base/blog/x', '/blog/x')).toBe(false)
  })
})

describe('displayPreviewPath', () => {
  it.each([
    ['/blog/x/?branch=b', '/blog/x/'],
    ['/?branch=feature%2Fa', '/'],
    ['/blog/x?branch=b&lang=en#top', '/blog/x?lang=en'],
    ['/base/preview/blog/x', '/base/preview/blog/x'],
    ['https://other.example.com/p/x?branch=b', 'https://other.example.com/p/x'],
    ['//cdn.example.com/p?branch=b', '//cdn.example.com/p'],
    ['/search?flag&branch=b', '/search?flag'],
    ['/p?q=a%20b&branch=b&tags[]=a/b', '/p?q=a%20b&tags[]=a/b'],
    ['custom://h/p?branch=b', 'custom://h/p'],
  ])('shows %s as %s', (input, expected) => {
    expect(displayPreviewPath(input)).toBe(expected)
  })
})

describe('displayPreviewPath with the preview mount', () => {
  it.each([
    ['/preview/posts/x?branch=b', {}, '/preview/posts/x'],
    ['/preview/posts/x?branch=b', { previewPrefix: '/preview' }, '/posts/x'],
    ['/preview?branch=b', { previewPrefix: 'preview/' }, '/'],
    ['/preview/?branch=b', { previewPrefix: '/preview' }, '/'],
    ['/b/preview/posts/x/?branch=b', { basePath: '/b', previewPrefix: '/preview' }, '/b/posts/x/'],
    ['/b/preview?branch=b', { basePath: 'b', previewPrefix: '/preview' }, '/b'],
    ['/previewer/x?branch=b', { previewPrefix: '/preview' }, '/previewer/x'],
    ['/b/posts/x?branch=b', { basePath: '/b', previewPrefix: '/preview' }, '/b/posts/x'],
    [
      'https://cms.example.com/preview/posts/x?branch=b',
      { basePath: '/b', previewPrefix: 'https://cms.example.com/preview' },
      '/posts/x',
    ],
  ])('shows %s under %j as %s', (src, mount, expected) => {
    expect(displayPreviewPath(src, mount)).toBe(expected)
  })
})

describe('the site header and footer query', () => {
  it('names the same page with or without chrome=1', () => {
    expect(normalizePreviewPath('/preview/x?branch=b&chrome=1')).toBe('/preview/x?branch=b')
    expect(normalizePreviewPath('/preview/x/?chrome=1')).toBe('/preview/x')
    expect(isSamePreviewPath('/preview/x?branch=b&chrome=1', '/preview/x?branch=b')).toBe(true)
    expect(isSamePreviewPath('/preview/x?chrome=1&branch=b', '/preview/x/?branch=b')).toBe(true)
  })

  it("keeps a site's own chrome query that is not the toggle's", () => {
    expect(normalizePreviewPath('/x?chrome=dark')).toBe('/x?chrome=dark')
    expect(isSamePreviewPath('/x?chrome=dark', '/x')).toBe(false)
  })

  it('leaves chrome=1 out of the shown path', () => {
    expect(
      displayPreviewPath('/preview/posts/x?branch=b&chrome=1', { previewPrefix: '/preview' }),
    ).toBe('/posts/x')
    expect(displayPreviewPath('/p?chrome=1&lang=en')).toBe('/p?lang=en')
  })
})

describe('siteChromeSrc', () => {
  it.each([
    [
      '/preview/posts/x?branch=b',
      { previewPrefix: '/preview' },
      '/preview/posts/x?branch=b&chrome=1',
    ],
    ['/preview/posts/x/', { previewPrefix: '/preview' }, '/preview/posts/x/?chrome=1'],
    ['/preview?branch=b#top', { previewPrefix: '/preview' }, '/preview?branch=b&chrome=1#top'],
    ['/preview/x?', { previewPrefix: '/preview' }, '/preview/x?chrome=1'],
    ['/preview/x?chrome=1', { previewPrefix: '/preview' }, '/preview/x?chrome=1'],
    [
      '/b/preview/x?branch=b',
      { basePath: '/b', previewPrefix: '/preview' },
      '/b/preview/x?branch=b&chrome=1',
    ],
    [
      'https://cms.example.com/preview/x?branch=b',
      { previewPrefix: 'https://cms.example.com/preview' },
      'https://cms.example.com/preview/x?branch=b&chrome=1',
    ],
  ])('asks %s under %j for the header and footer', (src, mount, expected) => {
    expect(siteChromeSrc(src, mount)).toBe(expected)
  })

  it.each([
    ['/posts/x?branch=b', {}],
    ['/posts/x?branch=b', { previewPrefix: '/preview' }],
    ['/previewer/x', { previewPrefix: '/preview' }],
    ['https://other.example.com/preview/x?branch=b', { previewPrefix: '/preview' }],
    ['/preview/x', { basePath: '/b', previewPrefix: '/preview' }],
    ['/posts/x?branch=b', { previewPrefix: '/' }],
  ])("leaves %s under %j alone: it is a page of the site's own", (src, mount) => {
    expect(siteChromeSrc(src, mount)).toBeUndefined()
  })
})

describe('previewPageKey', () => {
  const editor = 'https://cms.example/edit?entry=x'
  const key = (url: string, mount: Parameters<typeof previewPageKey>[1] = {}) =>
    previewPageKey(url, mount, editor)

  it.each([
    ['/preview/posts/x/?branch=b', 'https://cms.example/posts/x', { previewPrefix: '/preview' }],
    [
      '/base/preview/posts/x?branch=b&chrome=1',
      'https://cms.example/base/posts/x/',
      { basePath: '/base', previewPrefix: '/preview' },
    ],
    [
      '/base/preview/posts/x',
      'https://cms.example/base/preview/posts/x#top',
      {
        basePath: '/base',
        previewPrefix: '/preview',
      },
    ],
    ['/posts/x?branch=b', 'https://cms.example/posts/x', {}],
    [
      'https://site.example/preview/posts/x?branch=b',
      'https://site.example/posts/x',
      { previewPrefix: 'https://site.example/preview' },
    ],
    [
      'https://cms.example/preview/posts/x',
      'https://cms.example/posts/x',
      { previewPrefix: 'https://cms.example/preview' },
    ],
  ])('names the entry page %s and the link %s alike under %j', (src, href, mount) => {
    expect(key(src, mount)).toBeDefined()
    expect(key(src, mount)).toBe(key(href, mount))
  })

  it.each([
    ['/preview/posts/x?branch=b', 'https://cms.example/posts/y', { previewPrefix: '/preview' }],
    [
      '/preview/posts/x?branch=b',
      'https://cms.example/posts/x?page=2',
      { previewPrefix: '/preview' },
    ],
    ['/preview/posts/x?branch=b', 'https://other.example/posts/x', { previewPrefix: '/preview' }],
    ['https://site.example/posts/x', 'https://cms.example/posts/x', {}],
  ])('tells the entry page %s from the link %s under %j', (src, href, mount) => {
    expect(key(src, mount)).not.toBe(key(href, mount))
  })

  it('names nothing for a URL that does not parse', () => {
    expect(key('http://')).toBeUndefined()
  })
})
