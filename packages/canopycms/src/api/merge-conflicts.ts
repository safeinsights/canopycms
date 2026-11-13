/**
 * The conflicts the worker's merges left on a branch (merge-conflicts.ts), for the editor to show
 * and resolve: the list, one entry's conflicts with the three versions they compare, and the
 * choices that resolve an entry-level one. A field conflict is resolved by an ordinary save
 * (`resolvedConflicts`, api/content.ts), through {@link clearFieldConflicts}.
 */

import path from 'node:path'

import { z } from 'zod'

import type { BranchContext, BranchContextWithSchema } from '../types'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { CanopyConfig, ContentFormat, EntrySchema, FlatSchemaItem } from '../config'
import { SYNC_BRANCH_ACTION } from '../base-update'
import { operatingStrategy } from '../operating-mode'
import { enqueueTask } from '../task-queue/cms-task-queue'
import { getTaskQueueDir } from '../task-queue/task-queue-config'
import {
  entryRefFromRepoPath,
  entryRefFromRepoPathShape,
  parseEntryParts,
  type CollectionSchemaItem,
  type RepoPathRef,
} from '../content-listing'
import {
  BranchSyncingError,
  ContentConflictError,
  ContentStore,
  ContentStoreError,
  EntryGoneError,
} from '../content-store'
import type { DataPathSegment } from '../editor/entry-diff'
import type { FieldConflictKind, SidePaths } from '../merge/entry-merge'
import { keyOfDataPath } from '../merge/conflict-path'
import {
  MergeConflictStore,
  MergeConflictsFileMalformedError,
  MergeConflictsFileFormatError,
  conflictFilesOf,
  openConflictCount,
  withoutEntryConflict,
  withoutResolvedFields,
  type MergeConflictEntry,
  type MergeConflictKind,
  type MergeConflictState,
  type MergeSides,
  type ResolvedFieldConflict,
} from '../merge-conflicts'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { isAdmin } from '../authorization/helpers'
import { findBodyFieldName } from '../utils/body-field'
import { entryAsRead } from '../utils/calendar-day'
import { ContentWriteLockBusyError, withContentWriteLock } from '../utils/content-write-lock'
import { getErrorMessage, redactCredentials, sanitizeErrorMessage } from '../utils/error'
import { getFormatExtension } from '../utils/format'
import { parseTypedFilename } from '../utils/typed-filename'
import { canopyLogWarn } from '../utils/logger'
import { entryLogicalPath } from '../paths'
import type { ContentId, LogicalPath, Slug } from '../paths/types'
import type { EntryChangeSide } from './branch-entry-changes'
import { defineEndpoint } from './route-builder'
import { branchNameSchema, contentIdSchema, logicalPathSchema } from './validators'

/** One entry's open conflicts, as the list names them. */
export interface MergeConflictListItem {
  contentId: string
  kind: MergeConflictKind
  /** Where the file is in the branch, or was, for one the branch deleted. */
  path: string
  /** The entry's logical path; for a collection's settings, the collection's. */
  logicalPath?: string
  /** Fields with a conflict open; 0 for an entry-level conflict. */
  fieldCount: number
  /** The merge that last changed this entry's record. */
  mergeSha: string
}

export interface MergeConflictsData {
  conflicts: MergeConflictListItem[]
  /** Entries with conflicts open that this user may not read: counted, never named. */
  hiddenCount: number
  /** Choices open on the branch, each field and each entry-level conflict, hidden ones included. */
  openCount: number
  /**
   * The branch's record was damaged and set aside, so Submit and Approve wait until an admin
   * releases it (`POST /:branch/conflicts/release-hold`); the file it was moved to, for admins.
   */
  held?: { at: string; aside?: string }
}

export type MergeConflictsResponse = ApiResponse<MergeConflictsData>

/** A version a conflict compares that can't be shown. */
interface UnavailableConflictSide {
  unavailable: 'too-large' | 'unreadable' | 'missing' | 'not-an-entry'
}

export type ConflictSide = EntryChangeSide | UnavailableConflictSide

export interface EntryConflictField {
  /** The record's name for the place: what `resolvedConflicts` sends back. */
  key: string
  /**
   * The key the "Show changes" drawer gives the place, under the entry's schema now. It differs from
   * `key` only for a conflict the worker recorded without the schema.
   */
  drawerKey: string
  dataPath: DataPathSegment[]
  /**
   * Where each of `sides`' versions holds the value, as `versions` reads it; absent for a version
   * without the place. A list item can read under another key in one version than `dataPath`
   * names, as one in a list a side left keyless does.
   */
  sidePaths: SidePaths
  kind: FieldConflictKind
  /** A whole list item: resolving it keeps or removes the item. */
  item?: true
  /** Long text merged by line, its conflicting regions found from the three versions. */
  text?: true
  mergeSha: string
  /** What the author started from, and the versions of the merge that last found it. */
  sides: MergeSides
}

export interface EntryConflictData {
  contentId: string
  kind: MergeConflictKind
  path: string
  logicalPath: string
  mergeSha: string
  sides: MergeSides
  fields: EntryConflictField[]
  /** Every version a side names, by blob id, read as the editor reads an entry. */
  versions: Record<string, ConflictSide>
}

export type EntryConflictResponse = ApiResponse<EntryConflictData>

/** What an entry-level conflict is resolved by. */
export type EntryConflictChoice = 'keep' | 'delete' | 'restore' | 'use-latest'

export type ResolveEntryConflictResponse = ApiResponse<{ contentId: string; openCount: number }>

/** The most of a version read, as "Show changes" caps a side. */
const MAX_SIDE_BYTES = 1024 * 1024
/**
 * The most of all the versions one answer reads, since a field found again by several merges names
 * versions of its own: well under the gateway's 6 MB response cap, as the JSON it parses to is larger.
 */
const MAX_VERSIONS_BYTES = 3 * 1024 * 1024
const FORMATS: readonly ContentFormat[] = ['mdx', 'md', 'json', 'yaml']

const RECORD_UNREADABLE_ERROR =
  "Couldn't read this branch's conflicting changes right now. Try again in a moment."
const NO_CONFLICT_ERROR = 'This entry has no conflicting changes.'
const CONFLICT_CHANGED_ERROR =
  'This conflict changed since it was shown. Refresh to see what is left to choose.'

const blobIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

/** A save's `resolvedConflicts`: field conflicts the saved values resolve. */
export const resolvedConflictsSchema = z
  .array(z.object({ mergeSha: blobIdSchema, key: z.string().min(1).max(4096) }))
  .max(1000)

/** The record's entries; a record that does not parse answers as unreadable. */
const readEntries = async (
  branchRoot: string,
): Promise<Record<string, MergeConflictEntry> | 'unreadable'> => {
  const record = await readRecord(branchRoot)
  return record === 'unreadable' ? record : record.entries
}

/** The record as the list answers it; one that does not parse answers as unreadable. */
const readRecord = async (
  branchRoot: string,
): Promise<Pick<MergeConflictState, 'entries' | 'held'> | 'unreadable'> => {
  try {
    const record = await new MergeConflictStore(branchRoot).read()
    return record ?? { entries: {} }
  } catch (err) {
    if (
      err instanceof MergeConflictsFileMalformedError ||
      err instanceof MergeConflictsFileFormatError
    ) {
      return 'unreadable'
    }
    throw err
  }
}

/**
 * The record's path as the editor knows it: an entry, a collection's settings, or another file.
 * A file the schema no longer places is read from its path's shape, as "Show changes" reads one.
 */
const refOf = (
  repoPath: string,
  flatSchema: readonly FlatSchemaItem[],
  contentRoot: string,
): RepoPathRef => {
  const placed = entryRefFromRepoPath(repoPath, flatSchema, contentRoot)
  if (placed.kind !== 'other') return placed
  return entryRefFromRepoPathShape(repoPath, contentRoot) ?? placed
}

/** A record with where its file is now, and the path the editor addresses it, and rules judge, by. */
interface LocatedRecord {
  contentId: string
  entry: MergeConflictEntry
  ref: RepoPathRef
  /**
   * An entry's logical path, or a collection's for its settings or another file in its directory;
   * none for a file outside every collection.
   */
  address?: LogicalPath
  /**
   * The address of the path the merge recorded, where the versions it compared were, while the
   * schema still places it there.
   */
  recordedAddress?: LogicalPath
}

/** The path the editor addresses `ref` by; `at` is the file's repo path. */
const addressOf = (
  ref: RepoPathRef,
  at: string,
  flatSchema: readonly FlatSchemaItem[],
  contentRoot: string,
): LogicalPath | undefined => {
  if (ref.kind === 'entry') return ref.logicalPath
  if (ref.kind === 'collection-meta') return ref.collectionPath
  const settings = refOf(`${path.posix.dirname(at)}/.collection.json`, flatSchema, contentRoot)
  return settings.kind === 'collection-meta' ? settings.collectionPath : undefined
}

/**
 * Every record, located: an entry, or a collection's settings, where its content ID is now, since
 * the branch may have renamed or moved it since the merge recorded its path, and anything else
 * where the record says.
 */
const locateRecords = async (
  store: ContentStore,
  entries: Readonly<Record<string, MergeConflictEntry>>,
  flatSchema: readonly FlatSchemaItem[],
  contentRoot: string,
): Promise<LocatedRecord[]> => {
  if (Object.keys(entries).length === 0) return []
  const index = await store.idIndex()
  return Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([contentId, entry]) => {
      const recorded = refOf(entry.path, flatSchema, contentRoot)
      const now = recorded.kind === 'other' ? null : index.findById(contentId)
      const at =
        recorded.kind === 'entry' && now?.type === 'entry'
          ? now.relativePath
          : recorded.kind === 'collection-meta' && now?.type === 'collection'
            ? `${now.relativePath}/.collection.json`
            : entry.path
      const ref = at === entry.path ? recorded : refOf(at, flatSchema, contentRoot)
      const address = addressOf(ref, at, flatSchema, contentRoot)
      // A path the schema no longer places, as after a collection is renamed, is named by its shape
      // alone, which no path rule may still grant.
      const placedThen = entryRefFromRepoPath(entry.path, flatSchema, contentRoot)
      const recordedAddress =
        placedThen.kind === 'other'
          ? undefined
          : addressOf(placedThen, entry.path, flatSchema, contentRoot)
      return {
        contentId,
        entry,
        ref,
        ...(address !== undefined && { address }),
        ...(recordedAddress !== undefined && { recordedAddress }),
      }
    })
}

/**
 * Whether `user` may read or edit the record. The path rules judge it where it is and where the
 * merge recorded it, whose versions it shows. A file that is neither entry nor settings is shown
 * to admins only, and collection settings, like any schema change, are edited by admins only.
 */
const mayAccess = (
  record: LocatedRecord,
  checkAccess: (path: LogicalPath, level: 'read' | 'edit') => { allowed: boolean },
  user: ApiRequest['user'],
  level: 'read' | 'edit',
): boolean => {
  const admin = isAdmin(user.groups)
  if (record.ref.kind === 'other' && !admin) return false
  if (level === 'edit' && record.ref.kind === 'collection-meta' && !admin) return false
  if (record.address === undefined) return admin
  return [record.address, record.recordedAddress ?? record.address].every(
    (at) => checkAccess(at, level).allowed,
  )
}

/**
 * Wake the worker's git sync for `branch`, whose last open choice was just resolved, so the pull
 * request's conflicts status (worker/conflicts-status.ts) turns to success within a sync's rest: a
 * required check would otherwise hold the merge until the next regular cycle. Only where a worker
 * answers the queue; best-effort, as that next cycle sets it anyway.
 */
async function wakeConflictsStatus(config: Pick<CanopyConfig, 'mode'>, branch: string) {
  if (operatingStrategy(config.mode).baseUpdateRunsInRequest()) return
  try {
    await enqueueTask(getTaskQueueDir(config), { action: SYNC_BRANCH_ACTION, payload: { branch } })
  } catch (err) {
    canopyLogWarn(
      `CanopyCMS: Could not queue a sync for ${branch} after its last conflict was resolved:`,
      getErrorMessage(err),
    )
  }
}

/**
 * Change the record's entries by `change`, under the record's locks, then `branch.json`
 * `conflictFiles` to match, and wake the worker when that resolved the last open choice.
 * `change` returning null writes nothing. Resolves the entries written, or null.
 */
const changeRecord = async (
  config: Pick<CanopyConfig, 'mode'>,
  branchContext: BranchContext,
  change: (
    entries: Readonly<Record<string, MergeConflictEntry>>,
  ) => Record<string, MergeConflictEntry> | null,
): Promise<Record<string, MergeConflictEntry> | null> => {
  const state = await new MergeConflictStore(branchContext.branchRoot).update((current) => {
    if (current === null) return null
    const entries = change(current.entries)
    return entries && { ...current, entries }
  })
  if (state === null) return null
  await getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot).update(
    (existing) =>
      existing?.branch.name === branchContext.branch.name
        ? { branch: conflictFilesOf(state.entries) }
        : null,
    { keepUpdatedAt: true },
  )
  // Each change takes a choice off, so none open now means this one took the last.
  if (openConflictCount(state.entries) === 0 && !state.held) {
    await wakeConflictsStatus(config, branchContext.branch.name)
  }
  return state.entries
}

/**
 * Take the field conflicts `resolved` names off `contentId`'s record, each by its own merge and
 * key, and resolve those it cleared. A pair the record no longer holds is ignored. For a save to
 * call once the entry is written, inside its locks: the record's own locks come after them in
 * the one lock order (docs/concurrency.md).
 */
export async function clearFieldConflicts(
  config: Pick<CanopyConfig, 'mode'>,
  branchContext: BranchContext,
  contentId: string,
  resolved: readonly ResolvedFieldConflict[],
): Promise<ResolvedFieldConflict[]> {
  let cleared: ResolvedFieldConflict[] = []
  await changeRecord(config, branchContext, (entries) => {
    const next = withoutResolvedFields(entries, contentId, resolved)
    cleared = next.cleared
    return next.cleared.length > 0 ? next.entries : null
  })
  return cleared
}

/** The entry type's fields and format, while the schema still has both. */
const entryTypeOf = (
  flatSchema: readonly FlatSchemaItem[],
  ref: Extract<RepoPathRef, { kind: 'entry' }>,
) =>
  flatSchema
    .find(
      (item): item is CollectionSchemaItem =>
        item.type === 'collection' && item.logicalPath === ref.collectionPath,
    )
    ?.entries?.find((e) => e.name === ref.entryType)

/** A side's data with an md/mdx body under its body field, as the form holds it. */
const formValueOf = (side: EntryChangeSide): Record<string, unknown> =>
  side.body === undefined ? side.data : { ...side.data, [side.bodyFieldName ?? 'body']: side.body }

const listHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
): Promise<MergeConflictsResponse> => {
  const { branchContext } = gc
  const record = await readRecord(branchContext.branchRoot)
  if (record === 'unreadable') return { ok: false, status: 503, error: RECORD_UNREADABLE_ERROR }
  const { entries, held } = record
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )
  const store = new ContentStore(branchContext.branchRoot, branchContext.flatSchema, {
    contentRootName: contentRoot,
  })
  const conflicts: MergeConflictListItem[] = []
  let hiddenCount = 0
  for (const record of await locateRecords(store, entries, branchContext.flatSchema, contentRoot)) {
    const { contentId, entry, ref, address } = record
    if (!mayAccess(record, checkAccess, req.user, 'read')) {
      hiddenCount++
      continue
    }
    conflicts.push({
      contentId,
      kind: entry.kind,
      path: ref.physicalPath,
      ...(address !== undefined && { logicalPath: address }),
      fieldCount: entry.kind === 'fields' ? (entry.fields ?? []).length : 0,
      mergeSha: entry.mergeSha,
    })
  }
  return {
    ok: true,
    status: 200,
    data: {
      conflicts,
      hiddenCount,
      openCount: openConflictCount(entries),
      ...(held && {
        held: { at: held.at, ...(isAdmin(req.user.groups) && { aside: held.aside }) },
      }),
    },
  }
}

const listMergeConflicts = defineEndpoint({
  namespace: 'conflicts',
  name: 'list',
  method: 'GET',
  path: '/:branch/conflicts',
  params: z.object({ branch: branchNameSchema }),
  responseType: 'MergeConflictsResponse',
  response: {} as MergeConflictsResponse,
  defaultMockData: { conflicts: [], hiddenCount: 0, openCount: 0 },
  guards: ['branchAccessWithSchema'] as const,
  handler: listHandler,
})

const entryParamsSchema = z.object({
  branch: branchNameSchema,
  entryPath: logicalPathSchema,
  /** The entry's content id, which tells an entry from a collection at the same path. */
  id: contentIdSchema.optional(),
})

/** `logicalPath` under `contentRoot`, as content reads take it with or without the root. */
const underContentRoot = (logicalPath: string, contentRoot: string): string =>
  logicalPath === contentRoot || logicalPath.startsWith(`${contentRoot}/`)
    ? logicalPath
    : `${contentRoot}/${logicalPath}`

/** The path the store resolves `requested` to, so a rule judges the entry that is read. */
const canonicalLogicalPath = (store: ContentStore, requested: string): string => {
  const segments = requested.split('/').filter(Boolean)
  try {
    const { schemaItem, slug } = store.resolvePath(segments)
    return slug ? entryLogicalPath(schemaItem.logicalPath, slug) : schemaItem.logicalPath
  } catch (err) {
    if (err instanceof ContentStoreError) return segments.join('/')
    throw err
  }
}

/** The record addressed at `target`, matched by `id` when given; an entry wins over the rest. */
const findRecord = (
  records: readonly LocatedRecord[],
  target: string,
  id: string | undefined,
): LocatedRecord | undefined => {
  const found = records.filter(
    (r) => r.address === target && (id === undefined || r.contentId === id),
  )
  return found.find(({ ref }) => ref.kind === 'entry') ?? found[0]
}

/** Each version `shas` names, read and parsed as `ref`'s entry type. */
const readVersions = async (
  git: ReturnType<ApiContext['services']['createGitManagerFor']>,
  shas: ReadonlySet<string>,
  ref: RepoPathRef,
  flatSchema: readonly FlatSchemaItem[],
): Promise<{ versions: Record<string, ConflictSide>; fields?: EntrySchema }> => {
  const versions: Record<string, ConflictSide> = {}
  if (ref.kind !== 'entry') {
    for (const sha of shas) versions[sha] = { unavailable: 'not-an-entry' }
    return { versions }
  }
  const entryType = entryTypeOf(flatSchema, ref)
  const fields = entryType?.schema
  const format =
    entryType?.format ?? FORMATS.find((f) => ref.physicalPath.endsWith(getFormatExtension(f)))
  let budget = MAX_VERSIONS_BYTES
  for (const sha of shas) {
    const raw = await git.readBlob(sha, Math.min(MAX_SIDE_BYTES, budget))
    if (typeof raw === 'string') budget -= Buffer.byteLength(raw)
    if (raw === undefined) versions[sha] = { unavailable: 'missing' }
    else if (raw === 'too-large') versions[sha] = { unavailable: 'too-large' }
    else if (!format) versions[sha] = { unavailable: 'unreadable' }
    else {
      try {
        const parsed = parseEntryParts(raw, format)
        versions[sha] = {
          format,
          entryType: ref.entryType,
          data: entryAsRead(fields ?? [], parsed.data),
          ...(parsed.body !== undefined && {
            body: parsed.body,
            bodyFieldName: findBodyFieldName(fields ?? []),
          }),
        }
      } catch {
        versions[sha] = { unavailable: 'unreadable' }
      }
    }
  }
  return { versions, ...(fields && { fields }) }
}

const entryHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof entryParamsSchema>,
): Promise<EntryConflictResponse> => {
  const { branchContext } = gc
  const { flatSchema, branchRoot } = branchContext
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const noConflict: EntryConflictResponse = { ok: false, status: 404, error: NO_CONFLICT_ERROR }
  const store = new ContentStore(branchRoot, flatSchema, { contentRootName: contentRoot })
  const target = canonicalLogicalPath(store, underContentRoot(params.entryPath, contentRoot))
  // A path this user can't read answers as one with no conflict, so the answer never says more.
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchRoot,
    req.user,
  )
  if (!checkAccess(target as LogicalPath, 'read').allowed) return noConflict
  const entries = await readEntries(branchRoot)
  if (entries === 'unreadable') return { ok: false, status: 503, error: RECORD_UNREADABLE_ERROR }
  const records = await locateRecords(store, entries, flatSchema, contentRoot)
  const found = findRecord(records, target, params.id)
  if (!found || !mayAccess(found, checkAccess, req.user, 'read')) return noConflict
  const { contentId, entry, ref } = found

  const shas = new Set<string>()
  const add = (sides: MergeSides) => {
    for (const sha of [sides.ancestor, sides.base, sides.branch]) if (sha) shas.add(sha)
  }
  // Read in the order the cards need them, within MAX_VERSIONS_BYTES: a fields record's cards read
  // only its fields' versions, the newest merge's first; an entry-level record's, its own.
  if (entry.kind === 'fields') {
    for (const field of [...(entry.fields ?? [])].reverse()) add(field.sides)
  } else {
    add(entry.sides)
  }
  const git = ctx.services.createGitManagerFor(branchRoot, {
    baseBranch: branchContext.branch.baseBranch,
  })
  let read: Awaited<ReturnType<typeof readVersions>>
  try {
    read = await readVersions(git, shas, ref, flatSchema)
  } catch (err) {
    canopyLogWarn(
      `CanopyCMS: could not read the versions of ${branchContext.branch.name}'s conflicts:`,
      redactCredentials(getErrorMessage(err)),
    )
    return { ok: false, status: 503, error: RECORD_UNREADABLE_ERROR }
  }
  const { versions, fields: schemaFields } = read
  // A key the merge named under the schema is the drawer's already; one named without it starts
  // at an unknown top field (`?name`) and is named again here, where no list item is on the way.
  const drawerKeyOf = (field: NonNullable<MergeConflictEntry['fields']>[number]): string => {
    if (!schemaFields || !field.key.startsWith('?')) return field.key
    const side = [field.sides.branch, field.sides.base, field.sides.ancestor]
      .map((sha) => (sha ? versions[sha] : undefined))
      .find((v): v is EntryChangeSide => v !== undefined && !('unavailable' in v))
    return side ? keyOfDataPath(schemaFields, formValueOf(side), field.dataPath) : field.key
  }
  return {
    ok: true,
    status: 200,
    data: {
      contentId,
      kind: entry.kind,
      path: ref.physicalPath,
      logicalPath: target,
      mergeSha: entry.mergeSha,
      sides: entry.sides,
      fields: (entry.fields ?? []).map((field) => ({
        key: field.key,
        drawerKey: drawerKeyOf(field),
        dataPath: field.dataPath,
        sidePaths: field.sidePaths,
        kind: field.kind,
        ...(field.item && { item: true as const }),
        ...(field.text && { text: true as const }),
        mergeSha: field.mergeSha,
        sides: field.sides,
      })),
      versions,
    },
  }
}

const readEntryConflict = defineEndpoint({
  namespace: 'conflicts',
  name: 'entry',
  method: 'GET',
  path: '/:branch/conflicts/...entryPath',
  params: entryParamsSchema,
  responseType: 'EntryConflictResponse',
  response: {} as EntryConflictResponse,
  defaultMockData: {
    contentId: '',
    kind: 'fields',
    path: '',
    logicalPath: '',
    mergeSha: '',
    sides: {},
    fields: [],
    versions: {},
  },
  guards: ['branchAccessWithSchema'] as const,
  handler: entryHandler,
})

const resolveParamsSchema = z.object({
  branch: branchNameSchema,
  entryPath: logicalPathSchema,
})

const resolveBodySchema = z.object({
  /** The content id the record names the entry by. */
  id: contentIdSchema,
  /** The merge that last changed the record, as the conflict was shown. */
  mergeSha: blobIdSchema,
  /**
   * `keep`: leave the branch as it is, for any kind; `delete`: delete the entry the latest
   * version deleted (`deleted-on-base`); `restore`: put back the entry the branch deleted, as the
   * latest version has it (`deleted-on-branch`); `use-latest`: replace an entry that can't be merged
   * field by field with the latest version (`unreadable`).
   */
  choice: z.enum(['keep', 'delete', 'restore', 'use-latest']),
  /** The card promised the entry stays deleted: a `keep` is refused if it is in the tree now. */
  entryGone: z.literal(true).optional(),
})

export type ResolveEntryConflictBody = z.infer<typeof resolveBodySchema>

/** Which kinds of record each choice resolves. */
const CHOICE_KINDS: Record<EntryConflictChoice, readonly MergeConflictKind[]> = {
  keep: ['fields', 'deleted-on-base', 'deleted-on-branch', 'unreadable'],
  delete: ['deleted-on-base'],
  restore: ['deleted-on-branch'],
  'use-latest': ['unreadable'],
}

/**
 * Whether the latest version of entry `id`, in the tree the record's merge took in (its second
 * parent, worker/branch-merge.ts `buildMergeCommit`), is in the collection of the branch's file at
 * `placed`, with its entry type and extension. False when that tree can't be read.
 */
const sameKindAtLatest = async (
  git: ReturnType<ApiContext['services']['createGitManagerFor']>,
  entry: MergeConflictEntry,
  id: string,
  placed: Extract<RepoPathRef, { kind: 'entry' }>,
  flatSchema: readonly FlatSchemaItem[],
  contentRoot: string,
): Promise<boolean> => {
  const own = parseTypedFilename(path.posix.basename(placed.physicalPath))
  let files: Array<{ path: string }>
  try {
    files = await git.listFilesWithSizeAt(`${entry.mergeSha}^2`, contentRoot)
  } catch {
    return false
  }
  const latest = files.find((f) => parseTypedFilename(path.posix.basename(f.path))?.id === id)
  if (!latest || !own) return false
  const latestRef = entryRefFromRepoPath(latest.path, flatSchema, contentRoot)
  return (
    latestRef.kind === 'entry' &&
    latestRef.collectionPath === placed.collectionPath &&
    latestRef.entryType === own.type &&
    path.posix.extname(latest.path) === path.posix.extname(placed.physicalPath)
  )
}

/** Thrown inside a resolve's locks when the record no longer holds what the person chose on. */
class ConflictChangedError extends Error {}

/** A resolve's tree change refused because the version it needs isn't there. */
class LatestUnavailableError extends Error {}

const resolveHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof resolveParamsSchema>,
  body: ResolveEntryConflictBody,
): Promise<ResolveEntryConflictResponse> => {
  const { branchContext } = gc
  const { flatSchema, branchRoot } = branchContext
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const store = new ContentStore(branchRoot, flatSchema, { contentRootName: contentRoot })
  const target = canonicalLogicalPath(store, underContentRoot(params.entryPath, contentRoot))
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchRoot,
    req.user,
  )
  if (!checkAccess(target as LogicalPath, 'edit').allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  const entries = await readEntries(branchRoot)
  if (entries === 'unreadable') return { ok: false, status: 503, error: RECORD_UNREADABLE_ERROR }
  const records = await locateRecords(store, entries, flatSchema, contentRoot)
  const found = findRecord(records, target, body.id)
  if (!found) return { ok: false, status: 404, error: NO_CONFLICT_ERROR }
  if (!mayAccess(found, checkAccess, req.user, 'edit')) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  const { entry, ref } = found
  const changed: ResolveEntryConflictResponse = {
    ok: false,
    status: 409,
    code: 'CONFLICT_CHANGED',
    error: CONFLICT_CHANGED_ERROR,
  }
  if (entry.mergeSha !== body.mergeSha) return changed
  if (!CHOICE_KINDS[body.choice].includes(entry.kind)) {
    return {
      ok: false,
      status: 400,
      error: `"${body.choice}" doesn't resolve this kind of conflict.`,
    }
  }

  // The record as shown, checked under the content-write lock before the tree changes: every writer
  // of the record holds that lock, so what is checked here is what `clear` then finds.
  const verify = async () => {
    const now = await readEntries(branchRoot)
    const current = now === 'unreadable' ? undefined : now[body.id]
    if (current?.kind !== entry.kind || current.mergeSha !== body.mergeSha) {
      throw new ConflictChangedError()
    }
    // Read afresh: a restore since the drawer opened would make "keep it deleted" untrue.
    if (body.entryGone) {
      store.invalidateIndex()
      if ((await store.idIndex()).findById(body.id) !== null) throw new ConflictChangedError()
    }
  }
  // Clears the record as it stands under its lock, refusing when a merge changed it since.
  const clear = async () => {
    const written = await changeRecord(ctx.services.config, branchContext, (now) => {
      const current = now[body.id] as MergeConflictEntry | undefined
      if (current?.kind === 'fields' && current.mergeSha === body.mergeSha) {
        const { [body.id]: _kept, ...rest } = now
        return rest
      }
      const next = withoutEntryConflict(now, body.id, body.mergeSha)
      if (next === null) throw new ConflictChangedError()
      return next
    })
    if (written === null) throw new ConflictChangedError()
  }

  const placed = ref.kind === 'entry' ? ref : undefined
  if (body.choice !== 'keep' && !placed) {
    return { ok: false, status: 400, error: `"${body.choice}" only resolves an entry.` }
  }
  const slug = placed && (placed.logicalPath.slice(placed.logicalPath.lastIndexOf('/') + 1) as Slug)
  try {
    if (body.choice === 'keep' || !placed || !slug) {
      await withContentWriteLock(branchRoot, async () => {
        await verify()
        await clear()
      })
    } else if (body.choice === 'delete' || (body.choice === 'use-latest' && !entry.sides.base)) {
      // For `use-latest`, the latest version has no such entry, so using it deletes the branch's.
      await store.delete(placed.collectionPath, slug, {
        expectId: body.id,
        beforeDelete: verify,
        afterDelete: clear,
      })
    } else {
      const git = ctx.services.createGitManagerFor(branchRoot, {
        baseBranch: branchContext.branch.baseBranch,
      })
      const latest = entry.sides.base
        ? await git.readBlob(entry.sides.base, MAX_SIDE_BYTES)
        : undefined
      if (latest === 'too-large') {
        return { ok: false, status: 413, error: 'The latest version is too large to use here.' }
      }
      // The latest version's bytes go under the branch's filename, so they must be the same entry
      // type, in the same collection, in the same format: the record keeps one path, the branch's.
      if (
        body.choice === 'use-latest' &&
        !(await sameKindAtLatest(git, entry, body.id, placed, flatSchema, contentRoot))
      ) {
        return {
          ok: false,
          status: 409,
          error:
            "The latest version can't replace this entry here: it is another type of entry, or in another collection, or can't be found.",
        }
      }
      const entryType = entryTypeOf(flatSchema, placed)
      if (latest === undefined || !entryType) throw new LatestUnavailableError()
      try {
        parseEntryParts(latest, entryType.format)
      } catch {
        return {
          ok: false,
          status: 422,
          error: "The latest version of this entry doesn't read, so it can't be used here.",
        }
      }
      if (body.choice === 'restore') {
        await store.restore(
          placed.collectionPath,
          slug,
          { id: body.id as ContentId, entryTypeName: placed.entryType, raw: latest },
          { beforeWrite: verify, afterWrite: clear },
        )
      } else {
        await store.replaceRaw(
          placed.collectionPath,
          slug,
          { id: body.id as ContentId, raw: latest },
          { beforeWrite: verify, afterWrite: clear },
        )
      }
    }
  } catch (err) {
    if (err instanceof ConflictChangedError) return changed
    if (err instanceof LatestUnavailableError) {
      return {
        ok: false,
        status: 409,
        error:
          "The latest version of this entry can't be used here: it can't be read, or its entry type is no longer in the schema.",
      }
    }
    if (err instanceof ContentWriteLockBusyError || err instanceof BranchSyncingError) {
      return {
        ok: false,
        status: 409,
        error:
          err instanceof BranchSyncingError
            ? err.message
            : 'This branch is busy: it is being synced, or a save is in flight. Try again in a moment.',
        code: err.outcome === 'unknown' ? 'WRITE_OUTCOME_UNKNOWN' : 'BRANCH_SYNCING',
      }
    }
    if (err instanceof EntryGoneError) {
      return {
        ok: false,
        status: 409,
        code: 'ENTRY_GONE',
        error:
          'This entry has moved or left the branch since the conflict was shown. Refresh to see what is left to choose; for an entry no longer on the branch, keep the branch as it is.',
      }
    }
    if (err instanceof ContentConflictError) return { ok: false, status: 409, error: err.message }
    if (err instanceof ContentStoreError) {
      return { ok: false, status: 400, error: sanitizeErrorMessage(err.message) }
    }
    throw err
  }

  const left = await readEntries(branchRoot)
  return {
    ok: true,
    status: 200,
    data: { contentId: body.id, openCount: left === 'unreadable' ? 0 : openConflictCount(left) },
  }
}

const resolveEntryConflict = defineEndpoint({
  namespace: 'conflicts',
  name: 'resolveEntry',
  method: 'POST',
  path: '/:branch/resolve-entry/...entryPath',
  params: resolveParamsSchema,
  body: resolveBodySchema,
  bodyType: 'ResolveEntryConflictBody',
  responseType: 'ResolveEntryConflictResponse',
  response: {} as ResolveEntryConflictResponse,
  defaultMockData: { contentId: '', openCount: 0 },
  guards: ['schema', 'writableBranch'] as const,
  handler: resolveHandler,
})

export type ReleaseConflictsHoldResponse = ApiResponse<{ released: boolean }>

/**
 * An admin's release of a branch held because its conflict record was set aside: which fields
 * clashed is lost, and the values stay as the merges left them. Under the content-write lock, as a
 * merge's record is written.
 */
const releaseHoldHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
): Promise<ReleaseConflictsHoldResponse> => {
  const { branchRoot } = gc.branchContext
  try {
    const written = await withContentWriteLock(branchRoot, () =>
      new MergeConflictStore(branchRoot).update((current) => {
        if (!current?.held) return null
        return { ...current, held: undefined }
      }),
    )
    if (written !== null && openConflictCount(written.entries) === 0) {
      await wakeConflictsStatus(ctx.services.config, gc.branchContext.branch.name)
    }
    return { ok: true, status: 200, data: { released: written !== null } }
  } catch (err) {
    if (err instanceof ContentWriteLockBusyError) {
      return {
        ok: false,
        status: 409,
        code: 'BRANCH_SYNCING',
        error:
          'This branch is busy: it is being synced, or a save is in flight. Try again in a moment.',
      }
    }
    if (
      err instanceof MergeConflictsFileMalformedError ||
      err instanceof MergeConflictsFileFormatError
    ) {
      return { ok: false, status: 503, error: RECORD_UNREADABLE_ERROR }
    }
    throw err
  }
}

const releaseConflictsHold = defineEndpoint({
  namespace: 'conflicts',
  name: 'releaseHold',
  method: 'POST',
  path: '/:branch/conflicts/release-hold',
  params: z.object({ branch: branchNameSchema }),
  responseType: 'ReleaseConflictsHoldResponse',
  response: {} as ReleaseConflictsHoldResponse,
  defaultMockData: { released: true },
  guards: ['admin', 'branch'] as const,
  handler: releaseHoldHandler,
})

export const MERGE_CONFLICT_ROUTES = {
  list: listMergeConflicts,
  releaseHold: releaseConflictsHold,
  entry: readEntryConflict,
  resolveEntry: resolveEntryConflict,
} as const
