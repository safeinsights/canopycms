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
type InstallationTokenMinter = (options: { type: 'installation' }) => Promise<{ token: string }>

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
 * Hence `authStrategy: () => appAuth` — a closure returning the instance we
 * already have. Passing `authStrategy: createAppAuth` instead reads as the
 * obvious thing and is the mistake this exists to prevent: Octokit would call
 * that factory itself and build a SECOND instance, with its own separate cache.
 * The two spellings are indistinguishable at a glance and behave identically
 * until you look at the token count, which is why `github-app-auth.test.ts`
 * pins the identity rather than the behaviour.
 *
 * Taking the instance as a parameter, rather than constructing it here, is what
 * lets that test assert the identity with a plain spy.
 */
export function gitHubAppAuthFrom(appAuth: InstallationTokenMinter): GitHubAppAuth {
  return {
    // The `signal` core passes is deliberately dropped: `@octokit/auth-app@6`
    // accepts no per-call signal, so there is nothing to forward it to. Core
    // documents this (`GitHubAppAuth.mintInstallationToken` in
    // packages/canopycms/src/worker/github-auth.ts) and bounds the wait itself
    // with `Promise.race` against the same signal, so the timeout still holds —
    // the mint is abandoned rather than aborted.
    mintInstallationToken: async () => (await appAuth({ type: 'installation' })).token,
    // NOT `authStrategy: createAppAuth`. See above.
    octokitAuth: { authStrategy: () => appAuth, auth: {} },
  }
}

/**
 * Build the worker's App credential from the values its environment carries.
 *
 * The private key is normalized here rather than at the call site so that every
 * path into `createAppAuth` gets it: a key that arrived `\n`-escaped or
 * base64-wrapped through a single-line config field still works, and one that
 * is unusable throws HERE — where the key is configured, naming the key —
 * instead of surfacing later as an opaque JWT signing failure at the first push.
 */
export function buildGitHubAppAuth(credentials: GitHubAppCredentials): GitHubAppAuth {
  return gitHubAppAuthFrom(
    createAppAuth({
      appId: credentials.appId,
      installationId: credentials.installationId,
      privateKey: normalizeGitHubAppPrivateKey(credentials.privateKey),
    }),
  )
}
