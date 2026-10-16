import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import { fieldBreadcrumb } from './field-breadcrumb'

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'blocks',
    type: 'block',
    label: 'Page sections',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [
          { name: 'heading', type: 'string', label: 'Heading' },
          { name: 'image', type: 'image', label: 'Background' },
        ],
      },
      { name: 'cta', fields: [{ name: 'href', type: 'string' }] },
    ],
  },
  {
    type: 'group',
    name: 'seo',
    label: 'SEO',
    fields: [
      {
        name: 'meta',
        type: 'object',
        label: 'Meta',
        fields: [{ name: 'summary', type: 'string', label: 'Summary' }],
      },
    ],
  },
  {
    name: 'links',
    type: 'object',
    label: 'Links',
    list: true,
    fields: [{ name: 'label', type: 'string', label: 'Link text' }],
  },
  { name: 'tags', type: 'string', label: 'Tags', list: true },
]

const value = {
  blocks: [
    { template: 'hero', value: { heading: '' } },
    { template: 'cta', value: {} },
  ],
  links: [{ label: 'Docs' }, {}],
}

const crumb = (path: string) => fieldBreadcrumb(fields, value, path)

describe('fieldBreadcrumb', () => {
  it('names a top-level field by its label', () => {
    expect(crumb('title')).toEqual(['Title'])
  })

  it('names a block by its template label, then the field inside it', () => {
    expect(crumb('blocks[0].heading')).toEqual(['Page sections', 'Hero', 'Heading'])
  })

  it('reads the dotted spelling of an index the same way', () => {
    expect(crumb('blocks.0.heading')).toEqual(['Page sections', 'Hero', 'Heading'])
  })

  it('humanises template and field names that have no label', () => {
    expect(crumb('blocks[1].href')).toEqual(['Page sections', 'Cta', 'Href'])
  })

  it('names the parts of an image field', () => {
    expect(crumb('blocks[0].image.alt')).toEqual([
      'Page sections',
      'Hero',
      'Background',
      'Alt text',
    ])
    expect(crumb('blocks[0].image.src')).toEqual(['Page sections', 'Hero', 'Background', 'File'])
  })

  it('finds a field inside an inline group, which adds no path segment', () => {
    expect(crumb('meta.summary')).toEqual(['Meta', 'Summary'])
  })

  it('names an object-list item by its title, else by its position', () => {
    expect(crumb('links[0].label')).toEqual(['Links', 'Docs', 'Link text'])
    expect(crumb('links[1].label')).toEqual(['Links', 'Item 2', 'Link text'])
  })

  it('names a primitive list item by its position', () => {
    expect(crumb('tags[2]')).toEqual(['Tags', 'Item 3'])
  })

  it('keeps raw names for segments the schema does not know', () => {
    expect(crumb('gone.child')).toEqual(['gone', 'child'])
    expect(crumb('blocks[5].nowhere')).toEqual(['Page sections', 'Item 6', 'nowhere'])
  })

  it("finds a field of a block with no value in its templates' fields", () => {
    expect(fieldBreadcrumb(fields, undefined, 'blocks[5].heading')).toEqual([
      'Page sections',
      'Item 6',
      'Heading',
    ])
  })

  it('leaves the item crumbs out when asked, for a path whose items are gone', () => {
    const noItems = (path: string) => fieldBreadcrumb(fields, undefined, path, { items: false })
    expect(noItems('blocks[5].heading')).toEqual(['Page sections', 'Heading'])
    expect(noItems('links[3].label')).toEqual(['Links', 'Link text'])
    expect(noItems('tags[2]')).toEqual(['Tags'])
  })

  it('never reads an inherited property as an image part', () => {
    expect(crumb('blocks[0].image.constructor')).toEqual([
      'Page sections',
      'Hero',
      'Background',
      'constructor',
    ])
  })
})
