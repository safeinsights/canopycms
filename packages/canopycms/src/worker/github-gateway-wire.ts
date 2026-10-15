import { z } from 'zod'

import { GatewayRefusalError, MAX_PROTECTED_BRANCHES } from './branch-policy'
import { GitHubPushError, MAX_FETCH_HAVE } from './github-gateway'
import { GitHubTransientError, RefusedPushError } from './github-mirror'
import { gatewayLogWarn, redactEgress } from './gateway-egress'

/**
 * The GitHub gateway's wire format (worker/github-gateway-http.ts): what each operation sends and
 * answers over the socket, and how a thrown error crosses it. Both ends validate everything they
 * read against these schemas, and a value that fails is refused, never coerced: the server before
 * any operation runs, the client before the worker sees an answer.
 *
 * The schemas bound shape and size. Where the gateway refuses a value itself (a branch name, a pull
 * request's text, a protected branch: worker/branch-policy.ts), the bound here sits well above its
 * cap, so its refusal crosses as itself and classifies as it does in-process. Object IDs and the
 * `have` and prerequisite counts are held here to the gateway's own rules. Requests are strict, an
 * unknown field refused: the worker and the gateway ship in one bundle and roll together, so they
 * never differ in version, and tolerating fields would only widen what a hostile worker can send.
 */

/** Every route's prefix, so a later incompatible format can sit beside this one. */
const WIRE_PREFIX = '/v1'

/** Carries a push's JSON request, so the request body is free for its bundle. Base64url JSON. */
export const PUSH_REQUEST_HEADER = 'canopy-push-request'

/** The content type of a bundle, either way. */
export const BUNDLE_CONTENT_TYPE = 'application/x-git-bundle'

/** The largest JSON request body, in bytes: `have`'s 10 000 IDs, or a pull request body. */
export const MAX_JSON_REQUEST_BYTES = 2 * 1024 * 1024

/** The largest JSON answer, in bytes: a fetch's ref map for every GitHub branch. */
export const MAX_JSON_ANSWER_BYTES = 64 * 1024 * 1024

/** The longest error message that crosses, in characters; a longer one is cut. */
const MAX_MESSAGE_LENGTH = 256 * 1024

/** The largest Octokit `response.data` that crosses, serialized; a larger one crosses as absent. */
const MAX_ERROR_DATA_BYTES = 64 * 1024

/** The Octokit response headers that cross: the ones the task runner classifies on. */
const CROSSING_HEADERS = ['x-ratelimit-remaining', 'retry-after'] as const

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'not a full object ID')
// Shape bounds only: the gateway refuses a name or text over its own caps as itself.
const name = z.string().max(4096)
const prNumber = z.number().int().safe()
const message = z.string().max(MAX_MESSAGE_LENGTH)

export const fetchRequest = z.object({ have: z.array(objectId).max(MAX_FETCH_HAVE) }).strict()

export const pushRequest = z
  .object({
    branch: name,
    sha: objectId,
    lease: objectId.optional(),
    prerequisites: z.array(objectId).max(3),
    /** Whether the request body is a bundle; without one it is empty. */
    bundle: z.boolean(),
  })
  .strict()

const pullRequestText = { title: z.string().max(64 * 1024), body: z.string().max(1024 * 1024) }

export const requests = {
  prepare: z.object({}).strict(),
  health: z.object({}).strict(),
  defaultBranch: z.object({}).strict(),
  isProtectedBranch: z.object({ branch: name }).strict(),
  createPullRequest: z.object({ head: name, base: name, ...pullRequestText }).strict(),
  updatePullRequest: z
    .object({
      number: prNumber,
      title: pullRequestText.title.optional(),
      body: pullRequestText.body.optional(),
      state: z.literal('closed').optional(),
    })
    .strict(),
  getPullRequest: z.object({ number: prNumber }).strict(),
  createOrUpdatePullRequest: z
    .object({
      head: name,
      base: name,
      ...pullRequestText,
      markReadyIfDraft: z.boolean().optional(),
      mergeSectionIntoBody: z.boolean().optional(),
    })
    .strict(),
  convertPullRequestToDraft: z.object({ number: prNumber }).strict(),
  deleteBranch: z.object({ branch: name }).strict(),
  authSnapshot: z.object({}).strict(),
  termination: z.object({}).strict(),
  completeLifecycle: z.object({}).strict(),
} as const

const empty = z.object({}).strict()
const pullRequestRef = z.object({ number: prNumber, url: z.string().max(4096) }).strict()

export const answers = {
  prepare: empty,
  health: z
    .object({
      ready: z.boolean(),
      fatalError: message.nullable(),
      preflight: z.enum(['not-an-app', 'verified', 'unverified', 'pending']),
      clerkConfigured: z.boolean(),
      protectedBranches: z
        .object({
          configured: z.array(name).max(MAX_PROTECTED_BRANCHES + 1),
          githubDefault: name.nullable(),
        })
        .strict(),
    })
    .strict(),
  defaultBranch: z.object({ branch: name }).strict(),
  isProtectedBranch: z.object({ protected: z.boolean() }).strict(),
  createPullRequest: pullRequestRef,
  updatePullRequest: empty,
  getPullRequest: z
    .object({
      merged: z.boolean(),
      merged_at: z.string().max(64).nullable(),
      state: z.enum(['open', 'closed']),
      node_id: z.string().max(256),
    })
    .strict(),
  createOrUpdatePullRequest: pullRequestRef.extend({ created: z.boolean() }).strict(),
  convertPullRequestToDraft: empty,
  deleteBranch: empty,
  authSnapshot: z
    .object({
      users: z
        .array(
          z
            .object({
              id: name,
              name,
              email: name,
              avatarUrl: z.string().max(65536).optional(),
            })
            .strict(),
        )
        .max(1_000_000),
      groups: z
        .array(
          z
            .object({
              id: name,
              name,
              description: name.optional(),
              memberCount: z.number().int().nonnegative().optional(),
            })
            .strict(),
        )
        .max(1_000_000),
      memberships: z.record(z.array(name).max(100_000)),
    })
    .strict(),
  termination: z
    .object({
      notice: z
        .object({ kind: z.enum(['auto-scaling', 'spot']), reason: z.string().max(4096) })
        .strict()
        .nullable(),
    })
    .strict(),
  completeLifecycle: empty,
} as const

export type JsonOperation = keyof typeof requests

/** Where each JSON operation is POSTed. */
export const JSON_ROUTES: Readonly<Record<JsonOperation, string>> = {
  prepare: `${WIRE_PREFIX}/prepare`,
  health: `${WIRE_PREFIX}/health`,
  defaultBranch: `${WIRE_PREFIX}/default-branch`,
  isProtectedBranch: `${WIRE_PREFIX}/is-protected-branch`,
  createPullRequest: `${WIRE_PREFIX}/pull-request/create`,
  updatePullRequest: `${WIRE_PREFIX}/pull-request/update`,
  getPullRequest: `${WIRE_PREFIX}/pull-request/get`,
  createOrUpdatePullRequest: `${WIRE_PREFIX}/pull-request/create-or-update`,
  convertPullRequestToDraft: `${WIRE_PREFIX}/pull-request/convert-to-draft`,
  deleteBranch: `${WIRE_PREFIX}/branch/delete`,
  authSnapshot: `${WIRE_PREFIX}/auth-snapshot`,
  termination: `${WIRE_PREFIX}/termination`,
  completeLifecycle: `${WIRE_PREFIX}/complete-lifecycle`,
}

export const FETCH_ROUTE = `${WIRE_PREFIX}/fetch`
export const PUSH_ROUTE = `${WIRE_PREFIX}/push`
export const BUNDLE_ROUTE = `${WIRE_PREFIX}/bundle`

/** A fetch job's id, and a bundle's: 32 hex digits. */
const jobId = z.string().regex(/^[0-9a-f]{32}$/)

export const fetchStarted = z.object({ job: jobId }).strict()

/** A fetch job's state as a poll reads it; a failed one answers its error instead. */
export const fetchPoll = z.discriminatedUnion('state', [
  /** `progress` counts the signs of life from the gateway's git while the job waits. */
  z.object({ state: z.literal('running'), progress: z.number().int().nonnegative() }).strict(),
  z
    .object({
      state: z.literal('done'),
      progress: z.number().int().nonnegative(),
      /** Every GitHub branch and its tip, as pairs: a `Map` has no JSON form of its own. */
      refs: z.array(z.tuple([name, objectId])).max(1_000_000),
      bundleId: jobId.nullable(),
    })
    .strict(),
])

export const pushAnswer = z.union([
  z
    .object({
      kind: z.literal('pushed'),
      moved: z.literal(false),
      pastStaleLease: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pushed'),
      moved: z.literal(true),
      // git's abbreviation of GitHub's old tip; null for a new branch.
      from: z
        .string()
        .regex(/^[0-9a-f]{4,64}$/)
        .nullable(),
      to: objectId,
      pastStaleLease: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('need-objects'), usable: z.array(objectId).max(3) }).strict(),
])

/**
 * A JSON answer's body, `{ value }` or `{ error }` and nothing else; null for anything else.
 */
export function readAnswerBody(
  json: unknown,
): { value: unknown; error?: undefined } | { error: unknown } | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const keys = Object.keys(json)
  if (keys.length !== 1) return null
  if (keys[0] === 'value') return { value: (json as { value: unknown }).value }
  if (keys[0] === 'error') return { error: (json as { error: unknown }).error }
  return null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const errorEnvelope = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('refusal'),
      push: z.boolean(),
      operation: z.enum(['push', 'delete', 'pull-request']),
      branch: name,
      reason: z.enum(['invalid', 'protected', 'settings', 'not-a-commit', 'too-long']),
      message,
    })
    .strict(),
  z
    .object({
      kind: z.literal('push'),
      pushKind: z.enum(['rejected', 'rejected-after-stale-lease']),
      message,
    })
    .strict(),
  z
    .object({
      kind: z.literal('transient'),
      code: z.enum([
        'github-fetch-failed',
        'bundle-rejected',
        'prerequisite-gone',
        'bundle-gone',
        'mirror-corrupt',
        'objects-still-needed',
        'ref-kept-moving',
        'default-branch-unread',
      ]),
      message,
    })
    .strict(),
  z
    .object({
      kind: z.literal('http'),
      name: z.string().max(256),
      message,
      status: z.number().int(),
      /** Octokit's `response`, when the error carried one: the headers that cross, and its body. */
      response: z
        .object({
          headers: z.record(z.string().max(1024)),
          data: z.unknown().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('error'), name: z.string().max(256), message }).strict(),
  /** A transport-level refusal, with its HTTP status: the request never reached an operation. */
  z.object({ kind: z.literal('refused'), status: z.number().int(), message }).strict(),
  /** A poll named a job the gateway does not hold: it restarted, or the job's record expired. */
  z.object({ kind: z.literal('unknown-job'), message }).strict(),
  /** The gateway is draining for a stop: to the worker it is as good as gone. */
  z.object({ kind: z.literal('stopping'), message }).strict(),
])

export type ErrorEnvelope = z.infer<typeof errorEnvelope>

/**
 * An Octokit error as it crosses the socket: the fields the task runner's classifiers read
 * (`status`, `response.headers`, `response.data`, the message), rebuilt on the worker's side. Not
 * a gateway class: a GitHub answer stays a GitHub answer (`isPermanentTaskFailure`,
 * `isRateLimitSignal403`, `isNoCommitsBetweenError`, `isRefAlreadyGoneError`).
 * @internal Exported for tests.
 */
export class GitHubRequestError extends Error {
  constructor(
    name: string,
    message: string,
    readonly status: number,
    readonly response?: { headers: Record<string, string>; data?: unknown },
  ) {
    super(message)
    this.name = name
  }
}

/**
 * The GitHub gateway could not be reached, or broke off an answer: it is not running, restarting,
 * or stopping. Transient.
 */
export class GitHubGatewayUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubGatewayUnreachableError'
  }
}

/**
 * The gateway answered that it is draining for a stop. Unreachable for every purpose, and more:
 * the task runner releases a task it hits with no retry spent, since the stop, not the task, is
 * why it failed, and a restart's grace could otherwise outlast the task's retries.
 */
export class GitHubGatewayStoppingError extends GitHubGatewayUnreachableError {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubGatewayStoppingError'
  }
}

/** The gateway refused a request before any operation ran, or answered outside the wire format. */
export class GitHubGatewayProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubGatewayProtocolError'
  }
}

/**
 * The gateway, or node in front of it, refused a request for its shape or size: the same request
 * is refused again, as the in-process gateway's own refusal of an oversize field is, so the task
 * runner fails it for good. The HTTP status is `refusedWith`, never `status`, which every
 * classifier reads as GitHub's (a 404 there means a branch already gone).
 */
export class GatewayRequestRefusedError extends GitHubGatewayProtocolError {
  constructor(
    message: string,
    readonly refusedWith: number,
  ) {
    super(message)
    this.name = 'GatewayRequestRefusedError'
  }
}

/**
 * The statuses that refuse a request for its shape or size. An unknown route or method (404, 405)
 * says nothing about the request's content, so it stays transient, as does a 503 (busy,
 * stopping).
 */
const SHAPE_REFUSALS: ReadonlySet<number> = new Set([400, 411, 413, 415, 431])

/** The error for a request refused with `status` before any operation ran. */
export function refusedRequestError(message: string, status: number | undefined): Error {
  return status !== undefined && SHAPE_REFUSALS.has(status)
    ? new GatewayRequestRefusedError(message, status)
    : new GitHubGatewayProtocolError(message)
}

/** The message a thrown value that is not an Error crosses with. */
const NOT_AN_ERROR_MESSAGE = 'The GitHub gateway failed with a value that is not an Error'

/**
 * The envelope for an error leaving the gateway. Every string in it is scrubbed as an error is,
 * by the exact token forms and `redactCredentials`'s patterns (worker/gateway-egress.ts): a
 * credentialed operation already did (`LocalGitHubGateway.credentialed`), and this is the last
 * place anything could slip past it. No stack, no
 * `cause` and no Octokit `request` crosses. A thrown value that is not an Error crosses as a fixed
 * message and is logged here instead: its string form can be anything, a stack included.
 */
export function encodeError(err: unknown): ErrorEnvelope {
  const text = (value: string) => redactEgress(value).slice(0, MAX_MESSAGE_LENGTH)
  if (err instanceof GatewayRefusalError) {
    return {
      kind: 'refusal',
      push: err instanceof RefusedPushError,
      operation: err.operation,
      branch: text(err.branch),
      reason: err.reason,
      message: text(err.message),
    }
  }
  if (err instanceof GitHubPushError) {
    return { kind: 'push', pushKind: err.kind, message: text(err.message) }
  }
  if (err instanceof GitHubTransientError) {
    return { kind: 'transient', code: err.code, message: text(err.message) }
  }
  if (!(err instanceof Error)) {
    gatewayLogWarn('Answered a thrown value that is not an Error:', err)
    return { kind: 'error', name: 'Error', message: NOT_AN_ERROR_MESSAGE }
  }
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number' && Number.isInteger(status)) {
    const response = (err as { response?: unknown }).response
    return {
      kind: 'http',
      name: text(err.name),
      message: text(err.message),
      status,
      ...(typeof response === 'object' && response !== null
        ? { response: encodeResponse(response as { headers?: unknown; data?: unknown }) }
        : {}),
    }
  }
  return { kind: 'error', name: text(err.name), message: text(err.message) }
}

function encodeResponse(response: { headers?: unknown; data?: unknown }): {
  headers: Record<string, string>
  data?: unknown
} {
  const headers: Record<string, string> = {}
  if (typeof response.headers === 'object' && response.headers !== null) {
    const source = response.headers as Record<string, unknown>
    for (const key of CROSSING_HEADERS) {
      const value = source[key]
      if (typeof value === 'string' || typeof value === 'number') {
        headers[key] = redactEgress(String(value)).slice(0, 1024)
      }
    }
  }
  if (response.data === undefined) return { headers }
  let serialized: string
  try {
    serialized = JSON.stringify(response.data) ?? ''
  } catch {
    return { headers }
  }
  if (Buffer.byteLength(serialized) > MAX_ERROR_DATA_BYTES) return { headers }
  // Scrubbed as text, then read back; text the scrub left unreadable crosses as absent.
  try {
    return { headers, data: JSON.parse(redactEgress(serialized)) as unknown }
  } catch {
    return { headers }
  }
}

/**
 * The error an envelope describes, as the worker throws it: the gateway's own classes keep their
 * class, fields and message; an Octokit error becomes a {@link GitHubRequestError}.
 */
export function decodeError(value: unknown): Error {
  const parsed = errorEnvelope.safeParse(value)
  if (!parsed.success) {
    return new GitHubGatewayProtocolError(
      `The GitHub gateway answered with an error the worker cannot read: ${parsed.error.message}`,
    )
  }
  const envelope = parsed.data
  switch (envelope.kind) {
    case 'refusal': {
      const { push, operation, branch, reason } = envelope
      if (!push) return new GatewayRefusalError(operation, branch, reason, envelope.message)
      if (operation !== 'push' || reason === 'too-long') {
        return new GitHubGatewayProtocolError(
          `The GitHub gateway answered with a push refusal for ${operation}, reason ${reason}`,
        )
      }
      const err = new RefusedPushError(branch, reason)
      // The gateway's message, which can name what RefusedPushError's own cannot (the object).
      err.message = envelope.message
      return err
    }
    case 'push':
      return new GitHubPushError(envelope.pushKind, envelope.message)
    case 'transient':
      return new GitHubTransientError(envelope.code, envelope.message)
    case 'http':
      return new GitHubRequestError(
        envelope.name,
        envelope.message,
        envelope.status,
        envelope.response,
      )
    case 'error': {
      const err = new Error(envelope.message)
      err.name = envelope.name
      return err
    }
    case 'refused':
      return refusedRequestError(
        `The GitHub gateway refused the request: ${envelope.message}`,
        envelope.status,
      )
    case 'unknown-job':
      return new UnknownFetchJobError(envelope.message)
    case 'stopping':
      return new GitHubGatewayStoppingError(`The GitHub gateway is stopping: ${envelope.message}`)
  }
}

/** A poll for a fetch job the gateway does not hold; the client fetches anew, once. */
export class UnknownFetchJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownFetchJobError'
  }
}

/** A push's JSON request, as {@link PUSH_REQUEST_HEADER} carries it. */
export function encodePushHeader(request: z.infer<typeof pushRequest>): string {
  return Buffer.from(JSON.stringify(request)).toString('base64url')
}

/** {@link encodePushHeader}'s inverse; throws on anything that is not base64url JSON. */
export function decodePushHeader(value: string): unknown {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('the push header is not base64url')
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
}
