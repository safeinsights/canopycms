import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchContext } from './types'
import { BranchMetadataFileManager } from './branch-metadata'
import { isNotFoundError, getErrorMessage } from './utils/error'
import { createDebugLogger } from './utils/debug'
import {
  bumpResourceGeneration,
  readResourceGeneration,
  isGenerationCurrent,
} from './resource-generation'

const log = createDebugLogger({ prefix: 'BranchRegistry' })

// Registry files are stored directly in the branches root (not in a subdirectory)
const REGISTRY_FILE = 'branches.json'
// Legacy rename-based invalidation scheme's stale marker file. No longer written -
// invalidate() now bumps the cross-process generation marker instead - but a
// process upgraded mid-flight may find one left over from before the deploy, so
// regenerate() opportunistically deletes it. Keep this name only for that cleanup.
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
   * The resource-generation.ts marker token this snapshot was built against, or
   * null if it was built before any bump ever occurred on this root. Compared
   * against the live marker (via isGenerationCurrent) to decide freshness.
   */
  generation: string | null
}

/**
 * BranchRegistry is a read-only cache for fast branch listing.
 * Individual branch.json files are the source of truth.
 *
 * ## Cross-process freshness (resource-generation.ts marker protocol)
 *
 * Several warm Lambda containers plus the EC2 worker can share one branch-clone
 * root over EFS, each with its own in-process cache of `branches.json`. There is
 * no shared memory and no cross-host file watching, so freshness is coordinated
 * via the generic on-disk generation marker in resource-generation.ts: every
 * snapshot embeds the marker token it was built against, and every read
 * cheaply re-checks the live marker before trusting the cached snapshot. See
 * that module's doc comment for the full protocol and residual staleness
 * windows (A/B/C/E).
 *
 * BranchRegistry is exactly the "durable snapshot consumer" case called out
 * there: a regeneration whose scan is served from stale NFS dentry/attribute
 * caches can record a FRESH token over STALE data (window E), and because the
 * result is written to `branches.json`, that staleness becomes durable and
 * shared with every other host that reads the marker - not just one process's
 * memory. Two mitigations close the practical gap:
 *
 * - invalidate() eager-regenerates immediately after its own bump. The
 *   mutating host's own scan is necessarily coherent with the mutation it just
 *   made (no NFS round trip was needed to observe its own write), so this
 *   closes window (E) for the common case without waiting for some other host
 *   to lazily pull the change.
 * - get() implements a suspicious-miss backstop: a branch that "should" exist
 *   but is absent from the cached snapshot forces one fresh regeneration
 *   (throttled), bounding how long a bad snapshot can hide a real branch.
 *
 * regenerate() also skips persisting a snapshot when the marker read itself
 * fails (`{ ok: false }`, e.g. unreadable for a non-ENOENT reason): a snapshot
 * embedding a token we cannot attribute to "matches this scan" would be
 * indistinguishable from a correctly-attributed one to every future reader, so
 * the safer behavior is to serve the fresh scan without writing it durably and
 * let the next read retry the marker.
 *
 * Design:
 * - list() returns the cached snapshot if its embedded generation token still
 *   matches the live marker, regenerates from branch.json files otherwise
 * - invalidate() bumps the marker (durable, cross-process) and eager-regenerates
 * - Concurrent regeneration within one process is deduped to a single scan
 *   (regenInFlight); across processes, regeneration is still safe since all
 *   processes produce identical output from the same branch.json files
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

    // Strict version check: a truthy-only check would accept a persisted v1
    // snapshot (no `generation` field) left on EFS after a rolling deploy,
    // and `parsed.generation` would then be `undefined` rather than a real
    // token or explicit `null`, breaking the freshness comparison below.
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
   * Returns a single branch by name. Uses cache if available.
   *
   * Suspicious-miss backstop: if `name` isn't in the (possibly cached) list,
   * that's a signal the snapshot may be stale in the specific direction where
   * a branch that now exists is missing from it - force one fresh
   * regeneration and re-search before giving up, throttled per instance so a
   * genuinely-absent branch costs at most one extra scan per throttle window.
   * This bounds durable window-E staleness for the "branch exists but
   * snapshot predates it" direction; see the class doc comment.
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
   * Marks the cache as stale for every process sharing this root by bumping
   * the cross-process generation marker, then eager-regenerates on this host
   * (see class doc comment for why). The bump must succeed: a swallowed
   * failure here would leave the registry stale indefinitely with no
   * bounding backstop, unlike a failed eager regen below, which only forgoes
   * closing window (E) early - the bump alone already restored correctness
   * for every future reader. A failed eager regen therefore must not fail the
   * caller's save/delete.
   */
  async invalidate(): Promise<void> {
    await bumpResourceGeneration(this.root, RESOURCE, { mustSucceed: true })

    try {
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
   * for the snapshot's embedded token to match the marker - under a bump
   * storm that could livelock; a caller that wants the very latest state
   * after a concurrent bump should call list() again after this resolves.
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

    // Opportunistic cleanup of a stale file left by the old rename-based
    // invalidation scheme (e.g. a process upgraded mid-flight). Not load-bearing.
    await fs.unlink(this.stalePath).catch(() => {})

    if (!read.ok) {
      // The marker couldn't be read for a reason other than "never bumped" -
      // we cannot attribute a token to this scan, and stamping the snapshot
      // with an unattributable token would make it indistinguishable from a
      // correctly-attributed one to every future reader on any host. Serve
      // the fresh scan result without persisting it; the next read retries
      // the marker read and, on success, regenerates and persists normally.
      return branches
    }

    const snapshot: BranchRegistrySnapshot = {
      version: REGISTRY_VERSION,
      branches,
      generation: read.token,
    }

    // Write to unique temp file first, then atomic rename.
    // Use random suffix to avoid conflicts between concurrent regenerations.
    const uniqueTempPath = `${this.tempPath}.${Date.now()}.${Math.random().toString(36).slice(2)}`
    await fs.mkdir(this.root, { recursive: true })
    await fs.writeFile(uniqueTempPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')

    try {
      await fs.rename(uniqueTempPath, this.registryPath)
    } catch (err: unknown) {
      // Clean up temp file if rename fails
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
        const meta = await BranchMetadataFileManager.loadOnly(branchRoot)

        if (meta) {
          branches.push({
            branch: meta.branch,
            branchRoot,
            baseRoot: this.root,
          })
        }
      }
    } catch (err: unknown) {
      // If root doesn't exist yet, return empty list
      if (isNotFoundError(err)) {
        return []
      }
      throw err
    }

    return branches
  }
}
