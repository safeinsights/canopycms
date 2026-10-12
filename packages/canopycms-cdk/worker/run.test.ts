/**
 * The EC2 worker entrypoint's `runWorker`, with every side effect injected: what
 * a failure BEFORE `worker.start()` records, what a failure OF `start()` does
 * not, and which exit status the process takes in each case.
 *
 * Every assertion reads a recorded call or a returned value, never a log line.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DRAIN_DEADLINE_MS,
  DEFAULT_TASK_TIMEOUT,
  GitHubGatewayUnreachableError,
  recordWorkerStartupFailure,
  workerSelfChecks,
  type CmsWorkerConfig,
  type GitHubGateway,
  type GitHubGatewayHealth,
  type SelfCheckResult,
  type WorkerSelfStop,
} from 'canopycms/worker/cms-worker'
import type { AuthCacheSnapshot } from 'canopycms/auth/cache'

import {
  EXIT_DRAINED_FOR_TERMINATION,
  EXIT_WORKER_SELF_STOPPED,
  GATEWAY_SPLIT_CONTRACT,
  GITHUB_GATEWAY_SOCKET_ENV,
  WORKER_CONTRACT_ENV,
  WORKER_CONTRACT_VERSION,
  unitWorkerContract,
} from '../src/constructs/worker-lifecycle'
import { MIN_WORKER_TERMINATION_HEARTBEAT } from '../src/constructs/cms-service'
import { workerUnit } from '../src/constructs/worker-units'
import { FAILED_BOOT_HOLD_MS } from './gateway-run'
import {
  GATEWAY_AWAY_KEEP_MS,
  LIFECYCLE_ATTEMPTS,
  LIFECYCLE_RETRY_WINDOW_MS,
  isRecentGatewayFatal,
  pollGatewayForTermination,
  readGitHubAppEnv,
  runWorker,
  type RunWorkerDeps,
  type WorkerHandle,
} from './run'

const APP_ID = 'CANOPYCMS_GITHUB_APP_ID'
const APP_INSTALLATION_ID = 'CANOPYCMS_GITHUB_APP_INSTALLATION_ID'
const APP_KEY_ARN = 'CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN'
const APP_VARS = [APP_ID, APP_INSTALLATION_ID, APP_KEY_ARN]

const WORKSPACE = '/mnt/efs-test'

/** The minimum a PAT-authenticated worker needs. */
const baseEnv = (): NodeJS.ProcessEnv => ({
  CANOPYCMS_WORKSPACE_ROOT: WORKSPACE,
  CANOPYCMS_GITHUB_OWNER: 'acme',
  CANOPYCMS_GITHUB_REPO: 'site',
  CANOPYCMS_GITHUB_TOKEN: 'ghp_test_token',
  STATE_DIRECTORY: '/var/lib/canopy-worker',
  [WORKER_CONTRACT_ENV]: String(WORKER_CONTRACT_VERSION),
})

function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const env = baseEnv()
  for (const name of names) delete env[name]
  return env
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let promise reactions queued by the entrypoint run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Swallows what `workerLog*` write: `quietTestOutput` throws on stdout under CI.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// The inferred value, not just whether the worker runs: once the contract
// passes 1, an unstamped unit must still read as 1 and be refused.
describe("unitWorkerContract: the unit's contract version", () => {
  it.each<[string, number, NodeJS.ProcessEnv]>([
    ['unstamped, with a state directory', 1, { STATE_DIRECTORY: '/var/lib/canopy-worker' }],
    ['unstamped, without one', 0, {}],
    ['unstamped, with an empty one', 0, { STATE_DIRECTORY: '' }],
    ['stamped 0, with a state directory', 0, { [WORKER_CONTRACT_ENV]: '0', STATE_DIRECTORY: '/x' }],
    ['stamped 3', 3, { [WORKER_CONTRACT_ENV]: '3' }],
  ])('%s is %i', (_case, expected, env) => {
    expect(unitWorkerContract(env)).toBe(expected)
  })

  it('is NaN for a stamp that is not a whole number', () => {
    expect(unitWorkerContract({ [WORKER_CONTRACT_ENV]: '1.0' })).toBeNaN()
  })
})

describe('readGitHubAppEnv: the all-or-nothing App trio', () => {
  const full = { [APP_ID]: '123', [APP_INSTALLATION_ID]: '456', [APP_KEY_ARN]: 'arn:key' }

  it('returns the trio when all three are set', () => {
    expect(readGitHubAppEnv(full)).toEqual({
      appId: '123',
      installationId: '456',
      privateKeySecretArn: 'arn:key',
    })
  })

  it('returns undefined when none is set', () => {
    expect(readGitHubAppEnv({})).toBeUndefined()
  })

  it('treats blank values as not set', () => {
    expect(readGitHubAppEnv({ [APP_ID]: '', [APP_INSTALLATION_ID]: '', [APP_KEY_ARN]: '' })).toBe(
      undefined,
    )
  })

  it.each(APP_VARS)('throws naming %s when only it is missing', (missing) => {
    const env = { ...full } as Record<string, string | undefined>
    delete env[missing]
    expect(() => readGitHubAppEnv(env)).toThrow(
      `but ${missing} is not set. An installation token is minted from all three`,
    )
  })

  it.each([
    [APP_ID, APP_INSTALLATION_ID],
    [APP_ID, APP_KEY_ARN],
    [APP_INSTALLATION_ID, APP_KEY_ARN],
  ])('throws naming %s and %s when both are missing', (a, b) => {
    const env = { ...full } as Record<string, string | undefined>
    delete env[a]
    delete env[b]
    expect(() => readGitHubAppEnv(env)).toThrow(
      `but ${a} and ${b} are not set. An installation token is minted from all three`,
    )
  })

  it('lists all three variables in the message', () => {
    expect(() => readGitHubAppEnv({ [APP_ID]: '123' })).toThrow(
      `GitHub App authentication needs all of ${APP_VARS.join(', ')}`,
    )
  })
})

interface Harness {
  deps: RunWorkerDeps
  worker: WorkerHandle
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  selfStopped: ReturnType<typeof deferred<WorkerSelfStop>>
  createWorker: ReturnType<typeof vi.fn>
  getSecret: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  record: ReturnType<typeof vi.fn>
  completeLifecycle: ReturnType<typeof vi.fn>
  termination: ReturnType<typeof deferred<{ kind: 'auto-scaling' | 'spot'; reason: string }>>
  signals: Map<string, () => void>
  exitCodes: () => number[]
  connectGateway: ReturnType<typeof vi.fn>
  selfChecks: ReturnType<typeof vi.fn>
  writeAuthSnapshot: ReturnType<typeof vi.fn>
  gateway: FakeGateway
}

/** What `runWorker` calls of the gateway client, each a spy. */
interface FakeGateway {
  health: ReturnType<typeof vi.fn>
  authSnapshot: ReturnType<typeof vi.fn>
  termination: ReturnType<typeof vi.fn>
  completeLifecycle: ReturnType<typeof vi.fn>
}

const HEALTHY: GitHubGatewayHealth = {
  ready: true,
  fatalError: null,
  preflight: 'not-an-app',
  clerkConfigured: false,
  protectedBranches: { configured: [], githubDefault: 'main' },
}

const SNAPSHOT: AuthCacheSnapshot = {
  users: [{ id: 'u1', name: 'Ada', email: 'ada@example.test' }],
  groups: [{ id: 'g1', name: 'Editors' }],
  memberships: { u1: ['g1'] },
}

/** The five worker checks, all passing. */
const passingWorkerChecks = (): SelfCheckResult[] =>
  (['imds', 'network-namespace', 'proc', 'home', 'secrets-in-env'] as const).map((check) => ({
    check,
    ok: true,
    detail: 'ok',
  }))

function fakeGateway(): FakeGateway {
  return {
    health: vi.fn(async () => HEALTHY),
    authSnapshot: vi.fn(async () => SNAPSHOT),
    // Pending: no instance is terminating unless a test says so.
    termination: vi.fn(() => new Promise<never>(() => {})),
    completeLifecycle: vi.fn(async () => {}),
  }
}

function harness(overrides: Partial<RunWorkerDeps> & { env?: NodeJS.ProcessEnv } = {}): Harness {
  const selfStopped = deferred<WorkerSelfStop>()
  const start = vi.fn(async () => {})
  const stop = vi.fn(async (_options?: { reason?: string }) => {})
  const worker = { start, stop, selfStopped: selfStopped.promise } as unknown as WorkerHandle
  const createWorker = vi.fn((_config: CmsWorkerConfig) => worker)
  const getSecret = vi.fn(async (_arn: string) => 'secret-value')
  const exit = vi.fn((_code: number) => {})
  const record = vi.fn(async () => {})
  const completeLifecycle = vi.fn(async () => {})
  const termination = deferred<{ kind: 'auto-scaling' | 'spot'; reason: string }>()
  const signals = new Map<string, () => void>()
  const gateway = fakeGateway()
  const connectGateway = vi.fn(
    (_socketPath: string, _options: { fetchInactivityMs?: number }) =>
      gateway as unknown as GitHubGateway,
  )
  const selfChecks = vi.fn(async () => passingWorkerChecks())
  const writeAuthSnapshot = vi.fn(async (_cachePath: string, _snapshot: AuthCacheSnapshot) => {})

  const deps: RunWorkerDeps = {
    env: baseEnv(),
    getSecret,
    createWorker,
    exit,
    onSignal: (signal, handler) => {
      signals.set(signal, handler)
    },
    watchForTermination: vi.fn(() => termination.promise),
    completeTerminationLifecycleAction: completeLifecycle,
    recordWorkerStartupFailure: record,
    connectGateway,
    workerSelfChecks: selfChecks,
    writeAuthSnapshot,
    sleep: async () => {},
    // The single-process path most of these tests drive, which only a bundle below the split
    // contract runs; the split's tests set the socket variable, which selects the split at any.
    bundleContract: GATEWAY_SPLIT_CONTRACT - 1,
    ...overrides,
  }
  return {
    deps,
    worker,
    start,
    stop,
    selfStopped,
    createWorker,
    getSecret,
    exit,
    record,
    completeLifecycle,
    termination,
    signals,
    exitCodes: () => exit.mock.calls.map(([code]) => code),
    connectGateway,
    selfChecks,
    writeAuthSnapshot,
    gateway,
  }
}

describe('runWorker: a failure before worker.start()', () => {
  it('records a rejected getSecret against the workspace root, then exits 1 without building the worker', async () => {
    const accessDenied = new Error('AccessDeniedException: not authorized to GetSecretValue')
    const h = harness({
      env: {
        ...envWithout('CANOPYCMS_GITHUB_TOKEN'),
        CANOPYCMS_GITHUB_TOKEN_SECRET_ARN: 'arn:tok',
      },
      getSecret: vi.fn(async () => {
        throw accessDenied
      }),
    })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.record).toHaveBeenCalledWith({ workspacePath: WORKSPACE, error: accessDenied })
    expect(h.exitCodes()).toEqual([1])
    expect(h.createWorker).not.toHaveBeenCalled()
    expect(h.start).not.toHaveBeenCalled()
  })

  it('records the partial-App-trio message, then exits 1', async () => {
    const h = harness({ env: { ...baseEnv(), [APP_ID]: '123' } })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledTimes(1)
    const { workspacePath, error } = h.record.mock.calls[0][0] as {
      workspacePath: string
      error: Error
    }
    expect(workspacePath).toBe(WORKSPACE)
    expect(error.message).toContain(`${APP_INSTALLATION_ID} and ${APP_KEY_ARN} are not set`)
    expect(h.exitCodes()).toEqual([1])
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('records a missing GitHub credential, then exits 1', async () => {
    const h = harness({ env: envWithout('CANOPYCMS_GITHUB_TOKEN') })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledTimes(1)
    const { error } = h.record.mock.calls[0][0] as { error: Error }
    expect(error.message).toContain('CANOPYCMS_GITHUB_TOKEN or CANOPYCMS_GITHUB_TOKEN_SECRET_ARN')
    expect(h.exitCodes()).toEqual([1])
  })

  it('records a missing owner once the workspace root is known', async () => {
    const h = harness({ env: envWithout('CANOPYCMS_GITHUB_OWNER') })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.exitCodes()).toEqual([1])
  })

  it('records an error thrown while constructing the worker', async () => {
    const boom = new Error('no GitHub credential configured')
    const h = harness({
      createWorker: vi.fn(() => {
        throw boom
      }),
    })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledWith({ workspacePath: WORKSPACE, error: boom })
    expect(h.exitCodes()).toEqual([1])
    expect(h.start).not.toHaveBeenCalled()
  })

  it('records a unit without StateDirectory=, naming the line to add', async () => {
    const h = harness({ env: envWithout('STATE_DIRECTORY') })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledWith({
      workspacePath: WORKSPACE,
      error: expect.objectContaining({
        message: expect.stringMatching(
          /^StateDirectory=canopy-worker is not set on the worker unit/,
        ),
      }),
    })
    expect(h.exitCodes()).toEqual([1])
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('refuses an unstamped unit without StateDirectory= with the template-too-old line, before the state-directory check', async () => {
    const h = harness({ env: envWithout(WORKER_CONTRACT_ENV, 'STATE_DIRECTORY') })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledWith({
      workspacePath: WORKSPACE,
      error: expect.objectContaining({
        message: expect.stringContaining(
          `canopy-worker: template too old for this bundle: needs worker contract ` +
            `${WORKER_CONTRACT_VERSION}, unit has 0 (contract 1 adds StateDirectory=canopy-worker`,
        ),
      }),
    })
    expect(h.exitCodes()).toEqual([1])
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('reads an unstamped unit that has StateDirectory= as contract 1, which the split refuses', async () => {
    const h = harness({ env: envWithout(WORKER_CONTRACT_ENV) })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledWith({
      workspacePath: WORKSPACE,
      error: expect.objectContaining({
        message: expect.stringContaining(
          `unit has 1 (contract 2 adds canopy-github.socket and canopy-github.service, and ` +
            `${GITHUB_GATEWAY_SOCKET_ENV} on the worker unit)`,
        ),
      }),
    })
    expect(h.start).not.toHaveBeenCalled()
  })

  it('refuses a unit stamped below the bundle, whatever else it provides', async () => {
    const h = harness({
      env: { ...baseEnv(), [WORKER_CONTRACT_ENV]: String(WORKER_CONTRACT_VERSION - 1) },
    })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledWith({
      workspacePath: WORKSPACE,
      error: expect.objectContaining({
        message: expect.stringContaining(
          `needs worker contract ${WORKER_CONTRACT_VERSION}, unit has ${WORKER_CONTRACT_VERSION - 1} (`,
        ),
      }),
    })
    expect(h.exitCodes()).toEqual([1])
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  // '' is what systemd passes for `Environment=CANOPYCMS_WORKER_CONTRACT=`.
  it.each(['1.0', ''])(
    'refuses a contract stamp of %j, which is not a whole number',
    async (stamp) => {
      const h = harness({ env: { ...baseEnv(), [WORKER_CONTRACT_ENV]: stamp } })

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledWith({
        workspacePath: WORKSPACE,
        error: expect.objectContaining({
          message: `canopy-worker: ${WORKER_CONTRACT_ENV}=${JSON.stringify(stamp)} on the worker unit is not a whole number`,
        }),
      })
      expect(h.exitCodes()).toEqual([1])
      expect(h.createWorker).not.toHaveBeenCalled()
    },
  )

  it('starts under a unit stamped newer than the bundle', async () => {
    const h = harness({
      env: { ...baseEnv(), [WORKER_CONTRACT_ENV]: String(WORKER_CONTRACT_VERSION + 1) },
    })

    await runWorker(h.deps)

    expect(h.record).not.toHaveBeenCalled()
    expect(h.start).toHaveBeenCalled()
  })

  it("hands the worker systemd's state directory, the first of several", async () => {
    const h = harness({
      env: { ...baseEnv(), STATE_DIRECTORY: '/var/lib/canopy-worker:/var/lib/other' },
    })

    await runWorker(h.deps)

    expect(h.createWorker).toHaveBeenCalledWith(
      expect.objectContaining({ stateDirectory: '/var/lib/canopy-worker' }),
    )
  })

  it('has nowhere to record without CANOPYCMS_WORKSPACE_ROOT: exits 1 and records nothing', async () => {
    const h = harness({ env: envWithout('CANOPYCMS_WORKSPACE_ROOT') })

    await runWorker(h.deps)

    expect(h.record).not.toHaveBeenCalled()
    expect(h.exitCodes()).toEqual([1])
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('exits only after the record has finished', async () => {
    const recorded = deferred()
    const h = harness({
      env: envWithout('CANOPYCMS_GITHUB_OWNER'),
      recordWorkerStartupFailure: vi.fn(() => recorded.promise),
    })

    const done = runWorker(h.deps)
    await flush()
    expect(h.exit).not.toHaveBeenCalled()

    recorded.resolve()
    await done
    expect(h.exitCodes()).toEqual([1])
  })
})

describe('runWorker: a failure of worker.start() itself', () => {
  it('records nothing (start() records its own) and exits 1', async () => {
    const h = harness()
    h.start.mockRejectedValue(new Error('ELOCKED: another worker is running'))

    await runWorker(h.deps)

    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.record).not.toHaveBeenCalled()
    expect(h.exitCodes()).toEqual([1])
  })
})

describe('runWorker: a healthy start', () => {
  it('builds the worker from the environment and starts it without exiting', async () => {
    const h = harness({
      env: {
        ...baseEnv(),
        CANOPYCMS_BASE_BRANCH: 'trunk',
        CANOPYCMS_GIT_SYNC_INTERVAL: '1234',
      },
    })

    await runWorker(h.deps)

    expect(h.createWorker).toHaveBeenCalledTimes(1)
    expect(h.createWorker.mock.calls[0][0]).toMatchObject({
      workspacePath: WORKSPACE,
      githubOwner: 'acme',
      githubRepo: 'site',
      githubToken: 'ghp_test_token',
      baseBranch: 'trunk',
      gitSyncInterval: 1234,
      taskPollInterval: 5000,
    })
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.record).not.toHaveBeenCalled()
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('leaves the base branch unset for CmsWorker to detect when the env var is absent', async () => {
    const h = harness({ env: envWithout('CANOPYCMS_BASE_BRANCH') })

    await runWorker(h.deps)

    expect(h.createWorker).toHaveBeenCalledTimes(1)
    expect(h.createWorker.mock.calls[0][0].baseBranch).toBeUndefined()
  })

  it('passes CANOPYCMS_PROTECTED_BRANCHES as a list, and none when it is absent', async () => {
    const listed = harness({
      env: { ...baseEnv(), CANOPYCMS_PROTECTED_BRANCHES: 'release/*, production,,hotfix-*' },
    })
    await runWorker(listed.deps)
    expect(listed.createWorker.mock.calls[0][0].protectedBranches).toEqual([
      'release/*',
      'production',
      'hotfix-*',
    ])

    const absent = harness({ env: envWithout('CANOPYCMS_PROTECTED_BRANCHES') })
    await runWorker(absent.deps)
    expect(absent.createWorker.mock.calls[0][0].protectedBranches).toEqual([])
  })

  it('builds an App credential from the trio, reading the key from its secret', async () => {
    const h = harness({
      env: {
        ...envWithout('CANOPYCMS_GITHUB_TOKEN'),
        [APP_ID]: '123',
        [APP_INSTALLATION_ID]: '456',
        [APP_KEY_ARN]: 'arn:app-key',
      },
    })

    await runWorker(h.deps)

    expect(h.getSecret).toHaveBeenCalledWith('arn:app-key', expect.any(Object))
    const config = h.createWorker.mock.calls[0][0] as CmsWorkerConfig
    expect(config.githubAppAuth).toBeDefined()
    expect(config.githubToken).toBeUndefined()
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('drains and exits 0 on SIGTERM', async () => {
    const h = harness()
    await runWorker(h.deps)

    h.signals.get('SIGTERM')?.()
    await flush()

    expect(h.stop).toHaveBeenCalledWith({ reason: 'SIGTERM' })
    expect(h.exitCodes()).toEqual([0])
  })
})

describe('runWorker: the worker stops itself', () => {
  it('has an exit status that is neither success nor the no-restart drain status', () => {
    expect(EXIT_WORKER_SELF_STOPPED).not.toBe(0)
    expect(EXIT_WORKER_SELF_STOPPED).not.toBe(EXIT_DRAINED_FOR_TERMINATION)
  })

  it('exits with EXIT_WORKER_SELF_STOPPED when selfStopped settles', async () => {
    const h = harness()
    await runWorker(h.deps)
    expect(h.exit).not.toHaveBeenCalled()

    h.selfStopped.resolve({ reason: 'worker lock compromised' })
    await flush()

    expect(h.exitCodes()).toEqual([EXIT_WORKER_SELF_STOPPED])
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('leaves the exit to the drain when selfStopped settles during a termination drain', async () => {
    const h = harness()
    const drained = deferred()
    h.stop.mockImplementation(() => drained.promise)
    await runWorker(h.deps)

    h.termination.resolve({ kind: 'auto-scaling', reason: 'Auto Scaling is terminating' })
    await flush()
    expect(h.stop).toHaveBeenCalledWith({ reason: 'Auto Scaling is terminating' })

    h.selfStopped.resolve({ reason: 'worker lock compromised' })
    await flush()
    expect(h.exit).not.toHaveBeenCalled()

    drained.resolve()
    await flush()
    expect(h.exitCodes()).toEqual([EXIT_DRAINED_FOR_TERMINATION])
    expect(h.completeLifecycle).toHaveBeenCalledTimes(1)
  })

  it('does not complete the lifecycle action for a spot notice', async () => {
    const h = harness()
    await runWorker(h.deps)

    h.termination.resolve({ kind: 'spot', reason: 'spot interruption notice' })
    await flush()

    expect(h.completeLifecycle).not.toHaveBeenCalled()
    expect(h.exitCodes()).toEqual([EXIT_DRAINED_FOR_TERMINATION])
  })
})

describe('runWorker: a fatal error while a termination drain is under way', () => {
  it('awaits the drain instead of exiting 1', async () => {
    const h = harness()
    const drained = deferred()
    const startFails = deferred()
    h.stop.mockImplementation(() => drained.promise)
    h.start.mockImplementation(() => startFails.promise)

    const done = runWorker(h.deps)
    await flush()
    h.termination.resolve({ kind: 'auto-scaling', reason: 'Auto Scaling is terminating' })
    await flush()

    startFails.reject(new Error('boom'))
    await flush()
    expect(h.exit).not.toHaveBeenCalled()

    drained.resolve()
    await done
    await flush()
    expect(h.exitCodes()).toEqual([EXIT_DRAINED_FOR_TERMINATION])
  })
})

describe('the split’s names', () => {
  // The split's units (the plan's §8, "Carried from 5") name the variable and stamp the
  // contract; a change here strands them.
  it('pins the socket variable and the contract at which a worker runs only split', () => {
    expect(GITHUB_GATEWAY_SOCKET_ENV).toBe('CANOPYCMS_GITHUB_GATEWAY_SOCKET')
    expect(GATEWAY_SPLIT_CONTRACT).toBe(2)
  })
})

describe('runWorker: without the gateway socket, the single-process path', () => {
  it('never connects a gateway or runs the split self-checks', async () => {
    const h = harness()

    await runWorker(h.deps)

    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.connectGateway).not.toHaveBeenCalled()
    expect(h.selfChecks).not.toHaveBeenCalled()
  })

  it('refuses a bundle at the split contract, recording the missing socket variable', async () => {
    const h = harness({
      env: { ...baseEnv(), [WORKER_CONTRACT_ENV]: String(GATEWAY_SPLIT_CONTRACT) },
      bundleContract: GATEWAY_SPLIT_CONTRACT,
    })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledWith({
      workspacePath: WORKSPACE,
      error: expect.objectContaining({
        message: expect.stringContaining(GITHUB_GATEWAY_SOCKET_ENV),
      }),
    })
    expect(h.exitCodes()).toEqual([1])
    expect(h.createWorker).not.toHaveBeenCalled()
    expect(h.getSecret).not.toHaveBeenCalled()
  })

  it('runs single-process at contract 1 with the same environment', async () => {
    const h = harness({
      env: { ...baseEnv(), [WORKER_CONTRACT_ENV]: String(GATEWAY_SPLIT_CONTRACT) },
      bundleContract: 1,
    })

    await runWorker(h.deps)

    expect(h.record).not.toHaveBeenCalled()
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('treats a blank socket variable as absent', async () => {
    const h = harness({
      env: { ...baseEnv(), [GITHUB_GATEWAY_SOCKET_ENV]: '' },
      bundleContract: GATEWAY_SPLIT_CONTRACT,
    })

    await runWorker(h.deps)

    expect(h.exitCodes()).toEqual([1])
    expect(h.connectGateway).not.toHaveBeenCalled()
  })
})

const SOCKET = '/run/canopy-github/gateway.sock'

/** A worker unit in split mode: the socket, and no secret of any kind. */
const splitEnv = (): NodeJS.ProcessEnv => {
  const env = envWithout(
    'CANOPYCMS_GITHUB_TOKEN',
    'CANOPYCMS_GITHUB_TOKEN_SECRET_ARN',
    'CLERK_SECRET_KEY',
  )
  env[GITHUB_GATEWAY_SOCKET_ENV] = SOCKET
  return env
}

describe('runWorker: split mode', () => {
  it('runs the self-checks before connecting, reads no secret, and hands the worker the gateway alone', async () => {
    const order: string[] = []
    const h = harness({
      env: {
        ...splitEnv(),
        // Variables a hand-installed unit might still carry: split mode reads none of them.
        CANOPYCMS_GITHUB_TOKEN: 'ghp_ignored',
        CANOPYCMS_GITHUB_TOKEN_SECRET_ARN: 'arn:tok',
        CANOPYCMS_GITHUB_APP_ID: '123',
        CANOPYCMS_BASE_BRANCH: 'trunk',
      },
    })
    h.selfChecks.mockImplementation(async () => {
      order.push('self-checks')
      return passingWorkerChecks()
    })
    h.connectGateway.mockImplementation(() => {
      order.push('connect')
      return h.gateway as unknown as GitHubGateway
    })

    await runWorker(h.deps)

    expect(order).toEqual(['self-checks', 'connect'])
    expect(h.getSecret).not.toHaveBeenCalled()
    expect(h.connectGateway).toHaveBeenCalledWith(SOCKET, {
      fetchInactivityMs: DEFAULT_TASK_TIMEOUT,
    })
    expect(h.createWorker).toHaveBeenCalledTimes(1)
    const config = h.createWorker.mock.calls[0][0] as CmsWorkerConfig
    expect(config.githubGateway).toBe(h.gateway)
    expect(config).toMatchObject({
      workspacePath: WORKSPACE,
      stateDirectory: '/var/lib/canopy-worker',
      githubOwner: 'acme',
      githubRepo: 'site',
      baseBranch: 'trunk',
    })
    for (const forbidden of [
      'githubToken',
      'githubAppAuth',
      'refreshGitHubToken',
      'protectedBranches',
    ]) {
      expect(config).not.toHaveProperty(forbidden)
    }
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.exit).not.toHaveBeenCalled()
  })

  it("refuses CANOPYCMS_PROTECTED_BRANCHES on the worker's unit, which only the gateway enforces", async () => {
    const h = harness({ env: { ...splitEnv(), CANOPYCMS_PROTECTED_BRANCHES: 'release/*' } })

    await runWorker(h.deps)

    expect(h.record).toHaveBeenCalledTimes(1)
    const { error } = h.record.mock.calls[0][0] as { error: Error }
    expect(error.message).toMatch(/CANOPYCMS_PROTECTED_BRANCHES is set on the worker unit/)
    expect(h.connectGateway).not.toHaveBeenCalled()
    expect(h.createWorker).not.toHaveBeenCalled()
    expect(h.exitCodes()).toEqual([1])
  })

  it.each(['imds', 'network-namespace', 'proc', 'home', 'secrets-in-env'] as const)(
    'refuses to start, recording the failed %s check, and never connects',
    async (failing) => {
      const h = harness({ env: splitEnv() })
      h.selfChecks.mockResolvedValue(
        passingWorkerChecks().map((result) =>
          result.check === failing ? { ...result, ok: false, detail: 'it did not take' } : result,
        ),
      )

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledWith({
        workspacePath: WORKSPACE,
        error: expect.objectContaining({
          message: expect.stringContaining(`${failing}: it did not take`),
        }),
      })
      expect(h.exitCodes()).toEqual([1])
      expect(h.connectGateway).not.toHaveBeenCalled()
      expect(h.createWorker).not.toHaveBeenCalled()
    },
  )

  describe('with core’s own self-checks over a stand-in tree', () => {
    let root: string

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-run-checks-'))
      await fs.mkdir(path.join(root, 'proc', 'self', 'net'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'proc', 'self', 'net', 'dev'),
        'Inter-|   Receive\n face |bytes\n    lo: 0 0 0 0 0 0 0 0 0 0\n',
      )
      await fs.mkdir(path.join(root, 'home'), { recursive: true })
    })

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true })
    })

    const realChecks = (deps: () => RunWorkerDeps) => () =>
      workerSelfChecks({
        env: deps().env,
        root,
        uid: process.getuid?.() ?? 0,
        connect: async () => ({ code: 'ENETUNREACH' }),
      })

    it('refuses a worker whose environment holds the GitHub token', async () => {
      const h = harness({ env: { ...splitEnv(), CANOPYCMS_GITHUB_TOKEN: 'ghp_leaked' } })
      h.deps.workerSelfChecks = realChecks(() => h.deps)

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledWith({
        workspacePath: WORKSPACE,
        error: expect.objectContaining({
          message: expect.stringContaining('secrets-in-env'),
        }),
      })
      expect(h.exitCodes()).toEqual([1])
      expect(h.connectGateway).not.toHaveBeenCalled()
    })

    it('starts a worker whose environment holds none', async () => {
      const h = harness({ env: splitEnv() })
      h.deps.workerSelfChecks = realChecks(() => h.deps)

      await runWorker(h.deps)

      expect(h.record).not.toHaveBeenCalled()
      expect(h.connectGateway).toHaveBeenCalledTimes(1)
      expect(h.start).toHaveBeenCalledTimes(1)
    })
  })

  it('still requires the owner, the repository and the state directory', async () => {
    for (const missing of ['CANOPYCMS_GITHUB_OWNER', 'CANOPYCMS_GITHUB_REPO', 'STATE_DIRECTORY']) {
      const env = splitEnv()
      delete env[missing]
      const h = harness({ env })

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledTimes(1)
      expect(h.exitCodes()).toEqual([1])
      expect(h.connectGateway).not.toHaveBeenCalled()
    }
  })

  describe('the gateway’s health', () => {
    it('records the gateway’s fatal error as the worker’s, and builds no worker', async () => {
      const h = harness({ env: splitEnv() })
      h.gateway.health.mockResolvedValue({ ...HEALTHY, ready: false, fatalError: 'App key bad' })

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledWith({
        workspacePath: WORKSPACE,
        error: expect.objectContaining({
          message: 'The GitHub gateway could not start: App key bad',
        }),
      })
      expect(h.exitCodes()).toEqual([1])
      expect(h.createWorker).not.toHaveBeenCalled()
    })

    it('records an unreachable gateway', async () => {
      const unreachable = new Error('connect ENOENT /run/canopy-github/gateway.sock')
      const h = harness({ env: splitEnv() })
      h.gateway.health.mockRejectedValue(unreachable)

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledWith({ workspacePath: WORKSPACE, error: unreachable })
      expect(h.exitCodes()).toEqual([1])
      expect(h.createWorker).not.toHaveBeenCalled()
    })

    it('keeps the cause already recorded when the gateway is away, as it is while it restarts', async () => {
      const away = new GitHubGatewayUnreachableError('Could not reach the GitHub gateway')
      const h = harness({ env: splitEnv() })
      h.gateway.health.mockRejectedValue(away)

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledWith({
        workspacePath: WORKSPACE,
        error: away,
        keepRecordedFatal: expect.any(Function),
      })
      expect(h.exitCodes()).toEqual([1])
    })

    it('counts a health wait that timed out as the gateway being away', async () => {
      const h = harness({ env: splitEnv() })
      h.gateway.health.mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      )

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledWith({
        workspacePath: WORKSPACE,
        error: expect.any(GitHubGatewayUnreachableError),
        keepRecordedFatal: expect.any(Function),
      })
    })

    it("leaves the gateway's fatal error from one cycle showing through the next cycle's gap", async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-run-gap-'))
      try {
        const env = { ...splitEnv(), CANOPYCMS_WORKSPACE_ROOT: workspace }
        const statusFile = path.join(workspace, '.tasks', 'worker-status.json')
        const recorded = async () =>
          (
            JSON.parse(await fs.readFile(statusFile, 'utf-8')) as {
              lastFatalError?: { message: string }
            }
          ).lastFatalError?.message

        // Cycle 1: the gateway serves its fatal error.
        const first = harness({ env, recordWorkerStartupFailure })
        first.gateway.health.mockResolvedValue({
          ...HEALTHY,
          ready: false,
          fatalError: 'GitHub App authentication failed: 401',
        })
        await runWorker(first.deps)
        expect(await recorded()).toContain('GitHub App authentication failed: 401')

        // Cycle 2: the gateway has exited to restart, and is away.
        const second = harness({ env, recordWorkerStartupFailure })
        second.gateway.health.mockRejectedValue(
          new GitHubGatewayUnreachableError('Could not reach the GitHub gateway'),
        )
        await runWorker(second.deps)

        expect(await recorded()).toContain('GitHub App authentication failed: 401')
        expect(second.exitCodes()).toEqual([1])
      } finally {
        await fs.rm(workspace, { recursive: true, force: true })
      }
    })

    it.each<[string, { message: string; phase: string; ageMs: number }, boolean]>([
      [
        "the gateway's fatal error, just recorded",
        { message: 'The GitHub gateway could not start: App 401', phase: 'startup', ageMs: 1_000 },
        true,
      ],
      [
        "the gateway's fatal error, older than the keep window",
        {
          message: 'The GitHub gateway could not start: App 401',
          phase: 'startup',
          ageMs: GATEWAY_AWAY_KEEP_MS + 1_000,
        },
        false,
      ],
      [
        'a worker-side cause',
        {
          message: 'CANOPYCMS_PROTECTED_BRANCHES is set on the worker unit',
          phase: 'startup',
          ageMs: 1_000,
        },
        false,
      ],
      [
        'a running worker’s fatal error',
        { message: 'The GitHub gateway could not start: App 401', phase: 'run', ageMs: 1_000 },
        false,
      ],
      [
        "the gateway's fatal error, recorded in the future",
        { message: 'The GitHub gateway could not start: App 401', phase: 'startup', ageMs: -1_000 },
        false,
      ],
    ])('keeps, for an unreachable gateway, %s: %s', (_case, { message, phase, ageMs }, kept) => {
      const now = Date.parse('2026-10-11T12:00:00.000Z')
      const at = new Date(now - ageMs).toISOString()

      expect(isRecentGatewayFatal({ message, phase, at }, now)).toBe(kept)
    })

    it('keeps no gateway fatal error whose time cannot be read', () => {
      const now = Date.parse('2026-10-11T12:00:00.000Z')

      expect(
        isRecentGatewayFatal(
          { message: 'The GitHub gateway could not start: App 401', phase: 'startup', at: 'soon' },
          now,
        ),
      ).toBe(false)
    })

    it('measures the window to when this worker began waiting for the gateway, not to when the wait ended', async () => {
      const recordedAt = Date.parse('2026-10-11T12:00:00.000Z')
      const waitStart = recordedAt + 60_000
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(waitStart)
        const h = harness({ env: splitEnv() })
        // The gateway answers nothing for the client's whole wait, longer than the window.
        h.gateway.health.mockImplementation(async () => {
          vi.setSystemTime(waitStart + GATEWAY_AWAY_KEEP_MS + 60_000)
          throw new GitHubGatewayUnreachableError(
            'The GitHub gateway did not answer health in time',
          )
        })

        await runWorker(h.deps)

        const { keepRecordedFatal } = h.record.mock.calls[0][0] as {
          keepRecordedFatal: (recorded: { message: string; phase: string; at: string }) => boolean
        }
        expect(
          keepRecordedFatal({
            message: 'The GitHub gateway could not start: App 401',
            phase: 'startup',
            at: new Date(recordedAt).toISOString(),
          }),
        ).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('refuses a gateway that answers without being ready or failed', async () => {
      const h = harness({ env: splitEnv() })
      h.gateway.health.mockResolvedValue({ ...HEALTHY, ready: false })

      await runWorker(h.deps)

      expect(h.record).toHaveBeenCalledWith({
        workspacePath: WORKSPACE,
        error: expect.objectContaining({ message: expect.stringContaining('not ready') }),
      })
      expect(h.createWorker).not.toHaveBeenCalled()
    })
  })

  describe('the auth cache, whose Clerk key the gateway holds', () => {
    it('fetches the snapshot from the gateway and writes it under the workspace', async () => {
      const h = harness({ env: splitEnv() })
      h.gateway.health.mockResolvedValue({ ...HEALTHY, clerkConfigured: true })

      await runWorker(h.deps)

      const { refreshAuthCache } = h.createWorker.mock.calls[0][0] as CmsWorkerConfig
      expect(refreshAuthCache).toBeDefined()
      expect(h.gateway.authSnapshot).not.toHaveBeenCalled()

      await refreshAuthCache?.()

      expect(h.gateway.authSnapshot).toHaveBeenCalledTimes(1)
      expect(h.writeAuthSnapshot).toHaveBeenCalledWith(path.join(WORKSPACE, '.cache'), SNAPSHOT)
    })

    it('schedules no refresh when the gateway holds no Clerk key', async () => {
      const h = harness({ env: splitEnv() })

      await runWorker(h.deps)

      expect(h.createWorker.mock.calls[0][0].refreshAuthCache).toBeUndefined()
    })
  })

  describe('termination, noticed by the gateway', () => {
    it('stops with the notice’s reason and completes the lifecycle through the gateway', async () => {
      const h = harness({ env: splitEnv() })
      h.gateway.termination
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ kind: 'auto-scaling', reason: 'Auto Scaling is terminating' })

      await runWorker(h.deps)
      await flush()

      expect(h.gateway.termination).toHaveBeenCalledTimes(2)
      expect(h.stop).toHaveBeenCalledWith({ reason: 'Auto Scaling is terminating' })
      expect(h.gateway.completeLifecycle).toHaveBeenCalledTimes(1)
      expect(h.completeLifecycle).not.toHaveBeenCalled()
      expect(h.deps.watchForTermination).not.toHaveBeenCalled()
      expect(h.exitCodes()).toEqual([EXIT_DRAINED_FOR_TERMINATION])
    })

    it('does not complete the lifecycle for a spot notice', async () => {
      const h = harness({ env: splitEnv() })
      h.gateway.termination.mockResolvedValueOnce({
        kind: 'spot',
        reason: 'spot interruption notice',
      })

      await runWorker(h.deps)
      await flush()

      expect(h.stop).toHaveBeenCalledWith({ reason: 'spot interruption notice' })
      expect(h.gateway.completeLifecycle).not.toHaveBeenCalled()
      expect(h.exitCodes()).toEqual([EXIT_DRAINED_FOR_TERMINATION])
    })

    it('exits after the drain once the gateway has refused to complete the lifecycle for the whole retry window', async () => {
      const sleep = vi.fn(async (_ms: number) => {})
      const h = harness({ env: splitEnv(), sleep })
      h.gateway.termination.mockResolvedValueOnce({
        kind: 'auto-scaling',
        reason: 'Auto Scaling is terminating',
      })
      h.gateway.completeLifecycle.mockRejectedValue(new Error('the gateway is stopping'))

      await runWorker(h.deps)
      await vi.waitFor(() => expect(h.exitCodes()).toEqual([EXIT_DRAINED_FOR_TERMINATION]))

      expect(h.gateway.completeLifecycle).toHaveBeenCalledTimes(LIFECYCLE_ATTEMPTS)
      expect(LIFECYCLE_ATTEMPTS * 5_000).toBe(LIFECYCLE_RETRY_WINDOW_MS)
      expect(sleep.mock.calls.filter(([ms]) => ms === 5_000)).toHaveLength(LIFECYCLE_ATTEMPTS - 1)
    })

    it('fits the drain and the retry window inside the shortest lifecycle heartbeat, and the drain inside the unit stop timeout', () => {
      // The drain, its abort grace (core's ABORT_GRACE_MS) and the retries all run while Auto
      // Scaling holds the instance; past the heartbeat termination continues anyway.
      const abortGraceMs = 5_000
      expect(DEFAULT_DRAIN_DEADLINE_MS + abortGraceMs + LIFECYCLE_RETRY_WINDOW_MS).toBeLessThan(
        MIN_WORKER_TERMINATION_HEARTBEAT.toMilliseconds(),
      )
      // A gateway restart: its failed-boot hold, RestartSec=5 and a boot.
      expect(LIFECYCLE_RETRY_WINDOW_MS).toBeGreaterThan(FAILED_BOOT_HOLD_MS + 5_000 + 30_000)
      // A systemd stop (SIGTERM) runs the drain alone, inside the unit's TimeoutStopSec.
      const stopSec = workerUnit('split')
        .find((line) => line.startsWith('TimeoutStopSec='))
        ?.slice('TimeoutStopSec='.length)
      expect(Number(stopSec) * 1000).toBeGreaterThan(DEFAULT_DRAIN_DEADLINE_MS + abortGraceMs)
    })

    it('ends a lifecycle call the gateway holds when the retry window ends, and exits', async () => {
      const h = harness({ env: splitEnv(), lifecycleRetryWindowMs: 200 })
      h.gateway.termination.mockResolvedValueOnce({
        kind: 'auto-scaling',
        reason: 'Auto Scaling is terminating',
      })
      // Held until its signal aborts, as a call across a gateway restart can be.
      h.gateway.completeLifecycle.mockImplementation(
        (signal?: AbortSignal) =>
          new Promise<void>((_, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
      )
      const started = Date.now()

      await runWorker(h.deps)
      await vi.waitFor(() => expect(h.exitCodes()).toEqual([EXIT_DRAINED_FOR_TERMINATION]))

      expect(Date.now() - started).toBeLessThan(5_000)
      expect(h.gateway.completeLifecycle).toHaveBeenCalledTimes(1)
    })

    it('retries completing the lifecycle through a gateway that restarted, and exits once it has', async () => {
      const h = harness({ env: splitEnv() })
      h.gateway.termination.mockResolvedValueOnce({
        kind: 'auto-scaling',
        reason: 'Auto Scaling is terminating',
      })
      h.gateway.completeLifecycle
        .mockRejectedValueOnce(new Error('Could not reach the GitHub gateway'))
        .mockRejectedValueOnce(new Error('seen no Auto Scaling termination'))
        .mockResolvedValueOnce(undefined)

      await runWorker(h.deps)
      await vi.waitFor(() => expect(h.exitCodes()).toEqual([EXIT_DRAINED_FOR_TERMINATION]))

      expect(h.gateway.completeLifecycle).toHaveBeenCalledTimes(3)
    })

    it('drains and exits 0 on SIGTERM', async () => {
      const h = harness({ env: splitEnv() })
      await runWorker(h.deps)

      h.signals.get('SIGTERM')?.()
      await flush()

      expect(h.stop).toHaveBeenCalledWith({ reason: 'SIGTERM' })
      expect(h.exitCodes()).toEqual([0])
    })
  })
})

describe('pollGatewayForTermination', () => {
  it('returns the first notice, polling again at once after a null answer', async () => {
    const notice = { kind: 'auto-scaling' as const, reason: 'Auto Scaling is terminating' }
    const termination = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(notice)
    const sleep = vi.fn(async () => {})

    await expect(pollGatewayForTermination({ termination }, { sleep })).resolves.toEqual(notice)

    expect(termination).toHaveBeenCalledTimes(3)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('keeps polling across a rejected call, pausing and warning once for a run of failures', async () => {
    const notice = { kind: 'spot' as const, reason: 'spot interruption notice' }
    const termination = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ENOENT'))
      .mockRejectedValueOnce(new Error('connect ENOENT'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(notice)
    const sleep = vi.fn(async () => {})

    await expect(
      pollGatewayForTermination({ termination }, { sleep, retryMs: 1234 }),
    ).resolves.toEqual(notice)

    expect(termination).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls).toEqual([[1234], [1234]])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('warns again for a failure after a recovery', async () => {
    const termination = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValueOnce({ kind: 'spot', reason: 'r' })

    await pollGatewayForTermination({ termination }, { sleep: async () => {} })

    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})
