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
  const nothing = { access: { readable: false, narrowing: {} } }
  const salvage = (file: unknown) => salvageBranchMetadata(JSON.stringify(file))
  const removal = { by: 'admin', at: '2026-11-01T00:00:00.000Z', byAdmin: true }

  it.each([
    ['text that is not JSON', 'not json {{{'],
    ['JSON that is not an object', '[1, 2]'],
    ['no branch', '{}'],
    ['a branch that is an array', '{"branch": []}'],
    ['a branch that is null', '{"branch": null}'],
  ])('salvages nothing from %s', (_case, raw) => {
    expect(salvageBranchMetadata(raw)).toEqual(nothing)
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['missing', undefined],
  ])('reads no narrowing from access that is %s', (_case, access) => {
    expect(salvage({ branch: { access, createdBy: 'alice' } })).toEqual({
      ...nothing,
      createdBy: 'alice',
    })
  })

  it('keeps an access that passes whole, unknown keys included', () => {
    const access = { restricted: true, allowedUsers: ['alice'], futureKey: 1 }
    expect(salvage({ branch: { access } }).access).toEqual({ readable: true, access })
  })

  it('reads each field of a damaged access on its own', () => {
    const salvaged = salvage({
      branch: {
        access: {
          restricted: true,
          allowedUsers: 'x',
          allowedGroups: ['writers'],
          managerOrAdminAllowed: true,
          excluded: { bob: removal },
          excludedGroups: { readers: 'damaged' },
          addBy: 'admins',
        },
      },
    })
    expect(salvaged.access).toEqual({
      readable: false,
      narrowing: { managerOrAdminAllowed: true, excluded: { bob: removal }, addBy: 'admins' },
    })
  })

  it.each(['members', 'owner', 'nobody'])('carries no addBy of %j', (addBy) => {
    const salvaged = salvage({ branch: { access: { addBy, entryMeta: 1 } } })
    expect(salvaged.access).toEqual({ readable: false, narrowing: {} })
  })

  it('carries a lockdown only when it reads as true', () => {
    const salvaged = salvage({ branch: { access: { managerOrAdminAllowed: false, entryMeta: 1 } } })
    expect(salvaged.access).toMatchObject({ readable: false, narrowing: {} })
  })

  it.each([
    ['a number', 42],
    ['an empty string', ''],
  ])('keeps no createdBy or baseBranch that is %s', (_case, value) => {
    const salvaged = salvage({ branch: { createdBy: value, baseBranch: value } })
    expect(salvaged).toEqual(nothing)
  })

  it('keeps a non-empty createdBy and baseBranch', () => {
    expect(salvage({ branch: { createdBy: 'alice', baseBranch: 'main' } })).toEqual({
      ...nothing,
      createdBy: 'alice',
      baseBranch: 'main',
    })
  })

  it('takes nothing a __proto__ key carries', () => {
    const raw =
      '{"__proto__": {"branch": {"createdBy": "mallory"}}, "branch": {"__proto__": {"createdBy": "mallory"},' +
      ' "access": {"__proto__": {"allowedUsers": ["mallory"]}, "restricted": "damaged",' +
      ' "excluded": {"__proto__": {"by": "x", "at": "y", "byAdmin": false}}}}}'
    const salvaged = salvageBranchMetadata(raw)
    expect(salvaged.createdBy).toBeUndefined()
    if (salvaged.access.readable) throw new Error('expected damaged access')
    const { narrowing } = salvaged.access
    expect(narrowing.managerOrAdminAllowed).toBeUndefined()
    expect(Object.getPrototypeOf(narrowing)).toBe(Object.prototype)
    const excluded = narrowing.excluded ?? {}
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
