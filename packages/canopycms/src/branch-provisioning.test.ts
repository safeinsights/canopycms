/**
 * Crash-safe branch provisioning ([PROV-1], branch-provisioning.ts), against
 * real git in prod mode. Every residue below is built by hand in the exact
 * shape a killed process leaves behind.
 */
import { lstatSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import {
  classifyFinalDir,
  formatDirStamp,
  quarantineResidueAt,
  shortDirName,
  sweepProvisioningLeftovers,
} from './branch-provisioning'
import { BranchWorkspaceManager, setProvisioningTestHooks } from './branch-workspace'
import { BranchRegistry } from './branch-registry'
import { defineCanopyTestConfig } from './config-test'
import { SettingsWorkspaceManager } from './settings-workspace'
import { initTestRepo, mockConsole, useLocalGitHubGateway, type MockConsole } from './test-utils'
import {
  acquireProvisioningLock,
  branchProvisioningLockName,
  tryAcquireProvisioningLock,
} from './utils/provisioning-lock'
import { CmsWorker } from './worker/cms-worker'
import { repairBranchDirResidue } from './worker/git-sync'

let tmpDir: string
let workspaceRoot: string
let baseRoot: string
let remoteUrl: string
let consoleSpy: MockConsole

beforeEach(async () => {
  consoleSpy = mockConsole()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-prov-'))
  workspaceRoot = path.join(tmpDir, 'ws')
  baseRoot = path.join(workspaceRoot, 'content-branches')
  vi.stubEnv('CANOPYCMS_WORKSPACE_ROOT', workspaceRoot)
  remoteUrl = await makeRemote()
})

afterEach(async () => {
  setProvisioningTestHooks()
  consoleSpy.restore()
  vi.unstubAllEnvs()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function makeRemote(): Promise<string> {
  const sourceDir = path.join(tmpDir, 'source')
  await fs.mkdir(path.join(sourceDir, 'content'), { recursive: true })
  const source = await initTestRepo(sourceDir)
  await source.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await fs.writeFile(path.join(sourceDir, 'content', 'hello.md'), '# hi\n')
  await source.add('.')
  await source.commit('initial')
  // Where prod auto-detects it, and where the worker keeps it.
  const remotePath = path.join(workspaceRoot, 'remote.git')
  await simpleGit().raw(['clone', '-q', '--bare', sourceDir, remotePath])
  return remotePath
}

function config(mode: 'prod' | 'dev' = 'prod') {
  return defineCanopyTestConfig({
    mode,
    defaultBaseBranch: 'main',
    defaultRemoteUrl: remoteUrl,
    deploymentName: 'test',
    schema: { collections: [] },
  })
}

function create(branchName: string, createdBy = 'user-1', access = {}) {
  return new BranchWorkspaceManager(config()).openOrCreateBranch({
    branchName,
    mode: 'prod',
    createdBy,
    access,
  })
}

async function backdate(target: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs)
  await fs.utimes(target, when, when)
}

/**
 * What a Lambda killed mid-provisioning by the pre-staging code left at the
 * final path: a `--no-checkout` clone (no index), a 0-byte `config.lock` from
 * the `git config` it died inside, and no `.canopy-meta/`.
 */
async function makeIncidentResidue(dirName: string, ageMs: number): Promise<string> {
  const finalPath = path.join(baseRoot, dirName)
  await fs.mkdir(baseRoot, { recursive: true })
  await simpleGit().raw(['clone', '-q', '--no-checkout', '-b', 'main', remoteUrl, finalPath])
  await fs.writeFile(path.join(finalPath, '.git', 'config.lock'), '')
  await backdate(path.join(finalPath, '.git'), ageMs)
  await backdate(finalPath, ageMs)
  return finalPath
}

async function listLocks(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true })
  return entries.filter((entry) => entry.endsWith('.lock'))
}

/** Every staging, quarantine and delete leftover beside the branch directories. */
async function leftoverDirs(root: string): Promise<string[]> {
  return (await fs.readdir(root)).filter((name) => /^\.(prov|repair|trash|deleting)-/.test(name))
}

async function trashDirs(root: string): Promise<string[]> {
  return (await fs.readdir(root)).filter((name) => name.startsWith('.trash-'))
}

async function readBranchJson(branchRoot: string): Promise<{
  version: number
  branch: { access: unknown; createdBy: string }
}> {
  return JSON.parse(await fs.readFile(path.join(branchRoot, '.canopy-meta', 'branch.json'), 'utf8'))
}

describe('W1: the incident residue', () => {
  it('quarantines a killed clone with a stale config.lock and provisions the branch', async () => {
    const finalPath = await makeIncidentResidue('feat', 10 * 60_000)

    const context = await create('feat')

    expect(context.branch.name).toBe('feat')
    await expect(fs.stat(path.join(finalPath, '.git', 'index'))).resolves.toBeTruthy()
    expect(await listLocks(path.join(finalPath, '.git'))).toEqual([])
    expect((await readBranchJson(finalPath)).version).toBe(1)
    const trash = await trashDirs(baseRoot)
    expect(trash).toHaveLength(1)
    await expect(
      fs.stat(path.join(baseRoot, trash[0], '.git', 'config.lock')),
    ).resolves.toBeTruthy()
    const listed = await new BranchRegistry(baseRoot).list()
    expect(listed.map((entry) => entry.branch.name)).toEqual(['feat'])
    expect(consoleSpy).toHaveWarned(
      /Quarantined unfinished branch directory 'feat' as \.trash-feat-[0-9a-f]{10}-[0-9a-f]{6}-\d{8}T\d{6}Z \(git=true config\.lock=true index=false quiet=\d+s\)/,
    )
  })
})

describe('W2: a dead holder of the provisioning lock', () => {
  it('answers busy within 10 s instead of waiting the lock out, then succeeds once it is stale', async () => {
    const finalPath = await makeIncidentResidue('feat', 30_000)
    const marker = path.join(baseRoot, '.feat.init.lock')
    await fs.mkdir(marker)
    await backdate(marker, 30_000)

    const startedAt = Date.now()
    await expect(create('feat')).rejects.toMatchObject({ name: 'BranchProvisioningBusyError' })
    expect(Date.now() - startedAt).toBeLessThan(10_000)

    await backdate(marker, 120_000)
    await backdate(path.join(finalPath, '.git'), 120_000)
    await backdate(finalPath, 120_000)
    const context = await create('feat')
    expect(context.branch.name).toBe('feat')
  }, 15_000)
})

describe('publishing behind a live holder of the lock', () => {
  it('gives up after a bounded wait, answers busy, and removes its staging build', async () => {
    const release = await acquireProvisioningLock(baseRoot, '.feat.init.lock')
    try {
      const startedAt = Date.now()
      await expect(create('feat')).rejects.toMatchObject({ name: 'BranchProvisioningBusyError' })
      expect(Date.now() - startedAt).toBeLessThan(12_000)
    } finally {
      await release()
    }
    await expect(fs.stat(path.join(baseRoot, 'feat'))).rejects.toThrow(/ENOENT/)
    expect(await leftoverDirs(baseRoot)).toEqual([])
  }, 20_000)
})

describe('residue that must not be quarantined', () => {
  it('a young residue answers busy and stays exactly where it was', async () => {
    const finalPath = await makeIncidentResidue('feat', 10_000)
    const { ino } = await fs.lstat(finalPath)

    await expect(create('feat')).rejects.toMatchObject({ name: 'BranchProvisioningBusyError' })

    expect((await fs.lstat(finalPath)).ino).toBe(ino)
    expect(await trashDirs(baseRoot)).toEqual([])
  })

  it('a corrupt branch.json is never moved', async () => {
    const finalPath = await makeIncidentResidue('feat', 10 * 60_000)
    await fs.mkdir(path.join(finalPath, '.canopy-meta'))
    await fs.writeFile(path.join(finalPath, '.canopy-meta', 'branch.json'), '{ not json')
    await backdate(finalPath, 10 * 60_000)

    await expect(create('feat')).rejects.toMatchObject({ name: 'BranchMetadataCorruptError' })

    await expect(
      fs.readFile(path.join(finalPath, '.canopy-meta', 'branch.json'), 'utf8'),
    ).resolves.toBe('{ not json')
    expect(await trashDirs(baseRoot)).toEqual([])
  })

  it('an admin repair in progress (branch.json.corrupt-*) is left for the admin', async () => {
    const finalPath = await makeIncidentResidue('feat', 10 * 60_000)
    await fs.mkdir(path.join(finalPath, '.canopy-meta'))
    await fs.writeFile(
      path.join(finalPath, '.canopy-meta', 'branch.json.corrupt-20260101T000000Z'),
      '{ not json',
    )
    await backdate(path.join(finalPath, '.canopy-meta'), 10 * 60_000)
    await backdate(finalPath, 10 * 60_000)

    await expect(create('feat')).rejects.toMatchObject({ name: 'BranchProvisioningBusyError' })

    await expect(fs.stat(path.join(finalPath, '.git', 'config.lock'))).resolves.toBeTruthy()
    expect(await trashDirs(baseRoot)).toEqual([])
  })

  it('dev adopts a CLI-sync workspace (no remote, no branch.json) in place', async () => {
    const devBase = path.join(tmpDir, '.canopy-dev', 'content-branches')
    const finalPath = path.join(devBase, 'synced')
    await fs.mkdir(finalPath, { recursive: true })
    const wsGit = simpleGit({ baseDir: finalPath })
    await wsGit.init()
    await wsGit.addConfig('user.name', 'Dev')
    await wsGit.addConfig('user.email', 'dev@example.com')
    await wsGit.checkoutLocalBranch('synced')
    await fs.writeFile(path.join(finalPath, 'synced.md'), 'real work\n')
    await wsGit.add('.')
    await wsGit.commit('content pushed by sync')
    await backdate(finalPath, 10 * 60_000)

    const context = await new BranchWorkspaceManager(config('dev')).openOrCreateBranch({
      branchName: 'synced',
      mode: 'dev',
      basePathOverride: tmpDir,
      createdBy: 'user-1',
    })

    expect(context.branchRoot).toBe(finalPath)
    await expect(fs.readFile(path.join(finalPath, 'synced.md'), 'utf8')).resolves.toBe(
      'real work\n',
    )
    expect((await readBranchJson(finalPath)).branch.createdBy).toBe('user-1')
    expect(await trashDirs(devBase)).toEqual([])
  })
})

describe('the rename arbiter', () => {
  it('a branch another request already published is returned unchanged, never merged into', async () => {
    await create('feat', 'user-a', { allowedUsers: ['user-a'] })

    const second = await create('feat', 'user-b', { allowedUsers: ['user-b'] })

    expect(second.branch.createdBy).toBe('user-a')
    const onDisk = await readBranchJson(path.join(baseRoot, 'feat'))
    expect(onDisk.branch.access).toEqual({ allowedUsers: ['user-a'] })
    expect(onDisk.version).toBe(1)
  })
})

describe('W4: a delete killed partway through an in-place rm', () => {
  it('lets the same name be created again', async () => {
    const finalPath = path.join(baseRoot, 'feat')
    await create('feat')
    // rm -rf walks in readdir order: here it got through the metadata, HEAD
    // and the objects before it was killed; the config naming this
    // deployment's origin and the working tree survive.
    await fs.rm(path.join(finalPath, '.canopy-meta'), { recursive: true })
    await fs.rm(path.join(finalPath, '.git', 'HEAD'))
    await fs.rm(path.join(finalPath, '.git', 'objects'), { recursive: true })
    await backdate(path.join(finalPath, '.git'), 5 * 60_000)
    await backdate(finalPath, 5 * 60_000)

    const context = await create('feat', 'user-2')

    expect(context.branch.createdBy).toBe('user-2')
    await expect(fs.readFile(path.join(finalPath, 'content', 'hello.md'), 'utf8')).resolves.toBe(
      '# hi\n',
    )
  })
})

describe('W3: an interrupted first settings clone', () => {
  it('is re-provisioned instead of failing every request on its stale config.lock', async () => {
    const settingsRoot = path.join(workspaceRoot, 'settings')
    await fs.mkdir(workspaceRoot, { recursive: true })
    await simpleGit().raw(['clone', '-q', '-b', 'main', remoteUrl, settingsRoot])
    await fs.writeFile(path.join(settingsRoot, '.git', 'config.lock'), '')
    await backdate(path.join(settingsRoot, '.git'), 10 * 60_000)

    await new SettingsWorkspaceManager(config()).ensureGitWorkspace({
      settingsRoot,
      branchName: 'canopycms-settings-test',
      mode: 'prod',
      remoteUrl,
    })

    const head = await fs.readFile(path.join(settingsRoot, '.git', 'HEAD'), 'utf8')
    expect(head.trim()).toBe('ref: refs/heads/canopycms-settings-test')
    expect(consoleSpy).toHaveWarned(/Moved an unfinished settings workspace clone aside/)
    expect(await listLocks(path.join(settingsRoot, '.git'))).toEqual([])
    const trash = (await fs.readdir(workspaceRoot)).filter((name) =>
      name.startsWith('.trash-settings-'),
    )
    expect(trash).toHaveLength(1)
    await expect(
      fs.stat(path.join(workspaceRoot, trash[0], '.git', 'config.lock')),
    ).resolves.toBeTruthy()
  })
})

describe('the rename arbiter, racing', () => {
  it('a competitor publishing during this build wins; its metadata is untouched and nothing is left behind', async () => {
    const finalPath = path.join(baseRoot, 'feat')
    setProvisioningTestHooks({
      beforePublish: async ({ stagingPath }) => {
        // Another host's publish of the same name lands between our build and our rename.
        await fs.cp(stagingPath, finalPath, { recursive: true })
        const metaPath = path.join(finalPath, '.canopy-meta', 'branch.json')
        const competitor = JSON.parse(await fs.readFile(metaPath, 'utf8'))
        competitor.branch.createdBy = 'user-a'
        competitor.branch.access = { allowedUsers: ['user-a'] }
        await fs.writeFile(metaPath, JSON.stringify(competitor))
      },
    })

    const outcome = await new BranchWorkspaceManager(config()).provisionBranch({
      branchName: 'feat',
      mode: 'prod',
      createdBy: 'user-b',
      access: { allowedUsers: ['user-b'] },
    })

    expect(outcome.kind).toBe('exists')
    expect(outcome.context.branch.createdBy).toBe('user-a')
    expect((await readBranchJson(finalPath)).branch.access).toEqual({ allowedUsers: ['user-a'] })
    expect(await leftoverDirs(baseRoot)).toEqual([])
  })
})

describe('a publish rename that reports ENOENT', () => {
  it("counts as published when the branch.json at the name carries this build's writeId", async () => {
    // The rename landed but its reply was lost, and the retransmit found the source gone.
    setProvisioningTestHooks({
      beforePublish: async ({ stagingPath, finalPath }) => fs.rename(stagingPath, finalPath),
    })

    const outcome = await new BranchWorkspaceManager(config()).provisionBranch({
      branchName: 'feat',
      mode: 'prod',
      createdBy: 'user-b',
    })

    expect(outcome.kind).toBe('created')
    expect((await readBranchJson(path.join(baseRoot, 'feat'))).branch.createdBy).toBe('user-b')
  })

  it('is not published when the branch.json at the name carries another writeId', async () => {
    const finalPath = path.join(baseRoot, 'feat')
    setProvisioningTestHooks({
      beforePublish: async ({ stagingPath }) => {
        await fs.cp(stagingPath, finalPath, { recursive: true })
        const metaPath = path.join(finalPath, '.canopy-meta', 'branch.json')
        const other = JSON.parse(await fs.readFile(metaPath, 'utf8'))
        other.writeId = 'another-build'
        other.branch.createdBy = 'user-a'
        await fs.writeFile(metaPath, JSON.stringify(other))
        await fs.rm(stagingPath, { recursive: true })
      },
    })

    await expect(
      new BranchWorkspaceManager(config()).provisionBranch({
        branchName: 'feat',
        mode: 'prod',
        createdBy: 'user-b',
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readBranchJson(finalPath)).branch.createdBy).toBe('user-a')
  })
})

describe('quarantine verifies what it moved', () => {
  it('rolls a live branch straight back when a stale look reported residue at its name', async () => {
    await create('feat', 'user-a')
    const finalPath = path.join(baseRoot, 'feat')
    const metaPath = path.join(finalPath, '.canopy-meta', 'branch.json')
    const { ino } = await fs.lstat(finalPath)
    // Hidden from the lock-free checks, back by the time publish looks; only that look is stale.
    const original = await fs.readFile(metaPath, 'utf8')
    await fs.rm(metaPath)
    for (const dir of ['.git', '.canopy-meta', '']) {
      await backdate(path.join(finalPath, dir), 10 * 60_000)
    }
    setProvisioningTestHooks({
      beforePublish: async () => fs.writeFile(metaPath, original),
      inspectBlocked: async () => 'residue',
    })

    const outcome = await new BranchWorkspaceManager(config()).provisionBranch({
      branchName: 'feat',
      mode: 'prod',
      createdBy: 'user-b',
    })

    expect(outcome.kind).toBe('exists')
    expect((await fs.lstat(finalPath)).ino).toBe(ino)
    expect((await readBranchJson(finalPath)).branch.createdBy).toBe('user-a')
    expect(await leftoverDirs(baseRoot)).toEqual([])
  })

  it('rolls back when the inode found at the new name is not the one seen at the old name', async () => {
    const finalPath = await makeIncidentResidue('feat', 10 * 60_000)
    const realLstat = fs.lstat
    const lstat = vi.spyOn(fs, 'lstat')
    // A stale dentry: the first look at the name reports an inode the server has since replaced.
    lstat.mockImplementationOnce(
      async (target) => ({ ...(await realLstat(target)), ino: 1 }) as never,
    )

    const result = await quarantineResidueAt(baseRoot, 'feat', {
      minQuietMs: 60_000,
      expectedRemoteUrl: remoteUrl,
    })

    expect(result).toEqual({ kind: 'kept', reason: 'replaced' })
    await expect(fs.stat(path.join(finalPath, '.git', 'config.lock'))).resolves.toBeTruthy()
    expect(await trashDirs(baseRoot)).toEqual([])
  })

  it('moves the directory back to its name when judging it throws', async () => {
    const finalPath = await makeIncidentResidue('feat', 10 * 60_000)
    const { ino } = await fs.lstat(finalPath)
    // Through lstatSync: `fs.lstat` may already be a spy left by an earlier test.
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (target) => {
      if (path.basename(String(target)).startsWith('.repair-')) {
        throw Object.assign(new Error('EIO: i/o error, lstat'), { code: 'EIO' })
      }
      return lstatSync(target)
    })

    try {
      await expect(
        quarantineResidueAt(baseRoot, 'feat', { minQuietMs: 60_000, expectedRemoteUrl: remoteUrl }),
      ).rejects.toThrow('EIO')
    } finally {
      lstat.mockRestore()
    }

    expect((await fs.lstat(finalPath)).ino).toBe(ino)
    await expect(fs.stat(path.join(finalPath, '.git', 'config.lock'))).resolves.toBeTruthy()
    expect(await leftoverDirs(baseRoot)).toEqual([])
  })

  it.each([
    ['too young', 'too-young'],
    ['a corrupt branch.json', 'corrupt'],
    ['an admin repair in progress', 'protected'],
    ['another remote', 'foreign'],
  ] as const)('moves back, untouched, a directory holding %s', async (_label, reason) => {
    const finalPath = await makeIncidentResidue('feat', reason === 'too-young' ? 10_000 : 600_000)
    if (reason === 'corrupt' || reason === 'protected') {
      const name = reason === 'corrupt' ? 'branch.json' : 'branch.json.corrupt-20260101T000000Z'
      await fs.mkdir(path.join(finalPath, '.canopy-meta'))
      await fs.writeFile(path.join(finalPath, '.canopy-meta', name), '{ not json')
      await backdate(path.join(finalPath, '.canopy-meta'), 600_000)
    }
    const { ino } = await fs.lstat(finalPath)

    const result = await quarantineResidueAt(baseRoot, 'feat', {
      minQuietMs: 60_000,
      expectedRemoteUrl: reason === 'foreign' ? path.join(tmpDir, 'other.git') : remoteUrl,
    })

    expect(result).toEqual({ kind: 'kept', reason })
    expect((await fs.lstat(finalPath)).ino).toBe(ino)
    expect(await leftoverDirs(baseRoot)).toEqual([])
  })

  it('classifies what may be quarantined, and nothing else', async () => {
    await expect(classifyFinalDir(path.join(baseRoot, 'none'), remoteUrl)).resolves.toEqual({
      kind: 'vacant',
    })
    await fs.mkdir(path.join(baseRoot, 'empty'), { recursive: true })
    await expect(classifyFinalDir(path.join(baseRoot, 'empty'), remoteUrl)).resolves.toMatchObject({
      kind: 'residue',
      signature: { hasGitDir: false },
    })
    const killed = await makeIncidentResidue('killed', 0)
    await expect(classifyFinalDir(killed, remoteUrl)).resolves.toEqual({
      kind: 'residue',
      signature: { hasGitDir: true, configLock: true, hasIndex: false },
    })
    // The same clone, but of another remote: not ours to remove.
    await expect(classifyFinalDir(killed, path.join(tmpDir, 'other.git'))).resolves.toEqual({
      kind: 'foreign',
    })
    await fs.rm(path.join(killed, '.git', 'config'))
    await expect(classifyFinalDir(killed, path.join(tmpDir, 'other.git'))).resolves.toMatchObject({
      kind: 'residue',
    })
  })
})

describe('W5: the worker repairs residue', () => {
  function syncWorker(): CmsWorker {
    const worker = new CmsWorker({
      workspacePath: workspaceRoot,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    useLocalGitHubGateway(worker, { remoteUrl: () => path.join(tmpDir, 'no-such-github.git') })
    ;(worker as unknown as { running: boolean }).running = true
    return worker
  }

  it('quarantines quiet residue first in the sync cycle, even when the GitHub fetch then fails', async () => {
    const finalPath = await makeIncidentResidue('feat', 20 * 60_000)

    await expect(syncWorker().syncGit()).rejects.toThrow()

    await expect(fs.lstat(finalPath)).rejects.toThrow(/ENOENT/)
    expect(await trashDirs(baseRoot)).toHaveLength(1)
    expect(consoleSpy).toHaveWarned(/Quarantined unfinished branch directory 'feat'/)
    expect((await create('feat')).branch.name).toBe('feat')
  })

  it('leaves residue quiet for under 15 minutes, and residue whose provisioning lock is held', async () => {
    const young = await makeIncidentResidue('young', 10 * 60_000)
    const locked = await makeIncidentResidue('locked', 20 * 60_000)
    const release = await tryAcquireProvisioningLock(baseRoot, branchProvisioningLockName('locked'))
    try {
      await repairBranchDirResidue({ contentBranchesPath: baseRoot, remoteGitPath: remoteUrl })
    } finally {
      await release()
    }

    await expect(fs.stat(path.join(young, '.git', 'config.lock'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(locked, '.git', 'config.lock'))).resolves.toBeTruthy()
    expect(await trashDirs(baseRoot)).toEqual([])
  })

  it('never touches a live branch or a repository this deployment did not create', async () => {
    await create('live')
    const foreign = path.join(baseRoot, 'foreign')
    await fs.mkdir(foreign)
    const git = await initTestRepo(foreign)
    await fs.writeFile(path.join(foreign, 'notes.md'), 'kept\n')
    await git.add('.')
    await git.commit('not ours')
    await backdate(path.join(foreign, '.git'), 20 * 60_000)
    await backdate(foreign, 20 * 60_000)

    await repairBranchDirResidue({ contentBranchesPath: baseRoot, remoteGitPath: remoteUrl })

    expect((await readBranchJson(path.join(baseRoot, 'live'))).version).toBe(1)
    await expect(fs.readFile(path.join(foreign, 'notes.md'), 'utf8')).resolves.toBe('kept\n')
    expect(await trashDirs(baseRoot)).toEqual([])
    expect(consoleSpy).toHaveWarned(/foreign holds a git repository this deployment did not create/)
  })
})

describe('leftover sweep', () => {
  const minutesAgo = (minutes: number) => formatDirStamp(new Date(Date.now() - minutes * 60_000))

  async function leftover(name: string): Promise<string> {
    const dirPath = path.join(baseRoot, name)
    await fs.mkdir(path.join(dirPath, '.git'), { recursive: true })
    return dirPath
  }

  it('removes .prov-* builds older than 20 minutes and .deleting-* older than 10, keeping younger ones', async () => {
    const short = shortDirName('feat')
    const oldBuild = await leftover(`.prov-${short}-aaaaaa-${minutesAgo(21)}`)
    const liveBuild = await leftover(`.prov-${short}-bbbbbb-${minutesAgo(14)}`)
    const oldDelete = await leftover(`.deleting-${short}-cccccc-${minutesAgo(11)}`)
    const recentDelete = await leftover(`.deleting-${short}-dddddd-${minutesAgo(2)}`)

    const actions = await sweepProvisioningLeftovers(baseRoot, workspaceRoot)

    expect(actions.map((a) => [a.name, a.action]).sort()).toEqual(
      [
        [path.basename(oldBuild), 'removed'],
        [path.basename(oldDelete), 'removed'],
      ].sort(),
    )
    await expect(fs.stat(oldBuild)).rejects.toThrow(/ENOENT/)
    await expect(fs.stat(oldDelete)).rejects.toThrow(/ENOENT/)
    await expect(fs.stat(liveBuild)).resolves.toBeTruthy()
    await expect(fs.stat(recentDelete)).resolves.toBeTruthy()
  })

  it('restores an old .repair-* holding branch.json to a free name, and trashes one without', async () => {
    await create('feat')
    const repaired = `.repair-${shortDirName('feat')}-eeeeee-${minutesAgo(25)}`
    await fs.rename(path.join(baseRoot, 'feat'), path.join(baseRoot, repaired))
    const stray = `.repair-${shortDirName('gone')}-ffffff-${minutesAgo(25)}`
    await leftover(stray)
    const fresh = `.repair-${shortDirName('busy')}-abcdef-${minutesAgo(1)}`
    await leftover(fresh)

    const actions = await sweepProvisioningLeftovers(baseRoot, workspaceRoot)

    expect(actions).toEqual(
      expect.arrayContaining([
        { name: repaired, action: 'restored', detail: 'feat' },
        { name: stray, action: 'trashed', detail: `.trash-${stray.slice('.repair-'.length)}` },
      ]),
    )
    expect((await readBranchJson(path.join(baseRoot, 'feat'))).version).toBe(1)
    await expect(fs.stat(path.join(baseRoot, fresh))).resolves.toBeTruthy()
  })

  it('removes old settings staging and expired settings trash beside the settings workspace', async () => {
    const oldStaging = path.join(workspaceRoot, `.prov-settings-aaaaaa-${minutesAgo(30)}`)
    const oldTrash = path.join(workspaceRoot, `.trash-settings-bbbbbb-${minutesAgo(31 * 24 * 60)}`)
    const keptTrash = path.join(workspaceRoot, `.trash-settings-cccccc-${minutesAgo(60)}`)
    for (const dir of [oldStaging, oldTrash, keptTrash]) await fs.mkdir(dir, { recursive: true })

    await sweepProvisioningLeftovers(baseRoot, workspaceRoot)

    await expect(fs.stat(oldStaging)).rejects.toThrow(/ENOENT/)
    await expect(fs.stat(oldTrash)).rejects.toThrow(/ENOENT/)
    await expect(fs.stat(keptTrash)).resolves.toBeTruthy()
  })
})

describe('settings: what is not an interrupted first clone', () => {
  it('keeps a workspace on another branch whose settings branch exists locally', async () => {
    const settingsRoot = path.join(workspaceRoot, 'settings')
    const options = {
      settingsRoot,
      branchName: 'canopycms-settings-test',
      mode: 'prod' as const,
      remoteUrl,
    }
    await new SettingsWorkspaceManager(config()).ensureGitWorkspace(options)
    await simpleGit({ baseDir: settingsRoot }).raw(['commit', '--allow-empty', '-m', 'unpushed'])
    await simpleGit({ baseDir: settingsRoot }).checkout('main')

    vi.resetModules()
    const fresh = await import('./settings-workspace')
    ;(await import('./utils/provision-log')).setProvisionLogSink(() => {})
    await new fresh.SettingsWorkspaceManager(config()).ensureGitWorkspace(options)

    const log = await simpleGit({ baseDir: settingsRoot }).raw([
      'log',
      '--format=%s',
      'refs/heads/canopycms-settings-test',
    ])
    expect(log.split('\n')[0]).toBe('unpushed')
    const trash = (await fs.readdir(workspaceRoot)).filter((name) => name.startsWith('.trash-'))
    expect(trash).toEqual([])
  })
})
