/**
 * The EC2 worker entrypoint's `runWorker`, with every side effect injected: what
 * a failure BEFORE `worker.start()` records, what a failure OF `start()` does
 * not, and which exit status the process takes in each case.
 *
 * Every assertion reads a recorded call or a returned value, never a log line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CmsWorkerConfig, WorkerSelfStop } from 'canopycms/worker/cms-worker'

import {
  EXIT_DRAINED_FOR_TERMINATION,
  EXIT_WORKER_SELF_STOPPED,
  WORKER_CONTRACT_ENV,
  WORKER_CONTRACT_VERSION,
  unitWorkerContract,
} from '../src/constructs/worker-lifecycle'
import { readGitHubAppEnv, runWorker, type RunWorkerDeps, type WorkerHandle } from './run'

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

beforeEach(() => {
  // Swallows what `workerLog*` write: `quietTestOutput` throws on stdout under CI.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
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

  it('runs an unstamped unit that has StateDirectory= as contract 1', async () => {
    const h = harness({ env: envWithout(WORKER_CONTRACT_ENV) })

    await runWorker(h.deps)

    expect(h.record).not.toHaveBeenCalled()
    expect(h.start).toHaveBeenCalled()
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
