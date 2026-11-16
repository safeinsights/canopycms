import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BranchMetadataCorruptError,
  readBranchMetadataFile,
  salvageBranchMetadata,
} from './branch-metadata-file'

describe('readBranchMetadataFile', () => {
  let branchRoot: string

  beforeEach(async () => {
    branchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branch-meta-file-'))
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(branchRoot, { recursive: true, force: true })
  })

  const writeRaw = (raw: string) =>
    fs.writeFile(path.join(branchRoot, '.canopy-meta', 'branch.json'), raw, 'utf8')

  const writeFile = (file: unknown) => writeRaw(JSON.stringify(file))

  const fullBranch = {
    name: 'feature-a',
    status: 'editing',
    access: { allowedUsers: ['u1'], allowedGroups: ['g1'], managerOrAdminAllowed: false },
    createdBy: 'u1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  }

  const readCorrupt = async (): Promise<BranchMetadataCorruptError> => {
    const err = await readBranchMetadataFile(branchRoot).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BranchMetadataCorruptError)
    return err as BranchMetadataCorruptError
  }

  it('returns null when branch.json does not exist', async () => {
    await fs.rm(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    expect(await readBranchMetadataFile(branchRoot)).toBeNull()
  })

  it('reads a complete file, every optional field included', async () => {
    const branch = {
      ...fullBranch,
      title: 'T',
      description: 'D',
      baseBranch: 'main',
      pullRequestUrl: 'https://example.test/pr/1',
      pullRequestNumber: 1,
      submittedAt: '2026-10-03T00:00:00.000Z',
      pushedToGitHubAt: '2026-10-03T00:00:01.000Z',
      syncStatus: 'sync-failed',
      conflictStatus: 'conflicts-detected',
      conflictFiles: ['abc123def456'],
      pullRequestState: 'open',
      mergedAt: '2026-10-04T00:00:00.000Z',
      rebaseFailure: { message: 'm', firstAt: 'a', lastAt: 'b' },
      historyRewrittenFrom: 'deadbeef',
      syncFailureReason: 'rejected',
    }
    await writeFile({ schemaVersion: 1, version: 3, writeId: 'w', branch })

    expect(await readBranchMetadataFile(branchRoot)).toEqual({
      schemaVersion: 1,
      version: 3,
      writeId: 'w',
      branch,
    })
  })

  it('defaults the envelope and the bookkeeping fields a hand-written file can omit', async () => {
    await writeFile({ branch: { name: 'feature-a', status: 'submitted', access: {} } })

    const file = await readBranchMetadataFile(branchRoot)
    expect(file).toEqual({
      schemaVersion: 1,
      version: 0,
      branch: {
        name: 'feature-a',
        status: 'submitted',
        access: {},
        createdBy: 'unknown',
        createdAt: '1970-01-01T00:00:00.000Z',
        updatedAt: '1970-01-01T00:00:00.000Z',
      },
    })
  })

  it('keeps fields it does not know, at both levels', async () => {
    await writeFile({
      schemaVersion: 1,
      version: 1,
      extra: 1,
      branch: { ...fullBranch, next: 'x' },
    })

    expect(await readBranchMetadataFile(branchRoot)).toMatchObject({
      extra: 1,
      branch: { next: 'x' },
    })
  })

  it('reads a pull request hold, and drops a malformed one rather than failing the read', async () => {
    const hold = { kind: 'retargeted', base: 'release' }
    await writeFile({
      schemaVersion: 1,
      version: 1,
      branch: { ...fullBranch, pullRequestHold: hold },
    })
    expect((await readBranchMetadataFile(branchRoot))?.branch.pullRequestHold).toEqual(hold)

    for (const bad of ['conflicts', { kind: 'unheard-of' }, { kind: 'retargeted' }]) {
      await writeFile({
        schemaVersion: 1,
        version: 1,
        branch: { ...fullBranch, pullRequestHold: bad },
      })
      const read = await readBranchMetadataFile(branchRoot)
      expect(read?.branch.name).toBe('feature-a')
      expect(read?.branch.pullRequestHold).toBeUndefined()
    }
  })

  it('reads a review, and drops a malformed one rather than failing the read', async () => {
    const review = {
      state: 'approved',
      by: { userId: 'rev1', name: 'Rae' },
      at: '2026-10-28T14:05:00Z',
    }
    await writeFile({ schemaVersion: 1, version: 1, branch: { ...fullBranch, review } })
    expect((await readBranchMetadataFile(branchRoot))?.branch.review).toEqual(review)

    for (const bad of [
      { ...review, state: 'rejected' },
      { ...review, by: 'rev1' },
      { state: 'approved', by: { userId: 'rev1' } },
      'approved',
    ]) {
      await writeFile({ schemaVersion: 1, version: 1, branch: { ...fullBranch, review: bad } })
      const read = await readBranchMetadataFile(branchRoot)
      expect(read?.branch.name).toBe('feature-a')
      expect(read?.branch.review).toBeUndefined()
    }
  })

  it('raises BranchMetadataCorruptError for invalid JSON, saying so in plain words', async () => {
    await writeRaw('{ not json')
    const err = await readCorrupt()
    expect(err.parseCause).toMatch(/^Not valid JSON: /)
    expect(err.parseCause).not.toContain(branchRoot)
  })

  it.each([
    ['status is missing', { ...fullBranch, status: undefined }, 'Missing: branch.status'],
    ['status is not a known status', { ...fullBranch, status: 'open' }, 'Invalid: branch.status'],
    ['name is missing', { ...fullBranch, name: undefined }, 'Missing: branch.name'],
    ['name is empty', { ...fullBranch, name: '' }, 'Invalid: branch.name'],
    ['access is missing', { ...fullBranch, access: undefined }, 'Missing: branch.access'],
    [
      'an ACL is the wrong type',
      { ...fullBranch, access: { allowedUsers: 'u1' } },
      'Invalid: branch.access.allowedUsers',
    ],
    [
      'an optional field is the wrong type',
      { ...fullBranch, submittedAt: 5 },
      'Invalid: branch.submittedAt',
    ],
  ])('raises BranchMetadataCorruptError when %s', async (_label, branch, cause) => {
    await writeFile({ schemaVersion: 1, version: 1, branch })
    const err = await readCorrupt()
    expect(err.parseCause).toBe(`Not branch metadata. ${cause}`)
  })

  it.each([
    ['the branch object is missing', { schemaVersion: 1, version: 1, committed: true }],
    ['the file is an array', []],
    ['the file is null', null],
    ['the version is not a number', { version: '1', branch: fullBranch }],
  ])('raises BranchMetadataCorruptError when %s', async (_label, file) => {
    await writeFile(file)
    const err = await readCorrupt()
    expect(err.parseCause).toMatch(/^Not branch metadata\. /)
  })

  it('names every bad field, missing ones first', async () => {
    await writeFile({ branch: { name: 7, access: {} } })
    const err = await readCorrupt()
    expect(err.parseCause).toBe('Not branch metadata. Missing: branch.status. Invalid: branch.name')
  })

  it('rethrows other read failures unchanged', async () => {
    await fs.mkdir(path.join(branchRoot, '.canopy-meta', 'branch.json'))
    const err = await readBranchMetadataFile(branchRoot).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).not.toBeInstanceOf(BranchMetadataCorruptError)
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR')
  })
})

describe('salvageBranchMetadata', () => {
  const nothing = {
    access: { readable: false, narrowing: {}, mayRestrict: false, lockdownUnreadable: false },
    fields: {},
    unknownFields: {},
    unreadable: [],
  }
  const salvage = (file: unknown) => salvageBranchMetadata(JSON.stringify(file))
  const removal = { by: 'admin', at: '2026-11-01T00:00:00.000Z', byAdmin: true }
  const damaged = (narrowing: object, mayRestrict = false, lockdownUnreadable = false) => ({
    readable: false,
    narrowing,
    mayRestrict,
    lockdownUnreadable,
  })

  it.each([
    ['text that is not JSON', 'not json {{{'],
    ['JSON that is not an object', '[1, 2]'],
    ['no branch', '{}'],
    ['a branch that is an array', '{"branch": []}'],
    ['a branch that is null', '{"branch": null}'],
  ])('salvages nothing from %s', (_case, raw) => {
    expect(salvageBranchMetadata(raw)).toEqual(nothing)
  })

  it('reads a missing access as absent, suggesting no restriction', () => {
    expect(salvage({ branch: { createdBy: 'alice' } })).toEqual({
      ...nothing,
      fields: { createdBy: 'alice' },
    })
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'restricted'],
  ])('reads an access that is %s as one that may have restricted', (_case, access) => {
    expect(salvage({ branch: { access } }).access).toEqual(damaged({}, true))
  })

  it('keeps an access that passes whole, unknown keys included', () => {
    const access = { restricted: true, allowedUsers: ['alice'], futureKey: 1 }
    expect(salvage({ branch: { access } }).access).toEqual({ readable: true, access })
  })

  it('keeps each narrowing field that reads, and notes a list it cannot rebuild', () => {
    const salvaged = salvage({
      branch: {
        access: {
          allowedUsers: 'x',
          managerOrAdminAllowed: false,
          excluded: { bob: removal },
          excludedGroups: { readers: removal },
          addBy: 'owner',
        },
      },
    })
    expect(salvaged.access).toEqual(
      damaged(
        {
          managerOrAdminAllowed: false,
          excluded: { bob: removal },
          excludedGroups: { readers: removal },
          addBy: 'owner',
        },
        true,
      ),
    )
  })

  it.each(['restricted', 'allowedUsers', 'allowedGroups'])(
    'notes a restriction from %s, readable or not',
    (key) => {
      const readable = { restricted: true, allowedUsers: ['a'], allowedGroups: ['g'] }[key]
      for (const value of [readable, 'damaged']) {
        const salvaged = salvage({ branch: { access: { [key]: value, entryMeta: 1 } } })
        expect(salvaged.access).toMatchObject({ readable: false, mayRestrict: true })
      }
    },
  )

  it('notes no restriction from narrowing fields that read', () => {
    const salvaged = salvage({
      branch: { access: { managerOrAdminAllowed: true, excluded: {}, entryMeta: 1 } },
    })
    expect(salvaged.access).toEqual(damaged({ managerOrAdminAllowed: true, excluded: {} }))
  })

  it('takes a lockdown that does not read as a lockdown', () => {
    const salvaged = salvage({ branch: { access: { managerOrAdminAllowed: 'yes' } } })
    expect(salvaged.access).toEqual(damaged({ managerOrAdminAllowed: true }, true, true))
  })

  it.each(['members', 'owner', 'admins'])('carries addBy %j as it reads', (addBy) => {
    const salvaged = salvage({ branch: { access: { addBy, entryMeta: 1 } } })
    expect(salvaged.access).toEqual(damaged({ addBy }))
  })

  it('takes an addBy that does not read as admins only', () => {
    const salvaged = salvage({ branch: { access: { addBy: 'nobody', entryMeta: 1 } } })
    expect(salvaged.access).toEqual(damaged({ addBy: 'admins' }))
  })

  it("keeps every removal entry, a malformed one as an admin's made by no known user", () => {
    const salvaged = salvage({
      branch: {
        access: {
          excluded: { bob: removal, carol: 'damaged' },
          excludedGroups: { readers: { by: 1 } },
          entryMeta: 1,
        },
      },
    })
    const madeByNobody = { by: 'unknown', at: expect.any(String), byAdmin: true }
    expect(salvaged.access).toEqual(
      damaged({
        excluded: { bob: removal, carol: madeByNobody },
        excludedGroups: { readers: madeByNobody },
      }),
    )
  })

  it.each([
    ['a string', 'readers'],
    ['an array', ['readers']],
  ])('drops removed groups that are %s, which restrict no access', (_case, excludedGroups) => {
    const salvaged = salvage({ branch: { access: { excludedGroups, entryMeta: 1 } } })
    expect(salvaged.access).toEqual(damaged({}))
  })

  it.each([
    ['a string', 'bob'],
    ['an array', ['bob']],
  ])('drops removals that are %s, noting what they may have restricted', (_case, excluded) => {
    const salvaged = salvage({ branch: { access: { excluded, entryMeta: 1 } } })
    expect(salvaged.access).toEqual(damaged({}, true))
  })

  it.each(['editing', 'submitted', 'approved', 'archived'])('keeps a status of %j', (status) => {
    expect(salvage({ branch: { status } }).fields.status).toBe(status)
  })

  it.each([
    ['status', 'bogus', 'submitted'],
    ['unpublishedAtMerge', 'yes', true],
    ['rewrittenOnGitHub', 7, ''],
    ['archivedAt', 7, '2026-11-16T12:00:00.000Z'],
  ])('takes an unreadable %s at its most restrictive', (key, value, restrictive) => {
    const salvaged = salvageBranchMetadata(
      JSON.stringify({ branch: { [key]: value } }),
      new Date('2026-11-16T12:00:00.000Z'),
    )
    expect(salvaged.fields).toEqual({ [key]: restrictive })
    expect(salvaged.unreadable).toEqual([key])
  })

  it('keeps every other field that reads, and leaves out one that does not', () => {
    const salvaged = salvage({
      branch: {
        pullRequestNumber: 42,
        lastGitHubTip: 'a'.repeat(40),
        historyRewrittenFrom: 'b'.repeat(40),
        editors: ['alice'],
        syncStatus: 'damaged',
        review: { state: 'nope' },
        futureKey: 'carried',
      },
    })
    expect(salvaged.fields).toEqual({
      pullRequestNumber: 42,
      lastGitHubTip: 'a'.repeat(40),
      historyRewrittenFrom: 'b'.repeat(40),
      editors: ['alice'],
    })
    expect(salvaged.unreadable).toEqual(['syncStatus', 'review'])
    expect(salvaged.unknownFields).toEqual({ futureKey: 'carried' })
  })

  it('carries keys the schema does not know over verbatim, all but __proto__', () => {
    const salvaged = salvageBranchMetadata(
      '{"branch": {"futureLock": {"on": true}, "__proto__": {"x": 1}, "status": "bogus"}}',
    )
    expect(salvaged.unknownFields).toEqual({ futureLock: { on: true } })
    expect(Object.keys(salvaged.unknownFields)).toEqual(['futureLock'])
  })

  it('keeps a createdAt that reads, and notes one that does not', () => {
    expect(salvage({ branch: { createdAt: '2026-01-01T00:00:00.000Z' } }).createdAt).toBe(
      '2026-01-01T00:00:00.000Z',
    )
    const unreadableCreatedAt = salvage({ branch: { createdAt: 5 } })
    expect(unreadableCreatedAt.createdAt).toBeUndefined()
    expect(unreadableCreatedAt.unreadable).toEqual(['createdAt'])
  })

  it.each([
    ['a number', 42],
    ['an empty string', ''],
  ])('keeps no createdBy or baseBranch that is %s', (_case, value) => {
    const salvaged = salvage({ branch: { createdBy: value, baseBranch: value } })
    expect(salvaged).toEqual({ ...nothing, unreadable: ['createdBy', 'baseBranch'] })
  })

  it('keeps a non-empty createdBy and baseBranch', () => {
    expect(salvage({ branch: { createdBy: 'alice', baseBranch: 'main' } })).toEqual({
      ...nothing,
      fields: { createdBy: 'alice', baseBranch: 'main' },
    })
  })

  it('takes nothing a __proto__ key carries', () => {
    const raw =
      '{"__proto__": {"branch": {"createdBy": "mallory"}}, "branch": {"__proto__": {"createdBy": "mallory"},' +
      ' "access": {"__proto__": {"allowedUsers": ["mallory"]}, "entryMeta": 1,' +
      ' "excluded": {"__proto__": {"by": "x", "at": "y", "byAdmin": false}}}}}'
    const salvaged = salvageBranchMetadata(raw)
    expect(salvaged.fields).toEqual({})
    expect(salvaged.access).toEqual(damaged({ excluded: {} }))
    if (salvaged.access.readable) throw new Error('expected damaged access')
    const excluded = salvaged.access.narrowing.excluded ?? {}
    expect(Object.getPrototypeOf(excluded)).toBe(Object.prototype)
    expect(Object.keys(excluded)).toEqual([])
    expect(({} as Record<string, unknown>).allowedUsers).toBeUndefined()
  })

  it('keeps a whole access whose __proto__ key would otherwise widen it, without the key', () => {
    const raw = '{"branch": {"access": {"__proto__": {"allowedUsers": ["mallory"]}}}}'
    const salvaged = salvageBranchMetadata(raw)
    if (!salvaged.access.readable) throw new Error('expected readable access')
    expect(salvaged.access.access.allowedUsers).toBeUndefined()
    expect(Object.getPrototypeOf(salvaged.access.access)).toBe(Object.prototype)
  })
})
