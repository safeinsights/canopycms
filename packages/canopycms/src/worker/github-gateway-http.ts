import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { z } from 'zod'

import { getErrorMessage, isNodeError } from '../utils/error'
import type {
  GitHubCreateOrUpdatePullRequest,
  GitHubFetchResult,
  GitHubGateway,
  GitHubGatewayHealth,
  GitHubPullRequest,
  GitHubPushAnswer,
  GitHubPushRequest,
} from './github-gateway'
import {
  BUNDLE_CONTENT_TYPE,
  BUNDLE_ROUTE,
  FETCH_ROUTE,
  GitHubGatewayProtocolError,
  GitHubGatewayUnreachableError,
  JSON_ROUTES,
  MAX_JSON_ANSWER_BYTES,
  MAX_JSON_REQUEST_BYTES,
  PUSH_REQUEST_HEADER,
  PUSH_ROUTE,
  UnknownFetchJobError,
  answers,
  decodeError,
  decodePushHeader,
  encodeError,
  encodePushHeader,
  fetchPoll,
  fetchRequest,
  fetchStarted,
  pushAnswer,
  pushRequest,
  readAnswerBody,
  refusedRequestError,
  requests,
  type ErrorEnvelope,
  type JsonOperation,
} from './github-gateway-wire'
import { gatewayLogWarn } from './gateway-egress'

/**
 * The GitHub gateway over a local unix socket, HTTP/1.1: {@link serveGitHubGateway} puts a
 * {@link GitHubGateway} (the in-process one, `createLocalGitHubGateway`) behind a socket, and
 * {@link connectGitHubGateway} is the worker's {@link GitHubGateway} that reaches it there. Every
 * operation is one request, validated at both ends (worker/github-gateway-wire.ts). Bundles are
 * request and response bodies, streamed; a push's JSON travels in a header beside its bundle, so
 * no framing is invented.
 *
 * A fetch is a job, not a request: `POST fetch` starts it and answers `202` with the job's id, and
 * the client polls `GET fetch/<id>` until it reports the ref map and the bundle. The job runs
 * detached from every client, so a whole-repository fetch outlasts any one request, and an abort
 * ends only the client's wait. Every other operation is given a signal that aborts when its client
 * goes away; `prepare`, which every caller shares, is not.
 */

/** How long one poll of a fetch job waits for it to finish before answering that it runs on. */
const MAX_POLL_WAIT_MS = 25_000

/** How long a finished fetch job's answer stays readable. */
const FETCH_JOB_RETENTION_MS = 10 * 60_000

/** The most fetch jobs held at once, running or finished; past it the oldest finished one goes. */
const MAX_FETCH_JOBS = 64

/** The most fetch jobs running at once. */
const MAX_RUNNING_FETCH_JOBS = 8

/** How long a request may go on sending a body after its answer, before it is cut off. */
const DISCARD_BODY_MS = 10_000

/** The most connections the server holds at once. */
const MAX_CONNECTIONS = 64

/** Where the server listens: a socket systemd passed (`fd`), or a path it binds itself. */
export type GitHubGatewayListen = { fd: number } | { path: string }

export interface GitHubGatewayServer {
  /**
   * Resolves once nothing is under way: no request is being handled, and no fetch job runs.
   */
  idle(): Promise<void>
  /** Stop accepting, and close every connection. */
  close(): Promise<void>
}

/**
 * Serve `gateway` on a unix socket.
 *
 * Who can connect is the socket node's permissions. In production the worker and the gateway run
 * as different users, so systemd creates the socket and passes it as `fd`, and the socket unit
 * sets its owner and mode (`SocketUser=`, `SocketMode=`). A `path`, for development and tests,
 * where both ends are the same user, is bound here: only inside a directory this process owns and
 * no one else can enter, so no other user can reach, plant or swap the node, which is then made
 * `0600`.
 *
 * `gateway.prepare()` starts with the server, and every operation but `health` waits for it; a
 * failure is the gateway's fatal error, answered to each of them.
 */
export async function serveGitHubGateway(
  gateway: GitHubGateway,
  listen: GitHubGatewayListen,
): Promise<GitHubGatewayServer> {
  const handler = new GatewayRequestHandler(gateway)
  const server = http.createServer((req, res) => {
    void handler.handle(req, res)
  })
  // A push's body waits for the mirror as long as the push does; the caller's signal bounds that.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.maxHeadersCount = 32
  server.maxConnections = MAX_CONNECTIONS

  if ('fd' in listen) {
    await listenOn(server, { fd: listen.fd })
  } else {
    await assertPrivateDirectory(path.dirname(listen.path))
    await removeStaleSocket(listen.path)
    await listenOn(server, { path: listen.path })
    await fs.chmod(listen.path, 0o600)
  }

  return {
    idle: () => handler.idle(),
    close: () =>
      new Promise<void>((resolve) => {
        handler.close()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function listenOn(server: http.Server, options: { fd: number } | { path: string }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

/**
 * Refuse to bind in a directory another user could enter: they could connect to the socket before
 * the `chmod`, which is not atomic with the bind, or replace or plant the node if they can write.
 */
async function assertPrivateDirectory(dir: string): Promise<void> {
  const stat = await fs.lstat(dir)
  const uid = process.getuid?.()
  if (
    !stat.isDirectory() ||
    (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))
  ) {
    throw new Error(
      `Refusing to serve the GitHub gateway in ${dir}: it must be a directory this process owns ` +
        `and no one else can enter`,
    )
  }
}

/**
 * Remove a socket a stopped gateway of this user's left at `socketPath`. Refuse anything else: a
 * file that is not a socket, someone else's, or one a running gateway still answers on.
 */
async function removeStaleSocket(socketPath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(socketPath)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    throw err
  }
  const uid = process.getuid?.()
  if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(
      `Refusing to serve the GitHub gateway at ${socketPath}: something else is there`,
    )
  }
  if (await isServed(socketPath)) {
    throw new Error(
      `Refusing to serve the GitHub gateway at ${socketPath}: a gateway already serves there`,
    )
  }
  await fs.unlink(socketPath)
}

/** Whether something accepts a connection on the socket at `socketPath`. */
function isServed(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** A request refused before any operation ran. */
class RefusedRequest extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A fetch job: one `fetch` request's answer, computed detached from every client. */
interface FetchJob {
  readonly settled: Promise<void>
  answer:
    | { ok: true; value: z.input<typeof fetchPoll> }
    | { ok: false; error: ErrorEnvelope }
    | null
  settledAt: number | null
}

/** What each JSON operation runs, given its validated request; its answer is validated after. */
type JsonRunners = {
  [K in JsonOperation]: (
    input: z.infer<(typeof requests)[K]>,
    signal: AbortSignal,
  ) => Promise<z.input<(typeof answers)[K]>>
}

class GatewayRequestHandler {
  /**
   * The gateway's `prepare()`, started as the server starts. Every operation but `health` waits
   * for it, and answers its failure: a worker that never asks for it, or asks for an operation
   * first, still cannot reach one before the App check and the state-directory check have passed.
   */
  private readonly prepared: Promise<void>
  private readonly jobs = new Map<string, FetchJob>()
  private closed = false
  private inFlight = 0
  private idleWaiters: (() => void)[] = []
  private readonly runners: JsonRunners
  private readonly routes: ReadonlyMap<string, JsonOperation>

  constructor(private readonly gateway: GitHubGateway) {
    this.prepared = gateway.prepare()
    // Answered to every operation; never unhandled while none is asked for.
    this.prepared.catch(() => undefined)
    this.routes = new Map(
      (Object.entries(JSON_ROUTES) as [JsonOperation, string][]).map(([op, route]) => [route, op]),
    )
    this.runners = {
      prepare: async () => ({}),
      health: (_, signal) => gateway.health(signal),
      defaultBranch: async (_, signal) => ({ branch: await gateway.defaultBranch(signal) }),
      isProtectedBranch: async ({ branch }, signal) => ({
        protected: await gateway.isProtectedBranch(branch, signal),
      }),
      createPullRequest: async (input, signal) => {
        const { number, url } = await gateway.createPullRequest(input, signal)
        return { number, url }
      },
      updatePullRequest: async ({ number, ...update }, signal) => {
        await gateway.updatePullRequest(number, update, signal)
        return {}
      },
      getPullRequest: async ({ number }, signal) => {
        const { merged, merged_at, state, node_id } = await gateway.getPullRequest(number, signal)
        return { merged, merged_at, state, node_id }
      },
      createOrUpdatePullRequest: async (input, signal) => {
        const { number, url, created } = await gateway.createOrUpdatePullRequest(input, signal)
        return { number, url, created }
      },
      convertPullRequestToDraft: async ({ number }, signal) => {
        await gateway.convertPullRequestToDraft(number, signal)
        return {}
      },
      deleteBranch: async ({ branch }, signal) => {
        await gateway.deleteBranch(branch, signal)
        return {}
      },
    }
  }

  close(): void {
    this.closed = true
  }

  async idle(): Promise<void> {
    for (;;) {
      await Promise.all([...this.jobs.values()].map((job) => job.settled))
      if (this.inFlight === 0) {
        if ([...this.jobs.values()].every((job) => job.answer !== null)) return
        continue
      }
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.inFlight++
    try {
      await this.route(req, res)
    } finally {
      if (--this.inFlight === 0) {
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const resolve of waiters) resolve()
      }
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Aborts the operation when the client goes away before its answer.
    const controller = new AbortController()
    res.once('close', () => {
      if (!res.writableFinished) controller.abort(new Error('The worker closed the request'))
    })
    try {
      if (this.closed) throw new RefusedRequest(503, 'the gateway is stopping')
      const url = new URL(req.url ?? '/', 'http://gateway')
      const route = url.pathname
      const op = this.routes.get(route)
      if (op !== undefined) {
        assertMethod(req, 'POST')
        await this.json(op, req, res, controller.signal)
      } else if (route === PUSH_ROUTE) {
        assertMethod(req, 'POST')
        await this.push(req, res, controller.signal)
      } else if (route === FETCH_ROUTE) {
        assertMethod(req, 'POST')
        await this.startFetch(req, res)
      } else if (route.startsWith(`${FETCH_ROUTE}/`)) {
        assertMethod(req, 'GET')
        await this.pollFetch(route.slice(FETCH_ROUTE.length + 1), url, req, res)
      } else if (route.startsWith(`${BUNDLE_ROUTE}/`)) {
        assertMethod(req, 'GET')
        await this.bundle(route.slice(BUNDLE_ROUTE.length + 1), res)
      } else {
        throw new RefusedRequest(404, `no such operation: ${route.slice(0, 200)}`)
      }
    } catch (err) {
      this.fail(req, res, err)
    }
  }

  private async json(
    op: JsonOperation,
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    if (op !== 'health') await this.prepared
    const input = parseRequest(requests[op], await readJsonBody(req), op)
    const run = this.runners[op] as (input: unknown, signal: AbortSignal) => Promise<unknown>
    const value = await run(input, signal)
    sendJson(req, res, 200, { value: parseAnswer(answers[op], value, op) })
  }

  private async push(
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    await this.prepared
    const header = req.headers[PUSH_REQUEST_HEADER]
    if (typeof header !== 'string') {
      throw new RefusedRequest(400, `a push carries its request in ${PUSH_REQUEST_HEADER}`)
    }
    let raw: unknown
    try {
      raw = decodePushHeader(header)
    } catch (err) {
      throw new RefusedRequest(400, `unreadable ${PUSH_REQUEST_HEADER}: ${getErrorMessage(err)}`)
    }
    const { bundle: hasBundle, ...request } = parseRequest(pushRequest, raw, 'push')
    let body: PassThrough | undefined
    if (hasBundle) {
      if (req.headers['content-type'] !== BUNDLE_CONTENT_TYPE) {
        throw new RefusedRequest(415, `a push's bundle is ${BUNDLE_CONTENT_TYPE}`)
      }
      // Not the request itself: the gateway destroys the stream it is given when it is done with
      // it, and destroying the request would destroy the connection the answer goes back on.
      const stream = new PassThrough()
      // Its reader, if it has one yet, sees an error; an unread one must not crash the gateway.
      stream.on('error', () => undefined)
      req.pipe(stream)
      // A request that dies part way never ends its pipe: fail the body, or its reader waits on it
      // for ever, holding the gateway's one-at-a-time intake.
      req.once('close', () => {
        // Not `complete`: that says the bytes arrived, and a destroyed request drops what it
        // buffered unread.
        if (!req.readableEnded) {
          stream.destroy(new Error('the worker closed the request before the bundle arrived whole'))
        }
      })
      body = stream
    } else if (
      req.headers['content-length'] !== '0' &&
      req.headers['content-length'] !== undefined
    ) {
      throw new RefusedRequest(400, 'a push without a bundle has no body')
    } else if (req.headers['transfer-encoding'] !== undefined) {
      throw new RefusedRequest(400, 'a push without a bundle has no body')
    }
    try {
      const answer = await this.gateway.push(request, body, signal)
      sendJson(req, res, 200, { value: parseAnswer(pushAnswer, answer, 'push') })
    } finally {
      if (body !== undefined) req.unpipe(body)
    }
  }

  private async startFetch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.prepared
    const { have } = parseRequest(fetchRequest, await readJsonBody(req), 'fetch')
    this.evictJobs()
    const running = [...this.jobs.values()].filter((job) => job.settledAt === null).length
    if (running >= MAX_RUNNING_FETCH_JOBS) {
      throw new RefusedRequest(503, 'too many fetches are under way; retry after one finishes')
    }
    // Past the cap, the job that finished longest ago goes: a poll for it then fetches afresh.
    while (this.jobs.size >= MAX_FETCH_JOBS) {
      let oldest: [string, number] | null = null
      for (const [held, job] of this.jobs) {
        if (job.settledAt !== null && (oldest === null || job.settledAt < oldest[1])) {
          oldest = [held, job.settledAt]
        }
      }
      if (oldest === null) break
      this.jobs.delete(oldest[0])
    }
    const id = randomBytes(16).toString('hex')
    const job: FetchJob = {
      answer: null,
      settledAt: null,
      // No signal: the job outlives the request that started it (see the module doc).
      settled: this.gateway.fetch({ have }).then(
        ({ refs, bundleId }) => {
          job.answer = { ok: true, value: { state: 'done', refs: [...refs], bundleId } }
        },
        (err: unknown) => {
          job.answer = { ok: false, error: encodeError(err) }
        },
      ),
    }
    void job.settled.then(() => {
      job.settledAt = Date.now()
    })
    this.jobs.set(id, job)
    sendJson(req, res, 202, { value: parseAnswer(fetchStarted, { job: id }, 'fetch') })
  }

  /** Answer a poll for job `id`, waiting up to the request's `wait` (capped) for it to finish. */
  private async pollFetch(
    id: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    await this.prepared
    this.evictJobs()
    const job = this.jobs.get(id)
    if (job === undefined) {
      sendJson(req, res, 404, {
        error: {
          kind: 'unknown-job',
          message: 'The GitHub gateway holds no such fetch: it restarted, or the fetch expired',
        } satisfies ErrorEnvelope,
      })
      return
    }
    const waitParam = url.searchParams.get('wait') ?? '0'
    if (!/^\d{1,9}$/.test(waitParam)) throw new RefusedRequest(400, 'wait must be milliseconds')
    const wait = Math.min(Number(waitParam), MAX_POLL_WAIT_MS)
    if (job.answer === null && wait > 0) {
      let timer: NodeJS.Timeout | undefined
      let onClose = (): void => undefined
      await Promise.race([
        job.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, wait)
          onClose = resolve
          res.once('close', onClose)
        }),
      ])
      clearTimeout(timer)
      res.off('close', onClose)
    }
    const answer = job.answer
    if (answer === null) sendJson(req, res, 200, { value: { state: 'running' } })
    else if (answer.ok)
      sendJson(req, res, 200, { value: parseAnswer(fetchPoll, answer.value, 'fetch') })
    else sendJson(req, res, 500, { error: answer.error })
  }

  /** Drop finished jobs past their retention. */
  private evictJobs(): void {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (job.settledAt !== null && now - job.settledAt >= FETCH_JOB_RETENTION_MS) {
        this.jobs.delete(id)
      }
    }
  }

  private async bundle(id: string, res: ServerResponse): Promise<void> {
    await this.prepared
    if (!/^[0-9A-Za-z]{1,128}$/.test(id)) throw new RefusedRequest(404, 'no such bundle')
    const stream = await this.gateway.openBundle(id)
    res.writeHead(200, { 'content-type': BUNDLE_CONTENT_TYPE })
    // A client gone part way is its own failure to report; the stream is released either way.
    await pipeline(stream, res).catch(() => undefined)
  }

  /** Answer a failure, unless the answer has already begun; then the connection is cut. */
  private fail(req: IncomingMessage, res: ServerResponse, err: unknown): void {
    if (err instanceof RefusedRequest) {
      gatewayLogWarn(
        `Refused a request to ${req.method ?? '?'} ${(req.url ?? '?').slice(0, 200)}: ${err.message}`,
      )
    }
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (err instanceof RefusedRequest) {
      sendJson(req, res, err.status, {
        error: { kind: 'refused', status: err.status, message: err.message },
      })
    } else {
      sendJson(req, res, 500, { error: encodeError(err) })
    }
  }
}

function assertMethod(req: IncomingMessage, method: 'GET' | 'POST'): void {
  if (req.method !== method)
    throw new RefusedRequest(405, `${(req.url ?? '').slice(0, 200)} takes ${method}`)
}

/** Read a JSON request body of a declared length, no larger than {@link MAX_JSON_REQUEST_BYTES}. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json') {
    throw new RefusedRequest(415, 'the request body must be application/json')
  }
  const declared = req.headers['content-length']
  if (declared === undefined || !/^\d{1,10}$/.test(declared)) {
    throw new RefusedRequest(411, 'the request must declare its length')
  }
  if (Number(declared) > MAX_JSON_REQUEST_BYTES) {
    throw new RefusedRequest(413, `the request is larger than ${MAX_JSON_REQUEST_BYTES} bytes`)
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RefusedRequest(400, 'the request body is not JSON')
  }
}

function parseRequest<S extends z.ZodTypeAny>(schema: S, value: unknown, op: string): z.infer<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    // Codes and paths only: an issue's own text can quote the request back, at any length.
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.code} at ${issue.path.join('.').slice(0, 64) || '(root)'}`)
      .join('; ')
    throw new RefusedRequest(400, `malformed ${op} request: ${issues}`)
  }
  return parsed.data as z.infer<S>
}

/** The gateway's own answer, held to the wire format before it leaves. */
function parseAnswer<S extends z.ZodTypeAny>(schema: S, value: unknown, op: string): z.infer<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`The GitHub gateway's ${op} answer does not fit the wire format`)
  }
  return parsed.data as z.infer<S>
}

/**
 * Answer with `body`. When the request's body has not all arrived (an answer that refuses it part
 * way), the answer is written whole but ended only once the client stops sending, which it does on
 * reading the answer; meanwhile the rest of the body is read and dropped. Ending it at once would
 * close the connection under the client's next write, which can then fail before it has read the
 * answer. A client that keeps sending is cut off after {@link DISCARD_BODY_MS}.
 */
function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  if (req.complete) {
    res.end(text)
    return
  }
  res.write(text)
  const timer = setTimeout(() => req.socket.destroy(), DISCARD_BODY_MS)
  timer.unref()
  const finish = () => {
    clearTimeout(timer)
    res.end()
  }
  req.once('end', finish)
  req.once('close', finish)
  req.resume()
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** How long the client asks each poll of a fetch job to wait. */
const POLL_WAIT_MS = MAX_POLL_WAIT_MS

/** How long `health` waits for the gateway: `getSecret` alone has taken 87 s. */
const HEALTH_WAIT_MS = 300_000

/** How many polls in a row the connection may break off before the fetch fails. */
const POLL_RETRIES = 3

/** How long the client waits before polling again after a broken poll. */
const POLL_RETRY_MS = 1_000

/** Resolve after `ms`, or reject with `signal`'s reason when it aborts first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The worker's {@link GitHubGateway} for a gateway served at `socketPath`. Every answer is
 * validated before the worker sees it, and every error is rebuilt (worker/github-gateway-wire.ts,
 * `decodeError`), so the task runner classifies it as it would in-process. A
 * gateway it cannot reach throws {@link GitHubGatewayUnreachableError}.
 */
export function connectGitHubGateway(socketPath: string): GitHubGateway {
  return new GitHubGatewayClient(socketPath)
}

class GitHubGatewayClient implements GitHubGateway {
  constructor(private readonly socketPath: string) {}

  async prepare(): Promise<void> {
    await this.call('prepare', {})
  }

  /** Waits up to {@link HEALTH_WAIT_MS} for a `prepare()` under way: secret reads can be slow. */
  health(signal?: AbortSignal): Promise<GitHubGatewayHealth> {
    const bound = AbortSignal.timeout(HEALTH_WAIT_MS)
    return this.call('health', {}, signal === undefined ? bound : AbortSignal.any([signal, bound]))
  }

  async defaultBranch(signal?: AbortSignal): Promise<string> {
    return (await this.call('defaultBranch', {}, signal)).branch
  }

  async isProtectedBranch(branch: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.call('isProtectedBranch', { branch }, signal)).protected
  }

  /**
   * Start a fetch job and poll it. A poll for a job the gateway does not hold (it restarted, or
   * the job expired) starts one new job; a second loss fails.
   */
  async fetch(
    request: { have: readonly string[] },
    signal?: AbortSignal,
  ): Promise<GitHubFetchResult> {
    const have = [...new Set(request.have)]
    for (let attempt = 1; ; attempt++) {
      const started = await this.send({
        method: 'POST',
        path: FETCH_ROUTE,
        json: { have },
        signal,
      })
      const { job } = await readAnswer(started, fetchStarted, signal)
      try {
        return await this.pollFetch(job, signal)
      } catch (err) {
        if (err instanceof UnknownFetchJobError && attempt === 1) continue
        throw err
      }
    }
  }

  /**
   * Poll job `job` until it finishes. A poll the connection breaks off (the gateway restarting) is
   * tried again, up to {@link POLL_RETRIES} times in a row, {@link POLL_RETRY_MS} apart: a
   * restarted gateway then answers that it no longer holds the job.
   */
  private async pollFetch(job: string, signal?: AbortSignal): Promise<GitHubFetchResult> {
    for (let broken = 0; ; ) {
      let poll: z.infer<typeof fetchPoll>
      try {
        const res = await this.send({
          method: 'GET',
          path: `${FETCH_ROUTE}/${job}?wait=${POLL_WAIT_MS}`,
          signal,
        })
        poll = await readAnswer(res, fetchPoll, signal)
      } catch (err) {
        if (!(err instanceof GitHubGatewayUnreachableError) || ++broken > POLL_RETRIES) throw err
        await delay(POLL_RETRY_MS, signal)
        continue
      }
      broken = 0
      if (poll.state === 'done') return { refs: new Map(poll.refs), bundleId: poll.bundleId }
    }
  }

  async openBundle(bundleId: string): Promise<Readable> {
    const res = await this.send({
      method: 'GET',
      path: `${BUNDLE_ROUTE}/${encodeURIComponent(bundleId)}`,
    })
    if (res.statusCode === 200 && res.headers['content-type'] === BUNDLE_CONTENT_TYPE) return res
    await readAnswer(res, answers.prepare)
    throw new GitHubGatewayProtocolError('The GitHub gateway answered a bundle with no bundle')
  }

  async push(
    request: GitHubPushRequest,
    bundle?: Readable,
    signal?: AbortSignal,
  ): Promise<GitHubPushAnswer> {
    const header = encodePushHeader({
      branch: request.branch,
      sha: request.sha,
      ...(request.lease === undefined ? {} : { lease: request.lease }),
      prerequisites: [...request.prerequisites],
      bundle: bundle !== undefined,
    })
    const res = await this.send({
      method: 'POST',
      path: PUSH_ROUTE,
      headers: {
        [PUSH_REQUEST_HEADER]: header,
        ...(bundle === undefined
          ? { 'content-length': '0' }
          : { 'content-type': BUNDLE_CONTENT_TYPE }),
      },
      body: bundle,
      signal,
    })
    const answer = await readAnswer(res, pushAnswer, signal)
    if (answer.kind === 'need-objects') return answer
    const { kind, pastStaleLease } = answer
    return answer.moved
      ? { kind, moved: true, from: answer.from, to: answer.to, pastStaleLease }
      : { kind, moved: false, pastStaleLease }
  }

  createPullRequest(
    request: { head: string; base: string; title: string; body: string },
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string }> {
    return this.call('createPullRequest', request, signal)
  }

  async updatePullRequest(
    number: number,
    update: { title?: string; body?: string; state?: 'closed' },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('updatePullRequest', { number, ...update }, signal)
  }

  getPullRequest(number: number, signal?: AbortSignal): Promise<GitHubPullRequest> {
    return this.call('getPullRequest', { number }, signal)
  }

  createOrUpdatePullRequest(
    request: GitHubCreateOrUpdatePullRequest,
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string; created: boolean }> {
    return this.call('createOrUpdatePullRequest', request, signal)
  }

  async convertPullRequestToDraft(number: number, signal?: AbortSignal): Promise<void> {
    await this.call('convertPullRequestToDraft', { number }, signal)
  }

  async deleteBranch(branch: string, signal?: AbortSignal): Promise<void> {
    await this.call('deleteBranch', { branch }, signal)
  }

  private async call<K extends JsonOperation>(
    op: K,
    input: z.input<(typeof requests)[K]>,
    signal?: AbortSignal,
  ): Promise<z.infer<(typeof answers)[K]>> {
    const res = await this.send({ method: 'POST', path: JSON_ROUTES[op], json: input, signal })
    return readAnswer(res, answers[op], signal) as Promise<z.infer<(typeof answers)[K]>>
  }

  /**
   * Send one request and resolve with the response once it begins. An abort destroys the request
   * (the gateway then aborts the operation) and rejects with the signal's reason. A streamed `body` stops as soon as the answer begins: an answer
   * before the whole body means the gateway refused it, and destroying it stops its writer.
   */
  private send(options: {
    method: 'GET' | 'POST'
    path: string
    json?: unknown
    headers?: Record<string, string>
    body?: Readable
    signal?: AbortSignal
  }): Promise<IncomingMessage> {
    const { signal, body } = options
    return new Promise<IncomingMessage>((resolve, reject) => {
      if (signal?.aborted) {
        body?.destroy()
        reject(signal.reason)
        return
      }
      const text = options.json === undefined ? undefined : JSON.stringify(options.json)
      const req = http.request({
        socketPath: this.socketPath,
        method: options.method,
        path: options.path,
        agent: false,
        headers: {
          ...options.headers,
          ...(text === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(text)),
              }),
        },
      })
      let settled = false
      let bodyError: unknown = null
      const settle = () => {
        settled = true
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        if (settled) return
        settle()
        body?.destroy()
        req.destroy()
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.once('response', (res) => {
        if (settled) {
          res.destroy()
          return
        }
        settle()
        if (body !== undefined && !body.readableEnded) {
          body.unpipe(req)
          body.destroy()
          req.end()
        }
        resolve(res)
      })
      req.on('error', (err) => {
        if (settled) return
        settle()
        body?.destroy()
        reject(
          bodyError ??
            new GitHubGatewayUnreachableError(
              `Could not reach the GitHub gateway at ${this.socketPath}: ${getErrorMessage(err)}`,
            ),
        )
      })
      if (body !== undefined) {
        body.once('error', (err) => {
          // The bundle's own failure (its git), not the gateway's: reported as itself.
          bodyError = err
          req.destroy(err)
        })
        body.pipe(req)
      } else {
        req.end(text)
      }
    })
  }
}

/**
 * Read a JSON answer: its value, held to `schema`, or its error, rebuilt. Bounded to
 * {@link MAX_JSON_ANSWER_BYTES}; a connection that breaks part way is unreachable.
 */
async function readAnswer<S extends z.ZodTypeAny>(
  res: IncomingMessage,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  const onAbort = () => res.destroy()
  signal?.addEventListener('abort', onAbort, { once: true })
  let text: string
  try {
    if (res.headers['content-type'] !== 'application/json') {
      res.destroy()
      // node's own refusals (a 431 for an oversize header) carry no JSON.
      throw refusedRequestError(
        `The GitHub gateway answered ${res.statusCode ?? '?'} with no JSON`,
        res.statusCode,
      )
    }
    const chunks: Buffer[] = []
    let total = 0
    try {
      for await (const chunk of res) {
        total += (chunk as Buffer).length
        if (total > MAX_JSON_ANSWER_BYTES) {
          throw new GitHubGatewayProtocolError(
            `The GitHub gateway's answer is larger than ${MAX_JSON_ANSWER_BYTES} bytes`,
          )
        }
        chunks.push(chunk as Buffer)
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason
      if (err instanceof GitHubGatewayProtocolError) throw err
      throw new GitHubGatewayUnreachableError(
        `The GitHub gateway broke off its answer: ${getErrorMessage(err)}`,
      )
    }
    if (signal?.aborted) throw signal.reason
    text = Buffer.concat(chunks).toString('utf8')
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    throw new GitHubGatewayProtocolError('The GitHub gateway answered with malformed JSON')
  }
  const body = readAnswerBody(json)
  if (body === null) {
    throw new GitHubGatewayProtocolError('The GitHub gateway answered outside the wire format')
  }
  const status = res.statusCode ?? 0
  if ('error' in body) {
    if (status < 400) {
      throw new GitHubGatewayProtocolError(`The GitHub gateway answered ${status} with an error`)
    }
    throw decodeError(body.error)
  }
  if (status < 200 || status >= 300) {
    throw new GitHubGatewayProtocolError(`The GitHub gateway answered ${status} with a value`)
  }
  const value = schema.safeParse(body.value)
  if (!value.success) {
    throw new GitHubGatewayProtocolError(
      `The GitHub gateway's answer does not fit the wire format: ${value.error.message}`,
    )
  }
  return value.data as z.infer<S>
}
