/**
 * Prod's base branch with real git: configured wins, otherwise it is read from remote.git's HEAD
 * at creation, or on the first request after the worker creates remote.git, and an unreadable
 * remote fails loudly instead of assuming 'main'.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BranchWorkspaceManager } from './branch-workspace'
import { defineCanopyTestConfig } from './config-test'
import { RemoteNotReadyError } from './git-manager'
import { clearStrategyCache } from './operating-mode/client-unsafe-strategy'
import { createCanopyServices } from './services'
import { mockConsole, type MockConsole } from './test-utils'
import type { BranchContext } from './types'
import type { CanopyUser } from './user'
import { BaseBranchUnresolvedError } from './utils/base-branch'

const branchSchemaCache = {
  getSchema: async () => ({ schema: {}, flatSchema: [] }),
  invalidate: async () => {},
} as unknown as NonNullable<Parameters<typeof createCanopyServices>[1]>['branchSchemaCache']

describe('prod base branch resolution', () => {
  let workspaceRoot: string
  let previousRoot: string | undefined
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-base-branch-'))
    previousRoot = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot
    clearStrategyCache()
  })

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.CANOPYCMS_WORKSPACE_ROOT
    else process.env.CANOPYCMS_WORKSPACE_ROOT = previousRoot
    clearStrategyCache()
    consoleSpy.restore()
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  const remoteGit = () => path.join(workspaceRoot, 'remote.git')

  /** What the worker leaves: a bare clone whose HEAD names the repository's default branch. */
  const createRemoteGit = async (defaultBranch: string) => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-base-branch-src-'))
    const git = simpleGit({ baseDir: source })
    await git.init([`--initial-branch=${defaultBranch}`])
    await git.addConfig('user.name', 'Test')
    await git.addConfig('user.email', 'test@test.com')
    await fs.writeFile(path.join(source, 'README.md'), '# site\n')
    await git.add('-A')
    await git.commit('initial commit')
    await simpleGit().clone(source, remoteGit(), ['--bare'])
    await fs.rm(source, { recursive: true, force: true })
  }

  const makeServices = (overrides: Record<string, unknown> = {}) =>
    createCanopyServices(defineCanopyTestConfig({ schema: {}, mode: 'prod' }, overrides), {
      branchSchemaCache,
    })

  /** A branch named `name` with no recorded fork point, so only the config can protect it. */
  const unrecordedBranch = (name: string) =>
    ({
      branchRoot: path.join(workspaceRoot, 'content-branches', name),
      branch: { name, access: {}, createdBy: 'canopycms-system', status: 'editing' },
    }) as unknown as BranchContext
  const editor: CanopyUser = { type: 'authenticated', userId: 'editor-1', groups: [] }

  it('a configured defaultBaseBranch wins over the remote HEAD', async () => {
    await createRemoteGit('production')

    const services = await makeServices({ defaultBaseBranch: 'release' })

    expect(services.config.defaultBaseBranch).toBe('release')
    expect(services.config.defaultActiveBranch).toBe('release')
  })

  it('reads an unset base branch from remote.git HEAD at creation', async () => {
    await createRemoteGit('production')

    const services = await makeServices()

    expect(services.config.defaultBaseBranch).toBe('production')
    expect(services.config.defaultActiveBranch).toBe('production')
  })

  it('stays pending until the worker creates remote.git, then resolves on request', async () => {
    const services = await makeServices()
    expect(services.config.defaultBaseBranch).toBeUndefined()

    await expect(services.resolvePendingBaseBranch()).rejects.toThrow(RemoteNotReadyError)

    await createRemoteGit('production')
    await services.resolvePendingBaseBranch()

    expect(services.config.defaultBaseBranch).toBe('production')
    expect(services.config.defaultActiveBranch).toBe('production')
    // Consumers built at creation read the resolved value, not the pending one.
    expect(services.checkBranchAccess(unrecordedBranch('production'), editor)).toEqual({
      allowed: true,
      reason: 'base_branch',
    })
    expect(services.checkBranchAccess(unrecordedBranch('main'), editor).allowed).toBe(false)
  })

  it.each([
    ['a path', (dir: string) => dir],
    ['a file URL', (dir: string) => pathToFileURL(dir).href],
  ])(
    'stays pending, not failing, while a configured local remote (%s) does not exist yet',
    async (_shape, toUrl) => {
      const services = await makeServices({ defaultRemoteUrl: toUrl(remoteGit()) })
      expect(services.config.defaultBaseBranch).toBeUndefined()
      await expect(services.resolvePendingBaseBranch()).rejects.toThrow(RemoteNotReadyError)

      await createRemoteGit('production')
      await services.resolvePendingBaseBranch()

      expect(services.config.defaultBaseBranch).toBe('production')
    },
  )

  it('keeps a configured active branch when the base branch resolves later', async () => {
    const services = await makeServices({ defaultActiveBranch: 'staging' })
    await createRemoteGit('production')

    await services.resolvePendingBaseBranch()

    expect(services.config.defaultBaseBranch).toBe('production')
    expect(services.config.defaultActiveBranch).toBe('staging')
  })

  it('provisions a prod branch from the remote HEAD when given an unresolved config', async () => {
    const config = defineCanopyTestConfig({ schema: {}, mode: 'prod' })
    const open = () =>
      new BranchWorkspaceManager(config).openOrCreateBranch({
        branchName: 'feature-x',
        mode: 'prod',
        createdBy: 'editor-1',
      })

    await expect(open()).rejects.toThrow(RemoteNotReadyError)

    await createRemoteGit('production')
    const context = await open()
    expect(context.branch.baseBranch).toBe('production')
  })

  it('fails loudly at creation when remote.git HEAD names no branch with a commit', async () => {
    await simpleGit().raw(['init', '--bare', '--initial-branch=production', remoteGit()])

    await expect(makeServices()).rejects.toThrow(BaseBranchUnresolvedError)
    await expect(makeServices()).rejects.toThrow(/Set defaultBaseBranch/)
  })

  it('fails loudly at creation for a network remote it cannot read locally', async () => {
    await expect(
      makeServices({
        defaultRemoteUrl: 'https://github.com/acme/site.git',
        allowNetworkRemoteInProd: true,
      }),
    ).rejects.toThrow(/cannot be read locally from the network remote/)
  })
})
