import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import type { BranchContextWithSchema } from '../types'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { ContentFormat, EntrySchema, FlatSchemaItem } from '../config'
import {
  entryRefFromRepoPath,
  entryRefFromRepoPathShape,
  parseEntryParts,
  type CollectionSchemaItem,
} from '../content-listing'
import { ContentStore, ContentStoreError } from '../content-store'
import { resolveCollectionPath } from '../content-id-index'
import { BaseBranchMissingError } from '../git-manager'
import { withItemKeys } from '../item-keys'
import { getBranchProtection } from '../authorization/protected-branch'
import { baseBranchOf } from '../utils/base-branch'
import { findBodyFieldName } from '../utils/body-field'
import { isNodeError, isNotFoundError } from '../utils/error'
import { getFormatExtension } from '../utils/format'
import { entryLogicalPath } from '../paths'
import type { LogicalPath, Slug } from '../paths/types'
import { defineEndpoint } from './route-builder'
import { branchNameSchema, contentIdSchema, logicalPathSchema } from './validators'
import {
  branchReadFailedResponse,
  readWhileSteady,
  unsteadyReadResponse,
  type SteadyRead,
} from './branch-changes'

/** One side of an entry's change: its file as the editor reads it, references unresolved. */
export interface EntryChangeSide {
  format: ContentFormat
  entryType: string
  data: Record<string, unknown>
  /** An md/mdx entry's markdown content. */
  body?: string
  /** The field `body` maps to on this side, as `ContentStore.read` names it. */
  bodyFieldName?: string
}

export interface BranchEntryChangeData {
  /** The entry at the commit the branch forked from; null when it is new on the branch. */
  before: EntryChangeSide | null
  /** The entry as saved on the branch; null when the branch deleted it. */
  after: EntryChangeSide | null
  mergeBaseSha: string
}

export type BranchEntryChangeResponse = ApiResponse<BranchEntryChangeData>

/** The most of a side's file read, so one huge file can't hold the API or the browser. */
const MAX_SIDE_BYTES = 1024 * 1024
const NOT_COMPARABLE_ERROR = "This entry can't be compared."
const UNREADABLE_ERROR = "This entry couldn't be read on one side, so it can't be compared."
const TOO_LARGE_ERROR = 'This entry is too large to compare here.'
const FORMATS: readonly ContentFormat[] = ['mdx', 'md', 'json', 'yaml']

/** A side read, or why it can't be shown. */
type SideRead = EntryChangeSide | 'too-large' | 'unreadable' | undefined

const entryChangeParamsSchema = z.object({
  branch: branchNameSchema,
  entryPath: logicalPathSchema,
  /** A moved entry's path at the base. */
  from: logicalPathSchema.optional(),
  /** The entry's content id: both sides must carry it, so a slug reused by another entry isn't it. */
  id: contentIdSchema.optional(),
})

/** `logicalPath` under `contentRoot`, as content reads take it with or without the root. */
const underContentRoot = (logicalPath: string, contentRoot: string): string =>
  logicalPath === contentRoot || logicalPath.startsWith(`${contentRoot}/`)
    ? logicalPath
    : `${contentRoot}/${logicalPath}`

/** An entry path in the one form the access check, the read and every match use. */
interface CanonicalPath {
  logicalPath: LogicalPath
  /** Where the store reads it; absent when the schema has no such collection. */
  stored?: { collectionPath: LogicalPath; slug: Slug }
}

/**
 * The path as the store resolves it (the slug lowercased, separators collapsed), so a path rule
 * judges the entry that is read, as api/content.ts judges it. A collection the schema lacks has
 * nothing to read in the working tree; its path is the requested segments rejoined, and only a
 * base file at exactly that path matches it.
 */
const canonicalPath = (store: ContentStore, requested: string): CanonicalPath => {
  const segments = requested.split('/').filter(Boolean)
  try {
    const { schemaItem, slug } = store.resolvePath(segments)
    return {
      logicalPath: entryLogicalPath(schemaItem.logicalPath, slug),
      stored: { collectionPath: schemaItem.logicalPath, slug },
    }
  } catch (err) {
    if (err instanceof ContentStoreError) return { logicalPath: segments.join('/') as LogicalPath }
    throw err
  }
}

/** The entry type `entryType` names in `collectionPath`, when the schema still has both. */
const entryTypeIn = (
  flatSchema: readonly FlatSchemaItem[],
  collectionPath: string,
  entryType: string,
) =>
  flatSchema
    .find(
      (item): item is CollectionSchemaItem =>
        item.type === 'collection' && item.logicalPath === collectionPath,
    )
    ?.entries?.find((e) => e.name === entryType)

/** The working tree's side and what the base side must match: its content id and fields. */
interface AfterRead {
  side: SideRead
  contentId?: string
  fields?: EntrySchema
}

/**
 * The entry at `target` in the working tree, read as the editor's content read does. With `id`,
 * a file at that path holding another id is not this entry.
 */
const readAfter = async (
  store: ContentStore,
  flatSchema: readonly FlatSchemaItem[],
  target: CanonicalPath,
  id: string | undefined,
): Promise<AfterRead> => {
  if (!target.stored) return { side: undefined }
  const { collectionPath, slug } = target.stored
  let located: Awaited<ReturnType<ContentStore['resolveDocumentPath']>>
  try {
    located = await store.resolveDocumentPath(collectionPath, slug)
  } catch (err) {
    if (err instanceof ContentStoreError) return { side: undefined }
    throw err
  }
  if (!located.existed || (id !== undefined && located.id !== id)) return { side: undefined }
  const fields = entryTypeIn(flatSchema, collectionPath, located.entryTypeName)?.schema
  const found = { contentId: located.id, fields }
  try {
    const stat = await fs.stat(located.absolutePath)
    if (stat.size > MAX_SIDE_BYTES) return { ...found, side: 'too-large' }
    const doc = await store.read(collectionPath, slug, { resolveReferences: false })
    return {
      ...found,
      side: {
        format: doc.format,
        entryType: located.entryTypeName,
        data: doc.data,
        ...('body' in doc && { body: doc.body, bodyFieldName: doc.bodyFieldName }),
      },
    }
  } catch (err) {
    if (isNotFoundError(err)) return { side: undefined }
    // A filesystem failure (a `syscall` error) is the server's; anything else is this file not
    // parsing, or its entry type's schema failing to load (SchemaUnavailableError). A parser's
    // errors carry a `code` too, so `code` alone doesn't tell them apart.
    if (isNodeError(err) && err.syscall !== undefined) throw err
    return { ...found, side: 'unreadable' }
  }
}

/**
 * The entry at `logicalPath` in `mergeBase`'s tree, matched by `contentId` when there is one.
 * Looked for under the collection's directory first, then the whole content root when that
 * directory isn't in the base tree (a collection renamed or deleted on the branch). Files map
 * to entries as GET /:branch/changes maps them, so the entry it lists resolves to the same
 * file here. A base file whose collection or entry type the schema no longer has is keyed with
 * `afterFields`, the saved side's, so its unchanged items carry the keys the saved side's do.
 */
const readBefore = async (
  git: ReturnType<ApiContext['services']['createGitManagerFor']>,
  mergeBase: string,
  logicalPath: LogicalPath,
  match: { contentId?: string; afterFields?: EntrySchema },
  branchContext: BranchContextWithSchema,
  contentRoot: string,
): Promise<SideRead> => {
  const { flatSchema, branchRoot } = branchContext
  const collectionPath = logicalPath.slice(0, logicalPath.lastIndexOf('/')) as LogicalPath
  const collectionDir = await resolveCollectionPath(branchRoot, collectionPath)
  const dirs = [
    ...(collectionDir ? [path.relative(branchRoot, collectionDir).split(path.sep).join('/')] : []),
    contentRoot,
  ]
  for (const dir of dirs) {
    const files = await git.listFilesWithSizeAt(mergeBase, dir)
    for (const file of files) {
      const placed = entryRefFromRepoPath(file.path, flatSchema, contentRoot)
      const ref =
        placed.kind === 'other' ? entryRefFromRepoPathShape(file.path, contentRoot) : placed
      if (ref?.kind !== 'entry' || ref.logicalPath !== logicalPath) continue
      if (match.contentId !== undefined && ref.contentId !== match.contentId) continue
      if (file.size > MAX_SIDE_BYTES) return 'too-large'
      const entryType = entryTypeIn(flatSchema, ref.collectionPath, ref.entryType)
      const fields = entryType?.schema ?? match.afterFields ?? []
      // An entry type the schema no longer has is parsed by its extension.
      const format =
        entryType?.format ?? FORMATS.find((f) => file.path.endsWith(getFormatExtension(f)))
      if (!format) return 'unreadable'
      const raw = await git.showFile(mergeBase, file.path)
      if (raw === undefined) return undefined
      let parsed: ReturnType<typeof parseEntryParts>
      try {
        parsed = parseEntryParts(raw, format)
      } catch {
        return 'unreadable'
      }
      return {
        format,
        entryType: ref.entryType,
        // Keyed as ContentStore.read keys the working tree's side, so an item unchanged since the
        // base carries the same key on both.
        data: withItemKeys(fields, parsed.data, 'content'),
        ...(parsed.body !== undefined && {
          body: parsed.body,
          bodyFieldName: findBodyFieldName(fields),
        }),
      }
    }
    // The collection's directory is in the base tree, so an entry not in it is new.
    if (files.length > 0) return undefined
  }
  return undefined
}

const entryChangeHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof entryChangeParamsSchema>,
): Promise<BranchEntryChangeResponse> => {
  const { branchContext } = gc
  const { config } = ctx.services
  const base = branchContext.branch.baseBranch ?? baseBranchOf(config)
  const contentRoot = config.contentRoot || 'content'
  const notComparable: BranchEntryChangeResponse = {
    ok: false,
    status: 404,
    error: NOT_COMPARABLE_ERROR,
  }

  if (
    getBranchProtection(config, branchContext.branch.name, branchContext.branch.baseBranch)
      .isProtected
  ) {
    return notComparable
  }
  const store = new ContentStore(branchContext.branchRoot, branchContext.flatSchema, {
    contentRootName: contentRoot,
  })
  const target = canonicalPath(store, underContentRoot(params.entryPath, contentRoot))
  const from =
    params.from === undefined
      ? undefined
      : canonicalPath(store, underContentRoot(params.from, contentRoot))
  // A path this user can't read answers as one with nothing to compare, so the answer never
  // says the entry exists.
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )
  if (
    !checkAccess(target.logicalPath, 'read').allowed ||
    (from !== undefined && !checkAccess(from.logicalPath, 'read').allowed)
  ) {
    return notComparable
  }

  const git = ctx.services.createGitManagerFor(branchContext.branchRoot, {
    baseBranch: branchContext.branch.baseBranch,
  })
  let read: SteadyRead<{ mergeBase: string; before: SideRead; after: SideRead } | null>
  try {
    read = await readWhileSteady(branchContext.branchRoot, git, async () => {
      const mergeBase = await git.mergeBaseWithBase()
      if (!mergeBase) return null
      const after = await readAfter(store, branchContext.flatSchema, target, params.id)
      const before = await readBefore(
        git,
        mergeBase,
        (from ?? target).logicalPath,
        { contentId: params.id ?? after.contentId, afterFields: after.fields },
        branchContext,
        contentRoot,
      )
      return { mergeBase, before, after: after.side }
    })
  } catch (err) {
    if (err instanceof BaseBranchMissingError) return notComparable
    return branchReadFailedResponse(branchContext.branch.name, base, err)
  }
  if (!read.steady) return unsteadyReadResponse(read.reason, base)
  if (!read.value) return notComparable
  const { mergeBase, before, after } = read.value
  if (before === 'too-large' || after === 'too-large') {
    return { ok: false, status: 413, error: TOO_LARGE_ERROR }
  }
  if (before === 'unreadable' || after === 'unreadable') {
    return { ok: false, status: 422, error: UNREADABLE_ERROR }
  }
  if (!before && !after) return notComparable
  return {
    ok: true,
    status: 200,
    data: { before: before ?? null, after: after ?? null, mergeBaseSha: mergeBase },
  }
}

/**
 * One entry's saved state on the branch against the commit the branch forked from, for the
 * editor's "Show changes". A moved entry takes `from`, its path at the base; `id` pins both
 * sides to one content id.
 * GET /:branch/changes/...entryPath
 * @internal Exported for tests.
 */
export const readBranchEntryChange = defineEndpoint({
  namespace: 'changes',
  name: 'entry',
  method: 'GET',
  path: '/:branch/changes/...entryPath',
  params: entryChangeParamsSchema,
  responseType: 'BranchEntryChangeResponse',
  response: {} as BranchEntryChangeResponse,
  defaultMockData: { before: null, after: null, mergeBaseSha: '' },
  guards: ['branchAccessWithSchema'] as const,
  handler: entryChangeHandler,
})

export const BRANCH_ENTRY_CHANGE_ROUTES = {
  entry: readBranchEntryChange,
} as const
