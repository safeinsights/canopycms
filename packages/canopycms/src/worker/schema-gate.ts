import fs from 'node:fs/promises'
import path from 'node:path'
import type { simpleGit } from 'simple-git'

import { readSchemaRegistryRecord, type SchemaRegistryRecord } from '../schema-registry-record'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import type { BaseSchemaHold } from '../types'
import { getErrorMessage } from '../utils/error'
import { MAX_REPORTED_PATHS } from './canopy-state'
import { workerLogError, workerLogWarn } from './log'

/** How long the base branch may wait for one schema before the worker advances it anyway. */
export const DEFAULT_SCHEMA_HOLD_MAX_MS = 30 * 60_000

const COLLECTION_META_FILE = '.collection.json'
const SYMLINK_MODE = '120000'

type Git = ReturnType<typeof simpleGit>

export type SchemaGateDecision =
  | { kind: 'advance' }
  /** Advance anyway: every missing schema has waited its bound. `hold` names them. */
  | { kind: 'advance-expired'; hold: BaseSchemaHold }
  | { kind: 'hold'; hold: BaseSchemaHold }

/**
 * `contentRoot` as a literal pathspec: repo-relative with no `./` or trailing slash, or null for
 * the repository root. Literal, so a directory named like pathspec magic (`:x`) reads as itself.
 */
function contentPathspec(contentRoot: string): string | null {
  const normalized = path.posix.normalize(contentRoot.replace(/\\/g, '/')).replace(/\/+$/, '')
  return normalized === '.' || normalized === '' ? null : `:(literal)${normalized}`
}

function withPathspec(args: string[], pathspec: string | null): string[] {
  return pathspec ? [...args, '--', pathspec] : args
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

interface MetaEntry {
  mode: string
  oid: string
}

/** Every `.collection.json` under `pathspec` at `commit`, by repo-relative path. */
async function listCollectionMeta(
  git: Git,
  commit: string,
  pathspec: string | null,
): Promise<Map<string, MetaEntry>> {
  const listing = await git.raw(
    withPathspec(['ls-tree', '-r', '-z', '--full-tree', commit], pathspec),
  )
  const entries = new Map<string, MetaEntry>()
  for (const line of listing.split('\0')) {
    // `<mode> <type> <oid>\t<path>`
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const filePath = line.slice(tab + 1)
    if (path.posix.basename(filePath) !== COLLECTION_META_FILE) continue
    const [mode, type, oid] = line.slice(0, tab).split(' ')
    if (type === 'blob' && mode && oid) entries.set(filePath, { mode, oid })
  }
  return entries
}

/**
 * The schema names one meta file references at `commit`. A symlink is followed one hop, as the
 * editor's `fs.readFile` would, to a target inside the repository.
 */
async function metaReferences(
  git: Git,
  commit: string,
  filePath: string,
  entry: MetaEntry,
  blobCache: Map<string, string[]>,
): Promise<string[]> {
  if (entry.mode !== SYMLINK_MODE) {
    const cached = blobCache.get(entry.oid)
    if (cached) return cached
    const names = referencedSchemas(await git.raw(['cat-file', 'blob', entry.oid]))
    blobCache.set(entry.oid, names)
    return names
  }
  const linkText = await git.raw(['cat-file', 'blob', entry.oid])
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), linkText))
  if (target.startsWith('../') || path.posix.isAbsolute(target)) return []
  try {
    return referencedSchemas(await git.raw(['cat-file', 'blob', `${commit}:${target}`]))
  } catch {
    return []
  }
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString)

function isBaseSchemaHold(value: unknown): value is BaseSchemaHold {
  if (typeof value !== 'object' || value === null) return false
  const hold = value as Partial<Record<keyof BaseSchemaHold, unknown>>
  const { firstSeen, editorBuild } = hold
  return (
    isString(hold.since) &&
    typeof firstSeen === 'object' &&
    firstSeen !== null &&
    Object.values(firstSeen).every(isString) &&
    isString(hold.incomingSha) &&
    isStringArray(hold.missingSchemas) &&
    isStringArray(hold.files) &&
    typeof hold.fileCount === 'number' &&
    typeof editorBuild === 'object' &&
    editorBuild !== null &&
    'canopycmsVersion' in editorBuild &&
    isString(editorBuild.canopycmsVersion) &&
    isString(hold.editorRecordedAt) &&
    (hold.expired === undefined || hold.expired === true)
  )
}

/**
 * The hold in the status file a previous worker process left, so a restart or a lock takeover
 * keeps each schema's first-seen time and cannot reset the bound. Tolerant: an unreadable or
 * malformed file carries nothing.
 */
export async function readCarriedBaseHold(taskDir: string): Promise<BaseSchemaHold | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8'),
    )
    if (typeof parsed !== 'object' || parsed === null || !('baseHold' in parsed)) return undefined
    return isBaseSchemaHold(parsed.baseHold) ? parsed.baseHold : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the base branch may fast-forward from `currentSha` to `incomingSha` while the serving
 * editor runs the registry in the schema-registry record (schema-registry-record.ts).
 *
 * Holds only for a name that a `.collection.json` changed between the two tips references at the
 * incoming one, that the record lacks, and that the current base does not already reference:
 * holding cannot repair a reference already live, and a merge that changes no collection meta
 * passes after one tree diff.
 *
 * Fails open: with no readable record (an editor too old to write one, one not yet started, a
 * failed write), or when the trees cannot be read, the base advances as if there were no gate.
 * Each name waits at most `maxHoldMs` from when it was first seen missing, carried in
 * `previous.firstSeen` across cycles and worker restarts; once every missing name has waited
 * that long the base advances with an error naming them, since a name no deploy will ever supply
 * would otherwise freeze every content update.
 */
export async function decideBaseAdvance(input: {
  git: Git
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

  // Name -> the incoming meta files referencing it, for names the record lacks.
  const missing = new Map<string, string[]>()
  try {
    const pathspec = contentPathspec(record.contentRoot)
    const diff = await git.raw(
      withPathspec(
        ['diff-tree', '-r', '-z', '--name-only', '--no-renames', currentSha, incomingSha],
        pathspec,
      ),
    )
    const changed = new Set(
      diff.split('\0').filter((file) => path.posix.basename(file) === COLLECTION_META_FILE),
    )
    const incomingMeta = await listCollectionMeta(git, incomingSha, pathspec)
    // A symlink's target can change without the link itself changing.
    for (const [file, entry] of incomingMeta) if (entry.mode === SYMLINK_MODE) changed.add(file)

    const known = new Set(record.schemas)
    const blobCache = new Map<string, string[]>()
    for (const file of changed) {
      const entry = incomingMeta.get(file)
      if (!entry) continue
      for (const name of await metaReferences(git, incomingSha, file, entry, blobCache)) {
        if (!known.has(name)) missing.set(name, [...(missing.get(name) ?? []), file])
      }
    }
    if (missing.size > 0) {
      for (const [file, entry] of await listCollectionMeta(git, currentSha, pathspec)) {
        for (const name of await metaReferences(git, currentSha, file, entry, blobCache)) {
          missing.delete(name)
        }
      }
    }
  } catch (err) {
    workerLogWarn(
      `Schema gate (${baseBranch}): could not read collection meta, not holding: ${getErrorMessage(err)}`,
    )
    return { kind: 'advance' }
  }
  if (missing.size === 0) return { kind: 'advance' }

  const missingSchemas = [...missing.keys()].sort()
  const firstSeen: Record<string, string> = {}
  let waiting = false
  for (const name of missingSchemas) {
    const carried = previous?.firstSeen[name]
    // An unparseable carried time restarts that name's wait rather than ending or freezing it.
    const at = carried && Number.isFinite(Date.parse(carried)) ? carried : now.toISOString()
    firstSeen[name] = at
    if (now.getTime() - Date.parse(at) < maxHoldMs) waiting = true
  }
  const files = [...new Set([...missing.values()].flat())].sort()
  const hold: BaseSchemaHold = {
    since: Object.values(firstSeen).sort()[0] ?? now.toISOString(),
    firstSeen,
    incomingSha,
    missingSchemas,
    files: files.slice(0, MAX_REPORTED_PATHS),
    fileCount: files.length,
    editorBuild: record.build,
    editorRecordedAt: record.recordedAt,
  }
  if (waiting) return { kind: 'hold', hold }

  workerLogError(
    `Schema gate (${baseBranch}): waited ${Math.round(maxHoldMs / 60_000)} min for ${missingSchemas.join(', ')} ` +
      `(referenced by ${hold.files.join(', ')}${files.length > hold.files.length ? ', …' : ''}), ` +
      `which the serving editor` +
      `${record.build.sourceRevision ? ` (built from ${record.build.sourceRevision})` : ''} ` +
      `does not define. Advancing anyway; content types using them are unavailable until an editor ` +
      `image defining them is deployed.`,
  )
  return { kind: 'advance-expired', hold: { ...hold, expired: true } }
}
