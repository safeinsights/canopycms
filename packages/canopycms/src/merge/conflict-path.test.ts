import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import { computeEntryDiff } from '../editor/entry-diff'
import { entryAsRead } from '../utils/calendar-day'
import { keyOfDataPath } from './conflict-path'

const fields: FieldConfig[] = [
  { name: 'title', type: 'string' },
  {
    name: 'seo',
    type: 'object',
    fields: [
      { name: 'description', type: 'string' },
      { name: 'image', type: 'image' },
    ],
  },
  {
    name: 'faqs',
    type: 'object',
    list: true,
    fields: [
      { name: 'question', type: 'string' },
      { name: 'answer', type: 'markdown' },
    ],
  },
  {
    name: 'sections',
    type: 'block',
    templates: [
      { name: 'hero', fields: [{ name: 'heading', type: 'string' }] },
      { name: 'quote', fields: [{ name: 'text', type: 'string' }] },
    ],
  },
  { name: 'tags', type: 'string', list: true },
]

const before = {
  title: 'One',
  seo: { description: 'Old', image: { src: '/a.png' } },
  faqs: [
    { _key: 'q1', question: 'Why?', answer: 'Because' },
    { _key: 'q2', question: 'How?', answer: 'Like so' },
  ],
  sections: [
    { _key: 'hero1', template: 'hero', value: { heading: 'Hi' } },
    { _key: 'quote1', _type: 'quote', text: 'Said' },
  ],
  tags: ['a'],
  legacy: { nested: 1 },
}
const after = {
  title: 'Two',
  seo: { description: 'New', image: { src: '/b.png' } },
  faqs: [{ _key: 'q1', question: 'Why not?', answer: 'Because' }],
  sections: [
    { _key: 'hero1', template: 'hero', value: { heading: 'Hello' } },
    { _key: 'quote1', _type: 'quote', text: 'Said so' },
  ],
  tags: ['a', 'b'],
  legacy: { nested: 2 },
}

describe('keyOfDataPath', () => {
  const side = (data: Record<string, unknown>) => ({
    format: 'json' as const,
    entryType: 'page',
    data: entryAsRead(fields, data),
  })

  it('names every place the drawer reports a change at by the drawer’s own key', () => {
    const { changes } = computeEntryDiff({ fields, before: side(before), after: side(after) })
    const located = changes.filter((c) => c.dataPath)
    expect(located.length).toBeGreaterThanOrEqual(8)
    for (const change of located) {
      const read = change.kind === 'removed' ? side(before).data : side(after).data
      expect([change.key, keyOfDataPath(fields, read, change.dataPath!)]).toEqual([
        change.key,
        change.key,
      ])
    }
  })

  it('names a field recorded without the schema as the schema names it', () => {
    expect(keyOfDataPath(fields, after, [{ field: 'title' }])).toBe('title')
    expect(keyOfDataPath(fields, after, [{ field: 'legacy' }])).toBe('?legacy')
  })

  it('names an item no longer in the list by its key', () => {
    expect(keyOfDataPath(fields, after, [{ field: 'faqs' }, { item: 'q2' }])).toBe('faqs.q2')
  })
})
