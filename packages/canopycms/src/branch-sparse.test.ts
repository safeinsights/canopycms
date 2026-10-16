/**
 * Sparse checkout of content-branch clones (branch-sparse.ts), against real git in prod mode.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { loadPathPermissions } from './authorization/permissions/loader'
import { readRecordedSparseCone } from './branch-sparse'
import { BranchWorkspaceManager } from './branch-workspace'
import { defineCanopyTestConfig } from './config-test'
import { GitManager } from './git-manager'
import { createCanopyRequestHandler } from './http/handler'
import type { CanopyServices } from './services'
import { SettingsWorkspaceManager } from './settings-workspace'
import { initTestRepo, mockConsole, type MockConsole } from './test-utils'
import { setProvisionLogSink } from './utils/provision-log'

const PERMISSIONS = {
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'admin',
  pathPermissions: [{ path: 'content/**', edit: { allowedUsers: ['editor-1'] } }],
}

const SOURCE_FILES: Record<string, string> = {
  'permissions.json': JSON.stringify(PERMISSIONS),
  'canopycms.config.ts': 'export default {}\n',
  'content/hello.md': '# hi\n',
  'content/posts/first.md': '# first\n',
  'cms/readme.md': 'beside the nested content root\n',
  'cms/content/nested.md': '# nested\n',
  'src/app.ts': 'export {}\n',
  'docs/guide.md': '# guide\n',
  '.canopy-meta/tracked.json': '{"committed":true}\n',
}

let tmpDir: string
let workspaceRoot: string
let baseRoot: string
let remoteUrl: string
let consoleSpy: MockConsole

beforeEach(async () => {
  consoleSpy = mockConsole()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sparse-'))
  workspaceRoot = path.join(tmpDir, 'ws')
  baseRoot = path.join(workspaceRoot, 'content-branches')
  vi.stubEnv('CANOPYCMS_WORKSPACE_ROOT', workspaceRoot)
  remoteUrl = await makeRemote()
})

afterEach(async () => {
  setProvisionLogSink(() => {})
  consoleSpy.restore()
  vi.unstubAllEnvs()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function makeRemote(): Promise<string> {
  const sourceDir = path.join(tmpDir, 'source')
  await fs.mkdir(sourceDir, { recursive: true })
  const source = await initTestRepo(sourceDir)
  await source.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const [file, body] of Object.entries(SOURCE_FILES)) {
    await fs.mkdir(path.dirname(path.join(sourceDir, file)), { recursive: true })
    await fs.writeFile(path.join(sourceDir, file), body)
  }
  await source.add('.')
  await source.commit('initial')
  const remotePath = path.join(workspaceRoot, 'remote.git')
  await simpleGit().raw(['clone', '-q', '--bare', sourceDir, remotePath])
  return remotePath
}

function config(contentRoot?: string) {
  return defineCanopyTestConfig({
    mode: 'prod',
    defaultBaseBranch: 'main',
    defaultRemoteUrl: remoteUrl,
    deploymentName: 'test',
    schema: { collections: [] },
    ...(contentRoot === undefined ? {} : { contentRoot }),
  })
}

function create(branchName: string, contentRoot?: string) {
  return new BranchWorkspaceManager(config(contentRoot)).openOrCreateBranch({
    branchName,
    mode: 'prod',
    createdBy: 'user-1',
  })
}

/** Every file in a working tree as sorted repo-relative paths, without `.git` or cache markers. */
async function workingTree(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.generation'))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter((file) => !file.startsWith(`.git${path.sep}`))
    .sort()
}

async function isSparse(root: string): Promise<boolean> {
  const value = await simpleGit({ baseDir: root })
    .raw(['config', '--get', '--type=bool', 'core.sparseCheckout'])
    .catch(() => '')
  return value.trim() === 'true'
}

describe('content-branch clones', () => {
  it('check out the content root, .canopy-meta and root-level files, and nothing else', async () => {
    const { branchRoot } = await create('feat')

    expect(await workingTree(branchRoot)).toEqual([
      '.canopy-meta/branch.json',
      '.canopy-meta/tracked.json',
      'canopycms.config.ts',
      'content/hello.md',
      'content/posts/first.md',
      'permissions.json',
    ])
    const git = simpleGit({ baseDir: branchRoot })
    expect((await git.raw(['sparse-checkout', 'list'])).trim().split('\n')).toEqual([
      '.canopy-meta',
      'content',
    ])
    expect((await git.status()).isClean()).toBe(true)
    expect((await git.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('feat')
  })

  it('take a multi-segment content root with the files beside it', async () => {
    const { branchRoot } = await create('feat', 'cms/content')

    expect(await workingTree(branchRoot)).toEqual([
      '.canopy-meta/branch.json',
      '.canopy-meta/tracked.json',
      'canopycms.config.ts',
      'cms/content/nested.md',
      'cms/readme.md',
      'permissions.json',
    ])
  })

  it('are full when the content root is the repository root', async () => {
    const { branchRoot } = await create('feat', '.')

    expect(await isSparse(branchRoot)).toBe(false)
    expect(await workingTree(branchRoot)).toContain('src/app.ts')
  })

  it('log the sparse step', async () => {
    const lines: string[] = []
    setProvisionLogSink((line) => lines.push(line))

    await create('feat')

    expect(lines.some((line) => /dir=feat step=sparse start$/.test(line))).toBe(true)
    expect(lines.some((line) => /dir=feat step=sparse done ms=\d+$/.test(line))).toBe(true)
    expect(lines.findIndex((line) => line.includes('step=sparse start'))).toBeLessThan(
      lines.findIndex((line) => line.includes('step=checkout start')),
    )
  })

  it('record the cone for the worker, or that there is none', async () => {
    await create('feat')
    expect(await readRecordedSparseCone(baseRoot)).toEqual({ cone: ['.canopy-meta', 'content'] })

    await create('other', '.')
    expect(await readRecordedSparseCone(baseRoot)).toEqual({ cone: null })
  })

  it('record the configured cone when the API handler starts, before any branch is created', async () => {
    await create('feat')
    const handler = createCanopyRequestHandler({
      services: {
        config: config('cms/content'),
        refreshActiveBranch: async () => {},
        resolvePendingBaseBranch: async () => {},
      } as unknown as CanopyServices,
      authPlugin: {
        verifiesCredentials: true,
        authenticate: async () => ({ success: false, error: 'Unauthorized' }),
        searchUsers: async () => [],
        getUserMetadata: async () => null,
        getGroupMetadata: async () => null,
        listGroups: async () => [],
      },
    })

    const response = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/canopycms/branches',
        header: () => null,
        json: async () => undefined,
      },
      ['branches'],
    )

    expect(response.status).toBe(401)
    expect(await readRecordedSparseCone(baseRoot)).toEqual({
      cone: ['.canopy-meta', 'cms/content'],
    })
  })

  it('stage an explicit path outside the cone (commitFiles)', async () => {
    const { branchRoot } = await create('feat')
    await fs.mkdir(path.join(branchRoot, 'src'))
    await fs.writeFile(path.join(branchRoot, 'src/new.ts'), 'export {}\n')

    await new GitManager({ repoPath: branchRoot, baseBranch: 'main' }).add(['src/new.ts'])

    const staged = await simpleGit({ baseDir: branchRoot }).raw(['diff', '--cached', '--name-only'])
    expect(staged.trim()).toBe('src/new.ts')
  })

  it('serve path permissions from a sparse base-branch clone', async () => {
    const { branchRoot } = await create('main')

    expect(await isSparse(branchRoot)).toBe(true)
    const rules = await loadPathPermissions(branchRoot, 'prod')
    expect(rules).toEqual([{ path: 'content/**', edit: { allowedUsers: ['editor-1'] } }])
  })
})

describe('the settings workspace', () => {
  const SETTINGS_BRANCH = 'canopycms-settings-test'

  it('is never sparse, and its orphan branch carries no base content', async () => {
    const settingsRoot = path.join(workspaceRoot, 'settings')
    await new SettingsWorkspaceManager(config()).ensureGitWorkspace({
      settingsRoot,
      branchName: SETTINGS_BRANCH,
      mode: 'prod',
      remoteUrl,
    })

    expect(await isSparse(settingsRoot)).toBe(false)
    const tree = await simpleGit({ baseDir: settingsRoot }).raw([
      'ls-tree',
      '-r',
      '--name-only',
      SETTINGS_BRANCH,
    ])
    expect(tree).toBe('')
  })

  it('keeps out-of-cone base files out of an orphan made in a sparse clone', async () => {
    const root = path.join(tmpDir, 'sparse-settings')
    await simpleGit().raw(['clone', '-q', '--single-branch', '--branch', 'main', remoteUrl, root])
    const git = simpleGit({ baseDir: root })
    await git.raw(['sparse-checkout', 'set', '--cone', 'content'])
    await git.addConfig('user.name', 'Test Bot')
    await git.addConfig('user.email', 'test@canopycms.test')

    await new GitManager({ repoPath: root, baseBranch: 'main' }).createOrphanSettingsBranch(
      SETTINGS_BRANCH,
      {},
    )

    expect(await git.raw(['ls-tree', '-r', '--name-only', SETTINGS_BRANCH])).toBe('')
  })
})
