import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { listBranchesHandler } from './branch'
import { RESERVED_GROUPS } from '../authorization'
import type { BranchRegistry } from '../branch-registry'
import type { CanopyServices } from '../services'
import type { BranchContext } from '../types'
import {
  createMockApiContext,
  createMockBranchContext,
  createMockRegistry,
  mockConsole,
} from '../test-utils'

const admin = {
  user: { type: 'authenticated' as const, userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

/** A clone with one commit, its ref packed when `packed`. */
async function clone(packed = false): Promise<{ root: string; head: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-list-heads-'))
  roots.push(root)
  const git = simpleGit({ baseDir: root })
  await git.init(['--initial-branch=main'])
  await git.addConfig('user.name', 'Test')
  await git.addConfig('user.email', 'test@test.com')
  await git.commit('initial', ['--allow-empty'])
  if (packed) await git.raw(['pack-refs', '--all'])
  return { root, head: (await git.revparse(['HEAD'])).trim() }
}

const list = async (branches: BranchContext[], headSha?: () => Promise<string>) => {
  const createGitManagerFor = vi.fn(() => ({ headSha: headSha ?? (async () => 'f'.repeat(40)) }))
  const ctx = createMockApiContext({
    branchContext: branches[0],
    services: {
      registry: createMockRegistry(branches) as unknown as BranchRegistry,
      createGitManagerFor: createGitManagerFor as unknown as CanopyServices['createGitManagerFor'],
    },
  })
  const res = await listBranchesHandler(ctx, admin)
  const heads = Object.fromEntries((res.data?.branches ?? []).map((b) => [b.name, b.headSha]))
  return { heads, createGitManagerFor }
}

describe('the head each listed branch in review holds', () => {
  it('lists the head of a submitted or approved branch from its files, spawning no git', async () => {
    const submitted = await clone()
    const approved = await clone(true)
    const editing = await clone()
    const { heads, createGitManagerFor } = await list([
      createMockBranchContext({
        branchName: 'submitted',
        branchRoot: submitted.root,
        status: 'submitted',
      }),
      createMockBranchContext({
        branchName: 'approved',
        branchRoot: approved.root,
        status: 'approved',
      }),
      createMockBranchContext({
        branchName: 'editing',
        branchRoot: editing.root,
        status: 'editing',
      }),
    ])
    expect(heads).toEqual({
      submitted: submitted.head,
      approved: approved.head,
      editing: undefined,
    })
    expect(createGitManagerFor).not.toHaveBeenCalled()
  })

  it('asks git for a layout the files cannot answer', async () => {
    const { root } = await clone()
    // A symbolic ref chain, which the file reader leaves to git.
    await fs.writeFile(path.join(root, '.git/refs/heads/main'), 'ref: refs/heads/other\n')
    const { heads, createGitManagerFor } = await list(
      [createMockBranchContext({ branchName: 'chained', branchRoot: root, status: 'submitted' })],
      async () => 'c'.repeat(40),
    )
    expect(heads).toEqual({ chained: 'c'.repeat(40) })
    expect(createGitManagerFor).toHaveBeenCalledTimes(1)
  })

  it('lists a branch whose head cannot be read without one, and logs it', async () => {
    const consoleSpy = mockConsole()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-list-heads-'))
    roots.push(root)
    const { heads } = await list(
      [
        createMockBranchContext({
          branchName: 'unreadable',
          branchRoot: root,
          status: 'submitted',
        }),
      ],
      async () => {
        throw new Error('not a git repository')
      },
    )
    expect(heads).toEqual({ unreadable: undefined })
    expect(consoleSpy).toHaveErrored('Could not read the head of unreadable')
  })
})
