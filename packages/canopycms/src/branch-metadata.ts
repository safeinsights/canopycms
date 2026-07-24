import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext, BranchMetadata, BranchStatus } from './types'
import { BranchRegistry } from './branch-registry'
import { resolveBranchPath } from './paths'
import { type OperatingMode } from './operating-mode'
import { isNotFoundError } from './utils/error'
import { withLock } from './utils/async-mutex'
import {
  writeOccJsonFile,
  withOccRetry,
  withOccFileLock,
  OccWriteConflictError,
} from './utils/occ-json-write'

const BRANCH_META_DIR = '.canopy-meta'
const BRANCH_META_FILE = 'branch.json'

export interface BranchMetadataFile {
  schemaVersion: number
  version: number
  writeId?: string
  branch: BranchMetadata
}

const CURRENT_SCHEMA_VERSION = 1

export class BranchMetadataConflictError extends Error {
  constructor(message = 'Concurrent modification detected in branch metadata') {
    super(message)
    this.name = 'BranchMetadataConflictError'
  }
}

/**
 * Manages branch.json — branch status and access ACLs, both security-adjacent
 * state — under `.canopy-meta/` in a branch workspace.
 *
 * save() is protected by three layers, outermost to innermost (identical
 * structure to {@link CommentStore}'s withMutation, see comment-store.ts):
 *
 * 1. {@link withLock} - an in-process FIFO mutex keyed by the resolved file
 *    path. Serializes concurrent mutators on the SAME process/host
 *    deterministically.
 * 2. {@link withOccFileLock} - a server-enforced, cross-process/cross-host
 *    lock (proper-lockfile, mkdir-based). This is the actual fix for lost
 *    branch-status/ACL updates across two warm Lambda containers (or a
 *    Lambda + the EC2 worker) on EFS: rename-based OCC verification alone
 *    relies on a read-back that can be served from the writer's own local
 *    NFS dentry/attribute cache, so a foreign writer's rename can stay
 *    invisible for that cache's window (commonly 3-60s) and both writers
 *    conclude they won. A settle delay does not help — the cache window
 *    dwarfs any sleep worth paying — only server-enforced mutual exclusion
 *    does. Given branch.json carries status + ACLs, silently losing an
 *    update here is a correctness/security issue, not just a UX glitch.
 * 3. {@link withOccRetry} around {@link writeOccJsonFile} - version/writeId
 *    based optimistic concurrency control. With layers 1-2 in place this is
 *    now a defense-in-depth backstop only, not the primary safety mechanism.
 *
 * See `utils/occ-json-write.ts` for full guarantee documentation of layers 2-3.
 */
export class BranchMetadataFileManager {
  private readonly branchRoot: string
  private readonly filePath: string
  private readonly baseRoot: string
  private readonly settleMs: number | undefined

  private constructor(branchRoot: string, baseRoot: string, options?: { settleMs?: number }) {
    this.branchRoot = path.resolve(branchRoot)
    this.filePath = path.join(this.branchRoot, BRANCH_META_DIR, BRANCH_META_FILE)
    this.baseRoot = baseRoot
    this.settleMs = options?.settleMs
  }

  /**
   * Load branch metadata without requiring baseRoot.
   * Use this for read-only access (e.g., in registry scanning or loadBranchContext).
   */
  static async loadOnly(branchRoot: string): Promise<BranchMetadataFile | null> {
    const filePath = path.join(path.resolve(branchRoot), BRANCH_META_DIR, BRANCH_META_FILE)
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      return JSON.parse(raw) as BranchMetadataFile
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return null
      }
      throw err
    }
  }

  /**
   * Get a BranchMetadataFileManager instance configured for registry invalidation.
   * Use this in API handlers to ensure registry cache is invalidated on updates.
   */
  static get(
    branchRoot: string,
    baseRoot: string,
    options?: { settleMs?: number },
  ): BranchMetadataFileManager {
    return new BranchMetadataFileManager(branchRoot, baseRoot, options)
  }

  private async load(): Promise<{ meta: BranchMetadataFile | null; version: number | null }> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as BranchMetadataFile
      const version = parsed.version ?? 0
      return { meta: parsed, version }
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return { meta: null, version: null }
      }
      throw err
    }
  }

  /**
   * Write branch.json via the shared OCC helper, with the schemaVersion
   * default applied here (payload shaping stays branch-metadata's concern).
   *
   * Throws the helper's raw {@link OccWriteConflictError} so the surrounding
   * {@link withOccRetry} in save() recognizes and retries it; translation to
   * the public `BranchMetadataConflictError` contract happens at the save()
   * boundary, after retries are exhausted (translating earlier would make
   * withOccRetry's default predicate miss it, since it only recognizes the
   * raw error type).
   *
   * branch-metadata historically writes WITH a trailing newline, unlike
   * comment-store; `trailingNewline: true` preserves that.
   */
  private async write(
    meta: BranchMetadataFile,
    expectedVersion: number | null,
  ): Promise<{ version: number; writeId: string }> {
    const payload = {
      ...meta,
      schemaVersion: meta.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    }
    return writeOccJsonFile(this.filePath, payload, {
      expectedVersion,
      settleMs: this.settleMs,
      trailingNewline: true,
    })
  }

  /**
   * Run a save cycle under the full lock + OCC-retry stack described in the
   * class doc comment. A conflict that survives every retry surfaces as the
   * public `BranchMetadataConflictError`.
   *
   * Guards against a phantom-resurrection race with branch deletion: a
   * caller's branchContext can be resolved BEFORE a concurrent
   * deleteBranchHandler removes the branch directory, but this save() call
   * only reaches here (and its own mkdir({recursive:true}) inside write())
   * AFTER the removal. Without this check, that mkdir would silently
   * recreate `.canopy-meta/` (and this save would recreate branch.json from
   * defaults) inside a directory tree that no longer exists anywhere else --
   * a registry entry with no clone behind it. Checking BEFORE the lock stack
   * (rather than after) fails fast without paying for a lock acquisition on
   * a doomed save.
   *
   * Residual window (accepted): a save that passes this check can still
   * race a `rm` that starts moments later and is still mid-flight when this
   * save's write lands, resurrecting the tree. Closing that fully would
   * need a tombstone OUTSIDE the tree being removed -- the lockfile
   * (`withOccFileLock`) this save takes next lives INSIDE `branchRoot`, so
   * it cannot itself provide a wider guarantee than "the directory existed
   * a moment ago."
   */
  async save(incoming: BranchMetadataUpdate): Promise<BranchMetadataFile> {
    try {
      await fs.stat(this.branchRoot)
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        throw new BranchMetadataConflictError('Branch no longer exists')
      }
      throw err
    }

    let saved: BranchMetadataFile
    try {
      saved = await withLock(this.filePath, () =>
        withOccFileLock(this.filePath, () =>
          withOccRetry(async () => {
            const { meta: existing, version } = await this.load()
            const now = new Date().toISOString()

            const defaults: BranchMetadata = {
              name: 'unknown',
              status: 'editing' as BranchStatus,
              access: {},
              createdBy: 'unknown',
              createdAt: now,
              updatedAt: now,
            }

            const merged: BranchMetadataFile = {
              schemaVersion: CURRENT_SCHEMA_VERSION,
              version: version ?? 0,
              branch: {
                ...defaults,
                ...existing?.branch,
                ...incoming.branch,
                access: {
                  ...existing?.branch?.access,
                  ...incoming.branch?.access,
                },
                // Immutable after creation
                createdBy:
                  existing?.branch.createdBy ?? incoming.branch?.createdBy ?? defaults.createdBy,
                createdAt: existing?.branch.createdAt ?? defaults.createdAt,
                // Fork point is recorded once at creation; later saves must not move it
                baseBranch: existing?.branch.baseBranch ?? incoming.branch?.baseBranch,
              },
            }
            const written = await this.write(merged, version)
            merged.version = written.version
            merged.writeId = written.writeId
            return merged
          }),
        ),
      )
    } catch (err) {
      if (err instanceof OccWriteConflictError) {
        throw new BranchMetadataConflictError()
      }
      throw err
    }
    // Registry invalidation AFTER releasing the lockfile: the protocol only
    // requires the bump to land strictly after the branch.json write (it
    // does), and the registry's eager regeneration is O(branch count) fs
    // reads on EFS — holding the server-enforced lock through it would
    // extend every save's critical section for no correctness gain.
    await this.invalidateRegistry()
    return saved
  }

  /**
   * Invalidates the registry cache so next list() call regenerates from branch.json files.
   */
  private async invalidateRegistry(): Promise<void> {
    const registry = new BranchRegistry(this.baseRoot)
    await registry.invalidate()
  }
}

/**
 * Fields that can be set via save().
 * - createdBy: Only used on initial creation; ignored if metadata already exists
 * - createdAt/updatedAt: Managed automatically
 */
export interface BranchMetadataUpdate {
  branch?: Partial<Omit<BranchMetadata, 'createdAt' | 'updatedAt'>>
}

/**
 * Build the metadata update for archiving a branch because its PR merged.
 * Shared by the worker's merge-poll (CmsWorker.pollMergeState) and the
 * manual markAsMerged API (api/branch-merge.ts) so both paths produce
 * identical archived-branch metadata.
 *
 * Deliberately omits pullRequestNumber/pullRequestUrl: save()'s merge keeps
 * whatever the existing metadata already has for fields not present in the
 * incoming update, so the PR number/URL recorded earlier survive untouched.
 */
export function buildMergedBranchUpdate(
  branchName: string,
  now: Date = new Date(),
): NonNullable<BranchMetadataUpdate['branch']> {
  return {
    name: branchName,
    status: 'archived',
    pullRequestState: 'merged',
    mergedAt: now.toISOString(),
  }
}

/**
 * Get a BranchMetadataFileManager instance configured for registry invalidation.
 * Use this in API handlers to ensure registry cache is invalidated on updates.
 */
export const getBranchMetadataFileManager = (
  branchRoot: string,
  baseRoot: string,
  options?: { settleMs?: number },
): BranchMetadataFileManager => {
  return BranchMetadataFileManager.get(branchRoot, baseRoot, options)
}

/**
 * Load branch context from metadata file (source of truth).
 * Returns null if the branch doesn't exist.
 */
export const loadBranchContext = async (options: {
  branchName: string
  mode: OperatingMode
  basePathOverride?: string
}): Promise<BranchContext | null> => {
  const { branchRoot, baseRoot } = resolveBranchPath({
    branchName: options.branchName,
    mode: options.mode,
    basePathOverride: options.basePathOverride,
  })

  const meta = await BranchMetadataFileManager.loadOnly(branchRoot)
  if (!meta) {
    return null
  }

  return {
    branch: meta.branch,
    branchRoot,
    baseRoot,
  }
}
