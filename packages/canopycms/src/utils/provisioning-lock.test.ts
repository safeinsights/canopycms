import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import lockfile from 'proper-lockfile'

import { tryAcquireContentWriteLock } from './content-write-lock'
import {
  acquireProvisioningLock,
  acquireProvisioningLockWithin,
  tryAcquireProvisioningLock,
} from './provisioning-lock'
import { isNodeError } from './error'
import { mockConsole } from '../test-utils/console-spy'

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
  it('a bounded acquire gives up with ELOCKED once its budget is spent on a live holder', async () => {
    const release = await acquireProvisioningLock(branchesRoot, '.branch-a.init.lock')
    try {
      const startedAt = Date.now()
      await expect(
        acquireProvisioningLockWithin(branchesRoot, '.branch-a.init.lock', 400),
      ).rejects.toMatchObject({ code: 'ELOCKED' })
      const elapsed = Date.now() - startedAt
      expect(elapsed).toBeGreaterThanOrEqual(350)
      expect(elapsed).toBeLessThan(2_000)
    } finally {
      await release()
    }
  })

  it('a bounded acquire takes the lock once the holder releases within its budget', async () => {
    const release = await acquireProvisioningLock(branchesRoot, '.branch-a.init.lock')
    setTimeout(() => void release(), 150)
    const second = await acquireProvisioningLockWithin(branchesRoot, '.branch-a.init.lock', 5_000)
    await second()
  })

  it('gives two branches under one root independent locks', async () => {
    const releaseA = await acquireProvisioningLock(branchesRoot, '.branch-a.init.lock')
    const releaseB = await acquireProvisioningLock(branchesRoot, '.branch-b.init.lock')

    // Releasing A must not invalidate B's bookkeeping.
    await releaseA()
    await expect(releaseB()).resolves.toBeUndefined()

    // ...and neither lock directory may be left behind on disk.
    expect(await fs.readdir(branchesRoot)).toEqual([])
  })

  // proper-lockfile rejects a second release with ERELEASED -- the same code it
  // raises once `onCompromised` has marked the lock released underneath a holder
  // that is still inside its `finally`. Callers release in a `finally`, so
  // letting that escape would turn a COMPLETED operation into a spurious
  // failure. Double-release is the deterministic way to exercise that path
  // (a real compromise needs proper-lockfile's ~15s refresh heartbeat).
  it('swallows ERELEASED so a release in a finally cannot fail the operation', async () => {
    // The warning is expected output, so it is captured and asserted rather
    // than left to clutter the reporter (vitest.config.ts turns a stray
    // console write into a hard failure in CI).
    const consoleSpy = mockConsole()
    try {
      const release = await acquireProvisioningLock(branchesRoot, '.branch-a.init.lock')
      await release()
      await expect(release()).resolves.toBeUndefined()
      expect(consoleSpy).toHaveWarned(/was already released/)
    } finally {
      consoleSpy.restore()
    }
  })

  // The branch-purge case: an admin deletes the branch directory (and with it
  // the marker) while a holder is still inside its `finally`. proper-lockfile
  // treats a missing lock directory as already-removed, so release resolves --
  // worth pinning, because it is the difference between a purge completing and
  // a purge 500ing on the way out.
  it('releases cleanly when the marker was deleted underneath the holder', async () => {
    const release = await tryAcquireProvisioningLock(branchesRoot, '.branch-a.init.lock')
    await fs.rm(path.join(branchesRoot, '.branch-a.init.lock'), { recursive: true, force: true })
    await expect(release()).resolves.toBeUndefined()
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

  describe('staleness thresholds', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    /** A marker as a holder leaves it, last refreshed `ageMs` ago. */
    async function markerAged(dir: string, name: string, ageMs: number): Promise<string> {
      const marker = path.join(dir, name)
      await fs.mkdir(marker, { recursive: true })
      const then = new Date(Date.now() - ageMs)
      await fs.utimes(marker, then, then)
      return marker
    }

    it('every provisioning acquirer judges by the one 90s threshold, and every holder refreshes at 15s', async () => {
      const lockSpy = vi.spyOn(lockfile, 'lock')
      const releasePatient = await acquireProvisioningLock(branchesRoot, '.a.init.lock')
      const releaseTry = await tryAcquireProvisioningLock(branchesRoot, '.b.init.lock')
      const releaseContent = await tryAcquireContentWriteLock(path.join(tmpRoot, 'branch'))
      await Promise.all([releasePatient(), releaseTry(), releaseContent()])

      const options = lockSpy.mock.calls.map((call) => call[1])
      expect(options.map((o) => [o?.stale, o?.update])).toEqual([
        [90_000, 15_000],
        [90_000, 15_000],
        [30_000, 15_000],
      ])
    })

    it('leaves a provisioning marker that looks 40s old, which a live holder can through the NFS cache', async () => {
      const marker = await markerAged(branchesRoot, '.c.init.lock', 40_000)

      await expect(tryAcquireProvisioningLock(branchesRoot, '.c.init.lock')).rejects.toMatchObject({
        code: 'ELOCKED',
      })
      await expect(fs.stat(marker)).resolves.toBeTruthy()
    })

    it('still lets the content-write lock reap a 40s-old marker', async () => {
      const branchRoot = path.join(tmpRoot, 'branch')
      await markerAged(path.join(branchRoot, '.canopy-meta'), 'content-write.lock', 40_000)

      const release = await tryAcquireContentWriteLock(branchRoot)
      await release()
    })
  })
})
