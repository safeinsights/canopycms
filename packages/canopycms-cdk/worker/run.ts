/**
 * The EC2 worker's boot sequence and process lifecycle, with every side effect
 * (environment, Secrets Manager, the worker itself, signals, `process.exit`,
 * the termination watch, the status record) injected so tests can drive it.
 * `index.ts` is the only caller that passes the real ones; importing this
 * module runs nothing.
 */

// workerLog/workerLogError, not bare console: every line in
// /var/log/canopy-worker/worker.log must start with the ISO-8601 timestamp
// these add, or the CloudWatch agent's multi_line_start_pattern folds it into
// the previous event instead of starting a new one. See
// packages/canopycms/src/worker/log.ts.
import {
  workerLog,
  workerLogError,
  type CmsWorker,
  type CmsWorkerConfig,
} from 'canopycms/worker/cms-worker'
import { getErrorMessage } from 'canopycms/utils/error'
import path from 'node:path'

import {
  EXIT_DRAINED_FOR_TERMINATION,
  EXIT_WORKER_SELF_STOPPED,
  WORKER_CAPACITY_ENV,
} from '../src/constructs/worker-lifecycle'
import type { GetSecretOptions } from './secrets'
import { buildGitHubAppAuth } from './github-app-auth'
import { createReactiveSecret } from './credential-refresh'
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

/**
 * Boot the worker and wire its process lifecycle. Resolves once `start()` has
 * returned, or after a fatal error has been reported through `deps.exit`.
 */
export async function runWorker(deps: RunWorkerDeps): Promise<void> {
  const { env, getSecret } = deps

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

    const githubOwner = env.CANOPYCMS_GITHUB_OWNER
    if (!githubOwner) throw new Error('CANOPYCMS_GITHUB_OWNER is required')

    const githubRepo = env.CANOPYCMS_GITHUB_REPO
    if (!githubRepo) throw new Error('CANOPYCMS_GITHUB_REPO is required')

    // systemd's StateDirectory= (/var/lib/canopy-worker): the root volume, which the CMS Lambda
    // cannot reach. The GitHub credential is only ever used in a git repository there.
    const stateDirectory = env.STATE_DIRECTORY?.split(':')[0]
    if (!stateDirectory) {
      throw new Error(
        'StateDirectory=canopy-worker is not set on the worker unit. The worker keeps its private ' +
          'GitHub mirror there, so it does not start without it. Add it to the [Service] section ' +
          'of canopy-worker.service (see "The worker instance" in docs/deploying-to-aws.md).',
      )
    }

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
    const githubAppAuth = githubApp
      ? buildGitHubAppAuth({
          appId: githubApp.appId,
          installationId: githubApp.installationId,
          // Same `|| undefined` as the other two `getSecret` call sites in this
          // file, for the same reason: a blank var means "not configured", not
          // "read the field named ''".
          privateKey: await getSecret(githubApp.privateKeySecretArn, {
            jsonField: env.CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD || undefined,
            jsonFieldEnvVar: 'CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD',
          }),
        })
      : undefined

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
    })

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
    void deps
      .watchForTermination({ watchSpot: env[WORKER_CAPACITY_ENV] === 'spot' })
      .then((notice) => {
        terminating = (async () => {
          workerLog(`Instance terminating: ${notice.reason}`)
          await worker.stop({ reason: notice.reason })
          if (notice.kind === 'auto-scaling') await deps.completeTerminationLifecycleAction()
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
