import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { BranchWorkspaceManager, loadBranchContext } from './branch-workspace'
import { defineCanopyConfig } from './config'
import { defineCanopyTestConfig } from './config-test'
import { BranchRegistry } from './branch-registry'
import { initBareRepo } from './__integration__/test-utils/test-workspace'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branchws-'))

describe('BranchWorkspaceManager', () => {
  it('dev mode does not support branching', async () => {
    const root = await tmpDir()
    const git = simpleGit({ baseDir: root })
    await git.init()
    const manager = new BranchWorkspaceManager(
      defineCanopyTestConfig({
        schema: {
          collections: [
            { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', fields: [{ name: 'title', type: 'string' }] }] },
          ],
                  },
      })
    )

    // Dev mode should throw when trying to use branching functions
    await expect(
      manager.openOrCreateBranch({
        branchName: 'feature/foo',
        mode: 'dev',
        basePathOverride: root,
        createdBy: 'user-1',
        title: 'Foo Feature',
      })
    ).rejects.toThrow('No branching in dev mode')
  })

  it('creates metadata and registry entry when opening a branch in multi-branch mode', async () => {
    const root = await tmpDir()
    const remotePath = path.join(root, 'remote.git')
    const seedPath = path.join(root, 'seed')

    // Set up a bare remote repo
    await initBareRepo(remotePath)
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = simpleGit({ baseDir: seedPath })
    await seedGit.init()
    await seedGit.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(seedPath, 'README.md'), '# seed\n', 'utf8')
    await seedGit.add(['.'])
    await seedGit.commit('init')
    await seedGit.addRemote('origin', remotePath)
    await seedGit.push('origin', 'main', { '--set-upstream': null })

    const manager = new BranchWorkspaceManager(
      defineCanopyTestConfig({
        defaultBaseBranch: 'main',
        defaultRemoteUrl: remotePath,
        schema: {
          collections: [
            { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', fields: [{ name: 'title', type: 'string' }] }] },
          ],
                  },
      })
    )

    const workspace = await manager.openOrCreateBranch({
      branchName: 'feature/foo',
      mode: 'prod-sim',
      basePathOverride: root,
      createdBy: 'user-1',
      title: 'Foo Feature',
    })

    // In prod-sim, strategy creates .canopy-prod-sim/content-branches structure
    const expectedBranchesRoot = path.join(root, '.canopy-prod-sim', 'content-branches')

    // Note: Still using .canopycms for now - Phase 2 will migrate to .canopy-meta
    const metaFile = path.join(workspace.branchRoot, '.canopy-meta/branch.json')
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'))
    expect(meta.branch.name).toBe('feature-foo')
    expect(meta.branch.title).toBe('Foo Feature')
    expect(workspace.branchRoot).toBeDefined()
    expect(workspace.baseRoot).toBe(expectedBranchesRoot)

    // In multi-branch mode, registry can scan subdirectories and find the branch
    const registry = new BranchRegistry(expectedBranchesRoot)
    const entry = await registry.get('feature-foo')
    expect(entry?.branch.name).toBe('feature-foo')
  })

  it('clones a remote and checks out the branch when remoteUrl is provided', async () => {
    const root = await tmpDir()
    const remotePath = path.join(root, 'remote.git')
    const seedPath = path.join(root, 'seed')
    await initBareRepo(remotePath)

    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = simpleGit({ baseDir: seedPath })
    await seedGit.init()
    await seedGit.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(seedPath, 'README.md'), '# seed\n', 'utf8')
    await seedGit.add(['.'])
    await seedGit.commit('init')
    await seedGit.addRemote('origin', remotePath)
    await seedGit.push('origin', 'main', { '--set-upstream': null })

    const branchesRoot = path.join(root, 'branches')
    const manager = new BranchWorkspaceManager(
      defineCanopyTestConfig({
        defaultBaseBranch: 'main',
        defaultRemoteUrl: remotePath,
        schema: {
          collections: [
            { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', fields: [{ name: 'title', type: 'string' }] }] },
          ],
                  },
      })
    )

    const workspace = await manager.openOrCreateBranch({
      branchName: 'feature/foo',
      mode: 'prod-sim',
      basePathOverride: branchesRoot,
      createdBy: 'user-1',
    })

    const git = simpleGit({ baseDir: workspace.branchRoot })
    const status = await git.status()
    expect(status.current).toBe('feature-foo')
    const remotes = await git.getRemotes(true)
    expect(remotes.find((r) => r.name === 'origin')?.refs.fetch).toBe(remotePath)
  })

  it('dev mode throws when trying to load branch state', async () => {
    const root = await tmpDir()
    const git = simpleGit({ baseDir: root })
    await git.init()

    // Dev mode doesn't support branching, so loadBranchContext should throw
    await expect(
      loadBranchContext({
        branchName: 'main',
        mode: 'dev',
        basePathOverride: root,
      })
    ).rejects.toThrow('No branching in dev mode')
  })
})
