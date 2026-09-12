/**
 * Unit tests for the worker's GitHub credential resolution (github-auth.ts):
 * which of the two auth shapes is in play, how an installation token is
 * minted, and how a GitHub App private key is normalized.
 *
 * Keys are GENERATED here rather than committed as fixtures — a file that
 * looks like a private key is a file someone eventually treats as one.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  DEFAULT_GIT_TOKEN_MINT_TIMEOUT_MS,
  normalizeGitHubAppPrivateKey,
  resolveWorkerGitHubAuth,
  type GitHubAppAuth,
} from './github-auth'
import { isPermanentTaskFailure } from './task-runner'

/** An `@octokit/auth-app`-shaped injection whose mint is fully under test control. */
const appAuthWith = (
  mintInstallationToken: GitHubAppAuth['mintInstallationToken'],
): GitHubAppAuth => ({
  mintInstallationToken,
  octokitAuth: { authStrategy: () => ({ hook: () => {} }), auth: {} },
})

/** An Octokit `RequestError`-shaped rejection: an Error carrying `.status`. */
const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status })

describe('resolveWorkerGitHubAuth', () => {
  describe('exactly one credential', () => {
    it('accepts a token alone, and hands Octokit the bare token', async () => {
      const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_static' })

      expect(resolved.octokitAuth).toEqual({ auth: 'ghp_static' })
      expect(await resolved.resolveGitToken()).toBe('ghp_static')
    })

    it('accepts a GitHub App alone, and hands Octokit the auth strategy', async () => {
      const app = appAuthWith(async () => 'ghs_minted')
      const resolved = resolveWorkerGitHubAuth({ githubAppAuth: app })

      expect(resolved.octokitAuth).toBe(app.octokitAuth)
      expect(await resolved.resolveGitToken()).toBe('ghs_minted')
    })

    it('rejects both together, naming the ambiguity', () => {
      expect(() =>
        resolveWorkerGitHubAuth({
          githubToken: 'ghp_static',
          githubAppAuth: appAuthWith(async () => 'ghs_minted'),
        }),
      ).toThrow(/either githubToken or githubAppAuth, not both/)
    })

    it('rejects neither, naming the token as the default', () => {
      expect(() => resolveWorkerGitHubAuth({})).toThrow(/githubToken or githubAppAuth is required/)
    })

    it('treats an empty token as absent rather than as a credential', () => {
      // Otherwise `githubToken: process.env.X ?? ''` would build a worker that
      // pushes to `https://x-access-token:@github.com/...` and gets an
      // anonymous 403 with nothing in it about the credential.
      expect(() => resolveWorkerGitHubAuth({ githubToken: '' })).toThrow(/is required/)
    })
  })

  describe('the token path stands alone', () => {
    it('keeps @octokit/auth-app out of canopycms entirely', async () => {
      // github-service.ts is reachable from services.ts, so a dependency
      // declared here lands in every adopter's Next.js server bundle --
      // including everyone on a personal access token, which is most of them.
      // `pnpm lint:bundle` guards the CLIENT boundary only and would not
      // notice. The App-side dependency belongs to canopycms-cdk, whose
      // worker entrypoint constructs the strategy and injects it.
      const manifest = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf-8'),
      ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }

      // Non-vacuous: the manifest really was read and really does declare the
      // Octokit packages core does use.
      expect(Object.keys(manifest.dependencies ?? {})).toContain('@octokit/rest')
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@octokit/auth-app')
      expect(Object.keys(manifest.peerDependencies ?? {})).not.toContain('@octokit/auth-app')
    })

    it('never touches GitHub App machinery when no App auth is injected', async () => {
      // The regression guard for the majority case: core imports nothing from
      // `@octokit/auth-app` (it is not even a dependency of this package), so
      // a token-configured worker must resolve without any of it present.
      const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_static' })

      expect(await resolved.resolveGitToken()).toBe('ghp_static')
      expect(await resolved.resolveGitToken()).toBe('ghp_static')
    })
  })

  describe('installation-token minting', () => {
    it('mints again on every call, so nothing can hold a stale hourly token', async () => {
      // Varied ACROSS separate calls, never within one: a single
      // pushBranchToGitHub resolves exactly once by design (pinned in
      // cms-worker.test.ts), and this is the complementary half — that
      // separate uses do not share a cached value.
      let minted = 0
      const resolved = resolveWorkerGitHubAuth({
        githubAppAuth: appAuthWith(async () => `ghs_token_${++minted}`),
      })

      expect(await resolved.resolveGitToken()).toBe('ghs_token_1')
      expect(await resolved.resolveGitToken()).toBe('ghs_token_2')
      expect(minted).toBe(2)
    })

    it('propagates a mint failure AS THROWN, with its HTTP status intact', async () => {
      // The defect this pins: a `catch` that rethrew
      // `new Error(getErrorMessage(err))` would drop `.status`, and
      // isPermanentTaskFailure would then classify every mint failure --
      // including a permanently bad key -- as transient and retry it.
      const thrown = httpError(401, 'A JSON web token could not be decoded')
      const resolved = resolveWorkerGitHubAuth({
        githubAppAuth: appAuthWith(async () => {
          throw thrown
        }),
      })

      const caught = await resolved.resolveGitToken().catch((err: unknown) => err)

      expect(caught).toBe(thrown)
      expect((caught as { status?: unknown }).status).toBe(401)
    })

    it('classifies a 401 mint failure as permanent', async () => {
      const resolved = resolveWorkerGitHubAuth({
        githubAppAuth: appAuthWith(async () => {
          throw httpError(401, 'Bad credentials')
        }),
      })

      const caught = await resolved.resolveGitToken().catch((err: unknown) => err)

      expect(getErrorLike(caught).message).toContain('Bad credentials')
      expect(isPermanentTaskFailure(caught)).toBe(true)
    })

    it('classifies a 503 mint failure as transient', async () => {
      const resolved = resolveWorkerGitHubAuth({
        githubAppAuth: appAuthWith(async () => {
          throw httpError(503, 'Service unavailable')
        }),
      })

      const caught = await resolved.resolveGitToken().catch((err: unknown) => err)

      expect(getErrorLike(caught).message).toContain('Service unavailable')
      expect(isPermanentTaskFailure(caught)).toBe(false)
    })

    it('rejects an empty minted token instead of building an anonymous URL', async () => {
      const resolved = resolveWorkerGitHubAuth({
        githubAppAuth: appAuthWith(async () => ''),
      })

      await expect(resolved.resolveGitToken()).rejects.toThrow(/empty installation token/)
    })

    it('gives up on a mint that never settles, and aborts the signal it handed out', async () => {
      // The bound lives here rather than on the task's AbortSignal: git-sync's
      // two resolutions never pass through executeTaskWithTimeout at all, so
      // without this a hung mint would stall the sync loop indefinitely.
      let handed: AbortSignal | undefined
      const resolved = resolveWorkerGitHubAuth({
        gitTokenMintTimeoutMs: 25,
        githubAppAuth: appAuthWith(({ signal }) => {
          handed = signal
          return new Promise<string>(() => {})
        }),
      })

      await expect(resolved.resolveGitToken()).rejects.toThrow(/not minted within 25ms/)
      expect(handed?.aborted).toBe(true)
    })

    it('defaults the mint timeout to 30s', () => {
      expect(DEFAULT_GIT_TOKEN_MINT_TIMEOUT_MS).toBe(30_000)
    })

    it('does not time out a mint that answers promptly', async () => {
      const resolved = resolveWorkerGitHubAuth({
        gitTokenMintTimeoutMs: 1_000,
        githubAppAuth: appAuthWith(async () => 'ghs_prompt'),
      })

      expect(await resolved.resolveGitToken()).toBe('ghs_prompt')
    })

    it('leaves no unhandled rejection behind when the timeout wins the race', async () => {
      // The losing mint settles after the race is decided. Without the
      // `minting.catch(() => {})` guard that is an unhandled rejection, which
      // vitest reports separately from the pass count and CI treats as a
      // failure.
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const resolved = resolveWorkerGitHubAuth({
          gitTokenMintTimeoutMs: 10,
          githubAppAuth: appAuthWith(
            () =>
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('mint failed late')), 40),
              ),
          ),
        })

        await expect(resolved.resolveGitToken()).rejects.toThrow(/not minted within 10ms/)
        await new Promise((r) => setTimeout(r, 100))
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })
  })
})

describe('normalizeGitHubAppPrivateKey', () => {
  let key: KeyObject
  let pkcs1: string
  let pkcs8: string

  beforeAll(() => {
    key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    pkcs1 = key.export({ type: 'pkcs1', format: 'pem' }).toString()
    pkcs8 = key.export({ type: 'pkcs8', format: 'pem' }).toString()
  })

  /** The same key, expressed the way `universal-github-app-jwt` needs it. */
  const expectIsTheKeyInPkcs8 = (normalized: string) => {
    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----')
    expect(normalized).not.toContain('BEGIN RSA PRIVATE KEY')
    // Same key material, not merely a well-formed one.
    expect(createPrivateKey(normalized).export({ type: 'pkcs8', format: 'pem' })).toBe(pkcs8)
  }

  it('converts the PKCS#1 PEM GitHub actually issues', () => {
    // The landmine: GitHub hands out `BEGIN RSA PRIVATE KEY`, and
    // universal-github-app-jwt's WebCrypto path reads only PKCS#8.
    expect(pkcs1).toContain('-----BEGIN RSA PRIVATE KEY-----')
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(pkcs1))
  })

  it('passes a PKCS#8 PEM through unchanged in substance', () => {
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(pkcs8))
  })

  it('accepts a key whose newlines are literal \\n escapes', () => {
    const escaped = pkcs1.trimEnd().replace(/\n/g, '\\n')
    expect(escaped).not.toContain('\n')
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(escaped))
  })

  it('accepts a key whose newlines are literal \\r\\n escapes', () => {
    const escaped = pkcs1.trimEnd().replace(/\n/g, '\\r\\n')
    expect(escaped).not.toContain('\n')
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(escaped))
  })

  it('accepts a base64-wrapped PEM', () => {
    const wrapped = Buffer.from(pkcs1, 'utf8').toString('base64')
    expect(wrapped).not.toContain('BEGIN')
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(wrapped))
  })

  it('accepts a base64-wrapped PEM that was line-wrapped', () => {
    const wrapped = Buffer.from(pkcs8, 'utf8')
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
    expect(wrapped).toContain('\n')
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(wrapped))
  })

  it('tolerates surrounding whitespace', () => {
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(`\n  ${pkcs8.trim()}\n  `))
  })

  it('throws a key-shaped error on something that is not a key', () => {
    expect(() => normalizeGitHubAppPrivateKey('not-a-key')).toThrow(
      /GitHub App private key could not be parsed/,
    )
  })

  it('throws on a truncated PEM rather than handing it on', () => {
    const truncated = pkcs1.split('\n').slice(0, 3).join('\n')
    expect(truncated).toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(() => normalizeGitHubAppPrivateKey(truncated)).toThrow(
      /GitHub App private key could not be parsed/,
    )
  })

  it('throws on a public key, which is the easiest wrong file to grab', () => {
    const publicPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString()

    expect(() => normalizeGitHubAppPrivateKey(publicPem)).toThrow(
      /GitHub App private key could not be parsed/,
    )
  })
})

/** Narrow a caught `unknown` for message assertions without an `any`. */
function getErrorLike(err: unknown): { message: string } {
  expect(err).toBeInstanceOf(Error)
  return err as Error
}
