/**
 * Sparse checkout for content-branch clones. An editor reads and writes only under the content
 * root, and on EFS every checked-out file costs an NFS round trip, so a content branch's clone
 * checks out the content root and `.canopy-meta` in cone mode, which always keeps the files at
 * the repository root (a root permissions.json among them).
 *
 * A cone is set only by `stageBranchWorkspace` and, on clones already sparse, by the worker
 * (worker/sparse-cone.ts), so settings workspaces are never sparse; their orphan init also
 * empties the index with `--sparse`, so a sparse one could not leak base content either.
 * Sparse-index stays off: git expands it for most commands anyway.
 *
 * `git add` and `git rm` refuse a path outside the cone unless given `--sparse` (git >= 2.34),
 * so every call that can name one passes it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { readsFromCheckout } from './build-mode'
import type { CanopyConfig } from './config'
import { operatingStrategy } from './operating-mode'
import { getErrorMessage, isNodeError } from './utils/error'
import { CANOPY_META_DIR } from './utils/git'
import { canopyLogWarn } from './utils/logger'

/**
 * The cone a content branch's clone checks out for `contentRoot`, sorted as
 * `git sparse-checkout list` prints it, or null for a full clone when the content root is the
 * repository root.
 */
export function sparseConeFor(contentRoot: string | undefined): string[] | null {
  const root = (contentRoot ?? 'content')
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/')
  return root ? [...new Set([CANOPY_META_DIR, root])].sort() : null
}

export function sameCone(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b
  const [left, right] = [[...a].sort(), [...b].sort()]
  return left.length === right.length && left.every((dir, i) => dir === right[i])
}

/**
 * Beside the branch directories: the cone this deployment's config asks for, written by the
 * processes that hold the config and read by the worker, which does not, to re-apply a changed
 * content root to existing clones.
 */
const SPARSE_CONE_RECORD = '.sparse-cone.json'

export interface RecordedSparseCone {
  cone: string[] | null
}

function isConeDir(dir: unknown): dir is string {
  return (
    typeof dir === 'string' &&
    dir.length > 0 &&
    !path.isAbsolute(dir) &&
    !dir.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
}

/** The recorded cone, or undefined when none is recorded or the record does not parse. */
export async function readRecordedSparseCone(
  contentBranchesRoot: string,
): Promise<RecordedSparseCone | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(contentBranchesRoot, SPARSE_CONE_RECORD), 'utf8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || !('cone' in parsed)) return undefined
  const { cone } = parsed
  if (cone === null) return { cone: null }
  return Array.isArray(cone) && cone.length > 0 && cone.every(isConeDir)
    ? { cone: cone.filter(isConeDir) }
    : undefined
}

/**
 * Record `cone` unless it already is, by temp file and rename. Does not create the branches
 * root: a deployment without one has no clones to re-apply a cone to.
 */
export async function recordSparseCone(
  contentBranchesRoot: string,
  cone: string[] | null,
): Promise<void> {
  const current = await readRecordedSparseCone(contentBranchesRoot)
  if (current && sameCone(current.cone, cone)) return
  const target = path.join(contentBranchesRoot, SPARSE_CONE_RECORD)
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.writeFile(temp, `${JSON.stringify({ cone })}\n`, 'utf8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    throw err
  }
  try {
    await fs.rename(temp, target)
  } catch (err) {
    await fs.unlink(temp).catch(() => {})
    throw err
  }
}

/**
 * Record the cone `config` asks for, once per process start, so a changed content root reaches
 * existing clones without waiting for a new branch. Best-effort: a failure is logged.
 */
export async function recordConfiguredSparseCone(config: CanopyConfig): Promise<void> {
  try {
    if (readsFromCheckout(config)) return
    await recordSparseCone(
      operatingStrategy(config.mode).getContentBranchesRoot(config.sourceRoot),
      sparseConeFor(config.contentRoot),
    )
  } catch (err: unknown) {
    canopyLogWarn(`[canopy] Could not record the sparse-checkout cone: ${getErrorMessage(err)}`)
  }
}
