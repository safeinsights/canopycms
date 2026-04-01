import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { simpleGit } from 'simple-git'
import { sync } from './sync'
import { mockConsole } from '../test-utils/console-spy'

// Mock @clack/prompts to avoid interactive prompts in tests
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: {
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
  confirm: vi.fn().mockResolvedValue(false),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}))

/**
 * Set up a test environment simulating the dev mode workspace:
 *
 * projectDir/
 *   .git/                  ← source repo
 *   content/
 *     index.md
 *   .canopy-dev/
 *     remote.git/          ← bare remote seeded from source
 *     content-branches/
 *       test-branch/       ← branch workspace cloned from remote
 */
async function setupTestWorkspace(): Promise<{
  projectDir: string
  remotePath: string
  branchPath: string
}> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sync-test-'))

  // Initialize source repo
  const sourceGit = simpleGit({ baseDir: projectDir })
  await sourceGit.init(['--initial-branch=main'])
  await sourceGit.addConfig('user.name', 'Test User')
  await sourceGit.addConfig('user.email', 'test@test.com')

  // Create initial content
  const contentDir = path.join(projectDir, 'content')
  await fs.mkdir(contentDir, { recursive: true })
  await fs.writeFile(path.join(contentDir, 'index.md'), '# Hello\n\nOriginal content.\n')
  await fs.writeFile(path.join(contentDir, 'about.md'), '# About\n\nAbout page.\n')

  await sourceGit.add('-A')
  await sourceGit.commit('Initial commit')

  // Create bare remote
  const remotePath = path.join(projectDir, '.canopy-dev', 'remote.git')
  await fs.mkdir(path.dirname(remotePath), { recursive: true })
  await simpleGit().raw(['init', '--bare', '--initial-branch=main', remotePath])

  // Push source to bare remote
  const tempRemote = '__test_init__'
  await sourceGit.addRemote(tempRemote, remotePath)
  await sourceGit.push(tempRemote, 'main:main')
  await sourceGit.removeRemote(tempRemote)

  // Create a branch workspace by cloning from the bare remote
  const branchesDir = path.join(projectDir, '.canopy-dev', 'content-branches')
  const branchPath = path.join(branchesDir, 'test-branch')
  await simpleGit().clone(remotePath, branchPath, ['--branch', 'main', '--single-branch'])

  // Configure the branch workspace
  const branchGit = simpleGit({ baseDir: branchPath })
  await branchGit.addConfig('user.name', 'CMS Bot')
  await branchGit.addConfig('user.email', 'bot@canopycms.local')
  await branchGit.checkoutLocalBranch('test-branch')

  return { projectDir, remotePath, branchPath }
}

describe('canopycms sync', () => {
  let projectDir: string

  beforeEach(() => {
    mockConsole()
  })

  afterEach(async () => {
    if (projectDir) {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  describe('push', () => {
    it('pushes working-tree content changes to the local remote', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Make an uncommitted content change in the source repo
      await fs.writeFile(
        path.join(projectDir, 'content', 'index.md'),
        '# Hello\n\nUpdated content!\n',
      )

      const result = await sync({
        projectDir,
        direction: 'push',
      })

      expect(result.pushed).toBe(1)

      // Verify the remote was updated: clone it and check the content
      const verifyDir = path.join(projectDir, '.canopy-dev', '.verify-tmp')
      await simpleGit().clone(workspace.remotePath, verifyDir, ['--branch', 'main'])
      const content = await fs.readFile(path.join(verifyDir, 'content', 'index.md'), 'utf-8')
      expect(content).toBe('# Hello\n\nUpdated content!\n')
      await fs.rm(verifyDir, { recursive: true, force: true })
    })

    it('reports no changes when content is already up to date', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      const result = await sync({
        projectDir,
        direction: 'push',
      })

      expect(result.pushed).toBe(0)
    })

    it('fetches in existing branch workspaces after push', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Make a content change
      await fs.writeFile(
        path.join(projectDir, 'content', 'new-page.md'),
        '# New Page\n\nNew content.\n',
      )

      await sync({ projectDir, direction: 'push' })

      // The branch workspace should have fetched the updated remote
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      const log = await branchGit.log(['origin/main'])
      // The latest remote commit should mention sync
      expect(log.latest?.message).toContain('sync')
    })

    it('auto-initializes remote when .canopy-dev does not exist', async () => {
      // Create a minimal git repo with content but no .canopy-dev
      projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sync-test-'))
      const git = simpleGit({ baseDir: projectDir })
      await git.init(['--initial-branch=main'])
      await git.addConfig('user.name', 'Test')
      await git.addConfig('user.email', 'test@test.com')
      await fs.mkdir(path.join(projectDir, 'content'), { recursive: true })
      await fs.writeFile(path.join(projectDir, 'content', 'index.md'), '# Hello\n')
      await git.add('-A')
      await git.commit('initial')

      const result = await sync({
        projectDir,
        direction: 'push',
      })

      // Should auto-init and report no changes (remote was just seeded from same content)
      expect(result.pushed).toBe(0)
      // Remote should now exist
      const remoteStat = await fs.stat(path.join(projectDir, '.canopy-dev', 'remote.git'))
      expect(remoteStat.isDirectory()).toBe(true)
    })

    it('handles branch mismatch when developer switched git branches', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Remote was seeded from 'main'. Create a new branch in the source repo.
      const sourceGit = simpleGit({ baseDir: projectDir })
      await sourceGit.checkoutLocalBranch('feat-bar')

      // Make a content change on the new branch
      await fs.writeFile(
        path.join(projectDir, 'content', 'index.md'),
        '# Hello\n\nFrom feat-bar.\n',
      )

      const result = await sync({
        projectDir,
        direction: 'push',
      })

      // Should create feat-bar in the remote and push content
      expect(result.pushed).toBeGreaterThan(0)

      // Verify feat-bar exists in the remote by cloning it
      const verifyDir = path.join(projectDir, '.canopy-dev', '.verify-tmp')
      await simpleGit().clone(workspace.remotePath, verifyDir, ['--branch', 'feat-bar'])
      const content = await fs.readFile(path.join(verifyDir, 'content', 'index.md'), 'utf-8')
      expect(content).toBe('# Hello\n\nFrom feat-bar.\n')
      await fs.rm(verifyDir, { recursive: true, force: true })
    })
  })

  describe('pull', () => {
    it('pulls published content from a branch workspace to working tree', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Simulate a CMS edit: modify content in the branch workspace
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEdited in CMS.\n',
      )

      const result = await sync({
        projectDir,
        direction: 'pull',
        branch: 'test-branch',
        force: true,
      })

      expect(result.pulled).toBeGreaterThan(0)

      // Verify content was copied to working tree
      const content = await fs.readFile(path.join(projectDir, 'content', 'index.md'), 'utf-8')
      expect(content).toBe('# Hello\n\nEdited in CMS.\n')
    })

    it('uses the sole branch when only one exists', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Modify content in the only branch workspace
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'about.md'),
        '# About\n\nUpdated about.\n',
      )

      // Don't pass --branch; should auto-select the only branch
      const result = await sync({
        projectDir,
        direction: 'pull',
        force: true,
      })

      expect(result.pulled).toBeGreaterThan(0)
      const content = await fs.readFile(path.join(projectDir, 'content', 'about.md'), 'utf-8')
      expect(content).toBe('# About\n\nUpdated about.\n')
    })

    it('aborts when there are uncommitted content changes and user declines', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Make an uncommitted change in the working tree
      await fs.writeFile(
        path.join(projectDir, 'content', 'index.md'),
        '# Hello\n\nLocal uncommitted edit.\n',
      )

      // Simulate a CMS edit in the branch workspace
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEdited in CMS.\n',
      )

      // confirm mock returns false by default — user declines
      const result = await sync({
        projectDir,
        direction: 'pull',
        branch: 'test-branch',
      })

      expect(result.pulled).toBe(0)

      // Working tree should still have the local edit
      const content = await fs.readFile(path.join(projectDir, 'content', 'index.md'), 'utf-8')
      expect(content).toBe('# Hello\n\nLocal uncommitted edit.\n')
    })

    it('reports error when branch workspace does not exist', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      const result = await sync({
        projectDir,
        direction: 'pull',
        branch: 'nonexistent-branch',
      })

      expect(result.pulled).toBe(0)
    })

    it('reports error when no branch workspaces exist', async () => {
      projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sync-test-'))

      const result = await sync({
        projectDir,
        direction: 'pull',
      })

      expect(result.pulled).toBe(0)
    })

    it('rejects --content-root that escapes the project directory', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await expect(
        sync({
          projectDir,
          direction: 'pull',
          branch: 'test-branch',
          contentRoot: '../../etc',
          force: true,
        }),
      ).rejects.toThrow('escapes the expected directory')
    })

    it('rejects --content-root that escapes the project directory on push', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await expect(
        sync({
          projectDir,
          direction: 'push',
          contentRoot: '../../etc',
        }),
      ).rejects.toThrow('escapes the expected directory')
    })

    it('replaces entire content directory (files absent in branch are deleted)', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Branch workspace has index.md but NOT about.md
      await fs.rm(path.join(workspace.branchPath, 'content', 'about.md'))

      const result = await sync({
        projectDir,
        direction: 'pull',
        branch: 'test-branch',
        force: true,
      })

      expect(result.pulled).toBeGreaterThan(0)

      // about.md should be gone from the working tree
      const aboutExists = await fs
        .stat(path.join(projectDir, 'content', 'about.md'))
        .then(() => true)
        .catch(() => false)
      expect(aboutExists).toBe(false)

      // index.md should still be there
      const indexExists = await fs
        .stat(path.join(projectDir, 'content', 'index.md'))
        .then(() => true)
        .catch(() => false)
      expect(indexExists).toBe(true)
    })
  })

  describe('both directions', () => {
    it('runs push then pull in sequence', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Make a working-tree change (for push)
      await fs.writeFile(path.join(projectDir, 'content', 'new-page.md'), '# New\n\nNew content.\n')

      // Also simulate a CMS edit in the branch workspace (for pull)
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEdited in CMS.\n',
      )

      const result = await sync({
        projectDir,
        direction: 'both',
        branch: 'test-branch',
        force: true,
      })

      // Push should have synced the new file
      expect(result.pushed).toBeGreaterThan(0)
      // Pull should have brought the CMS edit back
      expect(result.pulled).toBeGreaterThan(0)
    })
  })
})
