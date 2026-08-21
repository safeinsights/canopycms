import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquireProvisioningLock, tryAcquireProvisioningLock } from './provisioning-lock'
import { isNodeError } from './error'

describe('provisioning lock', () => {
  let tmpRoot: string
  let branchesRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-provlock-'))
    branchesRoot = path.join(tmpRoot, 'content-branches')
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('still excludes a second holder of the SAME lock name', async () => {
    const release = await acquireProvisioningLock(branchesRoot, '.branch-a.init.lock')
    try {
      await expect(
        tryAcquireProvisioningLock(branchesRoot, '.branch-a.init.lock'),
      ).rejects.toMatchObject({ code: 'ELOCKED' })
    } finally {
      await release()
    }
  })

  // Regression: proper-lockfile keys its module-level `locks{}` bookkeeping by
  // the TARGET path passed to lock(), not by `lockfilePath`. Anchoring on the
  // shared branches directory made every branch under one root share a single
  // registry entry, so releasing one branch's lock tore down another's refresh
  // timer, failed its release with ERELEASED, and leaked its lock directory --
  // whose orphaned timer then stat()ed a deleted path and crashed the process
  // with ECOMPROMISED. See docs/concurrency.md ("Anchor path matters").
  it('gives two branches under one root independent locks', async () => {
    const releaseA = await acquireProvisioningLock(branchesRoot, '.branch-a.init.lock')
    const releaseB = await acquireProvisioningLock(branchesRoot, '.branch-b.init.lock')

    // Releasing A must not invalidate B's bookkeeping.
    await releaseA()
    await expect(releaseB()).resolves.toBeUndefined()

    // ...and neither lock directory may be left behind on disk.
    expect(await fs.readdir(branchesRoot)).toEqual([])
  })

  it('lets a branch lock be re-acquired after the sibling lock released', async () => {
    const releaseA = await acquireProvisioningLock(branchesRoot, '.branch-a.init.lock')
    const releaseB = await acquireProvisioningLock(branchesRoot, '.branch-b.init.lock')
    await releaseA()

    // B is still genuinely held, so a fresh waiter on B must be excluded.
    let code: string | undefined
    try {
      await tryAcquireProvisioningLock(branchesRoot, '.branch-b.init.lock')
    } catch (err: unknown) {
      code = isNodeError(err) ? err.code : undefined
    }
    expect(code).toBe('ELOCKED')

    await releaseB()
    const reacquired = await tryAcquireProvisioningLock(branchesRoot, '.branch-b.init.lock')
    await reacquired()
  })
})
