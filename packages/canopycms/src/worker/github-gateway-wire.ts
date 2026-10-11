import { z } from 'zod'

import { GatewayRefusalError } from './branch-policy'
import { GitHubPushError, MAX_FETCH_HAVE } from './github-gateway'
import { GitHubTransientError, RefusedPushError } from './github-mirror'
import { redactEgress } from './gateway-egress'

/**
 * The GitHub gateway's wire format (worker/github-gateway-http.ts): what each operation sends and
 * answers over the socket, and how a thrown error crosses it. Both ends validate everything they
 * read against these schemas, and a value that fails is refused, never coerced: the server before
 * any operation runs, the client before the worker sees an answer.
 *
 * The schemas bound shape and size only. What a value means (a plain branch name, a pull request's
 * text caps, a protected branch) stays the gateway's to judge (worker/branch-policy.ts), so its
 * refusals cross as themselves and classify as they do in-process: a size bound here sits well
 * above the gateway's own cap for the same field.
 */

/** Every route's prefix, so a later incompatible format can sit beside this one. */
const WIRE_PREFIX = '/v1'

/** Carries a push's JSON request, so the request body is free for its bundle. Base64url JSON. */
export const PUSH_REQUEST_HEADER = 'canopy-push-request'

/** The content type of a bundle, either way. */
export const BUNDLE_CONTENT_TYPE = 'application/x-git-bundle'

/** The largest JSON request or answer body, in bytes: `have`'s 10 000 IDs, or a pull request body. */
export const MAX_JSON_REQUEST_BYTES = 2 * 1024 * 1024

/** The largest JSON answer, in bytes: a fetch's ref map for every GitHub branch. */
export const MAX_JSON_ANSWER_BYTES = 64 * 1024 * 1024

/** The longest error message that crosses, in characters: git's stderr is capped at 64 KiB. */
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
} as const

const empty = z.object({}).strict()
const pullRequestRef = z.object({ number: prNumber, url: z.string().max(4096) }).strict()

export const answers = {
  prepare: empty,
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
} as const

export type JsonOperation = keyof typeof requests

/** Where each JSON operation is POSTed. */
export const JSON_ROUTES: Readonly<Record<JsonOperation, string>> = {
  prepare: `${WIRE_PREFIX}/prepare`,
  defaultBranch: `${WIRE_PREFIX}/default-branch`,
  isProtectedBranch: `${WIRE_PREFIX}/is-protected-branch`,
  createPullRequest: `${WIRE_PREFIX}/pull-request/create`,
  updatePullRequest: `${WIRE_PREFIX}/pull-request/update`,
  getPullRequest: `${WIRE_PREFIX}/pull-request/get`,
  createOrUpdatePullRequest: `${WIRE_PREFIX}/pull-request/create-or-update`,
  convertPullRequestToDraft: `${WIRE_PREFIX}/pull-request/convert-to-draft`,
  deleteBranch: `${WIRE_PREFIX}/branch/delete`,
}

export const FETCH_ROUTE = `${WIRE_PREFIX}/fetch`
export const PUSH_ROUTE = `${WIRE_PREFIX}/push`
export const BUNDLE_ROUTE = `${WIRE_PREFIX}/bundle`

/** A fetch job's id, and a bundle's: 32 hex digits. */
const jobId = z.string().regex(/^[0-9a-f]{32}$/)

export const fetchStarted = z.object({ job: jobId }).strict()

/** A fetch job's state as a poll reads it; a failed one answers its error instead. */
export const fetchPoll = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running') }).strict(),
  z
    .object({
      state: z.literal('done'),
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
  /** A transport-level refusal: the request never reached an operation. */
  z.object({ kind: z.literal('refused'), message }).strict(),
  /** A poll named a job the gateway does not hold: it restarted, or the job's record expired. */
  z.object({ kind: z.literal('unknown-job'), message }).strict(),
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

/** An answer from the gateway that does not fit the wire format. */
export class GitHubGatewayProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubGatewayProtocolError'
  }
}

/**
 * The envelope for an error leaving the gateway. Every string in it is scrubbed as an error is,
 * by the exact token forms and `redactCredentials`'s patterns (worker/gateway-egress.ts): the
 * operation already did, and this is the last place anything could slip past it. No stack, no
 * `cause` and no Octokit `request` crosses.
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
    return { kind: 'error', name: 'Error', message: text(String(err)) }
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
  // Scrubbed as text, then read back: the patterns never break JSON's own syntax.
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
      return new GitHubGatewayProtocolError(
        `The GitHub gateway refused the request: ${envelope.message}`,
      )
    case 'unknown-job':
      return new UnknownFetchJobError(envelope.message)
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
