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

const served = new Set<{ server: Promise<GitHubGatewayServer>; dir: string }>()

/** Each client {@link gatewayUnderTest} made, mapped to the in-process gateway behind it. */
const locals = new WeakMap<GitHubGateway, GitHubGateway>()

/**
 * `local` itself, or, under the `http` transport, a client of it served on a fresh socket, which
 * {@link closeServedGateways} closes after the test.
 */
export function gatewayUnderTest(local: GitHubGateway): GitHubGateway {
  if (GATEWAY_TRANSPORT === 'local') return local
  // Short: macOS caps a socket path at 104 bytes.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gw-'))
  const socketPath = path.join(dir, 's')
  const server = serveGitHubGateway(local, { path: socketPath })
  served.add({ server, dir })
  const client = new ServedGateway(server.then(() => connectGitHubGateway(socketPath)))
  locals.set(client, local)
  return client
}

/**
 * The in-process gateway behind `gateway`: itself, or the one a {@link gatewayUnderTest} client
 * reaches. For a test that reaches into the gateway's own state, which no transport carries.
 */
export function localGatewayOf(gateway: GitHubGateway): GitHubGateway {
  return locals.get(gateway) ?? gateway
}

/**
 * Wait until every served gateway has finished what it is handling. A client's abort returns at
 * once, while the gateway is still stopping the operation; the in-process gateway is done by then.
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
 * Close every gateway {@link gatewayUnderTest} served: the `worker-http` project's `afterEach`.
 * @internal Exported for test-utils/gateway-transport-setup.ts.
 */
export async function closeServedGateways(): Promise<void> {
  const all = [...served]
  served.clear()
  for (const { server, dir } of all) {
    await server.then((s) => s.close()).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A client that waits for its server to listen before each call. */
class ServedGateway implements GitHubGateway {
  constructor(private readonly client: Promise<GitHubGateway>) {}
  async prepare() {
    return (await this.client).prepare()
  }
  async defaultBranch(signal?: AbortSignal) {
    return (await this.client).defaultBranch(signal)
  }
  async isProtectedBranch(branch: string, signal?: AbortSignal) {
    return (await this.client).isProtectedBranch(branch, signal)
  }
  async fetch(request: { have: readonly string[] }, signal?: AbortSignal) {
    return (await this.client).fetch(request, signal)
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
  } = {},
): GitHubGateway {
  const internals = worker as unknown as WorkerGatewayInternals
  const gateway = createLocalGitHubGateway({
    ...internals.localGitHubGatewayOptions(),
    ...(seams.remoteUrl !== undefined ? { remoteUrl: seams.remoteUrl } : {}),
    ...(seams.octokit !== undefined ? { octokit: seams.octokit as Octokit } : {}),
    ...(seams.fetchCoalesceMs !== undefined ? { fetchCoalesceMs: seams.fetchCoalesceMs } : {}),
    ...(seams.timeoutMs !== undefined ? { timeoutMs: seams.timeoutMs } : {}),
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
