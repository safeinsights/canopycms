/**
 * Cross-host layered locking for the settings JSON files (permissions.json,
 * groups.json) in the settings workspace — one global orphan-git-branch
 * checkout at `{settingsRoot}` shared by every branch (see
 * `api/settings-helpers.ts`'s `getSettingsBranchContext`).
 *
 * `mutateSettingsJsonFile` composes the three layers docs/concurrency.md owns
 * ("The four layers"; the settings-files row of "Who uses what"): `withLock`
 * on the resolved path, then `withOccFileLock`, then `withOccRetry` around
 * `writeOccJsonFile`, which reloads the file on every attempt. Without all
 * three the write path is an unprotected TOCTOU: two warm Lambda containers
 * are separate NFS clients on EFS, so both can read the same pre-mutation file
 * and the second write silently wins.
 *
 * What that doc and `utils/occ-json-write.ts` do not cover:
 *
 * (a) These files are git-committed, so `version` is NOT monotonic here --
 *     `commitSettings()` (api/settings-helpers.ts) calls
 *     `commitToSettingsBranch`, whose `pullCurrentBranch()` merge runs after
 *     this helper releases its lock and can rewrite `version` from upstream.
 *     The lockfile (layer 2) is the cross-host guarantee; OCC is defense.
 * (b) The git commit+push deliberately runs OUTSIDE this lock: it is slow
 *     network I/O, and only the working-tree write needs the lock.
 * (c) So two writers' save-then-commit sequences can interleave and the second
 *     `git commit` can hit an already-clean tree. Benign with simple-git 3.36,
 *     whose task-error detection reads stderr while a clean-tree commit exits
 *     1 with "nothing to commit" on stdout only. Re-verify on upgrade.
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
 * Thrown by a caller's `mutate` when a client-supplied
 * `expectedContentVersion` doesn't match the file's current `version`: a real
 * edit conflict the user resolves by reloading, not the transient contention
 * behind {@link SettingsFileConflictError}. It is never retried —
 * {@link withOccRetry} only retries {@link OccWriteConflictError} — so it
 * propagates on the first attempt.
 */
export class SettingsVersionConflictError extends Error {
  constructor(message = 'Settings were modified by another user. Please reload and try again.') {
    super(message)
    this.name = 'SettingsVersionConflictError'
  }
}

/**
 * Just enough of a parsed settings file to read its OCC version without `any`.
 * `PermissionsFile` and `GroupsFile` satisfy it — `version` is optional on both.
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
   * Compute the next payload from the current parsed file (`null` on ENOENT)
   * and the version to write it under; return `null` for a deliberate no-op.
   * Called once per retry attempt against freshly reloaded state, so it must be
   * safe to call more than once. Anything it throws propagates out untouched,
   * and it must never throw `OccWriteConflictError` itself.
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
 * Reload the file fresh and report the version fed to both `mutate()` and
 * `writeOccJsonFile`'s `expectedVersion`.
 *
 * ENOENT is the ONLY case mapping to a `null` `occExpectedVersion` (the
 * create-via-link path in {@link writeOccJsonFile}); an existing file, even one
 * hand-written with no `version` field, maps to `0` and takes the rename-based
 * update path. Conflating them makes `writeOccJsonFile` attempt a `link()`
 * create over a file that exists and fail with EEXIST. (Same contract as
 * `CommentStore`'s `loadWithVersion` in comment-store.ts.)
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
 * Run one load -> mutate -> write cycle under the full lock + OCC-retry stack
 * described in the module doc. A conflict surviving every retry surfaces as
 * {@link SettingsFileConflictError}; everything else — including
 * {@link SettingsVersionConflictError} thrown by `mutate`, and any
 * parse/validation error — propagates untouched. Returns the
 * `writeOccJsonFile` result, or `null` if `mutate` chose a no-op.
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
