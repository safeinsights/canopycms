/**
 * Admin branch-health observability + recovery (PR-A3): a scan listing every
 * directory under the branches root (healthy/corrupt-metadata/orphan), plus
 * two recovery actions -- purge (reversible trash-rename) and repair-metadata
 * (recreate defaults for a corrupt branch.json). Split out of admin.ts to
 * keep that file under its size budget; ADMIN_ROUTES in admin.ts re-exports
 * these routes so the router and generate-client keep a single import.
 *
 * See docs/concurrency.md's "Who uses what" table for the locking rationale
 * (double-hold on purge, release-then-save ordering on repair).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { simpleGit } from 'simple-git'

import type { BranchMetadata } from '../types'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { scanBranchHealth, type BranchHealthEntry } from '../branch-health'
import { getDefaultBranchBase, sanitizeBranchName } from '../paths'
import { withOccFileLock } from '../utils/occ-json-write'
import { tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import { getErrorMessage, isNodeError, isNotFoundError } from '../utils/error'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'

// ============================================================================
// Constants
// ============================================================================

/** [H1] A fresh (< 5 min old) init lock blocks purge -- provisioning may be running. */
const PROVISIONING_LOCK_FRESH_MS = 5 * 60_000

/** An orphan dir younger than this may still be a clone in progress; corrupt dirs are exempt. */
const ORPHAN_YOUTH_THRESHOLD_MS = 15 * 60_000

const BRANCH_META_DIR = '.canopy-meta'
const BRANCH_META_FILE = 'branch.json'

// ============================================================================
// Response types
// ============================================================================

export interface BranchHealthData {
  entries: BranchHealthEntry[]
  generatedAt: string
}

/** Response type for GET /admin/branch-health */
export type BranchHealthResponse = ApiResponse<BranchHealthData>

export interface PurgeBranchDirData {
  /** The dot-prefixed name the directory was renamed to, e.g. `.trash-foo-20260101T000000Z`. */
  trashedAs: string
}

/** Response type for POST /admin/branch-dirs/:dirName/purge */
export type PurgeBranchDirResponse = ApiResponse<PurgeBranchDirData>

export interface RepairBranchDirData {
  branch: BranchMetadata
  /** The archived corrupt file's name, e.g. `branch.json.corrupt-20260101T000000Z`. */
  archivedAs: string
}

/** Response type for POST /admin/branch-dirs/:dirName/repair-metadata */
export type RepairBranchDirResponse = ApiResponse<RepairBranchDirData>

// ============================================================================
// Zod schemas
// ============================================================================

// Mirrors deleteTaskHandler's fileName pattern in admin.ts: conservative
// charset plus explicit traversal/dot-prefix refinements (the regex alone
// technically excludes '/' already, but the refinements keep intent explicit
// and self-documenting at the validation layer).
const dirNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .refine((v) => !v.includes('..'), { message: 'dirName must not contain ..' })
  .refine((v) => !v.startsWith('.'), { message: 'dirName must not be dot-prefixed' })

const branchDirParamsSchema = z.object({ dirName: dirNameSchema })
export type BranchDirParams = z.infer<typeof branchDirParamsSchema>

// ============================================================================
// Shared helpers
// ============================================================================

/** Compact UTC stamp for trash/archive names: `YYYYMMDDTHHMMSSZ` (no colons -- portability). */
function formatTrashStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Re-resolve dirName under baseRoot and enforce containment (belt-and-
 * suspenders on top of the zod regex, matching deleteTaskHandler's pattern
 * in admin.ts).
 */
function resolveDirWithinBase(baseRoot: string, dirName: string): string | null {
  const resolvedBase = path.resolve(baseRoot)
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep
  const dirPath = path.resolve(resolvedBase, dirName)
  if (dirPath !== resolvedBase && !dirPath.startsWith(baseWithSep)) return null
  return dirPath
}

/** Control-flow error for repair's precondition checks made INSIDE the lock hold. */
class RepairPreconditionError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'RepairPreconditionError'
    this.status = status
  }
}

// ============================================================================
// Handlers
// ============================================================================

const getBranchHealthHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
): Promise<BranchHealthResponse> => {
  // Same derivation services.ts uses to construct the BranchRegistry --
  // admin handlers must agree with it or the scan silently looks at the
  // wrong directory.
  const baseRoot = getDefaultBranchBase(ctx.services.config.mode)
  const baseBranchName = ctx.services.config.defaultBaseBranch ?? 'main'

  try {
    const entries = await scanBranchHealth(baseRoot, { baseBranchName })
    return {
      ok: true,
      status: 200,
      data: { entries, generatedAt: new Date().toISOString() },
    }
  } catch (err) {
    return { ok: false, status: 500, error: getErrorMessage(err) }
  }
}

/**
 * Purge a corrupt-metadata or orphan branch directory by renaming it into a
 * dot-prefixed trash name (reversible -- nothing is deleted here; the worker
 * sweeps trash older than 30 days, see cleanupTrashedBranchDirs in
 * worker/cms-worker.ts).
 *
 * Safety rails (see the PR's design review for the finding IDs):
 * - [always] the base branch directory can never be purged.
 * - Server re-derives live/corrupt/orphan state itself -- never trusts the
 *   client's view of the world.
 * - [H1] a fresh provisioning init-lock blocks purge; a stale one does not.
 * - an orphan (not corrupt) dir younger than 15 minutes is presumed to be a
 *   clone in progress and is not purgeable yet.
 * - [H2] the purge itself runs under a zero-retry provisioning lock, so a
 *   real in-flight provisioner (whose lock is therefore fresh, and would
 *   already have 409'd above) can never race the rename; a same-instant
 *   contender simply 409s.
 * - [M3] ALSO runs under the branch.json lockfile -- the same lock every
 *   metadata save() takes -- closing the window where a concurrent
 *   repair-metadata save() resurrects a ghost branch.json mid-purge.
 */
const purgeBranchDirHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
  params: BranchDirParams,
): Promise<PurgeBranchDirResponse> => {
  const baseRoot = getDefaultBranchBase(ctx.services.config.mode)
  const baseBranchName = ctx.services.config.defaultBaseBranch ?? 'main'
  const sanitizedBaseBranchName = sanitizeBranchName(baseBranchName)

  if (params.dirName === sanitizedBaseBranchName) {
    return { ok: false, status: 400, error: 'The base branch directory can never be purged' }
  }

  const dirPath = resolveDirWithinBase(baseRoot, params.dirName)
  if (!dirPath) {
    return { ok: false, status: 400, error: 'Invalid directory name' }
  }

  // [MEDIUM-1 rider] The directory must actually exist -- otherwise
  // withOccFileLock's `mkdir -p` below would CREATE it, and purge would
  // "succeed" with a phantom `.trash-*` entry for a directory that was
  // never there. Must run before anything below treats "no branch.json" as
  // orphan classification.
  const dirExists = await fs
    .stat(dirPath)
    .then(() => true)
    .catch(() => false)
  if (!dirExists) {
    return { ok: false, status: 404, error: 'Directory not found' }
  }

  const branchJsonPath = path.join(dirPath, BRANCH_META_DIR, BRANCH_META_FILE)

  // Re-derive state server-side -- never trust the client's classification.
  let meta: Awaited<ReturnType<typeof BranchMetadataFileManager.loadOnly>> = null
  let hadLoadError = false
  try {
    meta = await BranchMetadataFileManager.loadOnly(dirPath)
  } catch {
    hadLoadError = true
  }
  if (meta) {
    return { ok: false, status: 409, error: 'Directory holds a live branch; use branch delete' }
  }
  // True orphan (no branch.json, no load error) vs. corrupt-metadata
  // (loadOnly threw). Only true orphans are subject to the youth rail below.
  const isTrueOrphan = !hadLoadError

  // [H1] freshness rail: a fresh init lock means provisioning may genuinely
  // be in progress; a stale one is just crash debris and does not block.
  const lockPath = path.join(baseRoot, `.${params.dirName}.init.lock`)
  const lockStat = await fs.stat(lockPath).catch(() => null)
  if (lockStat && Date.now() - lockStat.mtimeMs < PROVISIONING_LOCK_FRESH_MS) {
    return { ok: false, status: 409, error: 'Provisioning may be in progress' }
  }

  // Youth rail: a brand-new orphan dir may be a clone that just hasn't
  // written branch.json yet. Corrupt-metadata dirs are exempt -- a
  // parseable-then-corrupted file is not a mid-clone signature.
  if (isTrueOrphan) {
    const dirStat = await fs.stat(dirPath).catch(() => null)
    if (dirStat && Date.now() - dirStat.mtimeMs < ORPHAN_YOUTH_THRESHOLD_MS) {
      return {
        ok: false,
        status: 409,
        error: 'Directory too young -- may be a clone in progress',
      }
    }
  }

  // [H2] Zero-retry provisioning lock: fails fast (409) on genuine live
  // contention instead of hanging the request for ~5 minutes.
  let releaseProvisioningLock: (() => Promise<void>) | undefined
  try {
    releaseProvisioningLock = await tryAcquireProvisioningLock(
      baseRoot,
      `.${params.dirName}.init.lock`,
    )
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ELOCKED') {
      return { ok: false, status: 409, error: 'Provisioning lock contention, try again' }
    }
    return { ok: false, status: 500, error: getErrorMessage(err) }
  }

  try {
    return await withOccFileLock(branchJsonPath, async (): Promise<PurgeBranchDirResponse> => {
      // [M3] Re-verify classification inside the double hold: a concurrent
      // repair-metadata save() could have resurrected branch.json between
      // our pre-lock check and now.
      let recheckMeta: Awaited<ReturnType<typeof BranchMetadataFileManager.loadOnly>> = null
      try {
        recheckMeta = await BranchMetadataFileManager.loadOnly(dirPath)
      } catch {
        // Still corrupt (or now corrupt) -- fine, proceed with the purge.
      }
      if (recheckMeta) {
        return { ok: false, status: 409, error: 'Directory holds a live branch; use branch delete' }
      }

      // [C1] The timestamp lives in the NAME, not the dir's mtime: rename()
      // preserves the original mtime, so mtime-based retention would delete
      // a months-stale orphan's trash on the very first cleanup pass.
      const trashName = `.trash-${params.dirName}-${formatTrashStamp(new Date())}`
      const trashPath = path.join(baseRoot, trashName)
      try {
        await fs.rename(dirPath, trashPath)
      } catch (err: unknown) {
        // Rename failure: the directory stays exactly where it was --
        // nothing evaporates, and the next scan still lists it.
        return { ok: false, status: 500, error: getErrorMessage(err) }
      }

      await ctx.services.registry?.invalidate()

      return { ok: true, status: 200, data: { trashedAs: trashName } }
    })
  } catch (err: unknown) {
    return {
      ok: false,
      status: 409,
      error: `Could not lock branch metadata: ${getErrorMessage(err)}`,
    }
  } finally {
    if (releaseProvisioningLock) {
      await releaseProvisioningLock().catch(() => {})
    }
  }
}

/**
 * Repair a corrupt branch.json by archiving it (forensics preserved as
 * `branch.json.corrupt-{STAMP}`, ignored by future scans since it doesn't
 * match the exact `branch.json` name) and recreating defaults via the
 * normal save() path. Unlike purge, the base branch IS a valid target here
 * -- a corrupt BASE branch.json is exactly the degraded-service scenario
 * this handler exists to fix.
 *
 * [M4] Lock sequence: withOccFileLock is NOT reentrant, and save() takes it
 * internally, so the rename must happen and the lock must be RELEASED
 * (exiting the withOccFileLock callback) before save() runs -- calling
 * save() while still holding the lock would deadlock against itself.
 *
 * [MEDIUM-1] The provisioning lock is held across the ENTIRE archive+save
 * sequence (acquired before withOccFileLock, released only after save()
 * completes), same lock order as purge (provisioning -> branch.json) so the
 * two can never deadlock against each other. Without this, a concurrent
 * purge could trash the directory in the window between this handler
 * releasing withOccFileLock (required before save(), per [M4] above) and
 * save() actually running -- save() would then resurrect a metadata-only
 * ghost of a directory purge just moved to trash.
 */
const repairBranchDirHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  req: ApiRequest,
  params: BranchDirParams,
): Promise<RepairBranchDirResponse> => {
  const baseRoot = getDefaultBranchBase(ctx.services.config.mode)

  const dirPath = resolveDirWithinBase(baseRoot, params.dirName)
  if (!dirPath) {
    return { ok: false, status: 400, error: 'Invalid directory name' }
  }

  // [MEDIUM-1 rider] Same stat guard as purge: the directory must actually
  // exist, otherwise withOccFileLock's `mkdir -p` below would CREATE it.
  const dirExists = await fs
    .stat(dirPath)
    .then(() => true)
    .catch(() => false)
  if (!dirExists) {
    return { ok: false, status: 404, error: 'Directory not found' }
  }

  const branchJsonPath = path.join(dirPath, BRANCH_META_DIR, BRANCH_META_FILE)

  // Pre-lock precondition check: fail fast on the common cases without
  // paying for a lock acquisition on a doomed request.
  const precheck = await checkStillCorrupt(dirPath)
  if (precheck !== 'corrupt') {
    return precheck === 'healthy'
      ? { ok: false, status: 409, error: 'Metadata is healthy' }
      : { ok: false, status: 409, error: 'No metadata file -- use purge for orphans' }
  }

  // [MEDIUM-1] Zero-retry provisioning lock, mirroring purge's [H2]: fails
  // fast (409) on genuine live contention instead of hanging the request.
  // Held until the `finally` below, AFTER save() completes.
  let releaseProvisioningLock: (() => Promise<void>) | undefined
  try {
    releaseProvisioningLock = await tryAcquireProvisioningLock(
      baseRoot,
      `.${params.dirName}.init.lock`,
    )
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ELOCKED') {
      return { ok: false, status: 409, error: 'Provisioning lock contention, try again' }
    }
    return { ok: false, status: 500, error: getErrorMessage(err) }
  }

  try {
    let archivedAs: string
    try {
      archivedAs = await withOccFileLock(branchJsonPath, async (): Promise<string> => {
        // Re-verify still-corrupt under the lock (a concurrent repair could
        // have already fixed this, or the file could have been purged out
        // from under us).
        const recheck = await checkStillCorrupt(dirPath)
        if (recheck === 'healthy') {
          throw new RepairPreconditionError('Metadata is healthy', 409)
        }
        if (recheck === 'missing') {
          throw new RepairPreconditionError('No metadata file -- use purge for orphans', 409)
        }

        const archivedName = `${BRANCH_META_FILE}.corrupt-${formatTrashStamp(new Date())}`
        await fs.rename(branchJsonPath, path.join(dirPath, BRANCH_META_DIR, archivedName))
        return archivedName
      })
    } catch (err: unknown) {
      if (err instanceof RepairPreconditionError) {
        return { ok: false, status: err.status, error: err.message }
      }
      return {
        ok: false,
        status: 409,
        error: `Could not lock branch metadata: ${getErrorMessage(err)}`,
      }
    }

    // [MEDIUM-3] Prefer the clone's actual checked-out branch over the
    // (possibly sanitized) directory name -- see resolveRepairedBranchName.
    const branchName = await resolveRepairedBranchName(dirPath, params.dirName)

    // Lock released above (we're outside the withOccFileLock callback now) --
    // save() takes its own hold on the same lock internally. Its defaults
    // path fabricates the rest of BranchMetadata and invalidates the
    // registry. Still under the provisioning lock acquired above -- see
    // [MEDIUM-1] in the docstring.
    const manager = getBranchMetadataFileManager(dirPath, baseRoot)
    const saved = await manager.save({
      branch: { name: branchName, status: 'editing', createdBy: req.user.userId },
    })

    return { ok: true, status: 200, data: { branch: saved.branch, archivedAs } }
  } finally {
    if (releaseProvisioningLock) {
      await releaseProvisioningLock().catch(() => {})
    }
  }
}

/**
 * [MEDIUM-3] Best-effort read of the branch actually checked out in the
 * clone at `dirPath`, falling back to `dirName` on any failure (no `.git`,
 * detached HEAD, corrupt repo, etc.). Workspace directory names are
 * sanitized (slashes stripped, see paths/branch.ts's `sanitizeBranchName`),
 * so a branch named `feature/foo` lives in a directory named `feature-foo`
 * -- writing `dirName` as `branch.name` would make later push/PR tasks
 * target the wrong ref.
 */
async function resolveRepairedBranchName(dirPath: string, dirName: string): Promise<string> {
  const hasGitDir = await fs
    .stat(path.join(dirPath, '.git'))
    .then(() => true)
    .catch(() => false)
  if (!hasGitDir) return dirName

  try {
    const current = await simpleGit({ baseDir: dirPath }).revparse(['--abbrev-ref', 'HEAD'])
    const trimmed = current.trim()
    return trimmed || dirName
  } catch {
    return dirName
  }
}

/** Classify branch.json's current state for repair's precondition checks. */
async function checkStillCorrupt(dirPath: string): Promise<'corrupt' | 'healthy' | 'missing'> {
  try {
    const meta = await BranchMetadataFileManager.loadOnly(dirPath)
    return meta ? 'healthy' : 'missing'
  } catch (err: unknown) {
    if (isNotFoundError(err)) return 'missing'
    return 'corrupt'
  }
}

// ============================================================================
// Route definitions
// ============================================================================

/**
 * Branch directory health scan (healthy/corrupt-metadata/orphan)
 * GET /admin/branch-health
 */
const getBranchHealth = defineEndpoint({
  namespace: 'admin',
  name: 'branchHealth',
  method: 'GET',
  path: '/admin/branch-health',
  responseType: 'BranchHealthResponse',
  response: {} as BranchHealthResponse,
  defaultMockData: { entries: [], generatedAt: '2024-01-01T00:00:00.000Z' },
  guards: ['admin'] as const,
  handler: getBranchHealthHandler,
})

/**
 * Purge a corrupt-metadata or orphan branch directory (reversible trash-rename)
 * POST /admin/branch-dirs/:dirName/purge
 */
const purgeBranchDir = defineEndpoint({
  namespace: 'admin',
  name: 'purgeBranchDir',
  method: 'POST',
  path: '/admin/branch-dirs/:dirName/purge',
  params: branchDirParamsSchema,
  responseType: 'PurgeBranchDirResponse',
  response: {} as PurgeBranchDirResponse,
  defaultMockData: { trashedAs: '.trash-example-branch-20240101T000000Z' },
  guards: ['admin'] as const,
  handler: purgeBranchDirHandler,
})

/**
 * Repair a corrupt branch.json by archiving it and recreating defaults
 * POST /admin/branch-dirs/:dirName/repair-metadata
 */
const repairBranchDir = defineEndpoint({
  namespace: 'admin',
  name: 'repairBranchDir',
  method: 'POST',
  path: '/admin/branch-dirs/:dirName/repair-metadata',
  params: branchDirParamsSchema,
  responseType: 'RepairBranchDirResponse',
  response: {} as RepairBranchDirResponse,
  defaultMockData: {
    branch: {
      name: 'example-branch',
      status: 'editing',
      access: {},
      createdBy: 'admin',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
    archivedAs: 'branch.json.corrupt-20240101T000000Z',
  },
  guards: ['admin'] as const,
  handler: repairBranchDirHandler,
})

/**
 * Exported routes, merged into ADMIN_ROUTES in admin.ts for a single
 * router/generate-client import.
 */
export const ADMIN_BRANCH_HEALTH_ROUTES = {
  branchHealth: getBranchHealth,
  purgeBranchDir,
  repairBranchDir,
} as const
