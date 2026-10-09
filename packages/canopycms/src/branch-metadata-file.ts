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

/**
 * `branch.json`'s shape, checked on every read.
 *
 * Strict where a guard or an access check reads the field: `status` (writes and
 * submits are gated on it), `name` (the protected-base-branch test compares it)
 * and `access` (an absent ACL would read as "no ACL", widening access). Lenient,
 * with defaults, where a hand-written file can omit bookkeeping: the envelope's
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
  access: z
    .object({
      allowedUsers: z.array(z.string()).optional(),
      allowedGroups: z.array(z.string()).optional(),
      managerOrAdminAllowed: z.boolean().optional(),
    })
    .passthrough(),
  createdBy: z.string().default('unknown'),
  createdAt: z.string().default(UNKNOWN_TIME),
  updatedAt: z.string().default(UNKNOWN_TIME),
  baseBranch: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  pullRequestNumber: z.number().int().optional(),
  submittedAt: z.string().optional(),
  pushedToGitHubAt: z.string().optional(),
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
  rebaseFailure: z
    .object({ message: z.string(), firstAt: z.string(), lastAt: z.string() })
    .optional(),
  historyRewrittenFrom: z.string().optional(),
  syncFailureReason: z.string().optional(),
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
