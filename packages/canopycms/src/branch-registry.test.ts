import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BranchRegistry } from './branch-registry'
import type { BranchState } from './types'

const sampleState = (name: string): BranchState => ({
  branch: {
    name,
    status: 'editing',
    access: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: 'user-1',
  },
})

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-registry-'))

describe('BranchRegistry', () => {
  it('creates and reads registry with upserts', async () => {
    const root = await tmpDir()
    const registry = new BranchRegistry(root)
    const stateA = sampleState('feature/a')
    await registry.upsert(stateA)

    const fetched = await registry.get('feature/a')
    expect(fetched?.branch.name).toBe('feature/a')

    const list = await registry.list()
    expect(list).toHaveLength(1)
  })

  it('updates existing entries on upsert', async () => {
    const root = await tmpDir()
    const registry = new BranchRegistry(root)
    const stateA = sampleState('feature/a')
    await registry.upsert(stateA)
    await registry.upsert({ ...stateA, pullRequestNumber: 12 })

    const fetched = await registry.get('feature/a')
    expect(fetched?.pullRequestNumber).toBe(12)
  })

  it('removes branches', async () => {
    const root = await tmpDir()
    const registry = new BranchRegistry(root)
    await registry.upsert(sampleState('feature/a'))
    await registry.upsert(sampleState('feature/b'))

    await registry.remove('feature/a')
    const remaining = await registry.list()
    expect(remaining.map((b) => b.branch.name)).toEqual(['feature/b'])
  })
})
