/**
 * The GitHub gateway entrypoint's `runGateway`, with every side effect injected: where it
 * listens, what it refuses to boot without, the stand-in it serves in place of a gateway that
 * could not boot, the scrubs of the secrets it reads, and how a signal ends it.
 *
 * Assertions read recorded calls and returned values, never a log line.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TASK_TIMEOUT,
  connectGitHubGateway,
  isPermanentTaskFailure,
  normalizeGitHubAppPrivateKey,
  redactEgress,
  serveGitHubGateway,
  type GitHubGateway,
  type GitHubGatewayHealth,
  type LocalGitHubGatewayOptions,
  type SelfCheckResult,
} from 'canopycms/worker/cms-worker'

const { fetchClerkSnapshotMock, rereadSecretMock } = vi.hoisted(() => ({
  fetchClerkSnapshotMock: vi.fn(),
  rereadSecretMock: vi.fn(),
}))

// A reactive secret re-reads through the module's own `getSecret`, not the one injected for the
// boot's first read.
vi.mock('./secrets', () => ({ getSecret: rereadSecretMock }))

vi.mock('canopycms-auth-clerk/cache-writer', () => ({
  fetchClerkSnapshot: fetchClerkSnapshotMock,
  refreshClerkCache: vi.fn(),
}))

import {
  GITHUB_GATEWAY_SOCKET_ENV,
  WORKER_CAPACITY_ENV,
  WORKER_CONTRACT_ENV,
  WORKER_CONTRACT_VERSION,
} from '../src/constructs/worker-lifecycle'
import {
  FAILED_BOOT_HOLD_MS,
  failedGateway,
  GATEWAY_DRAIN_GRACE_MS,
  resolveGatewayListen,
  runGateway,
  type RunGatewayDeps,
} from './gateway-run'

const PID = 4242
const STATE_DIRECTORY = '/var/lib/canopy-github'

/** The minimum a PAT-authenticated gateway needs, socket-activated as systemd runs it. */
const baseEnv = (): NodeJS.ProcessEnv => ({
  LISTEN_PID: String(PID),
  LISTEN_FDS: '1',
  CANOPYCMS_GITHUB_OWNER: 'acme',
  CANOPYCMS_GITHUB_REPO: 'site',
  CANOPYCMS_GITHUB_TOKEN: 'ghp_test_token',
  STATE_DIRECTORY,
  [WORKER_CONTRACT_ENV]: String(WORKER_CONTRACT_VERSION),
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Let promise reactions queued by the entrypoint run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  // Swallows what `gatewayLog*` write: `quietTestOutput` throws on stdout under CI.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fetchClerkSnapshotMock.mockReset()
  rereadSecretMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('resolveGatewayListen', () => {
  it('takes descriptor 3 when socket activation is addressed to this process', () => {
    expect(resolveGatewayListen({ LISTEN_PID: String(PID), LISTEN_FDS: '1' }, PID)).toEqual({
      fd: 3,
    })
  })

  it('prefers socket activation over a socket path', () => {
    expect(
      resolveGatewayListen(
        { LISTEN_PID: String(PID), LISTEN_FDS: '1', [GITHUB_GATEWAY_SOCKET_ENV]: '/x/s' },
        PID,
      ),
    ).toEqual({ fd: 3 })
  })

  it('refuses a descriptor addressed to another process, naming both variables', () => {
    expect(() => resolveGatewayListen({ LISTEN_PID: '1', LISTEN_FDS: '1' }, PID)).toThrow(
      /LISTEN_PID="1".*LISTEN_FDS="1"/,
    )
  })

  it('refuses a socket activation of two descriptors', () => {
    expect(() => resolveGatewayListen({ LISTEN_PID: String(PID), LISTEN_FDS: '2' }, PID)).toThrow(
      /exactly one descriptor/,
    )
  })

  it('refuses activation variables without a PID, even beside a socket path', () => {
    expect(() =>
      resolveGatewayListen({ LISTEN_FDS: '1', [GITHUB_GATEWAY_SOCKET_ENV]: '/x/s' }, PID),
    ).toThrow(/LISTEN_PID/)
  })

  it('binds the socket path when only the socket variable is set', () => {
    expect(resolveGatewayListen({ [GITHUB_GATEWAY_SOCKET_ENV]: '/tmp/g/s' }, PID)).toEqual({
      path: '/tmp/g/s',
    })
  })

  it('refuses to run with neither, saying how it is meant to run', () => {
    expect(() => resolveGatewayListen({}, PID)).toThrow(/canopy-github\.socket.*or with CANOPYCMS/)
  })
})

/** The gateway checks, all passing. */
const passingGatewayChecks = (): SelfCheckResult[] =>
  (['efs-unreadable', 'core-pattern', 'core-limit'] as const).map((check) => ({
    check,
    ok: true,
    detail: 'ok',
  }))

interface Served {
  gateway: GitHubGateway
  listen: { fd: number } | { path: string }
}

interface Harness {
  deps: RunGatewayDeps
  order: string[]
  getSecret: ReturnType<typeof vi.fn>
  createGateway: ReturnType<typeof vi.fn>
  serve: ReturnType<typeof vi.fn>
  served: Served[]
  drain: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  signals: Map<string, () => void>
  /** The gateway `createGateway` hands back. */
  gateway: { prepare: ReturnType<typeof vi.fn> }
  hold: ReturnType<typeof deferred<void>>
  sleep: ReturnType<typeof vi.fn>
  exitCodes: () => number[]
  options: () => LocalGitHubGatewayOptions
}

function harness(overrides: Partial<RunGatewayDeps> = {}): Harness {
  const order: string[] = []
  const signals = new Map<string, () => void>()
  const served: Served[] = []
  const hold = deferred()
  const gateway = { prepare: vi.fn(async () => {}) }
  const getSecret = vi.fn(async (_arn: string) => {
    order.push('getSecret')
    return 'secret-value'
  })
  const createGateway = vi.fn((_options: LocalGitHubGatewayOptions) => {
    order.push('createGateway')
    return gateway as unknown as GitHubGateway
  })
  const drain = vi.fn(async (_graceMs: number) => {})
  const serve = vi.fn(async (served_: GitHubGateway, listen: Served['listen']) => {
    served.push({ gateway: served_, listen })
    return { drain }
  })
  const exit = vi.fn((_code: number) => {})
  const sleep = vi.fn((_ms: number) => hold.promise)

  const deps: RunGatewayDeps = {
    env: baseEnv(),
    pid: PID,
    getSecret,
    exit,
    onSignal: (signal, handler) => {
      signals.set(signal, handler)
    },
    gatewaySelfChecks: vi.fn(async () => {
      order.push('self-checks')
      return passingGatewayChecks()
    }),
    createGateway,
    serve,
    watchForTermination: vi.fn(() => new Promise<never>(() => {})),
    completeTerminationLifecycleAction: vi.fn(async () => {}),
    sleep,
    ...overrides,
  }
  return {
    deps,
    order,
    getSecret,
    createGateway,
    serve,
    served,
    drain,
    exit,
    signals,
    gateway,
    hold,
    sleep,
    exitCodes: () => exit.mock.calls.map(([code]) => code),
    options: () => createGateway.mock.calls[0][0],
  }
}

/** The health the stand-in the harness served answers. */
async function standInHealth(h: Harness): Promise<GitHubGatewayHealth> {
  expect(h.served).toHaveLength(1)
  return h.served[0].gateway.health()
}

describe('failedGateway: the stand-in a failed boot serves', () => {
  const notice = { kind: 'auto-scaling', reason: 'scale-in' } as const
  const instance = {
    termination: vi.fn(async () => notice),
    completeLifecycle: vi.fn(async () => undefined),
  }
  const standIn = failedGateway('the cause', instance)
  const instanceOperations = ['termination', 'completeLifecycle']

  it('answers health with the cause and nothing ready', async () => {
    await expect(standIn.health()).resolves.toEqual({
      ready: false,
      fatalError: 'the cause',
      preflight: 'pending',
      clerkConfigured: false,
      branchPolicy: {
        configured: [],
        githubDefault: null,
        namespace: '',
        legacy: [],
        settingsBranch: null,
      },
    })
  })

  // Called directly: over a socket the server's own prepare gate rejects most of these first.
  it.each(
    Object.keys(standIn).filter((name) => name !== 'health' && !instanceOperations.includes(name)),
  )('rejects %s with the cause, as a plain error with no status', async (name) => {
    const operation = (standIn as unknown as Record<string, () => Promise<unknown>>)[name]

    const rejection: unknown = await operation().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).toMatchObject({
      message: 'the cause',
      name: 'GitHubGatewayNotStartedError',
    })
    expect(rejection).not.toHaveProperty('status')
    expect(isPermanentTaskFailure(rejection)).toBe(false)
  })

  it('answers the instance operations through the instance it is given', async () => {
    const signal = new AbortController().signal

    await expect(standIn.termination(signal)).resolves.toEqual(notice)
    await expect(standIn.completeLifecycle(signal)).resolves.toBeUndefined()

    expect(instance.termination).toHaveBeenCalledWith(signal)
    expect(instance.completeLifecycle).toHaveBeenCalledWith(signal)
  })
})

describe('runGateway: a healthy boot on a token', () => {
  it('runs the self-checks before reading any secret, then serves the gateway it built', async () => {
    const h = harness({
      env: {
        ...baseEnv(),
        CANOPYCMS_GITHUB_TOKEN: '',
        CANOPYCMS_GITHUB_TOKEN_SECRET_ARN: 'arn:tok',
        CANOPYCMS_BASE_BRANCH: 'trunk',
        CANOPYCMS_PROTECTED_BRANCHES: 'release/*, production',
      },
    })

    await runGateway(h.deps)

    expect(h.order).toEqual(['self-checks', 'getSecret', 'createGateway'])
    // Told the descriptor, whose socket's owner the gateway must not be.
    expect(h.deps.gatewaySelfChecks).toHaveBeenCalledWith({ fd: 3 })
    expect(h.createGateway).toHaveBeenCalledTimes(1)
    const options = h.options()
    expect(options).toMatchObject({
      githubOwner: 'acme',
      githubRepo: 'site',
      githubApp: false,
      stateDirectory: STATE_DIRECTORY,
      timeoutMs: DEFAULT_TASK_TIMEOUT,
      baseBranch: 'trunk',
      protectedBranches: ['release/*', 'production'],
    })
    expect(options).not.toHaveProperty('workspacePath')
    expect(h.serve).toHaveBeenCalledWith(h.gateway, { fd: 3 })
    expect(h.gateway.prepare).toHaveBeenCalledTimes(1)
    expect(h.exit).not.toHaveBeenCalled()
    expect(h.sleep).not.toHaveBeenCalled()
  })

  it('leaves the base branch unset and the protected set empty when the variables are absent', async () => {
    const h = harness()

    await runGateway(h.deps)

    expect(h.options().baseBranch).toBeUndefined()
    expect(h.options().protectedBranches).toEqual([])
    expect(h.options().legacyBranches).toEqual([])
  })

  it('passes CANOPYCMS_LEGACY_BRANCHES as a list', async () => {
    const h = harness({ env: { ...baseEnv(), CANOPYCMS_LEGACY_BRANCHES: 'spring, fix/typos,,' } })

    await runGateway(h.deps)

    expect(h.options().legacyBranches).toEqual(['spring', 'fix/typos'])
  })

  it.each([
    [{}, 'canopycms/prod/'],
    [{ CANOPYCMS_DEPLOYMENT_NAME: 'docs' }, 'canopycms/docs/'],
    [{ CANOPYCMS_BRANCH_NAMESPACE: 'editor-production/' }, 'editor-production/'],
    [
      { CANOPYCMS_BRANCH_NAMESPACE: 'editor-{deployment}/', CANOPYCMS_DEPLOYMENT_NAME: 'docs' },
      'editor-docs/',
    ],
  ])('resolves the branch namespace from %j as the worker does: %s', async (vars, expected) => {
    // resolveDeploymentName reads the process's variable first; the harness's env stands in for it.
    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
    const h = harness({ env: { ...baseEnv(), ...vars } })

    await runGateway(h.deps)

    expect(h.options().branchNamespace).toBe(expected)
  })

  it.each([
    [{}, 'canopycms-settings-prod'],
    [{ CANOPYCMS_DEPLOYMENT_NAME: 'docs' }, 'canopycms-settings-docs'],
    [
      { CANOPYCMS_DEPLOYMENT_NAME: 'docs', CANOPYCMS_SETTINGS_BRANCH: 'site-settings' },
      'site-settings',
    ],
  ])('resolves the settings branch from %j as the worker does: %s', async (vars, expected) => {
    // resolveDeploymentName reads the process's variable first; the harness's env stands in for it.
    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
    const h = harness({ env: { ...baseEnv(), ...vars } })

    await runGateway(h.deps)

    expect(h.options().settingsBranch).toBe(expected)
  })

  it('gives the gateway an auth snapshot only when a Clerk key is configured', async () => {
    const without = harness()
    await runGateway(without.deps)
    expect(without.options().authSnapshot).toBeUndefined()

    const withKey = harness({ env: { ...baseEnv(), CLERK_SECRET_KEY: 'sk_test_clerk_key' } })
    await runGateway(withKey.deps)
    expect(withKey.options().authSnapshot).toBeTypeOf('function')
  })

  it.each([
    [undefined, true],
    ['true', true],
    ['false', false],
  ])(
    'passes CANOPYCMS_CLERK_ORGANIZATIONS_AS_GROUPS=%j to the Clerk snapshot fetch as %s',
    async (value, expected) => {
      fetchClerkSnapshotMock.mockReset()
      fetchClerkSnapshotMock.mockResolvedValue({ users: [], groups: [], memberships: {} })
      const env: NodeJS.ProcessEnv = { ...baseEnv(), CLERK_SECRET_KEY: 'sk_test_clerk_key' }
      if (value !== undefined) env.CANOPYCMS_CLERK_ORGANIZATIONS_AS_GROUPS = value
      const h = harness({ env })
      await runGateway(h.deps)

      await h.options().authSnapshot?.()

      expect(fetchClerkSnapshotMock).toHaveBeenCalledWith(
        expect.objectContaining({ useOrganizationsAsGroups: expected }),
      )
    },
  )

  it('reads the termination watch’s spot setting from the environment', async () => {
    const h = harness({ env: { ...baseEnv(), [WORKER_CAPACITY_ENV]: 'spot' } })
    await runGateway(h.deps)

    void h.options().watchTermination?.()
    expect(h.deps.watchForTermination).toHaveBeenCalledWith({ watchSpot: true })

    const onDemand = harness()
    await runGateway(onDemand.deps)
    void onDemand.options().watchTermination?.()
    expect(onDemand.deps.watchForTermination).toHaveBeenCalledWith({ watchSpot: false })
  })

  it('completes the lifecycle action through the injected provider', async () => {
    const h = harness()
    await runGateway(h.deps)

    await h.options().completeLifecycle?.()

    expect(h.deps.completeTerminationLifecycleAction).toHaveBeenCalledTimes(1)
  })

  it('listens on the socket path when it is not socket-activated', async () => {
    const env = baseEnv()
    delete env.LISTEN_PID
    delete env.LISTEN_FDS
    env[GITHUB_GATEWAY_SOCKET_ENV] = '/tmp/g/s'
    const h = harness({ env })

    await runGateway(h.deps)

    expect(h.serve).toHaveBeenCalledWith(h.gateway, { path: '/tmp/g/s' })
  })

  it('builds a gateway on a GitHub App when the trio is set', async () => {
    const env = baseEnv()
    delete env.CANOPYCMS_GITHUB_TOKEN
    const h = harness({
      env: {
        ...env,
        CANOPYCMS_GITHUB_APP_ID: '123',
        CANOPYCMS_GITHUB_APP_INSTALLATION_ID: '456',
        CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN: 'arn:app-key',
      },
    })

    await runGateway(h.deps)

    expect(h.options().githubApp).toBe(true)
    expect(h.getSecret).toHaveBeenCalledWith('arn:app-key', expect.any(Object))
  })
})

describe('runGateway: a listen address that serves nothing', () => {
  it('exits 1 without serving anything', async () => {
    const h = harness({ env: { ...baseEnv(), LISTEN_PID: '1' } })

    await runGateway(h.deps)

    expect(h.exitCodes()).toEqual([1])
    expect(h.serve).not.toHaveBeenCalled()
    expect(h.deps.gatewaySelfChecks).not.toHaveBeenCalled()
  })
})

describe('runGateway: a boot that fails serves the cause, then exits 1', () => {
  it.each(['efs-unreadable', 'core-pattern', 'core-limit'] as const)(
    'refuses to start on a failed %s check, reading no secret and building no gateway',
    async (failing) => {
      const h = harness({
        env: {
          ...baseEnv(),
          CANOPYCMS_GITHUB_TOKEN: '',
          CANOPYCMS_GITHUB_TOKEN_SECRET_ARN: 'arn:tok',
        },
        gatewaySelfChecks: async () =>
          passingGatewayChecks().map((result) =>
            result.check === failing ? { ...result, ok: false, detail: 'it did not take' } : result,
          ),
      })

      const running = runGateway(h.deps)
      await flush()

      expect(h.getSecret).not.toHaveBeenCalled()
      expect(h.createGateway).not.toHaveBeenCalled()
      const health = await standInHealth(h)
      expect(health).toMatchObject({ ready: false, clerkConfigured: false })
      expect(health.fatalError).toContain(`${failing}: it did not take`)

      // Held for the worker to read, then ended so systemd starts the gateway again.
      expect(h.sleep).toHaveBeenCalledWith(FAILED_BOOT_HOLD_MS)
      expect(h.exit).not.toHaveBeenCalled()
      h.hold.resolve()
      await running
      expect(h.drain).toHaveBeenCalledWith(0)
      expect(h.exitCodes()).toEqual([1])
    },
  )

  it('serves a CANOPYCMS_CLERK_ORGANIZATIONS_AS_GROUPS that is neither true nor false, before reading any secret', async () => {
    const h = harness({
      env: {
        ...baseEnv(),
        CANOPYCMS_GITHUB_TOKEN: '',
        CANOPYCMS_GITHUB_TOKEN_SECRET_ARN: 'arn:tok',
        CANOPYCMS_CLERK_ORGANIZATIONS_AS_GROUPS: 'nope',
      },
    })

    const running = runGateway(h.deps)
    await flush()

    const { fatalError } = await standInHealth(h)
    expect(fatalError).toContain('CANOPYCMS_CLERK_ORGANIZATIONS_AS_GROUPS')
    expect(fatalError).toContain('"nope"')
    expect(h.getSecret).not.toHaveBeenCalled()
    expect(h.createGateway).not.toHaveBeenCalled()
    h.hold.resolve()
    await running
    expect(h.exitCodes()).toEqual([1])
  })

  it('serves a rejected getSecret’s message', async () => {
    const h = harness({
      env: {
        ...baseEnv(),
        CANOPYCMS_GITHUB_TOKEN: '',
        CANOPYCMS_GITHUB_TOKEN_SECRET_ARN: 'arn:tok',
      },
      getSecret: vi.fn(async () => {
        throw new Error('AccessDeniedException: not authorized to GetSecretValue')
      }),
    })

    const running = runGateway(h.deps)
    await flush()

    expect((await standInHealth(h)).fatalError).toBe(
      'AccessDeniedException: not authorized to GetSecretValue',
    )
    expect(h.createGateway).not.toHaveBeenCalled()
    h.hold.resolve()
    await running
    expect(h.exitCodes()).toEqual([1])
  })

  it('serves a partial App trio’s message', async () => {
    const h = harness({ env: { ...baseEnv(), CANOPYCMS_GITHUB_APP_ID: '123' } })

    const running = runGateway(h.deps)
    await flush()

    expect((await standInHealth(h)).fatalError).toContain(
      'CANOPYCMS_GITHUB_APP_INSTALLATION_ID and CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN are not set',
    )
    h.hold.resolve()
    await running
    expect(h.exitCodes()).toEqual([1])
  })

  it('serves a missing state directory’s message, naming the directive to add', async () => {
    const env = baseEnv()
    delete env.STATE_DIRECTORY
    const h = harness({ env })

    const running = runGateway(h.deps)
    await flush()

    expect((await standInHealth(h)).fatalError).toContain('StateDirectory=canopy-github')
    h.hold.resolve()
    await running
  })

  it('serves a credential-less configuration’s message', async () => {
    const env = baseEnv()
    delete env.CANOPYCMS_GITHUB_TOKEN
    const h = harness({ env })

    const running = runGateway(h.deps)
    await flush()

    expect((await standInHealth(h)).fatalError).toContain('CANOPYCMS_GITHUB_TOKEN or')
    h.hold.resolve()
    await running
  })

  it('serves a unit stamped below the bundle', async () => {
    const h = harness({ env: { ...baseEnv(), [WORKER_CONTRACT_ENV]: '0' } })

    const running = runGateway(h.deps)
    await flush()

    expect((await standInHealth(h)).fatalError).toContain('template too old for this bundle')
    h.hold.resolve()
    await running
  })

  it('scrubs a token out of the cause it serves', async () => {
    const leaked = `ghp_${randomBytes(18).toString('hex')}`
    const h = harness({
      env: {
        ...baseEnv(),
        CANOPYCMS_GITHUB_TOKEN: '',
        CANOPYCMS_GITHUB_TOKEN_SECRET_ARN: 'arn:tok',
      },
      getSecret: vi.fn(async () => {
        throw new Error(`could not parse ${leaked}`)
      }),
    })

    const running = runGateway(h.deps)
    await flush()

    const { fatalError } = await standInHealth(h)
    expect(fatalError).toContain('could not parse')
    expect(fatalError).not.toContain(leaked)
    h.hold.resolve()
    await running
  })

  it('exits 1 at once when the stand-in cannot be served either', async () => {
    const h = harness({
      gatewaySelfChecks: async () => [{ check: 'core-limit', ok: false, detail: 'x' }],
      serve: vi.fn(async () => {
        throw new Error('EADDRINUSE')
      }),
    })

    await runGateway(h.deps)

    expect(h.exitCodes()).toEqual([1])
    expect(h.sleep).not.toHaveBeenCalled()
  })

  it('serves the stand-in when the real gateway cannot be served', async () => {
    const h = harness()
    h.serve.mockImplementationOnce(async () => {
      throw new Error('EACCES: the socket directory is not private')
    })

    const running = runGateway(h.deps)
    await flush()

    expect((await standInHealth(h)).fatalError).toContain('EACCES')
    h.hold.resolve()
    await running
  })
})

describe('the exact scrubs of what the gateway reads', () => {
  it('scrubs the App’s private key as configured and as normalized, and the Clerk key', async () => {
    const pkcs1 = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString()
    const pkcs8 = normalizeGitHubAppPrivateKey(pkcs1)
    // A body line, not the BEGIN/END lines: `redactCredentials` scrubs a whole PEM block by pattern.
    const bodyLine = (pem: string) => pem.split('\n')[2]
    const clerkKey = `clerk_${randomBytes(16).toString('hex')}`
    const h = harness({
      env: {
        ...baseEnv(),
        CANOPYCMS_GITHUB_TOKEN: '',
        CANOPYCMS_GITHUB_APP_ID: '123',
        CANOPYCMS_GITHUB_APP_INSTALLATION_ID: '456',
        CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN: 'arn:app-key',
        CLERK_SECRET_KEY: clerkKey,
      },
      getSecret: vi.fn(async () => pkcs1),
    })
    const lines = [bodyLine(pkcs1), bodyLine(pkcs8)]
    expect(bodyLine(pkcs1)).not.toBe(bodyLine(pkcs8))
    for (const text of [...lines, clerkKey]) expect(redactEgress(`x ${text} y`)).toContain(text)

    await runGateway(h.deps)

    for (const line of lines) expect(redactEgress(`x ${line} y`)).toBe('x *** y')
    expect(redactEgress(`key ${clerkKey} rejected`)).toBe('key *** rejected')
  })

  it('scrubs a Clerk key rotated in after a rejection of the first', async () => {
    const first = `clerk_${randomBytes(16).toString('hex')}`
    const rotated = `clerk_${randomBytes(16).toString('hex')}`
    const rejection = Object.assign(new Error('Unauthenticated'), { status: 401 })
    fetchClerkSnapshotMock.mockRejectedValueOnce(rejection).mockResolvedValueOnce({
      users: [],
      groups: [],
      memberships: {},
    })
    const h = harness({
      env: {
        ...baseEnv(),
        CLERK_SECRET_KEY: '',
        CLERK_SECRET_KEY_SECRET_ARN: 'arn:clerk',
      },
      getSecret: vi.fn(async () => first),
    })
    rereadSecretMock.mockResolvedValue(rotated)
    await runGateway(h.deps)
    expect(redactEgress(`k ${first} k`)).toBe('k *** k')
    expect(redactEgress(`k ${rotated} k`)).toContain(rotated)

    await h.options().authSnapshot?.()

    expect(fetchClerkSnapshotMock.mock.calls.map(([call]) => call.secretKey)).toEqual([
      first,
      rotated,
    ])
    expect(redactEgress(`k ${rotated} k`)).toBe('k *** k')
  })
})

describe('runGateway: a failed prepare', () => {
  it('keeps answering its fatal error for the hold, then drains and exits 1, as a failed boot does', async () => {
    const h = harness()
    h.gateway.prepare.mockRejectedValue(new Error('GitHub App authentication failed: 401'))

    await runGateway(h.deps)
    await flush()

    // The real gateway stays served through the hold: its `health` answers prepare's failure.
    expect(h.served).toHaveLength(1)
    expect(h.served[0].gateway).toBe(h.gateway)
    expect(h.sleep).toHaveBeenCalledWith(FAILED_BOOT_HOLD_MS)
    expect(h.drain).not.toHaveBeenCalled()
    expect(h.exit).not.toHaveBeenCalled()

    h.hold.resolve()
    await flush()

    expect(h.drain).toHaveBeenCalledWith(0)
    expect(h.exitCodes()).toEqual([1])
  })

  it('drains and exits 0 on a SIGTERM during the hold, and not 1 after it', async () => {
    const h = harness()
    h.gateway.prepare.mockRejectedValue(new Error('GitHub App authentication failed: 401'))

    await runGateway(h.deps)
    await flush()
    h.signals.get('SIGTERM')?.()
    await flush()
    h.hold.resolve()
    await flush()

    expect(h.drain).toHaveBeenCalledTimes(1)
    expect(h.drain).toHaveBeenCalledWith(GATEWAY_DRAIN_GRACE_MS)
    expect(h.exitCodes()).toEqual([0])
  })

  it('neither holds nor exits once prepare has succeeded', async () => {
    const h = harness()

    await runGateway(h.deps)
    await flush()

    expect(h.gateway.prepare).toHaveBeenCalledTimes(1)
    expect(h.sleep).not.toHaveBeenCalled()
    expect(h.exit).not.toHaveBeenCalled()
  })
})

describe('runGateway: SIGTERM and SIGINT', () => {
  it('drains with the grace, then exits 0 only once the drain has finished', async () => {
    const draining = deferred()
    const h = harness()
    h.drain.mockImplementation(() => draining.promise)
    await runGateway(h.deps)

    h.signals.get('SIGTERM')?.()
    await flush()

    expect(h.drain).toHaveBeenCalledTimes(1)
    expect(h.drain).toHaveBeenCalledWith(GATEWAY_DRAIN_GRACE_MS)
    expect(h.exit).not.toHaveBeenCalled()

    draining.resolve()
    await flush()
    expect(h.exitCodes()).toEqual([0])
  })

  it('ignores a second signal, of either kind', async () => {
    const draining = deferred()
    const h = harness()
    h.drain.mockImplementation(() => draining.promise)
    await runGateway(h.deps)

    h.signals.get('SIGTERM')?.()
    h.signals.get('SIGTERM')?.()
    h.signals.get('SIGINT')?.()
    await flush()
    draining.resolve()
    await flush()

    expect(h.drain).toHaveBeenCalledTimes(1)
    expect(h.exitCodes()).toEqual([0])
  })

  it('exits 0 even when the drain fails', async () => {
    const h = harness()
    h.drain.mockRejectedValue(new Error('close failed'))
    await runGateway(h.deps)

    h.signals.get('SIGINT')?.()
    await flush()

    expect(h.exitCodes()).toEqual([0])
  })

  it('drains the stand-in during its hold and exits 0, not 1', async () => {
    const h = harness({
      gatewaySelfChecks: async () => [{ check: 'core-limit', ok: false, detail: 'x' }],
    })

    const running = runGateway(h.deps)
    await flush()
    h.signals.get('SIGTERM')?.()
    await flush()

    expect(h.drain).toHaveBeenCalledTimes(1)
    expect(h.drain).toHaveBeenCalledWith(GATEWAY_DRAIN_GRACE_MS)
    expect(h.exitCodes()).toEqual([0])

    h.hold.resolve()
    await running
    expect(h.drain).toHaveBeenCalledTimes(1)
    expect(h.exitCodes()).toEqual([0])
  })
})

describe('over a real socket', () => {
  let dir: string

  beforeEach(async () => {
    // Short: macOS caps a socket path at 104 bytes. mkdtemp makes it 0700.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gr-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  /** An env that listens on a path in `dir`, as a hand run does. */
  const socketEnv = (): { env: NodeJS.ProcessEnv; socketPath: string } => {
    const socketPath = path.join(dir, 'g.sock')
    const env = baseEnv()
    delete env.LISTEN_PID
    delete env.LISTEN_FDS
    env[GITHUB_GATEWAY_SOCKET_ENV] = socketPath
    return { env, socketPath }
  }

  it('reports a gateway whose prepare failed to the worker as its fatal error', async () => {
    const { env, socketPath } = socketEnv()
    const failure = 'The state directory is writable by others'
    const h = harness({ env, serve: serveGitHubGateway })
    h.createGateway.mockImplementation(
      () =>
        ({
          prepare: async () => {
            throw new Error(failure)
          },
          health: async (): Promise<GitHubGatewayHealth> => ({
            ready: false,
            fatalError: failure,
            preflight: 'pending',
            clerkConfigured: false,
            branchPolicy: {
              configured: [],
              githubDefault: null,
              namespace: '',
              legacy: [],
              settingsBranch: null,
            },
          }),
        }) as unknown as GitHubGateway,
    )

    await runGateway(h.deps)
    await flush()

    const health = await connectGitHubGateway(socketPath).health()
    expect(health.fatalError).toBe(failure)
    expect(health.ready).toBe(false)
    expect(h.exit).not.toHaveBeenCalled()

    h.signals.get('SIGTERM')?.()
    await vi.waitFor(() => expect(h.exitCodes()).toEqual([0]))
  })

  it('serves a stand-in for a failed boot that answers health and fails the GitHub operations as transient', async () => {
    const { env, socketPath } = socketEnv()
    const h = harness({
      env,
      serve: serveGitHubGateway,
      gatewaySelfChecks: async () => [
        { check: 'efs-unreadable', ok: false, detail: 'it can read /mnt/efs' },
      ],
    })

    const running = runGateway(h.deps)
    await vi.waitFor(async () => {
      await fs.stat(socketPath)
    })
    const client = connectGitHubGateway(socketPath)

    const health = await client.health()
    expect(health.ready).toBe(false)
    expect(health.fatalError).toContain('efs-unreadable: it can read /mnt/efs')

    const rejections = await Promise.all(
      [() => client.defaultBranch(), () => client.authSnapshot()].map((call) =>
        call().then(
          () => undefined,
          (err: unknown) => err,
        ),
      ),
    )
    for (const rejection of rejections) {
      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).message).toContain('efs-unreadable: it can read /mnt/efs')
      expect(isPermanentTaskFailure(rejection)).toBe(false)
    }

    h.signals.get('SIGTERM')?.()
    await vi.waitFor(() => expect(h.exitCodes()).toEqual([0]))
    h.hold.resolve()
    await running
    expect(h.exitCodes()).toEqual([0])
  })

  describe('the stand-in, asked for the instance operations by a worker that may be hostile', () => {
    /** A failed boot served on a path, with `watch` as the instance's termination watch. */
    async function standInServed(watch: RunGatewayDeps['watchForTermination']) {
      const { env, socketPath } = socketEnv()
      const h = harness({
        env: { ...env, [WORKER_CAPACITY_ENV]: 'spot' },
        serve: serveGitHubGateway,
        gatewaySelfChecks: async () => [{ check: 'core-limit', ok: false, detail: 'unlimited' }],
        watchForTermination: vi.fn(watch),
      })
      const running = runGateway(h.deps)
      await vi.waitFor(async () => {
        await fs.stat(socketPath)
      })
      const stop = async () => {
        h.signals.get('SIGTERM')?.()
        await vi.waitFor(() => expect(h.exitCodes()).toEqual([0]))
        h.hold.resolve()
        await running
      }
      return { h, client: connectGitHubGateway(socketPath), stop }
    }

    it('answers its own watch’s notice and completes the lifecycle action once, whatever the calls', async () => {
      const { h, client, stop } = await standInServed(async () => ({
        kind: 'auto-scaling',
        reason: 'scale-in',
      }))

      expect(await client.termination()).toEqual({ kind: 'auto-scaling', reason: 'scale-in' })
      await Promise.all([client.completeLifecycle(), client.completeLifecycle()])
      await client.completeLifecycle()

      expect(h.deps.watchForTermination).toHaveBeenCalledWith({ watchSpot: true })
      expect(h.deps.watchForTermination).toHaveBeenCalledTimes(1)
      expect(h.deps.completeTerminationLifecycleAction).toHaveBeenCalledTimes(1)
      await stop()
    })

    it('refuses to complete the lifecycle action on any notice but its own Auto Scaling one', async () => {
      const { h, client, stop } = await standInServed(async () => ({
        kind: 'spot',
        reason: 'spot interruption',
      }))

      const refusal: unknown = await client.completeLifecycle().catch((err: unknown) => err)

      expect(refusal).toBeInstanceOf(Error)
      expect((refusal as Error).message).toMatch(/seen no Auto Scaling termination/)
      expect(h.deps.completeTerminationLifecycleAction).not.toHaveBeenCalled()
      await stop()
    })
  })
})
