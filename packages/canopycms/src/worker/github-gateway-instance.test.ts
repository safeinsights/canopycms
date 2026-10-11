/**
 * The gateway's three instance-level operations: the auth provider's snapshot, the termination
 * poll and the lifecycle completion. Each runs in-process and through the socket, where the worker
 * is a client that may be hostile: it can ask for anything, in any order.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthCacheSnapshot } from '../auth/cache'
import { mockConsole, type MockConsole } from '../test-utils'
import { registerSecretText } from './gateway-egress'
import { resolveWorkerGitHubAuth } from './github-auth'
import {
  createLocalGitHubGateway,
  type GatewayTerminationNotice,
  type GitHubGateway,
  type LocalGitHubGatewayOptions,
} from './github-gateway'
import {
  connectGitHubGateway,
  serveGitHubGateway,
  type GitHubGatewayServer,
} from './github-gateway-http'

const SNAPSHOT: AuthCacheSnapshot = {
  users: [
    { id: 'user_1', name: 'Ada', email: 'ada@example.test', avatarUrl: 'https://img.test/ada' },
    { id: 'user_2', name: 'Bo', email: 'bo@example.test' },
  ],
  groups: [
    { id: 'org_1', name: 'Core', description: 'The core team', memberCount: 2 },
    { id: 'org_2', name: 'Docs' },
  ],
  memberships: { user_1: ['org_1', 'org_2'], user_2: ['org_1'] },
}

const AUTO_SCALING: GatewayTerminationNotice = { kind: 'auto-scaling', reason: 'scale-in' }
const SPOT: GatewayTerminationNotice = { kind: 'spot', reason: 'spot interruption' }

let root: string
let consoleSpy: MockConsole
let servers: GitHubGatewayServer[]

beforeEach(async () => {
  consoleSpy = mockConsole()
  // Short: macOS caps a socket path at 104 bytes.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gwi-')))
  servers = []
})

afterEach(async () => {
  for (const server of servers) await server.close()
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

type Reach = 'in-process' | 'socket'

/** The auth a gateway under test holds, whose GitHub re-read a test can watch. */
function watchedAuth() {
  const auth = resolveWorkerGitHubAuth({ githubToken: 'fake-token' })
  return { auth, refresh: vi.spyOn(auth, 'refreshCredential') }
}

/** A local gateway with `overrides`, reached the way `reach` says. */
async function gatewayReachedBy(
  reach: Reach,
  overrides: Partial<LocalGitHubGatewayOptions> = {},
): Promise<GitHubGateway> {
  const local = createLocalGitHubGateway({
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    auth: resolveWorkerGitHubAuth({ githubToken: 'fake-token' }),
    githubApp: false,
    stateDirectory: path.join(root, 'state'),
    workspacePath: path.join(root, 'workspace'),
    timeoutMs: 30_000,
    prefetch: false,
    ...overrides,
  })
  if (reach === 'in-process') return local
  const socketPath = path.join(root, `s${servers.length}`)
  servers.push(await serveGitHubGateway(local, { path: socketPath }))
  const client = connectGitHubGateway(socketPath)
  // The server prepares its gateway as it starts; the test removes its directory afterwards.
  await client.prepare()
  return client
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

/** A watch that never resolves. */
const neverNotified = () => new Promise<GatewayTerminationNotice>(() => undefined)

describe.each<Reach>(['in-process', 'socket'])('the instance operations, %s', (reach) => {
  const gateway = (overrides: Partial<LocalGitHubGatewayOptions> = {}) =>
    gatewayReachedBy(reach, overrides)

  describe('authSnapshot', () => {
    it("returns the provider's snapshot", async () => {
      const provider = vi.fn(async () => SNAPSHOT)
      const github = await gateway({ authSnapshot: provider })

      expect(await github.authSnapshot()).toEqual(SNAPSHOT)
      expect(provider).toHaveBeenCalledTimes(1)
    })

    it('rejects when no provider is configured', async () => {
      await expect((await gateway()).authSnapshot()).rejects.toThrow(/no auth provider key/)
    })

    it('reports Clerk configured only with a provider', async () => {
      const without = await gateway()
      const withProvider = await gateway({ authSnapshot: async () => SNAPSHOT })

      expect((await without.health()).clerkConfigured).toBe(false)
      expect((await withProvider.health()).clerkConfigured).toBe(true)
    })

    it("scrubs a registered key from the provider's error and from its answer", async () => {
      const key = `sk_live_${'q7'.repeat(20)}`
      registerSecretText(key)
      const failing = await gateway({
        authSnapshot: async () => {
          throw Object.assign(new Error(`Clerk refused ${key}`), { stderr: `via ${key}` })
        },
      })
      const leaking = await gateway({
        authSnapshot: async () => ({
          ...SNAPSHOT,
          users: [{ id: 'user_3', name: `name ${key}`, email: 'c@example.test' }],
        }),
      })

      const error = await failing.authSnapshot().catch((err: unknown) => err)
      const snapshot = await leaking.authSnapshot()

      expect(String((error as Error).message)).not.toContain(key)
      expect(JSON.stringify(snapshot)).not.toContain(key)
      expect(snapshot.users[0].name).toContain('***')
    })

    it('never arms the GitHub credential re-read, whatever the provider does', async () => {
      const { auth, refresh } = watchedAuth()
      const github = await gateway({
        auth,
        authSnapshot: async () => {
          throw Object.assign(new Error('Unauthorized'), { status: 401 })
        },
      })

      await expect(github.authSnapshot()).rejects.toThrow('Unauthorized')
      await settle()

      expect(refresh).not.toHaveBeenCalled()
    })
  })

  describe('termination', () => {
    it('answers the notice once the watch resolves', async () => {
      const github = await gateway({ watchTermination: async () => AUTO_SCALING })

      expect(await github.termination()).toEqual(AUTO_SCALING)
    })

    it('answers null when no notice comes within the poll wait', async () => {
      const github = await gateway({
        watchTermination: neverNotified,
        terminationPollWaitMs: 50,
      })

      const started = Date.now()
      expect(await github.termination()).toBeNull()
      expect(Date.now() - started).toBeGreaterThanOrEqual(40)
    })

    it('starts the watch once, across many calls', async () => {
      const watch = vi.fn(neverNotified)
      const github = await gateway({ watchTermination: watch, terminationPollWaitMs: 20 })

      await Promise.all([github.termination(), github.termination()])
      await github.termination()

      expect(watch).toHaveBeenCalledTimes(1)
    })

    it('answers null after the wait when nothing watches', async () => {
      const github = await gateway({ terminationPollWaitMs: 50 })

      const started = Date.now()
      expect(await github.termination()).toBeNull()
      expect(Date.now() - started).toBeGreaterThanOrEqual(40)
    })

    it('answers the same notice again once it has arrived', async () => {
      const watch = vi.fn(async () => AUTO_SCALING)
      const github = await gateway({ watchTermination: watch })

      expect(await github.termination()).toEqual(AUTO_SCALING)
      expect(await github.termination()).toEqual(AUTO_SCALING)
      expect(watch).toHaveBeenCalledTimes(1)
    })

    it('logs a failed watch, answers null once the poll has waited, and starts the watch again on the next call', async () => {
      const watch = vi
        .fn<() => Promise<GatewayTerminationNotice>>()
        .mockRejectedValueOnce(new Error('IMDS timed out'))
        .mockResolvedValueOnce(SPOT)
      const github = await gateway({ watchTermination: watch, terminationPollWaitMs: 200 })

      const asked = performance.now()
      expect(await github.termination()).toBeNull()
      // Paced: a client polling in a loop must not restart a failing watch as fast as it can ask.
      expect(performance.now() - asked).toBeGreaterThanOrEqual(150)
      expect(await github.termination()).toEqual(SPOT)

      expect(watch).toHaveBeenCalledTimes(2)
      expect(consoleSpy.all().error.join('\n')).toContain('IMDS timed out')
    })

    it("ends a wait when the caller's signal aborts", async () => {
      const github = await gateway({ watchTermination: neverNotified })
      const controller = new AbortController()

      const waiting = github.termination(controller.signal).catch((err: unknown) => err)
      setTimeout(() => controller.abort(new Error('worker went away')), 30)

      expect(await waiting).toMatchObject({ message: 'worker went away' })
    })

    it('never arms the GitHub credential re-read when the watch fails', async () => {
      const { auth, refresh } = watchedAuth()
      const github = await gateway({
        auth,
        watchTermination: async () => {
          throw Object.assign(new Error('Forbidden'), { status: 403 })
        },
        terminationPollWaitMs: 50,
      })

      expect(await github.termination()).toBeNull()
      await settle()

      expect(refresh).not.toHaveBeenCalled()
    })
  })

  describe('completeLifecycle, asked for by a worker that may be hostile', () => {
    it('is refused before any notice, and the provider never runs', async () => {
      const complete = vi.fn(async () => undefined)
      const github = await gateway({ watchTermination: neverNotified, completeLifecycle: complete })

      await expect(github.completeLifecycle()).rejects.toThrow(/seen no Auto Scaling termination/)

      expect(complete).not.toHaveBeenCalled()
    })

    it('is refused when the worker asks first, though a notice is on its way', async () => {
      const complete = vi.fn(async () => undefined)
      const github = await gateway({
        watchTermination: async () => AUTO_SCALING,
        completeLifecycle: complete,
      })

      // The gateway has not started its watch: no `termination()` call was made.
      await expect(github.completeLifecycle()).rejects.toThrow(/seen no Auto Scaling termination/)

      expect(complete).not.toHaveBeenCalled()
    })

    it('is refused after a spot notice', async () => {
      const complete = vi.fn(async () => undefined)
      const github = await gateway({
        watchTermination: async () => SPOT,
        completeLifecycle: complete,
      })
      expect(await github.termination()).toEqual(SPOT)

      await expect(github.completeLifecycle()).rejects.toThrow(/seen no Auto Scaling termination/)

      expect(complete).not.toHaveBeenCalled()
    })

    it('runs the provider once after an Auto Scaling notice, whatever the calls', async () => {
      let release: () => void = () => undefined
      const complete = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
      const github = await gateway({
        watchTermination: async () => AUTO_SCALING,
        completeLifecycle: complete,
      })
      expect(await github.termination()).toEqual(AUTO_SCALING)

      const first = github.completeLifecycle()
      const second = github.completeLifecycle()
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
      release()
      await Promise.all([first, second])
      await github.completeLifecycle()

      expect(complete).toHaveBeenCalledTimes(1)
    })

    it("answers every call the first call's failure, scrubbed", async () => {
      const key = `sk_live_${'z4'.repeat(20)}`
      registerSecretText(key)
      const complete = vi.fn(async () => {
        throw new Error(`CompleteLifecycleAction failed for ${key}`)
      })
      const github = await gateway({
        watchTermination: async () => AUTO_SCALING,
        completeLifecycle: complete,
      })
      await github.termination()

      const first = await github.completeLifecycle().catch((err: unknown) => err)
      const second = await github.completeLifecycle().catch((err: unknown) => err)

      expect(first).toBeInstanceOf(Error)
      expect((first as Error).message).not.toContain(key)
      expect((second as Error).message).toBe((first as Error).message)
      expect(complete).toHaveBeenCalledTimes(1)
    })

    it('resolves without a provider, saying nothing completes the action', async () => {
      const github = await gateway()

      await expect(github.completeLifecycle()).resolves.toBeUndefined()

      expect(consoleSpy.all().warn.join('\n')).toMatch(/Nothing completes the Auto Scaling/)
    })

    it('never arms the GitHub credential re-read when the provider fails', async () => {
      const { auth, refresh } = watchedAuth()
      const github = await gateway({
        auth,
        watchTermination: async () => AUTO_SCALING,
        completeLifecycle: async () => {
          throw Object.assign(new Error('Forbidden'), { status: 403 })
        },
        terminationPollWaitMs: 50,
      })
      await github.termination()

      await expect(github.completeLifecycle()).rejects.toThrow('Forbidden')
      await settle()

      expect(refresh).not.toHaveBeenCalled()
    })
  })
})
