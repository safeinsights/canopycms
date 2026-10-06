/**
 * Real-git tests for how few git processes workspace provisioning starts, and
 * for which auto-gc a GitManager can and cannot switch off. Processes are
 * counted from a `GIT_TRACE` file, which `gitChildEnv` passes through.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { GitManager, type InitializeWorkspaceOptions } from './git-manager'
import { initTestRepo } from './test-utils'

let tmpDir: string
let savedTrace: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-git-provision-'))
  savedTrace = process.env.GIT_TRACE
})

afterEach(async () => {
  if (savedTrace === undefined) delete process.env.GIT_TRACE
  else process.env.GIT_TRACE = savedTrace
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/**
 * Trace every git process into a file. Set it before constructing a
 * GitManager: its child env is captured once, at construction.
 */
function traceGit(name: string): { reset(): Promise<void>; builtins(): Promise<string[]> } {
  const file = path.join(tmpDir, `${name}.trace`)
  process.env.GIT_TRACE = file
  return {
    reset: () => fs.writeFile(file, ''),
    async builtins() {
      const text = await fs.readFile(file, 'utf-8')
      return [...text.matchAll(/trace: built-in: git (\S+)/g)].map((m) => m[1])
    },
  }
}

async function makeRemote(): Promise<string> {
  const sourceDir = path.join(tmpDir, 'source')
  await fs.mkdir(path.join(sourceDir, 'content'), { recursive: true })
  const sourceGit = await initTestRepo(sourceDir)
  await sourceGit.raw(['branch', '-M', 'main'])
  for (const name of ['a', 'b', 'c']) {
    await fs.writeFile(path.join(sourceDir, 'content', `${name}.md`), `# ${name}\n`, 'utf8')
  }
  await sourceGit.add(['.'])
  await sourceGit.commit('initial commit')
  const remotePath = path.join(tmpDir, 'remote.git')
  await simpleGit().raw(['clone', '--bare', sourceDir, remotePath])
  return remotePath
}

function workspaceOptions(remotePath: string, branchName: string): InitializeWorkspaceOptions {
  return {
    workspacePath: path.join(tmpDir, 'workspace'),
    branchName,
    mode: 'dev',
    baseBranch: 'main',
    remoteUrl: remotePath,
    branchType: 'content',
    gitBotAuthorName: 'Test Bot',
    gitBotAuthorEmail: 'bot@canopycms.test',
    gitExcludePattern: '.canopy-meta/',
  }
}

async function localConfig(repoPath: string, key: string): Promise<string> {
  return (await simpleGit({ baseDir: repoPath }).raw(['config', '--local', '--get', key])).trim()
}

async function packCount(objectsDir: string): Promise<number> {
  const names = await fs.readdir(path.join(objectsDir, 'pack'))
  return names.filter((name) => name.endsWith('.pack')).length
}

describe('GitManager.initializeWorkspace provisioning', () => {
  it('provisions a fresh content workspace with one clone and one checkout, and no config, branch or fetch processes', async () => {
    const remotePath = await makeRemote()
    const options = workspaceOptions(remotePath, 'feature-x')

    const trace = traceGit('fresh')
    await GitManager.initializeWorkspace(options)
    const ran = await trace.builtins()

    expect(ran.filter((cmd) => cmd === 'clone')).toHaveLength(1)
    expect(ran.filter((cmd) => cmd === 'checkout')).toHaveLength(1)
    expect(ran).not.toContain('config')
    expect(ran).not.toContain('branch')
    expect(ran).not.toContain('fetch')

    const ws = options.workspacePath
    expect(await localConfig(ws, 'canopycms.managed')).toBe('true')
    expect(await localConfig(ws, 'user.name')).toBe('Test Bot')
    expect(await localConfig(ws, 'user.email')).toBe('bot@canopycms.test')
    expect(await localConfig(ws, 'gc.auto')).toBe('0')
    expect(await localConfig(ws, 'maintenance.auto')).toBe('false')

    const wsGit = simpleGit({ baseDir: ws })
    expect((await wsGit.raw(['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('feature-x')
    expect((await wsGit.raw(['rev-parse', '--abbrev-ref', 'feature-x@{upstream}'])).trim()).toBe(
      'origin/main',
    )
    expect((await wsGit.status()).isClean()).toBe(true)
    expect(await fs.readFile(path.join(ws, 'content', 'b.md'), 'utf8')).toBe('# b\n')
  })

  it('populates the tree when the workspace is the base branch itself', async () => {
    const remotePath = await makeRemote()
    const options = workspaceOptions(remotePath, 'main')

    await GitManager.initializeWorkspace(options)

    const wsGit = simpleGit({ baseDir: options.workspacePath })
    expect((await wsGit.raw(['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('main')
    expect((await wsGit.status()).isClean()).toBe(true)
    expect(await fs.readFile(path.join(options.workspacePath, 'content', 'a.md'), 'utf8')).toBe(
      '# a\n',
    )
  })

  it('writes no config when it reuses a healthy workspace', async () => {
    const remotePath = await makeRemote()
    const options = workspaceOptions(remotePath, 'feature-x')
    await GitManager.initializeWorkspace(options)

    const configPath = path.join(options.workspacePath, '.git', 'config')
    const before = await fs.stat(configPath)
    const beforeText = await fs.readFile(configPath, 'utf8')

    await GitManager.initializeWorkspace(options)

    const after = await fs.stat(configPath)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await fs.readFile(configPath, 'utf8')).toBe(beforeText)
  })

  it('restores a missing managed marker and identity on a reused workspace', async () => {
    const remotePath = await makeRemote()
    const options = workspaceOptions(remotePath, 'feature-x')
    await GitManager.initializeWorkspace(options)
    const wsGit = simpleGit({ baseDir: options.workspacePath })
    await wsGit.raw(['config', '--local', '--unset', 'user.email'])

    await GitManager.initializeWorkspace(options)

    expect(await localConfig(options.workspacePath, 'user.email')).toBe('bot@canopycms.test')
    expect(await localConfig(options.workspacePath, 'canopycms.managed')).toBe('true')
  })
})

describe('auto-gc around a GitManager', () => {
  it("never runs gc or auto-maintenance in the GitManager's own repo", async () => {
    const repo = path.join(tmpDir, 'repo')
    await fs.mkdir(repo)
    const raw = await initTestRepo(repo)
    await raw.raw(['config', 'gc.auto', '1'])
    await raw.raw(['config', 'gc.autoPackLimit', '1'])
    await raw.raw(['config', 'gc.autoDetach', 'false'])
    for (const name of ['one', 'two']) {
      await fs.writeFile(path.join(repo, `${name}.txt`), name)
      await raw.raw(['-c', 'gc.auto=0', 'add', '.'])
      await raw.raw(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'commit', '-m', name])
      await raw.raw(['repack', '-q'])
    }
    expect(await packCount(path.join(repo, '.git', 'objects'))).toBe(2)

    const trace = traceGit('commit')
    const manager = new GitManager({ repoPath: repo })
    await fs.writeFile(path.join(repo, 'three.txt'), 'three')
    await manager.add('three.txt')
    await trace.reset()
    await manager.commit('three')
    const ran = await trace.builtins()

    expect(ran).toContain('commit')
    expect(ran).not.toContain('gc')
    expect(ran).not.toContain('maintenance')
    expect(await packCount(path.join(repo, '.git', 'objects'))).toBe(2)
  })

  // Git unsets GIT_CONFIG_PARAMETERS before spawning receive-pack for a
  // local-path push, so the pusher's `-c` cannot stop gc in remote.git; the
  // worker's remote.git config has to (cms-worker-remote-git-upkeep.test.ts).
  it("does not reach receive-pack: a push still runs the remote's own auto-gc", async () => {
    const remotePath = await makeRemote()
    const remote = simpleGit()
    for (const [key, value] of [
      ['receive.autogc', 'true'],
      ['gc.auto', '1'],
      ['gc.autoPackLimit', '1'],
      ['gc.autoDetach', 'false'],
      ['transfer.unpackLimit', '1'],
    ]) {
      await remote.raw(['--git-dir', remotePath, 'config', key, value])
    }
    await remote.raw(['--git-dir', remotePath, 'repack', '-a', '-d', '-q'])
    const options = workspaceOptions(remotePath, 'feature-x')
    const trace = traceGit('push')
    const manager = await GitManager.initializeWorkspace(options)

    await fs.writeFile(path.join(options.workspacePath, 'content', 'd.md'), '# d\n')
    await manager.add('content/d.md')
    await manager.commit('add d')
    await trace.reset()
    await manager.push()
    const ran = await trace.builtins()

    expect(ran).toContain('receive-pack')
    expect(ran).toContain('gc')
  })
})
