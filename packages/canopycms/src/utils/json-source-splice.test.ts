import { afterEach, describe, expect, it, vi } from 'vitest'

import { serializeJson } from './json-source-splice'

// A switch over jsonc-parser's `applyEdits`: while it is on, every edit set is dropped, so the
// spliced text no longer reads back as the data and the safety net is what is under test.
const faults = vi.hoisted(() => ({ dropEdits: false }))
vi.mock('jsonc-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jsonc-parser')>()
  return {
    ...actual,
    applyEdits: (text: string, edits: Parameters<typeof actual.applyEdits>[1]) =>
      faults.dropEdits ? text : actual.applyEdits(text, edits),
  }
})

afterEach(() => {
  faults.dropEdits = false
})

const plain = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`

/** Prettier's layout: a short array stays on one line, as does a short object. */
const PRETTIER = `{
  "title": "Hello",
  "tags": ["a", "b"],
  "meta": { "draft": false, "rank": 1 },
  "body": {
    "heading": "Intro",
    "items": [1, 2, 3]
  }
}
`

const PRETTIER_DATA = {
  title: 'Hello',
  tags: ['a', 'b'],
  meta: { draft: false, rank: 1 },
  body: { heading: 'Intro', items: [1, 2, 3] },
}

describe('serializeJson', () => {
  it('writes JSON.stringify output when there is no existing file', () => {
    expect(serializeJson(PRETTIER_DATA)).toBe(plain(PRETTIER_DATA))
  })

  it('returns the file byte for byte on a no-op save', () => {
    expect(serializeJson(PRETTIER_DATA, PRETTIER)).toBe(PRETTIER)
  })

  it('changes only the line of an edited scalar, leaving a short array on one line', () => {
    const saved = serializeJson({ ...PRETTIER_DATA, title: 'Goodbye' }, PRETTIER)
    expect(saved).toBe(PRETTIER.replace('"Hello"', '"Goodbye"'))
    expect(saved).toContain('"tags": ["a", "b"]')
  })

  it('removes a key the save dropped', () => {
    const { tags: _tags, ...rest } = PRETTIER_DATA
    expect(serializeJson(rest, PRETTIER)).toBe(PRETTIER.replace('  "tags": ["a", "b"],\n', ''))
  })

  it('adds and removes keys named like Object.prototype members', () => {
    const file = '{\n  "constructor": 1,\n  "tags": ["a", "b"]\n}\n'
    expect(serializeJson({ tags: ['a', 'b'] }, file)).toBe('{\n  "tags": ["a", "b"]\n}\n')
    expect(serializeJson({ tags: ['a', 'b'], toString: 'x' }, '{\n  "tags": ["a", "b"]\n}\n')).toBe(
      '{\n  "tags": ["a", "b"],\n  "toString": "x"\n}\n',
    )
  })

  it.each([
    [
      'the first member',
      '{\n  "a": 1,\n  "b": [1, 2],\n  "c": 3\n}\n',
      'a',
      '{\n  "b": [1, 2],\n  "c": 3\n}\n',
    ],
    [
      'a middle member',
      '{\n  "a": 1,\n  "b": [1, 2],\n  "c": 3\n}\n',
      'b',
      '{\n  "a": 1,\n  "c": 3\n}\n',
    ],
    ['the last member', '{\n  "a": [1, 2],\n  "c": 3\n}\n', 'c', '{\n  "a": [1, 2]\n}\n'],
    ['the only member', '{\n  "a": 1\n}\n', 'a', '{}\n'],
    [
      'the first member of a one-line object',
      '{ "a": 1, "b": [1, 2] }\n',
      'a',
      '{ "b": [1, 2] }\n',
    ],
    [
      'the first member of a CRLF file',
      '{\r\n  "a": 1,\r\n  "b": [1, 2]\r\n}\r\n',
      'a',
      '{\r\n  "b": [1, 2]\r\n}\r\n',
    ],
  ])('removes %s and only its text', (_shape, file, key, expected) => {
    const data = JSON.parse(file) as Record<string, unknown>
    delete data[key]
    expect(serializeJson(data, file)).toBe(expected)
  })

  it('writes an object emptied of its members as {}', () => {
    const file = '{\n  "meta": {\n    "x": 1\n  },\n  "tags": ["a", "b"]\n}\n'
    expect(serializeJson({ meta: {}, tags: ['a', 'b'] }, file)).toBe(
      '{\n  "meta": {},\n  "tags": ["a", "b"]\n}\n',
    )
    expect(serializeJson({}, '{\n  "a": [1, 2]\n}\n')).toBe('{}\n')
  })

  it('removes a key set to undefined', () => {
    const saved = serializeJson({ ...PRETTIER_DATA, tags: undefined }, PRETTIER)
    expect(saved).toBe(PRETTIER.replace('  "tags": ["a", "b"],\n', ''))
  })

  it('appends a new key without touching the member before it', () => {
    const saved = serializeJson({ ...PRETTIER_DATA, subtitle: 'World' }, PRETTIER)
    expect(saved).toBe(PRETTIER.replace('\n  }\n}\n', '\n  },\n  "subtitle": "World"\n}\n'))
  })

  it('appends a new key inside a nested object', () => {
    const saved = serializeJson(
      { ...PRETTIER_DATA, body: { ...PRETTIER_DATA.body, extra: true } },
      PRETTIER,
    )
    expect(saved).toBe(PRETTIER.replace('[1, 2, 3]\n', '[1, 2, 3],\n    "extra": true\n'))
  })

  it('edits a nested object value in place', () => {
    const saved = serializeJson(
      { ...PRETTIER_DATA, body: { heading: 'Outro', items: [1, 2, 3] } },
      PRETTIER,
    )
    expect(saved).toBe(PRETTIER.replace('"Intro"', '"Outro"'))
  })

  it('edits one element of an equal-length array without touching its neighbours', () => {
    const saved = serializeJson({ ...PRETTIER_DATA, tags: ['a', 'c'] }, PRETTIER)
    expect(saved).toBe(PRETTIER.replace('["a", "b"]', '["a", "c"]'))
  })

  it('re-renders a whole array whose length changed, leaving the rest alone', () => {
    const saved = serializeJson({ ...PRETTIER_DATA, tags: ['a', 'b', 'c'] }, PRETTIER)
    expect(JSON.parse(saved)).toEqual({ ...PRETTIER_DATA, tags: ['a', 'b', 'c'] })
    expect(saved).toContain('  "tags": [\n    "a",\n    "b",\n    "c"\n  ],\n')
    expect(saved).toContain('"meta": { "draft": false, "rank": 1 }')
    expect(saved).toContain('"items": [1, 2, 3]')
  })

  it('keeps the file key order for retained keys', () => {
    const reordered = {
      body: PRETTIER_DATA.body,
      tags: ['a', 'b'],
      title: 'Hello',
      meta: { draft: false, rank: 1 },
    }
    expect(serializeJson(reordered, PRETTIER)).toBe(PRETTIER)
  })

  it('replaces a value whose type changed', () => {
    const saved = serializeJson({ ...PRETTIER_DATA, meta: 'none' }, PRETTIER)
    expect(saved).toBe(PRETTIER.replace('{ "draft": false, "rank": 1 }', '"none"'))
  })

  it('compares values as JSON serialises them', () => {
    const when = new Date('2026-01-02T03:04:05.000Z')
    const raw = `{\n  "when": "${when.toISOString()}",\n  "n": 1\n}\n`
    expect(serializeJson({ when, n: 1 }, raw)).toBe(raw)
  })

  it('keeps CRLF line endings, including in rendered values', () => {
    const raw = PRETTIER.replace(/\n/g, '\r\n')
    const saved = serializeJson(
      { ...PRETTIER_DATA, title: 'Goodbye', tags: ['a', 'b', 'c'], added: { k: 1 } },
      raw,
    )
    expect(saved).not.toMatch(/[^\r]\n/)
    expect(saved).toContain('"title": "Goodbye"')
    expect(JSON.parse(saved).added).toEqual({ k: 1 })
  })

  it('keeps tab indentation for rendered values', () => {
    const raw = '{\n\t"a": 1,\n\t"b": {\n\t\t"c": 2\n\t}\n}\n'
    const saved = serializeJson({ a: 1, b: { c: 2 }, d: { e: [1] } }, raw)
    expect(saved).toBe(
      '{\n\t"a": 1,\n\t"b": {\n\t\t"c": 2\n\t},\n\t"d": {\n\t\t"e": [\n\t\t\t1\n\t\t]\n\t}\n}\n',
    )
  })

  it('keeps a four-space indent', () => {
    const raw = '{\n    "a": 1,\n    "b": 2\n}\n'
    expect(serializeJson({ a: 1, b: 2, c: 3 }, raw)).toBe(
      '{\n    "a": 1,\n    "b": 2,\n    "c": 3\n}\n',
    )
  })

  it('leaves an absent trailing newline absent', () => {
    const raw = PRETTIER.trimEnd()
    const saved = serializeJson({ ...PRETTIER_DATA, title: 'Goodbye', subtitle: 'World' }, raw)
    expect(saved.endsWith('}')).toBe(true)
    expect(JSON.parse(saved).subtitle).toBe('World')
  })

  it('keeps a trailing newline that is present', () => {
    expect(serializeJson({ ...PRETTIER_DATA, title: 'Goodbye' }, PRETTIER).endsWith('}\n')).toBe(
      true,
    )
  })

  it('fills an empty object', () => {
    expect(serializeJson({ a: 1 }, '{}\n')).toBe(plain({ a: 1 }))
  })

  it('writes JSON.stringify output over a file that does not parse', () => {
    expect(serializeJson(PRETTIER_DATA, '{ "title": ')).toBe(plain(PRETTIER_DATA))
    expect(serializeJson(PRETTIER_DATA, '')).toBe(plain(PRETTIER_DATA))
  })

  it('writes JSON.stringify output over a file whose root is not an object', () => {
    expect(serializeJson(PRETTIER_DATA, '[1]\n')).toBe(plain(PRETTIER_DATA))
    expect(serializeJson(PRETTIER_DATA, '"text"\n')).toBe(plain(PRETTIER_DATA))
    expect(serializeJson(PRETTIER_DATA, 'null\n')).toBe(plain(PRETTIER_DATA))
  })

  it('writes JSON.stringify output when the spliced text does not read back as the data', () => {
    const data = { ...PRETTIER_DATA, title: 'Goodbye' }
    faults.dropEdits = true
    const saved = serializeJson(data, PRETTIER)
    expect(saved).toBe(plain(data))
    expect(saved).toContain('"tags": [\n')
  })
})
