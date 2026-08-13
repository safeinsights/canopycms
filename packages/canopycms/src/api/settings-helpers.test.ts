import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ApiContext } from './types'
import { createMockApiContext, mockConsole } from '../test-utils'
import { commitSettings, getSettingsBranchContext } from './settings-helpers'
import { clearStrategyCache } from '../operating-mode'

describe('commitSettings (API-H1)', () => {
  const baseOptions = {
    context: { branchRoot: '/test/settings' },
    branchRoot: '/test/settings',
    fileName: 'permissions.json',
    message: 'Update permissions',
  }

  it('reports pushed: true when the commit is pushed successfully', async () => {
    const ctx: ApiContext = createMockApiContext({
      services: {
        config: { mode: 'dev' } as any,
        commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: true }),
      },
    })

    const result = await commitSettings(ctx, { ...baseOptions, mode: 'dev' })

    expect(result).toEqual({ pushed: true })
  })

  it('reports pushed: false with a sanitized error when the push fails', async () => {
    // The "committed but not pushed" path is expected here; swallow (and assert)
    // the warning so it doesn't clutter the test reporter.
    const consoleSpy = mockConsole()
    const ctx: ApiContext = createMockApiContext({
      services: {
        config: { mode: 'prod' } as any,
        commitToSettingsBranch: vi.fn().mockResolvedValue({
          committed: true,
          pushed: false,
          error: `push failed: https://x-access-token:ghp_leak@github.com/org/repo.git from /mnt/efs/settings`,
        }),
      },
    })

    const result = await commitSettings(ctx, { ...baseOptions, mode: 'prod' })

    expect(result.pushed).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain('ghp_leak')
    expect(result.error).not.toContain('/mnt/efs')
    expect(result.error).toContain('***@github.com')
    expect(consoleSpy).toHaveWarned('committed but not pushed')
    consoleSpy.restore()
  })

  it('falls back to a generic message when the underlying error is empty', async () => {
    const consoleSpy = mockConsole()
    const ctx: ApiContext = createMockApiContext({
      services: {
        config: { mode: 'prod' } as any,
        commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: false }),
      },
    })

    const result = await commitSettings(ctx, { ...baseOptions, mode: 'prod' })

    expect(result.pushed).toBe(false)
    expect(result.error).toBe('Settings change was saved but not pushed to git')
    expect(consoleSpy).toHaveWarned('committed but not pushed')
    consoleSpy.restore()
  })
})

describe('getSettingsBranchContext (deploymentName pass-through)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    clearStrategyCache()
  })

  it('passes the whole config through, so deploymentName reaches the resolved branch name', async () => {
    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
    const ctx: ApiContext = createMockApiContext({
      services: { config: { mode: 'dev', deploymentName: 'acme' } as any },
    })

    const result = await getSettingsBranchContext(ctx)

    expect('branchName' in result && result.branchName).toBe('canopycms-settings-acme')
  })

  it('falls back to the mode default when deploymentName is unset', async () => {
    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
    const ctx: ApiContext = createMockApiContext({
      services: { config: { mode: 'dev' } as any },
    })

    const result = await getSettingsBranchContext(ctx)

    expect('branchName' in result && result.branchName).toBe('canopycms-settings-local')
  })

  it('still honors an explicit settingsBranch override ahead of deploymentName', async () => {
    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
    const ctx: ApiContext = createMockApiContext({
      services: {
        config: { mode: 'dev', deploymentName: 'acme', settingsBranch: 'custom-branch' } as any,
      },
    })

    const result = await getSettingsBranchContext(ctx)

    expect('branchName' in result && result.branchName).toBe('custom-branch')
  })
})
