import { describe, expect, it, vi } from 'vitest'

import {
  BranchPolicy,
  DEFAULT_BRANCH_TTL_MS,
  GatewayRefusalError,
  MAX_BRANCH_NAME_LENGTH,
  MAX_PULL_REQUEST_BODY_LENGTH,
  MAX_PULL_REQUEST_TITLE_LENGTH,
  branchNameProblem,
  matchesBranchPattern,
  protectedPatternProblem,
} from './branch-policy'

const defaultIs = (name: string | null) => vi.fn(async () => name)

describe('matchesBranchPattern', () => {
  it.each([
    ['release/*', 'release/1.0', true],
    ['release/*', 'release/a/b', true],
    ['release/*', 'release/', true],
    ['release/*', 'release', false],
    ['*', 'anything/at/all', true],
    ['*-stable', 'v2-stable', true],
    ['*-stable', 'v2-stable-not', false],
    ['a*b*c', 'axxbyyc', true],
    ['a*b*c', 'acb', false],
    ['a*bc*c', 'abc', false],
    ['a*bc*c', 'abcc', true],
    ['a*a', 'a', false],
    ['a*a', 'aa', true],
    ['**', '', true],
    ['main', 'main', true],
    ['main', 'mainx', false],
  ])('%s against %s is %s', (pattern, name, expected) => {
    expect(matchesBranchPattern(pattern, name)).toBe(expected)
  })

  it('reads every character but * literally, never as a regex', () => {
    expect(matchesBranchPattern('v1.0', 'v1x0')).toBe(false)
    expect(matchesBranchPattern('main+', 'mainnn')).toBe(false)
    expect(matchesBranchPattern('a.*', 'ab')).toBe(false)
    expect(matchesBranchPattern('a.*', 'a.b')).toBe(true)
    expect(matchesBranchPattern('(a|b)', 'a')).toBe(false)
    expect(matchesBranchPattern('(a|b)', '(a|b)')).toBe(true)
  })
})

describe('protectedPatternProblem', () => {
  it.each(['main', 'release/*', '*', '*-stable', 'v1.0', 'a+b', 'feature/x'])(
    'takes %s',
    (pattern) => {
      expect(protectedPatternProblem(pattern)).toBeNull()
    },
  )

  it.each([
    ['another glob character', 'release-[0-9]'],
    ['a question mark', 'release-?'],
    ['a backslash', 'a\\*'],
    ['a tilde', 'a~1'],
    ['a colon', 'origin:main'],
    ['a leading refs/', 'refs/heads/main'],
    ['a percent sign', 'a%2fb'],
    ['a brace', 'a{b}'],
    ['a quote', 'a"b'],
    ['a leading dash', '-x'],
    ['whitespace', 'a b'],
    ['non-ASCII', 'caf\u00e9'],
    ['a zero-width space', 'ma\u200bin'],
    ['dot-dot', 'a..b'],
    ['a reflog selector', 'a@{1}'],
    ['a trailing slash', 'release/'],
    ['an empty entry', ''],
  ])('refuses %s', (_label, pattern) => {
    expect(protectedPatternProblem(pattern)).not.toBeNull()
  })

  it('refuses an invalid entry when the policy is built', () => {
    expect(() => new BranchPolicy({ protectedBranches: ['release-[0-9]'] })).toThrow(
      /Invalid protectedBranches entry "release-\[0-9\]"/,
    )
  })
})

describe('branchNameProblem', () => {
  it.each(['main', 'feature/x', 'canopycms-settings-prod', 'a_b.c-d', 'x'.repeat(255)])(
    'takes %s',
    (name) => {
      expect(branchNameProblem(name)).toBeNull()
    },
  )

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(MAX_BRANCH_NAME_LENGTH + 1)],
    ['a leading refs/heads/', 'refs/heads/main'],
    ['a leading Refs/ in another case', 'Refs/heads/main'],
    ['a leading heads/', 'heads/main'],
    ['a leading tags/', 'tags/v1'],
    ['a leading remotes/', 'remotes/origin/main'],
    ['a percent sign', 'm%61in'],
    ['a brace', 'a{b'],
    ['a quote', 'a"b'],
    ['a leading dash', '--upload-pack=x'],
    ['a space', 'a b'],
    ['a newline', 'a\nb'],
    ['a bidi control', 'ma\u202ein'],
    ['a Cyrillic letter', 'm\u0430in'],
  ])('refuses %s', (_label, name) => {
    expect(branchNameProblem(name)).not.toBeNull()
  })
})

describe('BranchPolicy: the protected set', () => {
  it('protects the configured base branch without reading GitHub', async () => {
    const read = defaultIs('main')
    const policy = new BranchPolicy({ baseBranch: 'production' })

    expect(await policy.isProtected('production', read)).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it("protects GitHub's default branch, and nothing else unconfigured", async () => {
    const policy = new BranchPolicy()

    expect(await policy.isProtected('main', defaultIs('main'))).toBe(true)
    expect(await policy.isProtected('feature', defaultIs('main'))).toBe(false)
  })

  it('protects nothing by default for a repository with no default branch', async () => {
    expect(await new BranchPolicy().isProtected('main', defaultIs(null))).toBe(false)
  })

  it('never lets a glob take in a settings branch, whose plain push the worker needs', async () => {
    const policy = new BranchPolicy({ protectedBranches: ['*-prod'] })

    expect(await policy.isProtected('release-prod', defaultIs('main'))).toBe(true)
    expect(await policy.isProtected('canopycms-settings-prod', defaultIs('main'))).toBe(false)
  })

  it('protects listed names and globs', async () => {
    const policy = new BranchPolicy({ protectedBranches: ['release/*', 'hotfix'] })
    const read = defaultIs('main')

    expect(await policy.isProtected('release/2026', read)).toBe(true)
    expect(await policy.isProtected('hotfix', read)).toBe(true)
    expect(await policy.isProtected('hotfix-2', read)).toBe(false)
    expect(await policy.isProtected('releases/x', read)).toBe(false)
  })

  it('matches case-sensitively, as GitHub names refs, and an exact entry by its workspace directory too', async () => {
    const policy = new BranchPolicy({ baseBranch: 'release/v2', protectedBranches: ['Hot*'] })
    const read = defaultIs('Main')

    expect(await policy.isProtected('Main', read)).toBe(true)
    expect(await policy.isProtected('MAIN', read)).toBe(false)
    expect(await policy.isProtected('RELEASE/V2', read)).toBe(false)
    expect(await policy.isProtected('release-v2', read)).toBe(true)
    expect(await policy.isProtected('Hotfix', read)).toBe(true)
    expect(await policy.isProtected('hotfix', read)).toBe(false)
  })

  it('fails, and caches nothing, when the default branch cannot be read', async () => {
    const policy = new BranchPolicy()
    const failing = vi.fn(async () => {
      throw new Error('GitHub is down')
    })

    await expect(policy.isProtected('main', failing)).rejects.toThrow('GitHub is down')
    const read = defaultIs('main')
    expect(await policy.isProtected('main', read)).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe("BranchPolicy: GitHub's default branch, re-read after its TTL", () => {
  it('reads it once per TTL, and again once the TTL has passed', async () => {
    let now = 1_000_000
    const policy = new BranchPolicy({ now: () => now })
    let current = 'main'
    const read = vi.fn(async () => current)

    expect(await policy.isProtected('main', read)).toBe(true)
    current = 'trunk'
    now += DEFAULT_BRANCH_TTL_MS - 1
    // Still the default it read: a change takes up to the TTL to reach the set.
    expect(await policy.isProtected('main', read)).toBe(true)
    expect(await policy.isProtected('trunk', read)).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)

    now += 1
    expect(await policy.isProtected('trunk', read)).toBe(true)
    expect(await policy.isProtected('main', read)).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps the later of two reads that finish out of order', async () => {
    let now = 0
    const policy = new BranchPolicy({ now: () => now })
    let finishOld!: (name: string) => void
    const old = policy.recordGitHubDefault(
      () => new Promise<string>((resolve) => (finishOld = resolve)),
    )
    now = 5
    await policy.recordGitHubDefault(async () => 'trunk')
    finishOld('main')
    await old

    const read = defaultIs('unused')
    expect(await policy.isProtected('trunk', read)).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('BranchPolicy: refusals', () => {
  const refusePush = (reason: string) => new Error(`push refused: ${reason}`)

  it('refuses a push to a protected branch, plain or leased', async () => {
    const policy = new BranchPolicy({ protectedBranches: ['release/*'] })

    for (const lease of [undefined, 'a'.repeat(40)]) {
      await expect(
        policy.assertPushAllowed('release/1', lease, defaultIs('main'), refusePush),
      ).rejects.toThrow('push refused: protected')
    }
  })

  it('takes a plain push to a settings branch, and refuses a leased one', async () => {
    const policy = new BranchPolicy()
    const read = defaultIs('main')

    await policy.assertPushAllowed('canopycms-settings-prod', undefined, read, refusePush)
    await expect(
      policy.assertPushAllowed('canopycms-settings-prod', 'a'.repeat(40), read, refusePush),
    ).rejects.toThrow('push refused: settings')
    await policy.assertPushAllowed('feature', 'a'.repeat(40), read, refusePush)
  })

  it("refuses to delete GitHub's default branch, the base, a listed branch or a settings branch", async () => {
    const policy = new BranchPolicy({ baseBranch: 'production', protectedBranches: ['keep-*'] })
    const read = defaultIs('main')

    for (const [branch, reason] of [
      ['main', 'protected'],
      ['production', 'protected'],
      ['keep-me', 'protected'],
      ['canopycms-settings-prod', 'settings'],
    ] as const) {
      const caught = await policy.assertDeleteAllowed(branch, read).catch((err: unknown) => err)
      expect(caught).toBeInstanceOf(GatewayRefusalError)
      expect(caught).toMatchObject({ operation: 'delete', branch, reason })
    }
    await policy.assertDeleteAllowed('feature', read)
  })

  it('refuses a pull request from a protected or settings head, never for its base', async () => {
    const policy = new BranchPolicy({ protectedBranches: ['release/*'] })
    const read = defaultIs('main')

    for (const head of ['main', 'release/1', 'canopycms-settings-prod']) {
      await expect(policy.assertPullRequestAllowed({ head }, read)).rejects.toBeInstanceOf(
        GatewayRefusalError,
      )
    }
    // The base is whatever the branch was created from, protected or not.
    await policy.assertPullRequestAllowed({ head: 'feature', title: 'T', body: 'B' }, read)
  })

  it('refuses pull request text over its caps, and takes it at them', async () => {
    const policy = new BranchPolicy()
    const read = defaultIs('main')

    await policy.assertPullRequestAllowed(
      {
        head: 'feature',
        title: 't'.repeat(MAX_PULL_REQUEST_TITLE_LENGTH),
        body: 'b'.repeat(MAX_PULL_REQUEST_BODY_LENGTH),
      },
      read,
    )
    for (const text of [
      { title: 't'.repeat(MAX_PULL_REQUEST_TITLE_LENGTH + 1) },
      { body: 'b'.repeat(MAX_PULL_REQUEST_BODY_LENGTH + 1) },
    ]) {
      await expect(
        policy.assertPullRequestAllowed({ head: 'feature', ...text }, read),
      ).rejects.toMatchObject({ reason: 'too-long' })
    }
  })
})
