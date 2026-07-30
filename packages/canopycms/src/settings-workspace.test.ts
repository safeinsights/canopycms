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
import { describe, it, expect, afterEach } from 'vitest'

import { initTestRepo } from './test-utils'
import { SettingsWorkspaceManager } from './settings-workspace'
import type { CanopyConfig } from './config'

const baseConfig: Partial<CanopyConfig> = {
  mode: 'dev',
  gitBotAuthorName: 'Test Bot',
  gitBotAuthorEmail: 'test@canopycms.test',
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
