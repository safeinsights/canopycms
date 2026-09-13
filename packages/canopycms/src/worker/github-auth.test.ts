/**
 * Unit tests for the worker's GitHub credential resolution (github-auth.ts):
 * which of the two auth shapes is in play, how an installation token is
 * minted, and how a GitHub App private key is normalized.
 *
 * Keys are GENERATED here rather than committed as fixtures — a file that
 * looks like a private key is a file someone eventually treats as one.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { createTokenAuth } from '@octokit/auth-token'

import {
  DEFAULT_GIT_TOKEN_MINT_TIMEOUT_MS,
  DEFAULT_GITHUB_TOKEN_REFRESH_MIN_INTERVAL_MS,
  MintTimeoutError,
  isTransientAuthFailure,
  normalizeGitHubAppPrivateKey,
  resolveWorkerGitHubAuth,
  type GitHubAppAuth,
} from './github-auth'
import type { OctokitAuthStrategyOptions } from '../github-service'
import { isPermanentTaskFailure } from './task-runner'

type TokenAuthHook = ReturnType<typeof createTokenAuth>['hook']

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

/**
 * Drive a resolution's Octokit auth the way Octokit does, and report the
 * `authorization` header it produced.
 *
 * This is how every token-path assertion below is made, and the indirection is
 * the point: the header is what GitHub sees, and it is the only thing that
 * stays constant across a change in how the token reaches Octokit. Asserting
 * the shape of `octokitAuth` instead pins an implementation detail, which is
 * exactly what had to be rewritten when the token path gained a strategy.
 *
 * `@octokit/auth-token`'s hook does `request.endpoint.merge(route, parameters)`,
 * sets `endpoint.headers.authorization`, then calls `request(endpoint)` — so a
 * `request` stub carrying an `endpoint.merge` observes the real thing.
 */
async function authorizationHeaderFrom(resolved: {
  octokitAuth: unknown
}): Promise<string | undefined> {
  const auth = resolved.octokitAuth as OctokitAuthStrategyOptions
  let sent: { headers: Record<string, string> } | undefined
  const request = Object.assign(
    async (endpoint: { headers: Record<string, string> }) => {
      sent = endpoint
      return { status: 200 }
    },
    { endpoint: { merge: () => ({ headers: {} as Record<string, string> }) } },
  ) as unknown as Parameters<TokenAuthHook>[0]

  const strategy = auth.authStrategy({}) as { hook: TokenAuthHook }
  await strategy.hook(request, 'GET /user')
  return sent?.headers.authorization
}

describe('resolveWorkerGitHubAuth', () => {
  describe('exactly one credential', () => {
    it('accepts a token alone, and authenticates Octokit as that token', async () => {
      const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_static' })

      // Asserted through what Octokit actually sends, not as
      // `{ auth: 'ghp_static' }`. The token path used to hand Octokit the bare
      // string; it now hands over a strategy that reads the token per request,
      // so that a rotation reaches a client already built (see
      // dynamicTokenAuth). The header is the behaviour either spelling owes,
      // and it is unchanged.
      expect(await authorizationHeaderFrom(resolved)).toBe('token ghp_static')
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
      // notice. The App-side dependency belongs to canopycms-cdk
      // (package.json devDependencies), whose worker constructs and injects the
      // strategy -- see packages/canopycms-cdk/worker/github-app-auth.ts.
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

    it.each([NaN, 0, -1, Infinity, 0.5, 2 ** 31, 2 ** 32])(
      'refuses a mint timeout that is not a usable delay (%s)',
      (bad) => {
        // Measured against Node 24, not assumed: AbortSignal.timeout throws a
        // RangeError for NaN, negatives, Infinity, a non-integer (0.5) and
        // anything above 2**32-1, and it SILENTLY clamps 2**31 .. 2**32-1 to
        // 1ms -- which would abort every mint instantly while reporting the
        // configured size. The throwing cases would throw INSIDE the mint,
        // where the rejection has no `.status`, so the task path would read a
        // config typo as transient and burn every push's full retry budget.
        // An environment variable through `parseInt` is NaN when unset, which
        // is how such a value arrives.
        //
        // 0 is the one value here AbortSignal.timeout does accept (it fires
        // immediately). We reject it anyway: a 0ms budget aborts every mint
        // before it can start, which is a config error however Node treats it.
        expect(() =>
          resolveWorkerGitHubAuth({
            gitTokenMintTimeoutMs: bad,
            githubAppAuth: appAuthWith(async () => 'ghs_minted'),
          }),
        ).toThrow(/gitTokenMintTimeoutMs must be a whole number of milliseconds/)
      },
    )

    it('checks the mint timeout on the token path too', () => {
      // It is ignored there, but a nonsense value is still a config error
      // worth naming rather than silently accepting.
      expect(() =>
        resolveWorkerGitHubAuth({ githubToken: 'ghp_static', gitTokenMintTimeoutMs: -5 }),
      ).toThrow(/gitTokenMintTimeoutMs/)
    })

    it('accepts the largest timeout AbortSignal.timeout honours', () => {
      expect(() =>
        resolveWorkerGitHubAuth({
          gitTokenMintTimeoutMs: 2 ** 31 - 1,
          githubAppAuth: appAuthWith(async () => 'ghs_minted'),
        }),
      ).not.toThrow()
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
      // A PROPERTY test, not a mutation-pinned one, and the distinction is
      // worth stating because this test first shipped guarding a line that did
      // nothing: `Promise.race` subscribes a reject handler to every input, so
      // the losing mint's late rejection is already handled, and deleting the
      // `minting.catch(() => {})` that used to sit there left this green.
      // Measured, and the dead line is gone. What is still worth asserting is
      // the property itself -- an unhandled rejection here is reported by
      // vitest separately from the pass count and fails CI -- so a future
      // rewrite that stops racing would be caught.
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

  describe('refreshCredential', () => {
    /** A provider handing out each value in turn, then nothing. */
    const providerOf = (...values: (string | undefined)[]) => vi.fn(async () => values.shift())

    describe('the token path', () => {
      it('swaps a rotated token into BOTH consumers', async () => {
        const refreshGitHubToken = providerOf('ghp_rotated')
        const resolved = resolveWorkerGitHubAuth({
          githubToken: 'ghp_revoked',
          refreshGitHubToken,
        })

        expect(await resolved.resolveGitToken()).toBe('ghp_revoked')
        expect(await authorizationHeaderFrom(resolved)).toBe('token ghp_revoked')

        await resolved.refreshCredential()

        // Both halves of GitHub access, from the one resolution. The git half
        // would pass on its own if only `resolveGitToken` were rewired, which
        // is why the header is asserted too: Octokit is the half that used to
        // bake the token in at construction.
        expect(await resolved.resolveGitToken()).toBe('ghp_rotated')
        expect(await authorizationHeaderFrom(resolved)).toBe('token ghp_rotated')
      })

      it('reaches an Octokit client BUILT BEFORE the rotation', async () => {
        const refreshGitHubToken = providerOf('ghp_rotated')
        const resolved = resolveWorkerGitHubAuth({
          githubToken: 'ghp_revoked',
          refreshGitHubToken,
        })

        // The strategy is invoked ONCE, as Octokit invokes it once in its
        // constructor and then reuses the returned hook forever. This is the
        // property that lets CmsWorker refresh with nothing to rebuild -- and
        // the one a per-resolution assertion above cannot see, because it
        // builds a fresh strategy each time.
        const auth = resolved.octokitAuth as OctokitAuthStrategyOptions
        const strategy = auth.authStrategy({}) as { hook: TokenAuthHook }
        const headerVia = async (): Promise<string | undefined> => {
          let sent: { headers: Record<string, string> } | undefined
          const request = Object.assign(
            async (endpoint: { headers: Record<string, string> }) => {
              sent = endpoint
              return { status: 200 }
            },
            { endpoint: { merge: () => ({ headers: {} as Record<string, string> }) } },
          ) as unknown as Parameters<TokenAuthHook>[0]
          await strategy.hook(request, 'GET /user')
          return sent?.headers.authorization
        }

        expect(await headerVia()).toBe('token ghp_revoked')
        await resolved.refreshCredential()
        expect(await headerVia()).toBe('token ghp_rotated')
      })

      it('keeps the token when the provider reports nothing to do', async () => {
        const refreshGitHubToken = providerOf(undefined)
        const resolved = resolveWorkerGitHubAuth({
          githubToken: 'ghp_original',
          refreshGitHubToken,
        })

        await resolved.refreshCredential()

        expect(refreshGitHubToken).toHaveBeenCalledTimes(1)
        expect(await resolved.resolveGitToken()).toBe('ghp_original')
      })

      it('keeps the token rather than adopting an empty one', async () => {
        const resolved = resolveWorkerGitHubAuth({
          githubToken: 'ghp_original',
          refreshGitHubToken: providerOf(''),
        })

        await resolved.refreshCredential()

        // An empty token builds `https://x-access-token:@github.com/...`, which
        // git sends anonymously for a 403 that says nothing about the
        // credential. Keeping the known-bad-but-real token fails legibly.
        expect(await resolved.resolveGitToken()).toBe('ghp_original')
      })

      it('is a no-op when no provider is configured', async () => {
        const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_only' })

        await expect(resolved.refreshCredential()).resolves.toBeUndefined()
        expect(await resolved.resolveGitToken()).toBe('ghp_only')
      })

      it('compares against the ROTATED token on a second round', async () => {
        const refreshGitHubToken = providerOf('ghp_second', 'ghp_third')
        const resolved = resolveWorkerGitHubAuth({
          githubToken: 'ghp_first',
          refreshGitHubToken,
          // Two back-to-back refreshes are the point of this test, not the floor.
          refreshGitHubTokenMinIntervalMs: 0,
        })

        await resolved.refreshCredential()
        expect(await resolved.resolveGitToken()).toBe('ghp_second')
        await resolved.refreshCredential()
        expect(await resolved.resolveGitToken()).toBe('ghp_third')
      })

      describe('overlapping refreshes', () => {
        /** A provider result the test releases by hand, so a refresh can be made to land late. */
        const deferred = () => {
          let release!: (value: string | undefined) => void
          const promise = new Promise<string | undefined>((resolve) => (release = resolve))
          return { promise, release }
        }

        it('does not let a slow refresh that lands late put an older token back', async () => {
          // The first refresh read the store before the rotation and stalled;
          // the second started later, read the rotated value, and landed first.
          const slow = deferred()
          const refreshGitHubToken = vi
            .fn<() => Promise<string | undefined>>()
            .mockReturnValueOnce(slow.promise)
            .mockResolvedValueOnce('ghp_newest')
          const resolved = resolveWorkerGitHubAuth({
            githubToken: 'ghp_boot',
            refreshGitHubToken,
            // The overlap-ordering guard is the point of this test, not the floor.
            refreshGitHubTokenMinIntervalMs: 0,
          })

          const first = resolved.refreshCredential()
          await resolved.refreshCredential()
          expect(await resolved.resolveGitToken()).toBe('ghp_newest')

          slow.release('ghp_older')
          await first
          expect(await resolved.resolveGitToken()).toBe('ghp_newest')
        })

        it('still adopts a slow refresh when the newer one had nothing to report', async () => {
          // `undefined` from the newer call (a provider's floor) is not evidence
          // that the slower real read is stale, so it must still land.
          const slow = deferred()
          const refreshGitHubToken = vi
            .fn<() => Promise<string | undefined>>()
            .mockReturnValueOnce(slow.promise)
            .mockResolvedValueOnce(undefined)
          const resolved = resolveWorkerGitHubAuth({
            githubToken: 'ghp_boot',
            refreshGitHubToken,
            // The overlap-ordering guard is the point of this test, not the floor.
            refreshGitHubTokenMinIntervalMs: 0,
          })

          const first = resolved.refreshCredential()
          await resolved.refreshCredential()
          slow.release('ghp_rotated')
          await first

          expect(await resolved.resolveGitToken()).toBe('ghp_rotated')
        })
      })

      describe('the refresh floor', () => {
        afterEach(() => {
          vi.useRealTimers()
        })

        it('reaches the provider once for two back-to-back calls, under the default floor', async () => {
          const refreshGitHubToken = providerOf('ghp_rotated', 'ghp_would_be_second')
          const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_boot', refreshGitHubToken })

          await resolved.refreshCredential()
          await resolved.refreshCredential()

          expect(refreshGitHubToken).toHaveBeenCalledTimes(1)
          expect(await resolved.resolveGitToken()).toBe('ghp_rotated')
        })

        it('reaches the provider again once the clock has moved past the interval', async () => {
          vi.useFakeTimers({ toFake: ['Date'] })
          vi.setSystemTime(0)
          const refreshGitHubToken = providerOf('ghp_rotated', 'ghp_second_round')
          const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_boot', refreshGitHubToken })

          await resolved.refreshCredential()
          vi.setSystemTime(DEFAULT_GITHUB_TOKEN_REFRESH_MIN_INTERVAL_MS + 1)
          await resolved.refreshCredential()

          expect(refreshGitHubToken).toHaveBeenCalledTimes(2)
          expect(await resolved.resolveGitToken()).toBe('ghp_second_round')
        })

        it('treats a wall clock that stepped backwards as the floor having expired', async () => {
          // An NTP correction at boot, or a VM resume, can move Date.now() back.
          // Without the `now >= lastProviderReachedAt` check the negative
          // difference is always under the interval, so the floor stayed shut for
          // however far the clock stepped -- here, two hours.
          const tenHours = 10 * 60 * 60_000
          vi.useFakeTimers({ toFake: ['Date'] })
          vi.setSystemTime(tenHours)
          const refreshGitHubToken = providerOf('ghp_first', 'ghp_after_clock_step')
          const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_boot', refreshGitHubToken })

          await resolved.refreshCredential()
          vi.setSystemTime(tenHours - 2 * 60 * 60_000)
          await resolved.refreshCredential()

          expect(refreshGitHubToken).toHaveBeenCalledTimes(2)
          expect(await resolved.resolveGitToken()).toBe('ghp_after_clock_step')
        })

        it('collapses overlapping calls into a single provider call', async () => {
          // The second call starts before the first's provider promise settles --
          // the same shape as the "overlapping refreshes" tests above, but here
          // it is the FLOOR, not the start-order guard, that must collapse them.
          const deferred = () => {
            let release!: (value: string | undefined) => void
            const promise = new Promise<string | undefined>((resolve) => (release = resolve))
            return { promise, release }
          }
          const slow = deferred()
          const refreshGitHubToken = vi
            .fn<() => Promise<string | undefined>>()
            .mockReturnValueOnce(slow.promise)
          const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_boot', refreshGitHubToken })

          const first = resolved.refreshCredential()
          const second = resolved.refreshCredential()
          slow.release('ghp_rotated')
          await Promise.all([first, second])

          expect(refreshGitHubToken).toHaveBeenCalledTimes(1)
          expect(await resolved.resolveGitToken()).toBe('ghp_rotated')
        })

        it('lets every call through when the floor is disabled', async () => {
          const refreshGitHubToken = providerOf('ghp_a', 'ghp_b')
          const resolved = resolveWorkerGitHubAuth({
            githubToken: 'ghp_boot',
            refreshGitHubToken,
            refreshGitHubTokenMinIntervalMs: 0,
          })

          await resolved.refreshCredential()
          await resolved.refreshCredential()

          expect(refreshGitHubToken).toHaveBeenCalledTimes(2)
          expect(await resolved.resolveGitToken()).toBe('ghp_b')
        })

        it('stamps the floor even when the provider throws, so an immediate retry is skipped', async () => {
          const refreshGitHubToken = vi.fn(async () => {
            throw new Error('AccessDeniedException reading the secret')
          })
          const resolved = resolveWorkerGitHubAuth({ githubToken: 'ghp_boot', refreshGitHubToken })

          await expect(resolved.refreshCredential()).rejects.toThrow('AccessDeniedException')
          // Immediately after: within the floor, so this must not reach the
          // provider a second time even though the first call never succeeded.
          await resolved.refreshCredential()

          expect(refreshGitHubToken).toHaveBeenCalledTimes(1)
        })

        it.each([NaN, -1, 1.5])(
          'rejects a refresh interval that is not a usable delay (%s)',
          (bad) => {
            expect(() =>
              resolveWorkerGitHubAuth({
                githubToken: 'ghp_boot',
                refreshGitHubTokenMinIntervalMs: bad,
              }),
            ).toThrow(/refreshGitHubTokenMinIntervalMs must be a whole number of milliseconds/)
          },
        )

        it('accepts 0 as a valid refresh interval', () => {
          expect(() =>
            resolveWorkerGitHubAuth({
              githubToken: 'ghp_boot',
              refreshGitHubTokenMinIntervalMs: 0,
            }),
          ).not.toThrow()
        })
      })
    })

    describe('the GitHub App path', () => {
      it('never calls the provider — the strategy renews its own token on expiry', async () => {
        const refreshGitHubToken = providerOf('ghp_should_not_be_used')
        const resolved = resolveWorkerGitHubAuth({
          githubAppAuth: appAuthWith(async () => 'ghs_minted'),
          refreshGitHubToken,
        })

        await resolved.refreshCredential()

        // An App holds no token to re-read: its private key does not expire,
        // and `@octokit/auth-app`'s own cache mints a new installation token
        // when the old one expires. Calling the provider here would read a
        // GitHub-token secret this deployment does not even have.
        expect(refreshGitHubToken).not.toHaveBeenCalled()
      })

      it('still mints through the App after a refresh', async () => {
        const mint = vi.fn(async () => 'ghs_minted')
        const resolved = resolveWorkerGitHubAuth({
          githubAppAuth: appAuthWith(mint),
          refreshGitHubToken: providerOf('ghp_should_not_be_used'),
        })

        await resolved.refreshCredential()

        expect(await resolved.resolveGitToken()).toBe('ghs_minted')
      })
    })
  })
})

describe('isTransientAuthFailure', () => {
  // The inverse of isPermanentTaskFailure, deliberately: that one defaults an
  // error with NO status to transient (right on the task path, where
  // maxRetries bounds it), and the boot-time credential check is bounded by
  // nothing, so it must default the other way.
  it('calls a status-less failure PERMANENT, where the task classifier calls it transient', () => {
    // The measured real case: a key of the wrong TYPE makes
    // @octokit/auth-app@6.1.4 throw from jsonwebtoken with no status, because
    // the JWT is signed locally and the request never leaves the box. (A valid
    // RSA key belonging to a DIFFERENT app is not this case -- it signs fine
    // and GitHub refuses it with a 401, which carries a status.)
    const wrongKey = new Error('"alg" parameter for "ec" key type must be one of: ES256, ES384')

    expect(isTransientAuthFailure(wrongKey)).toBe(false)
    // The divergence is the point, so assert it rather than implying it.
    expect(isPermanentTaskFailure(wrongKey)).toBe(false)
  })

  it.each([500, 502, 503, 408, 429])('calls %s transient', (status) => {
    expect(isTransientAuthFailure(httpError(status, 'later'))).toBe(true)
  })

  it.each([400, 401, 403, 404, 422])('calls %s permanent', (status) => {
    expect(isTransientAuthFailure(httpError(status, 'no'))).toBe(false)
  })

  it('calls a plain 403 permanent, unlike the task classifier', () => {
    // At boot a 403 from the installation-token endpoint is a suspended or
    // uninstalled app far more often than a rate limit -- a worker that has
    // issued no requests yet is not the one being throttled -- and exiting is
    // recoverable by systemd where booting on a dead credential is not.
    expect(isTransientAuthFailure(httpError(403, 'Resource not accessible'))).toBe(false)
  })

  it.each(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'])(
    'calls the network errno %s transient',
    (code) => {
      expect(isTransientAuthFailure(Object.assign(new Error('socket'), { code }))).toBe(true)
    },
  )

  it('finds the errno one level down in `cause`, where fetch actually puts it', () => {
    // Measured on Node 24: a fetch() DNS failure is `TypeError: fetch failed`
    // whose own `.code` is undefined and whose `.cause.code` is ENOTFOUND.
    // Reading only the top level called that permanent and would kill a
    // booting worker over a DNS blip.
    const fetchFailed = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    })

    expect(isTransientAuthFailure(fetchFailed)).toBe(true)
  })

  it('does not treat an unrecognised errno in `cause` as transient', () => {
    const wrapped = Object.assign(new Error('boom'), {
      cause: Object.assign(new Error('denied'), { code: 'EACCES' }),
    })

    expect(isTransientAuthFailure(wrapped)).toBe(false)
  })

  it('calls an unrecognised errno permanent', () => {
    expect(isTransientAuthFailure(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe(false)
  })

  it('calls our own mint timeout transient', () => {
    expect(isTransientAuthFailure(new MintTimeoutError(30_000))).toBe(true)
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

  /** Break base64 into 64-column lines, the way every base64 CLI emits it. */
  const lineWrap = (b64: string) => (b64.match(/.{1,64}/g) ?? []).join('\n')

  it('converts the PKCS#1 PEM GitHub actually issues', () => {
    // GitHub hands out `BEGIN RSA PRIVATE KEY`. At the pin we install this
    // still signs (see normalizeGitHubAppPrivateKey's comment -- measured),
    // but only because esbuild's `--platform=node` reaches the jsonwebtoken
    // build; the WebCrypto build of the same package rejects PKCS#1 outright.
    // Converting decouples us from that resolution.
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

  it('accepts a PEM that was \\n-escaped and THEN base64-wrapped', () => {
    // The two manglings compose, in either order, and each hides the other:
    // the escapes here are inside the encoded bytes, so unescaping before the
    // unwrap does nothing and the decoded PEM still has literal backslash-n.
    const wrapped = Buffer.from(pkcs1.trimEnd().replace(/\n/g, '\\n'), 'utf8').toString('base64')
    expect(wrapped).not.toContain('BEGIN')
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(wrapped))
  })

  it('accepts a PEM that was base64-wrapped and THEN \\n-escaped', () => {
    // The other order: the escapes are on the base64 itself, which stops it
    // even being recognised as base64 until they are undone.
    //
    // The trailing newline is explicit, not incidental. `base64 -w 64` and
    // friends end their output with one, and once escaped and unescaped it
    // leaves a real newline AFTER the `=` padding -- which the base64 shape
    // test is anchored past. Letting the line-wrapping decide whether one
    // appears makes it depend on the generated key's length: measured, a
    // version of this test without the explicit `\n` passed against an
    // implementation that does not re-trim between the two passes.
    const wrapped = (lineWrap(Buffer.from(pkcs1, 'utf8').toString('base64')) + '\n').replace(
      /\n/g,
      '\\n',
    )
    expect(wrapped.endsWith('\\n')).toBe(true)
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(wrapped))
  })

  it('accepts a base64-wrapped PEM that was line-wrapped', () => {
    const wrapped = lineWrap(Buffer.from(pkcs8, 'utf8').toString('base64'))
    expect(wrapped).toContain('\n')
    expectIsTheKeyInPkcs8(normalizeGitHubAppPrivateKey(wrapped))
  })

  it('accepts a base64 wrapping that ends in a newline, as base64(1) emits', () => {
    const wrapped = lineWrap(Buffer.from(pkcs1, 'utf8').toString('base64')) + '\n'
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
