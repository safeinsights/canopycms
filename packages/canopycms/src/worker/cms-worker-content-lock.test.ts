/**
 * [SYNC-C1] Cross-process exclusion between the worker's rebase loop and
 * concurrent content writes.
 *
 * `rebaseActiveBranches()` skips branches whose working tree is dirty, but the
 * check is a plain TOCTOU: once `git rebase` has started (fetch, replay, N
 * conflict rounds of awaited git subprocesses on EFS), a content write landing
 * in that window is destroyed two ways --
 *
 *  - `git checkout --theirs <file>` overwrites the just-saved working-tree
 *    content with the branch's committed version and stages it, after which
 *    the rebase SUCCEEDS and nothing logs a failure at all; and
 *  - `git rebase --abort` hard-resets the tree, discarding the save.
 *
 * Lambda's `ContentStore` and the worker share one EFS working tree and the
 * content files had only an in-process mutex, so nothing serialized them: the
 * editor got a 200 and the file was silently reverted.
 *
 * These tests drive that interleaving deterministically through the
 * `afterConflictDetectedForTesting()` seam (no sleeps, no shell rendezvous) --
 * see docs/concurrency.md's "Deterministic interleavings" testing pattern.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { flattenSchema } from '../config'
import { defineCanopyTestConfig } from '../config-test'
import { ContentConflictError, ContentStore } from '../content-store'
import { unsafeAsLogicalPath, unsafeAsSlug } from '../paths/test-utils'
import { initTestRepo, mockConsole } from '../test-utils'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { CmsWorker } from './cms-worker'

/**
 * Captures the `onCompromised` callback the worker installs on its
 * content-write lock, so a test can lose the lock at a chosen instant. A real
 * compromise needs proper-lockfile's ~15s refresh heartbeat; firing the
 * callback is the same code path without the wait. The mock delegates to the
 * real implementation, so every other test in this file is unaffected.
 */
const compromiseHook = vi.hoisted(() => ({ fire: undefined as ((err: Error) => void) | undefined }))

vi.mock('../utils/content-write-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/content-write-lock')>()
  return {
    ...actual,
    tryAcquireContentWriteLock: (branchRoot: string, onCompromised?: (err: Error) => void) => {
      if (onCompromised) compromiseHook.fire = onCompromised
      return actual.tryAcquireContentWriteLock(branchRoot, onCompromised)
    },
  }
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Entry file with an embedded ContentId, in the default content root. */
const ENTRY_FILE = 'content/posts/post.hello.TESTENTRYabc.json'
const COLLECTION = unsafeAsLogicalPath('content/posts')
const SLUG = unsafeAsSlug('hello')

const SCHEMA = {
  collections: [
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'json' as const,
          schema: [{ name: 'title', type: 'string' as const }],
        },
      ],
    },
  ],
} as const

const makeStore = (branchPath: string, contentWriteLockWaitMs = 150) =>
  new ContentStore(
    branchPath,
    flattenSchema(SCHEMA, defineCanopyTestConfig({ schema: SCHEMA }).contentRoot),
    { contentWriteLockWaitMs },
  )

/**
 * CmsWorker subclass that runs `onConflict` exactly once, at the instant the
 * rebase has reported conflicted files and is about to `checkout --theirs`
 * them -- i.e. squarely inside the window the old comment called safe.
 */
class ConflictHookWorker extends CmsWorker {
  onConflict?: () => Promise<void>
  onRebaseCompleted?: () => Promise<void>

  protected async afterConflictDetectedForTesting(): Promise<void> {
    const fn = this.onConflict
    this.onConflict = undefined
    if (fn) await fn()
  }

  protected async afterRebaseCompletedForTesting(): Promise<void> {
    const fn = this.onRebaseCompleted
    this.onRebaseCompleted = undefined
    if (fn) await fn()
  }
}

const makeWorker = (workspacePath: string) =>
  new ConflictHookWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    baseBranch: 'main',
  })

interface RebaseInternals {
  rebaseActiveBranches(): Promise<{
    rebased: string[]
    skippedDirty: string[]
    skippedLocked: string[]
    failed: { branch: string; error: string }[]
  }>
}

const runRebase = (worker: CmsWorker) =>
  (worker as unknown as RebaseInternals).rebaseActiveBranches()

interface ConflictSetup {
  branchPath: string
  branchGit: SimpleGit
}

/**
 * A branch clone whose entry file conflicts with the base branch, so the
 * rebase must enter its conflict round. Mirrors cms-worker-rebase.test.ts's
 * `createBranchSetup` (fixture remote is a non-bare repo the worker never
 * reads directly; the clone's `origin` is what the loop fetches).
 */
async function createConflictSetup(tmpDir: string, branchName: string): Promise<ConflictSetup> {
  const remotePath = path.join(tmpDir, 'remote')
  const contentBranchesPath = path.join(tmpDir, 'content-branches')
  const branchPath = path.join(contentBranchesPath, branchName)

  await fs.mkdir(remotePath)
  const remoteGit = await initTestRepo(remotePath)
  await remoteGit.raw(['branch', '-M', 'main'])

  const writeInto = async (root: string, content: string) => {
    const full = path.join(root, ENTRY_FILE)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }

  await writeInto(remotePath, '{\n  "title": "base"\n}\n')
  await remoteGit.add(['.'])
  await remoteGit.commit('initial commit')

  await fs.mkdir(contentBranchesPath, { recursive: true })
  await simpleGit().clone(remotePath, branchPath)

  const branchGit = simpleGit({ baseDir: branchPath, unsafe: { allowUnsafeEditor: true } })
  await branchGit.addConfig('user.name', 'Test Bot')
  await branchGit.addConfig('user.email', 'test@canopycms.test')
  await branchGit.addConfig('core.editor', 'true')

  const excludeFile = path.join(branchPath, '.git', 'info', 'exclude')
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  await fs.appendFile(excludeFile, '\n.canopy-meta/\n')

  await branchGit.checkoutBranch(branchName, 'origin/main')
  await branchGit.raw(['branch', '--set-upstream-to=origin/main', branchName])

  // Branch edits the entry...
  await writeInto(branchPath, '{\n  "title": "branch version"\n}\n')
  await branchGit.add(['.'])
  await branchGit.commit('branch: update entry')

  // ...and so does the base branch, on the same lines.
  await writeInto(remotePath, '{\n  "title": "main version"\n}\n')
  await remoteGit.add(['.'])
  await remoteGit.commit('main: update same entry')

  const meta = BranchMetadataFileManager.get(branchPath, contentBranchesPath)
  await meta.save({
    branch: { name: branchName, status: 'editing' as const, access: {}, createdBy: 'test' },
  })

  return { branchPath, branchGit }
}

const readEntry = (branchPath: string) => fs.readFile(path.join(branchPath, ENTRY_FILE), 'utf8')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rebase vs. content write exclusion', () => {
  let tmpDir: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-content-lock-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('never acknowledges a content write that a mid-flight rebase then rolls back', async () => {
    const setup = await createConflictSetup(tmpDir, 'my-feature')
    const store = makeStore(setup.branchPath)

    const worker = makeWorker(tmpDir)
    let writeOutcome: { ok: true } | { ok: false; err: unknown } | undefined
    worker.onConflict = async () => {
      // The editor saves RIGHT NOW: the rebase has started, conflicts are
      // reported, and `checkout --theirs` is the next thing that runs.
      try {
        await store.write(COLLECTION, SLUG, {
          format: 'json',
          data: { title: 'editor save' },
        })
        writeOutcome = { ok: true }
      } catch (err) {
        writeOutcome = { ok: false, err }
      }
    }

    await runRebase(worker)

    expect(writeOutcome).toBeDefined()
    const after = await readEntry(setup.branchPath)

    if (writeOutcome?.ok) {
      // A write the API answered 200 to must still be on disk. Before the
      // content-write lock existed this is exactly what failed: the write was
      // acknowledged and then silently reverted by `checkout --theirs`.
      expect(after).toContain('editor save')
    } else {
      // The other acceptable outcome: the write was refused, retriably, and
      // never acknowledged -- so nothing was rolled back behind the editor.
      expect(writeOutcome?.err).toBeInstanceOf(ContentConflictError)
      expect((writeOutcome?.err as Error).message).toMatch(/syncing/i)
      expect(after).not.toContain('editor save')
    }
  })

  it('skips a branch, without recording a failure, when the lock is lost mid-rebase', async () => {
    const setup = await createConflictSetup(tmpDir, 'my-feature')

    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)
    // Another host takes the lock over while the rebase is mid-conflict.
    worker.onConflict = async () => {
      compromiseHook.fire?.(new Error('simulated lock takeover'))
    }
    const summary = await runRebase(worker)

    // A lost lock is a RETRY, not a rebase failure.
    expect(summary.skippedLocked).toContain('my-feature')
    expect(summary.failed).toEqual([])
    expect(summary.rebased).not.toContain('my-feature')
    expect(consoleSpy).toHaveWarned(/compromised mid-rebase/i)
    consoleSpy.restore()

    // Nothing user-visible is recorded against the branch...
    const meta = await BranchMetadataFileManager.loadOnly(setup.branchPath)
    expect(meta?.branch.rebaseFailure).toBeUndefined()

    // ...and it is left behind, so the next cycle simply retries it.
    await setup.branchGit.fetch('origin', 'main')
    expect((await setup.branchGit.status()).behind).toBeGreaterThan(0)
  })

  // Regression: bailing out of a COMPLETED rebase strands a rewritten history.
  // `--abort` is a no-op by then, and the completion path owns the [SYNC-H1]
  // history-rewrite marker, the content-cache invalidation and the conflict
  // metadata -- none of which the next cycle redoes, because a caught-up branch
  // short-circuits on `behindCount === 0`. The result would be a permanently
  // wedged published branch, so the skip must apply only when !completed.
  it('finishes the sync when the lock is lost AFTER the rebase completed', async () => {
    const setup = await createConflictSetup(tmpDir, 'my-feature')

    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)
    worker.onRebaseCompleted = async () => {
      compromiseHook.fire?.(new Error('simulated lock takeover'))
    }
    const summary = await runRebase(worker)

    expect(summary.rebased).toContain('my-feature')
    expect(summary.skippedLocked).not.toContain('my-feature')
    expect(summary.failed).toEqual([])
    expect(consoleSpy).toHaveWarned(/already completed/i)
    consoleSpy.restore()

    // The rebase really did land -- the branch is caught up, which is exactly
    // why the next cycle would never revisit it.
    await setup.branchGit.fetch('origin', 'main')
    expect((await setup.branchGit.status()).behind).toBe(0)
  })

  it('skips a branch whose content-write lock is held, and reports the skip', async () => {
    const setup = await createConflictSetup(tmpDir, 'my-feature')
    const store = makeStore(setup.branchPath)

    // An editor's write is in flight when the cycle comes around: it holds the
    // cross-host lock but has not touched the file yet, so the working tree is
    // still clean and the dirty check would happily wave the rebase through.
    const release = await tryAcquireContentWriteLock(setup.branchPath)

    const consoleSpy = mockConsole()
    const worker = makeWorker(tmpDir)
    const summary = await runRebase(worker)

    expect(summary.skippedLocked).toContain('my-feature')
    expect(summary.rebased).not.toContain('my-feature')
    expect(consoleSpy).toHaveLogged(/content write in progress/i)
    consoleSpy.restore()

    // Untouched: still behind, so the branch is retried next cycle.
    await setup.branchGit.fetch('origin', 'main')
    expect((await setup.branchGit.status()).behind).toBeGreaterThan(0)

    // The in-flight write then completes against a tree nobody rewrote.
    await release()
    await store.write(COLLECTION, SLUG, { format: 'json', data: { title: 'editor save' } })
    expect(await readEntry(setup.branchPath)).toContain('editor save')
  })

  it('fails a content write with a retriable 409-shaped conflict while the rebase lock is held', async () => {
    const setup = await createConflictSetup(tmpDir, 'my-feature')
    const store = makeStore(setup.branchPath, 200)

    const release = await tryAcquireContentWriteLock(setup.branchPath)
    const startedAt = Date.now()
    try {
      await expect(
        store.write(COLLECTION, SLUG, { format: 'json', data: { title: 'editor save' } }),
      ).rejects.toThrow(ContentConflictError)
      // Bounded WAIT, not an instant failure: a lock handoff or a very short
      // hold must not surface to the editor at all.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150)
    } finally {
      await release()
    }

    // The tree still holds the committed version -- nothing half-written.
    expect(await readEntry(setup.branchPath)).toContain('branch version')

    // And once the lock is free the same write succeeds.
    await store.write(COLLECTION, SLUG, { format: 'json', data: { title: 'editor save' } })
    expect(await readEntry(setup.branchPath)).toContain('editor save')
  })

  it('releases the content lock when the rebase throws, not just on the happy path', async () => {
    const setup = await createConflictSetup(tmpDir, 'my-feature')

    // Throw from inside the locked region: the post-rebase metadata save.
    const saveSpy = vi
      .spyOn(BranchMetadataFileManager.prototype, 'save')
      .mockRejectedValue(new Error('boom'))

    const worker = makeWorker(tmpDir)
    await runRebase(worker)
    saveSpy.mockRestore()

    // The lock must be free -- a stranded lock would wedge every subsequent
    // write on this branch until it went stale.
    const release = await tryAcquireContentWriteLock(setup.branchPath)
    await release()
  })
})
