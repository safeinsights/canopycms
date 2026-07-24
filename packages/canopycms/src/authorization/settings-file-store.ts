/**
 * Cross-host layered locking for settings JSON files (permissions.json,
 * groups.json) in the settings workspace — a single global orphan-git-branch
 * checkout at `{settingsRoot}` shared by every branch (see
 * `api/settings-helpers.ts`'s `getSettingsBranchContext`).
 *
 * Without this helper, the write path is a classic unprotected TOCTOU: load
 * -> compare -> mutate -> write with no lock spanning the cycle, so two warm
 * Lambda containers (separate NFS clients on EFS) can each read the same
 * pre-mutation file and have the second write silently clobber the first.
 * `mutateSettingsJsonFile` closes that with the standard 3-layer recipe from
 * docs/concurrency.md, structured identically to {@link CommentStore}'s
 * `withMutation` (see comment-store.ts) and `BranchMetadataFileManager.save()`
 * (see branch-metadata.ts):
 *
 * 1. {@link withLock} - an in-process FIFO mutex keyed by the resolved file
 *    path. Deterministic same-process serialization.
 * 2. {@link withOccFileLock} - a server-enforced, cross-process/cross-host
 *    lock (proper-lockfile, mkdir-based), immune to NFS client dentry/
 *    attribute caching. This is the actual fix for a lost permission/group
 *    edit across two warm Lambda containers on EFS.
 * 3. {@link withOccRetry} around {@link writeOccJsonFile} - version/writeId
 *    based optimistic concurrency control, reloading the file fresh on
 *    EVERY retry attempt. With layers 1-2 in place this is defense-in-depth
 *    (e.g. a stale process from a rolling deploy writing without the lock),
 *    not the primary safety mechanism.
 *
 * `writeOccJsonFile`'s managed `version`/`writeId` pair is now THE single
 * counter for these files: the old hand-rolled `version: 1` format literal
 * and the separate `contentVersion` field are gone. A pre-existing file on
 * disk that still says `"version": 1` simply reads as OCC version 1 and
 * continues incrementing from there; a leftover `contentVersion` key is
 * silently stripped by the (non-strict, extra-keys-stripped) zod parse.
 *
 * Three caveats specific to these files, on top of the generic guarantee
 * documented on `utils/occ-json-write.ts`:
 *
 * (a) UNLIKE comments.json/branch.json (which never leave the branch
 *     workspace), permissions.json/groups.json are git-committed on the
 *     settings orphan branch. `commitSettings()` (api/settings-helpers.ts)
 *     calls `commitToSettingsBranch`, whose `pullCurrentBranch()` merge runs
 *     AFTER this helper has released its lock, and that merge can rewrite
 *     the file's `version` from upstream. So, unlike branch.json, `version`
 *     here is NOT guaranteed monotonic — it remains a correctness aid (it
 *     still catches the common same-host and short-window cross-host races)
 *     but is advisory/defense-in-depth, not a hard guarantee. The LOCKFILE
 *     (layer 2) is the actual cross-host correctness mechanism.
 * (b) The git commit+push deliberately happens OUTSIDE this lock (mirrors
 *     branch-metadata.ts keeping registry invalidation outside the lock it
 *     protects): committing/pushing is comparatively slow network/process
 *     I/O, and holding a mkdir-based lock across it would serialize
 *     unrelated requests behind that I/O for no correctness gain — only the
 *     write to the working tree needs the lock.
 * (c) Because commit+push is outside the lock, two writers' save-then-commit
 *     sequences can interleave (A saves+commits+pushes, B's save lands and
 *     commits before A's push is visible, or similar), and the second
 *     `git commit` can run against an already-clean tree. Verified benign
 *     with simple-git 3.36: its task-error detection depends on stderr
 *     output, and a clean-tree `git commit` exits 1 with "nothing to
 *     commit" on STDOUT only, so `git.commit()` resolves rather than
 *     throwing. Re-verify this on any simple-git upgrade.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { withLock } from '../utils/async-mutex'
import {
  writeOccJsonFile,
  withOccRetry,
  withOccFileLock,
  OccWriteConflictError,
  type OccWriteResult,
} from '../utils/occ-json-write'
import { isNotFoundError } from '../utils/error'

/**
 * Thrown when the lock/OCC-retry stack in {@link mutateSettingsJsonFile}
 * exhausts every attempt without landing a write — the file is busy with
 * another writer. Callers translate this into a 409 ("try again").
 */
export class SettingsFileConflictError extends Error {
  constructor(message = 'Settings are busy, please try again') {
    super(message)
    this.name = 'SettingsFileConflictError'
  }
}

/**
 * Thrown by a caller's `mutate` callback when an app-level
 * `expectedContentVersion` sent by a client doesn't match the file's current
 * `version`. A different concern from {@link SettingsFileConflictError}:
 * this is a real edit conflict the user must resolve by reloading, not
 * transient lock contention a retry can fix — and indeed it never IS
 * retried, since {@link withOccRetry} only recognizes
 * {@link OccWriteConflictError} as retryable, so this propagates on the
 * very first attempt.
 */
export class SettingsVersionConflictError extends Error {
  constructor(message = 'Settings were modified by another user. Please reload and try again.') {
    super(message)
    this.name = 'SettingsVersionConflictError'
  }
}

/**
 * Structural shape `mutateSettingsJsonFile` needs from a parsed settings
 * file: just enough to read the OCC version off it without resorting to
 * `any`. Concrete file types (e.g. `PermissionsFile`, `GroupsFile`) satisfy
 * this automatically since `version` is optional on both.
 */
interface VersionedSettingsFile {
  version?: number
}

export interface MutateSettingsFileOptions<TFile extends VersionedSettingsFile> {
  /** Path to the settings JSON file (resolved internally; need not be absolute). */
  filePath: string
  /** JSON.parse + zod-parse the raw file contents. Throws propagate untouched (never retried). */
  parse: (raw: string) => TFile
  /**
   * Compute the next payload from the current parsed file (`null` on
   * ENOENT) and the version to write it under. Return `null` for a
   * deliberate no-op — the write is skipped entirely. Called once per
   * retry attempt against freshly reloaded state, so it must be safe to
   * call more than once; anything it throws (besides the retried
   * `OccWriteConflictError`, which it should never throw itself) propagates
   * out of `mutateSettingsJsonFile` untouched.
   */
  mutate: (
    current: TFile | null,
    version: number,
  ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
  /** Forwarded to writeOccJsonFile. Pass 0 in tests. */
  settleMs?: number
  /** Forwarded to withOccRetry. */
  maxAttempts?: number
}

/**
 * Reload the file fresh and report the version to feed both `mutate()` and
 * `writeOccJsonFile`'s `expectedVersion`.
 *
 * ENOENT is the ONLY case that maps to a `null` `occExpectedVersion` (the
 * create-via-link path in {@link writeOccJsonFile}): an EXISTING file —
 * even one hand-written without a `version` field — maps to `0` and takes
 * the rename-based update path instead. Conflating the two would make
 * `writeOccJsonFile` attempt a `link()` create against a file that already
 * exists, spuriously failing with EEXIST instead of doing a normal
 * versioned update. (Same contract as `CommentStore`'s `loadWithVersion` in
 * comment-store.ts.)
 */
async function loadCurrent<TFile extends VersionedSettingsFile>(
  filePath: string,
  parse: (raw: string) => TFile,
): Promise<{ current: TFile | null; occExpectedVersion: number | null }> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if (isNotFoundError(err)) {
      return { current: null, occExpectedVersion: null }
    }
    throw err
  }
  const parsed = parse(raw)
  return { current: parsed, occExpectedVersion: parsed.version ?? 0 }
}

/**
 * Run a load -> mutate -> write cycle for a settings JSON file under the
 * full lock + OCC-retry stack described in the module doc comment above. A
 * conflict that survives every retry surfaces as
 * {@link SettingsFileConflictError}; everything else — including
 * {@link SettingsVersionConflictError} thrown by `mutate`, and any
 * parse/validation error — propagates untouched.
 *
 * Returns the `writeOccJsonFile` result, or `null` if `mutate` chose a
 * no-op (no write happened).
 */
export async function mutateSettingsJsonFile<TFile extends VersionedSettingsFile>(
  opts: MutateSettingsFileOptions<TFile>,
): Promise<OccWriteResult | null> {
  const resolved = path.resolve(opts.filePath)

  try {
    return await withLock(resolved, () =>
      withOccFileLock(resolved, () =>
        withOccRetry(
          async () => {
            const { current, occExpectedVersion } = await loadCurrent(resolved, opts.parse)
            const version = occExpectedVersion ?? 0
            const payload = await opts.mutate(current, version)
            if (payload === null) {
              return null
            }
            return writeOccJsonFile(resolved, payload, {
              expectedVersion: occExpectedVersion,
              settleMs: opts.settleMs,
            })
          },
          { maxAttempts: opts.maxAttempts },
        ),
      ),
    )
  } catch (err) {
    if (err instanceof OccWriteConflictError) {
      throw new SettingsFileConflictError()
    }
    throw err
  }
}
