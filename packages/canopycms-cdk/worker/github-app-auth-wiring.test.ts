/**
 * What `buildGitHubAppAuth` hands to `@octokit/auth-app` — how many times, and
 * with what key.
 *
 * A SEPARATE file from `github-app-auth.test.ts` because `vi.mock` is
 * file-scoped and that file needs the genuine `createAppAuth`: it checks the
 * normalizer against the real signer, which a counting wrapper would not be.
 * Here the wrapper is the point.
 *
 * Both properties below were found unguarded by review round 2, which mutated
 * them and watched the whole suite stay green:
 *
 * - **One instance, shared.** The earlier tests compared `authStrategy({})` to
 *   `authStrategy({…})` — one member against itself — so splitting the memo in
 *   two, one instance per member, was invisible. That split IS the regression
 *   the module exists to prevent: two token caches, two live tokens, double the
 *   mints.
 * - **The key is normalized.** `createAppAuth` does not inspect the private key
 *   at construction (measured), so every "does not throw" assertion about a
 *   mangled key passes with the normalizer removed. The failure is deferred to
 *   mint time, which no offline test reaches. Counting the call and reading the
 *   key it was given is what actually pins it.
 *
 * `vi.mock` with `importOriginal` is this package's existing idiom — see
 * `secrets.test.ts`, which wraps the Secrets Manager client the same way. The
 * real `createAppAuth` still runs underneath, so the returned object is a real
 * auth instance and `.hook` below is the real one Octokit dereferences.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'

// `vi.mock` factories are hoisted above the imports, so the spy has to be
// created in a `vi.hoisted` block to exist by the time the factory runs.
const { createAppAuthSpy } = vi.hoisted(() => ({ createAppAuthSpy: vi.fn() }))

vi.mock('@octokit/auth-app', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@octokit/auth-app')>()
  return {
    ...actual,
    createAppAuth: (options: Parameters<typeof actual.createAppAuth>[0]) => {
      createAppAuthSpy(options)
      return actual.createAppAuth(options)
    },
  }
})

import { buildGitHubAppAuth } from './github-app-auth'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
/** The format GitHub actually hands out when you download an App key. */
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

const credentials = { appId: '12345', installationId: '67890', privateKey: pkcs1 }

/**
 * Touch BOTH members, which is the only way the split shows up. The mint is
 * expected to fail — there is no network and no fake `request` here — and that
 * is fine: `createAppAuth` has already been called by then, which is what is
 * being counted.
 */
async function useBothMembers(auth: ReturnType<typeof buildGitHubAppAuth>): Promise<void> {
  auth.octokitAuth.authStrategy({})
  await auth.mintInstallationToken({ signal: AbortSignal.timeout(1000) }).catch(() => undefined)
}

describe('buildGitHubAppAuth: what reaches createAppAuth', () => {
  beforeEach(() => createAppAuthSpy.mockClear())

  it('constructs exactly ONE instance across both members', async () => {
    await useBothMembers(buildGitHubAppAuth(credentials))

    // Two would mean two installation-token caches and two live tokens for one
    // worker -- the REST half and the git half disagreeing about which token
    // they hold, and double the calls to the installation-token endpoint.
    expect(createAppAuthSpy).toHaveBeenCalledTimes(1)
  })

  it('hands it a PKCS#8 key, not the PKCS#1 one GitHub issued', async () => {
    await useBothMembers(buildGitHubAppAuth(credentials))

    const options = createAppAuthSpy.mock.calls[0][0] as { privateKey: string }
    expect(options.privateKey).toContain('-----BEGIN PRIVATE KEY-----')
    expect(options.privateKey).not.toContain('-----BEGIN RSA PRIVATE KEY-----')
  })

  it('normalizes an escaped, base64-wrapped key before it gets there', async () => {
    // The shape an App key comes back in from a JSON secret field -- which is
    // exactly what githubAppPrivateKeySecretJsonField exists for. Unnormalized,
    // createAppAuth accepts it without complaint at construction and the worker
    // fails at its first push with "secretOrPrivateKey must be an asymmetric
    // key when using RS256", hours later and nowhere near the cause.
    const mangled = Buffer.from(pkcs1.trimEnd().replace(/\n/g, '\\n'), 'utf8').toString('base64')
    expect(mangled).not.toContain('BEGIN')

    await useBothMembers(buildGitHubAppAuth({ ...credentials, privateKey: mangled }))

    const options = createAppAuthSpy.mock.calls[0][0] as { privateKey: string }
    expect(options.privateKey).toContain('-----BEGIN PRIVATE KEY-----')
  })

  it('passes both identifiers through unchanged', async () => {
    await useBothMembers(buildGitHubAppAuth(credentials))

    expect(createAppAuthSpy.mock.calls[0][0]).toMatchObject({
      appId: '12345',
      installationId: '67890',
    })
  })

  it('returns a real auth instance, carrying the .hook Octokit dereferences', () => {
    // `new Octokit({ authStrategy })` does `hook.wrap('request', auth.hook)`
    // immediately after calling the strategy (@octokit/core@5). A provider
    // returning a bare async function typechecks against
    // InstallationTokenMinter and then throws "Cannot read properties of
    // undefined (reading 'bind')" from inside start().
    const strategy = buildGitHubAppAuth(credentials).octokitAuth.authStrategy({})
    expect(strategy).toHaveProperty('hook')
  })
})
