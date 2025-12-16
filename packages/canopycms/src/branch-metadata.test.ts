import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BranchMetadata } from './branch-metadata'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branchmeta-'))

describe('BranchMetadata', () => {
  it('saves and loads metadata', async () => {
    const root = await tmpDir()
    const meta = new BranchMetadata(root)
    const now = new Date().toISOString()

    await meta.save({
      schemaVersion: 1,
      branch: {
        name: 'feature/x',
        status: 'editing',
        access: { allowedUsers: ['u1'], allowedGroups: ['g1'] },
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
    })

    const loaded = await meta.load()
    expect(loaded?.branch.name).toBe('feature/x')
    expect(loaded?.branch.access.allowedGroups).toContain('g1')
  })

  it('updates existing metadata and stamps updatedAt', async () => {
    const root = await tmpDir()
    const meta = new BranchMetadata(root)
    const now = new Date().toISOString()
    await meta.save({
      schemaVersion: 1,
      branch: {
        name: 'feature/y',
        status: 'editing',
        access: {},
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
    })

    const updated = await meta.update({
      branch: {
        name: 'feature/y',
        status: 'submitted',
        access: { managerOrAdminAllowed: true },
      },
      pullRequestNumber: 10,
      pullRequestUrl: 'https://example.com/pr/10',
    })

    expect(updated.branch.status).toBe('submitted')
    expect(updated.pullRequestNumber).toBe(10)
    expect(updated.branch.access.managerOrAdminAllowed).toBe(true)
    expect(new Date(updated.branch.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(now).getTime(),
    )
  })
})
