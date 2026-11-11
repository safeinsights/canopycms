/**
 * Submit and Approve wait while a merge's conflicts are open (plan row 45): Submit checks inside
 * its content-write lock, against a real clone; Approve before it records the approval.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestServices } from '../config-test'
import { ensureGitExcludePattern } from '../git-manager'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { MergeConflictStore, OpenMergeConflictsError, withFoundConflicts } from '../merge-conflicts'
import { RESERVED_GROUPS } from '../authorization'
import {
  createMockApiContext,
  createMockBranchContext,
  initTestRepo,
  openBareRepo,
} from '../test-utils'
import type { BranchContext } from '../types'
import type { BranchName, ContentId } from '../paths/types'
import { WORKFLOW_ROUTES } from './branch-status'

vi.mock('./pr-comment-sync', () => ({ syncPrComments: vi.fn().mockResolvedValue(undefined) }))

const MERGE = 'a'.repeat(40)
const ID = 'aboutAbc1234' as ContentId

let tmpDir: string
let branchRoot: string

const recordOpen = () =>
  new MergeConflictStore(branchRoot, 0).update(() => ({
    entries: withFoundConflicts(
      {},
      [
        {
          contentId: ID,
          path: 'content/page.about.aboutAbc1234.json',
          kind: 'fields',
          sides: {},
          fields: [
            { key: 'title', dataPath: [{ field: 'title' }], kind: 'changed' },
            { key: 'cta', dataPath: [{ field: 'cta' }], kind: 'changed' },
          ],
        },
      ],
      MERGE,
    ),
  }))
const recordResolved = () => new MergeConflictStore(branchRoot, 0).update(() => ({ entries: {} }))

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('submit while conflicts are open', () => {
  let remotePath: string
  let context: BranchContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-conflict-gate-submit-'))
    remotePath = path.join(tmpDir, 'remote.git')
    branchRoot = path.join(tmpDir, 'branch')
    await fs.mkdir(remotePath, { recursive: true })
    const bare = openBareRepo(remotePath)
    await bare.init(true)
    await bare.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    const seedPath = path.join(tmpDir, 'seed')
    await fs.mkdir(seedPath, { recursive: true })
    const seed = await initTestRepo(seedPath)
    await seed.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await fs.writeFile(path.join(seedPath, 'seed.txt'), 'seed', 'utf8')
    await seed.add(['.'])
    await seed.commit('initial commit')
    await seed.addRemote('origin', remotePath)
    await seed.push('origin', 'main')
    await simpleGit().clone(remotePath, branchRoot, ['--branch', 'main', '--single-branch'])
    await simpleGit({ baseDir: branchRoot }).addConfig('canopycms.managed', 'true')
    await ensureGitExcludePattern(branchRoot, '.canopy-meta/')
    context = {
      baseRoot: tmpDir,
      branchRoot,
      branch: {
        name: 'feature-1',
        baseBranch: 'main',
        status: 'editing',
        access: {},
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }
    await fs.writeFile(path.join(branchRoot, 'a.txt'), 'a change', 'utf8')
  })

  const remoteHasBranch = async () =>
    (await openBareRepo(remotePath).raw(['branch', '--list', 'feature-1'])).trim() !== ''

  it('refuses, committing and pushing nothing, then submits once they are resolved', async () => {
    const services = await createTestServices({
      schema: { collections: [] },
      mode: 'dev',
      defaultBaseBranch: 'main',
    })
    await recordOpen()
    const head = (await simpleGit({ baseDir: branchRoot }).revparse(['HEAD'])).trim()
    const err = await services.submitBranch({ context }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpenMergeConflictsError)
    expect(err).toMatchObject({ count: 2 })
    expect((await simpleGit({ baseDir: branchRoot }).revparse(['HEAD'])).trim()).toBe(head)
    expect(await remoteHasBranch()).toBe(false)

    await recordResolved()
    await services.submitBranch({ context })
    expect(await remoteHasBranch()).toBe(true)
  })

  it('answers 409 OPEN_CONFLICTS, telling the author where to choose', async () => {
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'feature-1', branchRoot }),
    })
    ctx.services.submitBranch = vi.fn().mockRejectedValue(new OpenMergeConflictsError(2))
    const res = await WORKFLOW_ROUTES.submit.handler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature-1' as BranchName },
      undefined,
    )
    expect(res).toEqual({
      ok: false,
      status: 409,
      code: 'OPEN_CONFLICTS',
      error:
        '2 changes on this branch conflict with newer changes on the site. Choose what to keep in "Show changes", then submit again.',
    })
  })
})

describe('approve while conflicts are open', () => {
  let branchContext: BranchContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-conflict-gate-approve-'))
    branchRoot = path.join(tmpDir, 'feature')
    await fs.mkdir(branchRoot, { recursive: true })
    branchContext = createMockBranchContext({
      branchName: 'feature',
      baseRoot: tmpDir,
      branchRoot,
      createdBy: 'creator',
      status: 'submitted',
    })
    await getBranchMetadataFileManager(branchRoot, tmpDir).save({ branch: branchContext.branch })
  })

  const approve = () =>
    WORKFLOW_ROUTES.approve.handler(
      createMockApiContext({ branchContext }),
      { user: { type: 'authenticated', userId: 'rev1', groups: [RESERVED_GROUPS.REVIEWERS] } },
      { branch: 'feature' as BranchName },
    )
  const status = async () => (await BranchMetadataFileManager.loadOnly(branchRoot))?.branch.status

  it('refuses with 409 OPEN_CONFLICTS and leaves the branch submitted, then approves once resolved', async () => {
    await recordOpen()
    expect(await approve()).toEqual({
      ok: false,
      status: 409,
      code: 'OPEN_CONFLICTS',
      error:
        '2 changes on this branch conflict with newer changes on the site. It can be approved once its editor chooses what to keep.',
    })
    expect(await status()).toBe('submitted')

    await recordResolved()
    expect(await approve()).toMatchObject({ ok: true, status: 200 })
    expect(await status()).toBe('approved')
  })

  it('refuses while the record does not parse', async () => {
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(branchRoot, '.canopy-meta', 'merge-conflicts.json'), 'nope')
    expect(await approve()).toMatchObject({ ok: false, status: 409, code: 'OPEN_CONFLICTS' })
    expect(await status()).toBe('submitted')
  })
})
