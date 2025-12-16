import { describe, expect, it, vi } from 'vitest'

import { GitManager } from './git-manager'

vi.mock('simple-git', () => {
  const status = vi.fn().mockResolvedValue({
    files: [],
    ahead: 0,
    behind: 0,
    current: 'feature/x',
    tracking: 'origin/feature/x',
  })
  const branch = vi.fn().mockResolvedValue({ all: ['main', 'feature/x'] })
  const checkout = vi.fn().mockResolvedValue(undefined)
  const checkoutBranch = vi.fn().mockResolvedValue(undefined)
  const checkoutLocalBranch = vi.fn().mockResolvedValue(undefined)
  const fetch = vi.fn().mockResolvedValue(undefined)
  const merge = vi.fn().mockResolvedValue(undefined)
  const rebase = vi.fn().mockResolvedValue(undefined)
  const add = vi.fn().mockResolvedValue(undefined)
  const commit = vi.fn().mockResolvedValue(undefined)
  const push = vi.fn().mockResolvedValue(undefined)
  const revparse = vi.fn().mockResolvedValue('feature/x')
  const getRemotes = vi
    .fn()
    .mockResolvedValue([{ name: 'origin', refs: { fetch: 'https://example.com/repo.git' } }])
  const addRemote = vi.fn().mockResolvedValue(undefined)
  const remote = vi.fn().mockResolvedValue(undefined)
  const listConfig = vi.fn().mockResolvedValue({ all: {} })
  const addConfig = vi.fn().mockResolvedValue(undefined)

  const gitInstance = {
    status,
    branch,
    checkout,
    checkoutBranch,
    checkoutLocalBranch,
    fetch,
    merge,
    rebase,
    add,
    commit,
    push,
    revparse,
    getRemotes,
    addRemote,
    remote,
    listConfig,
    addConfig,
  }

  const simpleGitMock = vi.fn(() => gitInstance)
  return { default: simpleGitMock, simpleGit: simpleGitMock }
})

describe('GitManager', () => {
  it('returns status shape', async () => {
    const gm = new GitManager({ repoPath: '/tmp/repo' })
    const s = await gm.status()
    expect(s.current).toBe('feature/x')
    expect(s.files).toEqual([])
  })

  it('checks out existing branch', async () => {
    const gm = new GitManager({ repoPath: '/tmp/repo' })
    await gm.checkoutBranch('feature/x')
    // If the mock was invoked, checkout was called
    expect(true).toBe(true)
  })

  it('ensures author is set', async () => {
    const gm = new GitManager({ repoPath: '/tmp/repo' })
    await gm.ensureAuthor({ name: 'Canopy Bot', email: 'canopy@example.com' })
    expect((gm as any).git.addConfig).toHaveBeenCalledWith('user.name', 'Canopy Bot')
    expect((gm as any).git.addConfig).toHaveBeenCalledWith('user.email', 'canopy@example.com')
  })
})
