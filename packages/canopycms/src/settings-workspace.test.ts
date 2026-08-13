/**
 * Tests for SettingsWorkspaceManager's rename guard.
 *
 * Changing the resolved settings branch name (deploymentName / settingsBranch /
 * CANOPYCMS_DEPLOYMENT_NAME) on a deployment that already has a populated
 * settings workspace must be refused loudly rather than silently wiping
 * permissions.json/groups.json — see ensureGitWorkspace's guard comment for
 * the full trace (createOrphanSettingsBranch on a name that isn't the current
 * branch runs `checkout --orphan` + `rm -rf .`).
 *
 * Uses real git in a temp dir (initTestRepo), matching the harness pattern in
 * cms-worker-rebase.test.ts / __integration__ rather than mocking simple-git.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { initTestRepo } from './test-utils'
import { SettingsWorkspaceManager, settingsInitLockTarget } from './settings-workspace'
import { acquireProvisioningLock } from './utils/provisioning-lock'
import type { CanopyConfig } from './config'

const baseConfig: Partial<CanopyConfig> = {
  mode: 'dev',
  gitBotAuthorName: 'Test Bot',
  gitBotAuthorEmail: 'test@canopycms.test',
}

/** Bare remote seeded with a `main` commit — what a settings workspace clones from. */
async function seedBareRemote(tmpRoot: string): Promise<string> {
  const barePath = path.join(tmpRoot, 'remote.git')
  const seedPath = path.join(tmpRoot, 'seed')
  await fs.mkdir(seedPath, { recursive: true })
  const seedGit = await initTestRepo(seedPath)
  await seedGit.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await fs.writeFile(path.join(seedPath, 'readme.md'), '# seed', 'utf8')
  await seedGit.add(['.'])
  await seedGit.commit('initial commit')
  await simpleGit().raw(['init', '--bare', barePath])
  await seedGit.addRemote('origin', barePath)
  await seedGit.push('origin', 'main')
  return barePath
}

describe('SettingsWorkspaceManager rename guard', () => {
  let tmpRoot: string | undefined

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = undefined
    }
  })

  it('refuses to re-point an existing settings workspace at a different branch, and leaves settings files intact on disk', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-guard-'))
    const settingsRoot = path.join(tmpRoot, 'settings')
    await fs.mkdir(settingsRoot, { recursive: true })

    // Simulate a settings workspace a PRIOR run already created and populated:
    // a real git repo, checked out on an orphan branch, with a committed
    // permissions.json standing in for real saved settings.
    const git = await initTestRepo(settingsRoot)
    await git.raw(['checkout', '--orphan', 'canopycms-settings-old'])
    await fs.writeFile(
      path.join(settingsRoot, 'permissions.json'),
      JSON.stringify({ acls: ['do-not-lose-me'] }),
    )
    await git.add(['permissions.json'])
    await git.commit('seed settings')

    const manager = new SettingsWorkspaceManager(baseConfig as CanopyConfig)

    // This deployment resolved a DIFFERENT settings branch (e.g. deploymentName
    // changed since the workspace was populated).
    await expect(
      manager.ensureGitWorkspace({
        settingsRoot,
        branchName: 'canopycms-settings-new',
        mode: 'dev',
      }),
    ).rejects.toThrow(/canopycms-settings-old/)

    await expect(
      manager.ensureGitWorkspace({
        settingsRoot,
        branchName: 'canopycms-settings-new',
        mode: 'dev',
      }),
    ).rejects.toThrow(/canopycms-settings-new/)

    // The guard must throw BEFORE any orphan checkout for the new branch runs —
    // permissions.json must still be present and byte-for-byte unchanged.
    const stillThere = await fs.readFile(path.join(settingsRoot, 'permissions.json'), 'utf-8')
    expect(JSON.parse(stillThere)).toEqual({ acls: ['do-not-lose-me'] })

    // And the workspace must still be checked out on the ORIGINAL branch — proof
    // that no `checkout --orphan canopycms-settings-new` ever ran.
    const status = await git.status()
    expect(status.current).toBe('canopycms-settings-old')
  })

  it('refuses immediately while another host holds the init lock (the guard is lock-free)', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-guard-'))
    const settingsRoot = path.join(tmpRoot, 'settings')
    await fs.mkdir(settingsRoot, { recursive: true })

    const git = await initTestRepo(settingsRoot)
    await git.raw(['checkout', '--orphan', 'canopycms-settings-old'])
    await fs.writeFile(
      path.join(settingsRoot, 'permissions.json'),
      JSON.stringify({ acls: ['do-not-lose-me'] }),
    )
    await git.add(['permissions.json'])
    await git.commit('seed settings')

    // Another host is mid-init and holds the real cross-process lock. A
    // misconfigured deployment (renamed settings branch) must refuse right
    // away rather than queue behind that holder for what can be minutes —
    // concurrent cold starts right after a deploy are exactly when a changed
    // deploymentName shows up.
    const release = await acquireProvisioningLock(settingsInitLockTarget(settingsRoot), 'lock')
    try {
      const manager = new SettingsWorkspaceManager(baseConfig as CanopyConfig)
      const startedAt = Date.now()
      await expect(
        manager.ensureGitWorkspace({
          settingsRoot,
          branchName: 'canopycms-settings-new',
          mode: 'dev',
        }),
      ).rejects.toThrow(/PERMANENTLY WIPES/)
      // proper-lockfile's shortest retry is 300ms and its budget is minutes, so
      // anything this fast proves the guard ran without waiting for the lock.
      expect(Date.now() - startedAt).toBeLessThan(2000)

      // Settings survived.
      const stillThere = await fs.readFile(path.join(settingsRoot, 'permissions.json'), 'utf-8')
      expect(JSON.parse(stillThere)).toEqual({ acls: ['do-not-lose-me'] })
    } finally {
      // The foreign holder's lock must still be ours to release — the refusing
      // process must never have taken it over or removed it.
      await release()
    }
  })

  it('proceeds (no throw) when the resolved branch name matches the workspace’s current branch', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-guard-'))
    const settingsRoot = path.join(tmpRoot, 'settings')
    const barePath = path.join(tmpRoot, 'remote.git')
    await fs.mkdir(settingsRoot, { recursive: true })

    // A real (empty) bare remote so GitManager.resolveRemoteUrl's explicit
    // remoteUrl path is used instead of dev mode's auto-init-local-remote path
    // (which would need a whole separate seeded source repo).
    const { simpleGit } = await import('simple-git')
    await simpleGit().raw(['init', '--bare', barePath])

    const git = await initTestRepo(settingsRoot)
    await git.raw(['checkout', '--orphan', 'canopycms-settings-prod'])
    await fs.writeFile(path.join(settingsRoot, 'permissions.json'), JSON.stringify({}))
    await git.add(['permissions.json'])
    await git.commit('seed settings')

    const manager = new SettingsWorkspaceManager(baseConfig as CanopyConfig)

    await expect(
      manager.ensureGitWorkspace({
        settingsRoot,
        branchName: 'canopycms-settings-prod',
        mode: 'dev',
        remoteUrl: barePath,
      }),
    ).resolves.toBeUndefined()

    const status = await git.status()
    expect(status.current).toBe('canopycms-settings-prod')
  })
})

describe('SettingsWorkspaceManager cross-process init lock', () => {
  let tmpRoot: string | undefined

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = undefined
    }
  })

  /**
   * Two independent module instances stand in for two OS processes: each gets
   * its own module-level in-memory lock AND its own proper-lockfile registry,
   * so the only thing that can serialize them is the on-disk lock — exactly the
   * situation of two Lambda containers cold-starting against one EFS volume.
   */
  async function loadTwoInstances(): Promise<
    [typeof import('./settings-workspace'), typeof import('./settings-workspace')]
  > {
    vi.resetModules()
    const a = await import('./settings-workspace')
    vi.resetModules()
    const b = await import('./settings-workspace')
    expect(a).not.toBe(b)
    return [a, b]
  }

  it('lets two concurrent cold starts initialize one empty settings root without colliding', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-race-'))
    const settingsRoot = path.join(tmpRoot, 'settings')
    const barePath = await seedBareRemote(tmpRoot)

    const [modA, modB] = await loadTwoInstances()
    const config = { ...baseConfig, defaultBaseBranch: 'main' } as CanopyConfig
    const options = {
      settingsRoot,
      branchName: 'canopycms-settings-prod',
      mode: 'dev' as const,
      remoteUrl: barePath,
    }

    const results = await Promise.allSettled([
      new modA.SettingsWorkspaceManager(config).ensureGitWorkspace(options),
      new modB.SettingsWorkspaceManager(config).ensureGitWorkspace(options),
    ])

    const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []))
    expect(failures).toEqual([])

    // And the workspace both of them "initialized" is a single consistent one.
    const status = await simpleGit({ baseDir: settingsRoot }).status()
    expect(status.current).toBe('canopycms-settings-prod')
  }, 60_000)

  it('anchors on a target of its own, so proper-lockfile cannot alias it with the provisioning or content-write locks', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-lock-'))
    const settingsRoot = path.join(tmpRoot, 'settings')
    const target = settingsInitLockTarget(settingsRoot)

    // proper-lockfile keys its in-process registry (refresh timer + release fn)
    // by the TARGET path passed to lock(). The provisioning lock targets the
    // content-branches root and the bare remote's parent (both plain workspace
    // dirs); the content-write lock targets `<branchRoot>/.canopy-meta`. This
    // target must equal none of them, or two live locks in one process clobber
    // each other's bookkeeping.
    expect(target).not.toBe(path.dirname(settingsRoot)) // remote-init / provisioning target
    expect(target).not.toBe(settingsRoot)
    expect(target).not.toBe(path.join(settingsRoot, '.canopy-meta')) // content-write target
    expect(path.basename(target)).toMatch(/^\./)

    // Holding it must not pre-create the settings root: git clone refuses a
    // non-empty destination, and initializeWorkspace clones into it.
    const release = await acquireProvisioningLock(target, 'lock')
    try {
      await expect(fs.stat(settingsRoot)).rejects.toThrow()
    } finally {
      await release()
    }
  })

  it('makes a losing cold start wait for the holder instead of racing into init', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-wait-'))
    const settingsRoot = path.join(tmpRoot, 'settings')
    const barePath = await seedBareRemote(tmpRoot)

    // Stand in for the other host: hold the real on-disk lock, then release.
    const release = await acquireProvisioningLock(settingsInitLockTarget(settingsRoot), 'lock')

    const manager = new SettingsWorkspaceManager({
      ...baseConfig,
      defaultBaseBranch: 'main',
    } as CanopyConfig)
    const pending = manager.ensureGitWorkspace({
      settingsRoot,
      branchName: 'canopycms-settings-prod',
      mode: 'dev',
      remoteUrl: barePath,
    })

    // While the foreign lock is held, init must not have started.
    await new Promise((resolve) => setTimeout(resolve, 400))
    await expect(fs.stat(path.join(settingsRoot, '.git'))).rejects.toThrow()

    await release()
    await expect(pending).resolves.toBeUndefined()

    const status = await simpleGit({ baseDir: settingsRoot }).status()
    expect(status.current).toBe('canopycms-settings-prod')
  }, 60_000)
})
