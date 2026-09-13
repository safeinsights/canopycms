/**
 * The contract between canopycms's `normalizeGitHubAppPrivateKey` and the real
 * `@octokit/auth-app`.
 *
 * canopycms cannot test this: it must never depend on `@octokit/auth-app`
 * (github-service.ts is reachable from services.ts, so anything it imports is
 * in every adopter's Next.js server bundle). The dependency lives here, so
 * this is the only place the normalizer can be checked against the signer it
 * exists for — its own unit tests can only prove the output is the same key in
 * PKCS#8, not that the signer accepts it.
 *
 * No network: `createAppAuth` takes a `request` override, so the mint is
 * answered locally. The JWT signing it does first is real.
 *
 * The describes below the first one cover this package's own two members on top
 * of that instance -- `gitHubAppAuthFrom` and `buildGitHubAppAuth` -- which is
 * why they live here too: they need the same real strategy, and the same
 * offline mint, to say anything about token SHARING rather than just about
 * object identity.
 */

import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { createAppAuth } from '@octokit/auth-app'
import { normalizeGitHubAppPrivateKey } from 'canopycms/worker/cms-worker'
import {
  buildGitHubAppAuth,
  gitHubAppAuthFrom,
  type InstallationTokenMinter,
} from './github-app-auth'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
/** The format GitHub actually hands out when you download an App key. */
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

/** Stands in for GitHub's installation-token endpoint. Counts the calls. */
const fakeRequest = () => {
  const calls: string[] = []
  const request = async (route: string) => {
    calls.push(route)
    return {
      data: {
        token: 'ghs_fake_installation_token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: 'write' },
        repository_selection: 'all',
      },
    }
  }
  // `createAppAuth` types this as Octokit's full RequestInterface; the mint
  // path uses only the call signature above.
  return { calls, request: request as unknown as Parameters<typeof createAppAuth>[0]['request'] }
}

const authWith = (key: string) => {
  const { calls, request } = fakeRequest()
  return {
    calls,
    appAuth: createAppAuth({
      appId: '12345',
      installationId: '67890',
      privateKey: key,
      request,
    }),
  }
}

describe('normalizeGitHubAppPrivateKey against @octokit/auth-app', () => {
  it('produces a key the real signer mints an installation token with', async () => {
    const { appAuth } = authWith(normalizeGitHubAppPrivateKey(pkcs1))

    const auth = await appAuth({ type: 'installation' })

    expect(auth.token).toBe('ghs_fake_installation_token')
  })

  it('produces a signable key from an escaped, base64-wrapped PEM too', async () => {
    // The shape a multi-line secret arrives in after a single-line config
    // field. Round-tripping it through the normalizer is the whole reason the
    // helper is exported.
    const mangled = Buffer.from(pkcs1.trimEnd().replace(/\n/g, '\\n'), 'utf8').toString('base64')
    expect(mangled).not.toContain('BEGIN')

    const { appAuth } = authWith(normalizeGitHubAppPrivateKey(mangled))

    await expect(appAuth({ type: 'installation' })).resolves.toMatchObject({
      token: 'ghs_fake_installation_token',
    })
  })

  it('caches the installation token on the instance, so one instance means one mint', async () => {
    // Why GitHubAppAuth's two members must derive from ONE createAppAuth
    // instance: the cache lives on the instance, and this is what keeps the
    // REST client and the git remote URL on the same hourly token.
    const { appAuth, calls } = authWith(normalizeGitHubAppPrivateKey(pkcs1))

    await appAuth({ type: 'installation' })
    await appAuth({ type: 'installation' })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('access_tokens')
  })

  it('mints separately for a second instance, which is what sharing avoids', async () => {
    const first = authWith(normalizeGitHubAppPrivateKey(pkcs1))
    const second = authWith(normalizeGitHubAppPrivateKey(pkcs1))

    await first.appAuth({ type: 'installation' })
    await second.appAuth({ type: 'installation' })

    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(1)
  })
})

/**
 * The two members this package builds on top of that instance.
 *
 * The contract is an IDENTITY, and it is silently violable:
 * `authStrategy: createAppAuth` and a closure returning the instance we already
 * have are one token apart, both typecheck, and both authenticate successfully.
 * The difference is two installation-token caches and twice the mints — which
 * nothing observes until a rate limit or a confused audit log. So these pin the
 * identity, and the mint COUNT through the real strategy, where a behavioural
 * assertion on the token alone would pass either way.
 */
describe('gitHubAppAuthFrom: both members reach ONE auth instance', () => {
  const spy = () => vi.fn(async () => ({ token: 'ghs_probe' }))

  it('octokitAuth.authStrategy returns the very instance mintInstallationToken uses', () => {
    const appAuth = spy()
    const auth = gitHubAppAuthFrom(() => appAuth)

    // Octokit calls the strategy with its own options; whatever comes back is
    // what it authenticates through. It must be the same object the git half
    // mints from, because that object -- and only that object -- holds the
    // installation-token cache the two halves share.
    expect(auth.octokitAuth.authStrategy({})).toBe(appAuth)
  })

  it('mints through that instance, asking for an installation token', async () => {
    const appAuth = spy()
    const auth = gitHubAppAuthFrom(() => appAuth)

    await expect(auth.mintInstallationToken({ signal: AbortSignal.timeout(1000) })).resolves.toBe(
      'ghs_probe',
    )
    // `{ type: 'app' }` would yield the App's own JWT, which authenticates as
    // the App rather than as its installation on a repository -- it cannot
    // push, and GitHub rejects it from the git remote with a 403 saying nothing
    // useful about why.
    expect(appAuth).toHaveBeenCalledWith({ type: 'installation' })
  })

  it('does not re-wrap a mint failure, so the HTTP status survives', async () => {
    // task-runner.ts's isPermanentTaskFailure classifies on `.status`: 4xx is
    // permanent, so a bad key (401) fails the task at once instead of burning
    // its whole retry budget. A `new Error(getErrorMessage(err))` here would
    // drop the status and make every mint failure look transient.
    const failure = Object.assign(new Error('Bad credentials'), { status: 401 })
    const auth = gitHubAppAuthFrom(
      () => (() => Promise.reject(failure)) as unknown as InstallationTokenMinter,
    )

    await expect(auth.mintInstallationToken({ signal: AbortSignal.timeout(1000) })).rejects.toBe(
      failure,
    )
  })
})

describe('buildGitHubAppAuth: the real strategy, built once and not before it is needed', () => {
  const credentials = { appId: '12345', installationId: '67890', privateKey: pkcs1 }

  it('shares one token across BOTH members: two uses, one mint', async () => {
    // The behavioural half of the identity assertions above, through the real
    // @octokit/auth-app. This is the property the whole single-instance
    // contract exists for, and the one that silently regresses.
    const { calls, request } = fakeRequest()
    let instance: InstallationTokenMinter | undefined
    const auth = gitHubAppAuthFrom(() => {
      instance ??= createAppAuth({
        appId: credentials.appId,
        installationId: credentials.installationId,
        privateKey: normalizeGitHubAppPrivateKey(credentials.privateKey),
        request,
      })
      return instance
    })

    // The git half, then the REST half -- the two call paths that must agree.
    // `authStrategy` is typed as returning `unknown` (Octokit only requires a
    // `.hook` on it); the cast is to the narrow shape this module guarantees.
    await auth.mintInstallationToken({ signal: AbortSignal.timeout(5000) })
    const forOctokit = auth.octokitAuth.authStrategy({}) as InstallationTokenMinter
    await forOctokit({ type: 'installation' })

    expect(calls).toHaveLength(1)
  })

  it('does not construct the strategy until a member is actually used', () => {
    // Load-bearing, not an optimisation: `normalizeGitHubAppPrivateKey` and
    // `createAppAuth` both throw synchronously on the likeliest operator
    // mistakes, and the AWS entrypoint builds this in main() -- BEFORE
    // worker.start(), whose catch is the only thing that writes
    // lastFatalError to worker-status.json. Eager construction would make an
    // unparseable key an invisible 5s systemd crash-loop that `cdk deploy`
    // reports as success. Deferred, the throw lands inside start()'s try.
    expect(() => buildGitHubAppAuth({ ...credentials, privateKey: 'not a key' })).not.toThrow()
  })

  it('throws when a member is used, naming the key', async () => {
    const auth = buildGitHubAppAuth({ ...credentials, privateKey: 'not a key' })
    await expect(auth.mintInstallationToken({ signal: AbortSignal.timeout(1000) })).rejects.toThrow(
      /GitHub App private key could not be parsed/,
    )
  })

  it('rejects a non-numeric app id when used, not silently', async () => {
    // `createAppAuth` refuses this at construction ("appId option must be a
    // number or numeric string"). Reaching it at all is what the deferral is
    // for; CanopyCmsService also refuses it at synth.
    const auth = buildGitHubAppAuth({ ...credentials, appId: 'my-app-slug' })
    await expect(auth.mintInstallationToken({ signal: AbortSignal.timeout(1000) })).rejects.toThrow(
      /appId/,
    )
  })

  it('memoizes, so the deferral does not become a second instance per call', () => {
    // A plain lazy getter would be `authStrategy: createAppAuth` by another
    // name -- a fresh instance, and a fresh token cache, on every call.
    const { octokitAuth } = buildGitHubAppAuth(credentials)
    expect(octokitAuth.authStrategy({})).toBe(octokitAuth.authStrategy({ request: {} }))
  })

  // No test here that a mangled key is "accepted end to end" by checking
  // `authStrategy` does not throw. Measured: `createAppAuth` does not inspect
  // the private key at construction at all, so that assertion passes with the
  // normalizer removed entirely -- it pins nothing. What buildGitHubAppAuth
  // hands to createAppAuth is checked directly, by reading it, in
  // github-app-auth-wiring.test.ts.
})
