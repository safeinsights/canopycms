/**
 * Integration tests for local-prod-sim mode initialization.
 * Tests that branch workspaces are created correctly with proper
 * handling of concurrent requests (no race conditions).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

import { BranchWorkspaceManager } from '../../branch-workspace'
import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { BLOG_SCHEMA } from '../fixtures/schemas'

describe('Local-Prod-Sim Initialization', () => {
  let workspace: TestWorkspace

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
      mode: 'local-prod-sim',
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('handles concurrent branch initialization without race conditions', async () => {
    const manager = new BranchWorkspaceManager(workspace.config)

    // Fire 5 concurrent requests to create the same branch workspace
    // This simulates multiple API requests hitting the server simultaneously
    const initPromises = Promise.all([
      manager.openOrCreateBranch({
        branchName: 'main',
        mode: 'local-prod-sim',
        createdBy: 'test-1',
      }),
      manager.openOrCreateBranch({
        branchName: 'main',
        mode: 'local-prod-sim',
        createdBy: 'test-2',
      }),
      manager.openOrCreateBranch({
        branchName: 'main',
        mode: 'local-prod-sim',
        createdBy: 'test-3',
      }),
      manager.openOrCreateBranch({
        branchName: 'main',
        mode: 'local-prod-sim',
        createdBy: 'test-4',
      }),
      manager.openOrCreateBranch({
        branchName: 'main',
        mode: 'local-prod-sim',
        createdBy: 'test-5',
      }),
    ])

    // All should succeed without errors
    const contexts = await initPromises
    expect(contexts).toHaveLength(5)

    // All should return valid contexts
    contexts.forEach((ctx) => {
      expect(ctx.branch.name).toBe('main')
      expect(ctx.branchRoot).toBeTruthy()
      expect(ctx.baseRoot).toBeTruthy()
    })

    // Verify only one workspace was created (no duplicates from race)
    const branchesDir = path.join(workspace.tmpRoot, '.canopycms', 'branches')
    const entries = await fs.readdir(branchesDir)

    // Should have main workspace + .canopycms metadata
    expect(entries).toContain('main')
    const mainDirs = entries.filter((e) => e === 'main')
    expect(mainDirs.length).toBe(1)
  })

  it('creates valid git workspace with correct remote', async () => {
    const manager = new BranchWorkspaceManager(workspace.config)

    // Trigger initialization
    const context = await manager.openOrCreateBranch({
      branchName: 'main',
      mode: 'local-prod-sim',
      createdBy: 'test',
    })

    const mainWorkspace = context.branchRoot

    // Verify it's a git repo
    const gitDir = path.join(mainWorkspace, '.git')
    const gitStat = await fs.stat(gitDir)
    expect(gitStat.isDirectory()).toBe(true)

    // Verify git remote is configured
    const { simpleGit } = await import('simple-git')
    const git = simpleGit({ baseDir: mainWorkspace })

    const remotes = await git.getRemotes(true)
    expect(remotes.length).toBeGreaterThan(0)
    expect(remotes[0].name).toBe('origin')

    // Verify on main branch
    const branch = await git.branchLocal()
    expect(branch.current).toBe('main')
  })

  it('workspace persists across multiple operations', async () => {
    const manager = new BranchWorkspaceManager(workspace.config)

    // First initialization
    const firstContext = await manager.openOrCreateBranch({
      branchName: 'main',
      mode: 'local-prod-sim',
      createdBy: 'test-1',
    })

    // Second access should load existing workspace
    const secondContext = await manager.openOrCreateBranch({
      branchName: 'main',
      mode: 'local-prod-sim',
      createdBy: 'test-2',
    })

    // Should return the same workspace path
    expect(secondContext.branchRoot).toBe(firstContext.branchRoot)

    // Verify only one workspace exists
    const branchesDir = path.join(workspace.tmpRoot, '.canopycms', 'branches')
    const entries = await fs.readdir(branchesDir)
    const mainDirs = entries.filter((e) => e === 'main')
    expect(mainDirs.length).toBe(1)
  })
})
