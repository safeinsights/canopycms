import { describe, it, expect, vi } from 'vitest'
import type { ApiContext } from './types'
import { createMockApiContext, mockConsole } from '../test-utils'
import { commitSettings } from './settings-helpers'

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
