/**
 * The EC2 worker's boot sequence and process lifecycle, with every side effect
 * (environment, Secrets Manager, the worker itself, signals, `process.exit`,
 * the termination watch, the status record) injected so tests can drive it.
 * `index.ts` is the only caller that passes the real ones; importing this
 * module runs nothing.
 *
 * Two modes, chosen by the worker unit's `CANOPYCMS_GITHUB_GATEWAY_SOCKET`:
 * without it the worker holds the credentials and reaches GitHub itself; with it
 * the worker holds none and reaches GitHub through the gateway process that
 * serves that socket (gateway-run.ts, which shares this file's secret reading).
 */

// workerLog/workerLogError, not bare console: every line in
// /var/log/canopy-worker/worker.log must start with the ISO-8601 timestamp
// these add, or the CloudWatch agent's multi_line_start_pattern folds it into
// the previous event instead of starting a new one. See
// packages/canopycms/src/worker/log.ts.
import {
  DEFAULT_TASK_TIMEOUT,
  assertSelfChecks,
  workerLog,
  workerLogError,
  workerLogWarn,
  type CmsWorker,
  type CmsWorkerConfig,
  type GitHubAppAuth,
  type GitHubGateway,
  type GitHubGatewayClientOptions,
  type SelfCheckResult,
} from 'canopycms/worker/cms-worker'
import type { AuthCacheSnapshot } from 'canopycms/auth/cache'
import { getErrorMessage } from 'canopycms/utils/error'
import path from 'node:path'

import {
  EXIT_DRAINED_FOR_TERMINATION,
  EXIT_WORKER_SELF_STOPPED,
  GATEWAY_SPLIT_CONTRACT,
  GITHUB_GATEWAY_SOCKET_ENV,
  WORKER_CAPACITY_ENV,
  WORKER_CONTRACT_VERSION,
  workerContractShortfall,
} from '../src/constructs/worker-lifecycle'
import type { GetSecretOptions } from './secrets'
import { buildGitHubAppAuth } from './github-app-auth'
import { createReactiveSecret, type ReactiveSecret } from './credential-refresh'
import { createClerkAuthCacheRefresher } from './clerk-refresh'
import type { TerminationNotice, TerminationWatchOptions } from './termination-watch'

/** The part of `CmsWorker` the entrypoint drives. */
export type WorkerHandle = Pick<CmsWorker, 'start' | 'stop' | 'selfStopped'>

export interface RunWorkerDeps {
  env: NodeJS.ProcessEnv
  getSecret: (secretArn: string, options?: GetSecretOptions) => Promise<string>
  createWorker: (config: CmsWorkerConfig) => WorkerHandle
  exit: (code: number) => void
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void
  watchForTermination: (options: TerminationWatchOptions) => Promise<TerminationNotice>
  completeTerminationLifecycleAction: () => Promise<void>
  /** `recordWorkerStartupFailure` from core; never throws. */
  recordWorkerStartupFailure: (options: { workspacePath: string; error: unknown }) => Promise<void>
  /** Split mode: the client of the gateway serving `socketPath`. */
  connectGateway: (socketPath: string, options: GitHubGatewayClientOptions) => GitHubGateway
  /** Split mode: core's `workerSelfChecks`. */
  workerSelfChecks: () => Promise<SelfCheckResult[]>
  /** Split mode: core's `writeAuthSnapshot`. */
  writeAuthSnapshot: (cachePath: string, snapshot: AuthCacheSnapshot) => Promise<unknown>
  /** Resolves the wait between termination polls after a failed one; tests replace it. */
  sleep?: (ms: number) => Promise<void>
  /** The contract this bundle runs at (default {@link WORKER_CONTRACT_VERSION}); a test seam. */
  bundleContract?: number
}

export interface GitHubAppEnv {
  appId: string
  installationId: string
  privateKeySecretArn: string
}

/**
 * GitHub App authentication, if this deployment uses it instead of a token.
 * Checked all-or-nothing HERE as well as at synth (assertGitHubAuthProps in
 * src/constructs/cms-service.ts), because the construct is the normal way
 * these arrive but not the only one: an adopter can set the instance's
 * environment directly, and half a credential otherwise fails at the first
 * push, hours after boot.
 *
 * Returns undefined when none of the three is set; throws on a partial set.
 */
export function readGitHubAppEnv(env: NodeJS.ProcessEnv): GitHubAppEnv | undefined {
  const appId = env.CANOPYCMS_GITHUB_APP_ID
  const installationId = env.CANOPYCMS_GITHUB_APP_INSTALLATION_ID
  const privateKeySecretArn = env.CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN
  const vars: Array<[string, string | undefined]> = [
    ['CANOPYCMS_GITHUB_APP_ID', appId],
    ['CANOPYCMS_GITHUB_APP_INSTALLATION_ID', installationId],
    ['CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN', privateKeySecretArn],
  ]
  const missing = vars.filter(([, value]) => !value).map(([name]) => name)
  if (missing.length > 0 && missing.length < vars.length) {
    throw new Error(
      `GitHub App authentication needs all of ${vars.map(([name]) => name).join(', ')}, ` +
        `but ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. An installation token is minted ` +
        `from all three together, so a partial set cannot authenticate at all.`,
    )
  }
  return appId && installationId && privateKeySecretArn
    ? { appId, installationId, privateKeySecretArn }
    : undefined
}

/** The environment variable whose entries `parseProtectedBranches` reads. */
const PROTECTED_BRANCHES_ENV = 'CANOPYCMS_PROTECTED_BRANCHES'

/**
 * `CANOPYCMS_PROTECTED_BRANCHES` as a list. Comma-separated: a comma is legal in a branch name,
 * but the construct refuses one in an entry.
 */
export function parseProtectedBranches(env: NodeJS.ProcessEnv): string[] {
  return (env[PROTECTED_BRANCHES_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** The worker unit's missing-`StateDirectory=` message. */
const WORKER_STATE_DIRECTORY_MISSING =
  'StateDirectory=canopy-worker is not set on the worker unit. The worker keeps its private ' +
  'GitHub mirror there, so it does not start without it. Add it to the [Service] section ' +
  'of canopy-worker.service (see "The worker instance" in docs/deploying-to-aws.md).'

/** What the worker and the gateway both read from their environment before any secret. */
export interface RepoEnv {
  githubOwner: string
  githubRepo: string
  stateDirectory: string
}

/**
 * The repository and state directory, which both roles need. `missingStateDirectory` is the
 * message for a unit without `StateDirectory=`, which names the unit it belongs to.
 */
export function readRepoEnv(env: NodeJS.ProcessEnv, missingStateDirectory: string): RepoEnv {
  const githubOwner = env.CANOPYCMS_GITHUB_OWNER
  if (!githubOwner) throw new Error('CANOPYCMS_GITHUB_OWNER is required')

  const githubRepo = env.CANOPYCMS_GITHUB_REPO
  if (!githubRepo) throw new Error('CANOPYCMS_GITHUB_REPO is required')

  // systemd's StateDirectory= (/var/lib/canopy-worker): the root volume, which the CMS Lambda
  // cannot reach. The GitHub credential is only ever used in a git repository there.
  const stateDirectory = env.STATE_DIRECTORY?.split(':')[0]
  if (!stateDirectory) throw new Error(missingStateDirectory)
  return { githubOwner, githubRepo, stateDirectory }
}

/** What each role does with a secret the moment it is read, beyond using it. */
export interface CredentialHooks {
  /** Told of the App's private key as read, before anything is built from it. */
  onAppPrivateKey?: (privateKey: string) => void
  /** Wraps the Clerk key's reactive secret. */
  wrapClerkSecret?: (secret: ReactiveSecret) => ReactiveSecret
}

export interface WorkerCredentials {
  githubToken: string | undefined
  githubTokenSecret: ReactiveSecret
  githubAppAuth: GitHubAppAuth | undefined
  clerkSecret: ReactiveSecret
}

/**
 * Read the GitHub credential and the Clerk key from the environment or Secrets Manager, in the
 * order a deployment's mistakes are best reported. Shared by the single-process worker and the
 * gateway, which hold the same secrets from the same variables.
 */
export async function readWorkerCredentials(
  env: NodeJS.ProcessEnv,
  getSecret: RunWorkerDeps['getSecret'],
  hooks: CredentialHooks = {},
): Promise<WorkerCredentials> {
  // Secrets from Secrets Manager or env vars.
  //
  // The ARN is resolved to `undefined` when the plain env var supplied the
  // value, which keeps the existing precedence (env var wins, the ARN is read
  // only in its absence) AND is what tells the reactive reader below there is
  // nothing behind this credential to re-read. Re-reading an ARN the
  // deployment deliberately overrode would swap the override back out.
  const githubTokenFromEnv = env.CANOPYCMS_GITHUB_TOKEN
  const githubTokenArn = githubTokenFromEnv ? undefined : env.CANOPYCMS_GITHUB_TOKEN_SECRET_ARN
  const githubTokenSecretOptions = {
    // `|| undefined` rather than passing the env var straight through: a var
    // that is present but blank means "not configured", so `getSecret` should
    // take the unchanged whole-value path rather than hunt for a field named
    // ''. The var name is passed too, so the warning `getSecret` logs when it
    // finds an unread JSON document can name the exact thing to set.
    jsonField: env.CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD || undefined,
    jsonFieldEnvVar: 'CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD',
  }
  const githubToken = githubTokenArn
    ? await getSecret(githubTokenArn, githubTokenSecretOptions)
    : githubTokenFromEnv
  // Wrapped so a rotated token reaches a RUNNING worker. Reactive: core calls
  // `refreshGitHubToken` only when a git sync or a task has just failed, so a
  // healthy worker makes no Secrets Manager calls after boot. Constructed even
  // under GitHub App auth, where it is inert - `resolveWorkerGitHubAuth` never
  // calls the provider there, because an App mints its own tokens.
  const githubTokenSecret = createReactiveSecret({
    arn: githubTokenArn,
    initial: githubToken,
    ...githubTokenSecretOptions,
  })

  // Nothing here touches the token path above. Both are passed to CmsWorker when
  // both are configured, and core's resolveWorkerGitHubAuth refuses that pair by
  // name rather than picking a winner here - a silent precedence would leave it
  // undefined which identity the worker's pushes and pull requests act as.
  const githubApp = readGitHubAppEnv(env)
  let githubAppAuth: GitHubAppAuth | undefined
  if (githubApp) {
    // Same `|| undefined` as the other two `getSecret` call sites in this
    // file, for the same reason: a blank var means "not configured", not
    // "read the field named ''".
    const privateKey = await getSecret(githubApp.privateKeySecretArn, {
      jsonField: env.CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD || undefined,
      jsonFieldEnvVar: 'CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD',
    })
    hooks.onAppPrivateKey?.(privateKey)
    githubAppAuth = buildGitHubAppAuth({
      appId: githubApp.appId,
      installationId: githubApp.installationId,
      privateKey,
    })
  }

  // `!githubAppAuth` as well: an App-authenticated worker has no token and must
  // not be told one is required. With neither configured this still reports the
  // token first, because the token is the default path and the one nearly every
  // deployment uses.
  if (!githubToken && !githubAppAuth)
    throw new Error(
      'CANOPYCMS_GITHUB_TOKEN or CANOPYCMS_GITHUB_TOKEN_SECRET_ARN is required ' +
        '(or the CANOPYCMS_GITHUB_APP_ID / _INSTALLATION_ID / _PRIVATE_KEY_SECRET_ARN trio, ' +
        'to authenticate as a GitHub App installation instead)',
    )

  // Same shape as the GitHub token above, and for the same reasons.
  const clerkKeyFromEnv = env.CLERK_SECRET_KEY
  const clerkKeyArn = clerkKeyFromEnv ? undefined : env.CLERK_SECRET_KEY_SECRET_ARN
  const clerkKeySecretOptions = {
    jsonField: env.CLERK_SECRET_KEY_SECRET_JSON_FIELD || undefined,
    jsonFieldEnvVar: 'CLERK_SECRET_KEY_SECRET_JSON_FIELD',
  }
  const clerkSecret = createReactiveSecret({
    arn: clerkKeyArn,
    initial: clerkKeyArn ? await getSecret(clerkKeyArn, clerkKeySecretOptions) : clerkKeyFromEnv,
    ...clerkKeySecretOptions,
  })

  return {
    githubToken,
    githubTokenSecret,
    githubAppAuth,
    clerkSecret: hooks.wrapClerkSecret ? hooks.wrapClerkSecret(clerkSecret) : clerkSecret,
  }
}

/**
 * Resolves with the first termination notice the gateway reports; never rejects. Each
 * `termination()` call waits for its answer on the gateway's side, so a null answer needs no
 * pause before the next call. A call that fails is logged on the transition to failing and again
 * on recovery, and polling continues after `retryMs`: losing this watch only costs the drain,
 * since the hook's heartbeat timeout still lets termination proceed.
 */
export async function pollGatewayForTermination(
  gateway: Pick<GitHubGateway, 'termination'>,
  options: { sleep?: (ms: number) => Promise<void>; retryMs?: number } = {},
): Promise<TerminationNotice> {
  const retryMs = options.retryMs ?? 5_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let failing = false

  for (;;) {
    try {
      const notice = await gateway.termination()
      if (failing) {
        failing = false
        workerLog('GitHub gateway reachable again; termination watch resumed')
      }
      if (notice !== null) return notice
    } catch (err) {
      if (!failing) {
        failing = true
        workerLogWarn(
          `Cannot ask the GitHub gateway about termination (${getErrorMessage(err)}); the worker ` +
            'will not drain before termination until it can. Retrying.',
        )
      }
      await sleep(retryMs)
    }
  }
}

/** The worker, and how it learns of and answers an instance termination. */
interface BuiltWorker {
  worker: WorkerHandle
  watchForTermination: () => Promise<TerminationNotice>
  completeLifecycle: () => Promise<void>
}

/** Settings both modes read the same way. */
function commonWorkerConfig(
  env: NodeJS.ProcessEnv,
): Pick<
  CmsWorkerConfig,
  | 'baseBranch'
  | 'settingsBranch'
  | 'taskPollInterval'
  | 'gitSyncInterval'
  | 'authCacheRefreshInterval'
> {
  return {
    // Unset, CmsWorker detects it rather than assuming 'main'.
    baseBranch: env.CANOPYCMS_BASE_BRANCH || undefined,
    // deploymentName is deliberately NOT passed: CmsWorker resolves it through
    // resolveDeploymentName, which reads CANOPYCMS_DEPLOYMENT_NAME itself,
    // applies the same env > config > 'prod' precedence as the Lambda, and
    // validates the result as a git ref component. Reading the env var here
    // would re-implement the outer half of that chain and skip the validation.
    // Explicit override, matching the strategy's own precedence: an adopter who
    // sets `settingsBranch` in canopycms.config.ts must set this too, or the
    // worker would own a branch name the Lambda never writes to.
    settingsBranch: env.CANOPYCMS_SETTINGS_BRANCH,
    taskPollInterval: parseInt(env.CANOPYCMS_TASK_POLL_INTERVAL ?? '5000'),
    gitSyncInterval: parseInt(env.CANOPYCMS_GIT_SYNC_INTERVAL ?? '300000'),
    authCacheRefreshInterval: parseInt(env.CANOPYCMS_AUTH_CACHE_REFRESH_INTERVAL ?? '900000'),
  }
}

/** The worker that holds the credentials and reaches GitHub itself. */
async function buildSingleProcessWorker(
  deps: RunWorkerDeps,
  workspacePath: string,
): Promise<BuiltWorker> {
  const { env } = deps
  const { githubOwner, githubRepo, stateDirectory } = readRepoEnv(
    env,
    WORKER_STATE_DIRECTORY_MISSING,
  )

  const { githubToken, githubTokenSecret, githubAppAuth, clerkSecret } =
    await readWorkerCredentials(env, deps.getSecret)

  // The re-read on a Clerk-rejected key lives inside this callback rather than
  // in core -- see clerk-refresh.ts for why.
  const refreshAuthCache = createClerkAuthCacheRefresher({
    secret: clerkSecret,
    cachePath: path.join(workspacePath, '.cache'),
  })

  const worker = deps.createWorker({
    workspacePath,
    stateDirectory,
    githubOwner,
    githubRepo,
    githubToken,
    githubAppAuth,
    // Re-read the PAT when a git sync or a task fails. Inert under App auth, where
    // `resolveWorkerGitHubAuth` never calls it.
    refreshGitHubToken: () => githubTokenSecret.refresh(),
    refreshAuthCache,
    protectedBranches: parseProtectedBranches(env),
    ...commonWorkerConfig(env),
  })
  return {
    worker,
    watchForTermination: () =>
      deps.watchForTermination({ watchSpot: env[WORKER_CAPACITY_ENV] === 'spot' }),
    completeLifecycle: () => deps.completeTerminationLifecycleAction(),
  }
}

/** The worker that holds no secret and reaches GitHub through the gateway at `socketPath`. */
async function buildSplitWorker(
  deps: RunWorkerDeps,
  workspacePath: string,
  socketPath: string,
): Promise<BuiltWorker> {
  const { env } = deps

  // Unconditional and fatal: a sandbox layer that did not take effect leaves a worker that
  // could be turned against the gateway's credential. Nothing here reads a secret.
  assertSelfChecks(await deps.workerSelfChecks())

  const { githubOwner, githubRepo, stateDirectory } = readRepoEnv(
    env,
    WORKER_STATE_DIRECTORY_MISSING,
  )

  // The gateway enforces the protected set from its own environment, so a list left here would
  // protect nothing while looking as if it did.
  if (parseProtectedBranches(env).length > 0) {
    throw new Error(
      `${PROTECTED_BRANCHES_ENV} is set on the worker unit, but beside the GitHub gateway it is ` +
        "the gateway's setting: move it to the gateway's environment (gateway.env)",
    )
  }

  // The worker's task timeout is core's default, which createWorker leaves unset.
  const gateway = deps.connectGateway(socketPath, { fetchInactivityMs: DEFAULT_TASK_TIMEOUT })

  // Waits up to 300 s for the gateway's prepare, which includes its secret reads. Its fatal
  // error becomes this worker's, so `lastFatalError` names the cause.
  const health = await gateway.health()
  if (health.fatalError !== null) {
    throw new Error(`The GitHub gateway could not start: ${health.fatalError}`)
  }
  if (!health.ready) throw new Error('The GitHub gateway is not ready')

  // The gateway holds the Clerk key; the worker writes what it fetches.
  const refreshAuthCache = health.clerkConfigured
    ? async () => {
        const snapshot = await gateway.authSnapshot()
        await deps.writeAuthSnapshot(path.join(workspacePath, '.cache'), snapshot)
        workerLog(`  ${snapshot.users.length} users, ${snapshot.groups.length} groups`)
      }
    : undefined

  // No credential, and no protected set: CmsWorker refuses either beside `githubGateway`, which
  // holds them.
  const worker = deps.createWorker({
    workspacePath,
    stateDirectory,
    githubOwner,
    githubRepo,
    githubGateway: gateway,
    refreshAuthCache,
    ...commonWorkerConfig(env),
  })
  return {
    worker,
    watchForTermination: () => pollGatewayForTermination(gateway, { sleep: deps.sleep }),
    completeLifecycle: async () => {
      try {
        await gateway.completeLifecycle()
      } catch (err) {
        workerLogError(
          `Could not complete the lifecycle action through the GitHub gateway (${getErrorMessage(err)}); ` +
            'termination continues when its heartbeat times out',
        )
      }
    },
  }
}

/**
 * Boot the worker and wire its process lifecycle. Resolves once `start()` has
 * returned, or after a fatal error has been reported through `deps.exit`.
 */
export async function runWorker(deps: RunWorkerDeps): Promise<void> {
  const { env } = deps

  /**
   * Set once a termination drain begins. A startup failure meanwhile must not
   * exit 1 under it: systemd would restart the worker on the departing instance,
   * and the lifecycle hook would wait out its heartbeat.
   */
  let terminating: Promise<void> | undefined

  // Set just before `worker.start()`. Only a failure before it is the
  // entrypoint's to record: start() records its own, and its ELOCKED
  // ("another worker is running") must stay unrecorded.
  let startCalled = false
  let workspacePath: string | undefined

  try {
    workerLog('CMS Worker starting...')

    workspacePath = env.CANOPYCMS_WORKSPACE_ROOT
    if (!workspacePath) throw new Error('CANOPYCMS_WORKSPACE_ROOT is required')

    // First after the workspace root, which recording the failure needs: under a
    // unit too old for this bundle, the checks below would report one missing
    // setting as a generic failure.
    const contractShortfall = workerContractShortfall(env)
    if (contractShortfall) throw new Error(contractShortfall)

    const socketPath = env[GITHUB_GATEWAY_SOCKET_ENV] || undefined
    if (!socketPath && (deps.bundleContract ?? WORKER_CONTRACT_VERSION) >= GATEWAY_SPLIT_CONTRACT) {
      throw new Error(
        `${GITHUB_GATEWAY_SOCKET_ENV} is not set on the worker unit. A worker at this contract ` +
          'runs only beside the GitHub gateway (canopy-github.socket), so the unit is missing it; ' +
          'running without it would put the GitHub credential in this process.',
      )
    }

    const { worker, watchForTermination, completeLifecycle } = socketPath
      ? await buildSplitWorker(deps, workspacePath, socketPath)
      : await buildSingleProcessWorker(deps, workspacePath)

    // stop() drains (see CmsWorker.stop); the unit's KillMode=mixed keeps
    // systemd's SIGTERM off the git children it is waiting for, and its
    // TimeoutStopSec outlasts the drain deadline.
    const shutdown = async (signal: string) => {
      await worker.stop({ reason: signal })
      deps.exit(0)
    }
    deps.onSignal('SIGTERM', () => void shutdown('SIGTERM'))
    deps.onSignal('SIGINT', () => void shutdown('SIGINT'))

    // Nothing else ends the process once the worker has stopped itself, and
    // exiting 0 or EXIT_DRAINED_FOR_TERMINATION would keep systemd from
    // starting the fresh worker that recovers it. A termination drain under way
    // owns the exit.
    void worker.selfStopped.then(async ({ reason }) => {
      workerLogError(
        `The worker stopped itself (${reason}); exiting so its process manager restarts it`,
      )
      if (terminating) {
        await terminating
        return
      }
      deps.exit(EXIT_WORKER_SELF_STOPPED)
    })

    // Drain BEFORE the instance goes: the construct's terminating lifecycle hook
    // holds it in Terminating:Wait until this completes the action (or the
    // heartbeat times out). Exiting with EXIT_DRAINED_FOR_TERMINATION stops
    // Restart=always from starting a fresh worker on the departing instance.
    void watchForTermination().then((notice) => {
      terminating = (async () => {
        workerLog(`Instance terminating: ${notice.reason}`)
        await worker.stop({ reason: notice.reason })
        if (notice.kind === 'auto-scaling') await completeLifecycle()
        deps.exit(EXIT_DRAINED_FOR_TERMINATION)
      })()
    })

    startCalled = true
    await worker.start()
  } catch (err) {
    workerLogError('Fatal error:', getErrorMessage(err))
    if (!startCalled && workspacePath) {
      await deps.recordWorkerStartupFailure({ workspacePath, error: err })
    }
    if (terminating) {
      await terminating
      return
    }
    deps.exit(1)
  }
}
