import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext } from './types'
import { BranchMetadataFileManager } from './branch-metadata'

// Registry files are stored directly in the branches root (not in a subdirectory)
const REGISTRY_FILE = 'branches.json'
const REGISTRY_STALE_FILE = 'branches.stale.json'
const REGISTRY_TEMP_FILE = 'branches.tmp.json'
const REGISTRY_VERSION = 1

export interface BranchRegistrySnapshot {
  version: number
  branches: BranchContext[]
}

/**
 * BranchRegistry is a read-only cache for fast branch listing.
 * Individual branch.json files are the source of truth.
 *
 * Design:
 * - list() returns cached data if fresh, regenerates from branch.json files if stale
 * - invalidate() marks cache as stale (called when branch state changes)
 * - Concurrent regeneration is safe (all processes produce identical output)
 */
export class BranchRegistry {
  private readonly root: string
  private readonly registryPath: string
  private readonly stalePath: string
  private readonly tempPath: string

  constructor(root: string) {
    this.root = path.resolve(root)
    this.registryPath = path.join(this.root, REGISTRY_FILE)
    this.stalePath = path.join(this.root, REGISTRY_STALE_FILE)
    this.tempPath = path.join(this.root, REGISTRY_TEMP_FILE)
  }

  /**
   * Returns all branches. Uses cache if fresh, regenerates if stale.
   */
  async list(): Promise<BranchContext[]> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8')
      const parsed = JSON.parse(raw) as BranchRegistrySnapshot
      if (!parsed.version || !Array.isArray(parsed.branches)) {
        // Invalid cache, regenerate
        return await this.regenerate()
      }
      return parsed.branches
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // Cache missing or stale, regenerate
        return await this.regenerate()
      }
      throw err
    }
  }

  /**
   * Returns a single branch by name. Uses cache if available.
   */
  async get(name: string): Promise<BranchContext | undefined> {
    const branches = await this.list()
    return branches.find((b) => b.branch.name === name)
  }

  /**
   * Marks the cache as stale. Next list() call will regenerate.
   * Uses atomic rename for safety.
   */
  async invalidate(): Promise<void> {
    try {
      await fs.rename(this.registryPath, this.stalePath)
    } catch (err: any) {
      // ENOENT means already stale or never existed, which is fine
      if (err?.code !== 'ENOENT') {
        throw err
      }
    }
  }

  /**
   * Scans branch directories and rebuilds the cache.
   * Concurrent calls are safe - all produce identical content.
   */
  private async regenerate(): Promise<BranchContext[]> {
    const branches = await this.scanBranchDirectories()

    // Write to unique temp file first, then atomic rename
    // Use random suffix to avoid conflicts between concurrent regenerations
    const uniqueTempPath = `${this.tempPath}.${Date.now()}.${Math.random().toString(36).slice(2)}`
    await fs.mkdir(this.root, { recursive: true })
    const snapshot: BranchRegistrySnapshot = { version: REGISTRY_VERSION, branches }
    await fs.writeFile(uniqueTempPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')

    try {
      await fs.rename(uniqueTempPath, this.registryPath)
    } catch (err: any) {
      // Clean up temp file if rename fails
      await fs.unlink(uniqueTempPath).catch(() => {})
      throw err
    }

    // Clean up stale file (ignore errors)
    await fs.unlink(this.stalePath).catch(() => {})

    return branches
  }

  /**
   * Scans the root directory for branch subdirectories with valid branch.json files.
   */
  private async scanBranchDirectories(): Promise<BranchContext[]> {
    const branches: BranchContext[] = []

    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true })

      for (const entry of entries) {
        // Skip non-directories and hidden directories (like .canopy-meta, .canopy-prod-sim)
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        const branchRoot = path.join(this.root, entry.name)
        const meta = await BranchMetadataFileManager.loadOnly(branchRoot)

        if (meta) {
          branches.push({
            branch: meta.branch,
            branchRoot,
            baseRoot: this.root,
          })
        }
      }
    } catch (err: any) {
      // If root doesn't exist yet, return empty list
      if (err?.code === 'ENOENT') {
        return []
      }
      throw err
    }

    return branches
  }
}
