import type { FileStatusResult, SimpleGit, StatusResult } from 'simple-git'

import { SCHEMA_CACHE_FILE } from '../branch-schema-cache'
import { CANOPY_META_DIR, isCanopyInternalPath } from '../utils/git'

/**
 * How the sync loop treats canopycms's own state (`.canopy-meta/`) in a branch clone. It is
 * never content, so it never makes a clone "dirty" for sync, but git still refuses some
 * operations over it while the adopter's repo tracks it. Only the adopter can stop that; once
 * they have, the base clone follows ({@link untrackInIndex}); branch clones need an operator.
 */

/** The fix an operator applies when an adopter repo tracks `.canopy-meta/`. */
export const TRACKED_CANOPY_STATE_FIX =
  'run `git rm -r --cached .canopy-meta` in the site repo, add `.canopy-meta/` to its .gitignore, and commit'

/** Paths listed in worker-status.json per category; the admin panel shows them in a tooltip. */
export const MAX_REPORTED_PATHS = 10

/** The schema cache's location in a clone before it moved under `.git/` (branch-schema-cache.ts). */
const RETIRED_SCHEMA_CACHE_PATH = `${CANOPY_META_DIR}/${SCHEMA_CACHE_FILE}`

export function isUntracked(file: FileStatusResult): boolean {
  return file.index === '?' && file.working_dir === '?'
}

/** Files under `.canopy-meta/` that the clone's index tracks. */
export async function listTrackedCanopyState(git: SimpleGit): Promise<string[]> {
  const out = await git.raw(['ls-files', '--', CANOPY_META_DIR])
  return out.split('\n').filter((line) => line.length > 0)
}

/**
 * Discard local changes to the schema cache's retired in-tree copy, so a clone of a repo that
 * committed it can sync again. Nothing reads or writes that path in a clone any more, so its
 * content is dead; but while it differs from HEAD, `git rebase` refuses to start and a
 * fast-forward that touches it (including the adopter's own commit untracking it) refuses too.
 * Untracked or newly staged copies block neither, so they are left alone. Returns whether it
 * restored anything; the caller re-reads status if so.
 */
export async function restoreRetiredSchemaCache(
  git: SimpleGit,
  status: StatusResult,
): Promise<boolean> {
  const entry = status.files.find((f) => f.path === RETIRED_SCHEMA_CACHE_PATH)
  if (!entry || entry.index === '?' || entry.index === 'A') return false
  await git.raw(['checkout', 'HEAD', '--', RETIRED_SCHEMA_CACHE_PATH])
  return true
}

/**
 * The modified tracked `.canopy-meta/` files in `status`: what git refuses to rebase over, and
 * what a fast-forward refuses to overwrite.
 */
export function trackedCanopyStateChanges(status: StatusResult): string[] {
  return status.files
    .filter((f) => isCanopyInternalPath(f.path) && !isUntracked(f))
    .map((f) => f.path)
}

/**
 * Split `paths` by whether the commit `tip` still tracks them. Those it no longer tracks, the
 * adopter has untracked upstream, so a fast-forward or rebase onto `tip` would delete them anyway
 * and {@link untrackInIndex} can clear the way; the rest still block.
 */
export async function splitByUpstreamTracking(
  git: SimpleGit,
  paths: string[],
  tip: string,
): Promise<{ droppedUpstream: string[]; stillTracked: string[] }> {
  if (paths.length === 0) return { droppedUpstream: [], stillTracked: [] }
  const tracked = new Set(
    (await git.raw(['ls-tree', '-r', '--name-only', tip, '--', CANOPY_META_DIR]))
      .split('\n')
      .filter((line) => line.length > 0),
  )
  return {
    droppedUpstream: paths.filter((p) => !tracked.has(p)),
    stillTracked: paths.filter((p) => tracked.has(p)),
  }
}

/**
 * Remove `paths` from this clone's index, leaving them on disk as untracked, excluded state.
 * Index-only, so a concurrent write to them (branch metadata, comments) is not lost. Only for a
 * clone with no commits of its own: a rebase that replays a commit touching these paths writes
 * that commit's bytes over them. Paths already out of the index are ignored.
 */
export async function untrackInIndex(git: SimpleGit, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await git.raw(['rm', '--cached', '--ignore-unmatch', '-q', '--', ...paths])
}
