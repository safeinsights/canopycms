/**
 * Builds the GitHub App credential the EC2 worker authenticates with.
 *
 * Lives in `canopycms-cdk`, NOT in `canopycms` core, for the same reason
 * `secrets.ts` does: `@octokit/auth-app` must not enter core's dependency
 * graph. `github-service.ts` is reachable from `services.ts`, so it ships in
 * every adopter's server bundle, and `pnpm lint:bundle` checks the *client*
 * boundary only — it would not catch the weight. Core therefore accepts a
 * structurally-typed `GitHubAppAuth` and this file supplies one. An adopter on
 * another cloud writes their own equivalent; `docs/adopter-migration.md`
 * carries the same wiring for that case.
 *
 * Split out of `index.ts` so it can be imported by a test at all: `index.ts`
 * ends in `main().catch(...)`, so importing it RUNS the worker.
 */

import { createAppAuth } from '@octokit/auth-app'
import { normalizeGitHubAppPrivateKey, type GitHubAppAuth } from 'canopycms/worker/cms-worker'

/**
 * The one thing this module needs from an `@octokit/auth-app` instance.
 *
 * Narrower than `AuthInterface` on purpose: it is what makes the single-instance
 * contract below testable with an ordinary spy, instead of a fake that has to
 * satisfy every overload of the real strategy.
 */
export type InstallationTokenMinter = (options: {
  type: 'installation'
}) => Promise<{ token: string }>

/** What GitHub gives you when you register an App and install it. */
export interface GitHubAppCredentials {
  /** The App's own ID, from its settings page. */
  appId: string
  /** The ID of THIS installation of the App — not the App ID. */
  installationId: string
  /** The PEM as configured, before normalization. */
  privateKey: string
}

/**
 * Derive both facets of the worker's App credential from ONE auth instance.
 *
 * **The single instance is the whole point of this function.** That instance
 * holds `@octokit/auth-app`'s installation-token cache — an LRU refreshed only
 * within ~60s of expiry — so sharing it is what keeps the REST half (Octokit)
 * and the git half (the credential in the remote URL) on the same hourly token.
 * Two instances would each mint and cache their own, doubling the calls to the
 * installation-token endpoint and putting two distinct live tokens in flight
 * for one worker.
 *
 * Hence both members reaching the instance through `resolveAppAuth` — one
 * provider, one object. Passing `authStrategy: createAppAuth` instead reads as
 * the obvious thing and is the mistake this exists to prevent: Octokit would
 * call that factory itself and build a SECOND instance, with its own separate
 * cache. The two spellings are indistinguishable at a glance and behave
 * identically until you look at the token count, which is why
 * `github-app-auth.test.ts` pins the identity as well as the mint count.
 *
 * `resolveAppAuth` is a FUNCTION rather than the instance itself so that
 * `buildGitHubAppAuth` below can defer construction — see its comment for why
 * that placement is load-bearing. It must return the same object every call;
 * that is the caller's obligation and is what the identity tests check.
 */
export function gitHubAppAuthFrom(resolveAppAuth: () => InstallationTokenMinter): GitHubAppAuth {
  return {
    // The `signal` core passes is deliberately dropped: `@octokit/auth-app@6`
    // accepts no per-call signal, so there is nothing to forward it to. Core
    // documents this (`GitHubAppAuth.mintInstallationToken` in
    // packages/canopycms/src/worker/github-auth.ts) and bounds the wait itself
    // with `Promise.race` against the same signal, so the timeout still holds —
    // the mint is abandoned rather than aborted.
    mintInstallationToken: async () => (await resolveAppAuth()({ type: 'installation' })).token,
    // NOT `authStrategy: createAppAuth`. See above.
    octokitAuth: { authStrategy: () => resolveAppAuth(), auth: {} },
  }
}

/**
 * Build the worker's App credential from the values its environment carries.
 *
 * **Construction is deferred to first use, and that is not an optimisation.**
 * Both `normalizeGitHubAppPrivateKey` and `createAppAuth` throw synchronously on
 * the likeliest operator mistakes — a PEM that is really an unread JSON
 * document, a truncated key, an App *slug* or `Iv1.…` client id where the
 * numeric app id belongs (`createAppAuth` rejects a non-numeric `appId` at
 * construction). Building eagerly in the entrypoint's `main()` would put those
 * throws BEFORE `worker.start()`, where the AWS entrypoint's `main().catch()`
 * only logs and exits: an invisible ~5s systemd crash-loop that `cdk deploy`
 * reports as success, with the admin panel showing the worker absent and no
 * `lastFatalError` to explain it. That is the shipped regression (#198) that
 * `CmsWorker.ensureGitHubAuth()` and `preflightGitHubAppAuth()` exist to
 * prevent, and eager construction here would have walked straight back into it
 * on the one failure mode those two cannot otherwise see.
 *
 * Deferred, the first touch of either member happens inside `start()`'s try —
 * `ensureGitHubAuth()` builds the Octokit client (which calls `authStrategy`),
 * and `preflightGitHubAppAuth()` mints — so the throw is recorded in
 * `worker-status.json` with its message intact.
 *
 * Memoized, because the single-instance contract above is exactly what a plain
 * lazy getter would break: `createAppAuth` per call is `authStrategy:
 * createAppAuth` by another name.
 *
 * The private key is normalized inside the same closure so that every path into
 * `createAppAuth` gets it: a key that arrived `\n`-escaped or base64-wrapped
 * through a single-line config field still works, and an unusable one fails
 * naming the key rather than as an opaque JWT signing error at the first push.
 */
export function buildGitHubAppAuth(credentials: GitHubAppCredentials): GitHubAppAuth {
  let appAuth: InstallationTokenMinter | undefined
  return gitHubAppAuthFrom(() => {
    appAuth ??= createAppAuth({
      appId: credentials.appId,
      installationId: credentials.installationId,
      privateKey: normalizeGitHubAppPrivateKey(credentials.privateKey),
    })
    return appAuth
  })
}
