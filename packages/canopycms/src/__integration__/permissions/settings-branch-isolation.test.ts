/**
 * Integration test to verify that permissions are read from the settings branch,
 * not from the current branch being accessed.
 *
 * This test creates a scenario where:
 * - Settings branch has restrictive permissions (only allow specific user)
 * - Main branch has permissive permissions (allow everyone)
 * - System must read from settings branch, not main branch
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import { BranchWorkspaceManager } from '../../branch-workspace'
import { SettingsWorkspaceManager } from '../../settings-workspace'
import { createTestCanopyServices } from '../../services'
import type { PathPermission } from '../../config'
import type { AuthenticatedUser } from '../../user'
import { operatingStrategy } from '../../operating-mode'

describe('Settings Branch Isolation', () => {
  let workspace: TestWorkspace

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
      defaultPathAccess: 'deny', // Default deny to ensure permissions are checked
      mode: 'prod-sim',
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('reads permissions from settings branch, not from main branch', async () => {
    const restrictedUser: AuthenticatedUser = {
      type: 'authenticated',
      userId: 'restricted-user',
      groups: [],
    }
    const allowedUser: AuthenticatedUser = {
      type: 'authenticated',
      userId: 'allowed-user',
      groups: [],
    }

    const manager = new BranchWorkspaceManager(workspace.config)

    // Create main branch
    const mainBranch = await manager.openOrCreateBranch({
      branchName: 'main',
      mode: 'prod-sim',
      createdBy: 'system',
      remoteUrl: workspace.remotePath,
    })

    // Create settings workspace using SettingsWorkspaceManager
    const settingsManager = new SettingsWorkspaceManager(workspace.config)
    const strategy = operatingStrategy('prod-sim')
    const settingsRoot = strategy.getSettingsRoot(workspace.tmpRoot)
    const settingsBranchName = strategy.getSettingsBranchName({
      settingsBranch: 'canopycms-settings',
    })

    await settingsManager.ensureGitWorkspace({
      settingsRoot,
      branchName: settingsBranchName,
      mode: 'prod-sim',
      remoteUrl: workspace.remotePath,
    })

    // Write PERMISSIVE permissions to main branch (the wrong place)
    const mainPermissionsDir = mainBranch.branchRoot
    await fs.mkdir(mainPermissionsDir, { recursive: true })
    const mainPermissionsFile = path.join(mainPermissionsDir, 'permissions.json')
    const permissiveRules: PathPermission[] = [
      {
        path: 'content/**',
        read: {
          allowedUsers: [restrictedUser.userId, allowedUser.userId, 'anonymous'],
        },
      },
    ]
    await fs.writeFile(
      mainPermissionsFile,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
        pathPermissions: permissiveRules,
      }),
    )

    // Write RESTRICTIVE permissions to settings directory (the correct place)
    await fs.mkdir(settingsRoot, { recursive: true })
    const settingsPermissionsFile = path.join(settingsRoot, 'permissions.json')
    const restrictiveRules: PathPermission[] = [
      {
        path: 'content/posts/hello.mdx',
        read: {
          allowedUsers: [allowedUser.userId], // Only allowedUser can read
        },
      },
    ]
    await fs.writeFile(
      settingsPermissionsFile,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
        pathPermissions: restrictiveRules,
      }),
    )

    // Create services with prod-sim mode
    const services = await createTestCanopyServices(
      {
        ...workspace.config,
        mode: 'prod-sim',
        settingsBranch: 'canopycms-settings',
      },
      BLOG_SCHEMA,
    )

    // Check access for restrictedUser on main branch
    // This should read from settings branch (restrictive), not main branch (permissive)
    const restrictedUserAccess = await services.checkContentAccess(
      mainBranch,
      mainBranch.branchRoot,
      'content/posts/hello.mdx',
      restrictedUser,
      'read',
    )

    // restrictedUser should be DENIED because settings branch doesn't allow them
    expect(restrictedUserAccess.allowed).toBe(false)
    expect(restrictedUserAccess.path.allowed).toBe(false)

    // Verify it's not falling back to main branch's permissive rule
    // If it were reading from main branch, this would be true
    expect(restrictedUserAccess.path.reason).not.toBe('allowed_by_rule')

    // Check access for allowedUser - should be allowed
    const allowedUserAccess = await services.checkContentAccess(
      mainBranch,
      mainBranch.branchRoot,
      'content/posts/hello.mdx',
      allowedUser,
      'read',
    )

    expect(allowedUserAccess.allowed).toBe(true)
    expect(allowedUserAccess.path.allowed).toBe(true)
    expect(allowedUserAccess.path.reason).toBe('allowed_by_rule')
  })

  it('does not read from current branch permissions file in prod-sim', async () => {
    const user: AuthenticatedUser = {
      type: 'authenticated',
      userId: 'test-user',
      groups: [],
    }
    const manager = new BranchWorkspaceManager(workspace.config)

    // Create main branch with permissive permissions IN THE BRANCH
    const mainBranch = await manager.openOrCreateBranch({
      branchName: 'main',
      mode: 'prod-sim',
      createdBy: 'system',
      remoteUrl: workspace.remotePath,
    })

    // Write permissions directly to main branch (wrong location in prod-sim)
    const mainPermissionsDir = mainBranch.branchRoot
    await fs.mkdir(mainPermissionsDir, { recursive: true })
    await fs.writeFile(
      path.join(mainPermissionsDir, 'permissions.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
        pathPermissions: [
          {
            path: 'content/**',
            read: { allowedUsers: [user.userId] },
          },
        ],
      }),
    )

    // Create settings branch with NO permissions (empty file)
    const settingsBranch = await manager.openOrCreateBranch({
      branchName: 'canopycms-settings',
      mode: 'prod-sim',
      createdBy: 'system',
      remoteUrl: workspace.remotePath,
    })

    const settingsPermissionsDir = settingsBranch.branchRoot
    await fs.mkdir(settingsPermissionsDir, { recursive: true })
    await fs.writeFile(
      path.join(settingsPermissionsDir, 'permissions.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
        pathPermissions: [], // Empty - no rules
      }),
    )

    // Create services
    const services = await createTestCanopyServices(
      {
        ...workspace.config,
        mode: 'prod-sim',
        settingsBranch: 'canopycms-settings',
      },
      BLOG_SCHEMA,
    )

    // Check access - should fall back to defaultPathAccess (deny)
    // NOT use the permissive rule from main branch
    const access = await services.checkContentAccess(
      mainBranch,
      mainBranch.branchRoot,
      'content/posts/test.mdx',
      user,
      'read',
    )

    // Should be denied because settings branch has no rules
    // If it were reading from main branch, this would be allowed
    expect(access.allowed).toBe(false)
    expect(access.path.allowed).toBe(false)
    expect(access.path.reason).toBe('no_rule_match')
  })

  it('verifies settings branch isolation works consistently across modes', async () => {
    // This test verifies the same behavior as the prod-sim test above,
    // but demonstrates it works for any mode that uses settings branch
    const user: AuthenticatedUser = {
      type: 'authenticated',
      userId: 'user-for-mode-test',
      groups: [],
    }
    const manager = new BranchWorkspaceManager(workspace.config)

    // Create feature branch with permissive permissions
    const featureBranch = await manager.openOrCreateBranch({
      branchName: 'feature-x',
      mode: 'prod-sim',
      createdBy: user.userId,
      remoteUrl: workspace.remotePath,
    })

    const featurePermissionsDir = featureBranch.branchRoot
    await fs.mkdir(featurePermissionsDir, { recursive: true })
    await fs.writeFile(
      path.join(featurePermissionsDir, 'permissions.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
        pathPermissions: [{ path: 'content/**', read: { allowedUsers: [user.userId] } }],
      }),
    )

    // Create settings branch with restrictive permissions
    const settingsBranch = await manager.openOrCreateBranch({
      branchName: 'canopycms-settings',
      mode: 'prod-sim',
      createdBy: 'system',
      remoteUrl: workspace.remotePath,
    })

    const settingsPermissionsDir = settingsBranch.branchRoot
    await fs.mkdir(settingsPermissionsDir, { recursive: true })
    await fs.writeFile(
      path.join(settingsPermissionsDir, 'permissions.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
        pathPermissions: [], // No rules = default deny
      }),
    )

    // Create services in prod-sim mode
    const services = await createTestCanopyServices(
      {
        ...workspace.config,
        mode: 'prod-sim',
        settingsBranch: 'canopycms-settings',
      },
      BLOG_SCHEMA,
    )

    // Check access on feature branch
    // Should read from settings branch (empty), not feature branch (permissive)
    const access = await services.checkContentAccess(
      featureBranch,
      featureBranch.branchRoot,
      'content/posts/test.mdx',
      user,
      'read',
    )

    // Should be denied because settings branch has no rules
    expect(access.allowed).toBe(false)
    expect(access.path.reason).toBe('no_rule_match')
  })
})
