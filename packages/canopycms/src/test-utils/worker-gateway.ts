import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { Octokit } from '@octokit/rest'
import { expect } from 'vitest'

import type { CmsWorker } from '../worker/cms-worker'
import {
  createLocalGitHubGateway,
  type GitHubGateway,
  type LocalGitHubGatewayOptions,
} from '../worker/github-gateway'
import {
  connectGitHubGateway,
  serveGitHubGateway,
  type GitHubGatewayServer,
} from '../worker/github-gateway-http'
import type { GitHubCredential } from '../worker/github-mirror'

/**
 * Which way the suites reach the gateway: `local`, calling it in-process, or `http`, through
 * `connectGitHubGateway` → `serveGitHubGateway` → the same in-process gateway over a real unix
 * socket. The vitest project `worker-http` sets it, and runs the gateway and worker suites again,
 * so both transports are held to one set of assertions.
 */
export const GATEWAY_TRANSPORT: 'local' | 'http' =
  process.env.CANOPY_TEST_GATEWAY_TRANSPORT === 'http' ? 'http' : 'local'

const served = new Set<{
  server: Promise<GitHubGatewayServer>
  dir: string
  local: GitHubGateway
}>()

/** Each client {@link gatewayUnderTest} made, mapped to the in-process gateway behind it. */
const locals = new WeakMap<GitHubGateway, GitHubGateway>()

/**
 * `local` itself, or, under the `http` transport, a client of it served on a fresh socket, which
 * {@link closeServedGateways} closes after the test.
 */
export function gatewayUnderTest(local: GitHubGateway): GitHubGateway {
  if (GATEWAY_TRANSPORT === 'local') return local
  // Served at the first call, not now: a server prepares its gateway as it starts, and a gateway a
  // test installs and then replaces unused must do nothing, as the in-process one does.
  let client: Promise<GitHubGateway> | null = null
  trackFetches(local)
  const connect = () =>
    (client ??= (async () => {
      // Short: macOS caps a socket path at 104 bytes.
      const dir = mkdtempSync(path.join(os.tmpdir(), 'gw-'))
      const socketPath = path.join(dir, 's')
      const server = serveGitHubGateway(local, { path: socketPath })
      served.add({ server, dir, local })
      await server
      return connectGitHubGateway(socketPath)
    })())
  const gateway = new ServedGateway(connect)
  locals.set(gateway, local)
  return gateway
}

/**
 * The in-process gateway behind `gateway`: itself, or the one a {@link gatewayUnderTest} client
 * reaches. For a test that reaches into the gateway's own state, which no transport carries.
 */
export function localGatewayOf(gateway: GitHubGateway): GitHubGateway {
  return locals.get(gateway) ?? gateway
}

/**
 * Wait until every served gateway has finished what it is handling, its fetch jobs included. A
 * client's abort returns at once, while the gateway may still be stopping the operation.
 */
export async function gatewaysSettled(): Promise<void> {
  for (const { server } of served) await (await server).idle()
}

/**
 * What an Octokit call made with `signal` receives as its signal: that one in-process; over the
 * socket, the server's own for the request, which aborts when the worker's does.
 */
export function passedSignal(signal: AbortSignal): unknown {
  return GATEWAY_TRANSPORT === 'http' ? expect.any(AbortSignal) : signal
}

/**
 * The request option an Octokit call made with no signal receives: none in-process; over the
 * socket, the server's signal for the request, which it always passes.
 */
export function serverRequestOption(): { request?: { signal: unknown } } {
  return GATEWAY_TRANSPORT === 'http' ? { request: { signal: expect.any(AbortSignal) } } : {}
}

/**
 * Assert that `caught` is `original` as the socket rebuilds an Octokit error: its name, message,
 * status, and the response headers and data the task runner classifies on.
 */
export function expectRebuiltOctokitError(caught: unknown, original: Error): void {
  const source = original as Error & {
    status: number
    response?: { headers: Record<string, unknown>; data?: unknown }
  }
  expect(caught).toBeInstanceOf(Error)
  expect(caught).toMatchObject({
    name: source.name,
    message: source.message,
    status: source.status,
  })
  const response = (caught as { response?: { headers: Record<string, string>; data?: unknown } })
    .response
  expect(response?.data).toEqual(source.response?.data)
  for (const key of ['x-ratelimit-remaining', 'retry-after']) {
    const value = source.response?.headers[key]
    expect(response?.headers[key]).toBe(value === undefined ? undefined : String(value))
  }
}

/**
 * Close every gateway {@link gatewayUnderTest} served, and wait out the work each runs in the
 * background: the GitHub fetch a served gateway starts as its server prepares, and any credential
 * re-read a failure armed. A suite that removes the directories those fetches write, or restores
 * a console spy a re-read's failure log must reach, calls it first in its own `afterEach`, which
 * runs before the `worker-http` project's (test-utils/gateway-transport-setup.ts).
 */
export async function closeServedGateways(): Promise<void> {
  const all = [...served]
  served.clear()
  for (const { server, dir, local } of all) {
    await server.then((s) => s.close()).catch(() => undefined)
    await backgroundWorkSettled(local)
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Every GitHub fetch a served gateway started, settled or not. A push or a deletion drops the
 * gateway's own reference to a fetch still running, the boot fetch included, so its record alone
 * would let a teardown remove the directory that fetch is still measuring.
 */
const startedFetches = new WeakMap<GitHubGateway, Set<Promise<unknown>>>()

function trackFetches(local: GitHubGateway): void {
  const internals = local as unknown as {
    startGitHubFetch?: (...args: unknown[]) => { done: Promise<unknown> }
  }
  const start = internals.startGitHubFetch
  if (typeof start !== 'function') return
  const started = new Set<Promise<unknown>>()
  startedFetches.set(local, started)
  internals.startGitHubFetch = (...args) => {
    const job = start.apply(local, args)
    started.add(job.done.catch(() => undefined))
    return job
  }
}

/**
 * Wait out the work an in-process gateway runs detached: every GitHub fetch it started, the boot
 * fetch its server's `prepare()` started included, so it writes nothing under a directory the test
 * then removes; the mirror maintenance a fetch starts detached, for the same reason; and the
 * credential re-read a failure arms, which logs when it fails, so its line lands
 * while the suite's console spy is still installed. A re-read is bounded only by the gateway's
 * `timeoutMs`, so a test that arms one against a provider that never settles sets a `timeoutMs`
 * below vitest's hook timeout, or this wait outlasts the hook.
 */
async function backgroundWorkSettled(local: GitHubGateway): Promise<void> {
  const internals = local as unknown as {
    githubFetch?: { done: Promise<unknown> } | null
    mirror?: { tail: Promise<unknown>; maintenance?: { held: Promise<void> | null } }
    refreshing?: Promise<void> | null
  }
  // The boot fetch starts once prepare() has; a fetch a push replaced still runs in a session.
  await local.prepare().catch(() => undefined)
  const started = startedFetches.get(local) ?? new Set<Promise<unknown>>()
  for (;;) {
    const job = internals.githubFetch
    const tail = internals.mirror?.tail
    const refreshing = internals.refreshing
    const maintaining = internals.mirror?.maintenance?.held ?? null
    const fetches = started.size
    await job?.done.catch(() => undefined)
    await Promise.all(started)
    await tail
    await refreshing
    await maintaining
    if (
      internals.githubFetch === job &&
      internals.mirror?.tail === tail &&
      internals.refreshing === refreshing &&
      (internals.mirror?.maintenance?.held ?? null) === null &&
      started.size === fetches
    ) {
      return
    }
  }
}

/** A client that serves its gateway at its first call, and waits for the server before each. */
class ServedGateway implements GitHubGateway {
  constructor(private readonly connect: () => Promise<GitHubGateway>) {}
  private get client(): Promise<GitHubGateway> {
    return this.connect()
  }
  async prepare() {
    return (await this.client).prepare()
  }
  async health(signal?: AbortSignal) {
    return (await this.client).health(signal)
  }
  async defaultBranch(signal?: AbortSignal) {
    return (await this.client).defaultBranch(signal)
  }
  async isProtectedBranch(branch: string, signal?: AbortSignal) {
    return (await this.client).isProtectedBranch(branch, signal)
  }
  async fetch(request: { have: readonly string[] }, signal?: AbortSignal, onProgress?: () => void) {
    return (await this.client).fetch(request, signal, onProgress)
  }
  async openBundle(bundleId: string) {
    return (await this.client).openBundle(bundleId)
  }
  async push(...args: [Parameters<GitHubGateway['push']>[0], Readable?, AbortSignal?]) {
    return (await this.client).push(...args)
  }
  async createPullRequest(...args: Parameters<GitHubGateway['createPullRequest']>) {
    return (await this.client).createPullRequest(...args)
  }
  async updatePullRequest(...args: Parameters<GitHubGateway['updatePullRequest']>) {
    return (await this.client).updatePullRequest(...args)
  }
  async getPullRequest(...args: Parameters<GitHubGateway['getPullRequest']>) {
    return (await this.client).getPullRequest(...args)
  }
  async createOrUpdatePullRequest(...args: Parameters<GitHubGateway['createOrUpdatePullRequest']>) {
    return (await this.client).createOrUpdatePullRequest(...args)
  }
  async convertPullRequestToDraft(...args: Parameters<GitHubGateway['convertPullRequestToDraft']>) {
    return (await this.client).convertPullRequestToDraft(...args)
  }
  async deleteBranch(...args: Parameters<GitHubGateway['deleteBranch']>) {
    return (await this.client).deleteBranch(...args)
  }
  async authSnapshot(...args: Parameters<GitHubGateway['authSnapshot']>) {
    return (await this.client).authSnapshot(...args)
  }
  async termination(...args: Parameters<GitHubGateway['termination']>) {
    return (await this.client).termination(...args)
  }
  async completeLifecycle(...args: Parameters<GitHubGateway['completeLifecycle']>) {
    return (await this.client).completeLifecycle(...args)
  }
}

interface WorkerGatewayInternals {
  gateway?: GitHubGateway
  localGitHubGatewayOptions(): LocalGitHubGatewayOptions
}

/**
 * Give `worker` the real in-process GitHub gateway, built from the worker's own options, with
 * GitHub replaced: `remoteUrl` is the repository standing in for it (resolved per use, so a
 * function can change or fail it mid-test), and `octokit` a stub of the Octokit calls the test
 * exercises. Install it before the worker first reaches GitHub; it replaces any gateway there.
 * Under the `http` transport the worker reaches it through the socket ({@link gatewayUnderTest}).
 */
export function useLocalGitHubGateway(
  worker: CmsWorker,
  seams: {
    remoteUrl?: LocalGitHubGatewayOptions['remoteUrl']
    octokit?: object
    fetchCoalesceMs?: number
    /** The gateway's own inactivity and re-read bound, apart from the worker's task deadline. */
    timeoutMs?: number
    /** Whether `prepare()` starts the first GitHub fetch (`LocalGitHubGatewayOptions.prefetch`). */
    prefetch?: boolean
  } = {},
): GitHubGateway {
  const internals = worker as unknown as WorkerGatewayInternals
  const gateway = createLocalGitHubGateway({
    ...internals.localGitHubGatewayOptions(),
    ...(seams.remoteUrl !== undefined ? { remoteUrl: seams.remoteUrl } : {}),
    ...(seams.octokit !== undefined ? { octokit: seams.octokit as Octokit } : {}),
    ...(seams.fetchCoalesceMs !== undefined ? { fetchCoalesceMs: seams.fetchCoalesceMs } : {}),
    ...(seams.timeoutMs !== undefined ? { timeoutMs: seams.timeoutMs } : {}),
    ...(seams.prefetch !== undefined ? { prefetch: seams.prefetch } : {}),
  })
  internals.gateway = gatewayUnderTest(gateway)
  return internals.gateway
}

/**
 * A credential for driving a `MirrorSession`'s GitHub-bound commands directly, against a local
 * repository standing in for GitHub. Its header is scoped to GitHub's origin, which a local path
 * never matches.
 */
export function fixtureCredential(url: string, token = 'fake-token'): GitHubCredential {
  return { url, token, onFailure: () => undefined }
}
