import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { branchProvisioningLockName } from '../utils/provisioning-lock'
import { holdProvisionedWorkspace } from './provisioned-workspace'

describe('holdProvisionedWorkspace', () => {
  let contentBranchesPath: string

  beforeEach(async () => {
    contentBranchesPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-provisioned-'))
  })

  afterEach(async () => {
    await fs.rm(contentBranchesPath, { recursive: true, force: true })
  })

  /** A lock marker as a holder leaves it, last refreshed `ageMs` ago. */
  async function markerAged(dirName: string, ageMs: number): Promise<string> {
    const marker = path.join(contentBranchesPath, branchProvisioningLockName(dirName))
    await fs.mkdir(marker)
    const then = new Date(Date.now() - ageMs)
    await fs.utimes(marker, then, then)
    return marker
  }

  it('leaves a marker that only looks 40s old, as a live clone seen through the NFS cache can', async () => {
    const marker = await markerAged('feature', 40_000)

    await expect(holdProvisionedWorkspace(contentBranchesPath, 'feature')).resolves.toEqual({
      kind: 'locked',
    })
    await expect(fs.stat(marker)).resolves.toBeTruthy()
  })

  it('takes over a marker left by a holder that died more than 90s ago', async () => {
    const marker = await markerAged('feature', 120_000)

    // Taken over, then released: the directory holds no clone.
    await expect(holdProvisionedWorkspace(contentBranchesPath, 'feature')).resolves.toEqual({
      kind: 'not-provisioned',
    })
    await expect(fs.stat(marker)).rejects.toThrow()
  })

  it('holds a clone with branch metadata until released', async () => {
    const root = path.join(contentBranchesPath, 'feature')
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.mkdir(path.join(root, '.canopy-meta'))
    await fs.writeFile(path.join(root, '.canopy-meta', 'branch.json'), '{}')

    const hold = await holdProvisionedWorkspace(contentBranchesPath, 'feature')
    expect(hold.kind).toBe('held')
    await expect(holdProvisionedWorkspace(contentBranchesPath, 'feature')).resolves.toEqual({
      kind: 'locked',
    })
    if (hold.kind === 'held') await hold.release()
    const again = await holdProvisionedWorkspace(contentBranchesPath, 'feature')
    expect(again.kind).toBe('held')
    if (again.kind === 'held') await again.release()
  })
})
