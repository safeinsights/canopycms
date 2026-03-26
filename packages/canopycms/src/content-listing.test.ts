import { describe, it, expect } from 'vitest'

import type { ContentId } from './paths/types'

import { sortByOrder, parseTypedFilename } from './content-listing'
import type { EntryTypeConfig } from './config'

// ---------------------------------------------------------------------------
// sortByOrder
// ---------------------------------------------------------------------------

describe('sortByOrder', () => {
  type Item = { contentId?: ContentId; name: string }
  const fallback = (item: Item) => item.name

  const item = (name: string, id?: string): Item => ({
    name,
    contentId: id as ContentId | undefined,
  })

  it('sorts alphabetically by fallback key when order is undefined', () => {
    const items = [item('cherry'), item('apple'), item('banana')]
    const result = sortByOrder(items, undefined, fallback)
    expect(result.map((i) => i.name)).toEqual(['apple', 'banana', 'cherry'])
  })

  it('sorts alphabetically by fallback key when order is empty', () => {
    const items = [item('cherry'), item('apple'), item('banana')]
    const result = sortByOrder(items, [], fallback)
    expect(result.map((i) => i.name)).toEqual(['apple', 'banana', 'cherry'])
  })

  it('sorts items by order array position', () => {
    const items = [item('c', 'id3'), item('a', 'id1'), item('b', 'id2')]
    const result = sortByOrder(items, ['id2', 'id1', 'id3'], fallback)
    expect(result.map((i) => i.name)).toEqual(['b', 'a', 'c'])
  })

  it('puts ordered items before unordered items', () => {
    const items = [
      item('unordered-b', 'id-x'),
      item('ordered', 'id-1'),
      item('unordered-a', 'id-y'),
    ]
    const result = sortByOrder(items, ['id-1'], fallback)
    expect(result.map((i) => i.name)).toEqual(['ordered', 'unordered-a', 'unordered-b'])
  })

  it('sorts unordered items alphabetically by fallback key', () => {
    const items = [
      item('delta', 'id-d'),
      item('alpha', 'id-a'),
      item('gamma', 'id-g'),
      item('beta', 'id-b'),
    ]
    // Only beta is in the order array
    const result = sortByOrder(items, ['id-b'], fallback)
    expect(result.map((i) => i.name)).toEqual(['beta', 'alpha', 'delta', 'gamma'])
  })

  it('handles items without contentId as unordered', () => {
    const items = [item('no-id'), item('has-id', 'id-1'), item('also-no-id')]
    const result = sortByOrder(items, ['id-1'], fallback)
    expect(result[0].name).toBe('has-id')
    // Remaining sorted alphabetically
    expect(result.slice(1).map((i) => i.name)).toEqual(['also-no-id', 'no-id'])
  })

  it('handles order array referencing nonexistent IDs gracefully', () => {
    const items = [item('b', 'id-b'), item('a', 'id-a')]
    // 'id-missing' doesn't match any item — should be ignored
    const result = sortByOrder(items, ['id-missing', 'id-a', 'id-b'], fallback)
    expect(result.map((i) => i.name)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// parseTypedFilename
// ---------------------------------------------------------------------------

describe('parseTypedFilename', () => {
  const entryTypes: EntryTypeConfig[] = [
    { name: 'post', format: 'md', schema: { fields: {} } },
    { name: 'doc', format: 'mdx', schema: { fields: {} } },
    { name: 'page', format: 'json', schema: { fields: {} } },
  ]

  it('parses a valid typed filename', () => {
    const result = parseTypedFilename('post.hello-world.vh2WdhwAFiSL.md', entryTypes)
    expect(result).toEqual({
      type: 'post',
      slug: 'hello-world',
      id: 'vh2WdhwAFiSL',
    })
  })

  it('handles slugs with dots', () => {
    const result = parseTypedFilename('doc.getting.started.guide.aB3cD4eF5gH6.mdx', entryTypes)
    expect(result).toEqual({
      type: 'doc',
      slug: 'getting.started.guide',
      id: 'aB3cD4eF5gH6',
    })
  })

  it('returns null for unknown entry type', () => {
    const result = parseTypedFilename('unknown.slug.vh2WdhwAFiSL.md', entryTypes)
    expect(result).toBeNull()
  })

  it('returns null for too few parts', () => {
    const result = parseTypedFilename('post.md', entryTypes)
    expect(result).toBeNull()
  })

  it('returns null for no extension', () => {
    const result = parseTypedFilename('post.slug.vh2WdhwAFiSL', entryTypes)
    expect(result).toBeNull()
  })

  it('returns null for invalid content ID', () => {
    const result = parseTypedFilename('post.slug.INVALID!!!.md', entryTypes)
    expect(result).toBeNull()
  })
})
