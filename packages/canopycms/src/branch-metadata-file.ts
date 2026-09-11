/**
 * Reading `branch.json` — the file format, nothing else.
 *
 * Deliberately a LEAF: it imports only node built-ins, a type, and the error
 * helper. That is the whole point of the file.
 *
 * `branch-registry.ts` scans every branch directory and reads each one's
 * `branch.json`; `branch-metadata.ts` owns writing it and, after a write,
 * invalidates the registry cache. Both of those are correct, but together they
 * were a runtime import cycle (`branch-metadata` -> `branch-registry` ->
 * `branch-metadata`), with value imports on both edges — the only cycle in the
 * package when `no-circular` was first turned on, 2026-08-23.
 *
 * Hoisting the READ here breaks it without changing either module's behavior:
 * the registry gets its reader from a leaf, and the metadata manager keeps its
 * invalidation edge. `BranchMetadataFileManager.loadOnly` stays as a thin
 * delegate so its ~16 existing call sites are untouched.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchMetadata } from './types'
import { isNotFoundError } from './utils/error'

export const BRANCH_META_DIR = '.canopy-meta'
export const BRANCH_META_FILE = 'branch.json'

export interface BranchMetadataFile {
  schemaVersion: number
  version: number
  writeId?: string
  branch: BranchMetadata
}

/**
 * branch.json exists but its content is not valid JSON. Distinguished from
 * provisioning/IO failures so callers can degrade instead of failing hard:
 * the registry scan quarantines the branch, and the request handler keeps
 * serving (with empty internal groups) when the BASE branch is the corrupt
 * one — otherwise the admin recovery surface would be unreachable exactly
 * when it is needed.
 */
export class BranchMetadataCorruptError extends Error {
  readonly branchRoot: string
  /**
   * [REDACT] The raw JSON.parse failure message (e.g. "Unexpected token
   * ..."), with no embedded path. `message` above deliberately keeps the
   * full `branchRoot`-qualified text for server logs; `parseCause` is what
   * callers should surface to clients (see branch-health.ts's `parseError`)
   * so the admin branch-health scan never leaks the absolute workspace path.
   */
  readonly parseCause: string

  constructor(branchRoot: string, cause: string) {
    super(`Corrupt branch metadata in '${branchRoot}': ${cause}`)
    this.name = 'BranchMetadataCorruptError'
    this.branchRoot = branchRoot
    this.parseCause = cause
  }
}

/** Absolute path to a branch workspace's `branch.json`. */
export const branchMetadataFilePath = (branchRoot: string): string =>
  path.join(path.resolve(branchRoot), BRANCH_META_DIR, BRANCH_META_FILE)

/**
 * Read and parse `branch.json`, with no locking, no OCC and no side effects.
 *
 * Returns `null` when the file does not exist (an un-provisioned or
 * non-branch directory), throws `BranchMetadataCorruptError` on malformed
 * JSON, and rethrows every other IO failure unchanged — callers distinguish
 * all three.
 */
export async function readBranchMetadataFile(
  branchRoot: string,
): Promise<BranchMetadataFile | null> {
  const resolvedRoot = path.resolve(branchRoot)
  try {
    const raw = await fs.readFile(branchMetadataFilePath(resolvedRoot), 'utf8')
    return JSON.parse(raw) as BranchMetadataFile
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      return null
    }
    if (err instanceof SyntaxError) {
      throw new BranchMetadataCorruptError(resolvedRoot, err.message)
    }
    throw err
  }
}
