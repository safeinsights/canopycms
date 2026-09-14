import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../branch-workspace', () => ({
  loadOrCreateBranchContext: vi.fn(async ({ branchName }: { branchName: string }) => ({
    branchRoot: `/workspace/${branchName}`,
  })),
}))

vi.mock('../../utils/git', () => ({
  detectHeadBranch: vi.fn(async () => 'feat-bar'),
}))

import { resolveBranchRoot } from '../resolve-branch'
import { loadOrCreateBranchContext } from '../../branch-workspace'
import { detectHeadBranch } from '../../utils/git'
import type { CanopyConfig } from '../../config'
import type { OperatingMode } from '../../operating-mode'

function makeConfig(overrides: Partial<CanopyConfig> = {}): CanopyConfig {
  return {
    mode: 'dev',
    deployedAs: 'server',
    contentRoot: 'content',
    gitBotAuthorName: 'bot',
    gitBotAuthorEmail: 'bot@test.com',
    ...overrides,
  } as CanopyConfig
}

describe('resolveBranchRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Guard against a developer's shell (or CI) already exporting either build-mode
    // switch: every test in this describe asserts RUNTIME behavior, and this file does
    // not mock build-mode, so readsFromCheckout() reads the real environment.
    vi.stubEnv('NEXT_PHASE', '')
    vi.stubEnv('CANOPY_BUILD_MODE', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns cwd for static deployments', async () => {
    const result = await resolveBranchRoot(makeConfig({ deployedAs: 'static' }))
    expect(result).toBe(process.cwd())
    expect(detectHeadBranch).not.toHaveBeenCalled()
    expect(loadOrCreateBranchContext).not.toHaveBeenCalled()
  })

  it('uses explicit defaultActiveBranch when set (dev mode)', async () => {
    const result = await resolveBranchRoot(makeConfig({ defaultActiveBranch: 'my-branch' }))
    expect(result).toBe('/workspace/my-branch')
    expect(detectHeadBranch).not.toHaveBeenCalled()
  })

  it('uses explicit defaultActiveBranch when set (prod mode)', async () => {
    const result = await resolveBranchRoot(
      makeConfig({ mode: 'prod', defaultActiveBranch: 'staging' }),
    )
    expect(result).toBe('/workspace/staging')
    expect(detectHeadBranch).not.toHaveBeenCalled()
  })

  it('auto-detects git HEAD in dev mode when no explicit branch', async () => {
    const result = await resolveBranchRoot(makeConfig({ mode: 'dev' }))
    expect(detectHeadBranch).toHaveBeenCalledWith(process.cwd(), 'main')
    expect(result).toBe('/workspace/feat-bar')
  })

  it('passes defaultBaseBranch as fallback to detectHeadBranch', async () => {
    const result = await resolveBranchRoot(
      makeConfig({ mode: 'dev', defaultBaseBranch: 'develop' }),
    )
    expect(detectHeadBranch).toHaveBeenCalledWith(process.cwd(), 'develop')
    expect(result).toBe('/workspace/feat-bar')
  })

  it('falls back to defaultBaseBranch in prod mode', async () => {
    const result = await resolveBranchRoot(
      makeConfig({ mode: 'prod', defaultBaseBranch: 'production' }),
    )
    expect(detectHeadBranch).not.toHaveBeenCalled()
    expect(result).toBe('/workspace/production')
  })

  it('falls back to main in prod mode when no branches configured', async () => {
    const result = await resolveBranchRoot(makeConfig({ mode: 'prod' }))
    expect(detectHeadBranch).not.toHaveBeenCalled()
    expect(result).toBe('/workspace/main')
  })
})

describe('resolveBranchRoot at build (readsFromCheckout)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['dev' as OperatingMode, 'NEXT_PHASE', 'phase-production-build'] as const,
    ['prod' as OperatingMode, 'NEXT_PHASE', 'phase-production-build'] as const,
    ['dev' as OperatingMode, 'CANOPY_BUILD_MODE', 'true'] as const,
    ['prod' as OperatingMode, 'CANOPY_BUILD_MODE', 'true'] as const,
  ])(
    'returns cwd for a %s-mode server deployment at build (%s=%s), never touching git or a branch workspace',
    async (mode, envVar, envValue) => {
      vi.stubEnv(envVar, envValue)

      const result = await resolveBranchRoot(makeConfig({ mode, deployedAs: 'server' }))

      expect(result).toBe(process.cwd())
      expect(detectHeadBranch).not.toHaveBeenCalled()
      expect(loadOrCreateBranchContext).not.toHaveBeenCalled()
    },
  )
})
