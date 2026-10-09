/**
 * The git sync's schema gate (worker/schema-gate.ts): the base branch does not fast-forward to
 * content naming an entry schema the serving editor's registry lacks. Drives a real `syncGit()`
 * against a bare "GitHub" fixture and a bare `remote.git`, as cms-worker-sync-reconcile.test.ts.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { recordSchemaRegistry } from '../schema-registry-record'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import { mockConsole, openBareRepo, type MockConsole } from '../test-utils'
import type { WorkerStatusReport } from '../types'
import { CmsWorker } from './cms-worker'

const BUILD = { canopycmsVersion: '1.2.3', sourceRevision: 'abc123' }

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
    ;(worker as unknown as { buildGitHubUrl(): string }).buildGitHubUrl = () => githubPath
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
    const hold = (await readStatus()).lastGitSync?.baseHold
    expect(hold).toMatchObject({
      incomingSha: incoming,
      missingSchemas: ['personSchema'],
      files: ['content/people/.collection.json'],
      editorBuild: BUILD,
    })
    expect(hold?.expired).toBeUndefined()
    expect((await readStatus()).lastGitSync?.tracked?.fastForwarded).not.toContain('main')
  })

  it('advances once the editor records a registry defining it, and clears the hold', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await mergePeopleCollection()
    const worker = makeWorker()
    await worker.syncGit()

    await editorDefines(['pageSchema', 'postSchema', 'personSchema'])
    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).lastGitSync?.baseHold).toBeUndefined()
  })

  it('keeps the first hold time while the base stays held across cycles', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const worker = makeWorker()
    await worker.syncGit()
    const firstSince = (await readStatus()).lastGitSync?.baseHold?.since

    await commitOnto(tmpDir, githubPath, 'main', { 'content/posts/a.json': '{}' })
    await worker.syncGit()

    expect(firstSince).toBeDefined()
    expect((await readStatus()).lastGitSync?.baseHold?.since).toBe(firstSince)
    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
  })

  it('advances anyway once the hold outlives its bound, reporting it as expired', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    const incoming = await mergePeopleCollection()

    await makeWorker(0).syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).lastGitSync?.baseHold).toMatchObject({
      missingSchemas: ['personSchema'],
      expired: true,
    })
    expect(consoleSpy).toHaveErrored('Advancing anyway')
  })

  it('starts a new hold afresh after an earlier one expired', async () => {
    await editorDefines(['pageSchema', 'postSchema'])
    await mergePeopleCollection()
    const worker = makeWorker(60 * 60_000)
    const report = (
      worker as unknown as { ensureStatusReport(): WorkerStatusReport }
    ).ensureStatusReport()
    report.lastGitSync = {
      durationMs: 1,
      rebased: [],
      skippedDirty: [],
      failed: [],
      baseHold: {
        since: '2000-01-01T00:00:00.000Z',
        incomingSha: baseSha,
        missingSchemas: ['pageSchema'],
        files: ['content/.collection.json'],
        editorBuild: BUILD,
        editorRecordedAt: '2000-01-01T00:00:00.000Z',
        expired: true,
      },
    }

    await worker.syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(baseSha)
    expect((await readStatus()).lastGitSync?.baseHold?.expired).toBeUndefined()
  })

  it('fails open with no record: the base advances as it would with no gate', async () => {
    const incoming = await mergePeopleCollection()

    await makeWorker().syncGit()

    expect(await refSha(remoteGitPath, 'refs/heads/main')).toBe(incoming)
    expect((await readStatus()).lastGitSync?.baseHold).toBeUndefined()
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
    expect((await readStatus()).lastGitSync?.baseHold?.files).toEqual([
      'site/content/people/.collection.json',
    ])
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
    expect((await readStatus()).lastGitSync?.baseHold).toBeUndefined()
  })
})
