import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { BRANCH_META_DIR, BRANCH_META_FILE } from '../branch-metadata-file'
import { sanitizeBranchName } from '../paths/branch-name'
import type { BranchStatus } from '../types'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import {
  MAX_BRANCH_NAME_LENGTH,
  MAX_PROTECTED_BRANCHES,
  type BranchPolicyDescription,
} from './branch-policy'
import {
  MAX_UNPUBLISHABLE_LISTED,
  findUnpublishableBranches,
  readCarriedGatewayPolicy,
  readCarriedUnpublishableBranches,
} from './unpublishable-branches'

let root: string
let contentBranchesPath: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-unpublishable-'))
  contentBranchesPath = path.join(root, 'content-branches')
  await fs.mkdir(contentBranchesPath)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

const POLICY: BranchPolicyDescription = {
  configured: ['main', 'canopycms/prod/release-*'],
  githubDefault: 'main',
  namespace: 'canopycms/prod/',
  legacy: ['spring'],
  settingsBranch: 'canopycms-settings-prod',
}

/**
 * A branch workspace as provisioning leaves one: its directory is the ref sanitized, and its
 * branch.json names the ref.
 */
async function workspace(
  name: string,
  status: BranchStatus = 'editing',
  dir: string = sanitizeBranchName(name),
) {
  const branchPath = path.join(contentBranchesPath, dir)
  await fs.mkdir(branchPath, { recursive: true })
  await getBranchMetadataFileManager(branchPath, contentBranchesPath).save({
    branch: { name, status },
  })
}

const context = () => ({ contentBranchesPath, sanitizedBaseBranch: sanitizeBranchName('main') })
const refs = (...names: string[]) => names.map((name) => ({ name }))

describe('findUnpublishableBranches', () => {
  it('lists editor branches outside the namespace or protected, by ref, and nothing else', async () => {
    await workspace('main')
    await workspace('canopycms/prod/spring-update')
    await workspace('spring')
    await workspace('autumn')
    await workspace('canopycms/prod/release-1')
    await workspace('feature/x')
    await workspace('old-merged', 'archived')
    // A purged branch waiting in the trash, whose name the gateway would refuse.
    await workspace('winter', 'editing', '.trash-x')
    await fs.writeFile(path.join(contentBranchesPath, 'branches.json'), '{}')
    // A registry write's temp file, waiting for its rename.
    await fs.writeFile(path.join(contentBranchesPath, 'branches.tmp.json.1.x'), '{}')
    await fs.mkdir(path.join(contentBranchesPath, 'no-metadata'))
    await fs.mkdir(path.join(contentBranchesPath, 'corrupt', BRANCH_META_DIR), { recursive: true })
    await fs.writeFile(
      path.join(contentBranchesPath, 'corrupt', BRANCH_META_DIR, BRANCH_META_FILE),
      '{',
    )

    expect(await findUnpublishableBranches(context(), POLICY)).toEqual({
      branches: refs('autumn', 'canopycms/prod/release-1', 'feature/x'),
      count: 3,
    })
  })

  it('reads the ref from branch.json, never the directory name', async () => {
    // Their directories, canopycms-prod-x and canopycms-prod-y, look alike; only the first ref is
    // in the namespace.
    await workspace('canopycms/prod/x')
    await workspace('canopycms-prod-y')

    expect(await findUnpublishableBranches(context(), POLICY)).toEqual({
      branches: refs('canopycms-prod-y'),
      count: 1,
    })
  })

  it('judges by the namespace the description gives', async () => {
    await workspace('canopycms/prod/a')
    await workspace('editor-production/b')

    expect(
      await findUnpublishableBranches(context(), { ...POLICY, namespace: 'editor-production/' }),
    ).toEqual({ branches: refs('canopycms/prod/a'), count: 1 })
  })

  it('lists at most MAX_UNPUBLISHABLE_LISTED names, counting them all', async () => {
    for (let i = 0; i < MAX_UNPUBLISHABLE_LISTED + 2; i++) await workspace(`old-${1000 + i}`)

    const report = await findUnpublishableBranches(context(), POLICY)

    expect(report.branches).toHaveLength(MAX_UNPUBLISHABLE_LISTED)
    expect(report.count).toBe(MAX_UNPUBLISHABLE_LISTED + 2)
  })

  it('reports none for a workspace with no branches yet', async () => {
    await fs.rm(contentBranchesPath, { recursive: true })

    expect(await findUnpublishableBranches(context(), POLICY)).toEqual({ branches: [], count: 0 })
  })

  it('fails, rather than reporting none, when the branches directory cannot be read', async () => {
    await fs.rm(contentBranchesPath, { recursive: true })
    await fs.writeFile(contentBranchesPath, 'not a directory')

    await expect(findUnpublishableBranches(context(), POLICY)).rejects.toThrow(/ENOTDIR/)
  })

  it('fails when an entry vanishes mid-listing, rather than reporting no branches directory', async () => {
    await workspace('autumn')
    // `readdir` with file types lstats each entry, and rejects with the entry's own ENOENT.
    vi.spyOn(fs, 'readdir').mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory, lstat'), {
        code: 'ENOENT',
        path: path.join(contentBranchesPath, 'autumn'),
      }),
    )

    await expect(findUnpublishableBranches(context(), POLICY)).rejects.toThrow(/ENOENT/)
  })

  it('fails, rather than leaving a branch out, when a branch.json cannot be read', async () => {
    await workspace('autumn')
    vi.spyOn(BranchMetadataFileManager, 'loadOnly').mockRejectedValue(
      Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }),
    )

    await expect(findUnpublishableBranches(context(), POLICY)).rejects.toThrow(/EIO/)
  })

  it('says which branches a legacyBranches entry would not publish, and why', async () => {
    // Named after part of the namespace: git holds no branch in it while these exist.
    await workspace('canopycms')
    await workspace('canopycms/prod')
    // A name legacyBranches refuses.
    await workspace('a,b')
    await workspace('autumn')

    expect(await findUnpublishableBranches(context(), POLICY)).toEqual({
      branches: [
        { name: 'a,b', reason: 'unlistable' },
        { name: 'autumn' },
        { name: 'canopycms', reason: 'blocks-namespace' },
        { name: 'canopycms/prod', reason: 'blocks-namespace' },
      ],
      count: 4,
    })
  })
})

describe('readCarriedUnpublishableBranches', () => {
  const AT = '2026-10-29T09:00:00.000Z'

  /** The report a previous worker left, as the status file holds it. */
  async function carry(unpublishableBranches: unknown) {
    await fs.writeFile(
      path.join(root, WORKER_STATUS_FILE),
      JSON.stringify({ version: 1, unpublishableBranches }),
    )
    return readCarriedUnpublishableBranches(root)
  }

  it('carries a report of the shape a sync records', async () => {
    const report = {
      branches: [
        { name: 'a'.repeat(MAX_BRANCH_NAME_LENGTH) },
        { name: 'a,b', reason: 'unlistable' },
      ],
      count: 60,
      at: AT,
    }

    expect(await carry(report)).toEqual(report)
  })

  it.each([
    [
      'more names than a report lists',
      {
        branches: refs(...Array.from({ length: MAX_UNPUBLISHABLE_LISTED + 1 }, (_, i) => `b${i}`)),
        count: MAX_UNPUBLISHABLE_LISTED + 1,
      },
    ],
    [
      'a name longer than a branch name can be',
      { branches: refs('a'.repeat(MAX_BRANCH_NAME_LENGTH + 1)), count: 1 },
    ],
    ['a count that is not whole', { branches: refs('autumn'), count: 1.5 }],
    ['a count smaller than its list', { branches: refs('autumn', 'winter'), count: 1 }],
    ['an unknown reason', { branches: [{ name: 'autumn', reason: 'other' }], count: 1 }],
    ['a count past any real workspace', { branches: refs('autumn'), count: 100_001 }],
  ])('carries nothing for a report with %s', async (_label, report) => {
    expect(await carry({ ...report, at: AT })).toBeUndefined()
  })

  it.each([
    ['an at that is not a date', 'not a date'],
    ['an at longer than a timestamp', `2026-10-29T09:00:00.${'0'.repeat(40)}Z`],
    ['an at that is not a string', 20261029],
  ])('carries nothing for a report with %s', async (_label, at) => {
    expect(await carry({ branches: refs('autumn'), count: 1, at })).toBeUndefined()
  })

  it('carries only the fields a sync writes', async () => {
    const carried = await carry({
      branches: [{ name: 'a,b', reason: 'unlistable', note: 'x'.repeat(1000) }, { name: 'autumn' }],
      count: 2,
      at: AT,
      extra: { huge: 'x'.repeat(1000) },
    })

    expect(carried).toEqual({
      branches: [{ name: 'a,b', reason: 'unlistable' }, { name: 'autumn' }],
      count: 2,
      at: AT,
    })
    expect(Object.keys(carried ?? {}).sort()).toEqual(['at', 'branches', 'count'])
  })
})

describe('readCarriedGatewayPolicy', () => {
  /** The gateway fields a previous worker left, as the status file holds them. */
  async function carry(fields: Record<string, unknown>) {
    await fs.writeFile(
      path.join(root, WORKER_STATUS_FILE),
      JSON.stringify({ version: 1, ...fields }),
    )
    return readCarriedGatewayPolicy(root)
  }

  it('carries the namespace and exact names a sync records', async () => {
    const fields = {
      gatewayBranchNamespace: 'canopycms/prod/',
      gatewayProtectedBranches: ['release', 'main'],
    }

    expect(await carry(fields)).toEqual(fields)
  })

  it('carries nothing from a file that holds no namespace, or none at all', async () => {
    expect(await carry({ gatewayProtectedBranches: ['main'] })).toEqual({})
    await fs.rm(path.join(root, WORKER_STATUS_FILE))
    expect(await readCarriedGatewayPolicy(root)).toEqual({})
  })

  it.each([
    ['a namespace that does not end with "/"', 'canopycms-prod-'],
    ['a namespace that is not a string', 7],
    ['a namespace longer than a branch name can be', `${'a'.repeat(MAX_BRANCH_NAME_LENGTH)}/`],
  ])('carries nothing for %s', async (_label, namespace) => {
    expect(
      await carry({ gatewayBranchNamespace: namespace, gatewayProtectedBranches: ['main'] }),
    ).toEqual({})
  })

  it.each([
    ['a glob', ['main', 'release-*']],
    ['a name that is not a string', ['main', 7]],
    ['an empty name', ['']],
    ['a name longer than a branch name can be', ['a'.repeat(MAX_BRANCH_NAME_LENGTH + 1)]],
    [
      'more names than a policy describes',
      Array.from({ length: MAX_PROTECTED_BRANCHES + 2 }, (_, i) => `b${i}`),
    ],
    ['a list that is not one', 'main'],
  ])('carries the namespace without protected names holding %s', async (_label, names) => {
    expect(
      await carry({ gatewayBranchNamespace: 'canopycms/prod/', gatewayProtectedBranches: names }),
    ).toEqual({ gatewayBranchNamespace: 'canopycms/prod/' })
  })
})
