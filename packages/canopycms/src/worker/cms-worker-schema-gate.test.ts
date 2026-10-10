/**
 * The git sync's schema gate (worker/schema-gate.ts): the base branch does not fast-forward to
 * content naming an entry schema the serving editor's registry lacks. Drives a real `syncGit()`
 * against a bare "GitHub" fixture and a bare `remote.git`, as cms-worker-sync-reconcile.test.ts.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { recordSchemaRegistry } from '../schema-registry-record'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import { mockConsole, openBareRepo, useLocalGitHubGateway, type MockConsole } from '../test-utils'
import type { WorkerStatusReport } from '../types'
import { CmsWorker } from './cms-worker'

const BUILD = { canopycmsVersion: '1.2.3', sourceRevision: 'abc123' }

/** Makes the sync cycle's task sweep, a step after the reconcile, throw while set. */
const sweepFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }))
vi.mock('../task-queue/cms-task-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../task-queue/cms-task-queue')>()
  return {
    ...actual,
    cleanupOldTasks: async (...args: Parameters<typeof actual.cleanupOldTasks>) => {
      if (sweepFailure.error) throw sweepFailure.error
      return actual.cleanupOldTasks(...args)
    },
  }
})

/** Runs once, inside the schema gate's registry read, then clears itself. */
const insideGate = vi.hoisted(() => ({ fn: undefined as (() => void) | undefined }))
vi.mock('../schema-registry-record', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schema-registry-record')>()
  return {
    ...actual,
    readSchemaRegistryRecord: async (
      ...args: Parameters<typeof actual.readSchemaRegistryRecord>
    ) => {
      const fn = insideGate.fn
      insideGate.fn = undefined
      fn?.()
      return actual.readSchemaRegistryRecord(...args)
    },
  }
})

function collectionMeta(name: string, schemas: string[]): string {
  return JSON.stringify({
    name,
    entries: schemas.map((schema, i) => ({ name: `type${i}`, format: 'json', schema })),
  })
}

let scratchCounter = 0

/** Commit `files` onto `branch` of `bareRepoPath` through a throwaway clone; returns the SHA. */
async function commitOnto(
  scratchRoot: string,
  bareRepoPath: string,
  branch: string,
  files: Record<string, string>,
): Promise<string> {
  const scratchDir = path.join(scratchRoot, `scratch-${scratchCounter++}`)
  await fs.mkdir(scratchDir, { recursive: true })
  const git = simpleGit({ baseDir: scratchDir })
  const exists = await openBareRepo(bareRepoPath)
    .raw(['rev-parse', '--verify', `refs/heads/${branch}`])
    .then(
      () => true,
      () => false,
    )
  if (exists) {
    await simpleGit().clone(bareRepoPath, scratchDir, ['--branch', branch, '--single-branch'])
  } else {
    await git.init()
    await git.checkout(['--orphan', branch])
  }
  await git.addConfig('user.name', 'Test Bot')
  await git.addConfig('user.email', 'test@canopycms.test')
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(scratchDir, name)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  await git.add(['.'])
  await git.commit(`commit on ${branch}`)
  await git.raw(['push', bareRepoPath, `${branch}:${branch}`])
  return (await git.revparse(['HEAD'])).trim()
}

async function refSha(bareRepoPath: string, ref: string): Promise<string> {
  return (await openBareRepo(bareRepoPath).raw(['rev-parse', ref])).trim()
}

describe('CmsWorker.syncGit() schema gate', () => {
  let tmpDir: string
  let workspacePath: string
  let githubPath: string
  let remoteGitPath: string
  let branchesRoot: string
  let baseSha: string
  let consoleSpy: MockConsole

  const readStatus = async (): Promise<WorkerStatusReport> =>
    JSON.parse(await fs.readFile(path.join(workspacePath, '.tasks', WORKER_STATUS_FILE), 'utf-8'))

  const editorDefines = (schemas: string[], contentRoot = 'content') =>
    recordSchemaRegistry(branchesRoot, {
      schemas,
      fingerprint: schemas.join(','),
      contentRoot,
      build: BUILD,
    })

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-schema-gate-test-'))
    workspacePath = path.join(tmpDir, 'workspace')
    githubPath = path.join(tmpDir, 'fixture-github.git')
    remoteGitPath = path.join(workspacePath, 'remote.git')
    branchesRoot = path.join(workspacePath, 'content-branches')

    await fs.mkdir(branchesRoot, { recursive: true })
    await simpleGit().raw(['init', '--bare', githubPath])
    await simpleGit().raw(['init', '--bare', remoteGitPath])

    baseSha = await commitOnto(tmpDir, githubPath, 'main', {
      'content/.collection.json': collectionMeta('root', ['pageSchema']),
      'content/posts/.collection.json': collectionMeta('posts', ['postSchema']),
    })
    await openBareRepo(remoteGitPath).raw(['fetch', githubPath, '+refs/heads/main:refs/heads/main'])
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeWorker = (schemaHoldMaxMs?: number) => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
      ...(schemaHoldMaxMs === undefined ? {} : { schemaHoldMaxMs }),
    })
    useLocalGitHubGateway(worker, { remoteUrl: () => githubPath })
    ;(worker as unknown as { running: boolean }).running = true
    return worker
  }

  /** GitHub's main gains a collection using `personSchema`. */
  const mergePeopleCollection = () =>
    commitOnto(tmpDir, githubPath, 'main', {
      'content/people/.collection.json': collectionMeta('people', ['personSchema']),
    })

  it('holds the base branch while the editor lacks a schema the incoming content names', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await mergePeopleCollection()

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    const hold = (await readStatus()).baseHold
    expect(hold).toMatchObject({
      incomingSha: incoming,
      missingSchemas: ['personSchema'],
      files: ['content/people/.collection.json'],
      editorBuild: BUILD,
    })
    expect(hold?.expired).toBeUndefined()
    expect((await readStatus()).lastGitSync?.tracked?.fastForwarded).not.toContain('main')
  })

  it('a drain during a held sync keeps the hold, which the next worker carries with the shutdown', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const first = makeWorker()
    await (first as unknown as { acquireLock(): Promise<void> }).acquireLock()
    await first.syncGit()
    const held = (await readStatus()).baseHold
    expect(held?.missingSchemas).toEqual(['personSchema'])

    // The drain begins during the next held cycle's fetch.
    useLocalGitHubGateway(first, {
      remoteUrl: () => {
        void first.stop({ reason: 'SIGTERM' })
        return githubPath
      },
    })
    await first.syncGit()
    await first.stop()

    expect(consoleSpy).toHaveLogged('Git sync stopped before the base-branch refresh')
    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    const afterDrain = await readStatus()
    expect(afterDrain.baseHold?.firstSeen).toEqual(held?.firstSeen)
    expect(afterDrain.lastShutdown).toMatchObject({ reason: 'SIGTERM', outcome: 'drained' })

    const successor = makeWorker()
    try {
      await successor.start()
      const status = await readStatus()
      expect(status.baseHold?.firstSeen).toEqual(held?.firstSeen)
      expect(status.baseHold?.since).toBe(held?.since)
      expect(status.lastShutdown?.reason).toBe('SIGTERM')
      expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    } finally {
      await successor.stop()
    }
  })

  it('an abort while the gate decides neither advances the held base nor drops the hold', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const worker = makeWorker()
    const internals = worker as unknown as {
      trackOperation(label: string, operation: Promise<void>): Promise<void>
      shutdownController: AbortController
      ensureStatusReport(): WorkerStatusReport
    }
    // A compromise aborts at once, while the reconcile is mid-decision.
    insideGate.fn = () => void worker.stop({ reason: 'worker lock compromised', deadlineMs: 0 })

    await internals.trackOperation('git sync', worker.syncGit()).catch(() => {})
    await worker.stop()

    expect(insideGate.fn).toBeUndefined()
    expect(internals.shutdownController.signal.aborted).toBe(true)
    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    expect(internals.ensureStatusReport().baseHold?.missingSchemas).toEqual(['personSchema'])
  })

  it('a stop during the lock acquisition keeps the hold the previous worker left', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const previous = makeWorker()
    await previous.syncGit()
    const held = (await readStatus()).baseHold
    expect(held).toBeDefined()

    const next = makeWorker()
    const starting = next.start()
    await next.stop({ reason: 'SIGTERM' })
    await starting

    const status = await readStatus()
    expect(status.lastShutdown?.reason).toBe('SIGTERM')
    expect(status.baseHold?.firstSeen).toEqual(held?.firstSeen)
  })

  it('advances once the editor records a registry defining it, and clears the hold', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await mergePeopleCollection()
    const worker = makeWorker()
    await worker.syncGit()

    await editorDefines(['pageSchema', 'postSchema', 'personSchema'])
    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).baseHold).toBeUndefined()
  })

  it('keeps the first hold time while the base stays held across cycles', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const worker = makeWorker()
    await worker.syncGit()
    const firstSince = (await readStatus()).baseHold?.since

    await commitOnto(tmpDir, githubPath, 'main', { 'content/posts/a.json': '{}' })
    await worker.syncGit()

    expect(firstSince).toBeDefined()
    expect((await readStatus()).baseHold?.since).toBe(firstSince)
    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
  })

  it('advances anyway once the hold outlives its bound, reporting it as expired', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await mergePeopleCollection()

    await makeWorker(0).syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).baseHold).toMatchObject({
      missingSchemas: ['personSchema'],
      expired: true,
    })
    expect(consoleSpy).toHaveErrored('Advancing anyway')
  })

  /** Seed the worker's in-memory hold, as a previous cycle or a restart would have left it. */
  const seedHold = (worker: CmsWorker, firstSeen: Record<string, string>, expired?: true) => {
    const report = (
      worker as unknown as { ensureStatusReport(): WorkerStatusReport }
    ).ensureStatusReport()
    report.baseHold = {
      since: Object.values(firstSeen).sort()[0],
      firstSeen,
      incomingSha: baseSha,
      missingSchemas: Object.keys(firstSeen),
      files: ['content/people/.collection.json'],
      fileCount: 1,
      editorBuild: BUILD,
      editorRecordedAt: '2000-01-01T00:00:00.000Z',
      ...(expired ? { expired } : {}),
    }
  }
  const LONG_AGO = '2000-01-01T00:00:00.000Z'

  it('advances once a carried hold has waited its bound', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await mergePeopleCollection()
    const worker = makeWorker(60 * 60_000)
    seedHold(worker, { personSchema: LONG_AGO })

    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).baseHold).toMatchObject({
      firstSeen: { personSchema: LONG_AGO },
      expired: true,
    })
  })

  it('times a missing schema from its own first sighting, not an earlier one since deployed', async () => {
    await editorDefines(['pageSchema', 'postSchema', 'personSchema'])
    await commitOnto(tmpDir, githubPath, 'main', {
      'content/people/.collection.json': collectionMeta('people', ['personSchema']),
      'content/teams/.collection.json': collectionMeta('teams', ['teamSchema']),
    })
    const worker = makeWorker(60 * 60_000)
    seedHold(worker, { personSchema: LONG_AGO })

    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    const hold = (await readStatus()).baseHold
    expect(hold?.missingSchemas).toEqual(['teamSchema'])
    expect(hold?.since).not.toBe(LONG_AGO)
    expect(hold?.expired).toBeUndefined()
  })

  it('advances once the oldest missing schema has waited, even while a newer one waits', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await commitOnto(tmpDir, githubPath, 'main', {
      'content/people/.collection.json': collectionMeta('people', ['personSchema']),
      'content/teams/.collection.json': collectionMeta('teams', ['teamSchema']),
    })
    const worker = makeWorker(60 * 60_000)
    seedHold(worker, { personSchema: LONG_AGO })

    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).baseHold).toMatchObject({ since: LONG_AGO, expired: true })
  })

  it('times a schema named __proto__ like any other', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await commitOnto(tmpDir, githubPath, 'main', {
      'content/odd/.collection.json': collectionMeta('odd', ['__proto__']),
    })
    await makeWorker().syncGit()
    const raw = await fs.readFile(path.join(workspacePath, '.tasks', WORKER_STATUS_FILE), 'utf-8')
    expect(raw).toMatch(/"firstSeen": \{\s*"__proto__": "/)

    const worker = makeWorker(60 * 60_000)
    seedHold(worker, JSON.parse(`{"__proto__":"${LONG_AGO}"}`) as Record<string, string>)

    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).baseHold?.expired).toBe(true)
  })

  it('restarts the wait for a carried time in the future', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const worker = makeWorker(60 * 60_000)
    seedHold(worker, { personSchema: '2999-01-01T00:00:00.000Z' })

    await worker.syncGit()

    const since = Date.parse((await readStatus()).baseHold?.since ?? '')
    expect(since).toBeLessThanOrEqual(Date.now())
  })

  it('clears a hold when GitHub no longer has the base branch', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await openBareRepo(githubPath).raw(['branch', 'other', 'main'])
    await openBareRepo(githubPath).raw(['update-ref', '-d', 'refs/heads/main'])
    const worker = makeWorker()
    seedHold(worker, { personSchema: LONG_AGO })

    await worker.syncGit()

    expect((await readStatus()).baseHold).toBeUndefined()
  })

  it('starts a new schema afresh after an earlier one expired', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const worker = makeWorker(60 * 60_000)
    seedHold(worker, { otherSchema: LONG_AGO }, true)

    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    expect((await readStatus()).baseHold?.expired).toBeUndefined()
  })

  it('restarts the wait for a name whose carried time does not parse', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const worker = makeWorker(60 * 60_000)
    seedHold(worker, { personSchema: 'not a date' })

    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    expect(Number.isNaN(Date.parse((await readStatus()).baseHold?.since ?? ''))).toBe(false)
  })

  it('carries the hold into a restarted worker, so the bound keeps counting', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    await makeWorker().syncGit()
    const firstSince = (await readStatus()).baseHold?.since

    const restarted = makeWorker()
    const internals = restarted as unknown as {
      ensureRemoteGit(): Promise<void>
      ensureStatusReport(): WorkerStatusReport
      running: boolean
    }
    internals.ensureRemoteGit = async () => {
      throw new Error('stop after the start snapshot')
    }
    await expect(restarted.start()).rejects.toThrow(/stop after the start snapshot/)
    expect(internals.ensureStatusReport().baseHold?.since).toBe(firstSince)

    internals.running = true
    await restarted.syncGit()
    expect(firstSince).toBeDefined()
    expect((await readStatus()).baseHold?.since).toBe(firstSince)
  })

  it('keeps the hold when a later step of the cycle throws', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    sweepFailure.error = new Error('task sweep fails')
    try {
      await expect(makeWorker().syncGit()).rejects.toThrow(/task sweep fails/)
    } finally {
      sweepFailure.error = undefined
    }

    expect((await readStatus()).baseHold?.missingSchemas).toEqual(['personSchema'])
  })

  it('clears a hold once the base matches GitHub, as after the held merge is force-pushed away', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const worker = makeWorker()
    seedHold(worker, { personSchema: LONG_AGO })

    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    expect((await readStatus()).baseHold).toBeUndefined()
  })

  it('reports at most ten referencing files, with their total', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const files: Record<string, string> = {}
    for (let i = 0; i < 12; i++) {
      files[`content/people${i}/.collection.json`] = collectionMeta(`people${i}`, ['personSchema'])
    }
    await commitOnto(tmpDir, githubPath, 'main', files)

    await makeWorker().syncGit()

    const hold = (await readStatus()).baseHold
    expect(hold?.files).toHaveLength(10)
    expect(hold?.fileCount).toBe(12)
  })

  it('refuses to start with a hold bound that would never expire, recording why', async () => {
    await expect(makeWorker(Number.NaN).start()).rejects.toThrow(/schemaHoldMaxMs/)
    expect((await readStatus()).lastFatalError?.message).toMatch(/schemaHoldMaxMs/)
    await expect(makeWorker(-1).start()).rejects.toThrow(/schemaHoldMaxMs/)
  })

  it('reads a symlinked meta file through to its target', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const scratch = path.join(tmpDir, 'scratch-symlink')
    await simpleGit().clone(githubPath, scratch, ['--branch', 'main'])
    const git = simpleGit({ baseDir: scratch })
    await git.addConfig('user.name', 'Test Bot')
    await git.addConfig('user.email', 'test@canopycms.test')
    await fs.mkdir(path.join(scratch, 'content/_meta'), { recursive: true })
    await fs.mkdir(path.join(scratch, 'content/people'), { recursive: true })
    await fs.writeFile(
      path.join(scratch, 'content/_meta/people.json'),
      collectionMeta('people', ['personSchema']),
    )
    await fs.symlink('../_meta/people.json', path.join(scratch, 'content/people/.collection.json'))
    await git.add(['.'])
    await git.commit('symlinked meta')
    await git.raw(['push', githubPath, 'main:main'])

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    expect((await readStatus()).baseHold?.missingSchemas).toEqual(['personSchema'])
  })

  it('holds when only the target of a symlinked meta file changed', async () => {
    const scratch = path.join(tmpDir, 'scratch-symlink-target')
    await simpleGit().clone(githubPath, scratch, ['--branch', 'main'])
    const git = simpleGit({ baseDir: scratch })
    await git.addConfig('user.name', 'Test Bot')
    await git.addConfig('user.email', 'test@canopycms.test')
    await fs.mkdir(path.join(scratch, 'content/_meta'), { recursive: true })
    await fs.mkdir(path.join(scratch, 'content/people'), { recursive: true })
    await fs.writeFile(
      path.join(scratch, 'content/_meta/people.json'),
      collectionMeta('people', ['postSchema']),
    )
    await fs.symlink('../_meta/people.json', path.join(scratch, 'content/people/.collection.json'))
    await git.add(['.'])
    await git.commit('symlinked meta')
    await git.raw(['push', githubPath, 'main:main'])
    await openBareRepo(remoteGitPath).raw(['fetch', githubPath, '+refs/heads/main:refs/heads/main'])
    const linkedBase = await refSha(remoteGitPath, 'refs/heads/main')
    await editorDefines(['pageSchema', 'postSchema'])
    await commitOnto(tmpDir, githubPath, 'main', {
      'content/_meta/people.json': collectionMeta('people', ['personSchema']),
    })

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(linkedBase)
    expect((await readStatus()).baseHold?.missingSchemas).toEqual(['personSchema'])
  })

  it('reads a content root named like pathspec magic as a literal directory', async () => {
    await editorDefines(['pageSchema', 'postSchema'], ':content')
    await commitOnto(tmpDir, githubPath, 'main', {
      ':content/people/.collection.json': collectionMeta('people', ['personSchema']),
    })

    await makeWorker().syncGit()

    expect((await readStatus()).baseHold?.files).toEqual([':content/people/.collection.json'])
  })

  it('fails open with no record: the base advances as it would with no gate', async () => {
    const incoming = await mergePeopleCollection()

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).baseHold).toBeUndefined()
  })

  it('does not hold for a name the current base already references', async () => {
    // The editor already lacks postSchema; holding cannot repair a live reference.
    await editorDefines(['pageSchema'])
    const incoming = await commitOnto(tmpDir, githubPath, 'main', {
      'content/posts/hello.json': '{"title":"hi"}',
      'content/posts/.collection.json': collectionMeta('posts', ['postSchema']).replace(
        '"posts"',
        '"Posts"',
      ),
    })

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
  })

  it('reads collection meta only under the recorded content root', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await commitOnto(tmpDir, githubPath, 'main', {
      'fixtures/.collection.json': collectionMeta('fixture', ['personSchema']),
    })

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
  })

  it('reads a nested content root from the record', async () => {
    await editorDefines(['pageSchema', 'postSchema'], './site/content/')
    await commitOnto(tmpDir, githubPath, 'main', {
      'site/content/people/.collection.json': collectionMeta('people', ['personSchema']),
    })

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    expect((await readStatus()).baseHold?.files).toEqual(['site/content/people/.collection.json'])
  })

  it('never holds a branch other than the base', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await openBareRepo(githubPath).raw(['branch', 'feature', 'main'])
    await openBareRepo(remoteGitPath).raw(['branch', 'feature', 'main'])
    const featureTip = await commitOnto(tmpDir, githubPath, 'feature', {
      'content/people/.collection.json': collectionMeta('people', ['personSchema']),
    })

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/feature')).toBe(featureTip)
    expect((await readStatus()).baseHold).toBeUndefined()
  })
})
