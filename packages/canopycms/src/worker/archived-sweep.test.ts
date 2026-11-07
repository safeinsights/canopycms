import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildInitialBranchMetadata } from '../branch-metadata'
import { BRANCH_META_DIR, BRANCH_META_FILE } from '../branch-metadata-file'
import { listTasks } from '../task-queue/cms-task-queue'
import { mockConsole, type MockConsole } from '../test-utils/console-spy'
import { sanitizeBranchName } from '../paths/branch-name'
import type { BranchMetadata } from '../types'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import {
  MAX_ARCHIVED_SWEEP_PER_CYCLE,
  sweepArchivedBranches,
  type ArchivedSweepContext,
} from './archived-sweep'

vi.mock('./log', () => ({
  workerLog: vi.fn(),
  workerLogWarn: vi.fn(),
  workerLogError: vi.fn(),
}))

const git = promisify(execFile)

const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const DAY = 24 * 60 * 60_000
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString()

let root: string
let contentBranchesPath: string
let remoteGitPath: string
let taskDir: string
// A registry rescan names a corrupt branch.json on the console.
let consoleSpy: MockConsole

const ctxWith = (overrides: Partial<ArchivedSweepContext> = {}): ArchivedSweepContext => ({
  archivedBranchRetentionDays: 30,
  baseBranch: 'main',
  sanitizedBaseBranch: sanitizeBranchName('main'),
  contentBranchesPath,
  remoteGitPath,
  taskDir,
  ensureSettingsBranch: () => 'canopycms-settings-prod',
  isDraining: () => false,
  ...overrides,
})

const addBranch = async (
  name: string,
  fields: Partial<BranchMetadata>,
  dirName: string = sanitizeBranchName(name),
) => {
  const branchRoot = path.join(contentBranchesPath, dirName)
  await fs.mkdir(path.join(branchRoot, '.git'), { recursive: true })
  await fs.mkdir(path.join(branchRoot, BRANCH_META_DIR))
  await fs.writeFile(
    path.join(branchRoot, BRANCH_META_DIR, BRANCH_META_FILE),
    JSON.stringify(buildInitialBranchMetadata({ branch: { name, ...fields } })),
  )
  await fs.writeFile(path.join(branchRoot, BRANCH_META_DIR, 'comments.json'), '{}')
}

const hasWorkspace = (name: string) =>
  fs.access(path.join(contentBranchesPath, sanitizeBranchName(name))).then(
    () => true,
    () => false,
  )

const expired = { status: 'archived', archivedAt: daysAgo(31), mergedAt: daysAgo(31) } as const

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-archived-sweep-'))
  contentBranchesPath = path.join(root, 'content-branches')
  remoteGitPath = path.join(root, 'remote.git')
  taskDir = path.join(root, '.tasks')
  await fs.mkdir(contentBranchesPath)
  await fs.mkdir(taskDir)
  await git('git', ['init', '--bare', '--quiet', remoteGitPath])
})

afterEach(async () => {
  consoleSpy.restore()
  vi.clearAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('sweepArchivedBranches', () => {
  it('does nothing when retention is off, however old the branch', async () => {
    await addBranch('old', { status: 'archived', mergedAt: daysAgo(5000) })

    const report = await sweepArchivedBranches(
      ctxWith({ archivedBranchRetentionDays: undefined }),
      NOW,
    )

    expect(report).toBeUndefined()
    expect(await hasWorkspace('old')).toBe(true)
  })

  it('deletes only archived branches older than the retention period', async () => {
    await addBranch('expired', expired)
    await addBranch('merged-expired', { status: 'archived', mergedAt: daysAgo(31) })
    await addBranch('fresh', {
      status: 'archived',
      archivedAt: daysAgo(29),
      mergedAt: daysAgo(29),
    })
    await addBranch('live', { status: 'editing' })
    await addBranch('in-review', { status: 'submitted', submittedAt: daysAgo(90) })
    await addBranch('approved', { status: 'approved', mergedAt: daysAgo(90) })

    const report = await sweepArchivedBranches(ctxWith(), NOW)

    expect(report?.deleted.sort()).toEqual(['expired', 'merged-expired'])
    expect(await hasWorkspace('expired')).toBe(false)
    expect(await hasWorkspace('merged-expired')).toBe(false)
    expect(await hasWorkspace('fresh')).toBe(true)
    expect(await hasWorkspace('live')).toBe(true)
    expect(await hasWorkspace('in-review')).toBe(true)
    expect(await hasWorkspace('approved')).toBe(true)
  })

  it('reports nothing when nothing is due', async () => {
    await addBranch('live', { status: 'editing' })

    expect(await sweepArchivedBranches(ctxWith(), NOW)).toBeUndefined()
  })

  it('never selects a branch archived without merging, and queues nothing for it', async () => {
    await addBranch('abandoned', {
      status: 'archived',
      archivedAt: daysAgo(5000),
      pullRequestState: 'closed',
      pullRequestNumber: 9,
    })

    expect(await sweepArchivedBranches(ctxWith(), NOW)).toBeUndefined()

    expect(await hasWorkspace('abandoned')).toBe(true)
    expect(await listTasks(taskDir, 'pending')).toEqual([])
  })

  it('keeps the base and settings branches, and a branch that may hold unpublished commits', async () => {
    await addBranch('main', expired)
    await addBranch('canopycms-settings-prod', expired)
    await addBranch('self-based', { ...expired, baseBranch: 'self-based' })
    await addBranch('unpublished', { ...expired, unpublishedAtMerge: true })

    expect(await sweepArchivedBranches(ctxWith(), NOW)).toBeUndefined()

    expect(await hasWorkspace('main')).toBe(true)
    expect(await hasWorkspace('canopycms-settings-prod')).toBe(true)
    expect(await hasWorkspace('self-based')).toBe(true)
    expect(await hasWorkspace('unpublished')).toBe(true)
  })

  it('keeps a directory whose branch.json names another branch', async () => {
    await addBranch('other', expired, 'not-other')

    expect(await sweepArchivedBranches(ctxWith(), NOW)).toBeUndefined()
    expect(await fs.readdir(contentBranchesPath)).toContain('not-other')
  })

  it('skips an unreadable branch.json and carries on', async () => {
    await addBranch('corrupt', expired)
    await addBranch('expired', expired)
    await fs.writeFile(
      path.join(contentBranchesPath, 'corrupt', BRANCH_META_DIR, BRANCH_META_FILE),
      'not json',
    )

    const report = await sweepArchivedBranches(ctxWith(), NOW)

    expect(report?.deleted).toEqual(['expired'])
    expect(await hasWorkspace('corrupt')).toBe(true)
  })

  it('takes the oldest first, up to the cap, and leaves the rest for later', async () => {
    const count = MAX_ARCHIVED_SWEEP_PER_CYCLE + 2
    for (let i = 0; i < count; i++) {
      await addBranch(`b${i}`, { status: 'archived', mergedAt: daysAgo(100 + i) })
    }

    const report = await sweepArchivedBranches(ctxWith(), NOW)

    expect(report?.deleted).toHaveLength(MAX_ARCHIVED_SWEEP_PER_CYCLE)
    expect(report?.deferred).toBe(2)
    expect(await hasWorkspace(`b${count - 1}`)).toBe(false)
    expect(await hasWorkspace('b0')).toBe(true)
    expect(await hasWorkspace('b1')).toBe(true)
  })

  it('stops at the next branch once the worker drains', async () => {
    await addBranch('one', { status: 'archived', mergedAt: daysAgo(90) })
    await addBranch('two', { status: 'archived', mergedAt: daysAgo(80) })
    let checks = 0

    const report = await sweepArchivedBranches(ctxWith({ isDraining: () => ++checks > 1 }), NOW)

    expect(report?.deleted).toEqual(['one'])
    expect(await hasWorkspace('two')).toBe(true)
  })

  it('yields a branch whose provisioning lock another process holds, and retries it', async () => {
    await addBranch('held', expired)
    const release = await tryAcquireProvisioningLock(
      contentBranchesPath,
      branchProvisioningLockName('held'),
    )

    const report = await sweepArchivedBranches(ctxWith(), NOW)

    expect(report?.skippedLocked).toEqual(['held'])
    expect(report?.deleted).toEqual([])
    expect(await hasWorkspace('held')).toBe(true)

    await release()
    expect((await sweepArchivedBranches(ctxWith(), NOW))?.deleted).toEqual(['held'])
  })

  it('costs a failing branch only itself', async () => {
    await addBranch('older', { status: 'archived', mergedAt: daysAgo(90) })
    await addBranch('newer', { status: 'archived', mergedAt: daysAgo(80) })
    const metaPath = path.join(contentBranchesPath, 'older', BRANCH_META_DIR, BRANCH_META_FILE)
    let checks = 0
    // The first drain check falls between the listing and the first delete.
    const isDraining = () => {
      if (++checks === 1) writeFileSync(metaPath, 'not json')
      return false
    }

    const report = await sweepArchivedBranches(ctxWith({ isDraining }), NOW)

    expect(report?.failed.map((f) => f.branch)).toEqual(['older'])
    expect(report?.deleted).toEqual(['newer'])
    expect(await hasWorkspace('older')).toBe(true)
  })

  it('keeps a branch that changed after the listing', async () => {
    await addBranch('changing', expired)
    const metaPath = path.join(contentBranchesPath, 'changing', BRANCH_META_DIR, BRANCH_META_FILE)
    const editing = buildInitialBranchMetadata({ branch: { name: 'changing', status: 'editing' } })
    const isDraining = () => {
      writeFileSync(metaPath, JSON.stringify(editing))
      return false
    }

    const report = await sweepArchivedBranches(ctxWith({ isDraining }), NOW)

    expect(report?.deleted).toEqual([])
    expect(report?.failed).toEqual([])
    expect(await hasWorkspace('changing')).toBe(true)
  })

  it('removes the mirror head and queues the GitHub delete with what guards a reused name', async () => {
    const { stdout: tree } = await git('git', [
      '--git-dir',
      remoteGitPath,
      'hash-object',
      '-t',
      'tree',
      '-w',
      '/dev/null',
    ])
    const { stdout: commit } = await git(
      'git',
      ['--git-dir', remoteGitPath, 'commit-tree', tree.trim(), '-m', 'x'],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'a',
          GIT_AUTHOR_EMAIL: 'a@example.com',
          GIT_COMMITTER_NAME: 'a',
          GIT_COMMITTER_EMAIL: 'a@example.com',
        },
      },
    )
    for (const ref of ['refs/heads/gone/branch', 'refs/heads/stays']) {
      await git('git', ['--git-dir', remoteGitPath, 'update-ref', ref, commit.trim()])
    }
    await addBranch('gone/branch', { ...expired, pullRequestNumber: 7 })

    const report = await sweepArchivedBranches(ctxWith(), NOW)

    expect(report?.deleted).toEqual(['gone/branch'])
    const { stdout: refs } = await git('git', [
      '--git-dir',
      remoteGitPath,
      'for-each-ref',
      '--format=%(refname)',
    ])
    expect(refs.trim().split('\n')).toEqual(['refs/heads/stays'])
    const tasks = await listTasks(taskDir, 'pending')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      action: 'delete-remote-branch',
      payload: { branch: 'gone/branch', pullRequestNumber: 7 },
    })
  })

  it('queues nothing for a branch GitHub never saw', async () => {
    await addBranch('local-only', expired)

    await sweepArchivedBranches(ctxWith(), NOW)

    expect(await listTasks(taskDir, 'pending')).toEqual([])
  })
})
