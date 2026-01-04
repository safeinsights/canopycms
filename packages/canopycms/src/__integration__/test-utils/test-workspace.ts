import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { vi } from 'vitest'
import type { CanopyConfig } from '../../config'
import { defineCanopyTestConfig } from '../../config-test'

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

  try {
    // Initialize bare remote
    await simpleGit().raw(['init', '--bare', remotePath])

    // Create and configure seed clone
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = simpleGit({ baseDir: seedPath })
    await seedGit.init()
    await seedGit.addConfig('user.name', 'Test Bot')
    await seedGit.addConfig('user.email', 'test@canopycms.local')
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
      mode: 'local-prod-sim',
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      defaultBaseBranch: 'main',
      defaultRemoteName: 'origin',
      defaultRemoteUrl: remotePath,
      schema: [],
      ...configOverrides,
    })

    // Mock process.cwd() to return tmpRoot so BranchRegistry uses isolated path
    // This prevents parallel tests from corrupting shared registry files
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot)

    return {
      tmpRoot,
      remotePath,
      seedPath,
      config,
      cleanup: async () => {
        warnSpy.mockRestore()
        cwdSpy.mockRestore()
        await fs.rm(tmpRoot, { recursive: true, force: true })
      },
    }
  } catch (error) {
    // Cleanup on error
    warnSpy.mockRestore()
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
