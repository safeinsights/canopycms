import { describe, it, expect } from 'vitest'
import { collectReferenceIds } from '../field-traversal'
import type { FieldConfig } from '../../config'

const ref = (name: string, list = false): FieldConfig => ({
  name,
  type: 'reference',
  label: name,
  collections: ['people'],
  ...(list ? { list: true } : {}),
})

describe('collectReferenceIds', () => {
  it('reports a single reference at its field path', () => {
    expect(collectReferenceIds([ref('author')], { author: 'aaaaaaaaaaaa' })).toEqual([
      { id: 'aaaaaaaaaaaa', path: 'author' },
    ])
  })

  it('reports each element of a list reference at its index, duplicates included', () => {
    const data = { related: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'aaaaaaaaaaaa'] }
    expect(collectReferenceIds([ref('related', true)], data)).toEqual([
      { id: 'aaaaaaaaaaaa', path: 'related[0]' },
      { id: 'bbbbbbbbbbbb', path: 'related[1]' },
      { id: 'aaaaaaaaaaaa', path: 'related[2]' },
    ])
  })

  it('reads the id of a resolved value and of an unavailable one', () => {
    const data = {
      author: { id: 'aaaaaaaaaaaa', slug: 'alice', title: 'Alice' },
      related: [
        { id: 'bbbbbbbbbbbb', title: 'Hidden', unavailable: true, reason: 'restricted' },
        'cccccccccccc',
      ],
    }
    expect(collectReferenceIds([ref('author'), ref('related', true)], data)).toEqual([
      { id: 'aaaaaaaaaaaa', path: 'author' },
      { id: 'bbbbbbbbbbbb', path: 'related[0]' },
      { id: 'cccccccccccc', path: 'related[1]' },
    ])
  })

  it("skips '', null, undefined, values with no id, and an object whose id is empty", () => {
    const schema = [ref('a'), ref('b'), ref('c'), ref('d'), ref('e'), ref('list', true)]
    const data = {
      a: '',
      b: null,
      d: { slug: 'no-id' },
      e: { id: '' },
      list: ['', null, 7, { title: 'no id' }, 'bbbbbbbbbbbb'],
    }
    expect(collectReferenceIds(schema, data)).toEqual([{ id: 'bbbbbbbbbbbb', path: 'list[4]' }])
  })

  it("walks groups, objects, object lists and blocks in traverseFields' path format", () => {
    const schema: FieldConfig[] = [
      { name: 'byline', type: 'group', label: 'Byline', fields: [ref('author')] },
      { name: 'meta', type: 'object', label: 'Meta', fields: [ref('reviewer')] },
      {
        name: 'credits',
        type: 'object',
        label: 'Credits',
        list: true,
        fields: [ref('person')],
      },
      {
        name: 'blocks',
        type: 'block',
        label: 'Blocks',
        templates: [{ name: 'quote', label: 'Quote', fields: [ref('speakers', true)] }],
      },
    ]
    const data = {
      author: 'aaaaaaaaaaaa',
      meta: { reviewer: 'bbbbbbbbbbbb' },
      credits: [{ person: 'cccccccccccc' }, { person: 'dddddddddddd' }],
      blocks: [
        { template: 'quote', value: { speakers: ['eeeeeeeeeeee'] } },
        { _type: 'quote', speakers: ['ffffffffffff'] },
      ],
    }
    expect(collectReferenceIds(schema, data)).toEqual([
      { id: 'aaaaaaaaaaaa', path: 'author' },
      { id: 'bbbbbbbbbbbb', path: 'meta.reviewer' },
      { id: 'cccccccccccc', path: 'credits[0].person' },
      { id: 'dddddddddddd', path: 'credits[1].person' },
      { id: 'eeeeeeeeeeee', path: 'blocks[0].speakers[0]' },
      { id: 'ffffffffffff', path: 'blocks[1].speakers[0]' },
    ])
  })

  it('ignores ids sitting in fields that are not reference fields', () => {
    const schema: FieldConfig[] = [{ name: 'note', type: 'string', label: 'Note' }]
    expect(collectReferenceIds(schema, { note: 'aaaaaaaaaaaa' })).toEqual([])
  })
})
