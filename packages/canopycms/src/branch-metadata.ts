import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchState, BranchStatus, CanopyGroupId, CanopyUserId } from './types'
import { BranchRegistry } from './branch-registry'

const BRANCH_META_DIR = '.canopycms'
const BRANCH_META_FILE = 'branch.json'

export interface BranchMetadataFile {
  schemaVersion: number
  branch: {
    name: string
    title?: string
    description?: string
    status: BranchStatus
    access: {
      allowedUsers?: CanopyUserId[]
      allowedGroups?: CanopyGroupId[]
      managerOrAdminAllowed?: boolean
    }
    createdBy: CanopyUserId // provenance only; not used for access control
    createdAt: string
    updatedAt: string
  }
  pullRequestUrl?: string
  pullRequestNumber?: number
}

const CURRENT_SCHEMA_VERSION = 1

export class BranchMetadata {
  private readonly branchRoot: string
  private readonly filePath: string
  private readonly registryDir: string

  private constructor(branchRoot: string, registryDir: string) {
    this.branchRoot = path.resolve(branchRoot)
    this.filePath = path.join(this.branchRoot, BRANCH_META_DIR, BRANCH_META_FILE)
    this.registryDir = registryDir
  }

  /**
   * Load branch metadata without requiring registryDir.
   * Use this for read-only access (e.g., in registry scanning or loadBranchState).
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
   * Get a BranchMetadata instance configured for registry invalidation.
   * Use this in API handlers to ensure registry cache is invalidated on updates.
   */
  static get(branchRoot: string, registryDir: string): BranchMetadata {
    return new BranchMetadata(branchRoot, registryDir)
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

    const defaults = {
      name: 'unknown',
      status: 'editing' as const,
      access: {},
      createdBy: 'unknown',
      createdAt: now,
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
        createdAt: existing?.branch.createdAt ?? defaults.createdAt,
        updatedAt: now,
      },
      pullRequestNumber: incoming.pullRequestNumber ?? existing?.pullRequestNumber,
      pullRequestUrl: incoming.pullRequestUrl ?? existing?.pullRequestUrl,
    }
    await this.write(merged)
    await this.invalidateRegistry()

    return merged
  }

  /**
   * Invalidates the registry cache so next list() call regenerates from branch.json files.
   */
  private async invalidateRegistry(): Promise<void> {
    const registry = new BranchRegistry(this.registryDir)
    await registry.invalidate()
  }

  static toBranchState(meta: BranchMetadataFile): BranchState {
    return {
      branch: {
        name: meta.branch.name,
        title: meta.branch.title,
        description: meta.branch.description,
        status: meta.branch.status,
        access: {
          allowedGroups: meta.branch.access.allowedGroups,
          allowedUsers: meta.branch.access.allowedUsers,
          managerOrAdminAllowed: meta.branch.access.managerOrAdminAllowed,
        },
        createdBy: meta.branch.createdBy,
        createdAt: meta.branch.createdAt,
        updatedAt: meta.branch.updatedAt,
      },
      pullRequestNumber: meta.pullRequestNumber,
      pullRequestUrl: meta.pullRequestUrl,
    }
  }
}

/**
 * Fields that can be set via save().
 * - createdBy: Only used on initial creation; ignored if metadata already exists
 * - createdAt/updatedAt: Managed automatically
 */
export interface BranchMetadataUpdate {
  branch?: Partial<Omit<BranchMetadataFile['branch'], 'createdAt' | 'updatedAt'>> & {
    createdBy?: CanopyUserId // Only used on initial creation
  }
  pullRequestUrl?: string
  pullRequestNumber?: number
}

/**
 * Get a BranchMetadata instance configured for registry invalidation.
 * Use this in API handlers to ensure registry cache is invalidated on updates.
 */
export const getBranchMetadata = (branchRoot: string, registryDir: string): BranchMetadata => {
  return BranchMetadata.get(branchRoot, registryDir)
}
