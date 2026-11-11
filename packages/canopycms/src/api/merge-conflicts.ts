/**
 * The conflicts the worker's merges left on a branch (merge-conflicts.ts), for the editor to show
 * and resolve: the list, one entry's conflicts with the three versions they compare, and the
 * choices that resolve an entry-level one. A field conflict is resolved by an ordinary save
 * (`resolvedConflicts`, api/content.ts), through {@link clearFieldConflicts}.
 */

import { z } from 'zod'

import type { BranchContext, BranchContextWithSchema } from '../types'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { ContentFormat, EntrySchema, FlatSchemaItem } from '../config'
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
import type { FieldConflictKind } from '../merge/entry-merge'
import { keyOfDataPath } from '../merge/conflict-path'
import {
  LOCATION_CONFLICT_KEY,
  MergeConflictStore,
  MergeConflictsFileMalformedError,
  MergeConflictsFileNewerError,
  conflictFilesOf,
  openConflictCount,
  withoutEntryConflict,
  withoutResolvedFields,
  type MergeConflictEntry,
  type MergeConflictKind,
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
import { canopyLogWarn } from '../utils/logger'
import { entryLogicalPath } from '../paths'
import type { ContentId, LogicalPath, Slug } from '../paths/types'
import type { EntryChangeSide } from './branch-entry-changes'
import { defineEndpoint } from './route-builder'
import { branchNameSchema, contentIdSchema, logicalPathSchema } from './validators'

/** One entry's open conflicts, as the list names them. */
interface MergeConflictListItem {
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

interface MergeConflictsData {
  conflicts: MergeConflictListItem[]
  /** Entries with conflicts open that this user may not read: counted, never named. */
  hiddenCount: number
  /** Choices open on the branch, each field and each entry-level conflict, hidden ones included. */
  openCount: number
}

export type MergeConflictsResponse = ApiResponse<MergeConflictsData>

/** A version a conflict compares that can't be shown. */
interface UnavailableConflictSide {
  unavailable: 'too-large' | 'unreadable' | 'missing' | 'not-an-entry'
}

type ConflictSide = EntryChangeSide | UnavailableConflictSide

interface EntryConflictField {
  /** The record's name for the place: what `resolvedConflicts` sends back. */
  key: string
  /**
   * The key the "Show changes" drawer gives the place, under the entry's schema now. It differs from
   * `key` only for a conflict the worker recorded without the schema.
   */
  drawerKey: string
  dataPath: DataPathSegment[]
  kind: FieldConflictKind
  /** A whole list item: resolving it keeps or removes the item. */
  item?: true
  /** Long text merged by line, its conflicting regions found from the three versions. */
  text?: true
  mergeSha: string
  /** What the author started from, and the versions of the merge that last found it. */
  sides: MergeSides
}

interface EntryConflictData {
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
type EntryConflictChoice = 'keep' | 'delete' | 'restore' | 'use-latest'

export type ResolveEntryConflictResponse = ApiResponse<{ contentId: string; openCount: number }>

/** The most of a version read, as "Show changes" caps a side. */
const MAX_SIDE_BYTES = 1024 * 1024
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
  try {
    return (await new MergeConflictStore(branchRoot).read())?.entries ?? {}
  } catch (err) {
    if (
      err instanceof MergeConflictsFileMalformedError ||
      err instanceof MergeConflictsFileNewerError
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

/** The path a path rule judges for `ref`; none for a file that is neither entry nor settings. */
const aclPathOf = (ref: RepoPathRef): LogicalPath | undefined =>
  ref.kind === 'entry'
    ? ref.logicalPath
    : ref.kind === 'collection-meta'
      ? ref.collectionPath
      : undefined

/**
 * Change the record's entries by `change`, under the record's locks, then `branch.json`
 * `conflictFiles` to match. `change` returning null writes nothing. Resolves the entries written,
 * or null.
 */
const changeRecord = async (
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
  return state.entries
}

/**
 * Take the field conflicts `resolved` names off `contentId`'s record, each by its own merge and
 * key, and resolve those it cleared. A pair the record no longer holds is ignored. For a save to
 * call once the entry is written, inside its locks: the record's own locks come after them in
 * the one lock order (docs/concurrency.md).
 */
export async function clearFieldConflicts(
  branchContext: BranchContext,
  contentId: string,
  resolved: readonly ResolvedFieldConflict[],
): Promise<ResolvedFieldConflict[]> {
  let cleared: ResolvedFieldConflict[] = []
  await changeRecord(branchContext, (entries) => {
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
  const entries = await readEntries(branchContext.branchRoot)
  if (entries === 'unreadable') return { ok: false, status: 503, error: RECORD_UNREADABLE_ERROR }
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )
  const admin = isAdmin(req.user.groups)
  const conflicts: MergeConflictListItem[] = []
  let hiddenCount = 0
  for (const [contentId, entry] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    const ref = refOf(entry.path, branchContext.flatSchema, contentRoot)
    const aclPath = aclPathOf(ref)
    const readable = aclPath === undefined ? admin : checkAccess(aclPath, 'read').allowed
    if (!readable) {
      hiddenCount++
      continue
    }
    conflicts.push({
      contentId,
      kind: entry.kind,
      path: entry.path,
      ...(aclPath !== undefined && { logicalPath: aclPath }),
      fieldCount: entry.kind === 'fields' ? (entry.fields ?? []).length : 0,
      mergeSha: entry.mergeSha,
    })
  }
  return {
    ok: true,
    status: 200,
    data: { conflicts, hiddenCount, openCount: openConflictCount(entries) },
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

/**
 * The record at `entryPath`, matched by `id` when given; an entry wins over collection settings. A
 * file that is neither is matched by its repo path.
 */
const findRecord = (
  entries: Readonly<Record<string, MergeConflictEntry>>,
  target: string,
  id: string | undefined,
  flatSchema: readonly FlatSchemaItem[],
  contentRoot: string,
): { contentId: string; entry: MergeConflictEntry; ref: RepoPathRef } | undefined => {
  const found = Object.entries(entries)
    .filter(([contentId]) => id === undefined || contentId === id)
    .map(([contentId, entry]) => ({
      contentId,
      entry,
      ref: refOf(entry.path, flatSchema, contentRoot),
    }))
    .filter(({ entry, ref }) => (aclPathOf(ref) ?? entry.path) === target)
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
  for (const sha of shas) {
    const raw = await git.readBlob(sha, MAX_SIDE_BYTES)
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
  const found = findRecord(entries, target, params.id, flatSchema, contentRoot)
  if (!found || (found.ref.kind === 'other' && !isAdmin(req.user.groups))) return noConflict
  const { contentId, entry, ref } = found

  const shas = new Set<string>()
  const add = (sides: MergeSides) => {
    for (const sha of [sides.ancestor, sides.base, sides.branch]) if (sha) shas.add(sha)
  }
  add(entry.sides)
  for (const field of entry.fields ?? []) add(field.sides)
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
  const drawerKeyOf = (field: NonNullable<MergeConflictEntry['fields']>[number]): string => {
    if (!schemaFields || field.key === LOCATION_CONFLICT_KEY) return field.key
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
      path: entry.path,
      logicalPath: target,
      mergeSha: entry.mergeSha,
      sides: entry.sides,
      fields: (entry.fields ?? []).map((field) => ({
        key: field.key,
        drawerKey: drawerKeyOf(field),
        dataPath: field.dataPath,
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
})

export type ResolveEntryConflictBody = z.infer<typeof resolveBodySchema>

/** Which kinds of record each choice resolves. */
const CHOICE_KINDS: Record<EntryConflictChoice, readonly MergeConflictKind[]> = {
  keep: ['fields', 'deleted-on-base', 'deleted-on-branch', 'unreadable'],
  delete: ['deleted-on-base'],
  restore: ['deleted-on-branch'],
  'use-latest': ['unreadable'],
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
  const found = findRecord(entries, target, body.id, flatSchema, contentRoot)
  if (!found) return { ok: false, status: 404, error: NO_CONFLICT_ERROR }
  // A file that is neither entry nor settings is listed to admins only, so only they resolve it.
  if (found.ref.kind === 'other' && !isAdmin(req.user.groups)) {
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
  }
  // Clears the record as it stands under its lock, refusing when a merge changed it since.
  const clear = async () => {
    const written = await changeRecord(branchContext, (now) => {
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
      await store.delete(placed.collectionPath, slug, { beforeDelete: verify, afterDelete: clear })
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
        error: "The latest version of this entry isn't available here, so it can't be used.",
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
    if (err instanceof EntryGoneError) return changed
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

export const MERGE_CONFLICT_ROUTES = {
  list: listMergeConflicts,
  entry: readEntryConflict,
  resolveEntry: resolveEntryConflict,
} as const
