import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BranchName } from '../paths/types'
import type { BranchReview } from '../types'

const { mockSyncSubmitPr } = vi.hoisted(() => ({ mockSyncSubmitPr: vi.fn() }))
vi.mock('./github-sync', () => ({ syncSubmitPr: mockSyncSubmitPr }))

import { WORKFLOW_ROUTES } from './branch-status'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { renderPrCommentsBody } from '../pr-comments'
import { buildPrSection, buildReviewBlock, mergeReviewBlock } from '../submission-attribution'
import { createMockApiContext, createMockBranchContext } from '../test-utils'

const submit = WORKFLOW_ROUTES.submit.handler

const changesRequested: BranchReview = {
  state: 'changes-requested',
  by: { userId: 'rev1', name: 'Rae Viewer' },
  at: '2026-10-28T14:05:00.000Z',
}

let tmp: string
let branchRoot: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-submit-review-'))
  branchRoot = path.join(tmp, 'feature-x')
  await fs.mkdir(branchRoot, { recursive: true })
  await getBranchMetadataFileManager(branchRoot, tmp, { settleMs: 0 }).save({
    branch: { name: 'feature/x', status: 'editing', createdBy: 'u1', review: changesRequested },
  })
  mockSyncSubmitPr.mockReset()
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const makeCtx = () =>
  createMockApiContext({
    branchContext: createMockBranchContext({
      branchName: 'feature/x',
      createdBy: 'u1',
      baseRoot: tmp,
      branchRoot,
    }),
    allowBranchAccess: true,
    services: { config: { defaultBranchAccess: 'allow' } as never },
  })

const run = (ctx = makeCtx()) =>
  submit(
    ctx,
    { user: { type: 'authenticated', userId: 'u1', groups: [] } },
    { branch: 'feature/x' as BranchName },
    undefined,
  )

/** The PR body the last submit left, with its request for changes still showing. */
const staleBody = mergeReviewBlock(
  buildPrSection({ changedPaths: ['a.md'] }),
  buildReviewBlock(changesRequested),
)!

describe("submit and the last round's review", () => {
  it('has cleared the review on disk before it writes the PR, so a comment sync in between renders none', async () => {
    let betweenWrites: string | undefined
    mockSyncSubmitPr.mockImplementation(async () => {
      // A comment sync running while the submit's PR write is in flight reads disk.
      betweenWrites = await renderPrCommentsBody({
        branchRoot,
        branch: 'feature/x',
        body: staleBody,
        warn: vi.fn(),
      })
      return { prUrl: 'https://example.test/pr/7', prNumber: 7, syncStatus: 'synced' }
    })

    const res = await run()

    expect(res.ok).toBe(true)
    expect(betweenWrites).toContain('Not yet reviewed in CanopyCMS.')
    expect(betweenWrites).not.toContain('Changes requested')
  })

  it('leaves no review once the submit is saved', async () => {
    mockSyncSubmitPr.mockResolvedValue({ syncStatus: 'synced' })

    await run()

    const saved = await BranchMetadataFileManager.loadOnly(branchRoot)
    expect(saved?.branch.status).toBe('submitted')
    expect(saved?.branch.review).toBeUndefined()
  })

  it('keeps the review when the push fails, since nothing was submitted', async () => {
    const ctx = makeCtx()
    ctx.services.submitBranch = vi.fn().mockRejectedValue(new Error('push rejected'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await run(ctx)
    consoleError.mockRestore()

    expect(res.ok).toBe(false)
    expect(mockSyncSubmitPr).not.toHaveBeenCalled()
    expect((await BranchMetadataFileManager.loadOnly(branchRoot))?.branch.review).toEqual(
      changesRequested,
    )
  })
})
