import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  writeOccJsonFile,
  withOccRetry,
  withOccFileLock,
  OccWriteConflictError,
} from './occ-json-write'

describe('occ-json-write', () => {
  let tmpDir: string
  let filePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'occ-json-write-test-'))
    filePath = path.join(tmpDir, 'data.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('writeOccJsonFile', () => {
    it('creates a new file at version 1 with a writeId', async () => {
      const result = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )
      expect(result.version).toBe(1)
      expect(result.writeId).toBeTruthy()

      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(onDisk.name).toBe('first')
      expect(onDisk.version).toBe(1)
      expect(onDisk.writeId).toBe(result.writeId)
    })

    it('throws OccWriteConflictError creating a new file when one already exists', async () => {
      await writeOccJsonFile(filePath, { name: 'first' }, { expectedVersion: null, settleMs: 0 })
      await expect(
        writeOccJsonFile(filePath, { name: 'second' }, { expectedVersion: null, settleMs: 0 }),
      ).rejects.toThrow(OccWriteConflictError)
    })

    it('increments the version on update with the correct expectedVersion', async () => {
      const created = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )
      const updated = await writeOccJsonFile(
        filePath,
        { name: 'second' },
        { expectedVersion: created.version, settleMs: 0 },
      )
      expect(updated.version).toBe(2)

      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(onDisk.name).toBe('second')
      expect(onDisk.version).toBe(2)
    })

    it('throws OccWriteConflictError on update with a stale expectedVersion', async () => {
      await writeOccJsonFile(filePath, { name: 'first' }, { expectedVersion: null, settleMs: 0 })
      await expect(
        writeOccJsonFile(filePath, { name: 'second' }, { expectedVersion: 0, settleMs: 0 }),
      ).rejects.toThrow(OccWriteConflictError)
    })

    it('throws OccWriteConflictError when another write lands mid-settle', async () => {
      const created = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )

      const writePromise = writeOccJsonFile(
        filePath,
        { name: 'second' },
        { expectedVersion: created.version, settleMs: 150 },
      )

      // Land squarely inside the 150ms settle window, after the rename has
      // already happened (rename + precheck complete in low single-digit ms
      // on a local/tmp filesystem).
      await new Promise((resolve) => setTimeout(resolve, 50))
      await fs.writeFile(
        filePath,
        JSON.stringify({ name: 'interloper', version: 2, writeId: 'someone-else' }),
      )

      await expect(writePromise).rejects.toThrow(OccWriteConflictError)
    })

    it('works with settleMs 0', async () => {
      const result = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )
      expect(result.version).toBe(1)
    })

    it('appends a trailing newline when requested', async () => {
      await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0, trailingNewline: true },
      )
      const raw = await fs.readFile(filePath, 'utf-8')
      expect(raw.endsWith('\n')).toBe(true)
    })

    it('cleans up temp files, leaving only the target in the directory', async () => {
      const created = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )
      await writeOccJsonFile(
        filePath,
        { name: 'second' },
        { expectedVersion: created.version, settleMs: 0 },
      )

      const entries = await fs.readdir(tmpDir)
      expect(entries).toEqual(['data.json'])
    })
  })

  describe('withOccRetry', () => {
    it('retries on OccWriteConflictError and eventually succeeds', async () => {
      let attempts = 0
      const result = await withOccRetry(
        async () => {
          attempts += 1
          if (attempts < 3) throw new OccWriteConflictError()
          return 'done'
        },
        { maxAttempts: 5 },
      )
      expect(result).toBe('done')
      expect(attempts).toBe(3)
    })

    it('gives up after maxAttempts and rethrows', async () => {
      let attempts = 0
      await expect(
        withOccRetry(
          async () => {
            attempts += 1
            throw new OccWriteConflictError()
          },
          { maxAttempts: 3 },
        ),
      ).rejects.toThrow(OccWriteConflictError)
      expect(attempts).toBe(3)
    })

    it('retries errors matched by isRetryable in addition to OccWriteConflictError', async () => {
      let attempts = 0
      const result = await withOccRetry(
        async () => {
          attempts += 1
          if (attempts < 2) throw new Error('transient')
          return 'done'
        },
        { maxAttempts: 3, isRetryable: (err) => err instanceof Error },
      )
      expect(result).toBe('done')
      expect(attempts).toBe(2)
    })

    it('does not retry non-retryable errors', async () => {
      let attempts = 0
      await expect(
        withOccRetry(async () => {
          attempts += 1
          throw new Error('fatal')
        }),
      ).rejects.toThrow('fatal')
      expect(attempts).toBe(1)
    })
  })

  describe('withOccFileLock', () => {
    it('serializes concurrent critical sections on the same file', async () => {
      let active = 0
      let sawOverlap = false

      const enterSection = async () => {
        await withOccFileLock(filePath, async () => {
          active += 1
          if (active > 1) sawOverlap = true
          await new Promise((resolve) => setTimeout(resolve, 20))
          active -= 1
        })
      }

      await Promise.all([enterSection(), enterSection(), enterSection()])

      expect(sawOverlap).toBe(false)
    })

    it('releases the lock when fn throws, so a later call can still acquire it', async () => {
      await expect(
        withOccFileLock(filePath, async () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')

      let ran = false
      await withOccFileLock(filePath, async () => {
        ran = true
      })
      expect(ran).toBe(true)
    })

    it('does not clobber a concurrent lock on a different file in the same directory (regression)', async () => {
      // Regression for a bug where the lock's resource key was the shared
      // directory rather than the target file: proper-lockfile keys its
      // module-level bookkeeping (release fn, refresh timer) by that resource
      // string, so two locks on different files in the same directory
      // collided — releasing one silently marked the other released too
      // (killing its refresh timer) without removing its on-disk `.lock`
      // directory. Interleaving: A acquires, B acquires (both held at once),
      // A releases while B is still held, then B releases.
      const fileA = path.join(tmpDir, 'a.json')
      const fileB = path.join(tmpDir, 'b.json')

      let aRan = false
      let bRan = false

      let resolveAAcquired: () => void
      const aAcquired = new Promise<void>((resolve) => {
        resolveAAcquired = resolve
      })
      let resolveReleaseAGate: () => void
      const releaseAGate = new Promise<void>((resolve) => {
        resolveReleaseAGate = resolve
      })

      const taskA = withOccFileLock(fileA, async () => {
        aRan = true
        resolveAAcquired()
        // Hold fileA's lock until B has acquired its own lock too.
        await releaseAGate
      })

      const taskB = (async () => {
        await aAcquired
        await withOccFileLock(fileB, async () => {
          bRan = true
          // Both locks are now held simultaneously. Release A while B is
          // still holding fileB's lock.
          resolveReleaseAGate()
          await new Promise((resolve) => setTimeout(resolve, 30))
        })
      })()

      await expect(Promise.all([taskA, taskB])).resolves.toBeDefined()

      expect(aRan).toBe(true)
      expect(bRan).toBe(true)

      const entries = await fs.readdir(tmpDir)
      const lockDirs = entries.filter((entry) => entry.endsWith('.lock'))
      expect(lockDirs).toEqual([])
    })

    it('acquires a lock for a file that does not yet exist on disk', async () => {
      const notYetCreated = path.join(tmpDir, 'not-yet-created.json')
      let ran = false
      await withOccFileLock(notYetCreated, async () => {
        ran = true
        const exists = await fs
          .stat(notYetCreated)
          .then(() => true)
          .catch(() => false)
        expect(exists).toBe(false)
      })
      expect(ran).toBe(true)
    })
  })

  describe('deleteBranch vs. racing save (item 4)', () => {
    // Simulates deleteBranchHandler's real critical section (api/branch.ts:
    // withOccFileLock(metadataFile) { unlink(metadataFile); rm(branchRoot,
    // {recursive:true}) }) racing a concurrent save that reads the current
    // version and writes via writeOccJsonFile, ALSO serialized through
    // withOccFileLock on the same metaFile -- mirroring the lock
    // branch-metadata.ts's save() takes around its load+write.
    //
    // branch-metadata.ts's save() additionally guards this exact scenario at
    // a HIGHER level, with an `fs.stat(this.branchRoot)` pre-check before
    // ever reaching this lock (see save()'s doc comment in
    // branch-metadata.ts, and the "phantom-save guard (item 4b)" describe
    // block in branch-metadata.test.ts, which covers that guard directly by
    // calling the real save() after removing branchRoot). That guard is NOT
    // exercised here -- this test drives the raw withOccFileLock +
    // writeOccJsonFile primitives directly, without it, to pin down their
    // actual behavior when genuinely raced against each other.
    // NOT a phantom-resurrection story: the racing save's lock ACQUISITION
    // itself fails. deleteBranchHandler's `fs.rm(branchRoot,
    // {recursive:true})` runs INSIDE the withOccFileLock critical section,
    // i.e. before its `release()`, and it deletes `.canopy-meta/` -- the
    // parent directory of `branch.json.lock`. A concurrent save polling
    // `lockfile.lock()` for that path then gets ENOENT (parent gone) on its
    // next attempt. withOccFileLock's own retry loop distinguishes error
    // types precisely for this case: ELOCKED (genuine contention) retries,
    // ENOENT fails FAST with OccWriteConflictError -- retrying could never
    // succeed and must not resurrect the deleted directory. (An earlier
    // version delegated retries to proper-lockfile, which retries blindly
    // and burned the entire ~13.5s budget re-hitting ENOENT before failing;
    // this test originally pinned that slow-fail behavior and now pins the
    // fail-fast fix.) branch-metadata.ts's save() additionally short-circuits
    // the common case even earlier via its `fs.stat(branchRoot)` pre-check.
    it('serializes the two critical sections; the racing save fails FAST with OccWriteConflictError once the rm removes the lock directory parent mid-poll', async () => {
      const branchRoot = path.join(tmpDir, 'branch')
      const metaDir = path.join(branchRoot, '.canopy-meta')
      const metaFile = path.join(metaDir, 'branch.json')
      await fs.mkdir(metaDir, { recursive: true })
      await writeOccJsonFile(
        metaFile,
        { branch: { name: 'feature-x' } },
        { expectedVersion: null, settleMs: 0 },
      )

      let active = 0
      let sawOverlap = false
      let deleteDone = false

      let resolveDeleteAcquired: () => void
      const deleteAcquired = new Promise<void>((resolve) => {
        resolveDeleteAcquired = resolve
      })
      let resolveProceed!: () => void
      const proceed = new Promise<void>((resolve) => {
        resolveProceed = resolve
      })

      const deleteOp = withOccFileLock(metaFile, async () => {
        active += 1
        if (active > 1) sawOverlap = true
        resolveDeleteAcquired()
        // Hold the lock until the racing save has queued its own attempt
        // behind this one, mirroring deleteBranchHandler's sequence.
        await proceed
        await fs.unlink(metaFile).catch(() => {})
        await fs.rm(branchRoot, { recursive: true, force: true })
        deleteDone = true
        active -= 1
      })

      // Ensure delete has genuinely acquired the lock (and thus mkdir'd
      // metaDir once, before the save below does its own one-time mkdir)
      // before the racing save even attempts to acquire.
      await deleteAcquired

      const saveResultPromise = withOccFileLock(metaFile, async () => {
        active += 1
        if (active > 1) sawOverlap = true
        return writeOccJsonFile(
          metaFile,
          { branch: { name: 'racing-save' } },
          { expectedVersion: 1, settleMs: 0 },
        )
      })
      // Prevent an unhandled-rejection warning from the expected failure
      // racing ahead of the `expect(...).rejects` assertion below.
      saveResultPromise.catch(() => {})

      // Let delete proceed now that the racing save is queued behind it.
      resolveProceed()

      await deleteOp
      expect(deleteDone).toBe(true)

      // The racing save's critical section body never overlapped with
      // delete's (it never even got IN -- see below).
      expect(sawOverlap).toBe(false)

      // The save never got a chance to acquire the lock at all: its own
      // withOccFileLock call fails outright, so `active` inside its
      // callback never even incremented for it. And it fails FAST (ENOENT is
      // not retried), not after the multi-second contention budget.
      const failStart = Date.now()
      await expect(saveResultPromise).rejects.toThrow(OccWriteConflictError)
      await expect(saveResultPromise).rejects.toThrow(/ENOENT/)
      expect(Date.now() - failStart).toBeLessThan(5000)

      // delete's own sequence completed cleanly and left nothing behind --
      // no resurrection, no orphaned lock artifact.
      const branchRootExists = await fs
        .stat(branchRoot)
        .then(() => true)
        .catch(() => false)
      expect(branchRootExists).toBe(false)
    }, 30_000)
  })
})
