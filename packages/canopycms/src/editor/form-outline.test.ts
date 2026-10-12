import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import { buildFormOutline, hasCollapsibleList } from './form-outline'

const title: FieldConfig = { name: 'title', type: 'string', label: 'Title' }
const summary: FieldConfig = { name: 'summary', type: 'string' }

const hero = {
  name: 'hero',
  label: 'Hero banner',
  fields: [
    { name: 'headline', type: 'string' },
    { name: 'kicker', type: 'string' },
  ] satisfies FieldConfig[],
}
const quote = { name: 'quote', fields: [{ name: 'text', type: 'string' }] satisfies FieldConfig[] }

const blocks: FieldConfig = {
  name: 'sections',
  type: 'block',
  label: 'Sections',
  templates: [hero, quote],
}

const team: FieldConfig = {
  name: 'team',
  type: 'object',
  label: 'Team',
  list: true,
  itemLabel: 'team member',
  itemTitleField: 'name',
  fields: [
    { name: 'name', type: 'string' },
    { name: 'role', type: 'string' },
  ],
}

describe('buildFormOutline', () => {
  it('lists each top-level field, labelled or by name, with its path, at depth 0', () => {
    expect(buildFormOutline([title, summary], {})).toEqual([
      { label: 'Title', path: 'title', depth: 0 },
      { label: 'summary', path: 'summary', depth: 0 },
    ])
  })

  it('has nothing for a schema with no fields', () => {
    expect(buildFormOutline([], {})).toEqual([])
  })

  it('makes an inline group a heading with no path, followed by its fields in order', () => {
    const fields: FieldConfig[] = [
      title,
      {
        type: 'group',
        name: 'seo',
        label: 'Search',
        fields: [
          { name: 'metaTitle', type: 'string', label: 'Meta title' },
          { name: 'metaText', type: 'string' },
        ],
      },
      summary,
    ]
    expect(buildFormOutline(fields, {})).toEqual([
      { label: 'Title', path: 'title', depth: 0 },
      { label: 'Search', depth: 0 },
      { label: 'Meta title', path: 'metaTitle', depth: 0 },
      { label: 'metaText', path: 'metaText', depth: 0 },
      { label: 'summary', path: 'summary', depth: 0 },
    ])
    expect(buildFormOutline(fields, {})[1]).not.toHaveProperty('path')
  })

  it('names an unlabelled group by its name, and flattens a group inside a group', () => {
    const fields: FieldConfig[] = [
      {
        type: 'group',
        name: 'outer',
        fields: [{ type: 'group', name: 'inner', label: 'Inner', fields: [summary] }],
      },
    ]
    expect(buildFormOutline(fields, {})).toEqual([
      { label: 'outer', depth: 0 },
      { label: 'Inner', depth: 0 },
      { label: 'summary', path: 'summary', depth: 0 },
    ])
  })

  it('puts each block row one level down, labelled by its template, with the first text as secondary', () => {
    const value = {
      sections: [
        { template: 'hero', value: { headline: 'Welcome', kicker: 'New' } },
        { template: 'quote', value: { text: 'To be' } },
        { template: 'hero', value: {} },
      ],
    }
    expect(buildFormOutline([blocks], value)).toEqual([
      { label: 'Sections', path: 'sections', depth: 0 },
      { label: 'Hero banner', secondary: 'Welcome', path: 'sections[0]', depth: 1 },
      { label: 'quote', secondary: 'To be', path: 'sections[1]', depth: 1 },
      { label: 'Hero banner', secondary: undefined, path: 'sections[2]', depth: 1 },
    ])
  })

  it('uses the index in each block row path, so a later row is blocks[1], not the first', () => {
    const value = {
      sections: [
        { template: 'quote', value: { text: 'a' } },
        { template: 'quote', value: { text: 'b' } },
      ],
    }
    expect(buildFormOutline([blocks], value).map((item) => item.path)).toEqual([
      'sections',
      'sections[0]',
      'sections[1]',
    ])
  })

  it('names a block of an unknown template by the template name, with no secondary', () => {
    const items = buildFormOutline([blocks], {
      sections: [{ template: 'retired', value: { text: 'x' } }],
    })
    expect(items[1]).toEqual({
      label: 'retired',
      secondary: undefined,
      path: 'sections[0]',
      depth: 1,
    })
  })

  it('calls a block row with no usable template "Unknown block"', () => {
    const items = buildFormOutline([blocks], {
      sections: [{ value: {} }, 'junk', null, { template: 7 }],
    })
    expect(items.slice(1).map((item) => item.label)).toEqual([
      'Unknown block',
      'Unknown block',
      'Unknown block',
      'Unknown block',
    ])
    expect(items.slice(1).map((item) => item.path)).toEqual([
      'sections[0]',
      'sections[1]',
      'sections[2]',
      'sections[3]',
    ])
  })

  it('puts each row of an object list one level down, titled by its itemTitleField, else by position', () => {
    const value = {
      team: [{ name: 'Ada', role: 'Engineer' }, { name: '', role: '' }, 'junk'],
    }
    expect(buildFormOutline([team], value)).toEqual([
      { label: 'Team', path: 'team', depth: 0 },
      { label: 'Ada', secondary: 'Engineer', path: 'team[0]', depth: 1 },
      // Nothing to title a row by: the positional heading from the field's itemLabel, 1-based.
      { label: 'Team member 2', secondary: undefined, path: 'team[1]', depth: 1 },
      { label: 'Team member 3', secondary: undefined, path: 'team[2]', depth: 1 },
    ])
  })

  it('lists a list field that is not a list of objects, and a single object, without rows', () => {
    const fields: FieldConfig[] = [
      { name: 'tags', type: 'string', list: true },
      { name: 'author', type: 'object', fields: [{ name: 'name', type: 'string' }] },
    ]
    expect(buildFormOutline(fields, { tags: ['a', 'b'], author: { name: 'Ada' } })).toEqual([
      { label: 'tags', path: 'tags', depth: 0 },
      { label: 'author', path: 'author', depth: 0 },
    ])
  })

  it('gives an object that is not a list no rows, even when its stored value is an array', () => {
    const author: FieldConfig = {
      name: 'author',
      type: 'object',
      fields: [{ name: 'name', type: 'string' }],
    }
    expect(buildFormOutline([author], { author: [{ name: 'Ada' }] })).toEqual([
      { label: 'author', path: 'author', depth: 0 },
    ])
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'sections'],
    ['an object', { template: 'hero' }],
  ])('has no rows for a block or list field whose value is %s', (_name, stored) => {
    const value = { sections: stored, team: stored }
    expect(buildFormOutline([blocks, team], value)).toEqual([
      { label: 'Sections', path: 'sections', depth: 0 },
      { label: 'Team', path: 'team', depth: 0 },
    ])
  })

  it('has no rows for an empty list', () => {
    expect(buildFormOutline([blocks, team], { sections: [], team: [] })).toHaveLength(2)
  })

  it('lists the rows of a block or list field that sits inside a group', () => {
    const fields: FieldConfig[] = [{ type: 'group', name: 'g', label: 'Page', fields: [team] }]
    expect(buildFormOutline(fields, { team: [{ name: 'Ada' }] }).map((i) => i.path)).toEqual([
      undefined,
      'team',
      'team[0]',
    ])
  })
})

describe('hasCollapsibleList', () => {
  it('is true for a block field', () => {
    expect(hasCollapsibleList([title, blocks])).toBe(true)
  })

  it('is true for a list of objects', () => {
    expect(hasCollapsibleList([title, team])).toBe(true)
  })

  it('is false for a schema of plain fields, lists of primitives and a single object', () => {
    expect(
      hasCollapsibleList([
        title,
        { name: 'tags', type: 'string', list: true },
        { name: 'sizes', type: 'number', list: true },
        { name: 'author', type: 'object', fields: [summary] },
      ]),
    ).toBe(false)
  })

  it('is false for no fields', () => {
    expect(hasCollapsibleList([])).toBe(false)
  })

  it('finds a list inside an inline group, however deep', () => {
    expect(
      hasCollapsibleList([
        { type: 'group', name: 'a', fields: [{ type: 'group', name: 'b', fields: [team] }] },
      ]),
    ).toBe(true)
    expect(hasCollapsibleList([{ type: 'group', name: 'a', fields: [title, summary] }])).toBe(false)
  })

  it('finds a block or list inside a single object', () => {
    expect(hasCollapsibleList([{ name: 'wrap', type: 'object', fields: [title, blocks] }])).toBe(
      true,
    )
    expect(
      hasCollapsibleList([
        {
          name: 'wrap',
          type: 'object',
          fields: [{ name: 'inner', type: 'object', fields: [team] }],
        },
      ]),
    ).toBe(true)
  })
})
