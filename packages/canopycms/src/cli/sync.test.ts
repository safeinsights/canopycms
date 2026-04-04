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
 *   .git/                  <- source repo
 *   content/
 *     index.md
 *     about.md
 *   .canopy-dev/
 *     remote.git/          <- bare remote seeded from source
 *     content-branches/
 *       test-branch/       <- branch workspace cloned from remote
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
  let consoleMock: ReturnType<typeof mockConsole>

  beforeEach(() => {
    consoleMock = mockConsole()
  })

  afterEach(async () => {
    consoleMock.restore()
    if (projectDir) {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  describe('push', () => {
    it('pushes working-tree content to branch workspace and commits', async () => {
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
        branch: 'test-branch',
        force: true,
      })

      expect(result.pushed).toBe(1)

      // Verify the workspace was updated
      const content = await fs.readFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        'utf-8',
      )
      expect(content).toBe('# Hello\n\nUpdated content!\n')

      // Verify it was committed in the workspace
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      const log = await branchGit.log()
      expect(log.latest?.message).toContain('sync: update content from working tree')
    })

    it('auto-selects sole branch workspace', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await fs.writeFile(path.join(projectDir, 'content', 'index.md'), '# Hello\n\nUpdated!\n')

      // Don't pass --branch; should auto-select the only branch
      const result = await sync({
        projectDir,
        direction: 'push',
        force: true,
      })

      expect(result.pushed).toBe(1)
    })

    it('reports no changes when content is already up to date', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      const result = await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      expect(result.pushed).toBe(0)
    })

    it('reports no changes when content directory does not exist', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await fs.rm(path.join(projectDir, 'content'), { recursive: true, force: true })

      const result = await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      expect(result.pushed).toBe(0)
    })

    it('auto-commits uncommitted editor changes before push', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Simulate an editor save (uncommitted file in workspace)
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEditor edit.\n',
      )

      // Make a working-tree change
      await fs.writeFile(
        path.join(projectDir, 'content', 'index.md'),
        '# Hello\n\nDeveloper edit.\n',
      )

      const result = await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      expect(result.pushed).toBe(1)

      // Verify editor changes were committed to history
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      const log = await branchGit.log()
      const messages = log.all.map((c) => c.message)
      expect(messages).toContain('sync: save editor state before push')
      expect(messages).toContain('sync: update content from working tree')

      // Verify workspace now has the developer's content
      const content = await fs.readFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        'utf-8',
      )
      expect(content).toBe('# Hello\n\nDeveloper edit.\n')
    })

    it('warns about uncommitted workspace changes and cancels when user declines', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Simulate an editor save (uncommitted file in workspace)
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEditor edit.\n',
      )

      // Make a working-tree change
      await fs.writeFile(
        path.join(projectDir, 'content', 'index.md'),
        '# Hello\n\nDeveloper edit.\n',
      )

      // confirm mock returns false by default — user declines
      const result = await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
      })

      expect(result.pushed).toBe(0)

      // Workspace should still have editor edit (not overwritten)
      const content = await fs.readFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        'utf-8',
      )
      expect(content).toBe('# Hello\n\nEditor edit.\n')
    })

    it('refuses push when workspace has merge conflicts', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir
      const pMock = await import('@clack/prompts')

      // Create a merge conflict in the workspace
      const branchGit = simpleGit({ baseDir: workspace.branchPath })

      // Make a change on test-branch and commit
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nBranch A change.\n',
      )
      await branchGit.add('-A')
      await branchGit.commit('branch change')

      // Create another branch with a conflicting change
      await branchGit.checkoutLocalBranch('conflict-branch')
      await branchGit.raw(['reset', '--hard', 'HEAD~1'])
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nBranch B change.\n',
      )
      await branchGit.add('-A')
      await branchGit.commit('conflicting change')

      // Try to merge — this will create conflicts
      await branchGit.checkout('test-branch')
      try {
        await branchGit.merge(['conflict-branch'])
      } catch {
        // Expected merge conflict
      }

      const result = await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      expect(result.pushed).toBe(0)
      expect(pMock.log.error).toHaveBeenCalledWith(
        expect.stringContaining('unresolved merge conflicts'),
      )
    })

    it('creates canopycms-sync-base tag after push', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await fs.writeFile(path.join(projectDir, 'content', 'index.md'), '# Hello\n\nUpdated!\n')

      await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      // Verify tag exists
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      const tagResult = await branchGit.raw(['rev-parse', 'canopycms-sync-base'])
      expect(tagResult.trim()).toBeTruthy()

      // Tag should point to HEAD
      const head = await branchGit.revparse(['HEAD'])
      expect(tagResult.trim()).toBe(head.trim())
    })

    it('rejects --content-root that escapes the project directory on push', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await expect(
        sync({
          projectDir,
          direction: 'push',
          branch: 'test-branch',
          contentRoot: '../../etc',
          force: true,
        }),
      ).rejects.toThrow('escapes the expected directory')
    })

    it('rejects --branch that escapes the branches directory', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await expect(
        sync({
          projectDir,
          direction: 'push',
          branch: '../../.git',
          force: true,
        }),
      ).rejects.toThrow('escapes the expected directory')
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
      const pMock = await import('@clack/prompts')

      const result = await sync({
        projectDir,
        direction: 'pull',
        branch: 'nonexistent-branch',
      })

      expect(result.pulled).toBe(0)
      expect(pMock.log.error).toHaveBeenCalledWith(expect.stringContaining('nonexistent-branch'))
    })

    it('reports error when no branch workspaces exist', async () => {
      projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sync-test-'))
      const pMock = await import('@clack/prompts')

      const result = await sync({
        projectDir,
        direction: 'pull',
      })

      expect(result.pulled).toBe(0)
      expect(pMock.log.error).toHaveBeenCalledWith(
        expect.stringContaining('No branch workspaces found'),
      )
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

    it('rejects --branch that escapes the branches directory', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await expect(
        sync({
          projectDir,
          direction: 'pull',
          branch: '../../.git',
          force: true,
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

  describe('both (merge)', () => {
    it('merges working-tree and editor changes when they edit different files', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Set up sync base: push initial content to establish the tag
      await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      // Developer changes about.md in working tree
      await fs.writeFile(
        path.join(projectDir, 'content', 'about.md'),
        '# About\n\nDeveloper updated about.\n',
      )

      // Editor changes index.md in workspace (committed)
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEditor updated index.\n',
      )
      await branchGit.add('-A')
      await branchGit.commit('editor: update index')

      const result = await sync({
        projectDir,
        direction: 'both',
        branch: 'test-branch',
        force: true,
      })

      // Both sides should have changes
      expect(result.pushed).toBeGreaterThan(0)
      expect(result.pulled).toBeGreaterThan(0)

      // Working tree should have both changes
      const index = await fs.readFile(path.join(projectDir, 'content', 'index.md'), 'utf-8')
      expect(index).toBe('# Hello\n\nEditor updated index.\n')
      const about = await fs.readFile(path.join(projectDir, 'content', 'about.md'), 'utf-8')
      expect(about).toBe('# About\n\nDeveloper updated about.\n')

      // Workspace should also have both changes
      const wsIndex = await fs.readFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        'utf-8',
      )
      expect(wsIndex).toBe('# Hello\n\nEditor updated index.\n')
      const wsAbout = await fs.readFile(
        path.join(workspace.branchPath, 'content', 'about.md'),
        'utf-8',
      )
      expect(wsAbout).toBe('# About\n\nDeveloper updated about.\n')
    })

    it('detects merge conflicts and leaves workspace in merge state', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir
      const pMock = await import('@clack/prompts')

      // Set up sync base
      await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      // Developer changes index.md
      await fs.writeFile(
        path.join(projectDir, 'content', 'index.md'),
        '# Hello\n\nDeveloper version.\n',
      )

      // Editor also changes index.md (conflict!)
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEditor version.\n',
      )
      await branchGit.add('-A')
      await branchGit.commit('editor: conflicting change')

      const result = await sync({
        projectDir,
        direction: 'both',
        branch: 'test-branch',
        force: true,
      })

      expect(result.pushed).toBe(0)
      expect(result.pulled).toBe(0)
      expect(pMock.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Merge conflicts detected'),
      )

      // Workspace should be in merge state
      const status = await branchGit.status()
      expect(status.conflicted.length).toBeGreaterThan(0)
    })

    it('handles first-time sync (no tag) by using HEAD as base', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Don't push first — no canopycms-sync-base tag exists
      // Developer adds a new file
      await fs.writeFile(path.join(projectDir, 'content', 'new-page.md'), '# New\n\nNew page.\n')

      const result = await sync({
        projectDir,
        direction: 'both',
        branch: 'test-branch',
        force: true,
      })

      // Should have pushed the new file
      expect(result.pushed).toBeGreaterThan(0)
      expect(result.pulled).toBeGreaterThan(0)

      // Working tree should have the new file
      const content = await fs.readFile(path.join(projectDir, 'content', 'new-page.md'), 'utf-8')
      expect(content).toBe('# New\n\nNew page.\n')
    })

    it('pulls only when working tree has no changes', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Set up sync base
      await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      // Only the editor makes changes (no working tree changes)
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEditor only change.\n',
      )
      await branchGit.add('-A')
      await branchGit.commit('editor change')

      const result = await sync({
        projectDir,
        direction: 'both',
        branch: 'test-branch',
        force: true,
      })

      // No push (working tree unchanged), but pull should get editor changes
      expect(result.pushed).toBe(0)
      expect(result.pulled).toBeGreaterThan(0)

      const content = await fs.readFile(path.join(projectDir, 'content', 'index.md'), 'utf-8')
      expect(content).toBe('# Hello\n\nEditor only change.\n')
    })

    it('updates sync-base tag after successful merge', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Set up sync base
      await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      const tagBefore = (await branchGit.raw(['rev-parse', 'canopycms-sync-base'])).trim()

      // Make changes on both sides
      await fs.writeFile(path.join(projectDir, 'content', 'about.md'), '# About\n\nDev change.\n')
      const wsGit = simpleGit({ baseDir: workspace.branchPath })
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEditor change.\n',
      )
      await wsGit.add('-A')
      await wsGit.commit('editor change')

      await sync({
        projectDir,
        direction: 'both',
        branch: 'test-branch',
        force: true,
      })

      const tagAfter = (await branchGit.raw(['rev-parse', 'canopycms-sync-base'])).trim()
      expect(tagAfter).not.toBe(tagBefore)

      // Tag should point to HEAD (the merge commit)
      const head = (await branchGit.revparse(['HEAD'])).trim()
      expect(tagAfter).toBe(head)
    })
  })

  describe('abort', () => {
    it('aborts a merge and restores workspace to pre-merge state', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      // Set up sync base
      await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
        force: true,
      })

      // Create a merge conflict via syncBoth
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nEditor version.\n',
      )
      await branchGit.add('-A')
      await branchGit.commit('editor: conflicting change')

      await fs.writeFile(
        path.join(projectDir, 'content', 'index.md'),
        '# Hello\n\nDeveloper version.\n',
      )

      // This should leave workspace in merge state
      await sync({
        projectDir,
        direction: 'both',
        branch: 'test-branch',
        force: true,
      })

      // Verify workspace is in merge state
      let status = await branchGit.status()
      expect(status.conflicted.length).toBeGreaterThan(0)

      // Abort the merge
      await sync({
        projectDir,
        direction: 'abort',
        branch: 'test-branch',
      })

      // Workspace should be clean (no conflicts)
      status = await branchGit.status()
      expect(status.conflicted.length).toBe(0)

      // Content should be restored to pre-merge (editor's version)
      const content = await fs.readFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        'utf-8',
      )
      expect(content).toBe('# Hello\n\nEditor version.\n')
    })

    it('reports no-op when workspace is not in a merge state', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir
      const pMock = await import('@clack/prompts')

      await sync({
        projectDir,
        direction: 'abort',
        branch: 'test-branch',
      })

      expect(pMock.log.info).toHaveBeenCalledWith(expect.stringContaining('not in a merge state'))
    })

    it('rejects --branch that escapes the branches directory', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir

      await expect(
        sync({
          projectDir,
          direction: 'abort',
          branch: '../../.git',
        }),
      ).rejects.toThrow('escapes the expected directory')
    })

    it('offers interactive abort when push encounters merge conflicts', async () => {
      const workspace = await setupTestWorkspace()
      projectDir = workspace.projectDir
      const pMock = await import('@clack/prompts')

      // Create a merge conflict in the workspace manually
      const branchGit = simpleGit({ baseDir: workspace.branchPath })
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nBranch A.\n',
      )
      await branchGit.add('-A')
      await branchGit.commit('branch change')

      await branchGit.checkoutLocalBranch('conflict-branch')
      await branchGit.raw(['reset', '--hard', 'HEAD~1'])
      await fs.writeFile(
        path.join(workspace.branchPath, 'content', 'index.md'),
        '# Hello\n\nBranch B.\n',
      )
      await branchGit.add('-A')
      await branchGit.commit('conflicting change')

      await branchGit.checkout('test-branch')
      try {
        await branchGit.merge(['conflict-branch'])
      } catch {
        // Expected merge conflict
      }

      // Mock confirm to accept abort
      vi.mocked(pMock.confirm).mockResolvedValueOnce(true)

      await sync({
        projectDir,
        direction: 'push',
        branch: 'test-branch',
      })

      // Workspace should be clean after interactive abort
      const status = await branchGit.status()
      expect(status.conflicted.length).toBe(0)
      expect(pMock.log.success).toHaveBeenCalledWith(expect.stringContaining('Merge aborted'))
    })
  })
})
