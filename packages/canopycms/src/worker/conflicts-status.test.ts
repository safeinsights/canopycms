import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBranchMetadataFileManager } from '../branch-metadata'
import type { BranchMetadata } from '../types'
import { MergeConflictStore, withFoundConflicts, type FoundEntryConflict } from '../merge-conflicts'
import { sanitizeBranchName } from '../paths/branch-name'
import type { ContentId } from '../paths/types'
import { mockConsole, type MockConsole } from '../test-utils'
import { GatewayRefusalError } from './branch-policy'
import {
  conflictsStatusOf,
  setConflictsStatuses,
  type ConflictsStatusContext,
} from './conflicts-status'
import type { GitHubConflictsStatus, GitHubGateway } from './github-gateway'

const [HEAD1, HEAD2, MERGE] = ['1'.repeat(40), '2'.repeat(40), 'f'.repeat(40)]
const SPRING = 'canopycms/prod/spring'

let root: string
let branches: string
let consoleSpy: MockConsole
let setStatus: ReturnType<typeof vi.fn<GitHubGateway['setConflictsStatus']>>
let statusesSet: Map<string, string>

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-conflicts-status-'))
  branches = path.join(root, 'content-branches')
  await fs.mkdir(branches)
  consoleSpy = mockConsole()
  setStatus = vi.fn<GitHubGateway['setConflictsStatus']>(async () => undefined)
  statusesSet = new Map()
})

afterEach(async () => {
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

const ctx = (): ConflictsStatusContext => ({
  contentBranchesPath: branches,
  sanitizedBaseBranch: sanitizeBranchName('main'),
  github: () => ({ setConflictsStatus: setStatus }) as unknown as GitHubGateway,
  conflictsStatusesSet: () => statusesSet,
  shutdownSignal: () => new AbortController().signal,
  taskTimeoutMs: 5_000,
})

/** A branch workspace whose branch.json holds `branch`. */
async function giveBranch(
  dir: string,
  branch: Partial<BranchMetadata> & { name: string },
): Promise<string> {
  const branchRoot = path.join(branches, dir)
  await fs.mkdir(branchRoot, { recursive: true })
  await getBranchMetadataFileManager(branchRoot, branches).save({
    branch: { status: 'submitted', ...branch },
  })
  return branchRoot
}

const fieldsConflict = (contentId: string, ...keys: string[]): FoundEntryConflict => ({
  contentId: contentId as ContentId,
  path: `content/page.${contentId}.json`,
  kind: 'fields',
  sides: { ancestor: 'o', base: 'a', branch: 'b' },
  fields: keys.map((key) => ({
    key,
    dataPath: [{ field: key }],
    sidePaths: { ancestor: [{ field: key }], base: [{ field: key }], branch: [{ field: key }] },
    kind: 'changed',
  })),
})

/** Record `found` as the branch's open conflicts; none clears them. */
async function recordConflicts(branchRoot: string, ...found: FoundEntryConflict[]) {
  await new MergeConflictStore(branchRoot).update(() => ({
    entries: withFoundConflicts({}, found, MERGE),
  }))
}

const posted = (): GitHubConflictsStatus[] => setStatus.mock.calls.map(([status]) => status)

describe('conflictsStatusOf', () => {
  it('fails with the number of choices open, each field and each entry-level conflict', async () => {
    const branchRoot = await giveBranch('spring', { name: SPRING })
    await recordConflicts(branchRoot, fieldsConflict('aboutAbc1234', 'title', 'cta'), {
      contentId: 'priceAbc1234' as ContentId,
      path: 'content/page.priceAbc1234.json',
      kind: 'deleted-on-base',
      sides: { ancestor: 'o', branch: 'b' },
    })
    expect(await conflictsStatusOf(branchRoot)).toEqual({
      state: 'failure',
      description: '3 conflicting changes to resolve in the editor',
    })
    await recordConflicts(branchRoot, fieldsConflict('aboutAbc1234', 'title'))
    expect(await conflictsStatusOf(branchRoot)).toEqual({
      state: 'failure',
      description: '1 conflicting change to resolve in the editor',
    })
  })

  it('succeeds with no record, and with one that holds nothing open', async () => {
    const branchRoot = await giveBranch('spring', { name: SPRING })
    const clear = { state: 'success', description: 'No conflicting changes to resolve' }
    expect(await conflictsStatusOf(branchRoot)).toEqual(clear)
    await recordConflicts(branchRoot)
    expect(await conflictsStatusOf(branchRoot)).toEqual(clear)
  })

  it('fails while the record is held, and while it does not parse, as Submit refuses', async () => {
    const branchRoot = await giveBranch('spring', { name: SPRING })
    const file = path.join(branchRoot, '.canopy-meta', 'merge-conflicts.json')
    await fs.writeFile(file, '{"oops"')
    expect(await conflictsStatusOf(branchRoot)).toEqual({
      state: 'failure',
      description: "Couldn't read this branch's conflicts",
    })
    await new MergeConflictStore(branchRoot, 0).quarantine()
    expect(await conflictsStatusOf(branchRoot)).toMatchObject({
      state: 'failure',
      description: expect.stringContaining('an admin must release the branch'),
    })
  })
})

describe('setConflictsStatuses', () => {
  it("sets each pull request head's status, once, and again for a new head or a changed count", async () => {
    const branchRoot = await giveBranch('canopycms-prod-spring', {
      name: SPRING,
      pullRequestNumber: 7,
    })
    await recordConflicts(branchRoot, fieldsConflict('aboutAbc1234', 'title', 'cta'))

    expect(await setConflictsStatuses(ctx(), new Map([[SPRING, HEAD1]]))).toBeUndefined()
    expect(posted()).toEqual([
      {
        pullRequest: 7,
        sha: HEAD1,
        state: 'failure',
        description: '2 conflicting changes to resolve in the editor',
      },
    ])

    // Nothing changed: nothing is set.
    await setConflictsStatuses(ctx(), new Map([[SPRING, HEAD1]]))
    expect(setStatus).toHaveBeenCalledTimes(1)

    // A choice made: the same head turns green.
    await recordConflicts(branchRoot)
    await setConflictsStatuses(ctx(), new Map([[SPRING, HEAD1]]))
    expect(posted()[1]).toMatchObject({ sha: HEAD1, state: 'success' })

    // A new head gets its own.
    await setConflictsStatuses(ctx(), new Map([[SPRING, HEAD2]]))
    expect(posted()[2]).toMatchObject({ sha: HEAD2, state: 'success' })
    expect(setStatus).toHaveBeenCalledTimes(3)
  })

  it('links the status to the branch in the editor at the URL a submit recorded', async () => {
    await giveBranch('canopycms-prod-spring', {
      name: SPRING,
      pullRequestNumber: 7,
      editorUrl: 'https://cms.example.org/edit?stale=1#x',
    })
    await giveBranch('canopycms-prod-summer', {
      name: 'canopycms/prod/summer',
      pullRequestNumber: 8,
      editorUrl: 'javascript:alert(1)',
    })
    await setConflictsStatuses(
      ctx(),
      new Map([
        [SPRING, HEAD1],
        ['canopycms/prod/summer', HEAD2],
      ]),
    )
    const byPr = new Map(posted().map((status) => [status.pullRequest, status]))
    expect(byPr.get(7)?.targetUrl).toBe(
      'https://cms.example.org/edit?branch=canopycms%2Fprod%2Fspring',
    )
    expect(byPr.get(8)).not.toHaveProperty('targetUrl')
  })

  it('sets none for a branch with no pull request, one archived, merged or closed, or not on GitHub', async () => {
    await giveBranch('no-pr', { name: 'canopycms/prod/no-pr' })
    await giveBranch('archived', {
      name: 'canopycms/prod/archived',
      status: 'archived',
      pullRequestNumber: 1,
    })
    await giveBranch('merged', {
      name: 'canopycms/prod/merged',
      pullRequestNumber: 2,
      pullRequestState: 'merged',
    })
    await giveBranch('closed', {
      name: 'canopycms/prod/closed',
      pullRequestNumber: 3,
      pullRequestState: 'closed',
    })
    await giveBranch('unpushed', { name: 'canopycms/prod/unpushed', pullRequestNumber: 4 })
    await giveBranch('main', { name: 'main', pullRequestNumber: 5 })
    await fs.mkdir(path.join(branches, '.trash-x'))
    const tips = new Map(
      ['no-pr', 'archived', 'merged', 'closed'].map((n) => [`canopycms/prod/${n}`, HEAD1]),
    )
    tips.set('main', HEAD1)

    expect(await setConflictsStatuses(ctx(), tips)).toBeUndefined()
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('reports a refused write without throwing, retries it next cycle, and clears once it lands', async () => {
    await giveBranch('a', { name: 'canopycms/prod/a', pullRequestNumber: 1 })
    await giveBranch('b', { name: 'canopycms/prod/b', pullRequestNumber: 2 })
    const tips = new Map([
      ['canopycms/prod/a', HEAD1],
      ['canopycms/prod/b', HEAD2],
    ])
    setStatus.mockRejectedValue(
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    )

    const failure = await setConflictsStatuses(ctx(), tips)
    expect(failure).toEqual({
      reason: 'permission',
      message: 'Resource not accessible by integration',
      branches: ['canopycms/prod/a', 'canopycms/prod/b'].sort(),
      count: 2,
      at: expect.any(String),
    })
    // The first refusal ends the cycle's writes: every other is refused the same way.
    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(consoleSpy).toHaveWarned(/Could not set the conflicts status/)

    setStatus.mockResolvedValue(undefined)
    expect(await setConflictsStatuses(ctx(), tips)).toBeUndefined()
    expect(setStatus).toHaveBeenCalledTimes(3)
  })

  it('reports a refused credential over another refusal before it', async () => {
    await giveBranch('a', { name: 'canopycms/prod/a', pullRequestNumber: 1 })
    await giveBranch('b', { name: 'canopycms/prod/b', pullRequestNumber: 2 })
    setStatus
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockRejectedValueOnce(Object.assign(new Error('Resource not accessible'), { status: 403 }))
    const failure = await setConflictsStatuses(
      ctx(),
      new Map([
        ['canopycms/prod/a', HEAD1],
        ['canopycms/prod/b', HEAD2],
      ]),
    )
    expect(failure).toMatchObject({ reason: 'permission', count: 2 })
  })

  it('stops the cycle at GitHub being unreachable, and bounds each write', async () => {
    await giveBranch('a', { name: 'canopycms/prod/a', pullRequestNumber: 1 })
    await giveBranch('b', { name: 'canopycms/prod/b', pullRequestNumber: 2 })
    setStatus.mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502 }))
    const failure = await setConflictsStatuses(
      { ...ctx(), taskTimeoutMs: 20 },
      new Map([
        ['canopycms/prod/a', HEAD1],
        ['canopycms/prod/b', HEAD2],
      ]),
    )
    expect(failure).toMatchObject({ reason: 'unreachable', count: 2 })
    expect(setStatus).toHaveBeenCalledTimes(1)
    const signal = setStatus.mock.calls[0][1]
    expect(signal?.aborted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(signal?.aborted).toBe(true)
  })

  it('tells GitHub being unreachable from a refused credential', async () => {
    await giveBranch('a', { name: 'canopycms/prod/a', pullRequestNumber: 1 })
    const tips = new Map([['canopycms/prod/a', HEAD1]])
    for (const err of [
      new Error('connect ECONNREFUSED'),
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
      Object.assign(new Error('API rate limit exceeded'), { status: 403 }),
    ]) {
      setStatus.mockRejectedValueOnce(err)
      expect(await setConflictsStatuses(ctx(), tips)).toMatchObject({ reason: 'unreachable' })
    }
    setStatus.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
    expect(await setConflictsStatuses(ctx(), tips)).toMatchObject({ reason: 'other' })
  })

  it('retries a head GitHub moved since the fetch without reporting it', async () => {
    await giveBranch('a', { name: 'canopycms/prod/a', pullRequestNumber: 1 })
    const tips = new Map([['canopycms/prod/a', HEAD1]])
    setStatus.mockRejectedValueOnce(
      new GatewayRefusalError('commit-status', 'canopycms/prod/a', 'not-head', 'moved'),
    )
    expect(await setConflictsStatuses(ctx(), tips)).toBeUndefined()
    expect(await setConflictsStatuses(ctx(), tips)).toBeUndefined()
    expect(setStatus).toHaveBeenCalledTimes(2)
  })

  it('reports a pull request the gateway refuses, and asks again next cycle', async () => {
    await giveBranch('a', { name: 'canopycms/prod/a', pullRequestNumber: 1 })
    const tips = new Map([['canopycms/prod/a', HEAD1]])
    setStatus.mockRejectedValueOnce(
      new GatewayRefusalError('pull-request', 'canopycms/prod/a', 'protected', 'it is protected'),
    )
    expect(await setConflictsStatuses(ctx(), tips)).toMatchObject({
      reason: 'other',
      message: 'it is protected',
      branches: ['canopycms/prod/a'],
    })
    expect(await setConflictsStatuses(ctx(), tips)).toBeUndefined()
    expect(setStatus).toHaveBeenCalledTimes(2)
  })

  it('leaves the last report standing when it cannot say: no branch listing, or a drain', async () => {
    await fs.rm(branches, { recursive: true })
    await fs.writeFile(branches, 'not a directory')
    expect(await setConflictsStatuses(ctx(), new Map())).toBeNull()
    expect(consoleSpy).toHaveWarned(/Could not read the branches/)

    await fs.rm(branches)
    await fs.mkdir(branches)
    await giveBranch('a', { name: 'canopycms/prod/a', pullRequestNumber: 1 })
    const drain = new AbortController()
    setStatus.mockImplementationOnce(async () => {
      drain.abort()
      throw new Error('aborted')
    })
    expect(
      await setConflictsStatuses(
        { ...ctx(), shutdownSignal: () => drain.signal },
        new Map([['canopycms/prod/a', HEAD1]]),
      ),
    ).toBeNull()
  })

  it('leaves off a link longer than the gateway takes, and sets the status without it', async () => {
    await giveBranch('a', {
      name: 'canopycms/prod/a',
      pullRequestNumber: 1,
      editorUrl: `https://cms.example.org/${'x'.repeat(2010)}`,
    })
    await setConflictsStatuses(ctx(), new Map([['canopycms/prod/a', HEAD1]]))
    expect(posted()[0]).not.toHaveProperty('targetUrl')
    expect(posted()[0]).toMatchObject({ state: 'success' })
  })
})
