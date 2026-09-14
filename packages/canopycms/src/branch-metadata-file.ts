/**
 * Reading `branch.json` — the file format, nothing else.
 *
 * Deliberately a LEAF, importing only node built-ins, a type, and the error
 * helper. That is what keeps `branch-registry.ts` (which reads every branch's
 * `branch.json`) out of a runtime import cycle with `branch-metadata.ts` (which
 * writes it and then invalidates the registry cache).
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
 * branch.json exists but is not valid JSON. Distinguished from provisioning and
 * IO failures so callers can degrade instead of failing hard: the registry scan
 * quarantines the branch, and the request handler keeps serving (with empty
 * internal groups) when the BASE branch is the corrupt one — otherwise the
 * admin recovery surface is unreachable exactly when it is needed.
 */
export class BranchMetadataCorruptError extends Error {
  readonly branchRoot: string
  /**
   * [REDACT] The raw JSON.parse failure message, with no embedded path.
   * `message` above keeps the `branchRoot`-qualified text for server logs;
   * `parseCause` is the one callers surface to clients (branch-health.ts's
   * `parseError`), so no scan leaks the absolute workspace path.
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
 * Callers distinguish three outcomes: `null` when the file does not exist (an
 * un-provisioned or non-branch directory), `BranchMetadataCorruptError` on
 * malformed JSON, and every other IO failure rethrown unchanged.
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
