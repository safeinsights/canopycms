import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ContentWriteLockBusyError,
  tryAcquireContentWriteLock,
  withContentWriteLock,
} from './content-write-lock'
import { mockConsole } from '../test-utils/console-spy'

/**
 * Captures the `onCompromised` callback so a test can lose the lock mid-hold
 * without waiting out proper-lockfile's refresh heartbeat. Delegates to the
 * real implementation otherwise.
 */
const compromiseHook = vi.hoisted(() => ({ fire: undefined as ((err: Error) => void) | undefined }))

vi.mock('./provisioning-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provisioning-lock')>()
  return {
    ...actual,
    tryAcquireProvisioningLock: (
      ...args: Parameters<typeof actual.tryAcquireProvisioningLock>
    ): ReturnType<typeof actual.tryAcquireProvisioningLock> => {
      compromiseHook.fire = args[2]
      return actual.tryAcquireProvisioningLock(...args)
    },
  }
})

describe('withContentWriteLock outcomes', () => {
  let branchRoot: string

  beforeEach(async () => {
    branchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-cwl-'))
  })

  afterEach(async () => {
    compromiseHook.fire = undefined
    await fs.rm(branchRoot, { recursive: true, force: true })
  })

  it('never recreates a branch root that no longer exists', async () => {
    const goneRoot = path.join(branchRoot, 'deleted-branch')
    const work = vi.fn()

    await expect(withContentWriteLock(goneRoot, work, 50)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(work).not.toHaveBeenCalled()
    await expect(fs.stat(goneRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it("reports 'not-run' when the wait expires, without running the work", async () => {
    const release = await tryAcquireContentWriteLock(branchRoot)
    const work = vi.fn().mockResolvedValue('done')
    try {
      const err = await withContentWriteLock(branchRoot, work, 50).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(ContentWriteLockBusyError)
      expect((err as ContentWriteLockBusyError).outcome).toBe('not-run')
      expect(work).not.toHaveBeenCalled()
    } finally {
      await release()
    }
  })

  it("reports 'unknown' when the lock is lost while the work runs", async () => {
    const consoleSpy = mockConsole()
    const err = await withContentWriteLock(branchRoot, async () => {
      compromiseHook.fire?.(new Error('lock taken over'))
      return 'done'
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ContentWriteLockBusyError)
    expect((err as ContentWriteLockBusyError).outcome).toBe('unknown')
    expect(consoleSpy).toHaveWarned(/compromised/)
    consoleSpy.restore()
  })
})
