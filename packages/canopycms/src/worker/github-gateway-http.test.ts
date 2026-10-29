import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { AuthCacheSnapshot } from '../auth/cache'
import { isNoCommitsBetweenError, isRefAlreadyGoneError } from '../github-service'
import {
  mockConsole,
  noCommitsBetweenError,
  octokitErrorFor,
  type MockConsole,
} from '../test-utils'
import { GatewayRefusalError, MAX_PROTECTED_BRANCHES } from './branch-policy'
import { registerLiveSecret } from './gateway-egress'
import { resolveWorkerGitHubAuth } from './github-auth'
import {
  GitHubPushError,
  createLocalGitHubGateway,
  type GatewayTerminationNotice,
  type GitHubGateway,
} from './github-gateway'
import {
  connectGitHubGateway,
  serveGitHubGateway,
  type GitHubGatewayServer,
  type GitHubGatewayServerOptions,
} from './github-gateway-http'
import {
  GatewayRequestRefusedError,
  GitHubGatewayProtocolError,
  GitHubGatewayStoppingError,
  GitHubGatewayUnreachableError,
  GitHubRequestError,
  PUSH_REQUEST_HEADER,
  UnknownFetchJobError,
} from './github-gateway-wire'
import { GitHubTransientError, RefusedPushError } from './github-mirror'
import { isPermanentTaskFailure } from './task-runner'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

let dir: string
let socketPath: string
let servers: GitHubGatewayServer[]
let consoleSpy: MockConsole

/** A gateway whose every operation is a spy; a test gives the ones it calls a behaviour. */
type FakeGateway = { [K in keyof GitHubGateway]: Mock<GitHubGateway[K]> }

function fakeGateway(): FakeGateway {
  return {
    prepare: vi.fn(async () => undefined),
    health: vi.fn(async () => ({
      ready: true,
      fatalError: null,
      preflight: 'not-an-app' as const,
      clerkConfigured: false,
      branchPolicy: {
        configured: ['main'],
        githubDefault: 'main',
        namespace: 'canopycms/prod/',
        legacy: [],
        settingsBranch: null,
      },
    })),
    defaultBranch: vi.fn(async () => 'main'),
    isProtectedBranch: vi.fn(async () => false),
    fetch: vi.fn(async () => ({ refs: new Map([['main', SHA]]), bundleId: null })),
    openBundle: vi.fn<GitHubGateway['openBundle']>(),
    push: vi.fn(async () => ({
      kind: 'pushed' as const,
      moved: false as const,
      pastStaleLease: false,
    })),
    createPullRequest: vi.fn(async () => ({ number: 1, url: 'https://example.test/1' })),
    updatePullRequest: vi.fn(async () => undefined),
    getPullRequest: vi.fn(async () => ({
      merged: false,
      merged_at: null,
      state: 'open' as const,
      node_id: 'PR_1',
      body: 'B',
    })),
    createOrUpdatePullRequest: vi.fn(async () => ({
      number: 1,
      url: 'https://example.test/1',
      created: true,
    })),
    convertPullRequestToDraft: vi.fn(async () => undefined),
    deleteBranch: vi.fn(async () => undefined),
    authSnapshot: vi.fn(async () => ({ users: [], groups: [], memberships: {} })),
    termination: vi.fn(async () => null),
    completeLifecycle: vi.fn(async () => undefined),
  }
}

async function serve(
  gateway: GitHubGateway,
  at = socketPath,
  options: GitHubGatewayServerOptions = {},
): Promise<GitHubGatewayServer> {
  const server = await serveGitHubGateway(gateway, { path: at }, options)
  servers.push(server)
  return server
}

/** One raw request to the served socket, bypassing the client's own validation. */
function raw(options: {
  method?: string
  path: string
  headers?: Record<string, string>
  body?: string | Buffer
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: options.method ?? 'POST',
        path: options.path,
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

function json(pathname: string, body: unknown) {
  const text = JSON.stringify(body)
  return raw({
    path: pathname,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)),
    },
    body: text,
  })
}

beforeEach(async () => {
  // Short: macOS caps a socket path at 104 bytes.
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gwh-'))
  socketPath = path.join(dir, 's')
  servers = []
  consoleSpy = mockConsole()
})

afterEach(async () => {
  for (const server of servers) await server.close()
  consoleSpy.restore()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('errors across the socket', () => {
  /** Throw `err` from `push` on the gateway's side, and return what the worker's side throws. */
  async function across(err: unknown): Promise<unknown> {
    const gateway = fakeGateway()
    gateway.push.mockRejectedValue(err)
    const at = path.join(dir, `e${servers.length}`)
    await serve(gateway, at)
    return connectGitHubGateway(at)
      .push({ branch: 'feature', sha: SHA, prerequisites: [] })
      .catch((caught: unknown) => caught)
  }

  it.each([['invalid', 'not-a-commit', 'protected', 'settings'] as const].flat())(
    'rebuilds a RefusedPushError (%s) as itself, permanent',
    async (reason) => {
      const original = new RefusedPushError('feature', reason, SHA)

      const caught = await across(original)

      expect(caught).toBeInstanceOf(RefusedPushError)
      expect(caught).toBeInstanceOf(GatewayRefusalError)
      expect(caught).toMatchObject({
        operation: 'push',
        branch: 'feature',
        reason,
        message: original.message,
        name: 'RefusedPushError',
      })
      expect(isPermanentTaskFailure(caught)).toBe(true)
    },
  )

  it.each([
    ['delete', 'protected'],
    ['pull-request', 'too-long'],
    ['pull-request', 'invalid'],
  ] as const)('rebuilds a %s GatewayRefusalError (%s) as itself, permanent', async (op, reason) => {
    const original = new GatewayRefusalError(op, 'release/1', reason, `Refusing ${op}: ${reason}`)

    const caught = await across(original)

    expect(caught).toBeInstanceOf(GatewayRefusalError)
    expect(caught).not.toBeInstanceOf(RefusedPushError)
    expect(caught).toMatchObject({
      operation: op,
      branch: 'release/1',
      reason,
      message: original.message,
    })
    expect(isPermanentTaskFailure(caught)).toBe(true)
  })

  it.each(['rejected', 'rejected-after-stale-lease'] as const)(
    'rebuilds a GitHubPushError (%s) with git’s message, transient',
    async (kind) => {
      const message = ' ! [rejected]        x -> feature (non-fast-forward)\nerror: failed to push'
      const caught = await across(new GitHubPushError(kind, message))

      expect(caught).toBeInstanceOf(GitHubPushError)
      expect(caught).toMatchObject({ kind, message, name: 'GitHubPushError' })
      expect(isPermanentTaskFailure(caught)).toBe(false)
    },
  )

  it.each([
    'github-fetch-failed',
    'bundle-rejected',
    'prerequisite-gone',
    'bundle-gone',
    'mirror-corrupt',
    'objects-still-needed',
    'ref-kept-moving',
    'default-branch-unread',
  ] as const)('rebuilds a GitHubTransientError (%s), transient', async (code) => {
    const caught = await across(new GitHubTransientError(code, `failed: ${code}`))

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect(caught).toMatchObject({ code, message: `failed: ${code}` })
    expect(isPermanentTaskFailure(caught)).toBe(false)
  })

  it.each([
    ['a primary rate limit (403, no requests left)', 403, { 'x-ratelimit-remaining': '0' }, {}],
    ['a secondary rate limit (403, retry-after)', 403, { 'retry-after': '60' }, {}],
    ['a permission denial (403)', 403, {}, { message: 'Resource not accessible by integration' }],
    ['a lost repository (404)', 404, {}, { message: 'Not Found' }],
    ['GitHub down (502)', 502, {}, { message: 'Bad Gateway' }],
    ['a ref already gone (422)', 422, {}, { message: 'Reference does not exist' }],
    ['a rate limit (429)', 429, {}, { message: 'Too Many Requests' }],
  ])(
    'rebuilds an Octokit error for %s so every classifier answers as before',
    async (_, status, headers, body) => {
      const original = await octokitErrorFor(status, body)
      Object.assign(
        (original as Error & { response: { headers: object } }).response.headers,
        headers,
      )

      const caught = await across(original)

      expect(caught).toBeInstanceOf(GitHubRequestError)
      expect(caught).toMatchObject({
        name: original.name,
        message: original.message,
        status,
        response: { data: (original as Error & { response: { data: unknown } }).response.data },
      })
      for (const [key, value] of Object.entries(headers)) {
        expect((caught as GitHubRequestError).response?.headers[key]).toBe(value)
      }
      expect(isPermanentTaskFailure(caught)).toBe(isPermanentTaskFailure(original))
      expect(isRefAlreadyGoneError(caught)).toBe(isRefAlreadyGoneError(original))
      expect(isNoCommitsBetweenError(caught)).toBe(isNoCommitsBetweenError(original))
    },
  )

  it('carries the 403 classification itself: rate limited is transient, a denial permanent', async () => {
    const limited = await octokitErrorFor(403, { message: 'API limit' })
    Object.assign((limited as Error & { response: { headers: object } }).response.headers, {
      'x-ratelimit-remaining': '0',
    })
    const denied = await octokitErrorFor(403, { message: 'Resource not accessible by integration' })

    expect(isPermanentTaskFailure(await across(limited))).toBe(false)
    expect(isPermanentTaskFailure(await across(denied))).toBe(true)
  })

  it("rebuilds GitHub's no-commits-between answer, which isNoCommitsBetweenError reads from response.data", async () => {
    const original = await noCommitsBetweenError()

    const caught = await across(original)

    expect(isNoCommitsBetweenError(original)).toBe(true)
    expect(isNoCommitsBetweenError(caught)).toBe(true)
  })

  it('rebuilds a refused token mint with its HTTP status and no response', async () => {
    const mint = Object.assign(new Error('Bad credentials'), { status: 401 })

    const caught = await across(mint)

    expect(caught).toBeInstanceOf(GitHubRequestError)
    expect(caught).toMatchObject({ status: 401, message: 'Bad credentials' })
    expect((caught as GitHubRequestError).response).toBeUndefined()
    expect(isPermanentTaskFailure(caught)).toBe(true)
  })

  it('rebuilds anything else as a plain Error of the same name and message, transient', async () => {
    const original = new TypeError('something local broke')

    const caught = await across(original)

    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ name: 'TypeError', message: 'something local broke' })
    expect(isPermanentTaskFailure(caught)).toBe(false)
  })

  it('sends a thrown value that is not an Error as a fixed message, and logs it on the gateway', async () => {
    const thrown = 'Error: local detail\n    at secret (/srv/gateway/internal.js:1:1)'

    const caught = await across(thrown)

    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({
      name: 'Error',
      message: 'The GitHub gateway failed with a value that is not an Error',
    })
    expect(isPermanentTaskFailure(caught)).toBe(false)
    expect(consoleSpy.all().warn.join('\n')).toContain('local detail')
  })

  it('logs no more of a thrown value that is not an Error than an error message may carry', async () => {
    await across('x'.repeat(1024 * 1024))

    const logged = consoleSpy.all().warn.find((line) => line.includes('not an Error'))
    expect(logged?.length).toBeGreaterThan(256 * 1024)
    expect(logged?.length).toBeLessThan(257 * 1024)
  })

  it('sends no stack, no cause, no request and no header outside the classified ones', async () => {
    const original = await octokitErrorFor(500, { message: 'Server Error' })
    Object.assign((original as Error & { response: { headers: object } }).response.headers, {
      'x-github-request-id': 'ABCD',
      'set-cookie': 'session=1',
    })
    Object.assign(original, { cause: new Error('inner') })

    const caught = (await across(original)) as GitHubRequestError & {
      cause?: unknown
      request?: unknown
    }

    expect(caught.stack).not.toContain('github-gateway-http.test.ts:1')
    expect(caught.cause).toBeUndefined()
    expect(caught.request).toBeUndefined()
    expect(caught.response?.headers).toEqual({})
  })

  it('scrubs a live token from every string in an error, by its exact forms and the patterns', async () => {
    const token = 'ghs_crossing0123456789abcdefghijklmnopqrstu'
    registerLiveSecret(token)
    const original = Object.assign(new Error(`failed with ${token}`), {
      status: 500,
      response: { headers: { 'retry-after': token }, data: { message: `echo ${token}` } },
    })

    const caught = await across(original)

    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(token)
    expect(JSON.stringify((caught as GitHubRequestError).response)).not.toContain(token)
  })

  it('drops an Octokit response body too large to cross, keeping the status and message', async () => {
    const original = await octokitErrorFor(422, {
      message: 'Validation Failed',
      big: 'x'.repeat(100_000),
    })

    const caught = await across(original)

    expect(caught).toMatchObject({ status: 422, message: original.message })
    expect((caught as GitHubRequestError).response?.data).toBeUndefined()
  })
})

describe('the wire format at the server', () => {
  it.each([
    ['a missing field', '/v1/is-protected-branch', {}],
    ['a field of the wrong type', '/v1/is-protected-branch', { branch: 7 }],
    ['an unknown field', '/v1/is-protected-branch', { branch: 'x', extra: true }],
    ['an over-long name', '/v1/branch/delete', { branch: 'b'.repeat(5000) }],
    ['a pull request number that is not an integer', '/v1/pull-request/get', { number: 1.5 }],
    [
      'more have IDs than the cap',
      '/v1/fetch',
      { have: Array.from({ length: 10_001 }, () => SHA) },
    ],
    ['a have entry that is not an object ID', '/v1/fetch', { have: ['--all'] }],
  ])('refuses %s before any operation runs', async (_, route, body) => {
    const gateway = fakeGateway()
    await serve(gateway)

    const { status, body: answer } = await json(route, body)

    expect(status).toBe(400)
    expect(JSON.parse(answer)).toMatchObject({ error: { kind: 'refused' } })
    // prepare() ran as the server started; no operation ran since.
    expect(gateway.prepare).toHaveBeenCalledTimes(1)
    for (const [name, op] of Object.entries(gateway)) {
      if (name !== 'prepare') expect(op).not.toHaveBeenCalled()
    }
    expect(consoleSpy).toHaveWarned(/Refused a request/)
  })

  it.each([
    [
      'a body larger than the cap',
      { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) },
      413,
    ],
    [
      'no declared length',
      { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      411,
    ],
    ['a body that is not JSON', { 'content-type': 'text/plain', 'content-length': '2' }, 415],
  ])('refuses %s without reading it', async (_, headers, status) => {
    const gateway = fakeGateway()
    await serve(gateway)

    const answer = await raw({ path: '/v1/default-branch', headers, body: '{}' }).catch(
      (err: unknown) => err,
    )

    expect(answer).toMatchObject({ status })
    expect(gateway.defaultBranch).not.toHaveBeenCalled()
  })

  it('refuses a push whose request header is missing, unreadable or malformed, before reading the body', async () => {
    const gateway = fakeGateway()
    await serve(gateway)
    const bundle = { 'content-type': 'application/x-git-bundle' }
    const header = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

    for (const headers of [
      bundle,
      { ...bundle, [PUSH_REQUEST_HEADER]: '!!!' },
      {
        ...bundle,
        [PUSH_REQUEST_HEADER]: header({
          branch: 'x',
          sha: 'nope',
          prerequisites: [],
          bundle: true,
        }),
      },
      {
        ...bundle,
        [PUSH_REQUEST_HEADER]: header({
          branch: 'x',
          sha: SHA,
          prerequisites: [SHA, SHA, SHA, SHA],
          bundle: true,
        }),
      },
    ]) {
      const { status } = await raw({ path: '/v1/push', headers, body: 'x'.repeat(1024) })
      expect(status).toBe(400)
    }
    expect(gateway.push).not.toHaveBeenCalled()
  })

  it('quotes nothing of a refused request back, however large', async () => {
    const gateway = fakeGateway()
    await serve(gateway)

    const { status, body } = await json('/v1/pull-request/update', {
      number: 1,
      state: 'x'.repeat(1024 * 1024),
    })

    expect(status).toBe(400)
    expect(body.length).toBeLessThan(1024)
    expect(body).toContain('invalid_literal at state')
    expect(gateway.updatePullRequest).not.toHaveBeenCalled()
    const warned = consoleSpy.all().warn.join('\n')
    expect(warned.length).toBeLessThan(1024)
    expect(warned).not.toContain('xxxx')
  })

  it('refuses a push that says it has no bundle and sends one', async () => {
    const gateway = fakeGateway()
    await serve(gateway)
    const header = Buffer.from(
      JSON.stringify({ branch: 'x', sha: SHA, prerequisites: [], bundle: false }),
    ).toString('base64url')

    const { status } = await raw({
      path: '/v1/push',
      headers: { [PUSH_REQUEST_HEADER]: header, 'content-length': '3' },
      body: 'abc',
    })

    expect(status).toBe(400)
    expect(gateway.push).not.toHaveBeenCalled()
  })

  it("quotes no more than the start of a refused request's URL", async () => {
    await serve(fakeGateway())

    const { status, body } = await raw({
      method: 'GET',
      path: `/v1/default-branch?${'q'.repeat(10_000)}`,
    })

    expect(status).toBe(405)
    expect(body.length).toBeLessThan(1024)
    expect(consoleSpy.all().warn.join('\n').length).toBeLessThan(1024)
  })

  it('refuses an unknown route and a wrong method', async () => {
    const gateway = fakeGateway()
    await serve(gateway)

    expect((await json('/v1/nothing', {})).status).toBe(404)
    expect((await raw({ method: 'GET', path: '/v1/default-branch' })).status).toBe(405)
    expect((await raw({ method: 'POST', path: '/v1/bundle/abc' })).status).toBe(405)
  })

  it("holds the gateway's own answer to the wire format, sending an error instead", async () => {
    const gateway = fakeGateway()
    gateway.push.mockResolvedValue({ kind: 'need-objects', usable: ['not-an-id'] })
    await serve(gateway)

    await expect(
      connectGitHubGateway(socketPath).push({ branch: 'feature', sha: SHA, prerequisites: [] }),
    ).rejects.toThrow(/push answer does not fit the wire format/)
  })
})

describe('the wire format at the client', () => {
  /** A server that answers every request with `status`, `type` and `body`. */
  async function answering(status: number, type: string, body: string): Promise<void> {
    const server = http.createServer((_, res) => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const close = () => new Promise<void>((resolve) => server.close(() => resolve()))
    servers.push({ idle: async () => undefined, drain: close, close })
  }

  it.each([
    ['not JSON', 200, 'application/json', '{nope'],
    ['no JSON at all', 200, 'text/plain', 'hello'],
    ['neither value nor error', 200, 'application/json', '{"other":1}'],
    ['a value of the wrong shape', 200, 'application/json', '{"value":{"branch":7}}'],
    ['a value with an extra field', 200, 'application/json', '{"value":{"branch":"main","x":1}}'],
    ['an error it cannot read', 500, 'application/json', '{"error":{"kind":"what"}}'],
    [
      'an error with a success status',
      200,
      'application/json',
      '{"error":{"kind":"error","name":"E","message":"m"}}',
    ],
    [
      'a stopping answer with a field it does not have',
      503,
      'application/json',
      '{"error":{"kind":"stopping","message":"m","extra":1}}',
    ],
  ])('refuses an answer that is %s, loudly', async (_, status, type, body) => {
    await answering(status, type, body)

    const caught = await connectGitHubGateway(socketPath)
      .defaultBranch()
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubGatewayProtocolError)
  })

  it.each([
    [
      'an unknown route, as an older gateway answers it',
      'application/json',
      '{"error":{"kind":"refused","status":404,"message":"no such operation"}}',
    ],
    ['a 404 from something that is not a gateway', 'text/plain', 'Not Found'],
  ])('keeps %s transient, and never a branch already gone', async (_, type, body) => {
    await answering(404, type, body)

    const caught = await connectGitHubGateway(socketPath)
      .deleteBranch('feature')
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubGatewayProtocolError)
    expect(isRefAlreadyGoneError(caught)).toBe(false)
    expect(isPermanentTaskFailure(caught)).toBe(false)
  })

  it('refuses an auth snapshot with a field it does not have', async () => {
    await answering(
      200,
      'application/json',
      JSON.stringify({ value: { users: [], groups: [], memberships: {}, secret: 'x' } }),
    )

    await expect(connectGitHubGateway(socketPath).authSnapshot()).rejects.toBeInstanceOf(
      GitHubGatewayProtocolError,
    )
  })

  it('refuses a push answer whose commit is not an object ID', async () => {
    await answering(
      200,
      'application/json',
      JSON.stringify({
        value: { kind: 'pushed', moved: true, from: null, to: 'HEAD', pastStaleLease: false },
      }),
    )

    await expect(
      connectGitHubGateway(socketPath).push({ branch: 'feature', sha: SHA, prerequisites: [] }),
    ).rejects.toBeInstanceOf(GitHubGatewayProtocolError)
  })

  it('fails a request the gateway refuses for its shape for good, as the gateway would refuse it', async () => {
    const gateway = fakeGateway()
    await serve(gateway)
    const client = connectGitHubGateway(socketPath)

    const oversize = await client.deleteBranch('b'.repeat(5000)).catch((err: unknown) => err)
    // A push header past node's own header limit: node refuses it, with no JSON.
    const unheadable = await client
      .push({ branch: '€'.repeat(4096), sha: SHA, prerequisites: [] })
      .catch((err: unknown) => err)

    expect(oversize).toBeInstanceOf(GatewayRequestRefusedError)
    expect(oversize).toMatchObject({ refusedWith: 400 })
    expect(isPermanentTaskFailure(oversize)).toBe(true)
    expect(unheadable).toBeInstanceOf(GatewayRequestRefusedError)
    expect(unheadable).toMatchObject({ refusedWith: 431 })
    expect(isPermanentTaskFailure(unheadable)).toBe(true)
    // Never read as GitHub's own status: a 404 there is a branch already gone.
    expect((oversize as { status?: unknown }).status).toBeUndefined()
    expect(gateway.deleteBranch).not.toHaveBeenCalled()
    expect(gateway.push).not.toHaveBeenCalled()
  })

  it('keeps a refusal for being busy transient', async () => {
    const gateway = fakeGateway()
    gateway.fetch.mockImplementation(() => new Promise(() => undefined))
    await serve(gateway)
    for (let i = 0; i < 8; i++) await json('/v1/fetch', { have: [] })

    const busy = await connectGitHubGateway(socketPath)
      .fetch({ have: [] })
      .catch((err: unknown) => err)

    expect(busy).toBeInstanceOf(GitHubGatewayProtocolError)
    expect(busy).not.toBeInstanceOf(GatewayRequestRefusedError)
    expect(isPermanentTaskFailure(busy)).toBe(false)
  })

  it('throws GitHubGatewayUnreachableError, transient, when nothing listens', async () => {
    const caught = await connectGitHubGateway(path.join(dir, 'nobody'))
      .defaultBranch()
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubGatewayUnreachableError)
    expect(isPermanentTaskFailure(caught)).toBe(false)
  })
})

describe('a worker that skips prepare', () => {
  const pushHeader = Buffer.from(
    JSON.stringify({ branch: 'feature', sha: SHA, prerequisites: [], bundle: false }),
  ).toString('base64url')

  /** Every operation a worker can ask for, raw, as a hostile one would, never calling prepare. */
  const everyOperation = () => [
    json('/v1/default-branch', {}),
    json('/v1/is-protected-branch', { branch: 'main' }),
    json('/v1/pull-request/create', { head: 'f', base: 'main', title: 'T', body: 'B' }),
    json('/v1/pull-request/update', { number: 1, state: 'closed' }),
    json('/v1/pull-request/get', { number: 1 }),
    json('/v1/pull-request/create-or-update', { head: 'f', base: 'main', title: 'T', body: 'B' }),
    json('/v1/pull-request/convert-to-draft', { number: 1 }),
    json('/v1/branch/delete', { branch: 'f' }),
    json('/v1/fetch', { have: [] }),
    raw({
      path: '/v1/push',
      headers: { [PUSH_REQUEST_HEADER]: pushHeader, 'content-length': '0' },
    }),
    raw({ method: 'GET', path: `/v1/fetch/${'e'.repeat(32)}?wait=0` }),
    raw({ method: 'GET', path: `/v1/bundle/${'e'.repeat(32)}` }),
  ]

  it('reaches no operation before the gateway has prepared', async () => {
    const gateway = fakeGateway()
    gateway.openBundle.mockRejectedValue(new GitHubTransientError('bundle-gone', 'gone'))
    let finish: () => void = () => undefined
    gateway.prepare.mockImplementation(
      () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
    )
    await serve(gateway)

    const answers = Promise.all(everyOperation())
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (const [name, op] of Object.entries(gateway)) {
      if (name !== 'prepare') expect(op, name).not.toHaveBeenCalled()
    }
    finish()
    await answers

    expect(gateway.defaultBranch).toHaveBeenCalledTimes(1)
    expect(gateway.push).toHaveBeenCalledTimes(1)
    expect(gateway.fetch).toHaveBeenCalledTimes(1)
  })

  it("answers every operation with a failed prepare's error, running none", async () => {
    const gateway = fakeGateway()
    gateway.prepare.mockRejectedValue(new Error('the state directory is shared'))
    await serve(gateway)

    for (const answer of await Promise.all(everyOperation())) {
      expect(answer.status).toBe(500)
      expect(JSON.parse(answer.body)).toMatchObject({
        error: { message: 'the state directory is shared' },
      })
    }
    for (const [name, op] of Object.entries(gateway)) {
      if (name !== 'prepare') expect(op, name).not.toHaveBeenCalled()
    }
  })

  it('answers health without waiting on prepare: it reports the wait itself', async () => {
    const gateway = fakeGateway()
    gateway.prepare.mockImplementation(() => new Promise<undefined>(() => undefined))
    await serve(gateway)

    const health = await connectGitHubGateway(socketPath).health()

    expect(health).toMatchObject({ ready: true, preflight: 'not-an-app' })
    expect(gateway.health).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('never runs the real gateway on a shared state directory, and reports why', async () => {
    const workspace = path.join(dir, 'workspace')
    const local = createLocalGitHubGateway({
      githubOwner: 'o',
      githubRepo: 'r',
      auth: resolveWorkerGitHubAuth({ githubToken: 'ghp_hostile_0123456789' }),
      githubApp: false,
      workspacePath: workspace,
      // Where the CMS Lambda can write: prepare() refuses it.
      stateDirectory: path.join(workspace, 'state'),
      timeoutMs: 10_000,
      remoteUrl: path.join(dir, 'nowhere.git'),
    })
    await serve(local)
    const client = connectGitHubGateway(socketPath)

    await expect(client.fetch({ have: [] })).rejects.toThrow(/inside its shared workspace/)
    await expect(client.push({ branch: 'feature', sha: SHA, prerequisites: [] })).rejects.toThrow(
      /inside its shared workspace/,
    )
    const health = await client.health()

    expect(health.ready).toBe(false)
    expect(health.fatalError).toMatch(/inside its shared workspace/)
    // Nothing ran there: no mirror was created.
    await expect(fs.access(path.join(workspace, 'state', 'github.git'))).rejects.toThrow()
  })
})

describe('operations across the socket', () => {
  it('carries each JSON operation and its answer', async () => {
    const gateway = fakeGateway()
    await serve(gateway)
    const client = connectGitHubGateway(socketPath)

    expect(await client.defaultBranch()).toBe('main')
    expect(await client.isProtectedBranch('main')).toBe(false)
    expect(
      await client.createPullRequest({ head: 'f', base: 'main', title: 'T', body: 'B' }),
    ).toEqual({ number: 1, url: 'https://example.test/1' })
    await client.updatePullRequest(3, { state: 'closed' })
    expect(await client.getPullRequest(3)).toEqual({
      merged: false,
      merged_at: null,
      state: 'open',
      node_id: 'PR_1',
      body: 'B',
    })
    expect(
      await client.createOrUpdatePullRequest({
        head: 'f',
        base: 'main',
        title: 'T',
        body: 'B',
        markReadyIfDraft: true,
      }),
    ).toEqual({ number: 1, url: 'https://example.test/1', created: true })
    await client.convertPullRequestToDraft(3)
    await client.deleteBranch('f')

    expect(gateway.isProtectedBranch).toHaveBeenCalledWith('main', expect.any(AbortSignal))
    expect(gateway.updatePullRequest).toHaveBeenCalledWith(
      3,
      { state: 'closed' },
      expect.any(AbortSignal),
    )
    expect(gateway.createOrUpdatePullRequest).toHaveBeenCalledWith(
      { head: 'f', base: 'main', title: 'T', body: 'B', markReadyIfDraft: true },
      expect.any(AbortSignal),
    )
    expect(gateway.deleteBranch).toHaveBeenCalledWith('f', expect.any(AbortSignal))
  })

  it('carries only the pull request fields the worker reads', async () => {
    const gateway = fakeGateway()
    // The in-process gateway hands back all of Octokit's `data`.
    const full = {
      merged: true,
      merged_at: '2026-01-01T00:00:00Z',
      state: 'closed' as const,
      node_id: 'PR_2',
      body: null,
      title: 'a title the worker never reads',
    }
    gateway.getPullRequest.mockResolvedValue(full)
    await serve(gateway)

    expect(await connectGitHubGateway(socketPath).getPullRequest(2)).toEqual({
      merged: true,
      merged_at: '2026-01-01T00:00:00Z',
      state: 'closed',
      node_id: 'PR_2',
      body: null,
    })
  })

  it('prepares the gateway once, and answers its failure to every later caller', async () => {
    const gateway = fakeGateway()
    gateway.prepare.mockRejectedValue(new Error('the App key is wrong'))
    await serve(gateway)
    const client = connectGitHubGateway(socketPath)

    await expect(client.prepare()).rejects.toThrow('the App key is wrong')
    await expect(client.prepare()).rejects.toThrow('the App key is wrong')
    expect(gateway.prepare).toHaveBeenCalledTimes(1)
  })

  it('aborts the operation on the gateway when the worker aborts its request', async () => {
    const gateway = fakeGateway()
    let seen: AbortSignal | undefined
    gateway.defaultBranch.mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((_, reject) => {
          seen = signal
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const server = await serve(gateway)
    const controller = new AbortController()

    const answer = connectGitHubGateway(socketPath).defaultBranch(controller.signal)
    await vi.waitFor(() => expect(seen).toBeDefined())
    controller.abort(new Error('task deadline'))

    await expect(answer).rejects.toThrow('task deadline')
    await server.idle()
    expect(seen?.aborted).toBe(true)
  })
})

describe('fetch jobs', () => {
  it('answers with the ref map and the bundle id', async () => {
    const gateway = fakeGateway()
    gateway.fetch.mockResolvedValue({
      refs: new Map([
        ['main', SHA],
        ['release/1.0', OTHER],
      ]),
      bundleId: 'c'.repeat(32),
    })
    await serve(gateway)

    const result = await connectGitHubGateway(socketPath).fetch({ have: [SHA, SHA, OTHER] })

    expect(result.refs).toEqual(
      new Map([
        ['main', SHA],
        ['release/1.0', OTHER],
      ]),
    )
    expect(result.bundleId).toBe('c'.repeat(32))
    // Deduplicated before it is sent, as the gateway would itself.
    expect(gateway.fetch).toHaveBeenCalledWith(
      { have: [SHA, OTHER] },
      undefined,
      expect.any(Function),
    )
  })

  it('keeps a job running when the worker abandons its wait, and answers its next poll', async () => {
    const gateway = fakeGateway()
    let finish: (value: { refs: Map<string, string>; bundleId: null }) => void = () => undefined
    gateway.fetch.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const server = await serve(gateway)
    const controller = new AbortController()

    const abandoned = connectGitHubGateway(socketPath).fetch({ have: [] }, controller.signal)
    await vi.waitFor(() => expect(gateway.fetch).toHaveBeenCalledTimes(1))
    controller.abort(new Error('the sync loop is stopping'))
    await expect(abandoned).rejects.toThrow('the sync loop is stopping')

    // The gateway's fetch took no signal, so nothing could abort it: only a progress listener.
    expect(gateway.fetch).toHaveBeenCalledWith({ have: [] }, undefined, expect.any(Function))
    finish({ refs: new Map([['main', SHA]]), bundleId: null })
    await server.idle()
    expect(gateway.fetch).toHaveBeenCalledTimes(1)
  })

  it('stops waiting, transient, for a job that shows no progress, and leaves it running', async () => {
    const gateway = fakeGateway()
    gateway.fetch.mockImplementation(() => new Promise(() => undefined))
    await serve(gateway)
    const started = Date.now()

    const caught = await connectGitHubGateway(socketPath, { fetchInactivityMs: 300 })
      .fetch({ have: [] })
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect(caught).toMatchObject({ code: 'github-fetch-failed' })
    expect(String(caught)).toMatch(/no progress for 300ms/)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(gateway.fetch).toHaveBeenCalledTimes(1)
  })

  it('waits out a job past the inactivity bound while its progress moves, and passes it on', async () => {
    const gateway = fakeGateway()
    gateway.fetch.mockImplementation(
      async (_request: unknown, _signal?: AbortSignal, onProgress?: () => void) => {
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          onProgress?.()
        }
        return { refs: new Map([['main', SHA]]), bundleId: null }
      },
    )
    await serve(gateway)
    const onProgress = vi.fn()

    const result = await connectGitHubGateway(socketPath, { fetchInactivityMs: 300 }).fetch(
      { have: [] },
      undefined,
      onProgress,
    )

    expect(result.refs.get('main')).toBe(SHA)
    expect(onProgress).toHaveBeenCalled()
  })

  it('polls a job past the server’s wait until it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const gateway = fakeGateway()
      let finish: (value: { refs: Map<string, string>; bundleId: null }) => void = () => undefined
      gateway.fetch.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
      await serve(gateway)

      const result = connectGitHubGateway(socketPath).fetch({ have: [] })
      await vi.waitFor(() => expect(gateway.fetch).toHaveBeenCalled())
      // Two of the server's 25 s waits pass with the job still running.
      await vi.advanceTimersByTimeAsync(25_001)
      await vi.advanceTimersByTimeAsync(25_001)
      finish({ refs: new Map(), bundleId: null })

      expect(await result).toEqual({ refs: new Map(), bundleId: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it("answers a failed job's error to its poll, rebuilt, and starts the next fetch afresh", async () => {
    const gateway = fakeGateway()
    gateway.fetch
      .mockRejectedValueOnce(new GitHubTransientError('github-fetch-failed', 'GitHub was down'))
      .mockResolvedValueOnce({ refs: new Map(), bundleId: null })
    await serve(gateway)
    const client = connectGitHubGateway(socketPath)

    await expect(client.fetch({ have: [] })).rejects.toBeInstanceOf(GitHubTransientError)
    expect(await client.fetch({ have: [] })).toEqual({ refs: new Map(), bundleId: null })
    expect(gateway.fetch).toHaveBeenCalledTimes(2)
  })

  it('starts one new fetch when the gateway no longer holds the job', async () => {
    // The first gateway takes the job and then restarts, losing it.
    const first = fakeGateway()
    first.fetch.mockImplementation(() => new Promise(() => undefined))
    const firstServer = await serve(first)
    const client = connectGitHubGateway(socketPath)
    const result = client.fetch({ have: [] })
    await vi.waitFor(() => expect(first.fetch).toHaveBeenCalledTimes(1))
    await firstServer.close()
    servers = servers.filter((server) => server !== firstServer)
    const second = fakeGateway()
    await serve(second)

    expect(await result).toEqual({ refs: new Map([['main', SHA]]), bundleId: null })
    expect(second.fetch).toHaveBeenCalledTimes(1)
  })

  it('fails when the gateway loses the job it started anew too', async () => {
    const gateways = [fakeGateway(), fakeGateway(), fakeGateway()]
    for (const gateway of gateways)
      gateway.fetch.mockImplementation(() => new Promise(() => undefined))
    let current = await serve(gateways[0])
    const result = connectGitHubGateway(socketPath)
      .fetch({ have: [] })
      .catch((err: unknown) => err)

    for (const next of gateways.slice(1)) {
      const before = next === gateways[1] ? gateways[0] : gateways[1]
      // The broken poll is tried again a second later.
      await vi.waitFor(() => expect(before.fetch).toHaveBeenCalledTimes(1), { timeout: 5_000 })
      await current.close()
      servers = servers.filter((server) => server !== current)
      current = await serve(next)
    }

    expect(await result).toBeInstanceOf(UnknownFetchJobError)
    expect(gateways[2].fetch).not.toHaveBeenCalled()
  })

  it('answers an unknown job id with unknown-job', async () => {
    await serve(fakeGateway())

    const { status, body } = await raw({
      method: 'GET',
      path: `/v1/fetch/${'d'.repeat(32)}?wait=0`,
    })

    expect(status).toBe(404)
    expect(JSON.parse(body)).toMatchObject({ error: { kind: 'unknown-job' } })
  })

  it("keeps a finished job's answer readable for ten minutes, and no longer", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await serve(fakeGateway())
      const started = await json('/v1/fetch', { have: [] })
      const { job } = (JSON.parse(started.body) as { value: { job: string } }).value
      const poll = () => raw({ method: 'GET', path: `/v1/fetch/${job}?wait=5000` })

      expect((await poll()).status).toBe(200)
      vi.setSystemTime(Date.now() + 10 * 60_000 - 1_000)
      expect(JSON.parse((await poll()).body)).toMatchObject({ value: { state: 'done' } })
      vi.setSystemTime(Date.now() + 2_000)
      expect((await poll()).status).toBe(404)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the oldest finished job, not a new fetch, when it holds as many as it may', async () => {
    await serve(fakeGateway())
    const ids: string[] = []
    for (let i = 0; i < 65; i++) {
      const started = await json('/v1/fetch', { have: [] })
      expect(started.status).toBe(202)
      const { job } = (JSON.parse(started.body) as { value: { job: string } }).value
      ids.push(job)
      // Finished before the next starts, so only the held cap is in play.
      expect((await raw({ method: 'GET', path: `/v1/fetch/${job}?wait=5000` })).status).toBe(200)
    }

    expect((await raw({ method: 'GET', path: `/v1/fetch/${ids[0]}?wait=0` })).status).toBe(404)
    expect((await raw({ method: 'GET', path: `/v1/fetch/${ids[1]}?wait=0` })).status).toBe(200)
  })

  it('drops the job that finished longest ago, not the one started first', async () => {
    const gateway = fakeGateway()
    let finishFirst: (value: { refs: Map<string, string>; bundleId: null }) => void = () =>
      undefined
    gateway.fetch.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
    await serve(gateway)
    const start = async () => {
      const started = await json('/v1/fetch', { have: [] })
      return (JSON.parse(started.body) as { value: { job: string } }).value.job
    }
    const done = (job: string) => raw({ method: 'GET', path: `/v1/fetch/${job}?wait=5000` })
    const first = await start()
    const quick: string[] = []
    for (let i = 0; i < 63; i++) {
      const job = await start()
      quick.push(job)
      await done(job)
    }
    finishFirst({ refs: new Map(), bundleId: null })
    expect((await done(first)).status).toBe(200)

    await start()

    expect((await raw({ method: 'GET', path: `/v1/fetch/${first}?wait=0` })).status).toBe(200)
    expect((await raw({ method: 'GET', path: `/v1/fetch/${quick[0]}?wait=0` })).status).toBe(404)
  })

  it('refuses a fetch past the running-job cap rather than queue without bound', async () => {
    const gateway = fakeGateway()
    gateway.fetch.mockImplementation(() => new Promise(() => undefined))
    await serve(gateway)

    const statuses: number[] = []
    for (let i = 0; i < 9; i++) statuses.push((await json('/v1/fetch', { have: [] })).status)

    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(202))
    expect(statuses[8]).toBe(503)
    expect(gateway.fetch).toHaveBeenCalledTimes(8)
  })
})

describe('bundles across the socket', () => {
  it('streams a pushed bundle to the gateway whole, and its answer back', async () => {
    const gateway = fakeGateway()
    let received = 0
    gateway.push.mockImplementation(async (_request: unknown, bundle?: Readable) => {
      for await (const chunk of bundle ?? []) received += (chunk as Buffer).length
      return { kind: 'pushed', moved: true, from: 'abc1234', to: SHA, pastStaleLease: true }
    })
    await serve(gateway)
    const size = 8 * 1024 * 1024
    const body = Readable.from(
      (function* () {
        for (let sent = 0; sent < size; sent += 64 * 1024) yield Buffer.alloc(64 * 1024, 1)
      })(),
    )

    const answer = await connectGitHubGateway(socketPath).push(
      { branch: 'feature', sha: SHA, lease: OTHER, prerequisites: [OTHER] },
      body,
    )

    expect(received).toBe(size)
    expect(answer).toEqual({
      kind: 'pushed',
      moved: true,
      from: 'abc1234',
      to: SHA,
      pastStaleLease: true,
    })
    expect(gateway.push).toHaveBeenCalledWith(
      { branch: 'feature', sha: SHA, lease: OTHER, prerequisites: [OTHER] },
      expect.any(Readable),
      expect.any(AbortSignal),
    )
  })

  it('stops sending a bundle the gateway refused before reading it, and reports the refusal', async () => {
    const gateway = fakeGateway()
    gateway.push.mockRejectedValue(new RefusedPushError('main', 'protected'))
    await serve(gateway)
    let pulled = 0
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < 16 * 1024; i++) {
          pulled += 64 * 1024
          yield Buffer.alloc(64 * 1024, 1)
        }
      })(),
    )

    const caught = await connectGitHubGateway(socketPath)
      .push({ branch: 'main', sha: SHA, prerequisites: [] }, body)
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(RefusedPushError)
    expect(body.destroyed).toBe(true)
    // Far short of the 1 GiB it would have sent.
    expect(pulled).toBeLessThan(64 * 1024 * 1024)
  })

  it("reports the bundle's own failure, not the gateway's, when its source fails", async () => {
    const gateway = fakeGateway()
    gateway.push.mockImplementation(async (_request: unknown, bundle?: Readable) => {
      for await (const _ of bundle ?? []) {
        // Read until the stream breaks.
      }
      return { kind: 'pushed', moved: false, pastStaleLease: false }
    })
    await serve(gateway)
    const body = new Readable({ read() {} })
    body.push(Buffer.alloc(1024))
    setTimeout(() => body.destroy(new Error('git bundle create died')), 20)

    await expect(
      connectGitHubGateway(socketPath).push(
        { branch: 'feature', sha: SHA, prerequisites: [] },
        body,
      ),
    ).rejects.toThrow('git bundle create died')
  })

  it('aborts a push on the gateway when the worker aborts it mid-body', async () => {
    const gateway = fakeGateway()
    let seen: AbortSignal | undefined
    gateway.push.mockImplementation(
      (_request: unknown, _bundle: unknown, signal?: AbortSignal) =>
        new Promise((_, reject) => {
          seen = signal
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const server = await serve(gateway)
    const controller = new AbortController()
    const body = new Readable({ read() {} })
    body.push(Buffer.alloc(1024))

    const answer = connectGitHubGateway(socketPath).push(
      { branch: 'feature', sha: SHA, prerequisites: [] },
      body,
      controller.signal,
    )
    await vi.waitFor(() => expect(seen).toBeDefined())
    controller.abort(new Error('task deadline'))

    await expect(answer).rejects.toThrow('task deadline')
    await server.idle()
    expect(seen?.aborted).toBe(true)
    expect(body.destroyed).toBe(true)
  })

  it('fails the body of a push whose worker goes away part way, so later pushes still run', async () => {
    // Bundles are taken in one at a time, as the in-process gateway's intake does.
    const gateway = fakeGateway()
    let tail: Promise<unknown> = Promise.resolve()
    const reads: string[] = []
    gateway.push.mockImplementation((_request: unknown, bundle?: Readable) => {
      const run = tail.then(async () => {
        try {
          for await (const _ of bundle ?? []) {
            // Read it all, as the intake does.
          }
          reads.push('whole')
        } catch (err) {
          reads.push(String(err))
          throw err
        }
        return { kind: 'pushed' as const, moved: false as const, pastStaleLease: false }
      })
      tail = run.catch(() => undefined)
      return run
    })
    const server = await serve(gateway)
    const header = Buffer.from(
      JSON.stringify({ branch: 'feature', sha: SHA, prerequisites: [], bundle: true }),
    ).toString('base64url')
    const partial = http.request({
      socketPath,
      method: 'POST',
      path: '/v1/push',
      agent: false,
      headers: { [PUSH_REQUEST_HEADER]: header, 'content-type': 'application/x-git-bundle' },
    })
    partial.on('error', () => undefined)
    partial.write(Buffer.alloc(1024))
    await vi.waitFor(() => expect(gateway.push).toHaveBeenCalledTimes(1))
    partial.destroy()

    const answer = await connectGitHubGateway(socketPath).push(
      { branch: 'feature', sha: SHA, prerequisites: [] },
      Readable.from([Buffer.alloc(1024)]),
    )

    expect(answer).toMatchObject({ kind: 'pushed' })
    expect(reads).toEqual([expect.stringMatching(/before the bundle arrived whole/), 'whole'])
    await server.idle()
  })

  it('fails a body that arrived whole but was not yet read when its worker went away', async () => {
    const gateway = fakeGateway()
    let release: () => void = () => undefined
    const intakeFree = new Promise<void>((resolve) => (release = resolve))
    const reads: string[] = []
    gateway.push.mockImplementation(async (_request: unknown, bundle?: Readable) => {
      // The intake is busy with another push until after the worker has gone.
      await intakeFree
      let bytes = 0
      try {
        for await (const chunk of bundle ?? []) bytes += (chunk as Buffer).length
        reads.push(`whole: ${bytes}`)
      } catch (err) {
        reads.push(String(err))
        throw err
      }
      return { kind: 'pushed' as const, moved: false as const, pastStaleLease: false }
    })
    // The server's side of each request, to hold this test to its own precondition below.
    const received: http.IncomingMessage[] = []
    const createServer = http.createServer.bind(http)
    const spy = vi.spyOn(http, 'createServer').mockImplementation(((
      listener: http.RequestListener,
    ) =>
      createServer((req, res) => {
        received.push(req)
        listener(req, res)
      })) as typeof http.createServer)
    const server = await serve(gateway)
    spy.mockRestore()
    const header = Buffer.from(
      JSON.stringify({ branch: 'feature', sha: SHA, prerequisites: [], bundle: true }),
    ).toString('base64url')
    const whole = http.request({
      socketPath,
      method: 'POST',
      path: '/v1/push',
      agent: false,
      headers: { [PUSH_REQUEST_HEADER]: header, 'content-type': 'application/x-git-bundle' },
    })
    whole.on('error', () => undefined)
    // Larger than the stream buffers between the socket and the reader, all of it sent.
    whole.end(Buffer.alloc(180 * 1024))
    await vi.waitFor(() => expect(gateway.push).toHaveBeenCalledTimes(1))
    // Every byte has arrived, and some of it waits unread in the request: the case under test.
    await vi.waitFor(() => expect(received[0]?.complete).toBe(true))
    expect(received[0].readableEnded).toBe(false)
    whole.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()

    await server.idle()
    expect(reads).toEqual([expect.stringMatching(/before the bundle arrived whole/)])
  })

  it('cuts off a download whose client stops reading, releasing the bundle', async () => {
    const gateway = fakeGateway()
    let opened: Readable | undefined
    gateway.openBundle.mockImplementation(async () => {
      // Far more than the socket's buffers hold, so a client that stops reading stalls it.
      opened = Readable.from(
        (function* () {
          for (let i = 0; i < 1024; i++) yield Buffer.alloc(64 * 1024, 3)
        })(),
      )
      return opened
    })
    await serve(gateway, socketPath, { downloadStallMs: 200 })

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        { socketPath, method: 'GET', path: `/v1/bundle/${'c'.repeat(32)}`, agent: false },
        resolve,
      )
      req.on('error', reject)
      req.end()
    })
    res.on('error', () => undefined)
    // Read one chunk, then nothing more.
    await new Promise((resolve) => res.once('data', resolve))
    res.pause()

    await vi.waitFor(() => expect(opened?.destroyed).toBe(true), { timeout: 3_000 })
  })

  it('cuts off a download read too slowly on average, though it never stalls', async () => {
    const gateway = fakeGateway()
    let opened: Readable | undefined
    gateway.openBundle.mockImplementation(async () => {
      opened = Readable.from(
        (function* () {
          for (let i = 0; i < 1024; i++) yield Buffer.alloc(64 * 1024, 3)
        })(),
      )
      return opened
    })
    // A floor above what one chunk per poll below can keep up: about 640 KiB/s.
    await serve(gateway, socketPath, {
      downloadStallMs: 200,
      minDownloadBytesPerSecond: 1024 * 1024,
    })

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        { socketPath, method: 'GET', path: `/v1/bundle/${'c'.repeat(32)}`, agent: false },
        resolve,
      )
      req.on('error', reject)
      req.end()
    })
    res.on('error', () => undefined)
    res.pause()
    // One chunk every 100 ms: never a whole period without one.
    const trickle = setInterval(() => res.read(), 100)
    try {
      await vi.waitFor(() => expect(opened?.destroyed).toBe(true), { timeout: 3_000 })
    } finally {
      clearInterval(trickle)
    }
  })

  it('streams an outgoing bundle back, and answers a gone one with its error', async () => {
    const gateway = fakeGateway()
    gateway.openBundle.mockImplementation(async (id: string) => {
      if (id !== 'c'.repeat(32)) throw new GitHubTransientError('bundle-gone', 'gone')
      return Readable.from([Buffer.from('# v2 git bundle\n'), Buffer.alloc(1024 * 1024, 2)])
    })
    await serve(gateway)
    const client = connectGitHubGateway(socketPath)

    const chunks: Buffer[] = []
    for await (const chunk of await client.openBundle('c'.repeat(32))) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).length).toBe(16 + 1024 * 1024)

    await expect(client.openBundle('d'.repeat(32))).rejects.toBeInstanceOf(GitHubTransientError)
    await expect(client.openBundle('../x')).rejects.toBeInstanceOf(GitHubGatewayProtocolError)
  })
})

describe('the instance operations over the socket', () => {
  const NOTICE: GatewayTerminationNotice = { kind: 'auto-scaling', reason: 'scale-in' }

  /** A real gateway whose `prepare()` fails: its state directory is inside its workspace. */
  function unpreparedGateway(
    overrides: Partial<Parameters<typeof createLocalGitHubGateway>[0]>,
  ): GitHubGateway {
    return createLocalGitHubGateway({
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      auth: resolveWorkerGitHubAuth({ githubToken: 'fake-token' }),
      githubApp: false,
      stateDirectory: path.join(dir, 'workspace', 'state'),
      workspacePath: path.join(dir, 'workspace'),
      timeoutMs: 30_000,
      prefetch: false,
      ...overrides,
    })
  }

  it("carries the provider's snapshot, and refuses one with a field the wire does not have", async () => {
    const gateway = fakeGateway()
    const snapshot = {
      users: [{ id: 'u1', name: 'Ada', email: 'ada@example.test' }],
      groups: [{ id: 'g1', name: 'Core', memberCount: 1 }],
      memberships: { u1: ['g1'] },
    }
    gateway.authSnapshot.mockResolvedValue(snapshot)
    await serve(gateway)
    const client = connectGitHubGateway(socketPath)

    expect(await client.authSnapshot()).toEqual(snapshot)

    gateway.authSnapshot.mockResolvedValue({
      ...snapshot,
      users: [{ id: 'u1', name: 'Ada', email: 'ada@example.test', role: 'admin' }],
    } as unknown as AuthCacheSnapshot)
    await expect(client.authSnapshot()).rejects.toThrow(/authSnapshot answer does not fit/)
  })

  it('makes authSnapshot wait for prepare, and answers its failure', async () => {
    const gateway = fakeGateway()
    gateway.prepare.mockRejectedValue(new Error('the state directory is shared'))
    await serve(gateway)

    await expect(connectGitHubGateway(socketPath).authSnapshot()).rejects.toThrow(
      'the state directory is shared',
    )

    expect(gateway.authSnapshot).not.toHaveBeenCalled()
  })

  it('answers termination and completeLifecycle while prepare has failed, with the notice observed first', async () => {
    const complete = vi.fn(async () => undefined)
    const gateway = unpreparedGateway({
      watchTermination: async () => NOTICE,
      completeLifecycle: complete,
    })
    await serve(gateway)
    const client = connectGitHubGateway(socketPath)
    await expect(client.prepare()).rejects.toThrow(/inside its shared workspace/)

    // The worker draining: it asks for the notice, then for the action to be completed.
    expect(await client.termination()).toEqual(NOTICE)
    await expect(client.completeLifecycle()).resolves.toBeUndefined()

    expect((await client.health()).fatalError).toMatch(/inside its shared workspace/)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('refuses a completeLifecycle that comes before any notice, taking no identifier', async () => {
    const complete = vi.fn(async () => undefined)
    await serve(
      unpreparedGateway({
        watchTermination: () => new Promise<GatewayTerminationNotice>(() => undefined),
        completeLifecycle: complete,
        terminationPollWaitMs: 50,
      }),
    )

    const asked = await json('/v1/complete-lifecycle', {})
    const withIdentifier = await json('/v1/complete-lifecycle', { instanceId: 'i-0123456789' })

    expect(asked.status).toBe(500)
    expect(asked.body).toMatch(/seen no Auto Scaling termination/)
    expect(withIdentifier.status).toBe(400)
    expect(complete).not.toHaveBeenCalled()
  })

  it('refuses a termination poll that names a lifecycle action', async () => {
    const gateway = fakeGateway()
    await serve(gateway)

    expect((await json('/v1/termination', { hook: 'x' })).status).toBe(400)
    expect(gateway.termination).not.toHaveBeenCalled()
  })

  it('answers a waiting termination poll null when the gateway drains, long before its wait ends', async () => {
    const gateway = unpreparedGateway({
      stateDirectory: path.join(dir, 'state'),
      watchTermination: () => new Promise<GatewayTerminationNotice>(() => undefined),
      terminationPollWaitMs: 20_000,
    })
    const server = await serve(gateway)
    const client = connectGitHubGateway(socketPath)
    await client.prepare()
    const polling = client.termination().catch((err: unknown) => err)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const started = Date.now()
    await server.drain(10_000)

    expect(await polling).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("passes a poll's own abort on to the gateway", async () => {
    const gateway = fakeGateway()
    gateway.termination.mockImplementation(
      (signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    )
    await serve(gateway)
    const controller = new AbortController()

    const polling = connectGitHubGateway(socketPath)
      .termination(controller.signal)
      .catch((err: unknown) => err)
    await vi.waitFor(() => expect(gateway.termination).toHaveBeenCalled())
    controller.abort(new Error('worker stopped waiting'))

    expect(await polling).toMatchObject({ message: 'worker stopped waiting' })
    await vi.waitFor(() => expect(gateway.termination.mock.calls[0][0]?.aborted).toBe(true))
  })

  it('takes a protected set of the most entries the policy allows, plus the base', async () => {
    const gateway = fakeGateway()
    const entries = Array.from({ length: MAX_PROTECTED_BRANCHES + 1 }, (_, i) => `release/${i}`)
    gateway.health.mockResolvedValue({
      ready: true,
      fatalError: null,
      preflight: 'not-an-app' as const,
      clerkConfigured: false,
      branchPolicy: {
        configured: entries,
        githubDefault: 'main',
        namespace: 'canopycms/prod/',
        legacy: [],
        settingsBranch: null,
      },
    })
    await serve(gateway)
    const client = connectGitHubGateway(socketPath)

    expect((await client.health()).branchPolicy.configured).toHaveLength(MAX_PROTECTED_BRANCHES + 1)

    gateway.health.mockResolvedValue({
      ready: true,
      fatalError: null,
      preflight: 'not-an-app' as const,
      clerkConfigured: false,
      branchPolicy: {
        configured: [...entries, 'one-more'],
        githubDefault: 'main',
        namespace: 'canopycms/prod/',
        legacy: [],
        settingsBranch: null,
      },
    })
    await expect(client.health()).rejects.toThrow(/health answer does not fit/)
  })
})

describe('a drain', () => {
  it('lets a request under way finish, answering new ones stopping, then closes', async () => {
    const gateway = fakeGateway()
    let finish: () => void = () => undefined
    gateway.defaultBranch.mockImplementation(
      () => new Promise<string>((resolve) => (finish = () => resolve('main'))),
    )
    const server = await serve(gateway)
    const client = connectGitHubGateway(socketPath)
    const underWay = client.defaultBranch()
    await vi.waitFor(() => expect(gateway.defaultBranch).toHaveBeenCalled())

    const started = Date.now()
    const draining = server.drain(10_000)
    const refused = await client.isProtectedBranch('main').catch((err: unknown) => err)
    // Still served: under socket activation systemd holds the socket too.
    const answered = await json('/v1/is-protected-branch', { branch: 'main' })
    finish()

    expect(await underWay).toBe('main')
    await draining
    // Once nothing is under way, not at the grace's end.
    expect(Date.now() - started).toBeLessThan(5_000)
    // Stopping, which the task runner releases with no retry spent.
    expect(answered.status).toBe(503)
    expect(JSON.parse(answered.body)).toMatchObject({ error: { kind: 'stopping' } })
    expect(refused).toBeInstanceOf(GitHubGatewayStoppingError)
    expect(refused).toBeInstanceOf(GitHubGatewayUnreachableError)
    expect(String(refused)).toMatch(/stopping/)
    expect(isPermanentTaskFailure(refused)).toBe(false)
    // Once per drain, though two requests met it.
    expect(
      consoleSpy.all().warn.filter((line) => line.includes('Answering requests as stopping')),
    ).toHaveLength(1)
    expect(gateway.isProtectedBranch).not.toHaveBeenCalled()
  })

  it('ends at its grace, whatever a client trickling a request holds open', async () => {
    const server = await serve(fakeGateway())
    const trickle = http.request({
      socketPath,
      method: 'POST',
      path: '/v1/default-branch',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': '100' },
    })
    const closed = new Promise<void>((resolve) => trickle.on('error', () => resolve()))
    trickle.write('{')
    // The request is under way once the server has begun reading it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()

    await server.drain(300)

    expect(Date.now() - started).toBeLessThan(2_000)
    await closed
  })
})

describe('the socket', () => {
  it('is 0600, in a directory only this user can enter', async () => {
    await serve(fakeGateway())

    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600)
  })

  it.each(['770', '757', '722', '750', '705'])(
    'is refused in a directory mode %s lets others in',
    async (mode) => {
      await fs.chmod(dir, parseInt(mode, 8))

      await expect(serveGitHubGateway(fakeGateway(), { path: socketPath })).rejects.toThrow(
        /no one else can enter/,
      )
      await fs.chmod(dir, 0o700)
    },
  )

  it('is not left listening when it cannot be made 0600, and its gateway never prepares', async () => {
    const gateway = fakeGateway()
    const chmod = vi.spyOn(fs, 'chmod').mockRejectedValueOnce(new Error('chmod failed'))

    await expect(serveGitHubGateway(gateway, { path: socketPath })).rejects.toThrow('chmod failed')

    chmod.mockRestore()
    await expect(connectGitHubGateway(socketPath).defaultBranch()).rejects.toBeInstanceOf(
      GitHubGatewayUnreachableError,
    )
    expect(gateway.prepare).not.toHaveBeenCalled()
  })

  it('is refused under a symbolic link to a directory', async () => {
    const real = path.join(dir, 'real')
    await fs.mkdir(real, { mode: 0o700 })
    await fs.symlink(real, path.join(dir, 'link'))

    await expect(
      serveGitHubGateway(fakeGateway(), { path: path.join(dir, 'link', 's') }),
    ).rejects.toThrow(/no one else can enter/)
  })

  it('replaces a socket a killed gateway left, and refuses to replace anything else', async () => {
    // A listener killed outright leaves its socket node behind; a clean close would remove it.
    const child = spawn(process.execPath, [
      '-e',
      "require('net').createServer().listen(process.argv[1], () => process.stdout.write('up'))",
      socketPath,
    ])
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    expect((await fs.lstat(socketPath)).isSocket()).toBe(true)

    await serve(fakeGateway())
    expect(await connectGitHubGateway(socketPath).defaultBranch()).toBe('main')

    const file = path.join(dir, 'f')
    await fs.writeFile(file, '')
    await expect(serveGitHubGateway(fakeGateway(), { path: file })).rejects.toThrow(
      /something else is there/,
    )
    // Nor a socket a running gateway still answers on; and the refused one never prepared, which
    // would sweep the state directory the running one is using.
    const refused = fakeGateway()
    await expect(serveGitHubGateway(refused, { path: socketPath })).rejects.toThrow(
      /a gateway already serves there/,
    )
    expect(refused.prepare).not.toHaveBeenCalled()
    expect(await connectGitHubGateway(socketPath).defaultBranch()).toBe('main')
  })
})
