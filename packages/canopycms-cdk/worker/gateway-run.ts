/**
 * The GitHub gateway process's boot sequence and lifecycle (`index.ts gateway`), with every side
 * effect injected so tests can drive it. It holds the GitHub credential and the Clerk key, serves
 * `GitHubGateway` on a socket for the worker (run.ts, split mode), and runs under its own user
 * (the unit's `User=`, which nothing here checks) with no view of the shared workspace (its
 * `efs-unreadable` self-check).
 *
 * A boot that cannot produce the real gateway still serves a stand-in that answers `health` with
 * the cause, so the worker records it as its `lastFatalError` where an operator reads it. Without
 * it the worker would see only an unreachable socket.
 */

import {
  DEFAULT_TASK_TIMEOUT,
  assertSelfChecks,
  gatewayLog,
  gatewayLogError,
  gatewayLogWarn,
  normalizeGitHubAppPrivateKey,
  redactEgress,
  registerPrivateKey,
  registerSecretText,
  resolveWorkerGitHubAuth,
  type GitHubGateway,
  type GitHubGatewayListen,
  type GitHubGatewayServer,
  type LocalGitHubGatewayOptions,
  type SelfCheckResult,
} from 'canopycms/worker/cms-worker'
import { getErrorMessage } from 'canopycms/utils/error'

import {
  GITHUB_GATEWAY_SOCKET_ENV,
  WORKER_CAPACITY_ENV,
  workerContractShortfall,
} from '../src/constructs/worker-lifecycle'
import type { GetSecretOptions } from './secrets'
import type { ReactiveSecret } from './credential-refresh'
import { createClerkSnapshotFetcher } from './clerk-refresh'
import { parseProtectedBranches, readRepoEnv, readWorkerCredentials } from './run'
import type { TerminationNotice, TerminationWatchOptions } from './termination-watch'

/**
 * How long a draining gateway lets requests under way finish. `drain()` answers new requests
 * `stopping`, lets push and Octokit requests under way finish, then closes every connection. A
 * running fetch job is not waited for: the process exits, and the unit's `KillMode=mixed` SIGKILLs
 * the cgroup, which takes the job's git with it. The plan's §3.1 "Stop ordering"
 * (.claude/future-tasks/worker-shared-repo-git-process-split.md) stops the worker unit first and
 * gives this one `TimeoutStopSec=150`, well above this grace.
 */
export const GATEWAY_DRAIN_GRACE_MS = 60_000

/**
 * How long a gateway that failed to boot or to prepare answers the cause before exiting, so the
 * worker has time to read the cause. systemd then starts it again: a transient cause (a Secrets
 * Manager timeout) recovers, and a permanent one fails again, loudly, each time.
 */
export const FAILED_BOOT_HOLD_MS = 60_000

/** The first file descriptor systemd passes under socket activation (`SD_LISTEN_FDS_START`). */
const SD_LISTEN_FDS_START = 3

export interface RunGatewayDeps {
  env: NodeJS.ProcessEnv
  pid: number
  getSecret: (secretArn: string, options?: GetSecretOptions) => Promise<string>
  exit: (code: number) => void
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void
  /** Core's `gatewaySelfChecks`. */
  gatewaySelfChecks: () => Promise<SelfCheckResult[]>
  createGateway: (options: LocalGitHubGatewayOptions) => GitHubGateway
  serve: (
    gateway: GitHubGateway,
    listen: GitHubGatewayListen,
  ) => Promise<Pick<GitHubGatewayServer, 'drain'>>
  watchForTermination: (options: TerminationWatchOptions) => Promise<TerminationNotice>
  completeTerminationLifecycleAction: () => Promise<void>
  /** Resolves the stand-in's hold; tests replace it. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Where the gateway listens: the socket systemd passed (`canopy-github.socket`, whose owner and
 * mode are the access control), or, for development and a hand run, a path it binds itself. A
 * socket-activation environment that is not for this process is refused rather than ignored.
 */
export function resolveGatewayListen(env: NodeJS.ProcessEnv, pid: number): GitHubGatewayListen {
  if (env.LISTEN_FDS !== undefined) {
    if (env.LISTEN_PID !== String(pid) || env.LISTEN_FDS !== '1') {
      throw new Error(
        `Socket activation passed LISTEN_PID=${JSON.stringify(env.LISTEN_PID)} and ` +
          `LISTEN_FDS=${JSON.stringify(env.LISTEN_FDS)}, but this gateway (pid ${pid}) takes exactly ` +
          'one descriptor addressed to it',
      )
    }
    return { fd: SD_LISTEN_FDS_START }
  }
  const socketPath = env[GITHUB_GATEWAY_SOCKET_ENV]
  if (socketPath) return { path: socketPath }
  throw new Error(
    `The GitHub gateway runs socket-activated (canopy-github.socket) or with ${GITHUB_GATEWAY_SOCKET_ENV} set; neither is`,
  )
}

/**
 * The gateway unit's missing-`StateDirectory=` message. The directory holds the mirror and must
 * be private to the gateway's user, or the worker could plant what the gateway's git reads.
 */
const GATEWAY_STATE_DIRECTORY_MISSING =
  'StateDirectory=canopy-github is not set on the gateway unit. The gateway keeps its GitHub ' +
  'mirror there, and the directory must be private to the gateway user, so it does not start ' +
  'without it. Add it to the [Service] section of canopy-github.service.'

/**
 * `secret` with every value it hands out, the initial one and each rotation, registered for
 * scrubbing before it is returned: the Clerk key is not a GitHub token, so the gateway's token
 * tracking does not know it.
 */
function scrubbed(secret: ReactiveSecret): ReactiveSecret {
  const register = (value: string | undefined): string | undefined => {
    if (value) registerSecretText(value)
    return value
  }
  return {
    current: () => register(secret.current()),
    refresh: async () => register(await secret.refresh()),
  }
}

/** Boot to a gateway that has not yet been served; throws what stops it. */
async function buildGateway(deps: RunGatewayDeps): Promise<GitHubGateway> {
  const { env } = deps

  // The gateway unit carries the same contract stamp as the worker's.
  const contractShortfall = workerContractShortfall(env)
  if (contractShortfall) throw new Error(contractShortfall)

  // Fatal, and before any secret is read: a sandbox layer that did not take effect leaves a
  // process holding the credential that the worker's user could reach.
  assertSelfChecks(await deps.gatewaySelfChecks())

  const { githubOwner, githubRepo, stateDirectory } = readRepoEnv(
    env,
    GATEWAY_STATE_DIRECTORY_MISSING,
  )

  const { githubToken, githubTokenSecret, githubAppAuth, clerkSecret } =
    await readWorkerCredentials(env, deps.getSecret, {
      onAppPrivateKey: (privateKey) => {
        registerPrivateKey(privateKey)
        try {
          registerPrivateKey(normalizeGitHubAppPrivateKey(privateKey))
        } catch {
          // An unusable key fails building the gateway, with its own message.
        }
      },
      wrapClerkSecret: scrubbed,
    })

  // Refuses both credentials and neither, as CmsWorker does for the in-process gateway.
  const auth = resolveWorkerGitHubAuth({
    githubToken,
    githubAppAuth,
    refreshGitHubToken: () => githubTokenSecret.refresh(),
  })

  return deps.createGateway({
    githubOwner,
    githubRepo,
    auth,
    githubApp: githubAppAuth !== undefined,
    stateDirectory,
    // No workspacePath: this process cannot see the shared workspace, and its `efs-unreadable`
    // self-check stands in for the state-directory check that path would enable.
    timeoutMs: DEFAULT_TASK_TIMEOUT,
    baseBranch: env.CANOPYCMS_BASE_BRANCH || undefined,
    protectedBranches: parseProtectedBranches(env),
    authSnapshot: createClerkSnapshotFetcher({
      secret: clerkSecret,
      log: { warn: gatewayLogWarn, error: gatewayLogError },
    }),
    watchTermination: () =>
      deps.watchForTermination({ watchSpot: env[WORKER_CAPACITY_ENV] === 'spot' }),
    completeLifecycle: () => deps.completeTerminationLifecycleAction(),
  })
}

/**
 * The gateway a failed boot serves: `health` answers the cause, and every other operation,
 * `prepare` included, rejects with it as a plain error. A status-less rejection is transient to
 * the worker's task runner, so nothing is marked permanently failed and nothing answers as if it
 * had succeeded. `message` is already scrubbed.
 * @internal Exported for tests.
 */
export function failedGateway(message: string): GitHubGateway {
  const refuse = async (): Promise<never> => {
    throw Object.assign(new Error(message), { name: 'GitHubGatewayNotStartedError' })
  }
  return {
    prepare: refuse,
    health: async () => ({
      ready: false,
      fatalError: message,
      preflight: 'pending',
      clerkConfigured: false,
      protectedBranches: { configured: [], githubDefault: null },
    }),
    defaultBranch: refuse,
    isProtectedBranch: refuse,
    fetch: refuse,
    openBundle: refuse,
    push: refuse,
    createPullRequest: refuse,
    updatePullRequest: refuse,
    getPullRequest: refuse,
    createOrUpdatePullRequest: refuse,
    convertPullRequestToDraft: refuse,
    deleteBranch: refuse,
    authSnapshot: refuse,
    termination: refuse,
    completeLifecycle: refuse,
  }
}

/** What ends the process: the first SIGTERM or SIGINT, or the failed boot's own exit. */
interface StopControl {
  /** Drain `server` and exit 0 on the first signal; later signals do nothing. */
  watch: (server: Pick<GitHubGatewayServer, 'drain'>) => void
  stopping: () => boolean
  /** Claim the stop, so a signal from here on does nothing. */
  begin: () => void
}

function stopControl(deps: RunGatewayDeps): StopControl {
  let stopping = false
  return {
    watch: (server) => {
      const stop = () => {
        if (stopping) return
        stopping = true
        void (async () => {
          try {
            await server.drain(GATEWAY_DRAIN_GRACE_MS)
          } catch (err) {
            gatewayLogError('Draining the GitHub gateway failed:', getErrorMessage(err))
          }
          deps.exit(0)
        })()
      }
      deps.onSignal('SIGTERM', stop)
      deps.onSignal('SIGINT', stop)
    },
    stopping: () => stopping,
    begin: () => {
      stopping = true
    },
  }
}

/**
 * Boot the gateway and wire its process lifecycle. Resolves once it is serving (the real gateway
 * or the failed boot's stand-in); a failure that leaves nothing to serve is reported through
 * `deps.exit`.
 */
export async function runGateway(deps: RunGatewayDeps): Promise<void> {
  const { env } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  gatewayLog('GitHub gateway starting...')

  let listen: GitHubGatewayListen
  try {
    listen = resolveGatewayListen(env, deps.pid)
  } catch (err) {
    gatewayLogError('Fatal error:', getErrorMessage(err))
    deps.exit(1)
    return
  }

  const stop = stopControl(deps)

  let gateway: GitHubGateway
  let server: Pick<GitHubGatewayServer, 'drain'>
  try {
    gateway = await buildGateway(deps)
    server = await deps.serve(gateway, listen)
  } catch (err) {
    gatewayLogError('Fatal error:', getErrorMessage(err))
    await serveFailedBoot(deps, listen, err, sleep, stop)
    return
  }
  stop.watch(server)

  // The server started `prepare()` as it took its socket. A failure is the gateway's fatal error,
  // which `health` answers; then it ends the process as a failed boot does, so a cause fixed
  // since (a rotated key) is read afresh.
  void gateway.prepare().then(
    () => gatewayLog('GitHub gateway ready'),
    async (err) => {
      gatewayLogError('The GitHub gateway could not prepare:', getErrorMessage(err))
      await holdThenExit(deps, server, sleep, stop)
    },
  )
}

/** Serve the stand-in for a failed boot, then {@link holdThenExit}. */
async function serveFailedBoot(
  deps: RunGatewayDeps,
  listen: GitHubGatewayListen,
  cause: unknown,
  sleep: (ms: number) => Promise<void>,
  stop: StopControl,
): Promise<void> {
  let server: Pick<GitHubGatewayServer, 'drain'>
  try {
    server = await deps.serve(failedGateway(redactEgress(getErrorMessage(cause))), listen)
  } catch (err) {
    gatewayLogError('Could not serve the failed boot to the worker either:', getErrorMessage(err))
    deps.exit(1)
    return
  }
  stop.watch(server)
  await holdThenExit(deps, server, sleep, stop)
}

/**
 * A gateway that cannot work (its boot or its `prepare()` failed): keep answering `health` with
 * the cause for {@link FAILED_BOOT_HOLD_MS}, so the worker records it, then exit 1 so systemd
 * starts the gateway again.
 */
async function holdThenExit(
  deps: RunGatewayDeps,
  server: Pick<GitHubGatewayServer, 'drain'>,
  sleep: (ms: number) => Promise<void>,
  stop: StopControl,
): Promise<void> {
  await sleep(FAILED_BOOT_HOLD_MS)
  // A signal during the hold owns the stop: its drain exits 0.
  if (stop.stopping()) return
  stop.begin()
  try {
    await server.drain(0)
  } catch (err) {
    gatewayLogError('Draining the failed gateway failed:', getErrorMessage(err))
  }
  deps.exit(1)
}
