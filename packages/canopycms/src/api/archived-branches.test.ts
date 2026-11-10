import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RESERVED_GROUPS } from '../authorization'
import { mockConsole } from '../test-utils/console-spy'
import { buildInitialBranchMetadata, BranchMetadataFileManager } from '../branch-metadata'
import { BRANCH_META_DIR, BRANCH_META_FILE } from '../branch-metadata-file'
import type { BranchContext, BranchMetadata } from '../types'
import { sanitizeBranchName } from '../paths/branch-name'
import type { BranchName } from '../paths/types'
import {
  ADMIN_ARCHIVED_BRANCH_ROUTES,
  ARCHIVE_BRANCH_ROUTES,
  DELETE_ARCHIVED_BUDGET_MS,
  deleteArchivedBranchesHandler,
} from './archived-branches'
import { deleteBranchHandler, toBranchListItem } from './branch'
import type { ApiContext, ApiRequest } from './types'

const { throwFor } = vi.hoisted(() => ({ throwFor: new Set<string>() }))

vi.mock('../branch-delete', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../branch-delete')>()
  return {
    ...actual,
    deleteBranchWorkspace: (options: Parameters<typeof actual.deleteBranchWorkspace>[0]) =>
      throwFor.has(options.context.branch.name)
        ? Promise.reject(new Error('boom'))
        : actual.deleteBranchWorkspace(options),
  }
})

const DAY = 24 * 60 * 60_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()

const admin = {
  user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
} as unknown as ApiRequest
const editor = {
  user: { type: 'authenticated', userId: 'editor-1', groups: [] },
} as unknown as ApiRequest

let baseRoot: string
let contexts: BranchContext[]

const addBranch = async (name: string, fields: Partial<BranchMetadata>) => {
  const branchRoot = path.join(baseRoot, sanitizeBranchName(name))
  const file = buildInitialBranchMetadata({ branch: { name, ...fields } })
  await fs.mkdir(path.join(branchRoot, BRANCH_META_DIR), { recursive: true })
  await fs.writeFile(path.join(branchRoot, BRANCH_META_DIR, BRANCH_META_FILE), JSON.stringify(file))
  const context: BranchContext = { baseRoot, branchRoot, branch: file.branch }
  contexts.push(context)
  return context
}

const contextFor = (): ApiContext =>
  ({
    services: {
      config: { mode: 'dev', defaultBaseBranch: 'main' },
      registry: {
        list: vi.fn(async () => contexts),
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      checkBranchAccess: vi.fn().mockReturnValue({ allowed: true }),
    },
    getBranchContext: vi.fn(
      async (name: string) => contexts.find((c) => c.branch.name === name) ?? null,
    ),
  }) as unknown as ApiContext

const hasWorkspace = (name: string) =>
  fs.access(path.join(baseRoot, sanitizeBranchName(name))).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-archived-api-'))
  contexts = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(baseRoot, { recursive: true, force: true })
})

describe('POST /:branch/archive', () => {
  const archive = (ctx: ApiContext, req: ApiRequest, branch: string) =>
    ARCHIVE_BRANCH_ROUTES.archive.handler(ctx, req, { branch: branch as BranchName })

  it('archives a closed-unmerged branch and records no merge', async () => {
    const context = await addBranch('abandoned', {
      status: 'submitted',
      pullRequestNumber: 9,
      pullRequestState: 'closed',
      submitUnfinished: true,
    })

    const result = await archive(contextFor(), admin, 'abandoned')

    expect(result).toMatchObject({ ok: true, data: { branch: { status: 'archived' } } })
    const saved = await BranchMetadataFileManager.loadOnly(context.branchRoot)
    expect(saved?.branch.status).toBe('archived')
    expect(saved?.branch.archivedAt).toEqual(expect.any(String))
    expect(saved?.branch).not.toHaveProperty('mergedAt')
    expect(saved?.branch.pullRequestState).toBe('closed')
    expect(saved?.branch.submitUnfinished).toBeUndefined()
  })

  it('is admin-only', async () => {
    const context = await addBranch('abandoned', {
      status: 'submitted',
      pullRequestNumber: 9,
      pullRequestState: 'closed',
    })

    const result = await archive(contextFor(), editor, 'abandoned')

    expect(result.status).toBe(403)
    const saved = await BranchMetadataFileManager.loadOnly(context.branchRoot)
    expect(saved?.branch.status).toBe('submitted')
  })

  it.each([
    ['an open pull request', { status: 'submitted', pullRequestState: 'open' }],
    ['no pull request', { status: 'editing' }],
    ['a branch already archived', { status: 'archived', pullRequestState: 'closed' }],
  ] as const)('refuses %s', async (_label, fields) => {
    const context = await addBranch('branch', fields)

    const result = await archive(contextFor(), admin, 'branch')

    expect(result).toMatchObject({ ok: false, status: 409 })
    const saved = await BranchMetadataFileManager.loadOnly(context.branchRoot)
    expect(saved?.branch).not.toHaveProperty('archivedAt')
  })
})

describe('POST /admin/archived-branches/delete', () => {
  const run = (
    ctx: ApiContext,
    branches = contexts.map((c) => c.branch.name),
    olderThanDays = 30,
  ) => deleteArchivedBranchesHandler(undefined, ctx, admin, { olderThanDays, branches })

  it('deletes merged, archived branches past the cutoff and nothing else', async () => {
    await addBranch('old-merged', { status: 'archived', mergedAt: daysAgo(40) })
    await addBranch('new-merged', { status: 'archived', mergedAt: daysAgo(10) })
    await addBranch('live', { status: 'editing' })

    const result = await run(contextFor())

    expect(result.data?.deleted).toEqual(['old-merged'])
    expect(await hasWorkspace('old-merged')).toBe(false)
    expect(await hasWorkspace('new-merged')).toBe(true)
    expect(await hasWorkspace('live')).toBe(true)
  })

  it('skips what only a person may delete, and says why', async () => {
    await addBranch('abandoned', { status: 'archived', archivedAt: daysAgo(40) })
    await addBranch('unpublished', {
      status: 'archived',
      mergedAt: daysAgo(40),
      unpublishedAtMerge: true,
    })

    const result = await run(contextFor())

    expect(result.data).toMatchObject({
      deleted: [],
      skipped: { notMerged: ['abandoned'], unpublished: ['unpublished'] },
    })
    expect(await hasWorkspace('abandoned')).toBe(true)
    expect(await hasWorkspace('unpublished')).toBe(true)
  })

  it('leaves the base and settings branches out altogether', async () => {
    await addBranch('main', { status: 'archived', mergedAt: daysAgo(40) })
    await addBranch('canopycms-settings-local', { status: 'archived', mergedAt: daysAgo(40) })

    const result = await run(contextFor())

    expect(result.data).toMatchObject({
      deleted: [],
      skipped: { notMerged: [], unpublished: [] },
    })
    expect(await hasWorkspace('main')).toBe(true)
  })

  it('deletes nothing the admin did not confirm', async () => {
    await addBranch('confirmed', { status: 'archived', mergedAt: daysAgo(40) })
    await addBranch('aged-since', { status: 'archived', mergedAt: daysAgo(40) })

    const result = await run(contextFor(), ['confirmed'])

    expect(result.data?.deleted).toEqual(['confirmed'])
    expect(await hasWorkspace('aged-since')).toBe(true)
  })

  it('reports a confirmed branch no longer listed, rather than saying nothing', async () => {
    const result = await run(contextFor(), ['someone-got-there-first'])

    expect(result.data).toMatchObject({ deleted: [], failed: ['someone-got-there-first'] })
  })

  it('counts a name confirmed twice once', async () => {
    const result = await run(contextFor(), ['gone', 'gone'])

    expect(result.data?.failed).toEqual(['gone'])
  })

  it('takes the editor copy only, queuing no GitHub delete', async () => {
    await addBranch('old-merged', {
      status: 'archived',
      mergedAt: daysAgo(40),
      pullRequestNumber: 3,
    })
    const ctx = contextFor()
    const deleteOnGitHub = vi.fn()
    ctx.services.githubService = { deleteBranch: deleteOnGitHub } as never

    await run(ctx)

    expect(await hasWorkspace('old-merged')).toBe(false)
    expect(deleteOnGitHub).not.toHaveBeenCalled()
  })

  it('costs a throwing delete only that branch', async () => {
    await addBranch('throws', { status: 'archived', mergedAt: daysAgo(40) })
    await addBranch('fine', { status: 'archived', mergedAt: daysAgo(40) })
    const consoleSpy = mockConsole()
    throwFor.add('throws')

    const result = await run(contextFor())

    throwFor.clear()
    expect(result.data).toMatchObject({ deleted: ['fine'], failed: ['throws'] })
    consoleSpy.restore()
  })

  it('leaves a branch that changed since the listing, as failed', async () => {
    const context = await addBranch('changing', { status: 'archived', mergedAt: daysAgo(40) })
    await fs.writeFile(
      path.join(context.branchRoot, BRANCH_META_DIR, BRANCH_META_FILE),
      JSON.stringify(
        buildInitialBranchMetadata({ branch: { name: 'changing', status: 'editing' } }),
      ),
    )

    const result = await run(contextFor())

    expect(result.data).toMatchObject({ deleted: [], failed: ['changing'] })
    expect(await hasWorkspace('changing')).toBe(true)
  })

  it('stops starting deletes once the budget is spent, and counts what is left', async () => {
    await addBranch('first', { status: 'archived', mergedAt: daysAgo(40) })
    await addBranch('second', { status: 'archived', mergedAt: daysAgo(40) })
    const start = Date.now()
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(start)
      .mockReturnValue(start + DELETE_ARCHIVED_BUDGET_MS + 1)

    const result = await run(contextFor())

    expect(result.data).toMatchObject({ deleted: [], remaining: 2 })
  })

  it('is admin-only', async () => {
    await addBranch('old-merged', { status: 'archived', mergedAt: daysAgo(40) })

    const route = ADMIN_ARCHIVED_BRANCH_ROUTES.deleteArchivedBranches
    const result = await route.handler(contextFor(), editor, {
      olderThanDays: 1,
      branches: ['old-merged'],
    })

    expect(result.status).toBe(403)
    expect(await hasWorkspace('old-merged')).toBe(true)
  })

  it.each([0, -1, 1.5])('refuses olderThanDays %s', (olderThanDays) => {
    const route = ADMIN_ARCHIVED_BRANCH_ROUTES.deleteArchivedBranches
    expect(route.validate({ body: { olderThanDays, branches: [] } }).ok).toBe(false)
  })
})

describe('DELETE /:branch', () => {
  const creator = {
    user: { type: 'authenticated', userId: 'creator-1', groups: [] },
  } as unknown as ApiRequest
  const rewritten = {
    status: 'archived',
    mergedAt: daysAgo(40),
    rewrittenOnGitHub: 'abc',
    createdBy: 'creator-1',
  } as const

  it('refuses the creator of an archived branch rewritten on GitHub, leaving it to an admin', async () => {
    await addBranch('rewritten', rewritten)

    const result = await deleteBranchHandler(contextFor(), creator, {
      branch: 'rewritten' as BranchName,
    })

    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(result.error).toContain('Ask an admin')
    expect(await hasWorkspace('rewritten')).toBe(true)
  })

  it('lets an admin delete it', async () => {
    await addBranch('rewritten', rewritten)

    const result = await deleteBranchHandler(contextFor(), admin, {
      branch: 'rewritten' as BranchName,
    })

    expect(result.ok).toBe(true)
    expect(await hasWorkspace('rewritten')).toBe(false)
  })

  it('lists it with a hold that says so', async () => {
    const { branch } = await addBranch('rewritten', rewritten)

    expect(toBranchListItem(contextFor().services.config, branch, admin.user).hold).toEqual({
      kind: 'rewritten-at-merge',
    })
  })

  it('answers 409, not success, for a branch whose directory is already gone', async () => {
    const context = await addBranch('half-deleted', { status: 'archived', mergedAt: daysAgo(40) })
    await fs.rm(context.branchRoot, { recursive: true })

    const result = await deleteBranchHandler(contextFor(), admin, {
      branch: 'half-deleted' as BranchName,
    })

    expect(result).toMatchObject({ ok: false, status: 409 })
  })
})
