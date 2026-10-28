import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import type { EntryChangeSide } from '../api/branch-entry-changes'
import { withItemKeys } from '../item-keys'
import {
  computeEntryDiff,
  textDiff,
  type DiffPart,
  type EntryChange,
  type TextDiff,
} from './entry-diff'

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'publishedAt', type: 'datetime' },
  { name: 'featured', type: 'boolean' },
  { name: 'author', type: 'reference', label: 'Author' },
  { name: 'cover', type: 'image' },
  {
    name: 'status',
    type: 'select',
    options: [
      { label: 'Draft copy', value: 'draft' },
      { label: 'Ready to go', value: 'ready' },
    ],
  },
  {
    name: 'seo',
    type: 'object',
    label: 'SEO',
    fields: [{ name: 'metaTitle', type: 'string', label: 'Meta title' }],
  },
  {
    name: 'blocks',
    type: 'block',
    label: 'Page sections',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [{ name: 'heading', type: 'string', label: 'Heading' }],
      },
      {
        name: 'faq',
        label: 'FAQ',
        fields: [
          {
            name: 'questions',
            type: 'object',
            list: true,
            label: 'Questions',
            itemLabel: 'question',
            fields: [
              { name: 'question', type: 'string', label: 'Question' },
              { name: 'answer', type: 'markdown', label: 'Answer' },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'team',
    type: 'object',
    list: true,
    label: 'Team',
    fields: [{ name: 'name', type: 'string', label: 'Name' }],
  },
  { name: 'content', type: 'markdown', label: 'Body', isBody: true },
]

/** A side as the server answers it: keyed by content, as ContentStore.read keys it. */
const side = (data: Record<string, unknown>, body?: string): EntryChangeSide => ({
  format: body === undefined ? 'json' : 'md',
  entryType: 'page',
  data: withItemKeys(fields, data, 'content'),
  ...(body !== undefined && { body }),
})

const base = {
  title: 'Hello',
  blocks: [
    { template: 'hero', value: { heading: 'Welcome' } },
    {
      template: 'faq',
      value: {
        questions: [
          { question: 'Why?', answer: 'Because.' },
          { question: 'How?', answer: 'Carefully.' },
        ],
      },
    },
  ],
  team: [{ name: 'Ada' }, { name: 'Grace' }, { name: 'Linus' }],
}

/** `after` from the keyed `before`, as a save keeps the keys the form read. */
const edit = (before: EntryChangeSide, change: (data: Record<string, unknown>) => void) => {
  const data = structuredClone(before.data)
  change(data)
  return { ...before, data }
}

const summary = (changes: EntryChange[]) => changes.map((c) => [c.kind, c.path.join(' › ')])

describe('computeEntryDiff', () => {
  it('names a change inside a nested block by its labels, item titles included', () => {
    const before = side(base)
    const after = edit(before, (data) => {
      const faq = (data.blocks as Array<{ value: { questions: Array<{ answer: string }> } }>)[1]
      faq.value.questions[1].answer = 'Very carefully.'
    })
    const { changes, formattingOnly } = computeEntryDiff({ fields, before, after })
    expect(formattingOnly).toBe(false)
    expect(summary(changes)).toEqual([
      ['changed', 'Page sections › FAQ › Questions › How? › Answer'],
    ])
    expect(changes[0]).toMatchObject({
      before: { kind: 'text', text: 'Carefully.', long: true },
      after: { kind: 'text', text: 'Very carefully.', long: true },
      text: { mode: 'lines' },
    })
  })

  it('reads a reordered list as one item moved, not as removed and added', () => {
    const before = side(base)
    const after = edit(before, (data) => {
      const team = data.team as unknown[]
      data.team = [team[2], team[0], team[1]]
    })
    const { changes } = computeEntryDiff({ fields, before, after })
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'moved',
        path: ['Team', 'Linus'],
        before: { kind: 'position', position: 3 },
        after: { kind: 'position', position: 1 },
      }),
    ])
  })

  it('reads reordered blocks as moved, and an edit to a moved block as its own change', () => {
    const before = side(base)
    const after = edit(before, (data) => {
      const blocks = data.blocks as Array<{ value: Record<string, unknown> }>
      blocks[0].value.heading = 'Welcome back'
      data.blocks = [blocks[1], blocks[0]]
    })
    expect(summary(computeEntryDiff({ fields, before, after }).changes)).toEqual([
      ['moved', 'Page sections › Hero: Welcome back'],
      ['changed', 'Page sections › Hero: Welcome back › Heading'],
    ])
  })

  it('lists an item added to and one removed from a list, with its fields', () => {
    const before = side(base)
    const after = edit(before, (data) => {
      const team = data.team as unknown[]
      data.team = [team[0], team[2], { name: 'Barbara', _key: 'newKey12345' }]
    })
    const { changes } = computeEntryDiff({ fields, before, after })
    expect(summary(changes)).toEqual([
      ['added', 'Team › Barbara'],
      ['removed', 'Team › Grace'],
    ])
    expect(changes[0].after).toEqual({
      kind: 'fields',
      fields: [{ label: 'Name', value: { kind: 'text', text: 'Barbara' } }],
    })
    expect(changes[1].before).toMatchObject({ kind: 'fields' })
  })

  it('shows a reference by its target’s title, and an id it can’t name as unknown', () => {
    const titles: Record<string, string> = { aaaaaaaaaaaa: 'Ada Lovelace' }
    const before = side({ ...base, author: 'aaaaaaaaaaaa' })
    const after = side({ ...base, author: 'bbbbbbbbbbbb' })
    const { changes } = computeEntryDiff({
      fields,
      before,
      after,
      referenceTitle: (id) => titles[id],
    })
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'changed',
        path: ['Author'],
        before: { kind: 'reference', id: 'aaaaaaaaaaaa', title: 'Ada Lovelace' },
        after: { kind: 'reference', id: 'bbbbbbbbbbbb' },
      }),
    ])
    expect(changes[0].text).toBeUndefined()
  })

  it('diffs a markdown body by line, marking words inside a changed line, and skips unchanged runs', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`)
    const changed = [...lines]
    changed[6] = 'Line 7, rewritten'
    const before = side({ title: 'Hello' }, `${lines.join('\n')}\n`)
    const after = side({ title: 'Hello' }, `${changed.join('\n')}\n`)
    const { changes } = computeEntryDiff({ fields, before, after })
    expect(summary(changes)).toEqual([['changed', 'Body']])
    const text = changes[0].text
    expect(text?.mode).toBe('lines')
    if (text?.mode !== 'lines') return
    expect(text.lines).toEqual([
      { kind: 'skipped', count: 4 },
      { kind: 'same', text: 'Line 5' },
      { kind: 'same', text: 'Line 6' },
      { kind: 'removed', parts: [{ value: 'Line 7' }] },
      {
        kind: 'added',
        parts: [{ value: 'Line 7' }, { value: ', rewritten', added: true }],
      },
      { kind: 'same', text: 'Line 8' },
      { kind: 'same', text: 'Line 9' },
      { kind: 'skipped', count: 3 },
    ])
  })

  it('files fields the schema doesn’t describe under "Other fields", humanised', () => {
    const before = side({ ...base, legacyNote: 'old' })
    const after = side({ ...base, legacyNote: 'new', extraFlag: true })
    expect(summary(computeEntryDiff({ fields, before, after }).changes)).toEqual([
      ['changed', 'Other fields › Legacy note'],
      ['added', 'Other fields › Extra flag'],
    ])
  })

  it('returns no changes and formattingOnly when the values are equal', () => {
    const before = side({ ...base, seo: { metaTitle: '' } })
    const after = side({ ...base, publishedAt: '' })
    expect(computeEntryDiff({ fields, before, after })).toEqual({
      changes: [],
      formattingOnly: true,
    })
  })

  it('lists a new entry’s values as added and a deleted one’s as removed', () => {
    const entry = side({ title: 'Fresh', featured: false, seo: { metaTitle: 'Fresh!' } })
    expect(summary(computeEntryDiff({ fields, before: null, after: entry }).changes)).toEqual([
      ['added', 'Title'],
      ['added', 'Featured'],
      ['added', 'SEO › Meta title'],
    ])
    const deleted = computeEntryDiff({ fields, before: entry, after: null })
    expect(deleted.formattingOnly).toBe(false)
    expect(deleted.changes.map((c) => c.kind)).toEqual(['removed', 'removed', 'removed'])
  })

  it('formats booleans, numbers, dates, selects and images as values', () => {
    const before = side({
      featured: false,
      publishedAt: '2026-01-02',
      status: 'draft',
      cover: { src: '/assets/a/old%20photo.jpg', alt: 'Old' },
    })
    const after = side({
      featured: true,
      publishedAt: '2026-02-03T10:00:00.000Z',
      status: 'ready',
      cover: { src: '/assets/b/new.png?w=100', alt: '' },
    })
    const byPath = Object.fromEntries(
      computeEntryDiff({ fields, before, after }).changes.map((c) => [c.path.join(' › '), c]),
    )
    expect(byPath['Featured']).toMatchObject({
      before: { kind: 'boolean', value: false },
      after: { kind: 'boolean', value: true },
    })
    expect(byPath['Published at']).toMatchObject({
      before: { kind: 'date', iso: '2026-01-02', dateOnly: true },
      after: { kind: 'date', iso: '2026-02-03T10:00:00.000Z' },
    })
    expect(byPath['Status']).toMatchObject({
      before: { kind: 'select', label: 'Draft copy' },
      after: { kind: 'select', label: 'Ready to go' },
    })
    expect(byPath['Cover']).toMatchObject({
      before: { kind: 'image', name: 'old photo.jpg', alt: 'Old' },
      after: { kind: 'image', name: 'new.png' },
    })
  })
})

describe('textDiff', () => {
  it('diffs a short value by word', () => {
    expect(textDiff('Hello world', 'Hello there world')).toEqual({
      mode: 'words',
      parts: [{ value: 'Hello ' }, { value: 'there ', added: true }, { value: 'world' }],
    })
  })

  it('reads each side back from its parts exactly, spacing included', () => {
    const own = (parts: DiffPart[], keep: 'before' | 'after') =>
      parts
        .filter((p) => (keep === 'before' ? !p.added : !p.removed))
        .map((p) => p.value)
        .join('')
    const side = (diff: TextDiff, keep: 'before' | 'after'): string =>
      diff.mode === 'words'
        ? own(diff.parts, keep)
        : diff.lines
            .flatMap((line) =>
              line.kind === 'same'
                ? [line.text]
                : line.kind === 'skipped' || (line.kind === 'removed') !== (keep === 'before')
                  ? []
                  : [own(line.parts, keep)],
            )
            .join('\n')
    const pairs: Array<[string, string]> = [
      ['To a branch.', 'To a branch of their own.'],
      ['Nothing  reaches the site', 'Nothing reaches your site '],
      ['one\ntwo  three', 'one\ntwo three\nfour'],
    ]
    for (const [before, after] of pairs) {
      const diff = textDiff(before, after)
      expect(side(diff, 'before')).toBe(before)
      expect(side(diff, 'after')).toBe(after)
    }
  })
})
