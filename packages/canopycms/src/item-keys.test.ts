import { describe, expect, it } from 'vitest'

import type { BlockFieldConfig, FieldConfig, ObjectFieldConfig } from './config'
import {
  ITEM_KEY,
  isItemKey,
  itemKeysOnPath,
  mintItemKey,
  resolveThreadPath,
  withFreshItemKeys,
  withItemKeys,
} from './item-keys'

type Rec = Record<string, unknown>
const keyOf = (item: unknown): string => (item as Rec)[ITEM_KEY] as string
const items = (value: unknown): Rec[] => value as Rec[]

const teamField: ObjectFieldConfig = {
  name: 'team',
  type: 'object',
  list: true,
  fields: [
    { name: 'name', type: 'string' },
    {
      name: 'links',
      type: 'object',
      list: true,
      fields: [{ name: 'href', type: 'string' }],
    },
  ],
}

const blocksField: BlockFieldConfig = {
  name: 'blocks',
  type: 'block',
  templates: [
    {
      name: 'hero',
      label: 'Hero',
      fields: [
        { name: 'title', type: 'string' },
        {
          name: 'buttons',
          type: 'object',
          list: true,
          fields: [{ name: 'label', type: 'string' }],
        },
      ],
    },
    { name: 'text', label: 'Text', fields: [{ name: 'body', type: 'string' }] },
  ],
}

const schema: FieldConfig[] = [{ name: 'title', type: 'string' }, teamField, blocksField]

describe('isItemKey / mintItemKey', () => {
  it.each([['a'], ['h1x'], ['Abc-123_x'], ['9'], ['a'.repeat(64)]])('accepts %s', (key) => {
    expect(isItemKey(key)).toBe(true)
  })

  it.each([
    [''],
    ['__proto__'],
    ['-lead'],
    ['has space'],
    ['a'.repeat(65)],
    [5],
    [null],
    [undefined],
    [{}],
  ])('rejects %j', (key) => {
    expect(isItemKey(key)).toBe(false)
  })

  it('mints 12 Base58 characters, a different one each time', () => {
    const minted = Array.from({ length: 50 }, mintItemKey)
    for (const key of minted) {
      expect(key).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
      expect(isItemKey(key)).toBe(true)
    }
    expect(new Set(minted).size).toBe(50)
  })
})

describe('withItemKeys with content keys', () => {
  const read = (data: Rec) => withItemKeys(schema, data, 'content')

  it('keys every object-list item, the same on every call, and differently for different items', () => {
    const data = { team: [{ name: 'Ada' }, { name: 'Bo' }, { name: 'Cy' }] }

    const first = items(read(data).team).map(keyOf)
    const again = items(read(structuredClone(data)).team).map(keyOf)

    expect(first).toEqual(again)
    first.forEach((key) => expect(isItemKey(key)).toBe(true))
    expect(new Set(first).size).toBe(3)
    expect(first.every((key) => key.startsWith('h'))).toBe(true)
  })

  it('gives an item the same key wherever it sits in the list', () => {
    const forward = items(read({ team: [{ name: 'Ada' }, { name: 'Bo' }] }).team)
    const reversed = items(read({ team: [{ name: 'Bo' }, { name: 'Ada' }] }).team)

    expect(keyOf(reversed[0])).toBe(keyOf(forward[1]))
    expect(keyOf(reversed[1])).toBe(keyOf(forward[0]))
  })

  it('suffixes identical items -2, -3 in order, the same on every call', () => {
    const data = { team: [{ name: 'Same' }, { name: 'Same' }, { name: 'Same' }] }

    const [a, b, c] = items(read(data).team).map(keyOf)

    expect(b).toBe(`${a}-2`)
    expect(c).toBe(`${a}-3`)
    expect(items(read(structuredClone(data)).team).map(keyOf)).toEqual([a, b, c])
  })

  it('keeps a valid key, and keys the item without one beside it', () => {
    const out = read({ team: [{ [ITEM_KEY]: 'mine', name: 'Ada' }, { name: 'Bo' }] })

    expect(keyOf(items(out.team)[0])).toBe('mine')
    expect(items(out.team)[0]).toEqual({ [ITEM_KEY]: 'mine', name: 'Ada' })
    expect(isItemKey(keyOf(items(out.team)[1]))).toBe(true)
  })

  it('replaces the second of two items holding the same key, and keeps the first', () => {
    const out = items(
      read({
        team: [
          { [ITEM_KEY]: 'dup', name: 'Ada' },
          { [ITEM_KEY]: 'dup', name: 'Bo' },
        ],
      }).team,
    )

    expect(keyOf(out[0])).toBe('dup')
    expect(keyOf(out[1])).not.toBe('dup')
    expect(isItemKey(keyOf(out[1]))).toBe(true)
  })

  it('does not let a content key collide with a key a later item already holds', () => {
    const probe = keyOf(items(read({ team: [{ name: 'Ada' }] }).team)[0])

    const out = items(read({ team: [{ name: 'Ada' }, { [ITEM_KEY]: probe, name: 'Bo' }] }).team)

    expect(keyOf(out[1])).toBe(probe)
    expect(keyOf(out[0])).not.toBe(probe)
    expect(new Set(out.map(keyOf)).size).toBe(2)
  })

  it.each([
    ['an empty string', ''],
    ['__proto__', '__proto__'],
    ['65 characters', 'a'.repeat(65)],
    ['a number', 5],
  ])('replaces an invalid key (%s) with a usable one', (_what, bad) => {
    const out = items(read({ team: [{ [ITEM_KEY]: bad, name: 'Ada' }] }).team)

    expect(isItemKey(keyOf(out[0]))).toBe(true)
    expect(keyOf(out[0])).not.toBe(bad)
  })

  it('keys items of a list nested in an item, and in a non-list object, and in a group', () => {
    const nested: FieldConfig[] = [
      teamField,
      {
        name: 'org',
        type: 'object',
        fields: [{ ...teamField, name: 'people' }],
      },
      {
        name: 'meta',
        type: 'group',
        fields: [{ ...teamField, name: 'advisers' }],
      },
    ]
    const data = {
      team: [{ name: 'Ada', links: [{ href: '/a' }, { href: '/b' }] }],
      org: { people: [{ name: 'Bo' }] },
      advisers: [{ name: 'Cy' }],
    }

    const out = withItemKeys(nested, data, 'content')

    const team = items(out.team)
    expect(isItemKey(keyOf(team[0]))).toBe(true)
    const links = items(team[0].links)
    expect(links.map((l) => isItemKey(keyOf(l)))).toEqual([true, true])
    expect(keyOf(links[0])).not.toBe(keyOf(links[1]))
    expect(isItemKey(keyOf(items((out.org as Rec).people)[0]))).toBe(true)
    // A group's fields live beside its siblings, not under the group's name.
    expect(isItemKey(keyOf(items(out.advisers)[0]))).toBe(true)
  })

  it('is idempotent: reading what a read produced changes nothing, nested lists included', () => {
    const once = read({ team: [{ name: 'Ada', links: [{ href: '/a' }, { href: '/a' }] }] })

    expect(read(once)).toBe(once)
  })

  describe('blocks', () => {
    it('keys a canonical { template, value } block on the block, never inside its value', () => {
      const out = items(read({ blocks: [{ template: 'text', value: { body: 'hi' } }] }).blocks)

      expect(isItemKey(keyOf(out[0]))).toBe(true)
      expect(out[0].value).toEqual({ body: 'hi' })
      expect(out[0].value).not.toHaveProperty(ITEM_KEY)
      expect(out[0].template).toBe('text')
    })

    it('keys the lists inside a canonical block, in its value', () => {
      const out = items(
        read({
          blocks: [
            { template: 'hero', value: { title: 'T', buttons: [{ label: 'A' }, { label: 'B' }] } },
          ],
        }).blocks,
      )

      const buttons = items((out[0].value as Rec).buttons)
      expect(buttons.map((b) => isItemKey(keyOf(b)))).toEqual([true, true])
      expect(keyOf(buttons[0])).not.toBe(keyOf(buttons[1]))
      expect(out[0].value).not.toHaveProperty(ITEM_KEY)
    })

    it('keys an inline _type block and the lists inside it', () => {
      const out = items(
        read({ blocks: [{ _type: 'hero', title: 'T', buttons: [{ label: 'A' }] }] }).blocks,
      )

      expect(isItemKey(keyOf(out[0]))).toBe(true)
      expect(out[0]._type).toBe('hero')
      expect(isItemKey(keyOf(items(out[0].buttons)[0]))).toBe(true)
    })

    it('keys a block whose template is unknown, and leaves its contents alone', () => {
      const out = items(read({ blocks: [{ template: 'gone', value: { x: [{ y: 1 }] } }] }).blocks)

      expect(isItemKey(keyOf(out[0]))).toBe(true)
      expect(out[0].value).toEqual({ x: [{ y: 1 }] })
    })

    it('passes a block whose value is null or an array through unreshaped', () => {
      const out = items(
        read({
          blocks: [
            { template: 'text', value: null },
            { template: 'text', value: ['a'] },
          ],
        }).blocks,
      )

      expect(out[0].value).toBeNull()
      expect(out[1].value).toEqual(['a'])
      expect(out.map((b) => isItemKey(keyOf(b)))).toEqual([true, true])
    })
  })

  it('returns the same object, and the same lists, when nothing needed a key', () => {
    const keyed = {
      title: 'T',
      team: [{ [ITEM_KEY]: 'a', name: 'Ada', links: [{ [ITEM_KEY]: 'l', href: '/' }] }],
      blocks: [{ [ITEM_KEY]: 'b', template: 'text', value: { body: 'x' } }],
    }

    expect(withItemKeys(schema, keyed, 'content')).toBe(keyed)
    expect(withItemKeys(schema, keyed, 'random')).toBe(keyed)
  })

  it('shares the parts it did not change, and never mutates its input', () => {
    const data = {
      title: 'T',
      team: [{ [ITEM_KEY]: 'a', name: 'Ada' }],
      blocks: [{ template: 'text', value: { body: 'x' } }],
    }
    const before = structuredClone(data)

    const out = withItemKeys(schema, data, 'content')

    expect(data).toEqual(before)
    expect(out).not.toBe(data)
    expect(out.team).toBe(data.team)
    expect(out.blocks).not.toBe(data.blocks)
  })

  it('ignores a non-array where a list is expected, and non-record items', () => {
    const data = { team: 'nope', blocks: [null, 'x', 4] }

    expect(withItemKeys(schema, data, 'content')).toBe(data)
  })
})

describe('withItemKeys with random keys', () => {
  it('mints a key for an item without one, keeps a valid one, and replaces a repeat', () => {
    const out = items(
      withItemKeys(
        schema,
        { team: [{ [ITEM_KEY]: 'k', name: 'A' }, { name: 'B' }, { [ITEM_KEY]: 'k', name: 'C' }] },
        'random',
      ).team,
    )

    expect(keyOf(out[0])).toBe('k')
    expect(keyOf(out[1])).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(keyOf(out[2])).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(new Set(out.map(keyOf)).size).toBe(3)
  })

  it('gives identical items different keys, and a second call different ones again', () => {
    const data = { team: [{ name: 'Same' }, { name: 'Same' }] }

    const one = items(withItemKeys(schema, data, 'random').team).map(keyOf)
    const two = items(withItemKeys(schema, data, 'random').team).map(keyOf)

    expect(one[0]).not.toBe(one[1])
    expect(one).not.toEqual(two)
  })
})

describe('withItemKeys with fresh keys', () => {
  it('rekeys every item, keyed or not, nested lists and blocks included', () => {
    const data = {
      team: [{ [ITEM_KEY]: 'a', name: 'Ada', links: [{ [ITEM_KEY]: 'l', href: '/' }] }],
      blocks: [
        {
          [ITEM_KEY]: 'b',
          template: 'hero',
          value: { buttons: [{ [ITEM_KEY]: 'btn', label: 'x' }] },
        },
      ],
    }

    const out = withItemKeys(schema, data, 'fresh')

    const team = items(out.team)
    expect(keyOf(team[0])).not.toBe('a')
    expect(isItemKey(keyOf(team[0]))).toBe(true)
    expect(keyOf(items(team[0].links)[0])).not.toBe('l')
    const block = items(out.blocks)[0]
    expect(keyOf(block)).not.toBe('b')
    expect(keyOf(items((block.value as Rec).buttons)[0])).not.toBe('btn')
    expect(data.team[0][ITEM_KEY]).toBe('a')
  })
})

describe('withFreshItemKeys', () => {
  it('rekeys the item and every item nested in it, leaving the original alone', () => {
    const original = {
      [ITEM_KEY]: 'a',
      name: 'Ada',
      links: [
        { [ITEM_KEY]: 'l1', href: '/1' },
        { [ITEM_KEY]: 'l2', href: '/2' },
      ],
    }

    const copy = withFreshItemKeys(teamField, structuredClone(original))

    expect(copy.name).toBe('Ada')
    expect(copy[ITEM_KEY]).not.toBe('a')
    expect(isItemKey(copy[ITEM_KEY])).toBe(true)
    const links = copy.links as Rec[]
    expect(links.map((l) => l.href)).toEqual(['/1', '/2'])
    expect(keyOf(links[0])).not.toBe('l1')
    expect(keyOf(links[1])).not.toBe('l2')
    expect(keyOf(links[0])).not.toBe(keyOf(links[1]))
    expect(original[ITEM_KEY]).toBe('a')
  })

  it('rekeys a block on the block and the lists in its value', () => {
    const original = {
      [ITEM_KEY]: 'b',
      template: 'hero',
      value: { title: 'T', buttons: [{ [ITEM_KEY]: 'btn', label: 'x' }] },
    }

    const copy = withFreshItemKeys(blocksField, structuredClone(original))

    expect(copy[ITEM_KEY]).not.toBe('b')
    expect(isItemKey(copy[ITEM_KEY])).toBe(true)
    expect(copy.value).not.toHaveProperty(ITEM_KEY)
    expect(keyOf((copy.value.buttons as Rec[])[0])).not.toBe('btn')
    expect(isItemKey(keyOf((copy.value.buttons as Rec[])[0]))).toBe(true)
  })
})

describe('itemKeysOnPath', () => {
  const value = withItemKeys(
    schema,
    {
      team: [
        { name: 'Ada', links: [{ href: '/a' }, { href: '/b' }] },
        { name: 'Bo', links: [{ href: '/c' }] },
      ],
      blocks: [
        { template: 'text', value: { body: 'x' } },
        { template: 'hero', value: { title: 'T', buttons: [{ label: 'go' }] } },
      ],
    },
    'random',
  )
  const team = items(value.team)
  const blocks = items(value.blocks)

  it('is empty for a path through no list', () => {
    expect(itemKeysOnPath(schema, value, 'title')).toEqual([])
  })

  it('names the item on a one-level path', () => {
    expect(itemKeysOnPath(schema, value, 'team[1].name')).toEqual([keyOf(team[1])])
  })

  it('names the items outermost first on a nested path', () => {
    const links = items(team[0].links)
    expect(itemKeysOnPath(schema, value, 'team[0].links[1].href')).toEqual([
      keyOf(team[0]),
      keyOf(links[1]),
    ])
  })

  it('names a block, and a list inside a block value', () => {
    const buttons = items((blocks[1].value as Rec).buttons)
    expect(itemKeysOnPath(schema, value, 'blocks[0].body')).toEqual([keyOf(blocks[0])])
    expect(itemKeysOnPath(schema, value, 'blocks[1].buttons[0].label')).toEqual([
      keyOf(blocks[1]),
      keyOf(buttons[0]),
    ])
  })

  it('accepts a dotted index', () => {
    expect(itemKeysOnPath(schema, value, 'team.1.name')).toEqual([keyOf(team[1])])
  })

  it('is undefined when an item on the path has no usable key', () => {
    const unkeyed = { team: [{ name: 'Ada' }] }
    expect(itemKeysOnPath(schema, unkeyed, 'team[0].name')).toBeUndefined()
    expect(
      itemKeysOnPath(schema, { team: [{ [ITEM_KEY]: '', name: 'A' }] }, 'team[0].name'),
    ).toBeUndefined()
  })

  it('is undefined when the path is not in the value', () => {
    expect(itemKeysOnPath(schema, value, 'team[7].name')).toBeUndefined()
    expect(itemKeysOnPath(schema, value, 'missing[0].name')).toBeUndefined()
    expect(itemKeysOnPath(schema, value, 'team.name')).toBeUndefined()
    expect(itemKeysOnPath(schema, value, 'blocks[0].body.deeper[0]')).toBeUndefined()
  })
})

describe('resolveThreadPath', () => {
  const build = (data: Rec) => withItemKeys(schema, data, 'random')

  const people = (names: string[]): Rec[] => names.map((name) => ({ name }))

  /** The thread's keys as they were when it was made on `path` of `value`. */
  const made = (value: Rec, path: string): string[] => {
    const keys = itemKeysOnPath(schema, value, path)
    if (!keys) throw new Error('no keys')
    return keys
  }

  it('follows an item that moved', () => {
    const value = build({ team: people(['Ada', 'Bo', 'Cy']) })
    const keys = made(value, 'team[1].name')
    const team = items(value.team)

    const moved = { ...value, team: [team[1], team[0], team[2]] }
    expect(resolveThreadPath(schema, moved, 'team[1].name', keys)).toBe('team[0].name')

    const shifted = { ...value, team: [{ [ITEM_KEY]: 'new', name: 'New' }, ...team] }
    expect(resolveThreadPath(schema, shifted, 'team[1].name', keys)).toBe('team[2].name')
  })

  it('returns null for a removed item, and still resolves the ones that remain', () => {
    const value = build({ team: people(['Ada', 'Bo', 'Cy']) })
    const team = items(value.team)
    const onBo = made(value, 'team[1].name')
    const onCy = made(value, 'team[2].name')

    const withoutBo = { ...value, team: [team[0], team[2]] }

    expect(resolveThreadPath(schema, withoutBo, 'team[1].name', onBo)).toBeNull()
    expect(resolveThreadPath(schema, withoutBo, 'team[2].name', onCy)).toBe('team[1].name')
  })

  it('does not match a key held by an item of another list', () => {
    const value = build({
      team: people(['Ada']),
      blocks: [{ template: 'text', value: { body: 'x' } }],
    })
    const onTeam = made(value, 'team[0].name')
    const blockKey = keyOf(items(value.blocks)[0])

    expect(resolveThreadPath(schema, value, 'team[0].name', [blockKey])).toBeNull()
    expect(resolveThreadPath(schema, value, 'team[0].name', onTeam)).toBe('team[0].name')
  })

  it('follows a nested item when both lists move', () => {
    const value = build({
      team: [
        { name: 'Ada', links: [{ href: '/a' }, { href: '/b' }] },
        { name: 'Bo', links: [{ href: '/c' }, { href: '/d' }] },
      ],
    })
    const keys = made(value, 'team[1].links[0].href')
    const [ada, bo] = items(value.team)
    const [c, d] = items(bo.links)

    const moved = { ...value, team: [{ ...bo, links: [d, c] }, ada] }

    expect(resolveThreadPath(schema, moved, 'team[1].links[0].href', keys)).toBe(
      'team[0].links[1].href',
    )
  })

  it('is null when only the nested item is gone, or only the outer item is gone', () => {
    const value = build({
      team: [
        { name: 'Ada', links: [{ href: '/a' }] },
        { name: 'Bo', links: [{ href: '/c' }] },
      ],
    })
    const keys = made(value, 'team[1].links[0].href')
    const [ada, bo] = items(value.team)

    expect(
      resolveThreadPath(
        schema,
        { ...value, team: [ada, { ...bo, links: [] }] },
        'team[1].links[0].href',
        keys,
      ),
    ).toBeNull()
    expect(
      resolveThreadPath(schema, { ...value, team: [ada] }, 'team[1].links[0].href', keys),
    ).toBeNull()
  })

  it('follows a block, on a path ending in a field of its template', () => {
    const value = build({
      blocks: [
        { template: 'text', value: { body: 'a' } },
        { template: 'text', value: { body: 'b' } },
        { template: 'hero', value: { title: 'T' } },
      ],
    })
    const keys = made(value, 'blocks[2].title')
    const blocks = items(value.blocks)

    const moved = { ...value, blocks: [blocks[2], blocks[0], blocks[1]] }
    expect(resolveThreadPath(schema, moved, 'blocks[2].title', keys)).toBe('blocks[0].title')

    const without = { ...value, blocks: [blocks[0], blocks[1]] }
    expect(resolveThreadPath(schema, without, 'blocks[2].title', keys)).toBeNull()
  })

  it('is null when the enclosing object was cleared', () => {
    const nested: FieldConfig[] = [
      {
        name: 'org',
        type: 'object',
        fields: [{ ...teamField, name: 'people' }],
      },
    ]
    const value = withItemKeys(nested, { org: { people: [{ name: 'Ada' }] } }, 'random')
    const keys = itemKeysOnPath(nested, value, 'org.people[0].name')!
    expect(keys).toHaveLength(1)

    expect(resolveThreadPath(nested, value, 'org.people[0].name', keys)).toBe('org.people[0].name')
    expect(resolveThreadPath(nested, { org: null }, 'org.people[0].name', keys)).toBeNull()
    expect(resolveThreadPath(nested, {}, 'org.people[0].name', keys)).toBeNull()
  })

  it('is null when the block no longer has its template', () => {
    const value = build({ blocks: [{ template: 'hero', value: { title: 'T' } }] })
    const keys = made(value, 'blocks[0].title')
    const key = keyOf(items(value.blocks)[0])

    const retemplated = { ...value, blocks: [{ [ITEM_KEY]: key, template: 'gone', value: {} }] }

    expect(resolveThreadPath(schema, retemplated, 'blocks[0].title', keys)).toBeNull()
  })

  it('returns a path with no keys as it is, whatever the value holds', () => {
    expect(resolveThreadPath(schema, {}, 'title', undefined)).toBe('title')
    expect(resolveThreadPath(schema, {}, 'title', [])).toBe('title')
    // Even a path through a list: with no keys to follow, the path is the thread's as stored.
    expect(resolveThreadPath(schema, {}, 'team[3].name', [])).toBe('team[3].name')
    expect(
      resolveThreadPath(schema, build({ team: people(['A']) }), 'team[0].name', undefined),
    ).toBe('team[0].name')
  })

  it('is null when the thread names fewer keys than the path has lists', () => {
    const value = build({ team: [{ name: 'Ada', links: [{ href: '/a' }] }] })
    const [outer] = made(value, 'team[0].links[0].href')

    expect(resolveThreadPath(schema, value, 'team[0].links[0].href', [outer])).toBeNull()
  })
})
