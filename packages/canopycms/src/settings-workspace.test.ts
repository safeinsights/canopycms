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
import { GitManager } from './git-manager'
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

    // Every lock now anchors proper-lockfile on its own MARKER path, so the
    // in-process registry key is the on-disk lock identity and two live locks
    // can no longer clobber each other's bookkeeping. This assertion is now
    // about WHERE the marker lives: not inside the settings root (git clone
    // refuses a non-empty destination) and not in the directory
    // `ensureLocalSimulatedRemote` puts `.remote-init.lock` in, which settings
    // init calls into while holding this lock.
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

describe('SettingsWorkspaceManager per-process ensure memo', () => {
  let tmpRoot: string | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = undefined
    }
  })

  async function ensuredWorkspace() {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-memo-'))
    const settingsRoot = path.join(tmpRoot, 'settings')
    const remoteUrl = await seedBareRemote(tmpRoot)
    const manager = new SettingsWorkspaceManager({
      ...baseConfig,
      defaultBaseBranch: 'main',
    } as CanopyConfig)
    const options = {
      settingsRoot,
      branchName: 'canopycms-settings-memo',
      mode: 'dev' as const,
      remoteUrl,
    }
    await manager.ensureGitWorkspace(options)
    return { manager, options, settingsRoot }
  }

  it('skips the guard and initializeWorkspace once this process has ensured the workspace', async () => {
    const { manager, options } = await ensuredWorkspace()
    const repoExists = vi.spyOn(GitManager, 'repoExistsAt')
    const init = vi.spyOn(GitManager, 'initializeWorkspace')

    await manager.ensureGitWorkspace(options)
    await new SettingsWorkspaceManager(baseConfig as CanopyConfig).ensureGitWorkspace(options)

    expect(repoExists).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
  }, 60_000)

  it('re-provisions a workspace that was moved aside', async () => {
    const { manager, options, settingsRoot } = await ensuredWorkspace()
    await fs.rename(settingsRoot, `${settingsRoot}.moved`)
    const init = vi.spyOn(GitManager, 'initializeWorkspace')

    await manager.ensureGitWorkspace(options)

    expect(init).toHaveBeenCalledOnce()
    const status = await simpleGit({ baseDir: settingsRoot }).status()
    expect(status.current).toBe('canopycms-settings-memo')
  }, 60_000)

  it('re-provisions when the workspace is found on another branch (re-cloned, or mid-clone)', async () => {
    const { manager, options, settingsRoot } = await ensuredWorkspace()
    await simpleGit({ baseDir: settingsRoot }).checkout('main')
    const init = vi.spyOn(GitManager, 'initializeWorkspace')

    await manager.ensureGitWorkspace(options)

    expect(init).toHaveBeenCalledOnce()
    const status = await simpleGit({ baseDir: settingsRoot }).status()
    expect(status.current).toBe('canopycms-settings-memo')
  }, 60_000)

  it('never records a failure: the next call retries, succeeds, and is then remembered', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-memo-'))
    const settingsRoot = path.join(tmpRoot, 'settings')
    const manager = new SettingsWorkspaceManager({
      ...baseConfig,
      defaultBaseBranch: 'main',
    } as CanopyConfig)
    const options = {
      settingsRoot,
      branchName: 'canopycms-settings-memo',
      mode: 'dev' as const,
      // The remote is not there yet, as when the worker has not created it.
      remoteUrl: path.join(tmpRoot, 'remote.git'),
    }

    await expect(manager.ensureGitWorkspace(options)).rejects.toThrow(/Failed to clone/)

    await seedBareRemote(tmpRoot)
    const init = vi.spyOn(GitManager, 'initializeWorkspace')
    await manager.ensureGitWorkspace(options)
    await manager.ensureGitWorkspace(options)

    expect(init).toHaveBeenCalledOnce()
  }, 60_000)

  it('runs concurrent first calls through one provisioning pass', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-memo-'))
    const remoteUrl = await seedBareRemote(tmpRoot)
    const init = vi.spyOn(GitManager, 'initializeWorkspace')
    const manager = new SettingsWorkspaceManager({
      ...baseConfig,
      defaultBaseBranch: 'main',
    } as CanopyConfig)
    const options = {
      settingsRoot: path.join(tmpRoot, 'settings'),
      branchName: 'canopycms-settings-memo',
      mode: 'dev' as const,
      remoteUrl,
    }

    await Promise.all([1, 2, 3].map(() => manager.ensureGitWorkspace(options)))

    expect(init).toHaveBeenCalledOnce()
  }, 60_000)

  it('shows a group change made through one process on another process’s next request', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-memo-'))
    const workspaceRoot = path.join(tmpRoot, 'workspace')
    await fs.mkdir(workspaceRoot)
    // Prod auto-detects {workspaceRoot}/remote.git, as on EFS.
    await fs.rename(await seedBareRemote(tmpRoot), path.join(workspaceRoot, 'remote.git'))
    const originalRoot = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot
    try {
      // Two module graphs stand in for two Lambda containers: each has its own memo.
      const loadProcess = async () => {
        vi.resetModules()
        return {
          services: await import('./services'),
          resolveUser: await import('./resolve-canopy-user'),
          groups: await import('./authorization/groups/loader'),
          git: await import('./git-manager'),
        }
      }
      const a = await loadProcess()
      const b = await loadProcess()
      const config = {
        ...baseConfig,
        mode: 'prod',
        defaultBaseBranch: 'main',
        deploymentName: 'memo',
      } as CanopyConfig
      const servicesA = await a.services.createCanopyServices(config)
      const servicesB = await b.services.createCanopyServices(config)
      const resolveOnB = () =>
        b.resolveUser.resolveCanopyUser(
          { success: true, user: { userId: 'user-b', externalGroups: [] } },
          {
            getSettingsBranchRoot: servicesB.getSettingsBranchRoot,
            mode: 'prod',
            bootstrapAdminIds: new Set(['admin-a']),
          },
        )

      expect((await resolveOnB()).groups).not.toContain('Editors')
      const rootA = await servicesA.getSettingsBranchRoot()
      const initOnB = vi.spyOn(b.git.GitManager, 'initializeWorkspace')

      await a.groups.mutateGroupsFile(
        rootA,
        'prod',
        (_current, version) => ({
          version,
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin-a',
          groups: [{ id: 'Editors', name: 'Editors', members: ['user-b'] }],
        }),
        { settleMs: 0 },
      )

      expect((await resolveOnB()).groups).toContain('Editors')
      expect(initOnB).not.toHaveBeenCalled()
    } finally {
      if (originalRoot === undefined) delete process.env.CANOPYCMS_WORKSPACE_ROOT
      else process.env.CANOPYCMS_WORKSPACE_ROOT = originalRoot
      vi.resetModules()
    }
  }, 60_000)

  it('still runs the rename guard for a different settings-branch name on the same root', async () => {
    const { manager, options, settingsRoot } = await ensuredWorkspace()
    await fs.writeFile(path.join(settingsRoot, 'permissions.json'), '{"keep":true}')

    await expect(
      manager.ensureGitWorkspace({ ...options, branchName: 'canopycms-settings-renamed' }),
    ).rejects.toThrow(/refusing to initialize settings workspace/)
    const status = await simpleGit({ baseDir: settingsRoot }).status()
    expect(status.current).toBe('canopycms-settings-memo')
  }, 60_000)
})

describe('SettingsWorkspaceManager provisioning from the remote settings branch', () => {
  const BRANCH = 'canopycms-settings-reprovision'
  const GROUPS = JSON.stringify({ version: 1, groups: [{ id: 'Insiders', members: ['u1'] }] })
  let tmpRoot: string

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  async function setup() {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-reprovision-'))
    const remoteUrl = await seedBareRemote(tmpRoot)
    const settingsRoot = path.join(tmpRoot, 'settings')
    const options = { settingsRoot, branchName: BRANCH, mode: 'dev' as const, remoteUrl }
    // Fresh module graphs stand in for cold starts: each has its own ensure memo.
    const coldStart = async () => {
      vi.resetModules()
      const mod = await import('./settings-workspace')
      return new mod.SettingsWorkspaceManager({
        ...baseConfig,
        defaultBaseBranch: 'main',
      } as CanopyConfig)
    }
    return { remoteUrl, settingsRoot, options, coldStart }
  }

  /** Commit groups.json on the settings branch and push it, as a settings save does. */
  async function saveGroups(settingsRoot: string): Promise<void> {
    const git = simpleGit({ baseDir: settingsRoot })
    await fs.writeFile(path.join(settingsRoot, 'groups.json'), GROUPS)
    await git.add('groups.json')
    await git.commit('save groups')
    await git.push('origin', BRANCH)
  }

  async function log(settingsRoot: string): Promise<string[]> {
    const out = await simpleGit({ baseDir: settingsRoot }).raw(['log', '--format=%s', BRANCH])
    return out.trim().split('\n')
  }

  it('checks out the remote settings branch, so settings survive and the next save pulls and pushes', async () => {
    const { settingsRoot, options, coldStart } = await setup()
    await (await coldStart()).ensureGitWorkspace(options)
    await saveGroups(settingsRoot)
    await fs.rename(settingsRoot, `${settingsRoot}.aside`)

    await (await coldStart()).ensureGitWorkspace(options)

    expect(await fs.readFile(path.join(settingsRoot, 'groups.json'), 'utf-8')).toBe(GROUPS)
    expect((await simpleGit({ baseDir: settingsRoot }).status()).current).toBe(BRANCH)
    expect(await log(settingsRoot)).toEqual(['save groups', 'Initialize settings branch'])

    const manager = new GitManager({ repoPath: settingsRoot, skipIndexMarker: true })
    await manager.pullCurrentBranch()
    await fs.writeFile(path.join(settingsRoot, 'permissions.json'), '{}')
    await manager.add('permissions.json')
    await manager.commit('save permissions')
    await manager.push()
    expect(await log(settingsRoot)).toHaveLength(3)
  }, 60_000)

  it('creates an empty orphan when the remote has no settings branch', async () => {
    const { settingsRoot, options, coldStart } = await setup()

    await (await coldStart()).ensureGitWorkspace(options)

    expect((await simpleGit({ baseDir: settingsRoot }).status()).current).toBe(BRANCH)
    expect(await log(settingsRoot)).toEqual(['Initialize settings branch'])
    expect(await fs.readdir(settingsRoot)).toEqual(['.git'])
  }, 60_000)

  it('fails closed, creating no orphan, when it cannot read the remote', async () => {
    const { remoteUrl, settingsRoot, options, coldStart } = await setup()
    // A clone interrupted before its settings branch existed, whose remote is now unreadable.
    await simpleGit().clone(remoteUrl, settingsRoot, ['--branch', 'main', '--single-branch'])
    await fs.rename(remoteUrl, `${remoteUrl}.gone`)

    await expect((await coldStart()).ensureGitWorkspace(options)).rejects.toThrow(
      /could not read settings branch/,
    )

    const git = simpleGit({ baseDir: settingsRoot })
    expect((await git.status()).current).toBe('main')
    expect((await git.branchLocal()).all).not.toContain(BRANCH)
  }, 60_000)

  it('repairs a workspace stuck on an empty orphan while the remote holds the settings branch', async () => {
    const { settingsRoot, options, coldStart } = await setup()
    const stuckRoot = path.join(tmpRoot, 'stuck')
    // Both provision before either saves; the first save then leaves the other
    // holding only an unrelated "Initialize settings branch" commit.
    await GitManager.initializeWorkspace({
      ...options,
      workspacePath: stuckRoot,
      baseBranch: 'main',
      branchType: 'orphan',
      gitBotAuthorName: 'Other Bot',
      gitBotAuthorEmail: 'other@canopycms.test',
    })
    await (await coldStart()).ensureGitWorkspace(options)
    await saveGroups(settingsRoot)

    await (await coldStart()).ensureGitWorkspace({ ...options, settingsRoot: stuckRoot })

    expect(await fs.readFile(path.join(stuckRoot, 'groups.json'), 'utf-8')).toBe(GROUPS)
    expect(await log(stuckRoot)).toEqual(['save groups', 'Initialize settings branch'])
    await new GitManager({ repoPath: stuckRoot, skipIndexMarker: true }).pullCurrentBranch()
  }, 60_000)

  it('refuses to repair a stuck workspace holding uncommitted settings, and leaves it untouched', async () => {
    const { settingsRoot, options, coldStart } = await setup()
    const stuckRoot = path.join(tmpRoot, 'stuck')
    await GitManager.initializeWorkspace({
      ...options,
      workspacePath: stuckRoot,
      baseBranch: 'main',
      branchType: 'orphan',
      gitBotAuthorName: 'Other Bot',
      gitBotAuthorEmail: 'other@canopycms.test',
    })
    await (await coldStart()).ensureGitWorkspace(options)
    await saveGroups(settingsRoot)
    await fs.writeFile(path.join(stuckRoot, 'permissions.json'), '{"unsaved":true}')

    await expect(
      (await coldStart()).ensureGitWorkspace({ ...options, settingsRoot: stuckRoot }),
    ).rejects.toThrow(/permissions\.json/)

    expect(await fs.readFile(path.join(stuckRoot, 'permissions.json'), 'utf-8')).toBe(
      '{"unsaved":true}',
    )
    expect(await log(stuckRoot)).toEqual(['Initialize settings branch'])
  }, 60_000)

  it('refuses to repair a stuck workspace holding a commit of its own, and keeps that commit', async () => {
    const { settingsRoot, options, coldStart } = await setup()
    const stuckRoot = path.join(tmpRoot, 'stuck')
    await GitManager.initializeWorkspace({
      ...options,
      workspacePath: stuckRoot,
      baseBranch: 'main',
      branchType: 'orphan',
      gitBotAuthorName: 'Other Bot',
      gitBotAuthorEmail: 'other@canopycms.test',
    })
    await (await coldStart()).ensureGitWorkspace(options)
    await saveGroups(settingsRoot)
    const stuck = simpleGit({ baseDir: stuckRoot })
    await fs.writeFile(path.join(stuckRoot, 'permissions.json'), '{"admin":"after the wipe"}')
    await stuck.add('permissions.json')
    await stuck.commit('save permissions after the wipe')

    await expect(
      (await coldStart()).ensureGitWorkspace({ ...options, settingsRoot: stuckRoot }),
    ).rejects.toThrow(/shares no history.*commits beyond its empty initial commit/)

    expect(await log(stuckRoot)).toEqual([
      'save permissions after the wipe',
      'Initialize settings branch',
    ])
  }, 60_000)

  /**
   * Push content history under the settings name, as a submit of a content workspace would.
   * `pruned` leaves only a settings file in its tree, so only its history gives it away.
   */
  async function pushContentHistoryAsSettings(
    remoteUrl: string,
    { pruned = false } = {},
  ): Promise<void> {
    const content = path.join(tmpRoot, 'content-clone')
    await simpleGit().clone(remoteUrl, content, ['--branch', 'main'])
    const git = await initTestRepo(content)
    await git.checkoutLocalBranch(BRANCH)
    if (pruned) {
      await git.rm('readme.md')
      await fs.writeFile(path.join(content, 'groups.json'), '{}')
      await git.add('groups.json')
    } else {
      await fs.writeFile(path.join(content, 'readme.md'), '# edited as content')
      await git.add('readme.md')
    }
    await git.commit(`Submit ${BRANCH}`)
    await git.push('origin', BRANCH)
  }

  /** A cold start whose base branch is `base` rather than `main`. */
  async function coldStartOnBase(base: string) {
    vi.resetModules()
    const mod = await import('./settings-workspace')
    return new mod.SettingsWorkspaceManager({
      ...baseConfig,
      defaultBaseBranch: base,
    } as CanopyConfig)
  }

  it('refuses to check out a remote settings branch that carries content history', async () => {
    const { remoteUrl, settingsRoot, options, coldStart } = await setup()
    await pushContentHistoryAsSettings(remoteUrl)

    await expect((await coldStart()).ensureGitWorkspace(options)).rejects.toThrow(
      /holds content, not settings \(it holds readme\.md\)/,
    )

    const git = simpleGit({ baseDir: settingsRoot })
    expect((await git.status()).current).toBe('main')
    expect((await git.branchLocal()).all).not.toContain(BRANCH)
  }, 60_000)

  it('refuses to repair an empty orphan onto a remote settings branch that carries content history', async () => {
    const { remoteUrl, settingsRoot, options, coldStart } = await setup()
    // Provisioned, never saved: the workspace sits on its empty initial commit.
    await (await coldStart()).ensureGitWorkspace(options)
    await pushContentHistoryAsSettings(remoteUrl)

    await expect((await coldStart()).ensureGitWorkspace(options)).rejects.toThrow(
      /holds content, not settings/,
    )

    expect(await log(settingsRoot)).toEqual(['Initialize settings branch'])
    expect(await fs.readdir(settingsRoot)).toEqual(['.git'])
  }, 60_000)

  it('refuses content history even when the current base has a root of its own', async () => {
    const { remoteUrl, settingsRoot, options } = await setup()
    // A base with its own parentless root, as dev seeds a sourceRoot snapshot.
    const snapshot = path.join(tmpRoot, 'snapshot')
    await fs.mkdir(snapshot)
    const snapGit = await initTestRepo(snapshot)
    await snapGit.raw(['symbolic-ref', 'HEAD', 'refs/heads/trunk'])
    await fs.writeFile(path.join(snapshot, 'readme.md'), '# snapshot')
    await snapGit.add('readme.md')
    await snapGit.commit('snapshot')
    await snapGit.push(remoteUrl, 'trunk')
    await pushContentHistoryAsSettings(remoteUrl)

    await expect((await coldStartOnBase('trunk')).ensureGitWorkspace(options)).rejects.toThrow(
      /holds content, not settings \(it holds readme\.md\)/,
    )
    expect((await simpleGit({ baseDir: settingsRoot }).branchLocal()).all).not.toContain(BRANCH)
  }, 60_000)

  it('refuses a pruned content branch by its history, reading a base the clone lacks from the remote', async () => {
    const { remoteUrl, options, coldStart } = await setup()
    const stuckRoot = path.join(tmpRoot, 'stuck')
    await (await coldStart()).ensureGitWorkspace({ ...options, settingsRoot: stuckRoot })
    await pushContentHistoryAsSettings(remoteUrl, { pruned: true })
    await simpleGit({ baseDir: path.join(tmpRoot, 'seed') }).push(
      remoteUrl,
      'main:refs/heads/trunk',
    )

    await expect(
      (await coldStartOnBase('trunk')).ensureGitWorkspace({ ...options, settingsRoot: stuckRoot }),
    ).rejects.toThrow(
      /holds content, not settings \(it shares history with the base branch 'trunk'\)/,
    )
    expect(await log(stuckRoot)).toEqual(['Initialize settings branch'])
  }, 60_000)

  it('reads the base from the remote when the clone was made at an earlier base, and still repairs', async () => {
    const { remoteUrl, settingsRoot, options, coldStart } = await setup()
    const stuckRoot = path.join(tmpRoot, 'stuck')
    await GitManager.initializeWorkspace({
      ...options,
      workspacePath: stuckRoot,
      baseBranch: 'main',
      branchType: 'orphan',
      gitBotAuthorName: 'Other Bot',
      gitBotAuthorEmail: 'other@canopycms.test',
    })
    await (await coldStart()).ensureGitWorkspace(options)
    await saveGroups(settingsRoot)
    // The deployment's base changes after the stuck clone was made at `main`.
    await simpleGit({ baseDir: path.join(tmpRoot, 'seed') }).push(
      remoteUrl,
      'main:refs/heads/trunk',
    )

    await (
      await coldStartOnBase('trunk')
    ).ensureGitWorkspace({ ...options, settingsRoot: stuckRoot })

    expect(await fs.readFile(path.join(stuckRoot, 'groups.json'), 'utf-8')).toBe(GROUPS)
  }, 60_000)

  it('leaves a branch related to the remote one for the next settings pull', async () => {
    const { remoteUrl, settingsRoot, options, coldStart } = await setup()
    await (await coldStart()).ensureGitWorkspace(options)
    await saveGroups(settingsRoot)
    // The remote moves ahead, as when the worker fast-forwards it from GitHub.
    const other = path.join(tmpRoot, 'other')
    await simpleGit().clone(remoteUrl, other, ['--branch', BRANCH])
    await initTestRepo(other)
    await fs.writeFile(path.join(other, 'permissions.json'), '{}')
    await simpleGit({ baseDir: other }).add('permissions.json')
    await simpleGit({ baseDir: other }).commit('remote save')
    await simpleGit({ baseDir: other }).push('origin', BRANCH)

    await (await coldStart()).ensureGitWorkspace(options)

    expect(await log(settingsRoot)).toEqual(['save groups', 'Initialize settings branch'])
  }, 60_000)

  it('serves a populated settings branch while the remote is unreadable', async () => {
    const { remoteUrl, settingsRoot, options, coldStart } = await setup()
    await (await coldStart()).ensureGitWorkspace(options)
    await saveGroups(settingsRoot)
    await fs.rename(remoteUrl, `${remoteUrl}.gone`)

    await (await coldStart()).ensureGitWorkspace(options)

    expect(await fs.readFile(path.join(settingsRoot, 'groups.json'), 'utf-8')).toBe(GROUPS)
  }, 60_000)

  it('answers 503-shaped RemoteNotReadyError in prod while remote.git is missing', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-reprovision-'))
    const workspaceRoot = path.join(tmpRoot, 'workspace')
    const remotePath = path.join(workspaceRoot, 'remote.git')
    await fs.mkdir(workspaceRoot)
    await fs.rename(await seedBareRemote(tmpRoot), remotePath)
    const originalRoot = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot
    try {
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()
      const settingsRoot = path.join(workspaceRoot, 'settings')
      const options = { settingsRoot, branchName: BRANCH, mode: 'prod' as const }
      const coldStart = async () => {
        vi.resetModules()
        const mod = await import('./settings-workspace')
        const git = await import('./git-manager')
        return { manager: new mod.SettingsWorkspaceManager(baseConfig as CanopyConfig), git }
      }
      await (await coldStart()).manager.ensureGitWorkspace(options)
      // The operator deletes remote.git so the worker re-clones it from GitHub.
      await fs.rename(remotePath, `${remotePath}.old`)

      const { manager, git } = await coldStart()
      const err = await manager.ensureGitWorkspace(options).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(git.RemoteNotReadyError)
      expect(await log(settingsRoot)).toEqual(['Initialize settings branch'])
    } finally {
      if (originalRoot === undefined) delete process.env.CANOPYCMS_WORKSPACE_ROOT
      else process.env.CANOPYCMS_WORKSPACE_ROOT = originalRoot
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()
      vi.resetModules()
    }
  }, 60_000)
})
