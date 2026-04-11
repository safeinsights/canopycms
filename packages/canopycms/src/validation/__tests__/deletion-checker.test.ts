import { describe, it, expect, vi } from 'vitest'
import { DeletionChecker } from '../deletion-checker'
import type { ContentStore } from '../../content-store'
import type { ContentIdIndex } from '../../content-id-index'
import type { FieldConfig } from '../../config'
import { unsafeAsLogicalPath, unsafeAsSlug, unsafeAsPhysicalPath } from '../../paths/test-utils'

// Minimal mocks — only what DeletionChecker actually uses

function makeMocks(docsBySlug: Record<string, Record<string, unknown>>) {
  const store = {
    read: vi.fn(async (_col: unknown, slug: string) => ({
      data: docsBySlug[slug] ?? {},
    })),
  } as unknown as ContentStore

  const idIndex = {
    getAllLocations: vi.fn(() =>
      Object.keys(docsBySlug).map((slug) => ({
        type: 'entry' as const,
        collection: unsafeAsLogicalPath('posts'),
        slug: unsafeAsSlug(slug),
        relativePath: unsafeAsPhysicalPath(`content/posts/${slug}.json`),
      })),
    ),
    findByPath: vi.fn(() => 'some-id'),
  } as unknown as ContentIdIndex

  return { store, idIndex }
}

function makeChecker(schema: FieldConfig[], docsBySlug: Record<string, Record<string, unknown>>) {
  const { store, idIndex } = makeMocks(docsBySlug)
  const collections = new Map([[unsafeAsLogicalPath('posts'), { fields: schema }]])
  return new DeletionChecker(store, idIndex, collections)
}

const TARGET_ID = 'target123'

describe('DeletionChecker.findIdInData', () => {
  it('finds a reference in a top-level reference field', async () => {
    const schema: FieldConfig[] = [
      { name: 'author', type: 'reference', label: 'Author', collections: ['authors'] },
    ]
    const checker = makeChecker(schema, { post1: { author: TARGET_ID } })
    const result = await checker.canDelete(TARGET_ID)
    expect(result.canDelete).toBe(false)
    expect(result.referencedBy[0].fields).toContain('author')
  })

  it('finds a reference inside a nested object field', async () => {
    const schema: FieldConfig[] = [
      {
        name: 'meta',
        type: 'object',
        label: 'Meta',
        fields: [
          { name: 'reviewer', type: 'reference', label: 'Reviewer', collections: ['users'] },
        ],
      },
    ]
    const checker = makeChecker(schema, { post1: { meta: { reviewer: TARGET_ID } } })
    const result = await checker.canDelete(TARGET_ID)
    expect(result.canDelete).toBe(false)
    expect(result.referencedBy[0].fields).toContain('meta.reviewer')
  })

  it('finds a reference inside a list:true object field (regression for missed bug)', async () => {
    // This is the bug that was fixed in April 2026: DeletionChecker.findIdInData had
    // !Array.isArray(value) guard for object fields, so list:true objects (arrays of objects)
    // were silently skipped. References inside e.g. an "authors" list were never found,
    // allowing deletion of a referenced entry.
    const schema: FieldConfig[] = [
      {
        name: 'authors',
        type: 'object',
        label: 'Authors',
        list: true,
        fields: [
          { name: 'profile', type: 'reference', label: 'Profile', collections: ['profiles'] },
        ],
      },
    ]
    const checker = makeChecker(schema, {
      post1: {
        authors: [
          { profile: 'other-id' },
          { profile: TARGET_ID }, // ← this reference should block deletion
        ],
      },
    })
    const result = await checker.canDelete(TARGET_ID)
    expect(result.canDelete).toBe(false)
    expect(result.referencedBy[0].fields).toContain('authors[1].profile')
  })

  it('returns canDelete:true when no references exist', async () => {
    const schema: FieldConfig[] = [
      { name: 'author', type: 'reference', label: 'Author', collections: ['authors'] },
    ]
    const checker = makeChecker(schema, { post1: { author: 'different-id' } })
    const result = await checker.canDelete(TARGET_ID)
    expect(result.canDelete).toBe(true)
    expect(result.referencedBy).toHaveLength(0)
  })

  it('finds a reference inside a block field', async () => {
    const schema: FieldConfig[] = [
      {
        name: 'content',
        type: 'block',
        label: 'Content',
        templates: [
          {
            name: 'callout',
            label: 'Callout',
            fields: [{ name: 'link', type: 'reference', label: 'Link', collections: ['pages'] }],
          },
        ],
      },
    ]
    const checker = makeChecker(schema, {
      post1: { content: [{ _type: 'callout', link: TARGET_ID }] },
    })
    const result = await checker.canDelete(TARGET_ID)
    expect(result.canDelete).toBe(false)
    expect(result.referencedBy[0].fields).toContain('content[0].link')
  })
})
