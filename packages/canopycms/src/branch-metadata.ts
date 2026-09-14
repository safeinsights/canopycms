import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext, BranchMetadata, BranchStatus } from './types'
import { BranchRegistry } from './branch-registry'
import {
  BRANCH_META_DIR,
  BRANCH_META_FILE,
  BranchMetadataCorruptError,
  readBranchMetadataFile,
  type BranchMetadataFile,
} from './branch-metadata-file'
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

// The file format lives in the leaf so branch-registry.ts can read branch.json
// without importing this module, which imports it back. Re-exported here so
// importers of these names do not have to move.
export { BranchMetadataCorruptError, type BranchMetadataFile }

const CURRENT_SCHEMA_VERSION = 1

/** @internal Exported for tests. */
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
 * save() runs under the same three-layer stack as {@link CommentStore}'s
 * withMutation — see comment-store.ts, and `utils/occ-json-write.ts` for the
 * guarantees of layers 2-3.
 *
 * Layer 2's server-enforced lock is the load-bearing one here. Rename-based OCC
 * alone verifies by a read-back that can come from the writer's own NFS
 * attribute cache, so for that cache's window (docs/concurrency.md) a foreign
 * writer's rename stays invisible and both writers conclude they won; no settle
 * delay closes it, since the window dwarfs any sleep worth paying. And because
 * branch.json carries status and ACLs, a silently lost update is a
 * correctness/security issue, not a UX glitch.
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

  /** Read-only load, needing no baseRoot: registry scanning, loadBranchContext. */
  static async loadOnly(branchRoot: string): Promise<BranchMetadataFile | null> {
    return readBranchMetadataFile(branchRoot)
  }

  /**
   * An instance wired for registry invalidation. API handlers use this, so the
   * registry cache is invalidated on update.
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
   * Write branch.json via the shared OCC helper, applying the schemaVersion
   * default here since payload shaping is branch-metadata's concern.
   *
   * Throws the helper's raw {@link OccWriteConflictError}, which is what the
   * surrounding {@link withOccRetry} in save() recognizes and retries;
   * translating to the public `BranchMetadataConflictError` earlier than the
   * save() boundary would make withOccRetry's predicate miss it.
   *
   * branch.json is written WITH a trailing newline (`trailingNewline: true`),
   * unlike comments.json.
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
   * Run a save cycle under the full lock + OCC-retry stack (class doc). A
   * conflict surviving every retry surfaces as `BranchMetadataConflictError`.
   *
   * The stat guards a phantom-resurrection race with branch deletion: a
   * caller's branchContext can resolve BEFORE a concurrent deleteBranchHandler
   * removes the branch directory, while the save reaches here after it, and
   * write()'s `mkdir({recursive:true})` would then recreate `.canopy-meta/` and
   * branch.json from defaults inside a tree nothing else refers to — a registry
   * entry with no clone behind it. It runs BEFORE the lock stack so a doomed
   * save fails fast instead of paying for a lock.
   *
   * Accepted residual window: a save that passes the check can still race a
   * `rm` that starts moments later and is mid-flight when the write lands.
   * Closing that needs a tombstone OUTSIDE the tree being removed, and the
   * lockfile taken next lives INSIDE `branchRoot`, so it can promise no more
   * than "the directory existed a moment ago".
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
                // Always stamped fresh; the spreads above would otherwise let
                // the creation-time value win forever, freezing the timestamp
                // the editor's Branches panel sorts and displays by
                updatedAt: now,
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
    // Registry invalidation AFTER releasing the lockfile. The protocol only
    // requires the bump to land strictly after the branch.json write, which it
    // does, and the registry's eager regeneration is O(branch count) fs reads
    // on EFS — holding the lock through it would stretch every save's critical
    // section for no correctness gain.
    await this.invalidateRegistry()
    return saved
  }

  /** Invalidate the registry cache so the next list() regenerates. */
  private async invalidateRegistry(): Promise<void> {
    const registry = new BranchRegistry(this.baseRoot)
    await registry.invalidate()
  }
}

/**
 * Fields save() accepts. `createdBy` applies on creation only and is ignored
 * once metadata exists; createdAt/updatedAt are managed here, not by callers.
 */
export interface BranchMetadataUpdate {
  branch?: Partial<Omit<BranchMetadata, 'createdAt' | 'updatedAt'>>
}

/**
 * The metadata update for archiving a branch whose PR merged. Shared by the
 * worker's merge-poll (CmsWorker.pollMergeState) and the manual markAsMerged
 * API (api/branch-merge.ts), so both produce identical metadata.
 *
 * Deliberately omits pullRequestNumber/pullRequestUrl: save() keeps existing
 * values for fields the incoming update omits, so the recorded PR number and
 * URL survive untouched.
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

/** {@link BranchMetadataFileManager.get} as a function. */
export const getBranchMetadataFileManager = (
  branchRoot: string,
  baseRoot: string,
  options?: { settleMs?: number },
): BranchMetadataFileManager => {
  return BranchMetadataFileManager.get(branchRoot, baseRoot, options)
}

/** Branch context from the metadata file, the source of truth. Null if absent. */
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
