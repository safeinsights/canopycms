/**
 * The conflicts the worker's merges found on a branch and nobody has resolved yet:
 * `.canopy-meta/merge-conflicts.json` in the branch clone, never committed, one record per entry.
 * The working tree holds the author's value at each one (merge/entry-merge.ts), so nothing here is
 * needed to read the branch; it is what says which values a person still has to choose.
 *
 * `branch.json` `conflictFiles` is derived from it: the content IDs it names, none for a clone with
 * no such file (`reconcileMergeConflicts`, worker/github-commits.ts).
 *
 * Writers run under the comment store's three layers (comment-store.ts): the in-process mutex, the
 * cross-host lockfile, then version OCC. The worker writes it holding the branch's provisioning and
 * content-write locks.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import type { DataPathSegment } from './editor/entry-diff'
import type { FieldConflictKind, KeyRemap, SidePaths } from './merge/entry-merge'
import type { ContentId } from './paths/types'
import type { ConflictStatus } from './types'
import { withLock } from './utils/async-mutex'
import { isNotFoundError } from './utils/error'
import { withOccFileLock, withOccRetry, writeOccJsonFile } from './utils/occ-json-write'
import { isPlainRecord } from './validation/field-traversal'

const MERGE_CONFLICTS_FILE = 'merge-conflicts.json'

/** A record field naming where the entry is, which both sides moved to different places. */
export { LOCATION_CONFLICT_KEY } from './merge/conflict-path'

/** Blob ids of the versions a merge compared; absent where that version had no file. */
export interface MergeSides {
  ancestor?: string
  base?: string
  branch?: string
}

/**
 * - `fields`: values changed differently on both sides, listed in `fields`;
 * - `deleted-on-base`: the base deleted the entry and the branch changed it; the branch's stands;
 * - `deleted-on-branch`: the branch deleted it and the base changed it; it stays deleted;
 * - `unreadable`: a version that can't be merged field by field (it does not parse, is over the
 *   size cap, changed its entry type, or is not an entry at all); the branch's file stands.
 */
export type MergeConflictKind = 'fields' | 'deleted-on-base' | 'deleted-on-branch' | 'unreadable'

export interface MergeConflictField {
  /** `entry-diff.ts`' `EntryChange.key` for the place, or {@link LOCATION_CONFLICT_KEY}. */
  key: string
  dataPath: DataPathSegment[]
  /**
   * Where each of `sides`' versions holds the value, as a read of that version names it
   * (merge/entry-merge.ts `FieldConflict.sidePaths`); `ancestor`'s is the first ancestor's.
   */
  sidePaths: SidePaths
  kind: FieldConflictKind
  item?: true
  /** Long text, merged by line: the regions both sides changed come from the three blobs. */
  text?: true
  /** The merge that last found it. */
  mergeSha: string
  /**
   * The ancestor of the merge that first found it, which is what the author started from, and the
   * base and branch of the merge that last found it.
   */
  sides: MergeSides
}

export interface MergeConflictEntry {
  /** Where the entry is in the merged tree, or was for one the branch deleted. */
  path: string
  /** The merge that last changed this record. */
  mergeSha: string
  kind: MergeConflictKind
  sides: MergeSides
  /** For `fields`, never empty. */
  fields?: MergeConflictField[]
  /**
   * The record as it stood before `mergeSha` changed it, kept until the branch holds that merge:
   * a merge recorded and then never landed gives the record back. Absent once it lands, and for a
   * record that merge created.
   */
  previous?: MergeConflictEntry
}

/** Item keys a merge changed, which the branch's comment threads take once it holds the merge. */
interface PendingRemap {
  mergeSha: string
  /** The logical path the threads name the entry by. */
  entryPath: string
  remaps: KeyRemap[]
}

/** What the file holds. */
export interface MergeConflictState {
  entries: Record<string, MergeConflictEntry>
  remaps?: PendingRemap[]
  /**
   * The merge this worker is landing: written before it reaches `remote.git`, cleared once the
   * clone holds it, or once neither the clone nor `remote.git` does; a clone whose ref can't be read
   * keeps it. The one commit a clone left
   * behind its own published merge may catch up with.
   */
  landing?: Landing
  /**
   * A record that didn't parse was set aside: which conflicts it held is lost, so Submit and Approve
   * wait ({@link assertNoOpenConflicts}) until an admin releases the branch. A later merge does not:
   * it takes the set-aside merge as merged, so the lost choices would read as the branch's own.
   * {@link MergeConflictStore.update} keeps it through a change that leaves it out.
   */
  held?: Held
}

interface Held {
  /** The name the unparseable file was moved aside to, in `.canopy-meta`. */
  aside: string
  at: string
}

interface Landing {
  mergeSha: string
  /** For a merge of GitHub's commits, the paths whose values the branch kept over them. */
  keptOverGitHub?: string[]
}

/** The record's format; a file of another is left as it is ({@link MergeConflictsFileFormatError}). */
const RECORD_SCHEMA = 2

export interface MergeConflictsFile extends MergeConflictState {
  version: number
  writeId?: string
}

/** What one merge found for one entry, before it has a commit to name. */
export interface FoundEntryConflict {
  contentId: ContentId
  path: string
  kind: MergeConflictKind
  sides: MergeSides
  fields?: Array<Omit<MergeConflictField, 'mergeSha' | 'sides'>>
}

// Strict throughout: within one `RECORD_SCHEMA` the format is fixed, so a member this code doesn't
// know is a file it didn't write, refused rather than dropped on the next write.
const sidesSchema = z
  .object({
    ancestor: z.string().optional(),
    base: z.string().optional(),
    branch: z.string().optional(),
  })
  .strict()

const dataPathSchema = z.array(
  z.union([
    z.object({ field: z.string() }).strict(),
    z.object({ item: z.string() }).strict(),
    z.object({ blockData: z.literal(true) }).strict(),
  ]),
)

const sidePathsSchema = z
  .object({
    ancestor: dataPathSchema.optional(),
    base: dataPathSchema.optional(),
    branch: dataPathSchema.optional(),
  })
  .strict()

const entrySchema: z.ZodType<MergeConflictEntry> = z.lazy(() =>
  z
    .object({
      path: z.string(),
      mergeSha: z.string(),
      kind: z.enum(['fields', 'deleted-on-base', 'deleted-on-branch', 'unreadable']),
      sides: sidesSchema,
      fields: z
        .array(
          z
            .object({
              key: z.string(),
              dataPath: dataPathSchema,
              sidePaths: sidePathsSchema,
              kind: z.enum(['changed', 'removed-on-base', 'removed-by-you']),
              item: z.literal(true).optional(),
              text: z.literal(true).optional(),
              mergeSha: z.string(),
              sides: sidesSchema,
            })
            .strict(),
        )
        .optional(),
      previous: entrySchema.optional(),
    })
    .strict(),
)

const fileSchema = z
  .object({
    schema: z.literal(RECORD_SCHEMA),
    version: z.number(),
    writeId: z.string().optional(),
    landing: z
      .object({ mergeSha: z.string(), keptOverGitHub: z.array(z.string()).optional() })
      .strict()
      .optional(),
    held: z.object({ aside: z.string(), at: z.string() }).strict().optional(),
    entries: z.record(z.string(), entrySchema),
    remaps: z
      .array(
        z
          .object({
            mergeSha: z.string(),
            entryPath: z.string(),
            remaps: z.array(
              z.object({ within: z.array(z.string()), from: z.string(), to: z.string() }).strict(),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

/**
 * merge-conflicts.json names another format than this module reads, `found`. It is left as it is,
 * unlike a file that doesn't parse: a worker of that format reads it, and its choices would be lost
 * if it were set aside. The worker's next merge refuses it too, so the branch shows as failing to
 * take its base in until the file is dealt with.
 */
export class MergeConflictsFileFormatError extends Error {
  constructor(readonly found: number) {
    super(
      `merge-conflicts.json is in format ${found}, and this code reads format ${RECORD_SCHEMA}; left as it is`,
    )
    this.name = 'MergeConflictsFileFormatError'
  }
}

/** merge-conflicts.json is there but is not a record this module wrote. */
export class MergeConflictsFileMalformedError extends Error {
  constructor(detail: string) {
    super(`merge-conflicts.json is malformed: ${detail}`)
    this.name = 'MergeConflictsFileMalformedError'
  }
}

/**
 * `existing` with what one merge, `mergeSha`, found. An entry this merge found no conflict in keeps
 * its record: its value is still the author's, which this merge took as the branch's own change.
 * A field found again keeps the ancestor it was first found against, and that ancestor's path, so
 * the person still sees what they started from, and takes this merge's base and branch. An
 * entry-level conflict replaces the entry's record; an `unreadable` record stands against fields
 * found later, taking this merge's base and branch. `paths` moves the kept records of entries this
 * merge moved. Every record this merge changes keeps the one it replaced as `previous`. Pure.
 */
export function withFoundConflicts(
  existing: Readonly<Record<string, MergeConflictEntry>>,
  found: readonly FoundEntryConflict[],
  mergeSha: string,
  paths: ReadonlyMap<string, string> = new Map(),
): Record<string, MergeConflictEntry> {
  const entries: Record<string, MergeConflictEntry> = {}
  const changed = (
    prior: MergeConflictEntry | undefined,
    next: Omit<MergeConflictEntry, 'mergeSha'>,
  ) => ({
    ...next,
    mergeSha,
    ...(prior && { previous: prior }),
  })
  for (const [id, entry] of Object.entries(existing)) {
    const at = paths.get(id)
    entries[id] =
      at === undefined || at === entry.path ? entry : changed(entry, { ...entry, path: at })
  }
  for (const { contentId, path: at, kind, sides, fields } of found) {
    const prior = existing[contentId] as MergeConflictEntry | undefined
    if (kind !== 'fields' || !fields || fields.length === 0) {
      entries[contentId] = changed(prior, { path: at, kind, sides })
      continue
    }
    if (prior?.kind === 'unreadable') {
      // A version merged as one value nobody has chosen on stands: this merge compared against it
      // as merged, so its changes would be lost unasked. The choice decides the whole entry, the
      // fields this merge found included, and compares this merge's versions with the first
      // ancestor. A deleted entry's record goes once both sides hold the entry again.
      const { ancestor: _later, ...latest } = sides
      const ancestor = prior.sides.ancestor
      entries[contentId] = changed(prior, {
        path: at,
        kind: prior.kind,
        sides: { ...latest, ...(ancestor !== undefined && { ancestor }) },
      })
      continue
    }
    const priorFields = prior?.kind === 'fields' ? (prior.fields ?? []) : []
    const keys = new Set(fields.map((f) => f.key))
    const kept = priorFields.filter((f) => !keys.has(f.key))
    const { ancestor: _ours, ...latest } = sides
    const now = fields.map((field) => {
      const earlier = priorFields.find((f) => f.key === field.key)
      const ancestor = earlier ? earlier.sides.ancestor : sides.ancestor
      // The path travels with its blob: the first ancestor's, or none when that had no value here.
      const { ancestor: _found, ...latestPaths } = field.sidePaths
      const ancestorPath = earlier ? earlier.sidePaths.ancestor : field.sidePaths.ancestor
      return {
        ...field,
        sidePaths: {
          ...latestPaths,
          ...(ancestorPath !== undefined && { ancestor: ancestorPath }),
        },
        mergeSha,
        sides: { ...latest, ...(ancestor !== undefined && { ancestor }) },
      }
    })
    entries[contentId] = changed(prior, { path: at, kind, sides, fields: [...kept, ...now] })
  }
  return entries
}

/** The item keys one merge changed in one entry, which the entry's records follow. */
export interface EntryKeyRemaps {
  contentId?: string
  remaps: readonly KeyRemap[]
}

/**
 * `field` with the item keys `remaps` changed renamed in its key and data path. Each remap names
 * an item by the keys it had before this merge, as the comment store's do, so all match against
 * the original path and apply at once. The key holds one token per data path step but `blockData`.
 */
function withRemappedKeys(
  field: MergeConflictField,
  remaps: readonly KeyRemap[],
): MergeConflictField {
  const renamed = new Map<number, string>()
  for (const { within, from, to } of remaps) {
    const enclosing: string[] = []
    field.dataPath.forEach((segment, n) => {
      if (!('item' in segment)) return
      const hit =
        segment.item === from &&
        enclosing.length === within.length &&
        enclosing.every((k, m) => k === within[m])
      if (hit && !renamed.has(n)) renamed.set(n, to)
      enclosing.push(segment.item)
    })
  }
  if (renamed.size === 0) return field
  const dataPath = field.dataPath.map((segment, n) => {
    const to = renamed.get(n)
    return to === undefined ? segment : { item: to }
  })
  const tokens = [...field.key.matchAll(/([.?]?)([^.?]+)/g)].map(([, sep, name]) => [sep, name])
  let token = 0
  field.dataPath.forEach((segment, n) => {
    if ('blockData' in segment) return
    const to = renamed.get(n)
    if (to !== undefined && tokens[token]) tokens[token] = [tokens[token][0], to]
    token++
  })
  const key = tokens.map(([sep, name]) => `${sep}${name}`).join('')
  return { ...field, key, dataPath }
}

/**
 * `entries` with the item keys a merge, `mergeSha`, changed renamed in the conflicts on record,
 * as the branch's comment threads are, so a conflict found again under the new key is the same
 * one. A record this renames keeps the one it replaced as `previous`, so a merge that never lands
 * gives the old keys back. Pure.
 */
export function withRemappedItemKeys(
  entries: Readonly<Record<string, MergeConflictEntry>>,
  remaps: readonly EntryKeyRemaps[],
  mergeSha: string,
): Record<string, MergeConflictEntry> {
  const out: Record<string, MergeConflictEntry> = { ...entries }
  for (const { contentId, remaps: changed } of remaps) {
    const entry = contentId === undefined ? undefined : out[contentId]
    if (!entry?.fields) continue
    const fields = entry.fields.map((field) => withRemappedKeys(field, changed))
    if (fields.every((field, n) => field === entry.fields?.[n])) continue
    out[contentId as string] = { ...entry, fields, mergeSha, previous: entry }
  }
  return out
}

/**
 * `entries` as the branch's history has them: a record whose `mergeSha` fails `holds` gives back the
 * one it replaced, or goes when it replaced none, and a record whose merge the branch holds drops
 * the one it replaced. A field whose own merge fails `holds` goes too, and an entry with no field
 * left. Pure.
 */
export function withoutMergesGone(
  entries: Readonly<Record<string, MergeConflictEntry>>,
  holds: (mergeSha: string) => boolean,
): Record<string, MergeConflictEntry> {
  const kept: Record<string, MergeConflictEntry> = {}
  for (const [id, newest] of Object.entries(entries)) {
    let entry: MergeConflictEntry | undefined = newest
    while (entry && !holds(entry.mergeSha)) entry = entry.previous
    if (!entry) continue
    const { previous: _landed, ...landed } = entry
    if (landed.kind !== 'fields') {
      kept[id] = landed
      continue
    }
    const fields = (landed.fields ?? []).filter((f) => holds(f.mergeSha))
    if (fields.length > 0) kept[id] = { ...landed, fields }
  }
  return kept
}

/** A field conflict a person resolved, named as the record names it. */
export interface ResolvedFieldConflict {
  mergeSha: string
  key: string
}

/**
 * `entries` without the fields of `contentId`'s record that `resolved` names, each by its own
 * `mergeSha` and `key`, and without the record once no field is left. A pair the record no longer
 * holds, as after a newer merge found that field again, is left out of `cleared`. A record left with
 * fields keeps its `previous`; a record left with none goes with it, since a merge keeps every field
 * the record it replaced held, so those were resolved too. Pure.
 */
export function withoutResolvedFields(
  entries: Readonly<Record<string, MergeConflictEntry>>,
  contentId: string,
  resolved: readonly ResolvedFieldConflict[],
): { entries: Record<string, MergeConflictEntry>; cleared: ResolvedFieldConflict[] } {
  const entry = entries[contentId] as MergeConflictEntry | undefined
  if (entry?.kind !== 'fields') return { entries: { ...entries }, cleared: [] }
  const cleared: ResolvedFieldConflict[] = []
  const fields = (entry.fields ?? []).filter((field) => {
    const match = resolved.some((r) => r.mergeSha === field.mergeSha && r.key === field.key)
    if (match) cleared.push({ mergeSha: field.mergeSha, key: field.key })
    return !match
  })
  const { [contentId]: _resolved, ...rest } = entries
  if (cleared.length === 0) return { entries: { ...entries }, cleared }
  return {
    entries: fields.length > 0 ? { ...rest, [contentId]: { ...entry, fields } } : rest,
    cleared,
  }
}

/**
 * `entries` without `contentId`'s entry-level record, when `mergeSha` is the merge that last changed
 * it; null when it is not there, or a later merge changed it. Pure.
 */
export function withoutEntryConflict(
  entries: Readonly<Record<string, MergeConflictEntry>>,
  contentId: string,
  mergeSha: string,
): Record<string, MergeConflictEntry> | null {
  const entry = entries[contentId] as MergeConflictEntry | undefined
  if (!entry || entry.kind === 'fields' || entry.mergeSha !== mergeSha) return null
  const { [contentId]: _resolved, ...rest } = entries
  return rest
}

/** How many choices `entries` leave a person: each field conflict, and each entry-level one. */
export function openConflictCount(entries: Readonly<Record<string, MergeConflictEntry>>): number {
  return Object.values(entries).reduce(
    (n, entry) => n + (entry.kind === 'fields' ? (entry.fields ?? []).length : 1),
    0,
  )
}

/** What `branch.json` holds for `entries`: the content IDs with a conflict open, sorted. */
export function conflictFilesOf(entries: Readonly<Record<string, MergeConflictEntry>>): {
  conflictStatus: ConflictStatus
  conflictFiles: ContentId[]
} {
  const conflictFiles = Object.keys(entries).sort() as ContentId[]
  return {
    conflictStatus: conflictFiles.length > 0 ? 'conflicts-detected' : 'clean',
    conflictFiles,
  }
}

/**
 * A submit or approval refused while the branch has conflicts open, `count` of them, or with none
 * it can count (`count` null): a record that doesn't parse, which the worker's next cycle sets aside
 * and holds; one held after that (`held`); or one of another format, left until a developer deals
 * with it.
 */
export class OpenMergeConflictsError extends Error {
  constructor(
    readonly count: number | null,
    /** The record was set aside as unparseable, so which conflicts are open is lost. */
    readonly held = false,
  ) {
    super(
      held
        ? "This branch's record of conflicts was damaged and set aside, so it's on hold until an admin releases it."
        : count === null
          ? "Couldn't check this branch for changes that conflict with newer ones. Try again in a moment."
          : count === 1
            ? 'A change on this branch conflicts with a newer change on the site.'
            : `${count} changes on this branch conflict with newer changes on the site.`,
    )
    this.name = 'OpenMergeConflictsError'
  }
}

/**
 * Throws {@link OpenMergeConflictsError} while `branchRoot`'s record holds a conflict, is held after
 * one was set aside, or does not parse. A clone with no record has none open.
 */
export async function assertNoOpenConflicts(branchRoot: string): Promise<void> {
  let record: MergeConflictsFile | null
  try {
    record = await new MergeConflictStore(branchRoot).read()
  } catch (err) {
    if (
      err instanceof MergeConflictsFileMalformedError ||
      err instanceof MergeConflictsFileFormatError
    )
      throw new OpenMergeConflictsError(null)
    throw err
  }
  if (record?.held) throw new OpenMergeConflictsError(null, true)
  const count = record ? openConflictCount(record.entries) : 0
  if (count > 0) throw new OpenMergeConflictsError(count)
}

/** A branch clone's merge-conflicts.json. */
export class MergeConflictStore {
  private readonly filePath: string

  constructor(
    branchRoot: string,
    private readonly settleMs?: number,
  ) {
    // Resolved, so two spellings of one branch root share the in-process lock key.
    this.filePath = path.join(path.resolve(branchRoot), '.canopy-meta', MERGE_CONFLICTS_FILE)
  }

  /** Whether the clone has a record at all. */
  async exists(): Promise<boolean> {
    return fs.stat(this.filePath).then(
      () => true,
      () => false,
    )
  }

  /**
   * Copy a file that does not parse as a record aside, and replace it with a new one that is
   * `held`, as which conflicts were open is lost with it. Resolves the copy's path, or null when
   * the file parses by the time the locks are held: another caller's copy, if it set one aside.
   * The new record is written beside the file and renamed over it, so a worker killed at any step
   * leaves a record that still refuses the gate: the damaged one, or the held one.
   */
  async quarantine(): Promise<string | null> {
    return withLock(this.filePath, () =>
      withOccFileLock(this.filePath, async () => {
        const now = await this.read().then(
          (record) => ({ record }),
          (err: unknown) => {
            if (err instanceof MergeConflictsFileMalformedError) return null
            throw err
          },
        )
        if (now !== null) {
          const aside = now.record?.held?.aside
          return aside === undefined ? null : path.join(path.dirname(this.filePath), aside)
        }
        const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`
        const aside = `${this.filePath}.malformed-${stamp}`
        await fs.copyFile(this.filePath, aside)
        const held: Held = { aside: path.basename(aside), at: new Date().toISOString() }
        const next = `${this.filePath}.held-${stamp}`
        await writeOccJsonFile(
          next,
          { schema: RECORD_SCHEMA, entries: {}, held },
          { expectedVersion: null, settleMs: this.settleMs },
        )
        await fs.rename(next, this.filePath)
        return aside
      }),
    )
  }

  /** The record, or null when the clone has none. Throws on a file that does not parse as one. */
  async read(): Promise<MergeConflictsFile | null> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf-8')
    } catch (err) {
      if (isNotFoundError(err)) return null
      throw err
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new MergeConflictsFileMalformedError('it is not JSON')
    }
    const schema = isPlainRecord(json) ? json.schema : undefined
    if (typeof schema === 'number' && schema !== RECORD_SCHEMA) {
      throw new MergeConflictsFileFormatError(schema)
    }
    const parsed = fileSchema.safeParse(json)
    if (!parsed.success) throw new MergeConflictsFileMalformedError(parsed.error.message)
    return parsed.data
  }

  /**
   * Replace what the file holds with what `change` makes of it, under the module's locks. `change`
   * gets null when there is no file yet, and returns null to write nothing; a `held` it leaves out
   * stays. Resolves what was written, or null.
   */
  async update(
    change: (current: MergeConflictState | null) => MergeConflictState | null,
  ): Promise<MergeConflictState | null> {
    return withLock(this.filePath, () =>
      withOccFileLock(this.filePath, () =>
        withOccRetry(async () => {
          const current = await this.read()
          const next = change(
            current && {
              entries: current.entries,
              ...(current.remaps && { remaps: current.remaps }),
              ...(current.landing && { landing: current.landing }),
              ...(current.held && { held: current.held }),
            },
          )
          if (next === null) return null
          // A hold stays unless the change names `held`, as only a release does, setting it undefined.
          const held = Object.prototype.hasOwnProperty.call(next, 'held')
            ? next.held
            : current?.held
          const payload = {
            schema: RECORD_SCHEMA,
            entries: next.entries,
            ...(next.remaps && { remaps: next.remaps }),
            ...(next.landing && { landing: next.landing }),
            ...(held && { held }),
          }
          await writeOccJsonFile(this.filePath, payload, {
            expectedVersion: current ? current.version : null,
            settleMs: this.settleMs,
          })
          return next
        }),
      ),
    )
  }
}
