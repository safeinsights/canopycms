import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext, BranchMetadata, BranchStatus } from './types'
import { BranchRegistry } from './branch-registry'
import { resolveBranchPath } from './paths'
import { type OperatingMode } from './operating-mode'

const BRANCH_META_DIR = '.canopycms'
const BRANCH_META_FILE = 'branch.json'

export interface BranchMetadataFile {
  schemaVersion: number
  branch: BranchMetadata
}

const CURRENT_SCHEMA_VERSION = 1

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
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
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

  private async load(): Promise<BranchMetadataFile | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as BranchMetadataFile
      return parsed
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  private async write(meta: BranchMetadataFile): Promise<void> {
    const payload = {
      ...meta,
      schemaVersion: meta.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  }

  async save(incoming: BranchMetadataUpdate): Promise<BranchMetadataFile> {
    const existing = await this.load()
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
      branch: {
        ...defaults,
        ...existing?.branch,
        ...incoming.branch,
        access: {
          ...existing?.branch?.access,
          ...incoming.branch?.access,
        },
        // Immutable after creation
        createdBy: existing?.branch.createdBy ?? incoming.branch?.createdBy ?? defaults.createdBy,
        createdAt: existing?.branch.createdAt ?? defaults.createdAt
      },
    }
    await this.write(merged)
    await this.invalidateRegistry()

    return merged
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
  baseRoot: string
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
