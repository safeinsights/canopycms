import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'

import type { BranchMetadata } from './types'
import { BranchMetadataFileManager, BranchMetadataCorruptError } from './branch-metadata'
import { ContentIdIndex, type DuplicateContentId } from './content-id-index'
import { sanitizeBranchName } from './paths/branch-name'
import { getErrorMessage, isNodeError, isNotFoundError } from './utils/error'
import { isRebaseInProgress } from './utils/git'

/**
 * Admin-facing health classification of every directory under a branches
 * root (`baseRoot`), including ones the {@link BranchRegistry} quarantines
 * out of normal listings. Two stuck states have no in-product recovery
 * without this: a branch dir whose `.canopy-meta/branch.json` is corrupt
 * (registry now silently drops it — see branch-registry.ts's
 * `scanBranchDirectories` quarantine), and an orphan dir with no
 * `branch.json` at all (left behind by a partial delete crash — see
 * `api/branch.ts`'s delete handler). Both are invisible to admins in prod,
 * who have no filesystem access.
 *
 * `scanBranchHealth` mirrors the registry's own directory-listing rules
 * (skip non-directories and dot-prefixed names) so its classification never
 * disagrees with what the registry itself would show as "missing".
 */
export type BranchHealthKind = 'healthy' | 'corrupt-metadata' | 'orphan'

export interface BranchHealthEntry {
  dirName: string
  kind: BranchHealthKind
  /** True when this directory is the sanitized base-branch directory. */
  isBaseBranch?: boolean
  /** healthy only */
  branch?: BranchMetadata
  /**
   * healthy only, and only when non-empty: duplicate content IDs found in
   * this branch's content tree (see content-id-index.ts's "Duplicate-ID
   * quarantine" section). The branch itself stays fully usable -- content
   * operations degrade only for the specific quarantined ID(s), which are
   * excluded from ID-based lookups, and whose entries refuse saves
   * (`DuplicateContentIdError`, a 409 naming this repair action) rather than
   * mutate an ambiguous target, until repaired via the
   * repair-content-duplicates admin action.
   */
  duplicateContentIds?: DuplicateContentId[]
  /**
   * healthy only, and only when true: this clone has an interrupted rebase on
   * disk (`.git/rebase-merge` / `.git/rebase-apply`).
   *
   * Deliberately an advisory flag on `healthy` rather than its own
   * `BranchHealthKind`, for the same reason `duplicateContentIds` is: the
   * branch's metadata is intact and the state is USUALLY transient -- the
   * worker's sync loop aborts an interrupted rebase at the top of its next
   * per-branch pass. What this flag buys is visibility in the window BEFORE
   * that pass runs, where the branch otherwise scanned as unqualified
   * `healthy` while being skipped as dirty every cycle.
   *
   * NOT self-recovering in every case, so a persisting value is the real
   * signal and needs an operator. Two ways it sticks: the abort itself keeps
   * failing, or the branch's status moved off `editing` after it wedged --
   * the rebase loop filters by status BEFORE reaching the recovery step, so a
   * clone that crashed mid-rebase and was then submitted or archived is never
   * revisited, and this flag is the only thing that surfaces it.
   */
  rebaseInProgress?: boolean
  /** corrupt-metadata only: message describing why the file failed to load. */
  parseError?: string
  /** corrupt-metadata only: branch.json's mtime, ISO. Omitted if branch.json itself couldn't be stat'd. */
  metaMtime?: string
  /** orphan only: whether a `.git` directory is present (partial clone vs. fully-provisioned). */
  hasGitDir?: boolean
  /** orphan only: the directory's own mtime, ISO. */
  dirMtime?: string
  /** orphan only: age of the directory's mtime in ms, clamped to >= 0. */
  ageMs?: number
  /**
   * [H1] Present iff the dir's provisioning init-lock marker exists on disk,
   * for orphan and corrupt-metadata entries only. Presence alone means
   * nothing -- a crashed provisioner's lock lingers forever (proper-lockfile
   * stale locks are only reaped by a later acquisition attempt, and a health
   * scan never acquires). Freshness (`ageMs`) is the actual signal admin
   * actions gate on.
   */
  provisioningLock?: { mtime: string; ageMs: number }
}

/**
 * The on-disk path of the cross-process provisioning lock marker for a
 * given branch directory, matching `branch-workspace.ts`'s
 * `ensureGitWorkspace()` exactly:
 *
 * ```ts
 * acquireProvisioningLock(
 *   path.dirname(branchRoot),         // === baseRoot
 *   `.${path.basename(branchRoot)}.init.lock`,
 * )
 * ```
 *
 * `acquireProvisioningLock` passes this name as `lockfilePath`, which
 * overrides proper-lockfile's default `${target}.lock` naming, so the lock
 * marker itself (a directory, mkdir-based) lives at exactly this path -- no
 * extra `.lock` suffix.
 */
export function provisioningLockPath(baseRoot: string, dirName: string): string {
  return path.join(baseRoot, `.${dirName}.init.lock`)
}

/** Stat the provisioning lock marker, if present. Never throws. */
async function readProvisioningLock(
  baseRoot: string,
  dirName: string,
): Promise<{ mtime: string; ageMs: number } | undefined> {
  try {
    const stat = await fs.stat(provisioningLockPath(baseRoot, dirName))
    return { mtime: stat.mtime.toISOString(), ageMs: Math.max(0, Date.now() - stat.mtimeMs) }
  } catch {
    // Missing, or unreadable for some other reason -- either way, "no signal"
    // is the safe default rather than failing the whole scan.
    return undefined
  }
}

/** Stat branch.json's mtime for a corrupt-metadata entry. Never throws. */
async function readMetaMtime(branchRoot: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(path.join(branchRoot, '.canopy-meta', 'branch.json'))
    return stat.mtime.toISOString()
  } catch {
    return undefined
  }
}

/**
 * Scan a healthy branch's content tree for duplicate-embedded-ID pairs (see
 * content-id-index.ts's "Duplicate-ID quarantine" section). Never throws --
 * one branch's unreadable/unusual content tree must not take down the whole
 * health scan (same rationale as the corrupt-metadata handling below). Costs
 * a full recursive readdir of the content tree, same class of cost as the
 * lazy warm-up every ContentStore already pays on first access -- acceptable
 * for an admin-triggered scan, not a hot path.
 */
async function scanDuplicateContentIds(
  branchRoot: string,
  contentRootName: string,
): Promise<DuplicateContentId[]> {
  try {
    const idIndex = new ContentIdIndex(branchRoot)
    await idIndex.buildFromFilenames(contentRootName)
    return idIndex.getDuplicateIds()
  } catch {
    return []
  }
}

/**
 * Scan every directory under `baseRoot` and classify it as healthy,
 * corrupt-metadata, or orphan. Never throws for a single bad directory --
 * one dir's unreadable/unparseable metadata must not take down the whole
 * scan (same rationale as the registry's own quarantine behavior).
 *
 * Tolerates a missing `baseRoot` (returns `[]`) so the admin endpoint can
 * call this unconditionally without a pre-existence check.
 */
export async function scanBranchHealth(
  baseRoot: string,
  opts: { baseBranchName: string; contentRootName?: string },
): Promise<BranchHealthEntry[]> {
  const resolvedRoot = path.resolve(baseRoot)
  const sanitizedBaseBranchName = sanitizeBranchName(opts.baseBranchName)
  const contentRootName = opts.contentRootName ?? 'content'

  let dirEntries: Dirent[]
  try {
    dirEntries = await fs.readdir(resolvedRoot, { withFileTypes: true })
  } catch (err: unknown) {
    if (isNotFoundError(err)) return []
    throw err
  }

  const entries: BranchHealthEntry[] = []

  for (const dirEntry of dirEntries) {
    // Same skip rules as BranchRegistry.scanBranchDirectories: non-dirs and
    // dot-prefixed names (`.canopy-meta`-style, and our own `.trash-*`/
    // `.*.init.lock` markers) are never branch directories.
    if (!dirEntry.isDirectory() || dirEntry.name.startsWith('.')) continue

    const dirName = dirEntry.name
    const branchRoot = path.join(resolvedRoot, dirName)
    const isBaseBranch = dirName === sanitizedBaseBranchName

    let meta: Awaited<ReturnType<typeof BranchMetadataFileManager.loadOnly>> = null
    let loadErr: unknown = null
    try {
      meta = await BranchMetadataFileManager.loadOnly(branchRoot)
    } catch (err: unknown) {
      loadErr = err
    }

    if (loadErr) {
      // Both the documented BranchMetadataCorruptError (bad JSON) and any
      // other loadOnly failure (EACCES, EISDIR from a directory named
      // branch.json, etc.) land here: all are "needs admin attention",
      // and none may throw out of the scan.
      //
      // [REDACT] parseError is served to the browser via the admin
      // branch-health endpoint, so it must never leak the absolute
      // workspace path. BranchMetadataCorruptError carries `parseCause`
      // (the raw JSON.parse message, path-free) for exactly this --
      // `message` embeds branchRoot and is for server logs only. Other node
      // errors (EISDIR from a directory named branch.json, EACCES, etc.)
      // embed the path in their `message`, so only their `code` is safe to
      // surface; non-node errors fall back to getErrorMessage.
      const parseError =
        loadErr instanceof BranchMetadataCorruptError
          ? loadErr.parseCause
          : isNodeError(loadErr)
            ? (loadErr.code ?? 'read error')
            : getErrorMessage(loadErr)
      const [metaMtime, provisioningLock] = await Promise.all([
        readMetaMtime(branchRoot),
        readProvisioningLock(resolvedRoot, dirName),
      ])
      entries.push({
        dirName,
        kind: 'corrupt-metadata',
        ...(isBaseBranch ? { isBaseBranch } : {}),
        parseError,
        ...(metaMtime ? { metaMtime } : {}),
        ...(provisioningLock ? { provisioningLock } : {}),
      })
      continue
    }

    if (meta) {
      const [duplicateContentIds, rebaseInProgress] = await Promise.all([
        scanDuplicateContentIds(branchRoot, contentRootName),
        isRebaseInProgress(branchRoot),
      ])
      entries.push({
        dirName,
        kind: 'healthy',
        ...(isBaseBranch ? { isBaseBranch } : {}),
        branch: meta.branch,
        ...(duplicateContentIds.length ? { duplicateContentIds } : {}),
        ...(rebaseInProgress ? { rebaseInProgress } : {}),
      })
      continue
    }

    // meta === null, no loadErr: no branch.json at all -- orphan.
    const [gitDirStat, dirStat, provisioningLock] = await Promise.all([
      fs.stat(path.join(branchRoot, '.git')).catch(() => null),
      fs.stat(branchRoot).catch(() => null),
      readProvisioningLock(resolvedRoot, dirName),
    ])
    entries.push({
      dirName,
      kind: 'orphan',
      ...(isBaseBranch ? { isBaseBranch } : {}),
      hasGitDir: gitDirStat !== null,
      ...(dirStat
        ? {
            dirMtime: dirStat.mtime.toISOString(),
            ageMs: Math.max(0, Date.now() - dirStat.mtimeMs),
          }
        : {}),
      ...(provisioningLock ? { provisioningLock } : {}),
    })
  }

  return entries
}
