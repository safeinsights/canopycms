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
 */

import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { createAppAuth } from '@octokit/auth-app'
import { normalizeGitHubAppPrivateKey } from 'canopycms/worker/cms-worker'

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
