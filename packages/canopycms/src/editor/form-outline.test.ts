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
  it('has one node per top-level field, labelled or by its humanised name, with its path and no children', () => {
    expect(buildFormOutline([title, summary], {})).toEqual([
      { label: 'Title', path: 'title' },
      { label: 'Summary', path: 'summary' },
    ])
  })

  it('has nothing for a schema with no fields', () => {
    expect(buildFormOutline([], {})).toEqual([])
  })

  it('makes an inline group a node with no path that holds its fields in order', () => {
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
    const outline = buildFormOutline(fields, {})
    expect(outline).toEqual([
      { label: 'Title', path: 'title' },
      {
        label: 'Search',
        children: [
          { label: 'Meta title', path: 'metaTitle' },
          { label: 'Meta text', path: 'metaText' },
        ],
      },
      { label: 'Summary', path: 'summary' },
    ])
    expect(outline[1]).not.toHaveProperty('path')
  })

  it('names an unlabelled group by its humanised name, and nests a group inside a group', () => {
    const fields: FieldConfig[] = [
      {
        type: 'group',
        name: 'outer',
        fields: [{ type: 'group', name: 'inner', label: 'Inner', fields: [summary] }],
      },
    ]
    expect(buildFormOutline(fields, {})).toEqual([
      {
        label: 'Outer',
        children: [{ label: 'Inner', children: [{ label: 'Summary', path: 'summary' }] }],
      },
    ])
  })

  it('holds each block row as a child of its field, labelled by its template, with the first text as secondary', () => {
    const value = {
      sections: [
        { template: 'hero', value: { headline: 'Welcome', kicker: 'New' } },
        { template: 'quote', value: { text: 'To be' } },
        { template: 'hero', value: {} },
      ],
    }
    expect(buildFormOutline([blocks], value)).toEqual([
      {
        label: 'Sections',
        path: 'sections',
        children: [
          { label: 'Hero banner', secondary: 'Welcome', path: 'sections[0]' },
          { label: 'Quote', secondary: 'To be', path: 'sections[1]' },
          { label: 'Hero banner', secondary: undefined, path: 'sections[2]' },
        ],
      },
    ])
  })

  it('uses the index in each block row path, so a later row is blocks[1], not the first', () => {
    const value = {
      sections: [
        { template: 'quote', value: { text: 'a' } },
        { template: 'quote', value: { text: 'b' } },
      ],
    }
    const [node] = buildFormOutline([blocks], value)
    expect(node.children?.map((row) => row.path)).toEqual(['sections[0]', 'sections[1]'])
  })

  it('names a block of an unknown template by the template name, with no secondary', () => {
    const [node] = buildFormOutline([blocks], {
      sections: [{ template: 'retired', value: { text: 'x' } }],
    })
    expect(node.children).toEqual([{ label: 'retired', secondary: undefined, path: 'sections[0]' }])
  })

  it('calls a block row with no usable template "Unknown block"', () => {
    const [node] = buildFormOutline([blocks], {
      sections: [{ value: {} }, 'junk', null, { template: 7 }],
    })
    expect(node.children?.map((row) => row.label)).toEqual([
      'Unknown block',
      'Unknown block',
      'Unknown block',
      'Unknown block',
    ])
    expect(node.children?.map((row) => row.path)).toEqual([
      'sections[0]',
      'sections[1]',
      'sections[2]',
      'sections[3]',
    ])
  })

  it('holds each row of an object list as a child, titled by its itemTitleField, else by position', () => {
    const value = {
      team: [{ name: 'Ada', role: 'Engineer' }, { name: '', role: '' }, 'junk'],
    }
    expect(buildFormOutline([team], value)).toEqual([
      {
        label: 'Team',
        path: 'team',
        children: [
          { label: 'Ada', secondary: 'Engineer', path: 'team[0]' },
          // Nothing to title a row by: the positional heading from the field's itemLabel, 1-based.
          { label: 'Team member 2', secondary: undefined, path: 'team[1]' },
          { label: 'Team member 3', secondary: undefined, path: 'team[2]' },
        ],
      },
    ])
  })

  it('gives a list field that is not a list of objects, and a single object, no children', () => {
    const fields: FieldConfig[] = [
      { name: 'tags', type: 'string', list: true },
      { name: 'author', type: 'object', fields: [{ name: 'name', type: 'string' }] },
    ]
    expect(buildFormOutline(fields, { tags: ['a', 'b'], author: { name: 'Ada' } })).toEqual([
      { label: 'Tags', path: 'tags' },
      { label: 'Author', path: 'author' },
    ])
  })

  it('gives an object that is not a list no rows, even when its stored value is an array', () => {
    const author: FieldConfig = {
      name: 'author',
      type: 'object',
      fields: [{ name: 'name', type: 'string' }],
    }
    expect(buildFormOutline([author], { author: [{ name: 'Ada' }] })).toEqual([
      { label: 'Author', path: 'author' },
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
      { label: 'Sections', path: 'sections' },
      { label: 'Team', path: 'team' },
    ])
  })

  it('has no rows for an empty list', () => {
    const outline = buildFormOutline([blocks, team], { sections: [], team: [] })
    expect(outline).toHaveLength(2)
    expect(outline.every((node) => !node.children || node.children.length === 0)).toBe(true)
  })

  it('holds the rows of a block or list field that sits inside a group under that field', () => {
    const fields: FieldConfig[] = [{ type: 'group', name: 'g', label: 'Page', fields: [team] }]
    expect(buildFormOutline(fields, { team: [{ name: 'Ada' }] })).toEqual([
      {
        label: 'Page',
        children: [
          {
            label: 'Team',
            path: 'team',
            children: [{ label: 'Ada', secondary: undefined, path: 'team[0]' }],
          },
        ],
      },
    ])
  })

  describe('with custom renderers', () => {
    const value = {
      sections: [{ template: 'quote', value: { text: 'a' } }],
      team: [{ name: 'Ada' }],
    }

    it('lists no rows for a field type that has a custom renderer', () => {
      expect(buildFormOutline([blocks, team], value, new Set(['block']))).toEqual([
        { label: 'Sections', path: 'sections' },
        {
          label: 'Team',
          path: 'team',
          children: [{ label: 'Ada', secondary: undefined, path: 'team[0]' }],
        },
      ])
      const [, teamNode] = buildFormOutline([blocks, team], value, new Set(['block']))
      expect(teamNode.children).toHaveLength(1)
    })

    it('still lists the field itself, and rows of types without a custom renderer', () => {
      const outline = buildFormOutline([blocks, team], value, new Set(['object']))
      expect(outline[0].children).toHaveLength(1)
      expect(outline[1]).toEqual({ label: 'Team', path: 'team' })
    })

    it('ignores custom types that no field has', () => {
      expect(buildFormOutline([blocks], value, new Set(['callout']))[0].children).toHaveLength(1)
    })
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

  describe('with custom renderers', () => {
    const custom = new Set(['block'])

    it('does not count a block field whose type has a custom renderer', () => {
      expect(hasCollapsibleList([title, blocks], custom)).toBe(false)
    })

    it('still counts a block field when only another type is custom', () => {
      expect(hasCollapsibleList([title, blocks], new Set(['callout']))).toBe(true)
    })

    it('counts a list of objects when only block is custom, and the reverse', () => {
      expect(hasCollapsibleList([blocks, team], custom)).toBe(true)
      expect(hasCollapsibleList([blocks, team], new Set(['object']))).toBe(true)
      expect(hasCollapsibleList([team], new Set(['object']))).toBe(false)
    })

    it('does not count a custom block inside a group or an object', () => {
      expect(hasCollapsibleList([{ type: 'group', name: 'g', fields: [blocks] }], custom)).toBe(
        false,
      )
      expect(hasCollapsibleList([{ name: 'wrap', type: 'object', fields: [blocks] }], custom)).toBe(
        false,
      )
    })
  })
})
