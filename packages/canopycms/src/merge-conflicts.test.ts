import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MergeConflictStore,
  MergeConflictsFileFormatError,
  OpenMergeConflictsError,
  assertNoOpenConflicts,
  conflictFilesOf,
  openConflictCount,
  withFoundConflicts,
  withRemappedItemKeys,
  withoutEntryConflict,
  withoutMergesGone,
  withoutResolvedFields,
  type FoundEntryConflict,
  type MergeConflictEntry,
} from './merge-conflicts'
import type { ContentId } from './paths/types'

const ID = 'aboutAbc1234' as ContentId
const OTHER = 'priceAbc1234' as ContentId
const [M1, M2] = ['1'.repeat(40), '2'.repeat(40)]

const fieldsFound = (
  sides: FoundEntryConflict['sides'],
  ...keys: string[]
): FoundEntryConflict => ({
  contentId: ID,
  path: 'content/page.home.aboutAbc1234.json',
  kind: 'fields',
  sides,
  fields: keys.map((key) => ({
    key,
    dataPath: [{ field: key }],
    sidePaths: { ancestor: [{ field: key }], base: [{ field: key }], branch: [{ field: key }] },
    kind: 'changed',
  })),
})

const paths = (key: string) => ({
  ancestor: [{ field: key }],
  base: [{ field: key }],
  branch: [{ field: key }],
})

const first = () =>
  withFoundConflicts(
    {},
    [fieldsFound({ ancestor: 'o1', base: 'a1', branch: 'b1' }, 'title', 'cta')],
    M1,
  )

describe('withFoundConflicts', () => {
  const first = withFoundConflicts(
    {},
    [fieldsFound({ ancestor: 'o1', base: 'a1', branch: 'b1' }, 'title', 'cta')],
    M1,
  )

  it('records each field with the merge that found it and its three blobs', () => {
    expect(first[ID]?.fields).toEqual([
      {
        key: 'title',
        dataPath: [{ field: 'title' }],
        sidePaths: paths('title'),
        kind: 'changed',
        mergeSha: M1,
        sides: { ancestor: 'o1', base: 'a1', branch: 'b1' },
      },
      {
        key: 'cta',
        dataPath: [{ field: 'cta' }],
        sidePaths: paths('cta'),
        kind: 'changed',
        mergeSha: M1,
        sides: { ancestor: 'o1', base: 'a1', branch: 'b1' },
      },
    ])
  })

  it('keeps a field the next merge did not find, and renews one it found from the first ancestor', () => {
    // The second merge reads each version's place elsewhere; the first ancestor's path stays with
    // the first ancestor's blob.
    const found = fieldsFound({ ancestor: 'o2', base: 'a2', branch: 'b2' }, 'title')
    found.fields![0].sidePaths = {
      ancestor: [{ field: 'o2' }],
      base: [{ field: 'a2' }],
      branch: [{ field: 'b2' }],
    }
    const next = withFoundConflicts(first, [found], M2)
    expect(next[ID]?.mergeSha).toBe(M2)
    expect(next[ID]?.fields).toEqual([
      { ...first[ID]!.fields![1] },
      {
        key: 'title',
        dataPath: [{ field: 'title' }],
        sidePaths: {
          ancestor: [{ field: 'title' }],
          base: [{ field: 'a2' }],
          branch: [{ field: 'b2' }],
        },
        kind: 'changed',
        mergeSha: M2,
        sides: { ancestor: 'o1', base: 'a2', branch: 'b2' },
      },
    ])
  })

  it('keeps no ancestor path for a field whose first ancestor had no value there', () => {
    const none = fieldsFound({ base: 'a1', branch: 'b1' }, 'title')
    none.fields![0].sidePaths = { base: [{ field: 'title' }], branch: [{ field: 'title' }] }
    const found = withFoundConflicts({}, [none], M1)
    const next = withFoundConflicts(
      found,
      [fieldsFound({ ancestor: 'o2', base: 'a2', branch: 'b2' }, 'title')],
      M2,
    )
    expect(next[ID]?.fields?.[0].sides.ancestor).toBeUndefined()
    expect(next[ID]?.fields?.[0].sidePaths.ancestor).toBeUndefined()
  })

  it('replaces an entry with an entry-level conflict, and a deleted entry’s with fields found later', () => {
    const deleted = withFoundConflicts(
      first,
      [{ contentId: ID, path: 'p', kind: 'deleted-on-base', sides: { branch: 'b2' } }],
      M2,
    )
    expect(deleted[ID]).toEqual({
      path: 'p',
      mergeSha: M2,
      kind: 'deleted-on-base',
      sides: { branch: 'b2' },
      previous: first[ID],
    })
    const again = withFoundConflicts(
      deleted,
      [fieldsFound({ ancestor: 'o3', base: 'a3', branch: 'b3' }, 'title')],
      M1,
    )
    // The base brought the entry back, so the deletion is no choice left to make.
    expect(again[ID]).toMatchObject({ kind: 'fields', mergeSha: M1, previous: deleted[ID] })
    expect(again[ID]?.fields?.map((f) => f.key)).toEqual(['title'])
    const unreadable = withFoundConflicts(
      {},
      [{ contentId: ID, path: 'p', kind: 'unreadable', sides: { ancestor: 'o1', base: 'a1' } }],
      M1,
    )
    const later = withFoundConflicts(
      unreadable,
      [fieldsFound({ ancestor: 'o2', base: 'a2', branch: 'b2' }, 'title')],
      M2,
    )
    expect(later[ID]).toMatchObject({
      kind: 'unreadable',
      mergeSha: M2,
      sides: { ancestor: 'o1', base: 'a2', branch: 'b2' },
    })
    expect(later[ID]?.fields).toBeUndefined()
  })

  it('moves the records of entries the merge moved, and leaves the rest', () => {
    const moved = withFoundConflicts(first, [], M2, new Map([[ID, 'content/new.json']]))
    expect(moved[ID]).toEqual({
      ...first[ID],
      path: 'content/new.json',
      mergeSha: M2,
      previous: first[ID],
    })
    expect(withFoundConflicts(first, [], M2, new Map([[ID, first[ID]!.path]]))).toEqual(first)
  })
})

describe('withoutMergesGone', () => {
  it('gives back the record a merge the branch never got replaced, and drops it once one lands', () => {
    const renewed = withFoundConflicts(
      first(),
      [fieldsFound({ ancestor: 'o2', base: 'a2', branch: 'b2' }, 'title')],
      M2,
    )
    expect(withoutMergesGone(renewed, (sha) => sha === M1)).toEqual(first())
    const landed = withoutMergesGone(renewed, () => true)
    expect(landed[ID]?.previous).toBeUndefined()
    expect(landed[ID]?.mergeSha).toBe(M2)
    const created = withFoundConflicts({}, [fieldsFound({}, 'title')], M2)
    expect(withoutMergesGone(created, (sha) => sha === M1)).toEqual({})
  })

  const entries: Record<string, MergeConflictEntry> = {
    [ID]: {
      ...withFoundConflicts({}, [fieldsFound({}, 'title')], M1)[ID]!,
      fields: [
        { key: 'title', dataPath: [], sidePaths: {}, kind: 'changed', mergeSha: M1, sides: {} },
        { key: 'cta', dataPath: [], sidePaths: {}, kind: 'changed', mergeSha: M2, sides: {} },
      ],
    },
    [OTHER]: { path: 'q', mergeSha: M2, kind: 'unreadable', sides: {} },
  }

  it('drops the fields and entries of a merge the branch does not hold', () => {
    const kept = withoutMergesGone(entries, (sha) => sha === M1)
    expect(Object.keys(kept)).toEqual([ID])
    expect(kept[ID]?.fields?.map(({ key }) => key)).toEqual(['title'])
  })

  it('drops an entry left with no fields', () => {
    expect(withoutMergesGone(entries, () => false)).toEqual({})
  })
})

describe('conflictFilesOf', () => {
  it('names the entries with conflicts open, sorted', () => {
    expect(
      conflictFilesOf({ [OTHER]: {} as MergeConflictEntry, [ID]: {} as MergeConflictEntry }),
    ).toEqual({
      conflictStatus: 'conflicts-detected',
      conflictFiles: [ID, OTHER],
    })
    expect(conflictFilesOf({})).toEqual({ conflictStatus: 'clean', conflictFiles: [] })
  })
})

describe('MergeConflictStore', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-merge-conflicts-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reads none before the first write, then what each write left, under a version', async () => {
    const store = new MergeConflictStore(root, 0)
    expect(await store.read()).toBeNull()
    const entries = withFoundConflicts({}, [fieldsFound({}, 'title')], M1)

    await store.update((current) => (current === null ? { entries } : null))
    expect(await store.read()).toMatchObject({ version: 1, entries })
    expect(await store.update(() => null)).toBeNull()
    expect((await store.read())?.version).toBe(1)
    await store.update(() => ({ entries: {} }))
    expect(await store.read()).toMatchObject({ version: 2, entries: {} })
  })

  it('refuses a field that names no side paths, as one this code did not write', async () => {
    await fs.mkdir(path.join(root, '.canopy-meta'))
    const field = { key: 'title', dataPath: [], kind: 'changed', mergeSha: M1, sides: {} }
    const record = {
      schema: 2,
      version: 1,
      entries: { [ID]: { path: 'p', mergeSha: M1, kind: 'fields', sides: {}, fields: [field] } },
    }
    const file = path.join(root, '.canopy-meta', 'merge-conflicts.json')
    await fs.writeFile(file, JSON.stringify(record))
    await expect(new MergeConflictStore(root).read()).rejects.toThrow(/malformed/)
    record.entries[ID].fields[0] = { ...field, sidePaths: {} } as typeof field
    await fs.writeFile(file, JSON.stringify(record))
    await expect(new MergeConflictStore(root).read()).resolves.toMatchObject({ version: 1 })
  })

  it('refuses a record of another format, and one holding a member this code does not write', async () => {
    await fs.mkdir(path.join(root, '.canopy-meta'))
    const file = path.join(root, '.canopy-meta', 'merge-conflicts.json')
    await fs.writeFile(file, JSON.stringify({ schema: 1, version: 1, entries: {} }))
    await expect(new MergeConflictStore(root).read()).rejects.toBeInstanceOf(
      MergeConflictsFileFormatError,
    )
    await expect(assertNoOpenConflicts(root)).rejects.toMatchObject({ count: null })
    await fs.writeFile(file, JSON.stringify({ schema: 2, version: 1, entries: {}, extra: 1 }))
    await expect(new MergeConflictStore(root).read()).rejects.toThrow(/malformed/)
    await fs.writeFile(file, JSON.stringify({ schema: 2, version: 1, entries: {} }))
    await expect(new MergeConflictStore(root).read()).resolves.toMatchObject({ entries: {} })
  })

  it('holds the branch once a record that does not parse is set aside, until a release', async () => {
    await fs.mkdir(path.join(root, '.canopy-meta'))
    await fs.writeFile(path.join(root, '.canopy-meta', 'merge-conflicts.json'), '{"oops"')
    const store = new MergeConflictStore(root, 0)
    const aside = await store.quarantine()
    expect(await fs.readFile(aside, 'utf8')).toBe('{"oops"')
    expect((await store.read())?.held).toMatchObject({ aside: path.basename(aside) })
    await expect(assertNoOpenConflicts(root)).rejects.toMatchObject({
      count: null,
      held: true,
      message: expect.stringContaining('on hold until an admin releases it'),
    })
    // A write that leaves it out keeps it, as a merge's does; only one that names it releases it.
    await store.update((current) => current && { ...current, remaps: [] })
    await store.update(() => ({ entries: {} }))
    expect((await store.read())?.held).toBeDefined()
    await store.update((current) => current && { ...current, held: undefined })
    expect((await store.read())?.held).toBeUndefined()
    await expect(assertNoOpenConflicts(root)).resolves.toBeUndefined()
  })

  it('leaves a record that refuses the gate whichever step of setting one aside fails', async () => {
    const file = path.join(root, '.canopy-meta', 'merge-conflicts.json')
    await fs.mkdir(path.dirname(file))
    for (const step of ['copyFile', 'writeFile', 'link', 'rename'] as const) {
      await fs.writeFile(file, '{"oops"')
      const spy = vi.spyOn(fs, step).mockRejectedValueOnce(new Error(`killed at ${step}`))
      await expect(new MergeConflictStore(root, 0).quarantine()).rejects.toThrow(
        `killed at ${step}`,
      )
      spy.mockRestore()
      await expect(fs.readFile(file, 'utf8')).resolves.toBe('{"oops"')
      await expect(assertNoOpenConflicts(root)).rejects.toMatchObject({ count: null })
    }
    // The next cycle sets it aside again, and the branch is held.
    await new MergeConflictStore(root, 0).quarantine()
    await expect(assertNoOpenConflicts(root)).rejects.toMatchObject({ held: true })
  })

  it('refuses a file that is not a record, rather than reading it as none', async () => {
    await fs.mkdir(path.join(root, '.canopy-meta'))
    const file = path.join(root, '.canopy-meta', 'merge-conflicts.json')
    await fs.writeFile(file, '{"version":1,"entries":{"x":{"path":1}}}')
    await expect(new MergeConflictStore(root).read()).rejects.toThrow(/malformed/)
    await fs.writeFile(file, 'not json')
    await expect(new MergeConflictStore(root).read()).rejects.toThrow(/not JSON/)
  })
})

describe('withoutResolvedFields', () => {
  const entries = withFoundConflicts(
    {},
    [fieldsFound({ ancestor: 'o1', base: 'a1', branch: 'b1' }, 'title', 'cta')],
    M1,
  )

  it('takes off the fields named by their own merge and key, and keeps the rest', () => {
    const { entries: left, cleared } = withoutResolvedFields(entries, ID, [
      { mergeSha: M1, key: 'title' },
    ])
    expect(cleared).toEqual([{ mergeSha: M1, key: 'title' }])
    expect(left[ID]?.fields?.map((f) => f.key)).toEqual(['cta'])
    expect(entries[ID]?.fields).toHaveLength(2)
  })

  it('ignores a pair whose merge or key the record no longer holds', () => {
    const { entries: left, cleared } = withoutResolvedFields(entries, ID, [
      { mergeSha: M2, key: 'title' },
      { mergeSha: M1, key: 'summary' },
    ])
    expect(cleared).toEqual([])
    expect(left).toEqual(entries)
  })

  it('drops the record once no field is left, its previous with it', () => {
    const renewed = withFoundConflicts(
      entries,
      [fieldsFound({ ancestor: 'o2', base: 'a2', branch: 'b2' }, 'title')],
      M2,
    )
    expect(renewed[ID]?.previous).toBeDefined()
    const { entries: left, cleared } = withoutResolvedFields(renewed, ID, [
      { mergeSha: M2, key: 'title' },
      { mergeSha: M1, key: 'cta' },
    ])
    expect(cleared).toHaveLength(2)
    expect(left).toEqual({})
  })

  it('keeps a partly resolved record’s previous, for a merge that never lands', () => {
    const renewed = withFoundConflicts(
      entries,
      [fieldsFound({ ancestor: 'o2', base: 'a2', branch: 'b2' }, 'title')],
      M2,
    )
    const { entries: left } = withoutResolvedFields(renewed, ID, [{ mergeSha: M1, key: 'cta' }])
    expect(left[ID]?.previous).toEqual(renewed[ID]?.previous)
  })

  it('leaves an entry-level record to resolve-entry', () => {
    const deleted = withFoundConflicts(
      {},
      [{ contentId: ID, path: 'p', kind: 'deleted-on-base', sides: {} }],
      M1,
    )
    expect(withoutResolvedFields(deleted, ID, [{ mergeSha: M1, key: 'title' }]).cleared).toEqual([])
  })
})

describe('withoutEntryConflict', () => {
  const deleted = withFoundConflicts(
    {},
    [{ contentId: ID, path: 'p', kind: 'deleted-on-base', sides: {} }],
    M1,
  )

  it('takes off an entry-level record the named merge last changed', () => {
    expect(withoutEntryConflict(deleted, ID, M1)).toEqual({})
  })

  it('refuses one a later merge changed, one that is not there, and a fields record', () => {
    expect(withoutEntryConflict(deleted, ID, M2)).toBeNull()
    expect(withoutEntryConflict(deleted, OTHER, M1)).toBeNull()
    expect(withoutEntryConflict(first(), ID, M1)).toBeNull()
  })
})

describe('openConflictCount', () => {
  it('counts each field, and each entry-level conflict once', () => {
    const entries = withFoundConflicts(
      {},
      [
        fieldsFound({}, 'title', 'cta'),
        { contentId: OTHER, path: 'q', kind: 'unreadable', sides: {} },
      ],
      M1,
    )
    expect(openConflictCount(entries)).toBe(3)
    expect(openConflictCount({})).toBe(0)
  })
})

describe('resolving against the record, concurrently', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-merge-conflicts-race-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const keys = Array.from({ length: 10 }, (_, i) => `field${i}`)
  const seed = () =>
    new MergeConflictStore(root, 0).update(() => ({
      entries: withFoundConflicts({}, [fieldsFound({}, ...keys)], M1),
    }))
  /** A save's clear, as `clearFieldConflicts` makes it, from its own store instance. */
  const clear = (key: string, mergeSha = M1, at = root) =>
    new MergeConflictStore(at, 0).update((current) => {
      if (current === null) return null
      const next = withoutResolvedFields(current.entries, ID, [{ mergeSha, key }])
      return next.cleared.length > 0 ? { ...current, entries: next.entries } : null
    })
  /** A merge's record write, as the worker makes it. */
  const merge = (mergeSha: string, ...found: string[]) =>
    new MergeConflictStore(root, 0).update((current) => ({
      ...current,
      entries: withFoundConflicts(current?.entries ?? {}, [fieldsFound({}, ...found)], mergeSha),
    }))
  const openKeys = async () =>
    ((await new MergeConflictStore(root).read())?.entries[ID]?.fields ?? []).map((f) => f.key)

  it('loses no clear when many saves clear fields at once', async () => {
    await seed()
    await Promise.all(keys.map((key) => clear(key)))
    expect(await new MergeConflictStore(root).read()).toMatchObject({ entries: {} })
  })

  it('loses neither a clear nor a merge that race', async () => {
    await seed()
    await Promise.all([clear('field0'), merge(M2, 'summary'), clear('field1')])
    const open = await openKeys()
    expect(open).toContain('summary')
    expect(open).not.toContain('field0')
    expect(open).not.toContain('field1')
    expect(open).toHaveLength(keys.length - 2 + 1)
  })

  it('keeps a field a racing merge found again open, whichever lands first', async () => {
    for (const order of [0, 1]) {
      await seed()
      const steps = [() => clear('field0'), () => merge(M2, 'field0')]
      await Promise.all(order === 0 ? steps.map((s) => s()) : steps.reverse().map((s) => s()))
      const record = (await new MergeConflictStore(root).read())?.entries[ID]
      expect(record?.fields?.find((f) => f.key === 'field0')?.mergeSha).toBe(M2)
    }
  })

  it('serializes clears across differently-spelled paths to one branch root', async () => {
    await seed()
    await Promise.all(keys.map((key, i) => clear(key, M1, i % 2 ? root : path.join(root, '.'))))
    expect(await openKeys()).toEqual([])
  })

  it('leaves no lock artifacts after a clear', async () => {
    await seed()
    await clear('field0')
    const names = await fs.readdir(path.join(root, '.canopy-meta'))
    expect(names.filter((n) => n.includes('.lock'))).toEqual([])
  })
})

describe('assertNoOpenConflicts', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-merge-conflicts-gate-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('passes with no record and with an empty one, and counts what is open', async () => {
    await expect(assertNoOpenConflicts(root)).resolves.toBeUndefined()
    await new MergeConflictStore(root, 0).update(() => ({ entries: {} }))
    await expect(assertNoOpenConflicts(root)).resolves.toBeUndefined()
    await new MergeConflictStore(root, 0).update(() => ({ entries: first() }))
    await expect(assertNoOpenConflicts(root)).rejects.toMatchObject({
      name: 'OpenMergeConflictsError',
      count: 2,
      message: '2 changes on this branch conflict with newer changes on the site.',
    })
  })

  it('refuses a record that does not parse, with no count', async () => {
    await fs.mkdir(path.join(root, '.canopy-meta'))
    await fs.writeFile(path.join(root, '.canopy-meta', 'merge-conflicts.json'), 'not json')
    const err = await assertNoOpenConflicts(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpenMergeConflictsError)
    expect(err).toMatchObject({ count: null })
  })
})

describe('withRemappedItemKeys', () => {
  const itemField = (
    key: string,
    dataPath: NonNullable<FoundEntryConflict['fields']>[number]['dataPath'],
  ): FoundEntryConflict => ({
    contentId: ID,
    path: 'content/page.home.aboutAbc1234.json',
    kind: 'fields',
    sides: { ancestor: 'o1', base: 'a1', branch: 'b1' },
    fields: [
      {
        key,
        dataPath,
        sidePaths: { ancestor: dataPath, base: dataPath, branch: dataPath },
        kind: 'changed',
      },
    ],
  })
  const recorded = withFoundConflicts(
    {},
    [
      itemField('items.hOld1.links.hIn1.href', [
        { field: 'items' },
        { item: 'hOld1' },
        { field: 'links' },
        { item: 'hIn1' },
        { field: 'href' },
      ]),
    ],
    M1,
  )

  it('renames a remapped item key in the key and data path of a conflict on record', () => {
    const renamed = withRemappedItemKeys(
      recorded,
      [{ contentId: ID, remaps: [{ within: [], from: 'hOld1', to: 'hNew1' }] }],
      M2,
    )
    expect(renamed[ID]?.fields?.map((f) => [f.key, f.dataPath])).toEqual([
      [
        'items.hNew1.links.hIn1.href',
        [
          { field: 'items' },
          { item: 'hNew1' },
          { field: 'links' },
          { item: 'hIn1' },
          { field: 'href' },
        ],
      ],
    ])
    expect(renamed[ID]?.mergeSha).toBe(M2)
    expect(renamed[ID]?.previous).toEqual(recorded[ID])
    // Each version's own path addresses its stored blob, which keeps its keys.
    expect(renamed[ID]?.fields?.[0].sidePaths).toEqual(recorded[ID]?.fields?.[0].sidePaths)
  })

  it('renames an inner item only inside the outer item the remap names, inner first', () => {
    const remaps = [
      { within: ['hOld1'], from: 'hIn1', to: 'hIn2' },
      { within: [], from: 'hOld1', to: 'hNew1' },
    ]
    expect(
      withRemappedItemKeys(recorded, [{ contentId: ID, remaps }], M2)[ID]?.fields?.[0].key,
    ).toBe('items.hNew1.links.hIn2.href')
    const elsewhere = [{ within: ['hOther'], from: 'hIn1', to: 'hIn2' }]
    expect(withRemappedItemKeys(recorded, [{ contentId: ID, remaps: elsewhere }], M2)[ID]).toBe(
      recorded[ID],
    )
  })

  it('matches every remap against the path on record: the first wins, and none compounds', () => {
    const key = (remaps: Array<{ within: string[]; from: string; to: string }>) =>
      withRemappedItemKeys(recorded, [{ contentId: ID, remaps }], M2)[ID]?.fields?.[0].key
    // As the comment store applies them (`remapItemKeys`): the first match for a thread's keys.
    expect(
      key([
        { within: [], from: 'hOld1', to: 'hFirst' },
        { within: [], from: 'hOld1', to: 'hSecond' },
      ]),
    ).toBe('items.hFirst.links.hIn1.href')
    expect(
      key([
        { within: [], from: 'hOld1', to: 'hMid1' },
        { within: [], from: 'hMid1', to: 'hNew1' },
      ]),
    ).toBe('items.hMid1.links.hIn1.href')
  })

  it('leaves records it renames nothing in, and other entries, as they were', () => {
    const remaps = [{ contentId: OTHER, remaps: [{ within: [], from: 'hOld1', to: 'hNew1' }] }]
    expect(withRemappedItemKeys(recorded, remaps, M2)[ID]).toBe(recorded[ID])
  })

  it('lets a conflict found again under the new key replace the one on record', () => {
    const renamed = withRemappedItemKeys(
      recorded,
      [{ contentId: ID, remaps: [{ within: [], from: 'hOld1', to: 'hNew1' }] }],
      M2,
    )
    const again = withFoundConflicts(
      renamed,
      [
        itemField('items.hNew1.links.hIn1.href', [
          { field: 'items' },
          { item: 'hNew1' },
          { field: 'links' },
          { item: 'hIn1' },
          { field: 'href' },
        ]),
      ],
      M2,
    )
    expect(again[ID]?.fields?.map((f) => f.key)).toEqual(['items.hNew1.links.hIn1.href'])
    expect(again[ID]?.fields?.[0].sides.ancestor).toBe('o1')
  })

  it('renames the item token, never a field or an outer item of the same name', () => {
    const faq = withFoundConflicts(
      {},
      [itemField('faq.faq.answer', [{ field: 'faq' }, { item: 'faq' }, { field: 'answer' }])],
      M1,
    )
    const remaps = [{ contentId: ID, remaps: [{ within: [], from: 'faq', to: 'NEW' }] }]
    expect(withRemappedItemKeys(faq, remaps, M2)[ID]?.fields?.[0].key).toBe('faq.NEW.answer')
    const nested = withFoundConflicts(
      {},
      [
        itemField('items.a.links.a.href', [
          { field: 'items' },
          { item: 'a' },
          { field: 'links' },
          { item: 'a' },
          { field: 'href' },
        ]),
      ],
      M1,
    )
    const inner = [{ contentId: ID, remaps: [{ within: ['a'], from: 'a', to: 'b' }] }]
    expect(withRemappedItemKeys(nested, inner, M2)[ID]?.fields?.[0].key).toBe(
      'items.a.links.b.href',
    )
  })

  it('counts the key tokens past a block data step, which has none', () => {
    const block = withFoundConflicts(
      {},
      [
        itemField('blocks.b1.items.i1.t', [
          { field: 'blocks' },
          { item: 'b1' },
          { blockData: true },
          { field: 'items' },
          { item: 'i1' },
          { field: 't' },
        ]),
      ],
      M1,
    )
    const remaps = [{ contentId: ID, remaps: [{ within: ['b1'], from: 'i1', to: 'i2' }] }]
    expect(withRemappedItemKeys(block, remaps, M2)[ID]?.fields?.[0].key).toBe(
      'blocks.b1.items.i2.t',
    )
  })

  it('matches every remap against the keys before the merge, as the comment store does', () => {
    const remaps = [
      {
        contentId: ID,
        remaps: [
          { within: [], from: 'hOld1', to: 'hMid1' },
          { within: [], from: 'hMid1', to: 'hNew1' },
        ],
      },
    ]
    expect(withRemappedItemKeys(recorded, remaps, M2)[ID]?.fields?.[0].key).toBe(
      'items.hMid1.links.hIn1.href',
    )
  })

  it('gives the old keys back when the merge that renamed them never lands', () => {
    const renamed = withRemappedItemKeys(
      recorded,
      [{ contentId: ID, remaps: [{ within: [], from: 'hOld1', to: 'hNew1' }] }],
      M2,
    )
    expect(withoutMergesGone(renamed, (sha) => sha === M1)[ID]?.fields?.[0].key).toBe(
      'items.hOld1.links.hIn1.href',
    )
  })
})
