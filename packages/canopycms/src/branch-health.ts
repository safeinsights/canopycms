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
 * Admin-facing health classification of every directory under a branches root,
 * including the ones {@link BranchRegistry} quarantines out of normal listings.
 * Without it two stuck states have no in-product recovery, and prod admins have
 * no filesystem access to see them: a branch dir whose `.canopy-meta/branch.json`
 * is corrupt (the registry drops it silently) and an orphan dir with no
 * `branch.json` at all (a partial delete crash — see `api/branch.ts`).
 *
 * `scanBranchHealth` mirrors the registry's own directory-listing rules (skip
 * non-directories and dot-prefixed names) so the two never disagree about what
 * counts as missing.
 */
type BranchHealthKind = 'healthy' | 'corrupt-metadata' | 'orphan'

export interface BranchHealthEntry {
  dirName: string
  kind: BranchHealthKind
  /** True when this directory is the sanitized base-branch directory. */
  isBaseBranch?: boolean
  /** healthy only */
  branch?: BranchMetadata
  /**
   * healthy only, non-empty only: duplicate content IDs in this branch's
   * content tree (see content-id-index.ts). The branch stays usable — only the
   * quarantined IDs degrade, dropping out of ID-based lookups and refusing
   * saves (`DuplicateContentIdError`, a 409 naming the repair action) rather
   * than mutating an ambiguous target.
   */
  duplicateContentIds?: DuplicateContentId[]
  /**
   * healthy only, true only: this clone has an interrupted rebase on disk
   * (`.git/rebase-merge` / `.git/rebase-apply`).
   *
   * Advisory on `healthy` rather than its own `BranchHealthKind`, like
   * `duplicateContentIds`: the metadata is intact and the state is usually
   * transient, since the worker's sync loop aborts an interrupted rebase at the
   * top of its next per-branch pass. The flag buys visibility in the window
   * before that, where the branch otherwise scans as plain `healthy` while
   * being skipped as dirty every cycle.
   *
   * A value that persists is the real signal and needs an operator, because
   * recovery is not guaranteed: the abort can keep failing, or the status can
   * move off `editing` after the branch wedged — the rebase loop filters by
   * status BEFORE the recovery step, so a clone that crashed mid-rebase and was
   * then submitted or archived is never revisited, and only this flag shows it.
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
   * [H1] Present iff the dir's provisioning init-lock marker is on disk, for orphan
   * and corrupt-metadata entries only. Presence alone means nothing: a crashed
   * provisioner's lock lingers forever, since proper-lockfile reaps a stale
   * lock only on a later acquisition and a health scan never acquires.
   * Freshness (`ageMs`) is what admin actions gate on.
   */
  provisioningLock?: { mtime: string; ageMs: number }
}

/**
 * The provisioning lock marker's path for a branch directory, matching what
 * `branch-workspace.ts`'s `ensureGitWorkspace()` passes exactly.
 *
 * `acquireProvisioningLock` passes the name as `lockfilePath`, overriding
 * proper-lockfile's default `${target}.lock`, so the marker (a mkdir-based
 * directory) sits at exactly this path — no extra `.lock` suffix.
 */
function provisioningLockPath(baseRoot: string, dirName: string): string {
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
    // Missing or unreadable: "no signal" is the safe default, rather than
    // failing the whole scan.
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
 * Scan a healthy branch's content tree for duplicate embedded IDs (see
 * content-id-index.ts). Never throws: one branch's unreadable content tree must
 * not take down the whole health scan. Costs a full recursive readdir — the
 * same class of cost as a ContentStore's first-access warm-up, fine for an
 * admin-triggered scan and not for a hot path.
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
 * Classify every directory under `baseRoot` as healthy, corrupt-metadata, or
 * orphan. Never throws for a single bad directory — one dir's unreadable
 * metadata must not take down the whole scan, as in the registry's quarantine.
 * A missing `baseRoot` returns `[]`, so the admin endpoint can call this
 * without a pre-existence check.
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
      // Every loadOnly failure lands here — BranchMetadataCorruptError for bad
      // JSON, EACCES/EISDIR and the rest for everything else — since all of
      // them need admin attention and none may throw out of the scan.
      //
      // [REDACT] parseError reaches the browser through the admin branch-health
      // endpoint, so it must never carry the absolute workspace path.
      // BranchMetadataCorruptError's `parseCause` is the path-free JSON.parse
      // message for exactly this, while its `message` embeds branchRoot and is
      // for server logs only. Node errors embed the path in `message` too, so
      // only their `code` is safe to surface.
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
