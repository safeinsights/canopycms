import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startDevContentWatcher } from './dev-content-watcher'
import type { CanopyServices } from './services'
import type { CanopyConfig } from './config'

/**
 * Builds a minimal CanopyServices stub. startDevContentWatcher only reads
 * services.config (mode, sourceRoot, contentRoot, defaultActiveBranch,
 * defaultBaseBranch), so nothing else needs to be real.
 */
const makeServices = (config: Partial<CanopyConfig>): CanopyServices =>
  ({
    config: {
      mode: 'dev',
      ...config,
    },
  }) as unknown as CanopyServices

describe('startDevContentWatcher', () => {
  let root: string
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-dev-watcher-'))
  })

  afterEach(async () => {
    dispose?.()
    dispose = undefined
    await fs.rm(root, { recursive: true, force: true })
  })

  it('arms and detects a divergence for a multi-segment content root', async () => {
    // contentRoot: 'cms/content' is documented as valid (config/helpers.ts). Before
    // the getContentRoot() fix, the strategy hardcoded 'content' regardless of this
    // value, so the watcher looked for "<sourceRoot>/content" -- which never
    // exists here -- hit the existsSync guard, and silently returned the no-op
    // disposer. No error, no warning: the watcher just never ran.
    const workingTreeContentDir = path.join(root, 'cms', 'content')
    await fs.mkdir(workingTreeContentDir, { recursive: true })
    await fs.writeFile(path.join(workingTreeContentDir, 'a.md'), 'from working tree')

    const branchContentDir = path.join(
      root,
      '.canopy-dev',
      'content-branches',
      'feature',
      'cms',
      'content',
    )
    await fs.mkdir(branchContentDir, { recursive: true })
    await fs.writeFile(path.join(branchContentDir, 'a.md'), 'from branch clone (different)')

    const warn = vi.fn()
    const services = makeServices({
      sourceRoot: root,
      contentRoot: 'cms/content',
      defaultActiveBranch: 'feature',
      defaultBaseBranch: 'main',
    })

    dispose = startDevContentWatcher(services, { warn })

    // Assert against ANY call, not just the first: under real filesystem-watcher
    // pressure (many chokidar/fsevents watchers alive across the full suite) the
    // watcher's own 'error' handler can also call warn() with an unrelated
    // EMFILE-type message, and ordering between that and the real divergence
    // check is not guaranteed. What this test needs to prove is that the
    // divergence check itself ran and found the mismatch -- not that it was the
    // only thing that ever called warn().
    await vi.waitFor(
      () => {
        const divergenceWarnings = warn.mock.calls.filter(([msg]) => /diverged/.test(msg))
        expect(divergenceWarnings.length).toBeGreaterThan(0)
        expect(divergenceWarnings[0][0]).toContain('a.md')
      },
      { timeout: 2000 },
    )
  })

  it('still arms and detects a divergence for the default single-segment content root', async () => {
    const workingTreeContentDir = path.join(root, 'content')
    await fs.mkdir(workingTreeContentDir, { recursive: true })
    await fs.writeFile(path.join(workingTreeContentDir, 'a.md'), 'from working tree')

    const branchContentDir = path.join(
      root,
      '.canopy-dev',
      'content-branches',
      'feature',
      'content',
    )
    await fs.mkdir(branchContentDir, { recursive: true })
    await fs.writeFile(path.join(branchContentDir, 'a.md'), 'from branch clone (different)')

    const warn = vi.fn()
    const services = makeServices({
      sourceRoot: root,
      defaultActiveBranch: 'feature',
      defaultBaseBranch: 'main',
    })

    dispose = startDevContentWatcher(services, { warn })

    await vi.waitFor(
      () => {
        const divergenceWarnings = warn.mock.calls.filter(([msg]) => /diverged/.test(msg))
        expect(divergenceWarnings.length).toBeGreaterThan(0)
      },
      { timeout: 2000 },
    )
  })
})
