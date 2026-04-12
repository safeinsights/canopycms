import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext, BranchMetadata, BranchStatus } from './types'
import { BranchRegistry } from './branch-registry'
import { resolveBranchPath } from './paths'
import { type OperatingMode } from './operating-mode'
import { isFileExistsError, isNotFoundError } from './utils/error'
import { withLock } from './utils/async-mutex'

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
  constructor() {
    super('Concurrent modification detected in branch metadata')
    this.name = 'BranchMetadataConflictError'
  }
}

export class BranchMetadataFileManager {
  private readonly branchRoot: string
  private readonly filePath: string
  private readonly baseRoot: string

  private constructor(branchRoot: string, baseRoot: string) {
    this.branchRoot = path.resolve(branchRoot)
    this.filePath = path.join(this.branchRoot, BRANCH_META_DIR, BRANCH_META_FILE)
    this.baseRoot = baseRoot
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
  static get(branchRoot: string, baseRoot: string): BranchMetadataFileManager {
    return new BranchMetadataFileManager(branchRoot, baseRoot)
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
   * Atomic write using temp-file + rename + post-write verification.
   * Follows the same pattern as CommentStore for EFS/NFS safety.
   */
  private async write(
    meta: BranchMetadataFile,
    expectedVersion: number | null,
  ): Promise<{ version: number; writeId: string }> {
    const newVersion = expectedVersion === null ? 1 : expectedVersion + 1
    const writeId = randomUUID()
    const payload = {
      ...meta,
      schemaVersion: meta.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      version: newVersion,
      writeId,
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true })

    const content = JSON.stringify(payload, null, 2) + '\n'

    if (expectedVersion === null) {
      // New file: use temp-file + rename for atomicity, then link(target) to detect EEXIST races.
      // Plain writeFile({flag:'wx'}) is not atomic — a crash mid-write leaves a partial file
      // that makes JSON.parse fail on next startup, permanently breaking the branch.
      const tempPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      await fs.writeFile(tempPath, content, 'utf-8')
      try {
        // link() is atomic and fails with EEXIST if the target already exists,
        // giving us the same exclusive-create semantics as wx without the atomicity risk.
        await fs.link(tempPath, this.filePath)
      } catch (err: unknown) {
        await fs.unlink(tempPath).catch(() => {})
        if (isFileExistsError(err)) {
          throw new BranchMetadataConflictError()
        }
        throw err
      }
      await fs.unlink(tempPath).catch(() => {})
      return { version: newVersion, writeId }
    }

    // Existing file: temp write + atomic rename + verification
    const tempPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')

    try {
      // Fast-fail optimization: check version before rename to avoid unnecessary
      // rename + verify cycle. Not a correctness guarantee — the post-write
      // writeId verification below is what actually detects cross-process races.
      let currentVersion: number | null = null
      try {
        const current = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as {
          version?: number
        }
        currentVersion = current.version ?? 0
      } catch {
        currentVersion = null
      }

      if (currentVersion !== expectedVersion) {
        throw new BranchMetadataConflictError()
      }

      // Atomic rename
      await fs.rename(tempPath, this.filePath)

      // Post-write verification: confirm our write landed (catches cross-process races)
      const afterWrite = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as {
        writeId?: string
      }
      if (afterWrite.writeId !== writeId) {
        throw new BranchMetadataConflictError()
      }
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {})
      throw err
    }

    return { version: newVersion, writeId }
  }

  private async withRetry<T>(operation: () => Promise<T>, maxAttempts = 5): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation()
      } catch (err) {
        if (err instanceof BranchMetadataConflictError && attempt < maxAttempts) {
          const baseDelay = Math.min(10 * Math.pow(2, attempt - 1), 100)
          const jitter = Math.random() * baseDelay
          await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter))
          continue
        }
        throw err
      }
    }
    throw new Error('Unreachable')
  }

  async save(incoming: BranchMetadataUpdate): Promise<BranchMetadataFile> {
    return withLock(this.filePath, () =>
      this.withRetry(async () => {
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
          },
        }
        const written = await this.write(merged, version)
        merged.version = written.version
        merged.writeId = written.writeId
        await this.invalidateRegistry()
        return merged
      }),
    )
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
 * Get a BranchMetadataFileManager instance configured for registry invalidation.
 * Use this in API handlers to ensure registry cache is invalidated on updates.
 */
export const getBranchMetadataFileManager = (
  branchRoot: string,
  baseRoot: string,
): BranchMetadataFileManager => {
  return BranchMetadataFileManager.get(branchRoot, baseRoot)
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
