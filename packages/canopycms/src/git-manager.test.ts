import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { GitManager, GitConflictError } from './git-manager'
import { initTestRepo } from './test-utils'

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
    const git = await initTestRepo(tmpDir)
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
    const git = await initTestRepo(tmpDir)
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
      mode: 'dev',
      remoteUrl: 'https://explicit.com/repo.git',
      defaultRemoteUrl: 'https://default.com/repo.git',
      baseBranch: 'main',
    })

    expect(result).toBe('https://explicit.com/repo.git')
  })

  it('returns defaultRemoteUrl when no explicit url', async () => {
    const result = await GitManager.resolveRemoteUrl({
      mode: 'dev',
      defaultRemoteUrl: 'https://default.com/repo.git',
      baseBranch: 'main',
    })

    expect(result).toBe('https://default.com/repo.git')
  })

  it('returns env var CANOPYCMS_REMOTE_URL when no config', async () => {
    process.env.CANOPYCMS_REMOTE_URL = 'https://env.com/repo.git'

    const result = await GitManager.resolveRemoteUrl({
      mode: 'dev',
      baseBranch: 'main',
    })

    expect(result).toBe('https://env.com/repo.git')
  })

  it('auto-initializes and returns local remote path for dev mode', async () => {
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
        mode: 'dev',
        baseBranch: 'main',
      })

      expect(result).toBe(path.join(gitRoot, '.canopy-dev/remote.git'))

      // Verify remote was created
      const remoteStat = await fs.stat(path.join(gitRoot, '.canopy-dev/remote.git'))
      expect(remoteStat.isDirectory()).toBe(true)
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('skips auto-init when explicit remoteUrl provided', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

    try {
      const result = await GitManager.resolveRemoteUrl({
        mode: 'dev',
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

  it('uses sourceRoot when provided for dev mode', async () => {
    // Setup: create git repo with subdirectory structure
    const git = await initTestRepo(tmpDir)
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
        mode: 'dev',
        baseBranch: 'main',
        sourceRoot: 'packages/example',
      })

      // Should resolve to the subdirectory (using real git root path)
      expect(result).toBe(path.join(gitRoot, 'packages/example/.canopy-dev/remote.git'))

      // Verify remote was created in the subdirectory
      const actualSubdir = path.join(gitRoot, 'packages/example')
      const remoteStat = await fs.stat(path.join(actualSubdir, '.canopy-dev/remote.git'))
      expect(remoteStat.isDirectory()).toBe(true)

      // Verify remote contains main branch
      const remoteGit = simpleGit({
        baseDir: path.join(actualSubdir, '.canopy-dev/remote.git'),
      })
      const branches = await remoteGit.branch()
      expect(branches.all).toContain('main')

      // Clone and verify only subdirectory content was pushed (via git subtree)
      const clonePath = path.join(tmpDir, 'clone-test')
      await simpleGit().clone(path.join(actualSubdir, '.canopy-dev/remote.git'), clonePath)
      const cloneFiles = await fs.readdir(clonePath)
      expect(cloneFiles).toContain('test.txt')
      // Should NOT contain packages/ dir since we used git subtree split
      expect(cloneFiles).not.toContain('packages')
    } finally {
      cwdSpy.mockRestore()
    }
  })
  it('auto-detects remote.git at workspace root in prod mode', async () => {
    // Setup: create a bare repo at the expected workspace path
    const workspaceRoot = path.join(tmpDir, 'workspace')
    const remoteGitPath = path.join(workspaceRoot, 'remote.git')
    await fs.mkdir(workspaceRoot, { recursive: true })
    const bareGit = simpleGit()
    await bareGit
      .clone(tmpDir, remoteGitPath, ['--bare']) // needs a source, use tmpDir as dummy
      .catch(async () => {
        // If tmpDir isn't a repo, just init a bare repo directly
        await fs.mkdir(remoteGitPath, { recursive: true })
        await simpleGit({ baseDir: remoteGitPath }).init(true)
      })

    // Point CANOPYCMS_WORKSPACE_ROOT to our test workspace
    const origWorkspace = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot

    try {
      // Clear strategy cache so it picks up new env var
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()

      const result = await GitManager.resolveRemoteUrl({
        mode: 'prod',
        baseBranch: 'main',
      })

      expect(result).toBe(remoteGitPath)
    } finally {
      if (origWorkspace !== undefined) {
        process.env.CANOPYCMS_WORKSPACE_ROOT = origWorkspace
      } else {
        delete process.env.CANOPYCMS_WORKSPACE_ROOT
      }
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()
    }
  })

  it('returns undefined for prod mode when remote.git does not exist', async () => {
    // Point CANOPYCMS_WORKSPACE_ROOT to a directory without remote.git
    const workspaceRoot = path.join(tmpDir, 'empty-workspace')
    await fs.mkdir(workspaceRoot, { recursive: true })

    const origWorkspace = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot

    try {
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()

      const result = await GitManager.resolveRemoteUrl({
        mode: 'prod',
        baseBranch: 'main',
      })

      expect(result).toBeUndefined()
    } finally {
      if (origWorkspace !== undefined) {
        process.env.CANOPYCMS_WORKSPACE_ROOT = origWorkspace
      } else {
        delete process.env.CANOPYCMS_WORKSPACE_ROOT
      }
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()
    }
  })

  it('explicit remoteUrl takes priority over auto-detected remote.git in prod mode', async () => {
    // Setup: create remote.git at workspace root
    const workspaceRoot = path.join(tmpDir, 'workspace')
    const remoteGitPath = path.join(workspaceRoot, 'remote.git')
    await fs.mkdir(remoteGitPath, { recursive: true })
    await simpleGit({ baseDir: remoteGitPath }).init(true)

    const origWorkspace = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot

    try {
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()

      const result = await GitManager.resolveRemoteUrl({
        mode: 'prod',
        remoteUrl: 'https://explicit.com/repo.git',
        baseBranch: 'main',
      })

      // Explicit URL should win over auto-detected path
      expect(result).toBe('https://explicit.com/repo.git')
    } finally {
      if (origWorkspace !== undefined) {
        process.env.CANOPYCMS_WORKSPACE_ROOT = origWorkspace
      } else {
        delete process.env.CANOPYCMS_WORKSPACE_ROOT
      }
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()
    }
  })

  it('env var CANOPYCMS_REMOTE_URL takes priority over auto-detected remote.git', async () => {
    // Setup: create remote.git at workspace root
    const workspaceRoot = path.join(tmpDir, 'workspace')
    const remoteGitPath = path.join(workspaceRoot, 'remote.git')
    await fs.mkdir(remoteGitPath, { recursive: true })
    await simpleGit({ baseDir: remoteGitPath }).init(true)

    const origWorkspace = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot
    process.env.CANOPYCMS_REMOTE_URL = 'https://env.com/repo.git'

    try {
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()

      const result = await GitManager.resolveRemoteUrl({
        mode: 'prod',
        baseBranch: 'main',
      })

      // Env var should win over auto-detected path
      expect(result).toBe('https://env.com/repo.git')
    } finally {
      if (origWorkspace !== undefined) {
        process.env.CANOPYCMS_WORKSPACE_ROOT = origWorkspace
      } else {
        delete process.env.CANOPYCMS_WORKSPACE_ROOT
      }
      const { clearStrategyCache } = await import('./operating-mode/client-unsafe-strategy')
      clearStrategyCache()
    }
  })
}, 10000)

describe('GitManager.ensureAuthor', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-git-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('allows setting author in managed repository', async () => {
    // Setup: create managed repo
    const git = await initTestRepo(tmpDir)
    await git.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'content', 'utf8')
    await git.add(['.'])
    await git.commit('Initial commit')

    // Create GitManager and ensure author
    const manager = new GitManager({ repoPath: tmpDir })
    await expect(
      manager.ensureAuthor({ name: 'Bot User', email: 'bot@example.com' }),
    ).resolves.not.toThrow()

    // Verify author was set
    const config = await git.listConfig()
    expect(config.all['user.name']).toBe('Bot User')
    expect(config.all['user.email']).toBe('bot@example.com')
  })

  it('throws error when trying to set author in non-managed repository', async () => {
    // Setup: create repo WITHOUT canopycms.managed marker
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()
    await git.addConfig('user.name', 'Regular User')
    await git.addConfig('user.email', 'user@example.com')

    // Create GitManager and try to ensure author - should fail
    const manager = new GitManager({ repoPath: tmpDir })
    await expect(
      manager.ensureAuthor({ name: 'Bot User', email: 'bot@example.com' }),
    ).rejects.toThrow(/Cannot set git bot author in non-managed repository/)

    // Verify author was NOT changed
    const config = await git.listConfig()
    expect(config.all['user.name']).toBe('Regular User')
    expect(config.all['user.email']).toBe('user@example.com')
  })

  it('provides helpful error message for non-managed repos', async () => {
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()

    const manager = new GitManager({ repoPath: tmpDir })
    await expect(manager.ensureAuthor({ name: 'Bot', email: 'bot@test.com' })).rejects.toThrow(
      /Bot identity should only be set in CanopyCMS branch clones/,
    )
    await expect(manager.ensureAuthor({ name: 'Bot', email: 'bot@test.com' })).rejects.toThrow(
      /If this is a test workspace, add "git config canopycms.managed true"/,
    )
  })

  it('only updates author if values differ', async () => {
    // Setup: managed repo with existing author
    await initTestRepo(tmpDir)

    const manager = new GitManager({ repoPath: tmpDir })
    // Spy on the manager's internal git instance
    const addConfigSpy = vi.spyOn(manager['git'], 'addConfig')

    // First call: should update (values differ from Test Bot / test@canopycms.test)
    await manager.ensureAuthor({ name: 'New Name', email: 'new@example.com' })
    expect(addConfigSpy).toHaveBeenCalledWith('user.name', 'New Name')
    expect(addConfigSpy).toHaveBeenCalledWith('user.email', 'new@example.com')

    addConfigSpy.mockClear()

    // Second call with same values: should NOT update
    await manager.ensureAuthor({ name: 'New Name', email: 'new@example.com' })
    expect(addConfigSpy).not.toHaveBeenCalled()
  })
})

describe('GitManager.ensureRemote', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-git-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('throws error when trying to modify remote in non-managed repository', async () => {
    // Setup: create repo WITHOUT canopycms.managed marker
    const git = simpleGit({ baseDir: tmpDir })
    await git.init()
    await git.addConfig('user.name', 'Test')
    await git.addConfig('user.email', 'test@test.com')

    const manager = new GitManager({ repoPath: tmpDir })
    await expect(manager.ensureRemote('https://example.com/repo.git')).rejects.toThrow(
      /Cannot modify remote in non-managed repository/,
    )

    // Verify no remote was added
    const remotes = await git.getRemotes()
    expect(remotes).toHaveLength(0)
  })

  it('allows modifying remote in managed repository', async () => {
    const git = await initTestRepo(tmpDir)

    const manager = new GitManager({ repoPath: tmpDir })
    await manager.ensureRemote('https://example.com/repo.git')

    const remotes = await git.getRemotes(true)
    const origin = remotes.find((r) => r.name === 'origin')
    expect(origin).toBeDefined()
    expect(origin!.refs.fetch).toBe('https://example.com/repo.git')
  })
})

describe('GitManager traversal protection', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-git-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('GIT_CEILING_DIRECTORIES prevents traversal to parent repo', async () => {
    // Setup: create a parent git repo
    const parentGit = simpleGit({ baseDir: tmpDir })
    await parentGit.init()
    await parentGit.addConfig('user.name', 'Parent')
    await parentGit.addConfig('user.email', 'parent@test.com')
    await fs.writeFile(path.join(tmpDir, 'parent.txt'), 'parent', 'utf8')
    await parentGit.add(['.'])
    await parentGit.commit('parent commit')

    // Create a child directory with a corrupt .git (empty directory)
    const childDir = path.join(tmpDir, 'child-workspace')
    await fs.mkdir(path.join(childDir, '.git'), { recursive: true })

    // GitManager should fail, NOT traverse to parent
    const manager = new GitManager({ repoPath: childDir })
    await expect(manager.status()).rejects.toThrow()

    // Verify parent repo was not touched
    const parentRemotes = await parentGit.getRemotes()
    expect(parentRemotes).toHaveLength(0)
  })

  it('initializeWorkspace cleans up corrupt .git and re-clones', async () => {
    // Setup: create a source repo to clone from
    const sourceDir = path.join(tmpDir, 'source')
    await fs.mkdir(sourceDir, { recursive: true })
    const sourceGit = await initTestRepo(sourceDir)
    await sourceGit.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(sourceDir, 'content.txt'), 'hello', 'utf8')
    await sourceGit.add(['.'])
    await sourceGit.commit('initial commit')

    // Create a bare remote from source
    const remotePath = path.join(tmpDir, 'remote.git')
    await simpleGit().raw(['clone', '--bare', sourceDir, remotePath])

    // Create workspace with corrupt .git
    const workspacePath = path.join(tmpDir, 'workspace')
    await fs.mkdir(path.join(workspacePath, '.git'), { recursive: true })

    // initializeWorkspace should recover by re-cloning
    const git = await GitManager.initializeWorkspace({
      workspacePath,
      branchName: 'main',
      mode: 'dev',
      baseBranch: 'main',
      remoteUrl: remotePath,
      branchType: 'content',
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'test@canopycms.test',
    })

    // Verify workspace was properly initialized
    const status = await git.status()
    expect(status.current).toBe('main')

    // Verify content was cloned
    const content = await fs.readFile(path.join(workspacePath, 'content.txt'), 'utf8')
    expect(content).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Conflict handling helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal two-repo conflict scenario:
 *   remote (bare) ← shared initial commit
 *   local clone   ← branch commit modifying `file.txt`
 *   second clone  ← diverging commit modifying `file.txt` → pushed to remote
 *
 * After setup, `localPath` has one unpushed commit that conflicts with the
 * remote's tip.  The local repo's `origin` points at the bare remote.
 */
async function setupMergeConflict(tmpDir: string): Promise<{
  localPath: string
  manager: GitManager
  conflictFile: string
}> {
  const remotePath = path.join(tmpDir, 'remote.git')
  const localPath = path.join(tmpDir, 'local')
  const otherPath = path.join(tmpDir, 'other')
  const conflictFile = 'shared.txt'

  // Bare remote
  await fs.mkdir(remotePath, { recursive: true })
  const bareGit = simpleGit({ baseDir: remotePath })
  await bareGit.init(true)

  // Initial commit from a temp clone
  const seedPath = path.join(tmpDir, 'seed')
  await fs.mkdir(seedPath, { recursive: true })
  const seedGit = await initTestRepo(seedPath)
  await seedGit.raw(['branch', '-M', 'main'])
  await fs.writeFile(path.join(seedPath, conflictFile), 'initial', 'utf8')
  await seedGit.add(['.'])
  await seedGit.commit('initial')
  await seedGit.addRemote('origin', remotePath)
  await seedGit.push('origin', 'main')

  // Local clone
  await simpleGit().clone(remotePath, localPath)
  const localRaw = simpleGit({ baseDir: localPath })
  await localRaw.addConfig('user.name', 'Test Bot')
  await localRaw.addConfig('user.email', 'test@canopycms.test')
  await localRaw.addConfig('canopycms.managed', 'true')

  // Local diverging commit (edit shared.txt)
  await fs.writeFile(path.join(localPath, conflictFile), 'local version', 'utf8')
  await localRaw.add(['.'])
  await localRaw.commit('local change')

  // Remote diverging commit via a second clone (edit shared.txt differently)
  await simpleGit().clone(remotePath, otherPath)
  const otherGit = simpleGit({ baseDir: otherPath })
  await otherGit.addConfig('user.name', 'Other Bot')
  await otherGit.addConfig('user.email', 'other@canopycms.test')
  await fs.writeFile(path.join(otherPath, conflictFile), 'remote version', 'utf8')
  await otherGit.add(['.'])
  await otherGit.commit('remote change')
  await otherGit.push('origin', 'main')

  const manager = new GitManager({ repoPath: localPath, baseBranch: 'main' })
  return { localPath, manager, conflictFile }
}

/**
 * Build a rebase conflict scenario:
 *   remote/main ← diverging commit modifying `shared.txt`
 *   local/feature ← commit modifying `shared.txt` on a feature branch
 *
 * After setup, `rebaseOntoBase()` will conflict on `shared.txt`.
 */
async function setupRebaseConflict(tmpDir: string): Promise<{
  localPath: string
  manager: GitManager
  conflictFile: string
}> {
  const remotePath = path.join(tmpDir, 'remote.git')
  const localPath = path.join(tmpDir, 'local')
  const otherPath = path.join(tmpDir, 'other')
  const conflictFile = 'shared.txt'

  // Bare remote
  await fs.mkdir(remotePath, { recursive: true })
  const bareGit = simpleGit({ baseDir: remotePath })
  await bareGit.init(true)

  // Seed remote with initial commit
  const seedPath = path.join(tmpDir, 'seed')
  await fs.mkdir(seedPath, { recursive: true })
  const seedGit = await initTestRepo(seedPath)
  await seedGit.raw(['branch', '-M', 'main'])
  await fs.writeFile(path.join(seedPath, conflictFile), 'initial', 'utf8')
  await seedGit.add(['.'])
  await seedGit.commit('initial')
  await seedGit.addRemote('origin', remotePath)
  await seedGit.push('origin', 'main')

  // Local clone — create feature branch, commit conflicting change
  await simpleGit().clone(remotePath, localPath)
  const localRaw = simpleGit({ baseDir: localPath })
  await localRaw.addConfig('user.name', 'Test Bot')
  await localRaw.addConfig('user.email', 'test@canopycms.test')
  await localRaw.addConfig('canopycms.managed', 'true')
  await localRaw.checkoutLocalBranch('feature')
  await fs.writeFile(path.join(localPath, conflictFile), 'feature version', 'utf8')
  await localRaw.add(['.'])
  await localRaw.commit('feature change')

  // Advance remote/main with a conflicting change via second clone
  await simpleGit().clone(remotePath, otherPath)
  const otherGit = simpleGit({ baseDir: otherPath })
  await otherGit.addConfig('user.name', 'Other Bot')
  await otherGit.addConfig('user.email', 'other@canopycms.test')
  await fs.writeFile(path.join(otherPath, conflictFile), 'main version', 'utf8')
  await otherGit.add(['.'])
  await otherGit.commit('main change')
  await otherGit.push('origin', 'main')

  const manager = new GitManager({ repoPath: localPath, baseBranch: 'main' })
  return { localPath, manager, conflictFile }
}

async function hasGitStateFile(repoPath: string, ...names: string[]): Promise<boolean> {
  for (const name of names) {
    try {
      await fs.stat(path.join(repoPath, '.git', name))
      return true
    } catch {
      // not found
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitManager conflict handling', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-conflict-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('pullBase', () => {
    it('throws GitConflictError when remote/base diverges with local changes', async () => {
      const { manager } = await setupMergeConflict(tmpDir)

      await expect(manager.pullBase()).rejects.toThrow(GitConflictError)
    })

    it('includes conflicting file paths in the error', async () => {
      const { manager, conflictFile } = await setupMergeConflict(tmpDir)

      const err = await manager.pullBase().catch((e) => e)
      expect(err).toBeInstanceOf(GitConflictError)
      expect((err as GitConflictError).conflictedFiles).toContain(conflictFile)
    })

    it('leaves no MERGE_HEAD after conflict (workspace is clean)', async () => {
      const { localPath, manager } = await setupMergeConflict(tmpDir)

      await manager.pullBase().catch(() => {})

      expect(await hasGitStateFile(localPath, 'MERGE_HEAD')).toBe(false)
    })
  })

  describe('pullCurrentBranch', () => {
    it('throws GitConflictError when remote branch diverges with local changes', async () => {
      const { localPath, manager } = await setupMergeConflict(tmpDir)
      // Force-push local commit so remote tracks local's diverged state, then
      // create further local divergence before pushing a conflicting remote commit
      const localRaw = simpleGit({ baseDir: localPath })
      await localRaw.push('origin', 'main', ['--force'])
      // Now add another local commit diverging from remote
      await fs.writeFile(path.join(localPath, 'extra.txt'), 'local extra', 'utf8')
      await localRaw.add(['.'])
      await localRaw.commit('extra local')

      // Push a conflicting commit to remote/main via another clone
      const other2 = path.join(tmpDir, 'other2')
      await simpleGit().clone(path.join(tmpDir, 'remote.git'), other2)
      const other2Git = simpleGit({ baseDir: other2 })
      await other2Git.addConfig('user.name', 'Bot')
      await other2Git.addConfig('user.email', 'bot@test.com')
      await fs.writeFile(path.join(other2, 'extra.txt'), 'remote extra', 'utf8')
      await other2Git.add(['.'])
      await other2Git.commit('extra remote')
      await other2Git.push('origin', 'main')

      await expect(manager.pullCurrentBranch()).rejects.toThrow(GitConflictError)
    })

    it('leaves no MERGE_HEAD after conflict (workspace is clean)', async () => {
      const { localPath, manager } = await setupMergeConflict(tmpDir)
      const localRaw = simpleGit({ baseDir: localPath })
      // Force-push local commit so remote tracks local's diverged state
      await localRaw.push('origin', 'main', ['--force'])
      await fs.writeFile(path.join(localPath, 'extra.txt'), 'local extra', 'utf8')
      await localRaw.add(['.'])
      await localRaw.commit('extra local')

      const other2 = path.join(tmpDir, 'other2')
      await simpleGit().clone(path.join(tmpDir, 'remote.git'), other2)
      const other2Git = simpleGit({ baseDir: other2 })
      await other2Git.addConfig('user.name', 'Bot')
      await other2Git.addConfig('user.email', 'bot@test.com')
      await fs.writeFile(path.join(other2, 'extra.txt'), 'remote extra', 'utf8')
      await other2Git.add(['.'])
      await other2Git.commit('extra remote')
      await other2Git.push('origin', 'main')

      await manager.pullCurrentBranch().catch(() => {})

      expect(await hasGitStateFile(localPath, 'MERGE_HEAD')).toBe(false)
    })
  })

  describe('rebaseOntoBase', () => {
    it('throws GitConflictError when feature branch conflicts with base', async () => {
      const { manager } = await setupRebaseConflict(tmpDir)

      await expect(manager.rebaseOntoBase()).rejects.toThrow(GitConflictError)
    })

    it('includes conflicting file paths in the error', async () => {
      const { manager, conflictFile } = await setupRebaseConflict(tmpDir)

      const err = await manager.rebaseOntoBase().catch((e) => e)
      expect(err).toBeInstanceOf(GitConflictError)
      expect((err as GitConflictError).conflictedFiles).toContain(conflictFile)
    })

    it('leaves no REBASE_MERGE or rebase-merge dir after conflict (workspace is clean)', async () => {
      const { localPath, manager } = await setupRebaseConflict(tmpDir)

      await manager.rebaseOntoBase().catch(() => {})

      expect(await hasGitStateFile(localPath, 'REBASE_MERGE', 'rebase-merge')).toBe(false)
    })
  })
}, 30_000)
