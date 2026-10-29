import { describe, expect, it, vi } from 'vitest'

import {
  BranchPolicy,
  DEFAULT_BRANCH_TTL_MS,
  GatewayRefusalError,
  MAX_BRANCH_NAME_LENGTH,
  MAX_LEGACY_BRANCHES,
  MAX_PROTECTED_BRANCHES,
  MAX_PULL_REQUEST_BODY_LENGTH,
  MAX_PULL_REQUEST_TITLE_LENGTH,
  branchNameProblem,
  legacyBranchProblem,
  matchesBranchPattern,
  protectedPatternProblem,
  pushRefusalMessage,
  DEFAULT_BRANCH_NAMESPACE,
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
    ['a glob only settings branches could match', 'canopycms-settings-*'],
  ])('refuses %s', (_label, pattern) => {
    expect(protectedPatternProblem(pattern)).not.toBeNull()
  })

  it.each(['canopycms-settings-prod', 'canopycms-settings-'])(
    'refuses the exact settings entry %s: its plain push every sync would stop',
    (entry) => {
      expect(protectedPatternProblem(entry)).toMatch(/settings reaching GitHub/)
      expect(() => new BranchPolicy({ protectedBranches: [entry] })).toThrow(
        /Invalid protectedBranches entry .*settings reaching GitHub/,
      )
    },
  )

  it('takes up to MAX_PROTECTED_BRANCHES entries and refuses one more, naming the count', () => {
    const entries = (count: number) => Array.from({ length: count }, (_, i) => `release/${i}`)

    expect(
      () =>
        new BranchPolicy({
          baseBranch: 'main',
          protectedBranches: entries(MAX_PROTECTED_BRANCHES),
        }),
    ).not.toThrow()
    expect(
      new BranchPolicy({
        baseBranch: 'main',
        protectedBranches: entries(MAX_PROTECTED_BRANCHES),
      }).describe().configured,
    ).toHaveLength(MAX_PROTECTED_BRANCHES + 1)
    expect(
      () => new BranchPolicy({ protectedBranches: entries(MAX_PROTECTED_BRANCHES + 1) }),
    ).toThrow(`${MAX_PROTECTED_BRANCHES + 1} entries`)
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
    const policy = new BranchPolicy({ settingsBranch: 'canopycms-settings-prod' })
    const read = defaultIs('main')

    await policy.assertPushAllowed('canopycms-settings-prod', undefined, read, refusePush)
    await expect(
      policy.assertPushAllowed('canopycms-settings-prod', 'a'.repeat(40), read, refusePush),
    ).rejects.toThrow('push refused: settings')
    await policy.assertPushAllowed('canopycms/prod/feature', 'a'.repeat(40), read, refusePush)
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
    await policy.assertDeleteAllowed('canopycms/prod/feature', read)
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
    await policy.assertPullRequestAllowed(
      { head: 'canopycms/prod/feature', title: 'T', body: 'B' },
      read,
    )
  })

  it('refuses pull request text over its caps, and takes it at them', async () => {
    const policy = new BranchPolicy()
    const read = defaultIs('main')

    await policy.assertPullRequestAllowed(
      {
        head: 'canopycms/prod/feature',
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
        policy.assertPullRequestAllowed({ head: 'canopycms/prod/feature', ...text }, read),
      ).rejects.toMatchObject({ reason: 'too-long' })
    }
  })
})

describe('BranchPolicy: the namespace', () => {
  const refusePush = (reason: string) => new Error(`push refused: ${reason}`)
  const lease = 'a'.repeat(40)

  /** What the policy answers for each operation on `branch`: 'ok' or the refusal's reason. */
  async function verdicts(policy: BranchPolicy, branch: string) {
    const read = defaultIs('main')
    const reasonOf = (err: unknown) =>
      err instanceof GatewayRefusalError
        ? err.reason
        : err instanceof Error
          ? err.message.replace('push refused: ', '')
          : String(err)
    const settle = (work: Promise<void>) => work.then(() => 'ok', reasonOf)
    return {
      push: await settle(policy.assertPushAllowed(branch, undefined, read, refusePush)),
      lease: await settle(policy.assertPushAllowed(branch, lease, read, refusePush)),
      delete: await settle(policy.assertDeleteAllowed(branch, read)),
      pullRequest: await settle(policy.assertPullRequestAllowed({ head: branch }, read)),
    }
  }
  const all = (verdict: string) => ({
    push: verdict,
    lease: verdict,
    delete: verdict,
    pullRequest: verdict,
  })

  it('writes a branch in the namespace, and nothing outside it', async () => {
    const policy = new BranchPolicy({ settingsBranch: 'canopycms-settings-prod' })

    expect(await verdicts(policy, 'canopycms/prod/spring-update')).toEqual(all('ok'))
    expect(await verdicts(policy, 'canopycms/prod/release/1')).toEqual(all('ok'))
    for (const outside of [
      'feature',
      'release/1',
      'deploy-staging',
      'cms-x',
      'canopycms-feature',
    ]) {
      expect(await verdicts(policy, outside)).toEqual(all('outside-namespace'))
    }
  })

  it('compares the prefix exactly, as GitHub compares refs', async () => {
    const policy = new BranchPolicy()

    for (const lookalike of [
      'canopycms/prod',
      'canopycms/Prod/x',
      'CanopyCMS/prod/x',
      'canopycms/prod-eu/x',
      'canopycms-prod-x',
      'canopycms_prod/x',
      'xcanopycms/prod/x',
    ]) {
      expect(await verdicts(policy, lookalike)).toEqual(all('outside-namespace'))
    }
  })

  it('writes a legacy branch by its exact name only, never a name that sanitizes to it', async () => {
    const policy = new BranchPolicy({ legacyBranches: ['feature/x', 'spring'] })

    expect(await verdicts(policy, 'feature/x')).toEqual(all('ok'))
    expect(await verdicts(policy, 'spring')).toEqual(all('ok'))
    for (const near of ['feature-x', 'feature/x/y', 'Spring', 'spring-2']) {
      expect(await verdicts(policy, near)).toEqual(all('outside-namespace'))
    }
  })

  it('still refuses a protected branch inside the namespace or on the legacy list', async () => {
    const policy = new BranchPolicy({
      baseBranch: 'trunk',
      protectedBranches: ['canopycms/prod/keep-*', 'old'],
      legacyBranches: ['old', 'trunk'],
    })

    for (const branch of ['trunk', 'canopycms/prod/keep-me', 'old']) {
      expect(await verdicts(policy, branch)).toEqual(all('protected'))
    }
  })

  it("pushes this deployment's settings branch plainly, and no other deployment's", async () => {
    const policy = new BranchPolicy({ settingsBranch: 'canopycms-settings-prod' })

    expect(await verdicts(policy, 'canopycms-settings-prod')).toEqual({
      push: 'ok',
      lease: 'settings',
      delete: 'settings',
      pullRequest: 'settings',
    })
    expect(await verdicts(policy, 'canopycms-settings-staging')).toEqual({
      push: 'other-settings',
      lease: 'settings',
      delete: 'settings',
      pullRequest: 'settings',
    })
  })

  it('pushes no settings branch at all when it is given none', async () => {
    const policy = new BranchPolicy()

    expect((await verdicts(policy, 'canopycms-settings-prod')).push).toBe('other-settings')
  })

  it('treats a configured settings branch outside the prefix as a settings branch', async () => {
    const policy = new BranchPolicy({ settingsBranch: 'site-settings' })

    expect(await verdicts(policy, 'site-settings')).toEqual({
      push: 'ok',
      lease: 'settings',
      delete: 'settings',
      pullRequest: 'settings',
    })
  })

  it('describes the namespace, the legacy list and the settings branch', () => {
    const policy = new BranchPolicy({
      baseBranch: 'main',
      settingsBranch: 'canopycms-settings-prod',
      legacyBranches: ['spring'],
    })

    expect(policy.describe()).toEqual({
      configured: ['main'],
      githubDefault: null,
      namespace: 'canopycms/prod/',
      legacy: ['spring'],
      settingsBranch: 'canopycms-settings-prod',
    })
  })

  it('names the way out in an outside-namespace refusal', () => {
    expect(pushRefusalMessage('spring', 'outside-namespace', 'canopycms/prod/')).toMatch(
      /^Refusing to push "spring" to GitHub: it is outside this deployment's branch namespace \(names starting canopycms\/prod\/\).*legacyBranches/,
    )
  })

  it('names the configured namespace in a refusal, for every operation', async () => {
    const policy = new BranchPolicy({ namespace: 'editor-production/' })
    const read = defaultIs('main')
    const outside =
      /outside this deployment's branch namespace \(names starting editor-production\/\)/

    await expect(
      policy.assertPushAllowed('spring', undefined, read, (reason, message) => new Error(message)),
    ).rejects.toThrow(outside)
    await expect(policy.assertDeleteAllowed('spring', read)).rejects.toThrow(outside)
    await expect(policy.assertPullRequestAllowed({ head: 'spring' }, read)).rejects.toThrow(outside)
  })

  it('enforces a custom namespace instead of the default one', async () => {
    const policy = new BranchPolicy({
      namespace: 'editor-production/',
      settingsBranch: 'canopycms-settings-prod',
    })

    expect(policy.namespace).toBe('editor-production/')
    expect(policy.describe().namespace).toBe('editor-production/')
    expect(await verdicts(policy, 'editor-production/spring')).toEqual(all('ok'))
    expect(await verdicts(policy, 'editor-production/a/b')).toEqual(all('ok'))
    for (const outside of [
      'canopycms/prod/spring',
      'editor-production',
      'editor-production-x/spring',
      'Editor-Production/spring',
      'editor-staging/spring',
    ]) {
      expect(await verdicts(policy, outside)).toEqual(all('outside-namespace'))
    }
  })

  it('defaults to DEFAULT_BRANCH_NAMESPACE', () => {
    expect(DEFAULT_BRANCH_NAMESPACE).toBe('canopycms/prod/')
    expect(new BranchPolicy().namespace).toBe(DEFAULT_BRANCH_NAMESPACE)
  })
})

describe('legacyBranchProblem', () => {
  it.each(['spring', 'feature/x', 'v1.0', 'Release-2'])('takes %s', (entry) => {
    expect(legacyBranchProblem(entry)).toBeNull()
  })

  it.each([
    ['a wildcard', '*', /exact branch name/],
    ['a glob', 'release/*', /exact branch name/],
    ['a settings branch', 'canopycms-settings-prod', /settings branch/],
    ['a leading dash', '-x', /starts with '-'/],
    ['an empty name', '', /1 to/],
    ['a name git refuses', 'a..b', /'\.\.'/],
  ])('refuses %s', (_, entry, why) => {
    expect(legacyBranchProblem(entry)).toMatch(why)
  })
})

describe('BranchPolicy: building the namespace', () => {
  it('takes up to MAX_LEGACY_BRANCHES entries and refuses one more', () => {
    const entries = (count: number) => Array.from({ length: count }, (_, i) => `old-${i}`)

    expect(
      new BranchPolicy({ legacyBranches: entries(MAX_LEGACY_BRANCHES) }).describe().legacy,
    ).toHaveLength(MAX_LEGACY_BRANCHES)
    expect(() => new BranchPolicy({ legacyBranches: entries(MAX_LEGACY_BRANCHES + 1) })).toThrow(
      `legacyBranches has ${MAX_LEGACY_BRANCHES + 1} entries; the most it takes is ${MAX_LEGACY_BRANCHES}`,
    )
  })

  it.each([
    ['no trailing slash', 'editor-production', /must end with "\/"/],
    ['an empty namespace', '', /must end with "\/"/],
    ['a settings branch prefix', 'canopycms-settings-x/', /settings branches/],
    ['a space', 'editor production/', /printable ASCII/],
    ['a leading refs/', 'refs/heads/x/', /refs\//],
  ])('refuses a namespace with %s', (_label, namespace, why) => {
    expect(() => new BranchPolicy({ namespace })).toThrow(
      `Invalid branch namespace ${JSON.stringify(namespace)}: `,
    )
    expect(() => new BranchPolicy({ namespace })).toThrow(why)
  })

  it.each([
    ['base branch', { baseBranch: 'editor-production/main' }],
    ['settings branch', { settingsBranch: 'editor-production/settings' }],
  ])('refuses a %s inside the namespace', (what, options) => {
    expect(() => new BranchPolicy({ namespace: 'editor-production/', ...options })).toThrow(
      new RegExp(`The ${what} ".*" is inside the branch namespace "editor-production\\/"`),
    )
    expect(() => new BranchPolicy(options)).not.toThrow()
  })

  it('takes a base or settings branch that merely lookalikes the namespace', () => {
    expect(
      () =>
        new BranchPolicy({
          baseBranch: 'canopycms/prod-main',
          settingsBranch: 'canopycms/prod-settings',
        }),
    ).not.toThrow()
  })

  it.each([
    ['base branch', { baseBranch: 'canopycms/prod' }],
    ['base branch', { baseBranch: 'canopycms' }],
    ['settings branch', { settingsBranch: 'canopycms' }],
  ])(
    'refuses a %s named after part of the namespace, which git cannot hold beside it',
    (what, options) => {
      expect(() => new BranchPolicy(options)).toThrow(
        new RegExp(`The ${what} ".*" is a branch named after part of the branch namespace`),
      )
    },
  )

  it('refuses a legacy entry inside the namespace, as already in it', () => {
    expect(() => new BranchPolicy({ legacyBranches: ['canopycms/prod/spring'] })).toThrow(
      /Invalid legacyBranches entry "canopycms\/prod\/spring": it starts with canopycms\/prod\/, so it is already in the namespace/,
    )
    expect(
      () =>
        new BranchPolicy({
          namespace: 'editor-production/',
          legacyBranches: ['editor-production/x'],
        }),
    ).toThrow(/already in the namespace/)
    // Under another namespace the same name is simply a legacy branch.
    expect(
      new BranchPolicy({
        namespace: 'editor-production/',
        legacyBranches: ['canopycms/prod/spring'],
      }).describe().legacy,
    ).toEqual(['canopycms/prod/spring'])
  })

  it('refuses an invalid or repeated legacy entry, and an invalid settings branch', () => {
    expect(() => new BranchPolicy({ legacyBranches: ['*'] })).toThrow(
      'Invalid legacyBranches entry "*"',
    )
    expect(() => new BranchPolicy({ legacyBranches: ['spring', 'spring'] })).toThrow(
      'legacyBranches lists a branch more than once',
    )
    for (const name of ['', '-x', 'refs/heads/x']) {
      expect(() => new BranchPolicy({ settingsBranch: name })).toThrow('Invalid settings branch')
    }
  })
})
