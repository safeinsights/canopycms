import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import { removalAnchors, restoreRemoval, type FieldRemoval } from './undo-removal'

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
