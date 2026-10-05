import { describe, expect, it } from 'vitest'

import { isSamePreviewPath, normalizePreviewPath } from './preview-path'

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
