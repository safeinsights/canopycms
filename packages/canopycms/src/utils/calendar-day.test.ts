import matter from 'gray-matter'
import { afterEach, describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import {
  calendarDayToLocalDate,
  entryAsRead,
  isCalendarDay,
  localDateToCalendarDay,
  withCalendarDays,
} from './calendar-day'

const zone = process.env.TZ

afterEach(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

describe('isCalendarDay', () => {
  it.each(['2024-02-29', '2026-11-05', '2026-12-31', '2000-02-29', '0099-01-01'])(
    'accepts %s',
    (value) => {
      expect(isCalendarDay(value)).toBe(true)
    },
  )

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-5-1',
    '26-05-01',
    '2026-05-01T00:00:00.000Z',
    '2026-05-01 ',
    ' 2026-05-01',
    '2026-05-01\n',
    '20260501',
    '',
    'next tuesday',
  ])('refuses %j', (value) => {
    expect(isCalendarDay(value)).toBe(false)
  })

  it.each([[20260501], [null], [undefined], [new Date('2026-05-01')], [['2026-05-01']]])(
    'refuses a value that is no string: %j',
    (value) => {
      expect(isCalendarDay(value)).toBe(false)
    },
  )
})

describe.each(['America/Los_Angeles', 'Asia/Tokyo', 'America/Havana', 'UTC'])(
  'a day and a local Date in %s',
  (timeZone) => {
    // 2026-03-08 has no midnight in Havana: its clocks go from 00:00 to 01:00.
    it.each(['2024-02-29', '2026-03-08', '2026-11-05', '2026-12-31', '0099-01-01'])(
      'reads %s as that local day and writes it back',
      (day) => {
        process.env.TZ = timeZone
        const date = calendarDayToLocalDate(day)
        expect(date).not.toBeNull()
        expect(localDateToCalendarDay(date as Date)).toBe(day)
      },
    )
  },
)

it('reads a value that is no real day as null', () => {
  expect(calendarDayToLocalDate('2026-02-30')).toBeNull()
  expect(calendarDayToLocalDate('')).toBeNull()
})

const fields: FieldConfig[] = [
  { name: 'on', type: 'date' },
  { name: 'at', type: 'datetime' },
  { name: 'meta', type: 'group', fields: [{ name: 'inGroup', type: 'date' }] },
  { name: 'nested', type: 'object', fields: [{ name: 'on', type: 'date' }] },
  { name: 'rows', type: 'object', list: true, fields: [{ name: 'on', type: 'date' }] },
  {
    name: 'blocks',
    type: 'block',
    templates: [{ name: 'event', fields: [{ name: 'on', type: 'date' }] }],
  },
]

const bare = (day: string) => new Date(`${day}T00:00:00.000Z`)

describe('withCalendarDays', () => {
  it('makes a bare date the day written, wherever a date field sits', () => {
    expect(
      withCalendarDays(fields, {
        on: bare('2024-05-01'),
        inGroup: bare('2024-05-02'),
        nested: { on: bare('2024-05-03') },
        rows: [{ on: bare('2024-05-04') }, { on: '2024-05-05' }],
        blocks: [
          { template: 'event', value: { on: bare('2024-05-06') } },
          { _type: 'event', on: bare('2024-05-07') },
        ],
      }),
    ).toEqual({
      on: '2024-05-01',
      inGroup: '2024-05-02',
      nested: { on: '2024-05-03' },
      rows: [{ on: '2024-05-04' }, { on: '2024-05-05' }],
      blocks: [
        { template: 'event', value: { on: '2024-05-06' } },
        { _type: 'event', on: '2024-05-07' },
      ],
    })
  })

  it('reads a bare date in a block field that is itself named value, in both block shapes', () => {
    const named: FieldConfig[] = [
      {
        name: 'blocks',
        type: 'block',
        templates: [{ name: 'stat', fields: [{ name: 'value', type: 'date' }] }],
      },
    ]
    expect(
      withCalendarDays(named, {
        blocks: [
          { template: 'stat', value: { value: bare('2024-05-01') } },
          { template: 'stat', value: bare('2024-05-02') },
          { _type: 'stat', value: bare('2024-05-03') },
        ],
      }),
    ).toEqual({
      blocks: [
        { template: 'stat', value: { value: '2024-05-01' } },
        { template: 'stat', value: '2024-05-02' },
        { _type: 'stat', value: '2024-05-03' },
      ],
    })
  })

  it('leaves a Date with a time of day, and a bare date before 1970 is still a day', () => {
    const noon = new Date('2024-05-01T12:00:00.000Z')
    expect(withCalendarDays(fields, { on: noon }).on).toBe(noon)
    expect(withCalendarDays(fields, { on: bare('1969-12-30') }).on).toBe('1969-12-30')
  })

  it('leaves a bare date under any other field, and one the schema does not name', () => {
    const on = bare('2024-05-01')
    const data = { at: on, stray: on }
    expect(withCalendarDays(fields, data)).toBe(data)
  })

  it('hands back the same object when nothing changed', () => {
    const data = {
      on: '2024-05-01',
      nested: { on: '' },
      rows: [{ on: '2024-05-04' }, 'not a row'],
      blocks: [{ template: 'event', value: {} }, { template: 'gone' }],
    }
    expect(withCalendarDays(fields, data)).toBe(data)
  })

  it('writes nothing into a parser’s shared object', () => {
    const { data } = matter('---\non: 2024-05-01\nnested:\n  on: 2024-05-03\n---\n', {})
    const out = withCalendarDays(fields, data)
    expect(out.nested).toEqual({ on: '2024-05-03' })
    expect(data.on).toBeInstanceOf(Date)
    expect((data.nested as { on: unknown }).on).toBeInstanceOf(Date)
  })

  it('reads a real bare date as the day written west and east of UTC', () => {
    for (const timeZone of ['America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = timeZone
      const { data } = matter('---\non: 2024-05-01\n---\n', {})
      expect(withCalendarDays(fields, data).on).toBe('2024-05-01')
    }
  })
})

describe('entryAsRead', () => {
  it('keys an item by its value as read, as a save of that value keys it', () => {
    const asRead = entryAsRead(fields, { rows: [{ on: bare('2024-05-04') }] })
    const asSaved = entryAsRead(fields, { rows: [{ on: '2024-05-04' }] })
    expect(asRead).toEqual(asSaved)
    expect((asRead.rows as Array<{ _key: string }>)[0]._key).toMatch(/^h/)
  })
})
