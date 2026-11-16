/**
 * Reading `branch.json` — the file format, nothing else.
 *
 * Deliberately a LEAF, importing only node built-ins, zod, types, and the error
 * modules. That is what keeps `branch-registry.ts` (which reads every branch's
 * `branch.json`) out of a runtime import cycle with `branch-metadata.ts` (which
 * writes it and then invalidates the registry cache).
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import type { ContentId } from './paths/types'
import type {
  BranchAccessControl,
  BranchAccessExclusion,
  BranchAddBy,
  BranchMetadata,
  BranchStatus,
  ConflictStatus,
  PullRequestState,
  SyncStatus,
} from './types'
import { getErrorMessage, isNotFoundError } from './utils/error'
import { BranchMetadataCorruptError } from './branch-metadata-error'

export { BranchMetadataCorruptError }

export const BRANCH_META_DIR = '.canopy-meta'
export const BRANCH_META_FILE = 'branch.json'

export interface BranchMetadataFile {
  schemaVersion: number
  version: number
  writeId?: string
  branch: BranchMetadata
}

/** Absolute path to a branch workspace's `branch.json`. */
const branchMetadataFilePath = (branchRoot: string): string =>
  path.join(path.resolve(branchRoot), BRANCH_META_DIR, BRANCH_META_FILE)

/** The value a timestamp missing from a hand-written file reads as: honestly unknown, and stable. */
const UNKNOWN_TIME = new Date(0).toISOString()

/** A zod enum of every member of `T`: the mapped type refuses to compile if one is left out. */
const enumOf = <T extends string>(values: { [K in T]: K }) => z.nativeEnum(values)

/** One entry of `access.excluded` or `access.excludedGroups`. */
const exclusionSchema = z
  .object({ by: z.string(), at: z.string(), byAdmin: z.boolean() })
  .passthrough()

/** A branch's `access`, as {@link branchMetadataSchema} checks it. */
const branchAccessSchema = z
  .object({
    allowedUsers: z.array(z.string()).optional(),
    allowedGroups: z.array(z.string()).optional(),
    managerOrAdminAllowed: z.boolean().optional(),
    restricted: z.boolean().optional(),
    excluded: z.record(z.string(), exclusionSchema).optional(),
    excludedGroups: z.record(z.string(), exclusionSchema).optional(),
    addBy: enumOf<BranchAddBy>({
      members: 'members',
      owner: 'owner',
      admins: 'admins',
    }).optional(),
    entryMeta: z
      .record(z.string(), z.object({ addedBy: z.string(), addedAt: z.string() }).passthrough())
      .optional(),
  })
  .passthrough()

/**
 * `branch.json`'s shape, checked on every read.
 *
 * Strict where a guard or an access check reads the field: `status` (writes and
 * submits are gated on it), `name` (the protected-base-branch test compares it)
 * and `access` (required: a missing one would read as "no ACL" and widen
 * access). Lenient, with defaults, where a hand-written file can omit bookkeeping: the envelope's
 * `version` (0, as occ-json-write reads it) and `schemaVersion`, and
 * `createdBy` ('unknown', which matches no user, so the creator grant fails
 * closed) and the timestamps. Every optional field is type-checked.
 *
 * Unknown keys pass through, so a field a newer deployment writes survives an
 * older one's save. Code reads only the typed {@link BranchMetadataFile}.
 */
const branchMetadataShape = {
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  status: enumOf<BranchStatus>({
    editing: 'editing',
    submitted: 'submitted',
    approved: 'approved',
    archived: 'archived',
  }),
  access: branchAccessSchema,
  createdBy: z.string().default('unknown'),
  createdAt: z.string().default(UNKNOWN_TIME),
  updatedAt: z.string().default(UNKNOWN_TIME),
  baseBranch: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  pullRequestNumber: z.number().int().optional(),
  submittedAt: z.string().optional(),
  pushedToGitHubAt: z.string().optional(),
  editorUrl: z.string().optional(),
  syncStatus: enumOf<SyncStatus>({
    synced: 'synced',
    'pending-sync': 'pending-sync',
    'sync-failed': 'sync-failed',
  }).optional(),
  conflictStatus: enumOf<ConflictStatus>({
    clean: 'clean',
    'conflicts-detected': 'conflicts-detected',
  }).optional(),
  conflictFiles: z.array(z.custom<ContentId>((v) => typeof v === 'string')).optional(),
  pullRequestState: enumOf<PullRequestState>({
    open: 'open',
    closed: 'closed',
    merged: 'merged',
  }).optional(),
  mergedAt: z.string().optional(),
  archivedAt: z.string().optional(),
  rebaseFailure: z
    .object({ message: z.string(), firstAt: z.string(), lastAt: z.string() })
    .optional(),
  historyRewrittenFrom: z.string().optional(),
  historyRewrittenTo: z.string().optional(),
  lastGitHubTip: z.string().optional(),
  keptOverGitHub: z.array(z.string()).optional(),
  rewrittenOnGitHub: z.string().optional(),
  submitUnfinished: z.boolean().optional(),
  submitNotQueued: z.boolean().optional(),
  unpublishedAtMerge: z.boolean().optional(),
  syncFailureReason: z.string().optional(),
  editors: z.array(z.string()).optional(),
  uncommittedEditors: z.array(z.string()).optional(),
  // Dropped when malformed: it only decorates the branch card, so it never fails a read.
  pullRequestHold: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('conflicts') }),
      z.object({ kind: z.literal('retargeted'), base: z.string() }),
    ])
    .optional()
    .catch(undefined),
  // Dropped when malformed, never failing a read: it decorates the PR body, and without `commit`
  // the worker judges a move against the clone's head before it (worker/github-commits.ts).
  review: z
    .object({
      state: z.enum(['approved', 'changes-requested']),
      by: z.object({ userId: z.string(), name: z.string().optional() }),
      at: z.string(),
      commit: z.string().optional(),
    })
    .optional()
    .catch(undefined),
  baseUpdateRequestedAt: z.string().optional().catch(undefined),
  latestChangesWaiting: z.string().optional().catch(undefined),
  // Dropped when malformed: it only ends the editor's wait, which then times out instead.
  lastBaseUpdate: z
    .object({
      at: z.string(),
      outcome: z.enum(['merged', 'up-to-date', 'conflicts', 'failed']),
      baseSha: z.string().optional(),
      keptEntries: z.number().int().nonnegative().optional(),
    })
    .optional()
    .catch(undefined),
} satisfies { [K in keyof BranchMetadata]-?: z.ZodTypeAny }

/** The `branch` object, also embedded in the registry snapshot (branch-registry.ts). */
export const branchMetadataSchema = z.object(branchMetadataShape).passthrough()

const branchMetadataFileSchema = z
  .object({
    schemaVersion: z.number().int().default(1),
    version: z.number().int().nonnegative().default(0),
    writeId: z.string().optional(),
    branch: branchMetadataSchema,
  })
  .passthrough()

/** The schema failures, by field and without values, so no file content reaches a client. */
function describeSchemaIssues(issues: z.ZodIssue[]): string {
  const missing = new Set<string>()
  const invalid = new Set<string>()
  for (const issue of issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : 'the file'
    const isMissing =
      issue.code === z.ZodIssueCode.invalid_type && issue.received === z.ZodParsedType.undefined
    ;(isMissing ? missing : invalid).add(field)
  }
  const parts: string[] = []
  if (missing.size > 0) parts.push(`Missing: ${[...missing].join(', ')}`)
  if (invalid.size > 0) parts.push(`Invalid: ${[...invalid].join(', ')}`)
  return `Not branch metadata. ${parts.join('. ')}`
}

/**
 * Read, parse and validate `branch.json`, with no locking, no OCC and no side
 * effects. Callers distinguish three outcomes: `null` when the file does not
 * exist (an un-provisioned or non-branch directory),
 * `BranchMetadataCorruptError` on malformed JSON or a failed schema check, and
 * every other IO failure rethrown unchanged.
 */
export async function readBranchMetadataFile(
  branchRoot: string,
): Promise<BranchMetadataFile | null> {
  const resolvedRoot = path.resolve(branchRoot)
  let raw: string
  try {
    raw = await fs.readFile(branchMetadataFilePath(resolvedRoot), 'utf8')
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      return null
    }
    throw err
  }
  return parseBranchMetadataFile(resolvedRoot, raw)
}

/**
 * Parse and validate `branch.json` text already read from `branchRoot`.
 *
 * @throws BranchMetadataCorruptError when it is not JSON or fails the schema
 */
function parseBranchMetadataFile(branchRoot: string, raw: string): BranchMetadataFile {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err: unknown) {
    throw new BranchMetadataCorruptError(branchRoot, `Not valid JSON: ${getErrorMessage(err)}`)
  }
  const result = branchMetadataFileSchema.safeParse(json)
  if (!result.success) {
    throw new BranchMetadataCorruptError(branchRoot, describeSchemaIssues(result.error.issues))
  }
  const file: BranchMetadataFile = result.data
  return file
}

/** The fields that only ever narrow who may open a branch or change its list. */
type NarrowingAccess = Pick<
  BranchAccessControl,
  'managerOrAdminAllowed' | 'excluded' | 'excludedGroups' | 'addBy'
>

/** What a damaged `branch.json` still says about who may open the branch. */
export type SalvagedAccess =
  | { readable: true; access: BranchAccessControl }
  | {
      readable: false
      /**
       * The narrowing fields: each kept as it reads, a present one that doesn't read at its most
       * restrictive (a lockdown, `addBy: 'admins'`, a malformed removal entry as an admin's).
       */
      narrowing: NarrowingAccess
      /**
       * `access` was there but held, or may have held, a list or a lockdown that can't be
       * rebuilt: it isn't an object, it has `restricted`, `allowedUsers` or `allowedGroups`, or
       * its lockdown or `excluded` doesn't read.
       */
      mayRestrict: boolean
      /** The lockdown in `narrowing` stands in for one that didn't read. */
      lockdownUnreadable: boolean
      /**
       * Removals may have been lost: `access` isn't an object, or `excluded` or `excludedGroups`
       * isn't one. `narrowing` then has `addBy: 'admins'`, so no one but an admin re-adds anyone.
       */
      removalsUnreadable: boolean
    }

/** The fields repair writes besides `name`, `access` and the timestamps save() manages. */
type SalvagedFields = Partial<Omit<BranchMetadata, 'name' | 'access' | 'createdAt' | 'updatedAt'>>

interface SalvagedBranch {
  access: SalvagedAccess
  /**
   * Every other field the schema knows, each read on its own: a value that passes its own
   * schema as it is, and a present one that doesn't at {@link restrictiveValues} where it has one.
   * `createdBy` and `baseBranch` must also be non-empty.
   */
  fields: SalvagedFields
  /** The fields as they read, before any restrictive value: what repair kept. */
  read: SalvagedFields
  /** The keys the schema doesn't know, verbatim, as a read passes them through. */
  unknownFields: Record<string, unknown>
  /** `createdAt` as the file had it, when it reads. */
  createdAt?: string
  /** The keys present but unreadable, so given their restrictive value or left out. */
  unreadable: (keyof BranchMetadata)[]
}

/**
 * The value a present field that doesn't read takes, for the fields that hold something back:
 * - `status` `submitted` locks writes, and Withdraw recovers the branch. A missing status, or text
 *   that isn't JSON, takes it too: it is as unknown. A status unknown on a file with `archivedAt`
 *   or `mergedAt`, which only an archive writes, is `archived` instead, as nothing un-archives;
 * - `unpublishedAtMerge` true holds a delete for an admin. A status unknown beside a rewrite
 *   marker takes it too, even over a readable `false`, since the archived status that let the
 *   marker hold the delete may be lost;
 * - `rewrittenOnGitHub` naming no commit refuses pushes, and on an archived branch holds a delete
 *   for an admin. A sync clears it when GitHub has no branch of that name and no pull request is
 *   recorded, or, on a published branch, when GitHub's branch holds the clone's and `remote.git`'s
 *   heads or a commit recorded there, a marker that names one among them;
 * - `archivedAt` the repair time keeps deletion by age from counting from an older merge.
 *
 * Any other unreadable field is left out, as save()'s defaults leave it. Nothing that decides who
 * can open, edit or delete the branch widens. Review and merge rights can, in four cases: a
 * `submitUnfinished` left out no longer blocks Approve; a `syncStatus` left out no longer marks a
 * later merge as possibly unpublished; a `pullRequestState` left out, if `closed`, no longer
 * blocks Approve, Request changes and Mark merged; and an unknown status taken as `submitted` lets
 * reviewers Approve or Request changes on what may have been an editing branch. And the worker's
 * GitHub sync loses any record it can't read but the rewrite marker: an unreadable
 * `historyRewrittenFrom` or `lastGitHubTip` leaves it less to detect a new rewrite by, though a
 * standing marker stays until GitHub's branch holds all of this branch's; an unreadable
 * `keptOverGitHub` drops paths from the PR body; and a `syncStatus` left out no longer holds back,
 * as `sync-failed` did, a retried push or base update.
 */
const restrictiveValues = (now: string): SalvagedFields => ({
  status: 'submitted',
  unpublishedAtMerge: true,
  rewrittenOnGitHub: '',
  archivedAt: now,
})

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const has = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key)

const unreadable = Symbol('unreadable')

/** `value` through `schema`, or `unreadable` when it fails. */
function readField<T>(schema: z.ZodType<T>, value: unknown): T | typeof unreadable {
  const result = schema.safeParse(value)
  return result.success ? result.data : unreadable
}

const nonEmptyString = z.string().min(1).optional()

const {
  name: _name,
  access: _access,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...rest
} = branchMetadataShape
/** Each salvaged field's own schema; every one optional, so a field absent stays absent. */
const salvagedFieldShape = { ...rest, createdBy: nonEmptyString, baseBranch: nonEmptyString }
const salvagedFieldsSchema = z.object(salvagedFieldShape).partial().strip()
type SalvagedKey = keyof typeof salvagedFieldShape
const isSalvagedKey = (key: string): key is SalvagedKey => has(salvagedFieldShape, key)

/**
 * What `branch.json` text that fails {@link readBranchMetadataFile} still says, each field read
 * on its own key, so one bad field never takes another with it: a field that reads is kept, a
 * present one that doesn't takes its most restrictive value or is left out, and an absent one
 * stays absent. {@link restrictiveValues} says what that keeps from widening and what it doesn't.
 * `access` is readable only when it passes its schema whole. Keys the schema doesn't know are
 * carried over verbatim, as a read passes them through, so a restricting field a newer deployment
 * wrote survives. Text that is not JSON, or holds no `branch` object, salvages nothing.
 */
export function salvageBranchMetadata(raw: string, now: Date = new Date()): SalvagedBranch {
  const nothing: SalvagedBranch = {
    access: {
      readable: false,
      narrowing: {},
      mayRestrict: false,
      lockdownUnreadable: false,
      removalsUnreadable: false,
    },
    fields: { status: 'submitted' },
    read: {},
    unknownFields: {},
    unreadable: [],
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return nothing
  }
  if (!isPlainObject(json)) return nothing
  const branch = json.branch
  if (!isPlainObject(branch)) return nothing

  const restrictive = restrictiveValues(now.toISOString())
  const read: Record<string, unknown> = {}
  const unreadableKeys: (keyof BranchMetadata)[] = []
  for (const key of Object.keys(branch).filter(isSalvagedKey)) {
    const value = readField(salvagedFieldShape[key], branch[key])
    if (value !== unreadable && value !== undefined) read[key] = value
    else unreadableKeys.push(key)
  }
  // Every value was read through these same schemas, so these parses only give them their type.
  const kept = salvagedFieldsSchema.parse(read)
  const held: SalvagedFields = { ...kept }
  for (const key of unreadableKeys) {
    if (has(restrictive, key)) Object.assign(held, { [key]: restrictive[key as SalvagedKey] })
  }
  if (kept.status === undefined) {
    // Only an archive writes these times, and nothing un-archives a branch.
    held.status =
      has(branch, 'archivedAt') || has(branch, 'mergedAt') ? 'archived' : restrictive.status
    if (has(branch, 'rewrittenOnGitHub')) held.unpublishedAtMerge = true
  }

  const unknownFields = Object.fromEntries(
    Object.keys(branch)
      .filter((key) => key !== '__proto__' && !has(branchMetadataShape, key))
      .map((key) => [key, branch[key]]),
  )
  const createdAt = has(branch, 'createdAt')
    ? readField(branchMetadataShape.createdAt, branch.createdAt)
    : undefined
  if (createdAt === unreadable) unreadableKeys.push('createdAt')
  return {
    access: has(branch, 'access') ? salvageAccess(branch.access) : nothing.access,
    fields: salvagedFieldsSchema.parse(held),
    read: kept,
    unknownFields,
    ...(typeof createdAt === 'string' && { createdAt }),
    unreadable: unreadableKeys,
  }
}

/** Salvages a present `access`. */
function salvageAccess(rawAccess: unknown): SalvagedAccess {
  const whole = branchAccessSchema.safeParse(rawAccess)
  if (whole.success) return { readable: true, access: whole.data }
  if (!isPlainObject(rawAccess)) {
    return {
      readable: false,
      narrowing: { addBy: 'admins' },
      mayRestrict: true,
      lockdownUnreadable: false,
      removalsUnreadable: true,
    }
  }

  const { shape } = branchAccessSchema
  const lockdown = has(rawAccess, 'managerOrAdminAllowed')
    ? readField(shape.managerOrAdminAllowed, rawAccess.managerOrAdminAllowed)
    : undefined
  const addBy = has(rawAccess, 'addBy') ? readField(shape.addBy, rawAccess.addBy) : undefined
  const excluded = salvageExclusions(rawAccess, 'excluded')
  const excludedGroups = salvageExclusions(rawAccess, 'excludedGroups')
  const removalsUnreadable = excluded === unreadable || excludedGroups === unreadable
  return {
    readable: false,
    narrowing: {
      ...(lockdown !== undefined && {
        managerOrAdminAllowed: lockdown === unreadable ? true : lockdown,
      }),
      ...(addBy !== undefined && { addBy: addBy === unreadable ? 'admins' : addBy }),
      ...(removalsUnreadable && { addBy: 'admins' }),
      ...(excluded !== undefined && excluded !== unreadable && { excluded }),
      ...(excludedGroups !== undefined && excludedGroups !== unreadable && { excludedGroups }),
    },
    mayRestrict:
      ['restricted', 'allowedUsers', 'allowedGroups'].some((key) => has(rawAccess, key)) ||
      lockdown === unreadable ||
      removalsUnreadable,
    lockdownUnreadable: lockdown === unreadable,
    removalsUnreadable,
  }
}

/** Who a removal entry that can't be read is recorded as made by: no user. */
const UNKNOWN_EXCLUDER = 'unknown'

/**
 * `access[key]`'s removals entry by entry: a valid entry as it is, a malformed one as an admin's
 * made now by nobody known, so it still holds and only an admin lifts it. Unreadable when the
 * value isn't an object at all; undefined when absent.
 */
function salvageExclusions(
  rawAccess: Record<string, unknown>,
  key: 'excluded' | 'excludedGroups',
): Record<string, BranchAccessExclusion> | typeof unreadable | undefined {
  if (!has(rawAccess, key)) return undefined
  const raw = rawAccess[key]
  if (!isPlainObject(raw)) return unreadable
  const at = new Date().toISOString()
  const entries = Object.keys(raw)
    .filter((id) => id !== '__proto__')
    .map((id): [string, BranchAccessExclusion] => {
      const entry = exclusionSchema.safeParse(raw[id])
      return [id, entry.success ? entry.data : { by: UNKNOWN_EXCLUDER, at, byAdmin: true }]
    })
  return Object.fromEntries(entries)
}
