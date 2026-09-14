import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './utils/atomic-write'
import { getErrorMessage, isNodeError } from './utils/error'
import { createDebugLogger } from './utils/debug'

/**
 * Cross-process generation marker for an on-disk resource cached under a
 * branch-clone root: several warm Lambda containers and the EC2 worker share
 * those clones on EFS with no shared memory and no cross-host file watching,
 * so the filesystem coordinates. The marker for `resource` lives at
 * {root}/.canopy-meta/{resource}.generation — dot-prefixed so content and
 * index scans skip it, and excluded from git via .git/info/exclude.
 *
 * - Mutators bump AFTER mutating, with a fresh random token: a counter would
 *   need read-modify-write and lose concurrent bumps without a lock.
 * - Regenerators capture the token BEFORE scanning and embed it in the
 *   snapshot; readers compare that token against the live marker and
 *   regenerate on mismatch. A regeneration racing an invalidation embeds the
 *   old token, so it self-describes as stale and heals on the next read.
 * - Regeneration returns its own scan result and never loops until the tokens
 *   match, which would livelock under a bump storm.
 * - `mustSucceed` bumps explicit invalidations, where a swallowed failure
 *   means indefinite staleness; bulk `finally`-block callers take the default
 *   log-and-swallow hint bump.
 * - A marker read error other than ENOENT stays distinct from "never bumped":
 *   the consumer serves the fresh scan but skips persisting a snapshot whose
 *   token it cannot attribute to that scan.
 *
 * A consumer that persists its snapshot (branch registry, schema cache) can
 * durably record a fresh token over data its scan read from a stale NFS cache,
 * which every other host then trusts. So the mutating host regenerates eagerly
 * right after its own bump — that scan is coherent with its own mutation — and
 * the registry adds a suspicious-miss backstop. Staleness windows (A-E) and
 * the rolling-deploy transient: docs/concurrency.md §4.
 */

const log = createDebugLogger({ prefix: 'ResourceGeneration' })

const META_DIR = '.canopy-meta'

/** Absolute path of the generation marker for `resource` under `root`. */
export function resourceGenerationPath(root: string, resource: string): string {
  return path.resolve(root, META_DIR, `${resource}.generation`)
}

export interface BumpResourceGenerationOptions {
  /**
   * Rethrow a failed bump instead of logging and swallowing it. Set it where a
   * lost bump means indefinitely stale durable data with no bounding backstop
   * (e.g. a registry's invalidate()). Default false.
   */
  mustSucceed?: boolean
}

/**
 * Record on disk that `resource` changed under `root`, so consumers in OTHER
 * processes rebuild. Must be called AFTER the filesystem mutation.
 *
 * Returns the token written, or null if the write failed and `mustSucceed`
 * was not set.
 */
export async function bumpResourceGeneration(
  root: string,
  resource: string,
  options?: BumpResourceGenerationOptions,
): Promise<string | null> {
  const token = randomUUID()
  try {
    await atomicWriteFile(resourceGenerationPath(root, resource), token)
    return token
  } catch (err) {
    log.warn('generation', `Failed to bump ${resource} generation for ${root}`, {
      error: getErrorMessage(err),
    })
    if (options?.mustSucceed) throw err
    return null
  }
}

/**
 * Result of reading a generation marker. `ok: false` means the read failed for
 * a reason OTHER than "marker doesn't exist yet"; callers force-regenerate
 * rather than folding it into a token value, because a legitimate snapshot can
 * embed `token: null` (a fresh clone regenerated before any bump) and that must
 * stay distinguishable from "we don't know the current token".
 */
export type GenerationReadResult = { ok: true; token: string | null } | { ok: false }

/**
 * Read the current generation token for `resource` under `root`. ENOENT maps to
 * `{ok: true, token: null}`, the "never bumped" state; every other read error
 * maps to `{ok: false}`.
 */
export async function readResourceGeneration(
  root: string,
  resource: string,
): Promise<GenerationReadResult> {
  try {
    const token = await fs.readFile(resourceGenerationPath(root, resource), 'utf-8')
    return { ok: true, token }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return { ok: true, token: null }
    log.warn('generation', `Failed to read ${resource} generation for ${root}`, {
      error: getErrorMessage(err),
    })
    return { ok: false }
  }
}

/**
 * True when a snapshot's captured token is still current: the read succeeded
 * AND its token matches. A failed read (`ok: false`) is never current, even
 * against a null snapshot token — an unreadable marker vouches for nothing, so
 * the safe default is stale.
 */
export function isGenerationCurrent(
  snapshotToken: string | null,
  read: GenerationReadResult,
): boolean {
  return read.ok && read.token === snapshotToken
}
