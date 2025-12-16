import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { BranchWorkspaceManager, loadBranchState } from './branch-workspace'
import { defineCanopyConfig } from './config'
import { defineCanopyTestConfig } from './config-test'
import { BranchRegistry } from './branch-registry'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branchws-'))

describe('BranchWorkspaceManager', () => {
  it('creates metadata and registry entry when opening a branch', async () => {
    const root = await tmpDir()
    const git = simpleGit({ baseDir: root })
    await git.init()
    const manager = new BranchWorkspaceManager(
      defineCanopyTestConfig({
        schema: [
          { type: 'collection', name: 'posts', path: 'posts', format: 'md', fields: [{ name: 'title', type: 'string' }] },
        ],
      })
    )

    const workspace = await manager.openOrCreateBranch({
      branchName: 'feature/foo',
      mode: 'local-simple',
      basePathOverride: root,
      createdBy: 'user-1',
      title: 'Foo Feature',
    })

    const metaFile = path.join(workspace.branchRoot, '.canopycms/branch.json')
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'))
    expect(meta.branch.name).toBe('feature-foo')
    expect(meta.branch.title).toBe('Foo Feature')
    expect(workspace.metadataRoot).toBe(workspace.branchRoot)
    expect(workspace.state.workspaceRoot).toBe(workspace.branchRoot)

    const registry = new BranchRegistry(root)
    const entry = await registry.get('feature-foo')
    expect(entry?.branch.name).toBe('feature-foo')
  })

  it('clones a remote and checks out the branch when remoteUrl is provided', async () => {
    const root = await tmpDir()
    const remotePath = path.join(root, 'remote.git')
    const seedPath = path.join(root, 'seed')
    await simpleGit().raw(['init', '--bare', remotePath])

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
        schema: [
          { type: 'collection', name: 'posts', path: 'posts', format: 'md', fields: [{ name: 'title', type: 'string' }] },
        ],
      })
    )

    const workspace = await manager.openOrCreateBranch({
      branchName: 'feature/foo',
      mode: 'local-prod-sim',
      basePathOverride: branchesRoot,
      createdBy: 'user-1',
    })

    const git = simpleGit({ baseDir: workspace.branchRoot })
    const status = await git.status()
    expect(status.current).toBe('feature-foo')
    const remotes = await git.getRemotes(true)
    expect(remotes.find((r) => r.name === 'origin')?.refs.fetch).toBe(remotePath)
  })

  it('loads branch state with workspace root for local-simple', async () => {
    const root = await tmpDir()
    const git = simpleGit({ baseDir: root })
    await git.init()
    const manager = new BranchWorkspaceManager(
      defineCanopyTestConfig({
        schema: [
          { type: 'collection', name: 'pages', path: 'pages', format: 'md', fields: [{ name: 'title', type: 'string' }] },
        ],
      })
    )

    await manager.openOrCreateBranch({
      branchName: 'main',
      mode: 'local-simple',
      basePathOverride: root,
      createdBy: 'user-1',
    })

    const state = await loadBranchState({
      branchName: 'main',
      mode: 'local-simple',
      basePathOverride: root,
    })

    expect(state?.branch.name).toBe('main')
    expect(state?.workspaceRoot).toBe(root)
    expect(state?.baseRoot).toBe(root)
  })
})
