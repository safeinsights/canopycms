import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MergeConflictStore,
  conflictFilesOf,
  withFoundConflicts,
  withoutMergesGone,
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
  fields: keys.map((key) => ({ key, dataPath: [{ field: key }], kind: 'changed' })),
})

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
        kind: 'changed',
        mergeSha: M1,
        sides: { ancestor: 'o1', base: 'a1', branch: 'b1' },
      },
      {
        key: 'cta',
        dataPath: [{ field: 'cta' }],
        kind: 'changed',
        mergeSha: M1,
        sides: { ancestor: 'o1', base: 'a1', branch: 'b1' },
      },
    ])
  })

  it('keeps a field the next merge did not find, and renews one it found from the first ancestor', () => {
    const next = withFoundConflicts(
      first,
      [fieldsFound({ ancestor: 'o2', base: 'a2', branch: 'b2' }, 'title')],
      M2,
    )
    expect(next[ID]?.mergeSha).toBe(M2)
    expect(next[ID]?.fields).toEqual([
      { ...first[ID]!.fields![1] },
      {
        key: 'title',
        dataPath: [{ field: 'title' }],
        kind: 'changed',
        mergeSha: M2,
        sides: { ancestor: 'o1', base: 'a2', branch: 'b2' },
      },
    ])
  })

  it('replaces an entry with an entry-level conflict, and that with fields found later', () => {
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
    })
    const again = withFoundConflicts(deleted, [fieldsFound({ ancestor: 'o3' }, 'title')], M1)
    expect(again[ID]?.fields?.map(({ key, sides }) => ({ key, sides }))).toEqual([
      { key: 'title', sides: { ancestor: 'o3' } },
    ])
  })

  it('moves the records of entries the merge moved, and leaves the rest', () => {
    const moved = withFoundConflicts(first, [], M2, new Map([[ID, 'content/new.json']]))
    expect(moved[ID]).toEqual({ ...first[ID], path: 'content/new.json' })
  })
})

describe('withoutMergesGone', () => {
  const entries: Record<string, MergeConflictEntry> = {
    [ID]: {
      ...withFoundConflicts({}, [fieldsFound({}, 'title')], M1)[ID]!,
      fields: [
        { key: 'title', dataPath: [], kind: 'changed', mergeSha: M1, sides: {} },
        { key: 'cta', dataPath: [], kind: 'changed', mergeSha: M2, sides: {} },
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

    await store.update((current) => (current === null ? entries : null))
    expect(await store.read()).toMatchObject({ version: 1, entries })
    expect(await store.update(() => null)).toBeNull()
    expect((await store.read())?.version).toBe(1)
    await store.update(() => ({}))
    expect(await store.read()).toMatchObject({ version: 2, entries: {} })
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
