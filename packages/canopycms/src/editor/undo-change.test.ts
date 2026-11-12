import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import type { EntryChangeSide } from '../api/branch-entry-changes'
import { computeEntryDiff, type EntryChange } from './entry-diff'
import {
  canopyPathOf,
  formValueOfSide,
  holdsAs,
  setAllBack,
  setChangeBack,
  sideOfFormValue,
} from './undo-change'

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'body', type: 'markdown', label: 'Body', isBody: true },
  {
    name: 'seo',
    type: 'object',
    label: 'SEO',
    fields: [{ name: 'description', type: 'string', label: 'Description' }],
  },
  {
    name: 'links',
    type: 'object',
    list: true,
    label: 'Links',
    fields: [{ name: 'label', type: 'string', label: 'Label' }],
  },
  {
    name: 'blocks',
    type: 'block',
    label: 'Sections',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [{ name: 'heading', type: 'string', label: 'Heading' }],
      },
      { name: 'quote', label: 'Quote', fields: [{ name: 'text', type: 'string', label: 'Text' }] },
    ],
  },
  {
    name: 'cover',
    type: 'image',
    label: 'Cover',
  },
  { name: 'author', type: 'reference', label: 'Author', collections: ['people'] },
] as FieldConfig[]

const side = (data: Record<string, unknown>, body = 'Hello\n'): EntryChangeSide => ({
  format: 'md',
  entryType: 'page',
  data,
  body,
  bodyFieldName: 'body',
})

const link = (key: string, label: string) => ({ _key: key, label })
const hero = (key: string, heading: string) => ({
  _key: key,
  template: 'hero',
  value: { heading },
})

const baseData = {
  title: 'Home',
  seo: { description: 'Our site' },
  links: [link('a', 'One'), link('b', 'Two'), link('c', 'Three')],
  blocks: [hero('h1', 'Welcome'), { _key: 'q1', template: 'quote', value: { text: 'Hi' } }],
  cover: { src: '/media/old.png', alt: 'Old' },
  author: 'person-1',
}

const diffOf = (before: EntryChangeSide, after: EntryChangeSide): EntryChange[] =>
  computeEntryDiff({ fields, before, after }).changes

/** Undoes `pick`'s change in the saved value; the change is then gone from a fresh diff. */
const undo = (
  saved: Record<string, unknown>,
  pick: (c: EntryChange) => boolean,
  body?: string,
): { value: Record<string, unknown>; before: EntryChangeSide; change: EntryChange } => {
  const before = side(baseData)
  const after = side(saved, body)
  const change = diffOf(before, after).find(pick)
  expect(change).toBeDefined()
  const value = setChangeBack(formValueOfSide(after), formValueOfSide(before), change!, 'body')
  expect(value).toBeDefined()
  const left = diffOf(before, sideOfFormValue(value!, after)).map((c) => c.key)
  expect(left).not.toContain(change!.key)
  return { value: value!, before, change: change! }
}

describe('setChangeBack', () => {
  it('sets a field back and leaves the other changes', () => {
    const { value } = undo(
      { ...baseData, title: 'Start', seo: { description: 'New' } },
      (c) => c.key === 'title',
    )
    expect(value.title).toBe('Home')
    expect(value.seo).toEqual({ description: 'New' })
  })

  it('sets the body back under the form key', () => {
    const { value } = undo(baseData, (c) => c.key === 'body', 'Changed\n')
    expect(value.body).toBe('Hello\n')
  })

  it('puts a field back inside an object the branch cleared', () => {
    const saved: Record<string, unknown> = { ...baseData }
    delete saved.seo
    const { value } = undo(saved, (c) => c.key === 'seo.description')
    expect(value.seo).toEqual({ description: 'Our site' })
  })

  it('drops a field the branch added', () => {
    const { value } = undo({ ...baseData, title: undefined, extra: 'x' }, (c) =>
      c.key.endsWith('?extra'),
    )
    expect('extra' in value).toBe(false)
  })

  it('takes out an item the branch added', () => {
    const { value } = undo(
      { ...baseData, links: [...baseData.links, link('d', 'Four')] },
      (c) => c.item === true && c.kind === 'added',
    )
    expect(value.links).toEqual(baseData.links)
  })

  it('puts a removed item back after its nearest base neighbour, with its key', () => {
    const { value } = undo(
      { ...baseData, links: [link('c', 'Three'), link('a', 'One')] },
      (c) => c.item === true && c.kind === 'removed',
    )
    expect((value.links as Array<{ _key: string }>).map((l) => l._key)).toEqual(['c', 'a', 'b'])
  })

  it('puts a removed first item first', () => {
    const { value } = undo(
      { ...baseData, links: [link('b', 'Two'), link('c', 'Three')] },
      (c) => c.item === true && c.kind === 'removed',
    )
    expect(value.links).toEqual(baseData.links)
  })

  it('moves a moved item back', () => {
    const { value } = undo(
      { ...baseData, links: [link('b', 'Two'), link('c', 'Three'), link('a', 'One')] },
      (c) => c.kind === 'moved',
    )
    expect(value.links).toEqual(baseData.links)
  })

  it('sets an item field back wherever the item now sits', () => {
    const { value } = undo(
      { ...baseData, links: [link('c', 'Three'), link('a', 'First'), link('b', 'Two')] },
      (c) => c.key === 'links.a.label',
    )
    expect((value.links as Array<{ label: string }>)[1].label).toBe('One')
  })

  it("sets a block's field back inside its value", () => {
    const { value } = undo(
      { ...baseData, blocks: [hero('h1', 'Hello there'), baseData.blocks[1]] },
      (c) => c.key === 'blocks.h1.heading',
    )
    expect(value.blocks).toEqual(baseData.blocks)
  })

  it('sets back a block whose template changed, whole', () => {
    const { value } = undo(
      {
        ...baseData,
        blocks: [{ _key: 'h1', template: 'quote', value: { text: 'Now' } }, baseData.blocks[1]],
      },
      (c) => c.key === 'blocks.h1',
    )
    expect(value.blocks).toEqual(baseData.blocks)
  })

  it('sets an image and a reference back', () => {
    const saved = { ...baseData, cover: { src: '/media/new.png', alt: 'New' }, author: 'person-2' }
    expect(undo(saved, (c) => c.key === 'cover').value.cover).toEqual(baseData.cover)
    expect(undo(saved, (c) => c.key === 'author').value.author).toBe('person-1')
  })

  it('redoes an undo from the saved side', () => {
    const saved = { ...baseData, links: [...baseData.links, link('d', 'Four')] }
    const { value, change } = undo(saved, (c) => c.item === true && c.kind === 'added')
    const redone = setChangeBack(value, formValueOfSide(side(saved)), change, 'body')
    expect(redone?.links).toEqual(saved.links)
  })

  it('refuses a change inside an item the value no longer has', () => {
    const before = side(baseData)
    const after = side({ ...baseData, links: [link('a', 'First'), ...baseData.links.slice(1)] })
    const change = diffOf(before, after).find((c) => c.key === 'links.a.label')!
    const current = { ...formValueOfSide(after), links: baseData.links.slice(1) }
    expect(setChangeBack(current, formValueOfSide(before), change, 'body')).toBeUndefined()
  })

  it('has no place for an entry type change', () => {
    const before = side(baseData)
    const after = { ...side(baseData), entryType: 'post' }
    const change = diffOf(before, after).find((c) => c.key === '$entryType')!
    expect(change.dataPath).toBeUndefined()
    expect(setChangeBack(formValueOfSide(after), formValueOfSide(before), change)).toBeUndefined()
  })
})

describe('setChangeBack, edges', () => {
  it('sets back a body whose schema field has another name, under the form key', () => {
    const named = fields.map((f) => (f.name === 'body' ? { ...f, name: 'content' } : f))
    const before = { ...side(baseData), bodyFieldName: 'content' }
    const after = { ...side(baseData, 'Changed\n'), bodyFieldName: 'content' }
    const change = computeEntryDiff({ fields: named, before, after }).changes[0]
    expect(change.key).toBe('content')
    const value = setChangeBack(formValueOfSide(after), formValueOfSide(before), change, 'content')
    expect(value?.body).toBe('Hello\n')
    expect('content' in (value ?? {})).toBe(false)
  })

  it('refuses a move of an item the value no longer has', () => {
    const before = side(baseData)
    const after = side({
      ...baseData,
      links: [link('b', 'Two'), link('c', 'Three'), link('a', 'One')],
    })
    const change = diffOf(before, after).find((c) => c.kind === 'moved')!
    const current = { ...formValueOfSide(after), links: [link('b', 'Two'), link('c', 'Three')] }
    expect(setChangeBack(current, formValueOfSide(before), change, 'body')).toBeUndefined()
  })
})

describe('setChangeBack, empty containers', () => {
  it('redoes a cleared object without leaving it empty', () => {
    const before = side(baseData)
    const saved: Record<string, unknown> = { ...baseData }
    delete saved.seo
    const after = side(saved)
    const change = diffOf(before, after).find((c) => c.key === 'seo.description')!
    const undone = setChangeBack(formValueOfSide(after), formValueOfSide(before), change, 'body')!
    const redone = setChangeBack(undone, formValueOfSide(after), change, 'body')
    expect(redone).toEqual(formValueOfSide(after))
  })

  it('undoes an object and a list the branch added, leaving neither empty', () => {
    const bare: Record<string, unknown> = { title: 'Home' }
    const before = side(bare)
    const after = side({ ...bare, seo: { description: 'New' }, links: [link('a', 'One')] })
    const value = setAllBack(
      formValueOfSide(after),
      formValueOfSide(before),
      diffOf(before, after),
      'body',
    )
    expect(value).toEqual(formValueOfSide(before))
  })
})

describe('canopyPathOf', () => {
  it('has no path through an item the value lacks', () => {
    const before = side(baseData)
    const after = side({ ...baseData, links: [link('a', 'First'), ...baseData.links.slice(1)] })
    const change = diffOf(before, after).find((c) => c.key === 'links.a.label')!
    expect(canopyPathOf({ ...formValueOfSide(after), links: [] }, change)).toBeUndefined()
  })

  it('names items by their index in the value and skips a block value', () => {
    const before = side(baseData)
    const after = side({ ...baseData, blocks: [baseData.blocks[1], hero('h1', 'Changed')] })
    const change = diffOf(before, after).find((c) => c.key === 'blocks.h1.heading')!
    expect(canopyPathOf(formValueOfSide(after), change)).toEqual(['blocks', 1, 'heading'])
  })
})

describe('setAllBack', () => {
  it('sets every change back, lists in base order, and keeps other edits', () => {
    const before = side(baseData)
    const saved = {
      ...baseData,
      title: 'Start',
      links: [link('d', 'Four'), link('c', 'Three'), link('b', 'Second')],
      blocks: [baseData.blocks[1], hero('h1', 'Hey')],
    }
    const after = side(saved, 'Changed\n')
    const changes = diffOf(before, after)
    const current = { ...formValueOfSide(after), unsaved: 'kept' }
    const value = setAllBack(current, formValueOfSide(before), changes, 'body')
    expect(value).toEqual({ ...formValueOfSide(before), unsaved: 'kept' })
    const redone = setAllBack(value, formValueOfSide(after), changes, 'body')
    expect(redone).toEqual(current)
  })

  it('reverses a list in base order', () => {
    const before = side(baseData)
    const reversed = [...baseData.links, link('d', 'Four')].reverse()
    const after = side({ ...baseData, links: reversed })
    const value = setAllBack(formValueOfSide(after), formValueOfSide(before), diffOf(before, after))
    expect(value.links).toEqual(baseData.links)
  })
})

/**
 * Every shape of change, held as saved and undone to the base, with an edit made at or inside it
 * since: `holdsAs` must see the edit, which an undo or a redo would otherwise replace.
 */
describe('holdsAs, every change shape with an edit since', () => {
  const editTitle = (v: Record<string, unknown>) => ({ ...v, title: 'Edited' })
  const editLink = (key: string) => (v: Record<string, unknown>) => ({
    ...v,
    links: (v.links as Array<{ _key: string }>).map((l) =>
      l._key === key ? { ...l, label: 'Edited' } : l,
    ),
  })
  const editBlock = (v: Record<string, unknown>) => ({
    ...v,
    blocks: (v.blocks as Array<{ _key: string; value: Record<string, unknown> }>).map((b) =>
      b._key === 'h1' ? { ...b, value: { ...b.value, heading: 'Edited', text: 'Edited' } } : b,
    ),
  })
  const cases: Array<{
    name: string
    saved: Record<string, unknown>
    body?: string
    pick: (c: EntryChange) => boolean
    edit: (v: Record<string, unknown>) => Record<string, unknown>
  }> = [
    {
      name: 'a field',
      saved: { ...baseData, title: 'Start' },
      pick: (c) => c.key === 'title',
      edit: editTitle,
    },
    {
      name: 'the body',
      saved: baseData,
      body: 'Changed\n',
      pick: (c) => c.key === 'body',
      edit: (v) => ({ ...v, body: 'Edited\n' }),
    },
    {
      name: 'an object field',
      saved: { ...baseData, seo: { description: 'New' } },
      pick: (c) => c.key === 'seo.description',
      edit: (v) => ({ ...v, seo: { description: 'Edited' } }),
    },
    {
      name: 'an added item',
      saved: { ...baseData, links: [...baseData.links, link('d', 'Four')] },
      pick: (c) => c.item === true && c.kind === 'added',
      edit: editLink('d'),
    },
    {
      name: 'a removed item',
      saved: { ...baseData, links: baseData.links.slice(1) },
      pick: (c) => c.item === true && c.kind === 'removed',
      edit: editLink('a'),
    },
    {
      name: 'an item field',
      saved: { ...baseData, links: [link('a', 'First'), ...baseData.links.slice(1)] },
      pick: (c) => c.key === 'links.a.label',
      edit: editLink('a'),
    },
    {
      name: 'a block field',
      saved: { ...baseData, blocks: [hero('h1', 'Hey'), baseData.blocks[1]] },
      pick: (c) => c.key === 'blocks.h1.heading',
      edit: editBlock,
    },
    {
      name: 'a block template change',
      saved: {
        ...baseData,
        blocks: [{ _key: 'h1', template: 'quote', value: { text: 'Now' } }, baseData.blocks[1]],
      },
      pick: (c) => c.key === 'blocks.h1',
      edit: editBlock,
    },
    {
      name: 'an image',
      saved: { ...baseData, cover: { src: '/media/new.png', alt: 'New' } },
      pick: (c) => c.key === 'cover',
      edit: (v) => ({ ...v, cover: { ...(v.cover as object), alt: 'Edited' } }),
    },
  ]

  for (const { name, saved, body, pick, edit } of cases) {
    it(`sees an edit to ${name}, held as saved and once undone`, () => {
      const before = side(baseData)
      const after = side(saved, body)
      const change = diffOf(before, after).find(pick)!
      expect(change).toBeDefined()
      const [baseValue, savedValue] = [formValueOfSide(before), formValueOfSide(after)]
      const undone = setChangeBack(savedValue, baseValue, change, 'body')!
      expect(holdsAs(savedValue, savedValue, change, 'body')).toBe(true)
      expect(holdsAs(undone, baseValue, change, 'body')).toBe(true)
      // An edit inside an item applies only where the item is: held for an added one, undone
      // for a removed one, both for the rest.
      let edited = 0
      for (const [value, target] of [
        [savedValue, savedValue],
        [undone, baseValue],
      ] as const) {
        if (JSON.stringify(edit(value)) === JSON.stringify(value)) continue
        edited++
        expect(holdsAs(edit(value), target, change, 'body')).toBe(false)
      }
      expect(edited).toBeGreaterThan(0)
    })
  }

  it('sees a moved item held where the saved order has it, and once moved back', () => {
    const before = side(baseData)
    const after = side({
      ...baseData,
      links: [link('b', 'Two'), link('c', 'Three'), link('a', 'One')],
    })
    const change = diffOf(before, after).find((c) => c.kind === 'moved')!
    const [baseValue, savedValue] = [formValueOfSide(before), formValueOfSide(after)]
    expect(holdsAs(savedValue, savedValue, change)).toBe(true)
    const undone = setChangeBack(savedValue, baseValue, change)!
    expect(holdsAs(undone, baseValue, change)).toBe(true)
    expect(holdsAs(undone, savedValue, change)).toBe(false)
  })
})

describe('putting back an item among items keyed otherwise', () => {
  const change: EntryChange = {
    key: 'links.x',
    dataPath: [{ field: 'links' }, { item: 'x' }],
    path: ['Links', 'X'],
    kind: 'removed',
    item: true,
  }

  it('places it before the nearest item after it that the form holds, none before it doing', () => {
    // The source's items before it read under keys the form doesn't hold, as a version that left
    // the list keyless reads them; the one after it is held.
    const source = { links: [link('p1', 'One'), link('p2', 'Two'), link('x', 'X'), link('c', 'C')] }
    const current = { links: [link('c', 'C')] }
    const placed = setChangeBack(current, source, change)
    expect((placed?.links as Array<{ _key: string }>).map((l) => l._key)).toEqual(['x', 'c'])
  })

  it('places it at its own place when the form holds no item beside it', () => {
    const source = { links: [link('p1', 'One'), link('x', 'X')] }
    const current = { links: [link('q', 'Other')] }
    const placed = setChangeBack(current, source, change)
    expect((placed?.links as Array<{ _key: string }>).map((l) => l._key)).toEqual(['q', 'x'])
  })
})
