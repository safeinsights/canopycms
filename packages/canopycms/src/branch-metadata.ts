import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchState, BranchStatus, CanopyGroupId, CanopyUserId } from './types'

const BRANCH_META_DIR = '.canopycms'
const BRANCH_META_FILE = 'branch.json'
const REGISTRY_FILE = 'branches.json'
const REGISTRY_STALE_FILE = 'branches.stale.json'

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

export interface BranchMetadataOptions {
  branchRoot: string
  registryDir?: string
}

export class BranchMetadata {
  private readonly branchRoot: string
  private readonly filePath: string
  private readonly registryDir?: string

  constructor(branchRoot: string)
  constructor(options: BranchMetadataOptions)
  constructor(branchRootOrOptions: string | BranchMetadataOptions) {
    if (typeof branchRootOrOptions === 'string') {
      this.branchRoot = path.resolve(branchRootOrOptions)
      this.filePath = path.join(this.branchRoot, BRANCH_META_DIR, BRANCH_META_FILE)
    } else {
      this.branchRoot = path.resolve(branchRootOrOptions.branchRoot)
      this.filePath = path.join(this.branchRoot, BRANCH_META_DIR, BRANCH_META_FILE)
      this.registryDir = branchRootOrOptions.registryDir
    }
  }

  async load(): Promise<BranchMetadataFile | null> {
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

  async save(meta: BranchMetadataFile): Promise<void> {
    const payload = {
      ...meta,
      schemaVersion: meta.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  }

  async update(update: BranchMetadataUpdate): Promise<BranchMetadataFile> {
    const existing = (await this.load()) ?? null
    const merged: BranchMetadataFile = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      branch: {
        name: update.branch?.name ?? existing?.branch.name ?? 'unknown',
        title: update.branch?.title ?? existing?.branch.title,
        description: update.branch?.description ?? existing?.branch.description,
        status: update.branch?.status ?? existing?.branch.status ?? 'editing',
        access: {
          allowedUsers: update.branch?.access?.allowedUsers ?? existing?.branch.access.allowedUsers,
          allowedGroups:
            update.branch?.access?.allowedGroups ?? existing?.branch.access.allowedGroups,
          managerOrAdminAllowed:
            update.branch?.access?.managerOrAdminAllowed ??
            existing?.branch.access.managerOrAdminAllowed,
        },
        createdBy: update.branch?.createdBy ?? existing?.branch.createdBy ?? 'unknown',
        createdAt:
          update.branch?.createdAt ?? existing?.branch.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      pullRequestNumber: update.pullRequestNumber ?? existing?.pullRequestNumber,
      pullRequestUrl: update.pullRequestUrl ?? existing?.pullRequestUrl,
    }
    await this.save(merged)

    // Invalidate registry cache if registryDir provided
    if (this.registryDir) {
      await this.invalidateRegistry()
    }

    return merged
  }

  /**
   * Invalidates the registry cache by atomically renaming branches.json to branches.stale.json.
   * This causes the next registry.list() call to regenerate from branch.json files.
   */
  private async invalidateRegistry(): Promise<void> {
    if (!this.registryDir) return

    const registryPath = path.join(this.registryDir, BRANCH_META_DIR, REGISTRY_FILE)
    const stalePath = path.join(this.registryDir, BRANCH_META_DIR, REGISTRY_STALE_FILE)

    try {
      await fs.rename(registryPath, stalePath)
    } catch (err: any) {
      // ENOENT means already stale or never existed, which is fine
      if (err?.code !== 'ENOENT') {
        throw err
      }
    }
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

export interface BranchMetadataUpdate {
  branch?: Partial<BranchMetadataFile['branch']>
  pullRequestUrl?: string
  pullRequestNumber?: number
}

/**
 * Factory function to create a BranchMetadata instance with registry invalidation.
 * Use this in API handlers to ensure registry cache is invalidated on updates.
 */
export const createBranchMetadata = (branchRoot: string, registryDir?: string): BranchMetadata => {
  if (registryDir) {
    return new BranchMetadata({ branchRoot, registryDir })
  }
  return new BranchMetadata(branchRoot)
}
