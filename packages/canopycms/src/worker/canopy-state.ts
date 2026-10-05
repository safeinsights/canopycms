import type { FileStatusResult, SimpleGit, StatusResult } from 'simple-git'

import { SCHEMA_CACHE_FILE } from '../branch-schema-cache'
import { CANOPY_META_DIR } from '../utils/git'

/**
 * How the sync loop treats canopycms's own state (`.canopy-meta/`) in a branch clone. It is
 * never content, so it never makes a clone "dirty" for sync, but git still refuses some
 * operations over it when an adopter has committed it, and only the adopter can fix that.
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
