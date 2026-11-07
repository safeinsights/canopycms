import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteBranchWorkspace, type DeleteBranchWorkspaceOptions } from './branch-delete'
import { buildInitialBranchMetadata } from './branch-metadata'
import { BRANCH_META_DIR, BRANCH_META_FILE } from './branch-metadata-file'
import { mockConsole } from './test-utils/console-spy'
import type { BranchMetadata } from './types'

let baseRoot: string
let branchRoot: string

const branch = (): BranchMetadata =>
  buildInitialBranchMetadata({ branch: { name: 'feature/x', status: 'archived' } }).branch

const writeMetadata = async (root: string, status: BranchMetadata['status']) => {
  await fs.mkdir(path.join(root, BRANCH_META_DIR), { recursive: true })
  await fs.writeFile(
    path.join(root, BRANCH_META_DIR, BRANCH_META_FILE),
    JSON.stringify(buildInitialBranchMetadata({ branch: { name: 'feature/x', status } })),
  )
}

const options = (
  overrides: Partial<DeleteBranchWorkspaceOptions> = {},
): DeleteBranchWorkspaceOptions => ({
  context: { baseRoot, branchRoot, branch: branch() },
  baseBranch: 'main',
  registry: { invalidate: vi.fn().mockResolvedValue(undefined) },
  deleteMirrorHead: vi.fn().mockResolvedValue(undefined),
  deleteOnGitHub: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-branch-delete-'))
  branchRoot = path.join(baseRoot, 'feature-x')
  await writeMetadata(branchRoot, 'archived')
  await fs.writeFile(path.join(branchRoot, BRANCH_META_DIR, 'comments.json'), '{}')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(baseRoot, { recursive: true, force: true })
})

describe('deleteBranchWorkspace', () => {
  it('removes the workspace with its metadata and comments, and every copy elsewhere', async () => {
    const opts = options()
    const outcome = await deleteBranchWorkspace(opts)

    expect(outcome).toEqual({ kind: 'deleted' })
    expect(await fs.readdir(baseRoot)).toEqual([])
    expect(opts.deleteMirrorHead).toHaveBeenCalledOnce()
    expect(opts.deleteOnGitHub).toHaveBeenCalledOnce()
    expect(opts.registry.invalidate).toHaveBeenCalledOnce()
  })

  it('runs the rm last, so a kill during it leaves nothing but a swept directory', async () => {
    const seen: string[][] = []
    const opts = options({
      registry: {
        invalidate: async () => {
          seen.push(await fs.readdir(baseRoot))
        },
      },
    })
    await deleteBranchWorkspace(opts)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(1)
    expect(seen[0][0]).toMatch(/^\.deleting-feature-x-/)
  })

  it('keeps a branch stillWanted refuses, on a read made under the lock', async () => {
    const opts = options()
    // The caller's snapshot says archived; the disk now says otherwise.
    await writeMetadata(branchRoot, 'editing')
    const stillWanted = vi.fn((current: BranchMetadata) => current.status === 'archived')

    const outcome = await deleteBranchWorkspace({ ...opts, stillWanted })

    expect(outcome).toEqual({ kind: 'kept' })
    expect(stillWanted).toHaveBeenCalledWith(expect.objectContaining({ status: 'editing' }))
    expect(await exists(path.join(branchRoot, BRANCH_META_DIR, BRANCH_META_FILE))).toBe(true)
    expect(opts.deleteMirrorHead).not.toHaveBeenCalled()
    expect(opts.deleteOnGitHub).not.toHaveBeenCalled()
    expect(opts.registry.invalidate).not.toHaveBeenCalled()
  })

  it('reads a branch another delete already took as kept, not busy', async () => {
    await fs.rm(branchRoot, { recursive: true })
    const opts = options({ stillWanted: () => true })

    expect(await deleteBranchWorkspace(opts)).toEqual({ kind: 'kept' })
    expect(opts.deleteOnGitHub).not.toHaveBeenCalled()
  })

  it('reads an unreadable branch.json as busy and leaves the workspace', async () => {
    await fs.writeFile(path.join(branchRoot, BRANCH_META_DIR, BRANCH_META_FILE), 'not json')

    const outcome = await deleteBranchWorkspace(options({ stillWanted: () => true }))

    expect(outcome.kind).toBe('busy')
    expect(await exists(branchRoot)).toBe(true)
  })

  it('still deletes when the mirror or GitHub step fails, and says so', async () => {
    const consoleSpy = mockConsole()
    const outcome = await deleteBranchWorkspace(
      options({
        deleteMirrorHead: vi.fn().mockRejectedValue(new Error('mirror down')),
        deleteOnGitHub: vi.fn().mockResolvedValue('Could not queue it'),
      }),
    )

    expect(outcome.kind).toBe('deleted')
    expect(outcome).toEqual(
      expect.objectContaining({
        cleanupWarning: expect.stringMatching(/mirror down.*Could not queue it/),
      }),
    )
    expect(await exists(branchRoot)).toBe(false)
    consoleSpy.restore()
  })

  it('still removes the workspace when the registry refresh fails, and says so', async () => {
    const outcome = await deleteBranchWorkspace(
      options({ registry: { invalidate: vi.fn().mockRejectedValue(new Error('no marker')) } }),
    )

    expect(outcome).toEqual({
      kind: 'deleted',
      cleanupWarning: expect.stringContaining('no marker'),
    })
    expect(await fs.readdir(baseRoot)).toEqual([])
  })

  it('never touches the mirror or GitHub for the base branch', async () => {
    const opts = options({ baseBranch: 'feature/x' })
    await deleteBranchWorkspace(opts)

    expect(opts.deleteMirrorHead).not.toHaveBeenCalled()
    expect(opts.deleteOnGitHub).not.toHaveBeenCalled()
  })
})
