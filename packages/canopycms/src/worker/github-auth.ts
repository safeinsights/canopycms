import { createPrivateKey } from 'node:crypto'
import type { CanopyOctokitAuthOptions, OctokitAuthStrategyOptions } from '../github-service'
import { getErrorMessage } from '../utils/error'

/**
 * How the worker authenticates to GitHub, for both halves of its access:
 * Octokit (the REST API) and git-over-HTTPS (push/fetch, which carries the
 * credential in the remote URL).
 *
 * Two shapes are supported, and they are equals — nothing here deprecates,
 * warns on, or nudges away from the token.
 *
 * - **A personal access token** (`githubToken`). The documented default, and
 *   the only one most adopters will ever use: registering and installing a
 *   GitHub App needs organisation-admin rights that a single-maintainer site
 *   does not have. Nothing in this module imports `@octokit/auth-app`, so
 *   this path works with that package absent from the install entirely.
 * - **A GitHub App** (`githubAppAuth`). An App's private key does not expire
 *   and installs across repositories, where a fine-grained PAT expires within
 *   a year, acts as the person who created it, and dies when they leave the
 *   organisation. The cost is that its installation tokens last about an
 *   hour, so the credential must be minted on demand rather than read once at
 *   boot — which is why `CmsWorker.buildGitHubUrl()` is async.
 */
export interface GitHubAuthConfig {
  /**
   * GitHub bot token (a PAT) for pushing and PR operations.
   *
   * Exactly one of this and `githubAppAuth` must be set.
   */
  githubToken?: string
  /**
   * GitHub App authentication, constructed by the deployment entrypoint and
   * injected here — the same seam `refreshAuthCache` uses, and for the same
   * reason: the package it needs must not enter core's dependency graph.
   *
   * Exactly one of this and `githubToken` must be set.
   */
  githubAppAuth?: GitHubAppAuth
  /**
   * How long to wait for one installation-token mint before giving up, in ms
   * (default: 30000).
   *
   * The bound lives here rather than being threaded down from the task's own
   * AbortSignal because the two git credential call paths do not share one:
   * `pushBranchToGitHub` runs under `executeTaskWithTimeout`, but git-sync.ts's
   * two resolutions run on the sync loop and are bounded by nothing at all. A
   * local timeout covers both.
   */
  gitTokenMintTimeoutMs?: number
}

/**
 * The two facets of a GitHub App credential that the worker needs, supplied
 * by whoever constructs the `@octokit/auth-app` strategy.
 *
 * **Derive both from ONE `createAppAuth(…)` instance.** That instance holds
 * the installation-token cache (an LRU keyed by installation, refreshed only
 * within ~60s of expiry), so sharing it is what keeps the REST and git halves
 * on the same hourly token instead of minting twice. Concretely:
 *
 * ```ts
 * const appAuth = createAppAuth({ appId, privateKey, installationId })
 * const githubAppAuth = {
 *   mintInstallationToken: async () => (await appAuth({ type: 'installation' })).token,
 *   // A closure, not `authStrategy: createAppAuth` — that would have Octokit
 *   // build a SECOND instance with its own separate cache.
 *   octokitAuth: { authStrategy: () => appAuth, auth: {} },
 * }
 * ```
 */
export interface GitHubAppAuth {
  /**
   * Mint (or return the cached) installation access token, used as the
   * password in the git remote URL.
   *
   * `signal` aborts when the caller's timeout fires. Forward it to the
   * underlying HTTP request if the strategy allows it — `@octokit/auth-app@6`
   * does not accept a per-call signal, so with the stock strategy this is
   * advisory and `resolveGitToken` below is what actually bounds the wait.
   *
   * Reject with the error as thrown, do NOT re-wrap it: a `RequestError`'s
   * `.status` is what `isPermanentTaskFailure` classifies on, and a
   * `new Error(getErrorMessage(err))` would turn every 401 into a retried
   * transient failure.
   */
  mintInstallationToken: (options: { signal: AbortSignal }) => Promise<string>
  /**
   * Octokit's `{ authStrategy, auth }` passthrough, so the REST client
   * authenticates as the App installation too.
   */
  octokitAuth: OctokitAuthStrategyOptions
}

/** See `GitHubAuthConfig.gitTokenMintTimeoutMs`. */
export const DEFAULT_GIT_TOKEN_MINT_TIMEOUT_MS = 30_000

export interface ResolvedGitHubAuth {
  /** Passed straight to `createCanopyOctokit`. */
  octokitAuth: CanopyOctokitAuthOptions
  /**
   * The git-over-HTTPS credential, resolved fresh on every call.
   *
   * Never cache what this returns: an installation token expires in about an
   * hour, so a URL built from one is only good for that long. Resolving per
   * use is cheap — `@octokit/auth-app` answers from its own cache until the
   * token is within ~60s of expiry, so the common case is a resolved
   * microtask, and the PAT case is a bare `async` return.
   */
  resolveGitToken: () => Promise<string>
}

/**
 * Choose how this worker authenticates, ONCE, from its config.
 *
 * Called from `CmsWorker`'s constructor so the branch is taken a single time
 * and both consumers (Octokit and the git URL) provably agree about it, and
 * so a half-configured worker fails at construction rather than at its first
 * push.
 */
export function resolveWorkerGitHubAuth(config: GitHubAuthConfig): ResolvedGitHubAuth {
  const token = config.githubToken
  const app = config.githubAppAuth
  const hasToken = typeof token === 'string' && token.length > 0

  if (hasToken && app) {
    throw new Error(
      'CanopyCMS worker: configure either githubToken or githubAppAuth, not both. ' +
        'Two credentials would leave it undefined which identity a push or a pull request acts as.',
    )
  }
  if (!hasToken && !app) {
    throw new Error(
      'CanopyCMS worker: githubToken or githubAppAuth is required. ' +
        'A personal access token (githubToken) is the default; githubAppAuth authenticates as a GitHub App installation instead.',
    )
  }

  if (app) {
    const timeoutMs = config.gitTokenMintTimeoutMs ?? DEFAULT_GIT_TOKEN_MINT_TIMEOUT_MS
    return {
      octokitAuth: app.octokitAuth,
      resolveGitToken: () => mintInstallationToken(app, timeoutMs),
    }
  }
  // Narrowed by hasToken, which TypeScript cannot carry through the branch above.
  const staticToken = token as string
  return {
    octokitAuth: { auth: staticToken },
    resolveGitToken: async () => staticToken,
  }
}

/**
 * Mint an installation token, bounded by `timeoutMs`.
 *
 * Deliberately has NO try/catch around the mint. A rejection must reach
 * `isPermanentTaskFailure` (task-runner.ts) carrying the `.status` its
 * `RequestError` was thrown with, because that is the whole of the
 * classification: 4xx is permanent, so a bad key (401), a suspended app (403)
 * or a revoked installation (404) fails the task immediately instead of
 * burning its retry budget, while a 5xx or a network error with no status at
 * all is retried. Catching and re-throwing `new Error(getErrorMessage(err))`
 * here would silently make every mint failure transient.
 */
async function mintInstallationToken(app: GitHubAppAuth, timeoutMs: number): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs)
  const minting = app.mintInstallationToken({ signal })
  // If the timeout wins the race, the losing promise must not surface an
  // unhandled rejection when it eventually settles (same guard as
  // executeTaskWithTimeout).
  minting.catch(() => {})
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new Error(`GitHub App installation token was not minted within ${timeoutMs}ms`)),
      { once: true },
    )
  })
  const minted = await Promise.race([minting, timedOut])
  if (!minted) {
    // An empty token would build `https://x-access-token:@github.com/…`, which
    // git sends as an anonymous request and GitHub answers with a 403 that
    // says nothing about the credential.
    throw new Error('GitHub App authentication returned an empty installation token')
  }
  return minted
}

/**
 * Normalize a GitHub App private key to a PKCS#8 PEM.
 *
 * **GitHub issues App keys as PKCS#1** (`-----BEGIN RSA PRIVATE KEY-----`),
 * but `@octokit/auth-app@6` signs its JWT through `universal-github-app-jwt`,
 * whose WebCrypto path accepts **only PKCS#8**. Which of that package's paths
 * runs depends on the export condition the bundler picks — the worker is
 * bundled with `esbuild --platform=node --format=esm` — so a key that signs
 * fine in one build can fail in another. Converting up front removes the
 * question.
 *
 * Also accepts the two wrappings a key picks up on its way through
 * configuration, since both are indistinguishable from corruption at the point
 * of failure:
 * - `\n` escaped as a literal backslash-n (a `.env` value, or JSON that was
 *   never parsed);
 * - the whole PEM base64-encoded (a common way to get a multi-line secret
 *   through a single-line field).
 *
 * Anything `crypto.createPrivateKey` cannot parse throws here — at the point
 * the key is configured, naming the key — rather than surfacing later as an
 * opaque JWT signing failure.
 */
export function normalizeGitHubAppPrivateKey(privateKey: string): string {
  const pem = decodeIfBase64(unescapeNewlines(privateKey.trim()))
  try {
    return createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString()
  } catch (err) {
    throw new Error(
      `CanopyCMS: the GitHub App private key could not be parsed (${getErrorMessage(err)}). ` +
        'Supply the PEM GitHub generated for the app — PKCS#1, PKCS#8, base64-encoded or with \\n escapes are all accepted.',
    )
  }
}

/**
 * Turn literal `\n` / `\r\n` escapes back into real newlines. Unconditional,
 * because no PEM and no base64 alphabet contains a backslash, so this cannot
 * corrupt a key that was already well-formed.
 */
function unescapeNewlines(value: string): string {
  return value.replace(/\\r\\n|\\r|\\n/g, '\n')
}

/**
 * Undo a base64 wrapping of the whole PEM. Gated on the result actually
 * looking like a PEM, so a malformed key is reported as a key-parse failure
 * rather than as whatever bytes a stray base64 decode produced.
 */
function decodeIfBase64(value: string): string {
  if (value.includes('-----BEGIN')) return value
  if (!/^[A-Za-z0-9+/\s]+={0,2}$/.test(value)) return value
  const decoded = Buffer.from(value, 'base64').toString('utf8')
  return decoded.includes('-----BEGIN') ? decoded : value
}
