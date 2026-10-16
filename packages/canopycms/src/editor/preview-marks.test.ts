import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import { findInexactMarks } from './preview-marks'

const fields: FieldConfig[] = [
  { type: 'string', name: 'title' },
  { type: 'string', name: 'tags', list: true },
  { type: 'group', name: 'seo', fields: [{ type: 'string', name: 'metaTitle' }] },
  {
    type: 'object',
    name: 'banner',
    fields: [
      { type: 'string', name: 'heading' },
      { type: 'object', name: 'items', list: true, fields: [{ type: 'string', name: 'text' }] },
    ],
  },
  { type: 'reference', name: 'author', collections: ['content/authors'] },
  { type: 'image', name: 'cover' },
  {
    type: 'block',
    name: 'sections',
    templates: [
      { name: 'hero', fields: [{ type: 'string', name: 'headline' }] },
      {
        name: 'posts',
        fields: [
          {
            type: 'object',
            name: 'posts',
            list: true,
            fields: [{ type: 'string', name: 'category' }],
          },
        ],
      },
    ],
  },
]
const data = {
  title: 'Home',
  sections: [
    { template: 'hero', value: { headline: 'Hi' } },
    { template: 'posts', value: { posts: [{ category: 'news' }] } },
  ],
}

const inexact = (...paths: string[]) => findInexactMarks(fields, data, paths)

describe('findInexactMarks', () => {
  it('passes every path the form has a field or item for', () => {
    expect(
      inexact(
        'title',
        'tags[3]',
        'metaTitle',
        'banner',
        'banner.heading',
        'banner.items[0]',
        'banner.items.1.text',
        'author',
        'cover',
        'sections',
        'sections[0]',
        'sections[0].headline',
        'sections[1].posts[0].category',
      ),
    ).toEqual([])
  })

  it('flags a key the schema lacks, with its nearest field', () => {
    expect(inexact('sections[1].posts[0].tag', 'subtitle')).toEqual([
      { path: 'sections[1].posts[0].tag', nearest: 'sections[1].posts[0]' },
      { path: 'subtitle' },
    ])
  })

  it('flags a path below a reference, an image or a scalar', () => {
    expect(inexact('author.name', 'cover.alt', 'title.text', 'tags[0].x')).toEqual([
      { path: 'author.name', nearest: 'author' },
      { path: 'cover.alt', nearest: 'cover' },
      { path: 'title.text', nearest: 'title' },
      { path: 'tags[0].x', nearest: 'tags[0]' },
    ])
  })

  it('flags an inline group spelled as a key, and an index where a key goes or the reverse', () => {
    expect(inexact('seo.metaTitle', 'banner.items.text', 'title[0]')).toEqual([
      { path: 'seo.metaTitle' },
      { path: 'banner.items.text', nearest: 'banner.items' },
      { path: 'title[0]', nearest: 'title' },
    ])
  })

  it('flags a field of another template than the block at that index', () => {
    expect(inexact('sections[0].posts', 'sections[1].headline')).toEqual([
      { path: 'sections[0].posts', nearest: 'sections[0]' },
      { path: 'sections[1].headline', nearest: 'sections[1]' },
    ])
  })

  it('takes any path below a block item the draft does not have yet', () => {
    expect(inexact('sections[7].headline', 'sections[7].anything.0')).toEqual([])
  })

  it('normalizes and reports each path once', () => {
    expect(inexact('subtitle', 'sections.0.nope', 'sections[0].nope')).toEqual([
      { path: 'subtitle' },
      { path: 'sections[0].nope', nearest: 'sections[0]' },
    ])
  })

  it('flags an empty path, which names nothing', () => {
    expect(inexact('')).toEqual([{ path: '' }])
  })
})
