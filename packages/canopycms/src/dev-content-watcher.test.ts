import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetDevContentWatchersForTests, startDevContentWatcher } from './dev-content-watcher'
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

/**
 * Divergence blocks only. The watcher's own 'error' handler can also call warn() with an unrelated
 * EMFILE-type message under filesystem-watcher pressure (many chokidar/fsevents watchers alive
 * across the full suite), and ordering between that and the real check is not guaranteed.
 */
const divergenceCalls = (warn: ReturnType<typeof vi.fn>): string[] =>
  warn.mock.calls.map(([msg]) => msg as string).filter((msg) => /diverged/.test(msg))

const syncedCalls = (warn: ReturnType<typeof vi.fn>): string[] =>
  warn.mock.calls.map(([msg]) => msg as string).filter((msg) => /back in sync/.test(msg))

/** Long enough for a startup check over a handful of small files to have completed. */
const CHECK_SETTLE_MS = 400
const settle = () => new Promise((resolve) => setTimeout(resolve, CHECK_SETTLE_MS))

describe('startDevContentWatcher', () => {
  let root: string
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-dev-watcher-'))
  })

  afterEach(async () => {
    dispose?.()
    dispose = undefined
    // The dedupe registry lives on globalThis and deliberately outlives dispose(), so it has to be
    // cleared explicitly or state leaks between tests.
    resetDevContentWatchersForTests()
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

    await vi.waitFor(
      () => {
        expect(divergenceCalls(warn).length).toBeGreaterThan(0)
        expect(divergenceCalls(warn)[0]).toContain('a.md')
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
        expect(divergenceCalls(warn).length).toBeGreaterThan(0)
      },
      { timeout: 2000 },
    )
  })

  describe('repeat suppression', () => {
    let workingTreeContentDir: string
    let branchContentDir: string
    let services: CanopyServices

    beforeEach(async () => {
      workingTreeContentDir = path.join(root, 'content')
      await fs.mkdir(workingTreeContentDir, { recursive: true })
      await fs.writeFile(path.join(workingTreeContentDir, 'a.md'), 'from working tree')

      branchContentDir = path.join(root, '.canopy-dev', 'content-branches', 'feature', 'content')
      await fs.mkdir(branchContentDir, { recursive: true })
      await fs.writeFile(path.join(branchContentDir, 'a.md'), 'from branch clone (different)')

      services = makeServices({
        sourceRoot: root,
        defaultActiveBranch: 'feature',
        defaultBaseBranch: 'main',
      })
    })

    it('reports an unchanged divergence once, however many content events fire', async () => {
      const warn = vi.fn()
      dispose = startDevContentWatcher(services, { warn })

      await vi.waitFor(() => expect(divergenceCalls(warn).length).toBe(1), { timeout: 2000 })

      // Rewrite a file with byte-identical content: chokidar fires 'change' every time, but the diff
      // against the branch clone is unchanged, so the condition the reader was told about is unchanged.
      for (let i = 0; i < 3; i++) {
        await fs.writeFile(path.join(workingTreeContentDir, 'a.md'), 'from working tree')
        await settle()
      }

      expect(divergenceCalls(warn)).toHaveLength(1)
    })

    it('stays quiet when a restarted watcher re-finds the same divergence', async () => {
      const firstWarn = vi.fn()
      const first = startDevContentWatcher(services, { warn: firstWarn })
      await vi.waitFor(() => expect(divergenceCalls(firstWarn).length).toBe(1), { timeout: 2000 })
      first()

      // Next's dev server compiles the server graph per route bundle and evaluates each copy in its
      // own module scope, so every copy calls startDevContentWatcher again. With the registry in
      // module scope, the new watcher saw no prior state and re-printed the whole block -- which is
      // what made the warning appear to repeat on every request.
      const secondWarn = vi.fn()
      dispose = startDevContentWatcher(services, { warn: secondWarn })
      await settle()

      expect(divergenceCalls(secondWarn)).toHaveLength(0)

      // Prove the restarted watcher is genuinely live and merely chose silence: change the
      // divergence and the new state must be reported.
      await fs.writeFile(path.join(workingTreeContentDir, 'b.md'), 'only in the working tree')
      await vi.waitFor(() => expect(divergenceCalls(secondWarn).length).toBe(1), { timeout: 2000 })
      expect(divergenceCalls(secondWarn)[0]).toContain('b.md')
    })

    it('announces the retraction when the divergence is resolved', async () => {
      const warn = vi.fn()
      dispose = startDevContentWatcher(services, { warn })
      await vi.waitFor(() => expect(divergenceCalls(warn).length).toBe(1), { timeout: 2000 })

      // Bring the trees back into agreement, as `canopycms sync push` would.
      await fs.writeFile(path.join(branchContentDir, 'a.md'), 'from working tree')
      await fs.writeFile(path.join(workingTreeContentDir, 'a.md'), 'from working tree')

      await vi.waitFor(() => expect(syncedCalls(warn).length).toBe(1), { timeout: 2000 })
      expect(syncedCalls(warn)[0]).toContain('feature')

      // And the retraction is itself a condition, not an event: it does not repeat either.
      for (let i = 0; i < 2; i++) {
        await fs.writeFile(path.join(workingTreeContentDir, 'a.md'), 'from working tree')
        await settle()
      }
      expect(syncedCalls(warn)).toHaveLength(1)
    })
  })
})
