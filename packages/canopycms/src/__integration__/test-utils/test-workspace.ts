import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
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
  /** Cleanup function to remove all temp files */
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
export async function createTestWorkspace(
  configOverrides?: Partial<Parameters<typeof defineCanopyTestConfig>[0]>,
): Promise<TestWorkspace> {
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

    return {
      tmpRoot,
      remotePath,
      seedPath,
      config,
      cleanup: async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true })
      },
    }
  } catch (error) {
    // Cleanup on error
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
