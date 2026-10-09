import path from 'node:path'
import type { simpleGit } from 'simple-git'

import { readSchemaRegistryRecord, type SchemaRegistryRecord } from '../schema-registry-record'
import type { BaseSchemaHold } from '../types'
import { getErrorMessage } from '../utils/error'
import { workerLogError, workerLogWarn } from './log'

/** How long the base branch may stay held before the worker advances it anyway. */
export const DEFAULT_SCHEMA_HOLD_MAX_MS = 30 * 60_000

const COLLECTION_META_FILE = '.collection.json'

export type SchemaGateDecision =
  | { kind: 'advance' }
  /** Advance anyway: the hold outlived its bound. `hold` names what the editor still lacks. */
  | { kind: 'advance-expired'; hold: BaseSchemaHold }
  | { kind: 'hold'; hold: BaseSchemaHold }

/** `contentRoot` as a pathspec for `ls-tree`: repo-relative, no `./` or trailing slash; '' for the root. */
function contentPathspec(contentRoot: string): string {
  const normalized = path.posix.normalize(contentRoot.replace(/\\/g, '/')).replace(/\/+$/, '')
  return normalized === '.' ? '' : normalized
}

/** Schema names a `.collection.json` blob's entry types reference; none when it does not parse. */
function referencedSchemas(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) return []
  const { entries } = parsed
  if (!Array.isArray(entries)) return []
  const names: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !('schema' in entry)) continue
    if (typeof entry.schema === 'string' && entry.schema.length > 0) names.push(entry.schema)
  }
  return names
}

/**
 * Every schema name the collection meta under `pathspec` references at `commit`, with the files
 * referencing each. Read from the object store, so the bare `remote.git` needs no checkout.
 */
async function schemaReferencesAt(
  git: ReturnType<typeof simpleGit>,
  commit: string,
  pathspec: string,
  blobCache: Map<string, string[]>,
): Promise<Map<string, string[]>> {
  const args = ['ls-tree', '-r', '-z', '--full-tree', commit]
  if (pathspec) args.push('--', pathspec)
  const listing = await git.raw(args)
  const refs = new Map<string, string[]>()
  for (const line of listing.split('\0')) {
    // `<mode> blob <oid>\t<path>`
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const filePath = line.slice(tab + 1)
    if (path.posix.basename(filePath) !== COLLECTION_META_FILE) continue
    const [, type, oid] = line.slice(0, tab).split(' ')
    if (type !== 'blob' || !oid) continue
    let names = blobCache.get(oid)
    if (!names) {
      names = referencedSchemas(await git.raw(['cat-file', 'blob', oid]))
      blobCache.set(oid, names)
    }
    for (const name of names) {
      const files = refs.get(name) ?? []
      files.push(filePath)
      refs.set(name, files)
    }
  }
  return refs
}

/**
 * Whether the base branch may fast-forward from `currentSha` to `incomingSha` while the serving
 * editor runs the registry in the schema-registry record (schema-registry-record.ts).
 *
 * Holds only for a name the incoming tip references, the record lacks, and the current base does
 * not already reference: holding cannot repair a reference already live, and every other change,
 * content-only merges included, passes at once.
 *
 * Fails open: with no readable record (an editor too old to write one, one not yet started, a
 * failed write), or when the trees cannot be read, the base advances as if there were no gate.
 * A hold is bounded by `maxHoldMs`, counted from `previous.since` while the base stays held across
 * cycles, then advances with an error naming what the editor still lacks: a name no deploy will
 * ever supply would otherwise freeze every content update.
 */
export async function decideBaseAdvance(input: {
  git: ReturnType<typeof simpleGit>
  contentBranchesPath: string
  baseBranch: string
  currentSha: string
  incomingSha: string
  previous: BaseSchemaHold | undefined
  maxHoldMs: number
  now?: Date
}): Promise<SchemaGateDecision> {
  const { git, baseBranch, currentSha, incomingSha, previous, maxHoldMs } = input
  const now = input.now ?? new Date()

  let record: SchemaRegistryRecord | undefined
  try {
    record = await readSchemaRegistryRecord(input.contentBranchesPath)
  } catch (err) {
    workerLogWarn(
      `Schema gate (${baseBranch}): could not read the schema-registry record, not holding: ${getErrorMessage(err)}`,
    )
    return { kind: 'advance' }
  }
  if (!record) return { kind: 'advance' }

  let missing: Map<string, string[]>
  try {
    const pathspec = contentPathspec(record.contentRoot)
    const blobCache = new Map<string, string[]>()
    const incoming = await schemaReferencesAt(git, incomingSha, pathspec, blobCache)
    const current = await schemaReferencesAt(git, currentSha, pathspec, blobCache)
    const known = new Set(record.schemas)
    missing = new Map([...incoming].filter(([name]) => !known.has(name) && !current.has(name)))
  } catch (err) {
    workerLogWarn(
      `Schema gate (${baseBranch}): could not read collection meta, not holding: ${getErrorMessage(err)}`,
    )
    return { kind: 'advance' }
  }
  if (missing.size === 0) return { kind: 'advance' }

  const missingSchemas = [...missing.keys()].sort()
  const files = [...new Set([...missing.values()].flat())].sort()
  const since = previous?.since ?? now.toISOString()
  const hold: BaseSchemaHold = {
    since,
    incomingSha,
    missingSchemas,
    files,
    editorBuild: record.build,
    editorRecordedAt: record.recordedAt,
  }
  const heldMs = now.getTime() - Date.parse(since)
  if (Number.isFinite(heldMs) && heldMs >= maxHoldMs) {
    workerLogError(
      `Schema gate (${baseBranch}): held ${Math.round(heldMs / 60_000)} min for ${missingSchemas.join(', ')} ` +
        `(referenced by ${files.join(', ')}), which the serving editor` +
        `${record.build.sourceRevision ? ` (built from ${record.build.sourceRevision})` : ''} ` +
        `does not define. Advancing anyway; collections using them are unavailable until an editor ` +
        `image defining them is deployed.`,
    )
    return { kind: 'advance-expired', hold: { ...hold, expired: true } }
  }
  return { kind: 'hold', hold }
}
