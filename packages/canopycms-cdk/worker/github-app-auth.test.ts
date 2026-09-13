import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { buildGitHubAppAuth, gitHubAppAuthFrom } from './github-app-auth'

/**
 * The contract these tests exist for is an IDENTITY, not a behaviour, and it is
 * silently violable: `authStrategy: createAppAuth` and
 * `authStrategy: () => appAuth` are one token apart, both typecheck, and both
 * authenticate successfully. The difference only shows up as two
 * installation-token caches and twice the mints -- which nothing observes until
 * a rate limit or a confused audit log. So the assertions below pin object
 * identity deliberately, where a behavioural assertion would pass either way.
 */

/** A PKCS#1 RSA key, which is the format GitHub issues App keys in. */
function generatePkcs1Key(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey
}

describe('gitHubAppAuthFrom: both facets come from ONE auth instance', () => {
  it('octokitAuth.authStrategy returns the very instance mintInstallationToken uses', () => {
    const appAuth = vi.fn(async () => ({ token: 'ghs_probe' }))
    const auth = gitHubAppAuthFrom(appAuth)

    // Octokit calls the strategy with its own options; whatever comes back is
    // what it authenticates through. It must be the same object the git half
    // mints from, because that object -- and only that object -- holds the
    // installation-token cache the two halves share.
    expect(auth.octokitAuth.authStrategy({})).toBe(appAuth)
  })

  it('never constructs a second instance: the strategy is the same object every call', () => {
    // `authStrategy: createAppAuth` would satisfy the assertion above's TYPE
    // and fail this one -- Octokit would build a fresh instance per call.
    const appAuth = vi.fn(async () => ({ token: 'ghs_probe' }))
    const { octokitAuth } = gitHubAppAuthFrom(appAuth)
    expect(octokitAuth.authStrategy({})).toBe(octokitAuth.authStrategy({ request: {} }))
  })

  it('mints through that instance, asking for an installation token', () => {
    const appAuth = vi.fn(async () => ({ token: 'ghs_probe' }))
    const auth = gitHubAppAuthFrom(appAuth)

    return expect(auth.mintInstallationToken({ signal: AbortSignal.timeout(1000) })).resolves.toBe(
      'ghs_probe',
    )
  })

  it("asks for type 'installation', not the app-level JWT", () => {
    // `{ type: 'app' }` yields the App's own JWT, which authenticates as the
    // App rather than as its installation on a repository -- it cannot push,
    // and GitHub rejects it from the git remote with a 403 saying nothing
    // useful about why.
    const appAuth = vi.fn(async () => ({ token: 'ghs_probe' }))
    const auth = gitHubAppAuthFrom(appAuth)

    return auth.mintInstallationToken({ signal: AbortSignal.timeout(1000) }).then(() => {
      expect(appAuth).toHaveBeenCalledWith({ type: 'installation' })
    })
  })

  it('does not re-wrap a mint failure, so the HTTP status survives', () => {
    // task-runner.ts's isPermanentTaskFailure classifies on `.status`: 4xx is
    // permanent, so a bad key (401) fails the task at once instead of burning
    // its whole retry budget. A `new Error(getErrorMessage(err))` here would
    // drop the status and make every mint failure look transient.
    const failure = Object.assign(new Error('Bad credentials'), { status: 401 })
    const auth = gitHubAppAuthFrom(
      vi.fn(() => Promise.reject(failure)) as unknown as Parameters<typeof gitHubAppAuthFrom>[0],
    )

    return auth.mintInstallationToken({ signal: AbortSignal.timeout(1000) }).then(
      () => expect.unreachable('the mint should have rejected'),
      (err: unknown) => expect(err).toBe(failure),
    )
  })
})

describe('buildGitHubAppAuth: the real @octokit/auth-app strategy, built once', () => {
  const credentials = {
    appId: '123456',
    installationId: '78901234',
    privateKey: generatePkcs1Key(),
  }

  it('backs both facets with one real strategy instance', () => {
    // The same identity assertion as above, but against the real
    // `createAppAuth` rather than a spy -- so it also proves that
    // buildGitHubAppAuth calls it exactly once and hands the result straight
    // to gitHubAppAuthFrom, which the spy version cannot see.
    const { octokitAuth } = buildGitHubAppAuth(credentials)
    const first = octokitAuth.authStrategy({})
    expect(first).toBe(octokitAuth.authStrategy({}))
    // `.hook` is what Octokit actually requires of a strategy's return value,
    // so this is the check that the closure returns a usable auth instance and
    // not, say, the options object.
    expect(first).toHaveProperty('hook')
  })

  it('accepts a PKCS#1 key whose newlines arrived as literal \\n escapes', () => {
    // How a multi-line PEM comes back out of a single-line config field, and
    // the case normalizeGitHubAppPrivateKey earns its place on TODAY. Verified
    // to have teeth: replacing the normalizer with a bare
    // `createPrivateKey(pem)` -- a plausible "simplification", since the
    // PKCS#1 -> PKCS#8 conversion is only insurance -- turns this red.
    //
    // There is deliberately no sibling asserting that an UNESCAPED PKCS#1 key
    // is accepted. That assertion cannot fail: PKCS#1 already works at the pin
    // we install (esbuild --platform=node resolves universal-github-app-jwt@1's
    // `main`, which signs via `jsonwebtoken`), so it passes with the
    // normalization removed entirely. The conversion guards a bundler-flag
    // change or an @octokit/auth-app@7 bump, neither of which a test here can
    // observe -- `github-auth.test.ts` in core covers the normalizer directly.
    expect(() =>
      buildGitHubAppAuth({
        ...credentials,
        privateKey: credentials.privateKey.replace(/\n/g, '\\n'),
      }),
    ).not.toThrow()
  })

  it('rejects an unusable key where it is configured, naming the key', () => {
    // Rather than surfacing hours later as an opaque JWT signing failure at the
    // first push.
    expect(() => buildGitHubAppAuth({ ...credentials, privateKey: 'not a key' })).toThrow(
      /GitHub App private key could not be parsed/,
    )
  })
})
