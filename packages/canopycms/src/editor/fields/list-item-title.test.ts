import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../../config'
import {
  listItemHeading,
  listItemSecondary,
  listItemSummary,
  listItemTitle,
} from './list-item-title'

const name: FieldConfig = { name: 'name', type: 'string' }
const role: FieldConfig = {
  name: 'role',
  type: 'select',
  options: [{ label: 'Engineer', value: 'eng' }, 'designer'],
}

const summary = (
  item: unknown,
  fields: FieldConfig[],
  itemTitleField?: string,
  index = 0,
): ReturnType<typeof listItemSummary> =>
  listItemSummary(item, { fields, ...(itemTitleField ? { itemTitleField } : {}) }, index)

describe('listItemSummary title', () => {
  const fields: FieldConfig[] = [
    { name: 'kicker', type: 'string' },
    { name: 'headline', type: 'string' },
  ]

  it('is the itemTitleField value when that field has one', () => {
    expect(summary({ kicker: 'K', headline: 'H' }, fields, 'headline').title).toBe('H')
  })

  it('is the first string field when there is no itemTitleField', () => {
    expect(summary({ kicker: 'K', headline: 'H' }, fields).title).toBe('K')
  })

  it('falls back to the first non-blank string field when the itemTitleField value is blank', () => {
    expect(summary({ kicker: 'K', headline: '   ' }, fields, 'headline').title).toBe('K')
    expect(summary({ kicker: 'K' }, fields, 'headline').title).toBe('K')
  })

  it('skips blank string fields on the way to the first one with text', () => {
    expect(summary({ kicker: '  ', headline: 'H' }, fields).title).toBe('H')
  })

  it('is "Item N", counting from 1, when no field has text', () => {
    expect(summary({}, fields, undefined, 0).title).toBe('Item 1')
    expect(summary({ kicker: '', headline: ' ' }, fields, undefined, 4).title).toBe('Item 5')
  })

  it('uses a number held by the itemTitleField', () => {
    const numbered: FieldConfig[] = [{ name: 'rank', type: 'number' }, name]
    expect(summary({ rank: 7, name: 'Ada' }, numbered, 'rank').title).toBe('7')
    expect(summary({ rank: 0, name: 'Ada' }, numbered, 'rank').title).toBe('0')
  })

  it('does not title an item by a number when no itemTitleField names it', () => {
    expect(summary({ rank: 7 }, [{ name: 'rank', type: 'number' }], undefined, 1).title).toBe(
      'Item 2',
    )
  })

  it('does not title an item by a string list or a select', () => {
    const fieldsWithoutTitle: FieldConfig[] = [{ name: 'tags', type: 'string', list: true }, role]
    expect(summary({ tags: 'x', role: 'eng' }, fieldsWithoutTitle).title).toBe('Item 1')
  })

  it('shortens a long title to 60 characters, ending in an ellipsis', () => {
    expect(summary({ name: 'x'.repeat(200) }, [name]).title).toBe(`${'x'.repeat(59)}…`)
    expect(summary({ name: 'x'.repeat(60) }, [name]).title).toBe('x'.repeat(60))
  })

  it('finds a title field inside an inline group', () => {
    const grouped: FieldConfig[] = [{ name: 'meta', type: 'group', fields: [name] }]
    expect(summary({ name: 'Ada' }, grouped).title).toBe('Ada')
  })
})

describe('listItemSummary secondary', () => {
  it('is the next text field after the one that titled the item', () => {
    const fields: FieldConfig[] = [name, { name: 'city', type: 'string' }]
    expect(summary({ name: 'Ada', city: 'London' }, fields)).toEqual({
      title: 'Ada',
      secondary: 'London',
    })
  })

  it('skips the field named by itemTitleField, even when it comes later in the schema', () => {
    const fields: FieldConfig[] = [{ name: 'city', type: 'string' }, name]
    expect(summary({ name: 'Ada', city: 'London' }, fields, 'name')).toEqual({
      title: 'Ada',
      secondary: 'London',
    })
  })

  it('skips the field whose text became the title through the first-string fallback', () => {
    const fields: FieldConfig[] = [
      { name: 'blank', type: 'string' },
      name,
      { name: 'city', type: 'string' },
    ]
    expect(summary({ blank: '', name: 'Ada', city: 'London' }, fields)).toEqual({
      title: 'Ada',
      secondary: 'London',
    })
  })

  it('is undefined for an item whose title field is its only text', () => {
    expect(summary({ name: 'Ada' }, [name]).secondary).toBeUndefined()
  })

  it('shows a select by its option label, not its value', () => {
    expect(summary({ name: 'Ada', role: 'eng' }, [name, role]).secondary).toBe('Engineer')
  })

  it('shows a select by a plain string option as that string', () => {
    expect(summary({ name: 'Ada', role: 'designer' }, [name, role]).secondary).toBe('designer')
  })

  it('shows a select value that matches no option as it is', () => {
    expect(summary({ name: 'Ada', role: 'retired' }, [name, role]).secondary).toBe('retired')
  })

  it('shows numbers, zero included', () => {
    const fields: FieldConfig[] = [name, { name: 'age', type: 'number' }]
    expect(summary({ name: 'Ada', age: 36 }, fields).secondary).toBe('36')
    expect(summary({ name: 'Ada', age: 0 }, fields).secondary).toBe('0')
  })

  it('skips a number that is not finite', () => {
    const fields: FieldConfig[] = [
      name,
      { name: 'age', type: 'number' },
      { name: 'city', type: 'string' },
    ]
    expect(summary({ name: 'Ada', age: Number.NaN, city: 'London' }, fields).secondary).toBe(
      'London',
    )
  })

  it('skips blank strings and takes the next field with text', () => {
    const fields: FieldConfig[] = [
      name,
      { name: 'city', type: 'string' },
      { name: 'country', type: 'string' },
    ]
    expect(summary({ name: 'Ada', city: '   ', country: 'UK' }, fields).secondary).toBe('UK')
    expect(summary({ name: 'Ada', city: '', country: '' }, fields).secondary).toBeUndefined()
  })

  it('shows only the first line of a multi-line value', () => {
    const fields: FieldConfig[] = [name, { name: 'bio', type: 'string' }]
    expect(summary({ name: 'Ada', bio: 'First line\nSecond line' }, fields).secondary).toBe(
      'First line',
    )
  })

  it('skips string lists, booleans and other fields that are not single-line text', () => {
    const fields: FieldConfig[] = [
      name,
      { name: 'tags', type: 'string', list: true },
      { name: 'live', type: 'boolean' },
      { name: 'notes', type: 'markdown' },
      { name: 'city', type: 'string' },
    ]
    expect(
      summary({ name: 'Ada', tags: ['a'], live: true, notes: 'text', city: 'London' }, fields)
        .secondary,
    ).toBe('London')
  })

  it('shortens a long secondary value to 60 characters', () => {
    const fields: FieldConfig[] = [name, { name: 'bio', type: 'string' }]
    expect(summary({ name: 'Ada', bio: 'y'.repeat(100) }, fields).secondary).toBe(
      `${'y'.repeat(59)}…`,
    )
  })
})

describe('listItemSummary for an item that is not a record', () => {
  // A field named "length" would read a string's or an array's own property if they were treated as records.
  const fields: FieldConfig[] = [name, role, { name: 'length', type: 'number' }]

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'text'],
    ['a number', 3],
    ['an array', ['Ada']],
  ])('is "Item N" with no secondary for %s', (_label, item) => {
    expect(summary(item, fields, 'name', 2)).toEqual({
      title: 'Item 3',
      secondary: undefined,
    })
  })
})

describe('listItemTitle, listItemHeading and listItemSecondary', () => {
  it('listItemTitle is undefined where listItemHeading is "Item N"', () => {
    expect(listItemTitle({}, { fields: [name] })).toBeUndefined()
    expect(listItemHeading({}, { fields: [name] }, 1)).toBe('Item 2')
    expect(listItemHeading({ name: 'Ada' }, { fields: [name] }, 1)).toBe('Ada')
  })

  it('listItemSecondary leaves out the field it is told to exclude', () => {
    const fields: FieldConfig[] = [name, { name: 'city', type: 'string' }]
    const item = { name: 'Ada', city: 'London' }
    expect(listItemSecondary(item, fields)).toBe('Ada')
    expect(listItemSecondary(item, fields, 'name')).toBe('London')
  })
})
