import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { GitManager } from './git-manager'

describe('GitManager.ensureLocalSimulatedRemote', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-git-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates bare remote and pushes baseBranch when remote does not exist', async () => {
    // Setup: create a git repo with a commit on main
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()
    await git.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello', 'utf8')
    await git.add(['.'])
    await git.commit('initial commit')

    const remotePath = path.join(tmpDir, 'remote.git')

    // Act
    await GitManager.ensureLocalSimulatedRemote({
      remotePath,
      sourcePath: tmpDir,
      baseBranch: 'main',
    })

    // Assert: remote exists and has main branch
    const remoteStat = await fs.stat(remotePath)
    expect(remoteStat.isDirectory()).toBe(true)

    const remoteGit = simpleGit({ baseDir: remotePath })
    const branches = await remoteGit.branch()
    expect(branches.all).toContain('main')
  })

  it('is idempotent - does not recreate if remote already exists', async () => {
    // Setup
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()
    await git.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello', 'utf8')
    await git.add(['.'])
    await git.commit('initial commit')

    const remotePath = path.join(tmpDir, 'remote.git')

    // Create remote first time
    await GitManager.ensureLocalSimulatedRemote({
      remotePath,
      sourcePath: tmpDir,
      baseBranch: 'main',
    })

    // Get initial state
    const initialStat = await fs.stat(remotePath)
    const initialMtime = initialStat.mtimeMs

    // Wait a bit to ensure mtime would change if recreated
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Act: call again
    await GitManager.ensureLocalSimulatedRemote({
      remotePath,
      sourcePath: tmpDir,
      baseBranch: 'main',
    })

    // Assert: directory wasn't recreated (mtime unchanged)
    const finalStat = await fs.stat(remotePath)
    expect(finalStat.mtimeMs).toBe(initialMtime)
  })

  it('throws error if sourcePath is not a git repo', async () => {
    const remotePath = path.join(tmpDir, 'remote.git')

    await expect(
      GitManager.ensureLocalSimulatedRemote({
        remotePath,
        sourcePath: tmpDir,
        baseBranch: 'main',
      }),
    ).rejects.toThrow('not a git repository')
  })

  it('throws error if git repo has no commits', async () => {
    // Setup: init repo but don't commit
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()

    const remotePath = path.join(tmpDir, 'remote.git')

    await expect(
      GitManager.ensureLocalSimulatedRemote({
        remotePath,
        sourcePath: tmpDir,
        baseBranch: 'main',
      }),
    ).rejects.toThrow('repository has no commits')
  })

  it('throws error if baseBranch does not exist locally', async () => {
    // Setup: create repo with commit on main, but ask for develop
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()
    await git.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello', 'utf8')
    await git.add(['.'])
    await git.commit('initial commit')

    const remotePath = path.join(tmpDir, 'remote.git')

    await expect(
      GitManager.ensureLocalSimulatedRemote({
        remotePath,
        sourcePath: tmpDir,
        baseBranch: 'develop',
      }),
    ).rejects.toThrow("base branch 'develop' does not exist locally")
  })

  it('pushes actual baseBranch content, not current HEAD', async () => {
    // Setup: create main with one commit, then feature branch with different commit
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()
    await git.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(tmpDir, 'main.txt'), 'main content', 'utf8')
    await git.add(['.'])
    await git.commit('main commit')

    // Create feature branch with different content
    await git.checkoutLocalBranch('feature')
    await fs.writeFile(path.join(tmpDir, 'feature.txt'), 'feature content', 'utf8')
    await git.add(['.'])
    await git.commit('feature commit')

    const remotePath = path.join(tmpDir, 'remote.git')

    // Act: initialize remote while on feature branch, but specify main as baseBranch
    await GitManager.ensureLocalSimulatedRemote({
      remotePath,
      sourcePath: tmpDir,
      baseBranch: 'main',
    })

    // Assert: remote has main, not feature
    const remoteGit = simpleGit({ baseDir: remotePath })
    const branches = await remoteGit.branch()
    expect(branches.all).toContain('main')
    expect(branches.all).not.toContain('feature')

    // Clone the remote to verify content
    const clonePath = path.join(tmpDir, 'clone')
    await simpleGit().clone(remotePath, clonePath)
    const cloneFiles = await fs.readdir(clonePath)
    expect(cloneFiles).toContain('main.txt')
    expect(cloneFiles).not.toContain('feature.txt')
  })
})

describe('GitManager.resolveRemoteUrl', () => {
  let tmpDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-resolve-test-'))
    originalEnv = process.env.CANOPYCMS_REMOTE_URL
    delete process.env.CANOPYCMS_REMOTE_URL
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    if (originalEnv !== undefined) {
      process.env.CANOPYCMS_REMOTE_URL = originalEnv
    } else {
      delete process.env.CANOPYCMS_REMOTE_URL
    }
  })

  it('returns explicit remoteUrl when provided (highest priority)', async () => {
    const result = await GitManager.resolveRemoteUrl({
      mode: 'local-prod-sim',
      remoteUrl: 'https://explicit.com/repo.git',
      defaultRemoteUrl: 'https://default.com/repo.git',
      baseBranch: 'main',
    })

    expect(result).toBe('https://explicit.com/repo.git')
  })

  it('returns defaultRemoteUrl when no explicit url', async () => {
    const result = await GitManager.resolveRemoteUrl({
      mode: 'local-prod-sim',
      defaultRemoteUrl: 'https://default.com/repo.git',
      baseBranch: 'main',
    })

    expect(result).toBe('https://default.com/repo.git')
  })

  it('returns env var CANOPYCMS_REMOTE_URL when no config', async () => {
    process.env.CANOPYCMS_REMOTE_URL = 'https://env.com/repo.git'

    const result = await GitManager.resolveRemoteUrl({
      mode: 'local-prod-sim',
      baseBranch: 'main',
    })

    expect(result).toBe('https://env.com/repo.git')
  })

  it('auto-initializes and returns local remote path for local-prod-sim', async () => {
    // Setup: create git repo in tmpDir with commit
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()
    await git.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello', 'utf8')
    await git.add(['.'])
    await git.commit('initial commit')

    // Get the real git root path (handles symlinks on macOS)
    const gitRootResult = await git.raw(['rev-parse', '--show-toplevel'])
    const gitRoot = gitRootResult.trim()

    // Mock process.cwd() to return tmpDir
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

    try {
      const result = await GitManager.resolveRemoteUrl({
        mode: 'local-prod-sim',
        baseBranch: 'main',
      })

      expect(result).toBe(path.join(gitRoot, '.canopycms/remote.git'))

      // Verify remote was created
      const remoteStat = await fs.stat(path.join(gitRoot, '.canopycms/remote.git'))
      expect(remoteStat.isDirectory()).toBe(true)
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('returns undefined for local-simple mode', async () => {
    const result = await GitManager.resolveRemoteUrl({
      mode: 'local-simple',
      baseBranch: 'main',
    })

    expect(result).toBeUndefined()
  })

  it('skips auto-init when explicit remoteUrl provided', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

    try {
      const result = await GitManager.resolveRemoteUrl({
        mode: 'local-prod-sim',
        remoteUrl: 'https://explicit.com/repo.git',
        baseBranch: 'main',
      })

      expect(result).toBe('https://explicit.com/repo.git')

      // Verify no local remote was created
      await expect(fs.stat(path.join(tmpDir, '.canopycms/remote.git'))).rejects.toThrow()
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('uses sourceRoot when provided for local-prod-sim', async () => {
    // Setup: create git repo with subdirectory structure
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()
    await git.raw(['branch', '-M', 'main'])

    // Create subdirectory with content
    const subdir = path.join(tmpDir, 'packages/example')
    await fs.mkdir(subdir, { recursive: true })
    await fs.writeFile(path.join(subdir, 'test.txt'), 'hello', 'utf8')
    await git.add(['.'])
    await git.commit('initial commit')

    // Get the real git root path (handles symlinks on macOS)
    const gitRootResult = await git.raw(['rev-parse', '--show-toplevel'])
    const gitRoot = gitRootResult.trim()

    // Mock process.cwd() to return tmpDir (git root)
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

    try {
      const result = await GitManager.resolveRemoteUrl({
        mode: 'local-prod-sim',
        baseBranch: 'main',
        sourceRoot: 'packages/example',
      })

      // Should resolve to the subdirectory (using real git root path)
      expect(result).toBe(path.join(gitRoot, 'packages/example/.canopycms/remote.git'))

      // Verify remote was created in the subdirectory
      const actualSubdir = path.join(gitRoot, 'packages/example')
      const remoteStat = await fs.stat(path.join(actualSubdir, '.canopycms/remote.git'))
      expect(remoteStat.isDirectory()).toBe(true)

      // Verify remote contains main branch
      const remoteGit = simpleGit({ baseDir: path.join(actualSubdir, '.canopycms/remote.git') })
      const branches = await remoteGit.branch()
      expect(branches.all).toContain('main')

      // Clone and verify only subdirectory content was pushed (via git subtree)
      const clonePath = path.join(tmpDir, 'clone-test')
      await simpleGit().clone(path.join(actualSubdir, '.canopycms/remote.git'), clonePath)
      const cloneFiles = await fs.readdir(clonePath)
      expect(cloneFiles).toContain('test.txt')
      // Should NOT contain packages/ dir since we used git subtree split
      expect(cloneFiles).not.toContain('packages')
    } finally {
      cwdSpy.mockRestore()
    }
  })
})
