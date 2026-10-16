import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import type { CommentThread } from '../comment-store'
import {
  openThreadsWithin,
  removalAnchors,
  restoredFieldPath,
  restoreRemoval,
  type FieldRemoval,
} from './undo-removal'

const fields: FieldConfig[] = [
  { name: 'title', type: 'string' },
  {
    name: 'links',
    type: 'object',
    list: true,
    fields: [{ name: 'href', type: 'string' }],
  },
  {
    name: 'meta',
    type: 'group',
    fields: [{ name: 'hero', type: 'image' }],
  },
  {
    name: 'seo',
    type: 'object',
    fields: [
      { name: 'summary', type: 'string' },
      {
        name: 'card',
        type: 'object',
        fields: [{ name: 'caption', type: 'string' }],
      },
    ],
  },
  {
    name: 'blocks',
    type: 'block',
    templates: [
      {
        name: 'gallery',
        label: 'Gallery',
        fields: [
          {
            name: 'items',
            type: 'object',
            list: true,
            fields: [{ name: 'caption', type: 'string' }],
          },
        ],
      },
      { name: 'hero', label: 'Hero', fields: [{ name: 'heading', type: 'string' }] },
    ],
  },
]

describe('restoreRemoval', () => {
  it('puts a list item back at its index, as the same object', () => {
    const removed = { href: '/b' }
    const value = { links: [{ href: '/a' }, { href: '/c' }] }
    const restored = restoreRemoval(fields, value, {
      kind: 'list-item',
      listPath: ['links'],
      index: 1,
      item: removed,
      label: '/b',
    })
    expect(restored?.links).toEqual([{ href: '/a' }, { href: '/b' }, { href: '/c' }])
    expect((restored?.links as unknown[])[1]).toBe(removed)
  })

  it('keeps edits made after the removal, because it changes only the one list', () => {
    const atRemoval = { title: 'Old', links: [{ href: '/a' }] }
    const editedSince = { ...atRemoval, title: 'Edited after the removal' }
    const restored = restoreRemoval(fields, editedSince, {
      kind: 'list-item',
      listPath: ['links'],
      index: 0,
      item: { href: '/z' },
      label: '/z',
    })
    expect(restored).toEqual({
      title: 'Edited after the removal',
      links: [{ href: '/z' }, { href: '/a' }],
    })
  })

  it('appends when the list has since shrunk below the removed index', () => {
    const restored = restoreRemoval(
      fields,
      { links: [] },
      { kind: 'list-item', listPath: ['links'], index: 3, item: { href: '/x' }, label: '/x' },
    )
    expect(restored?.links).toEqual([{ href: '/x' }])
  })

  it('restores a whole block into the block list', () => {
    const block = { template: 'hero', value: { heading: 'Hi' } }
    const restored = restoreRemoval(
      fields,
      { blocks: [] },
      { kind: 'list-item', listPath: ['blocks'], index: 0, item: block, label: 'Hero' },
    )
    expect(restored?.blocks).toEqual([block])
  })

  it("finds a list inside a block through the block's value", () => {
    const value = {
      blocks: [
        { template: 'hero', value: { heading: 'Top' } },
        { template: 'gallery', value: { items: [{ caption: 'one' }] } },
      ],
    }
    const restored = restoreRemoval(fields, value, {
      kind: 'list-item',
      listPath: ['blocks', 1, 'items'],
      index: 0,
      item: { caption: 'zero' },
      label: 'zero',
    })
    expect(restored?.blocks).toEqual([
      { template: 'hero', value: { heading: 'Top' } },
      { template: 'gallery', value: { items: [{ caption: 'zero' }, { caption: 'one' }] } },
    ])
  })

  it('restores an image inside an inline group, which adds no path segment', () => {
    const image = { src: '/a.png', alt: 'A' }
    const restored = restoreRemoval(
      fields,
      { title: 'T' },
      { kind: 'value', path: ['hero'], value: image, label: 'Hero' },
    )
    expect(restored).toEqual({ title: 'T', hero: image })
  })

  it('leaves an image field filled since the removal alone', () => {
    expect(
      restoreRemoval(
        fields,
        { hero: { src: '/new.png', alt: 'New' } },
        { kind: 'value', path: ['hero'], value: { src: '/old.png', alt: 'Old' }, label: 'Hero' },
      ),
    ).toBeUndefined()
  })

  it('gives up when the path no longer leads anywhere', () => {
    expect(
      restoreRemoval(
        fields,
        { blocks: [{ template: 'hero', value: {} }] },
        {
          kind: 'list-item',
          listPath: ['blocks', 0, 'items'],
          index: 0,
          item: { caption: 'x' },
          label: 'x',
        },
      ),
    ).toBeUndefined()
  })

  describe('enclosing lists', () => {
    const gallery = (caption: string) => ({
      template: 'gallery',
      value: { items: [{ caption }] },
    })
    const removeFirstCaption = (value: Record<string, unknown>): FieldRemoval => {
      const removal: FieldRemoval = {
        kind: 'list-item',
        listPath: ['blocks', 0, 'items'],
        index: 0,
        item: { caption: 'x' },
        label: 'x',
      }
      return { ...removal, anchors: removalAnchors(fields, value, removal) }
    }

    it("puts nothing into a block that moved into the removed item's place", () => {
      const [g1, g2] = [gallery('x'), gallery('y')]
      const removal = removeFirstCaption({ blocks: [g1, g2] })
      const g1After = { ...g1, value: { items: [] } }
      expect(restoreRemoval(fields, { blocks: [g2, g1After] }, removal)).toBeUndefined()
    })

    it('puts nothing back once the enclosing block itself is gone', () => {
      const [g1, g2] = [gallery('x'), gallery('y')]
      const removal = removeFirstCaption({ blocks: [g1, g2] })
      expect(restoreRemoval(fields, { blocks: [g2] }, removal)).toBeUndefined()
    })

    it('restores into a saved copy of the same blocks, which are new objects', () => {
      const [g1, g2] = [gallery('x'), gallery('y')]
      const removal = removeFirstCaption({ blocks: [g1, g2] })
      const saved = JSON.parse(
        JSON.stringify({ blocks: [{ ...g1, value: { items: [] } }, g2] }),
      ) as Record<string, unknown>
      expect(restoreRemoval(fields, saved, removal)?.blocks).toEqual([
        { template: 'gallery', value: { items: [{ caption: 'x' }] } },
        g2,
      ])
    })

    it('holds against a saved copy that dropped a sibling key set to undefined', () => {
      const [g1, g2] = [gallery('x'), { ...gallery('y'), cleared: undefined }]
      const removal = removeFirstCaption({ blocks: [g1, g2] })
      const saved = JSON.parse(
        JSON.stringify({ blocks: [{ ...g1, value: { items: [] } }, g2] }),
      ) as Record<string, unknown>
      expect(restoreRemoval(fields, saved, removal)).toBeDefined()
    })

    it('puts nothing back once a sibling block has changed', () => {
      const [g1, g2] = [gallery('x'), gallery('y')]
      const removal = removeFirstCaption({ blocks: [g1, g2] })
      const g2Edited = gallery('y edited')
      expect(
        restoreRemoval(fields, { blocks: [{ ...g1, value: { items: [] } }, g2Edited] }, removal),
      ).toBeUndefined()
    })

    it('restores while the enclosing block is still in place, even edited', () => {
      const [g1, g2] = [gallery('x'), gallery('y')]
      const removal = removeFirstCaption({ blocks: [g1, g2] })
      const g1Edited = { ...g1, value: { items: [{ caption: 'z' }] } }
      const restored = restoreRemoval(fields, { blocks: [g1Edited, g2] }, removal)
      expect(restored?.blocks).toEqual([
        { template: 'gallery', value: { items: [{ caption: 'x' }, { caption: 'z' }] } },
        g2,
      ])
    })
  })

  it('puts nothing back when a copy of the item is already there', () => {
    expect(
      restoreRemoval(
        fields,
        { links: [{ href: '/a' }, { href: '/b' }] },
        { kind: 'list-item', listPath: ['links'], index: 1, item: { href: '/b' }, label: '/b' },
      ),
    ).toBeUndefined()
  })

  it('puts nothing back when the item is already there', () => {
    const item = { href: '/b' }
    expect(
      restoreRemoval(
        fields,
        { links: [{ href: '/a' }, item] },
        { kind: 'list-item', listPath: ['links'], index: 1, item, label: '/b' },
      ),
    ).toBeUndefined()
  })
})

describe('restoreRemoval of a cleared object', () => {
  const clearOf = (path: Array<string | number>, value: unknown): FieldRemoval => ({
    kind: 'value',
    path,
    value,
    label: 'x',
  })

  it('puts the object back while its field is still unset', () => {
    const seo = { summary: 'S' }
    expect(restoreRemoval(fields, { title: 'T' }, clearOf(['seo'], seo))?.seo).toBe(seo)
  })

  it('puts nothing back once the object holding it has itself been cleared', () => {
    // Clear seo.card, then Clear seo: Undo on the first would bring seo back as { card } alone.
    const removal = clearOf(['seo', 'card'], { caption: 'C' })
    expect(restoreRemoval(fields, { title: 'T' }, removal)).toBeUndefined()
    expect(restoreRemoval(fields, { seo: { summary: 'S' } }, removal)?.seo).toEqual({
      summary: 'S',
      card: { caption: 'C' },
    })
  })
})

describe('openThreadsWithin', () => {
  const thread = (id: string, canopyPath: string, itemKeys?: string[], resolved = false) =>
    ({
      id,
      type: 'field',
      entryPath: 'posts/a',
      canopyPath,
      itemKeys,
      resolved,
      authorId: 'u',
      createdAt: '2024-01-01T00:00:00Z',
      comments: [],
    }) as CommentThread

  it('counts the open threads keyed to the removed item or inside it, and no other', () => {
    const threads = [
      thread('on-item', 'links[1].href', ['k1']),
      thread('resolved', 'links[1].href', ['k1'], true),
      thread('neighbour', 'links[10].href', ['k10']),
      thread('other-entry', 'links[1].href', ['k1']),
    ]
    threads[3] = { ...threads[3], entryPath: 'posts/b' }
    expect(openThreadsWithin(threads, 'posts/a', ['links', 1])).toBe(1)
  })

  it("counts a Clear's threads keyed to items inside it, not those keyed only above it", () => {
    const threads = [
      thread('inside-list', 'meta.links[0].href', ['k0']),
      thread('on-field', 'meta.title'),
      thread('above', 'team[1].seo.title', ['k-team1']),
    ]
    expect(openThreadsWithin(threads, 'posts/a', ['meta'])).toBe(1)
    expect(openThreadsWithin(threads, 'posts/a', ['team', 1, 'seo'])).toBe(0)
  })
})

describe('restoredFieldPath', () => {
  const link = (index: number): FieldRemoval => ({
    kind: 'list-item',
    listPath: ['links'],
    index,
    item: { href: '/c' },
    label: '/c',
  })

  it('is the removed index while the list still reaches it', () => {
    const value = { links: [{ href: '/a' }, { href: '/b' }] }
    expect(restoredFieldPath(fields, value, link(1))).toEqual(['links', 1])
  })

  it('is where restoreRemoval actually inserts, once the list has shrunk below the index', () => {
    const value = { links: [{ href: '/b' }] }
    expect(restoredFieldPath(fields, value, link(2))).toEqual(['links', 1])
    expect(restoreRemoval(fields, value, link(2))?.links).toEqual([{ href: '/b' }, { href: '/c' }])
    expect(restoredFieldPath(fields, {}, link(2))).toEqual(['links', 0])
  })

  it('clamps a list inside a block through the block value', () => {
    const removal: FieldRemoval = {
      kind: 'list-item',
      listPath: ['blocks', 0, 'items'],
      index: 4,
      item: { caption: 'x' },
      label: 'x',
    }
    const value = { blocks: [{ template: 'gallery', value: { items: [{ caption: 'y' }] } }] }
    expect(restoredFieldPath(fields, value, removal)).toEqual(['blocks', 0, 'items', 1])
  })

  it('is the field itself for a removed value', () => {
    const removal: FieldRemoval = {
      kind: 'value',
      path: ['meta', 'hero'],
      value: 'a.png',
      label: 'x',
    }
    expect(restoredFieldPath(fields, {}, removal)).toEqual(['meta', 'hero'])
  })
})
