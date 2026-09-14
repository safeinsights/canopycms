import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext } from './types'
// The leaf, NOT './branch-metadata': that module imports this one back, so the
// pair would be a runtime import cycle. See branch-metadata-file.ts.
import { readBranchMetadataFile } from './branch-metadata-file'
import { isNotFoundError, getErrorMessage } from './utils/error'
import { createDebugLogger } from './utils/debug'
// canopyLogWarn, not console.warn: registry regeneration is reached from every
// worker `meta.save()`, so this line lands in worker.log, where an unprefixed
// line is folded into the previous CloudWatch event. See utils/logger.ts.
import { canopyLogWarn } from './utils/logger'
import {
  bumpResourceGeneration,
  readResourceGeneration,
  isGenerationCurrent,
} from './resource-generation'

const log = createDebugLogger({ prefix: 'BranchRegistry' })

// Registry files are stored directly in the branches root (not in a subdirectory)
const REGISTRY_FILE = 'branches.json'
// Retired stale-marker file, never written. Named only so regenerate() can
// delete one a mid-flight deploy left behind.
const REGISTRY_STALE_FILE = 'branches.stale.json'
const REGISTRY_TEMP_FILE = 'branches.tmp.json'
const REGISTRY_VERSION = 2

/** resource-generation.ts resource key for the branch registry's marker. */
const RESOURCE = 'branch-registry'

/** Throttle for the get() suspicious-miss backstop; mirrors content-store's FORCED_REFRESH_MIN_INTERVAL_MS. */
const GET_MISS_REFRESH_MIN_INTERVAL_MS = 5000

export interface BranchRegistrySnapshot {
  version: number
  branches: BranchContext[]
  /**
   * The marker token this snapshot was built against, or null when it was built
   * before any bump on this root. Compared against the live marker (via
   * isGenerationCurrent) to decide freshness.
   */
  generation: string | null
}

/**
 * A read-only `branches.json` cache for fast branch listing; the individual
 * branch.json files are the source of truth.
 *
 * Freshness follows the generation-marker protocol owned by
 * resource-generation.ts. This is that protocol's durable-snapshot consumer, so
 * it carries both mitigations: invalidate() eager-regenerates on the mutating
 * host right after its own bump, and get() has a throttled suspicious-miss
 * backstop bounding how long a bad snapshot can hide a real branch.
 *
 * Concurrent regeneration within one process is deduped to a single scan
 * (regenInFlight); across processes it needs no coordination, since every
 * process produces identical output from the same branch.json files.
 */
export class BranchRegistry {
  private readonly root: string
  private readonly registryPath: string
  private readonly stalePath: string
  private readonly tempPath: string

  /** Shared in-flight scan so concurrent list()/get() callers on one instance await a single regeneration. */
  private regenInFlight: Promise<BranchContext[]> | null = null

  /** Throttle clock for the get() suspicious-miss backstop. */
  private lastForcedRefreshMs = 0

  constructor(root: string) {
    this.root = path.resolve(root)
    this.registryPath = path.join(this.root, REGISTRY_FILE)
    this.stalePath = path.join(this.root, REGISTRY_STALE_FILE)
    this.tempPath = path.join(this.root, REGISTRY_TEMP_FILE)
  }

  /**
   * Returns all branches. Uses the cached snapshot if its embedded generation
   * token matches the live marker, regenerates otherwise.
   */
  async list(): Promise<BranchContext[]> {
    let parsed: BranchRegistrySnapshot
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8')
      parsed = JSON.parse(raw) as BranchRegistrySnapshot
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return await this.regenerate()
      }
      throw err
    }

    // Strict version check, not truthiness: a snapshot from an older version
    // left on EFS by a rolling deploy has no `generation` field, and an
    // `undefined` token breaks the freshness comparison below.
    if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.branches)) {
      return await this.regenerate()
    }

    const read = await readResourceGeneration(this.root, RESOURCE)
    if (isGenerationCurrent(parsed.generation, read)) {
      return parsed.branches
    }
    return await this.regenerate()
  }

  /**
   * Returns a single branch by name, from the cached snapshot when it is fresh.
   *
   * Suspicious-miss backstop: a `name` missing from the list is the signal that
   * the snapshot may predate a branch that now exists, so force one fresh
   * regeneration and re-search before giving up. Throttled per instance, so a
   * genuinely-absent branch costs at most one extra scan per window.
   */
  async get(name: string): Promise<BranchContext | undefined> {
    const branches = await this.list()
    const found = branches.find((b) => b.branch.name === name)
    if (found) return found

    if (!this.shouldForceRefresh()) return undefined

    const refreshed = await this.regenerate()
    return refreshed.find((b) => b.branch.name === name)
  }

  private shouldForceRefresh(): boolean {
    const now = Date.now()
    if (now - this.lastForcedRefreshMs < GET_MISS_REFRESH_MIN_INTERVAL_MS) return false
    this.lastForcedRefreshMs = now
    return true
  }

  /**
   * Marks the cache stale for every process sharing this root by bumping the
   * marker, then eager-regenerates on this host. The bump must succeed —
   * swallowing that failure leaves the registry stale indefinitely with no
   * backstop. A failed eager regen must NOT fail the caller's save/delete: the
   * bump alone already restored correctness for every future reader.
   */
  async invalidate(): Promise<void> {
    await bumpResourceGeneration(this.root, RESOURCE, { mustSucceed: true })

    try {
      // A scan already in flight captured the PRE-bump token and possibly
      // pre-mutation state; joining it via regenerate()'s dedup would skip the
      // eager post-bump scan this method exists for. Let it drain — its
      // snapshot self-describes as stale either way — then scan fresh.
      if (this.regenInFlight) await this.regenInFlight.catch(() => {})
      await this.regenerate()
    } catch (err: unknown) {
      log.warn('invalidate', 'Eager regeneration after invalidate() failed', {
        error: getErrorMessage(err),
      })
    }
  }

  /**
   * Scans branch directories and rebuilds the cache, deduping concurrent
   * callers on this instance to a single underlying scan. Never loops waiting
   * for the embedded token to match the marker — that livelocks under a bump
   * storm; a caller wanting the very latest state calls list() again.
   */
  private async regenerate(): Promise<BranchContext[]> {
    if (this.regenInFlight) return this.regenInFlight

    const run = this.performRegenerate()
    this.regenInFlight = run
    try {
      return await run
    } finally {
      this.regenInFlight = null
    }
  }

  private async performRegenerate(): Promise<BranchContext[]> {
    // Capture the marker strictly BEFORE scanning: a bump landing mid-scan
    // then differs from the token recorded below, forcing a rebuild on the
    // next probe instead of silently resurrecting stale data.
    const read = await readResourceGeneration(this.root, RESOURCE)
    const branches = await this.scanBranchDirectories()

    // Opportunistic cleanup of the retired stale-marker file. Not load-bearing.
    await fs.unlink(this.stalePath).catch(() => {})

    if (!read.ok) {
      // The marker read failed for a reason other than "never bumped", so no
      // token can be attributed to this scan, and a snapshot stamped with an
      // unattributable one would look correctly attributed to every future
      // reader on any host. Serve the fresh scan without persisting it.
      return branches
    }

    const snapshot: BranchRegistrySnapshot = {
      version: REGISTRY_VERSION,
      branches,
      generation: read.token,
    }

    // Temp file then atomic rename; the random suffix keeps concurrent
    // regenerations off each other's temp path.
    const uniqueTempPath = `${this.tempPath}.${Date.now()}.${Math.random().toString(36).slice(2)}`
    await fs.mkdir(this.root, { recursive: true })
    await fs.writeFile(uniqueTempPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')

    try {
      await fs.rename(uniqueTempPath, this.registryPath)
    } catch (err: unknown) {
      await fs.unlink(uniqueTempPath).catch(() => {})
      throw err
    }

    return branches
  }

  /**
   * Scans the root directory for branch subdirectories with valid branch.json files.
   * Protected (rather than exported as a test hook) so tests can subclass and
   * override to simulate cross-process interleavings.
   */
  protected async scanBranchDirectories(): Promise<BranchContext[]> {
    const branches: BranchContext[] = []

    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true })

      for (const entry of entries) {
        // Skip non-directories and hidden directories (like .canopy-meta)
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        const branchRoot = path.join(this.root, entry.name)

        // Quarantine, don't propagate: one branch's corrupt or unreadable
        // branch.json must not take down the whole listing, which a rethrow
        // would (500 on GET /branches, for every branch). The broken branch
        // drops out of the registry and stays on disk for branch-health.
        let meta: Awaited<ReturnType<typeof readBranchMetadataFile>>
        try {
          meta = await readBranchMetadataFile(branchRoot)
        } catch (err: unknown) {
          canopyLogWarn(
            `CanopyCMS: Skipping branch directory '${entry.name}' during registry scan: ${getErrorMessage(err)}`,
          )
          continue
        }

        if (meta) {
          branches.push({
            branch: meta.branch,
            branchRoot,
            baseRoot: this.root,
          })
        }
      }
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return []
      }
      throw err
    }

    return branches
  }
}
