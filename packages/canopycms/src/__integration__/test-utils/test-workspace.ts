import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { vi } from 'vitest'
import type { InternalGroup } from '../../authorization'
import type { CanopyConfig } from '../../config'
import { defineCanopyTestConfig } from '../../config-test'
import { initTestRepo } from '../../test-utils'
import { operatingStrategy } from '../../operating-mode'
import { SettingsWorkspaceManager } from '../../settings-workspace'

/**
 * Initialize a bare git repository with the specified default branch.
 * This ensures the bare repo's HEAD points to the correct branch when cloning.
 *
 * @param remotePath - Path where the bare repository should be created
 * @param defaultBranch - The default branch name (defaults to 'main')
 * @returns A simpleGit instance configured for the bare repository
 */
export async function initBareRepo(remotePath: string, defaultBranch = 'main') {
  await simpleGit().raw(['init', '--bare', `--initial-branch=${defaultBranch}`, remotePath])
  return simpleGit({ baseDir: remotePath })
}

export interface TestWorkspaceOptions {
  /**
   * Internal groups to seed into groups.json on the settings workspace (the
   * orphan `canopycms-settings-{deploymentName}` branch) — the same
   * location `getSettingsBranchRoot()`/`resolveCanopyUser` read at runtime,
   * mirroring `authorization/content.ts`'s `createContentAccessChecker`.
   *
   * Previously this seeded groups.json onto the main branch content clone
   * instead, which happened to match a bug in the (now-fixed) read path in
   * `http/handler.ts` / `canopycms-next`'s `context-wrapper.ts` — nothing in
   * the product ever wrote groups.json there, so seeding it there encoded
   * the bug into every test that used this option instead of catching it.
   *
   * Reserved group IDs (Admins/Reviewers) supplied by an auth provider are
   * stripped for security (SEC-H1), so tests that need a privileged persona
   * must grant membership through internal groups (or bootstrap admin IDs).
   */
  internalGroups?: InternalGroup[]
}

/**
 * Seed groups.json onto the settings workspace's orphan settings branch,
 * exactly as a real admin write would end up (provision workspace -> write
 * file -> commit -> push), so it's visible to any later
 * `getSettingsBranchRoot()` call against the same config (`config.defaultRemoteUrl`
 * is what ties the settings workspace back to the shared bare remote).
 */
async function seedInternalGroups(config: CanopyConfig, groups: InternalGroup[]): Promise<void> {
  const strategy = operatingStrategy(config.mode)
  const branchName = strategy.getSettingsBranchName(config)
  const settingsRoot = strategy.getSettingsRoot()

  // Same provisioning path production code uses (services.ts's
  // getSettingsBranchRoot) — creates/checks out the orphan settings branch
  // at `settingsRoot`, reusable by any later call against the same path.
  await new SettingsWorkspaceManager(config).ensureGitWorkspace({
    settingsRoot,
    branchName,
    mode: config.mode,
    remoteUrl: config.defaultRemoteUrl,
  })

  const groupsFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: 'test-setup',
    groups,
  }
  await fs.writeFile(
    path.join(settingsRoot, 'groups.json'),
    JSON.stringify(groupsFile, null, 2),
    'utf8',
  )

  const git = simpleGit({ baseDir: settingsRoot })
  await git.add('groups.json')
  await git.commit('Seed internal groups for tests')
  await git.push('origin', branchName, { '--set-upstream': null })
}

export interface TestWorkspace {
  /** Root temporary directory for this workspace */
  tmpRoot: string
  /** Path to bare git remote */
  remotePath: string
  /** Path to seed clone (initial commit) */
  seedPath: string
  /** Full Canopy configuration */
  config: CanopyConfig
  /** Cleanup function to remove all temp files and restore cwd mock */
  cleanup: () => Promise<void>
}

/**
 * Creates an isolated test environment with temp directory and bare git remote.
 *
 * Directory structure created:
 * ```
 * tmpRoot/
 *   ├── remote.git/       (bare git remote)
 *   ├── seed/             (initial clone with content/)
 *   └── branches/         (workspace clones will be created here)
 * ```
 *
 * Based on the pattern from branch-workflow.integration.test.ts
 */
// Warnings to suppress in integration tests (expected when using local git repos)
const suppressedWarnings: (string | RegExp)[] = [
  'CanopyCMS: GitHub token not found',
  'CanopyCMS: Failed to parse GitHub remote URL',
  'CanopyCMS: GitHub service requires remoteUrl',
]

export async function createTestWorkspace(
  configOverrides?: Partial<Parameters<typeof defineCanopyTestConfig>[0]>,
  options?: TestWorkspaceOptions,
): Promise<TestWorkspace> {
  // Suppress known CanopyCMS warnings that are expected in integration tests
  const originalWarn = console.warn
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    const message = String(args[0] ?? '')
    const shouldSuppress = suppressedWarnings.some((pattern) =>
      typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message),
    )
    if (!shouldSuppress) {
      originalWarn.apply(console, args)
    }
  })

  // Create root temp directory
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
  const remotePath = path.join(tmpRoot, 'remote.git')
  const seedPath = path.join(tmpRoot, 'seed')

  // Declared here (not inside the try block) so the catch handler below can
  // restore it if something throws after it's installed — e.g. a failure
  // seeding internal groups, which runs after this mock is set up.
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined

  try {
    // Initialize bare remote
    await initBareRepo(remotePath)

    // Create and configure seed clone
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await seedGit.raw(['branch', '-M', 'main'])

    // Create initial content directory
    await fs.mkdir(path.join(seedPath, 'content'), { recursive: true })

    // Create initial commit with README
    await fs.writeFile(path.join(seedPath, 'README.md'), '# Test Repository\n', 'utf8')

    await seedGit.add(['.'])
    await seedGit.commit('Initial commit')

    // Push to remote
    await seedGit.addRemote('origin', remotePath)
    await seedGit.push('origin', 'main', { '--set-upstream': null })

    // Create config
    const config = defineCanopyTestConfig({
      mode: 'dev',
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      defaultBaseBranch: 'main',
      defaultRemoteName: 'origin',
      defaultRemoteUrl: remotePath,
      schema: { collections: [] },
      ...configOverrides,
    })

    // Mock process.cwd() to return tmpRoot so BranchRegistry uses isolated path
    // This prevents parallel tests from corrupting shared registry files
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot)

    // Seed internal groups (groups.json) on the settings workspace so
    // privileged personas get their reserved-group membership from a
    // Canopy-managed source (SEC-H1). Must run after the cwd mock above:
    // getSettingsRoot() resolves relative to process.cwd().
    if (options?.internalGroups) {
      await seedInternalGroups(config, options.internalGroups)
    }

    return {
      tmpRoot,
      remotePath,
      seedPath,
      config,
      cleanup: async () => {
        warnSpy.mockRestore()
        cwdSpy?.mockRestore()
        await fs.rm(tmpRoot, { recursive: true, force: true })
      },
    }
  } catch (error) {
    // Cleanup on error
    warnSpy.mockRestore()
    cwdSpy?.mockRestore()
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
