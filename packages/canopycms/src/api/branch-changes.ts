import type { z } from 'zod'

import type { BranchContextWithSchema } from '../types'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { CollectionSchemaItem } from '../content-listing'
import {
  entryRefFromRepoPath,
  entryRefFromRepoPathShape,
  parseEntryData,
  type RepoPathRef,
} from '../content-listing'
import { getFormatExtension } from '../utils/format'
import type { ContentFormat } from '../config'
import { defineEndpoint } from './route-builder'
import { BaseBranchMissingError } from '../git-manager'
import { branchParamSchema } from './validators'
import { getBranchProtection } from '../authorization/protected-branch'
import { isAdmin } from '../authorization/helpers'
import { baseBranchOf } from '../utils/base-branch'
import { isCanopyInternalPath, isRebaseInProgress } from '../utils/git'
import { resolveEntryTitle } from '../utils/title-field'
import { getErrorMessage, redactCredentials } from '../utils/error'
import { canopyLogWarn } from '../utils/logger'
import type { LogicalPath } from '../paths/types'

/** An entry whose saved state on the branch differs from the base branch. */
export interface BranchChangeEntry {
  status: 'added' | 'modified' | 'deleted' | 'moved'
  logicalPath: string
  /** A moved entry's path at the base. */
  previousLogicalPath?: string
  contentId: string
  collectionPath: string
  entryType: string
  /** A deleted entry's title at the base. */
  title?: string
}

export interface BranchChangesData {
  base: string
  mergeBaseSha?: string
  entries: BranchChangeEntry[]
  /** Collections whose settings (`.collection.json`) differ. */
  collections: Array<{ status: 'added' | 'modified' | 'deleted'; logicalPath: string }>
  /** Something changed that this user may not read. Never a count, which would leak its size. */
  hiddenChanges: boolean
  /** The branch and its base share no commit, so there is no fork point to compare against. */
  baseUnavailable?: boolean
  /** The remote no longer has the base branch, so nothing can be compared until it is back. */
  baseMissing?: boolean
  /** Changed files that are neither entries nor collection settings. Admins only. */
  otherFiles?: string[]
  /** `otherFiles` holds only the first {@link MAX_OTHER_FILES}. Admins only. */
  otherFilesTruncated?: boolean
}

export type BranchChangesResponse = ApiResponse<BranchChangesData>

/** Deleted entries whose titles are read from the base, one `git show` each. */
const MAX_DELETED_TITLES = 200
/** Other files listed to an admin; the rest are counted only as `otherFilesTruncated`. */
const MAX_OTHER_FILES = 200

const SYNCING_ERROR = (base: string) =>
  `This branch is being synced with ${base}. Try again in a moment.`
const CHANGED_MID_READ_ERROR =
  'This branch changed while its changes were being read. Try again in a moment.'
const READ_FAILED_ERROR = "Couldn't read this branch's changes right now. Try again in a moment."

type BranchGit = ReturnType<ApiContext['services']['createGitManagerFor']>

/** Why a read of a branch against its base can't be trusted: see {@link readWhileSteady}. */
export type UnsteadyRead = 'syncing' | 'moved'

export type SteadyRead<T> = { steady: true; value: T } | { steady: false; reason: UnsteadyRead }

/**
 * `read`'s result, taken lock-free, or why it can't be trusted: `syncing` while a rebase is
 * under way before or after it, since a half-rebased tree reports the base's own changes as
 * the branch's; `moved` when HEAD moved during it, as a submit's commit does, leaving a mix of
 * two trees.
 */
export const readWhileSteady = async <T>(
  branchRoot: string,
  git: BranchGit,
  read: () => Promise<T>,
): Promise<SteadyRead<T>> => {
  if (await isRebaseInProgress(branchRoot)) return { steady: false, reason: 'syncing' }
  const head = await git.headSha()
  const value = await read()
  if (await isRebaseInProgress(branchRoot)) return { steady: false, reason: 'syncing' }
  if ((await git.headSha()) !== head) return { steady: false, reason: 'moved' }
  return { steady: true, value }
}

/** The 409 for a read {@link readWhileSteady} refused, nothing lost. */
export const unsteadyReadResponse = (reason: UnsteadyRead, base: string): ApiResponse<never> => ({
  ok: false,
  status: 409,
  error: reason === 'syncing' ? SYNCING_ERROR(base) : CHANGED_MID_READ_ERROR,
})

/** The 503 for a git failure, logged with the branch and base it compared. */
export const branchReadFailedResponse = (
  branch: string,
  base: string,
  err: unknown,
): ApiResponse<never> => {
  canopyLogWarn(
    `CanopyCMS: could not read what ${branch} changes against ${base}:`,
    redactCredentials(getErrorMessage(err)),
  )
  return { ok: false, status: 503, error: READ_FAILED_ERROR }
}

type FileStatus = 'A' | 'M' | 'D'
const FORMATS: readonly ContentFormat[] = ['mdx', 'md', 'json', 'yaml']
type EntryRef = Extract<RepoPathRef, { kind: 'entry' }>
const COLLECTION_STATUS = { A: 'added', M: 'modified', D: 'deleted' } as const

/**
 * Every changed file's status against `mergeBase`: tracked changes plus untracked files as
 * added. A path both deleted from the index and present untracked is a modified file.
 */
const changedFiles = async (
  git: BranchGit,
  mergeBase: string,
): Promise<Map<string, FileStatus>> => {
  const [tracked, untracked] = await Promise.all([
    git.diffNameStatusAgainst(mergeBase),
    git.listUntrackedFiles(),
  ])
  const files = new Map<string, FileStatus>()
  for (const { status, path } of tracked) files.set(path, status)
  for (const path of untracked) files.set(path, files.get(path) === 'D' ? 'M' : 'A')
  for (const path of files.keys()) if (isCanopyInternalPath(path)) files.delete(path)
  return files
}

const branchChangesHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchChangesResponse> => {
  const { branchContext } = gc
  const { config } = ctx.services
  const base = branchContext.branch.baseBranch ?? baseBranchOf(config)
  const empty: BranchChangesData = { base, entries: [], collections: [], hiddenChanges: false }

  if (
    getBranchProtection(config, branchContext.branch.name, branchContext.branch.baseBranch)
      .isProtected
  ) {
    return { ok: true, status: 200, data: empty }
  }

  const git = ctx.services.createGitManagerFor(branchContext.branchRoot, {
    baseBranch: branchContext.branch.baseBranch,
  })
  let read: SteadyRead<Omit<BranchChangesData, 'base'> | null>
  try {
    read = await readWhileSteady(branchContext.branchRoot, git, async () => {
      const mergeBase = await git.mergeBaseWithBase()
      return mergeBase ? readChanges(ctx, req, branchContext, git, mergeBase) : null
    })
  } catch (err) {
    if (err instanceof BaseBranchMissingError) {
      return { ok: true, status: 200, data: { ...empty, baseMissing: true } }
    }
    return branchReadFailedResponse(branchContext.branch.name, base, err)
  }
  if (!read.steady) return unsteadyReadResponse(read.reason, base)
  if (!read.value) return { ok: true, status: 200, data: { ...empty, baseUnavailable: true } }
  return { ok: true, status: 200, data: { base, ...read.value } }
}

/** The branch's changes against `mergeBase`, filtered to what `req.user` may read. */
const readChanges = async (
  ctx: ApiContext,
  req: ApiRequest,
  branchContext: BranchContextWithSchema,
  git: BranchGit,
  mergeBase: string,
): Promise<Omit<BranchChangesData, 'base'>> => {
  const files = await changedFiles(git, mergeBase)
  const flatSchema = branchContext.flatSchema
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )
  const readable = (logicalPath: LogicalPath) => checkAccess(logicalPath, 'read').allowed
  const admin = isAdmin(req.user.groups)
  const underContentRoot = (path: string) => path.startsWith(`${contentRoot}/`)

  let hiddenChanges = false
  const entries: BranchChangeEntry[] = []
  const collections: BranchChangesData['collections'] = []
  const otherFiles: string[] = []
  const added = new Map<string, EntryRef[]>()
  const deleted = new Map<string, EntryRef[]>()
  const modified: EntryRef[] = []
  const push = (map: Map<string, EntryRef[]>, ref: EntryRef) =>
    map.set(ref.contentId, [...(map.get(ref.contentId) ?? []), ref])

  for (const [path, status] of files) {
    let ref: RepoPathRef = entryRefFromRepoPath(path, flatSchema, contentRoot)
    // A deleted file the schema no longer places, as under a renamed or deleted collection, is
    // read from its path's shape, so it still reads as deleted or as the old side of a move.
    if (ref.kind === 'other' && status === 'D') {
      ref = entryRefFromRepoPathShape(path, contentRoot) ?? ref
    }
    if (ref.kind === 'other') {
      otherFiles.push(ref.physicalPath)
      // Under the content root it may be content this user can't see placed; never nothing.
      if (!admin && underContentRoot(path)) hiddenChanges = true
    } else if (ref.kind === 'collection-meta') {
      // `/*`, as entries.ts probes a collection: a rule for its contents decides too.
      if (readable(ref.collectionPath) && readable(`${ref.collectionPath}/*` as LogicalPath)) {
        collections.push({ status: COLLECTION_STATUS[status], logicalPath: ref.collectionPath })
      } else hiddenChanges = true
    } else if (status === 'A') push(added, ref)
    else if (status === 'D') push(deleted, ref)
    else modified.push(ref)
  }

  const toEntry = (
    ref: EntryRef,
    status: BranchChangeEntry['status'],
    previous?: EntryRef,
  ): BranchChangeEntry => ({
    status,
    logicalPath: ref.logicalPath,
    ...(previous && { previousLogicalPath: previous.logicalPath }),
    contentId: ref.contentId,
    collectionPath: ref.collectionPath,
    entryType: ref.entryType,
  })
  const addedShown: EntryRef[] = []
  const deletedShown: EntryRef[] = []
  const showAdded = (ref: EntryRef) => {
    if (readable(ref.logicalPath)) addedShown.push(ref)
    else hiddenChanges = true
  }
  const showDeleted = (ref: EntryRef) => {
    if (readable(ref.logicalPath)) deletedShown.push(ref)
    else hiddenChanges = true
  }

  for (const ref of modified) {
    if (readable(ref.logicalPath)) entries.push(toEntry(ref, 'modified'))
    else hiddenChanges = true
  }
  for (const [contentId, adds] of added) {
    const dels = deleted.get(contentId) ?? []
    deleted.delete(contentId)
    // A content id on more than one file on either side is a duplicate, not one entry moving,
    // so its files are listed as they are.
    if (adds.length !== 1 || dels.length !== 1) {
      adds.forEach(showAdded)
      dels.forEach(showDeleted)
      continue
    }
    const [ref] = adds
    const [from] = dels
    const toReadable = readable(ref.logicalPath)
    const fromReadable = readable(from.logicalPath)
    if (from.logicalPath === ref.logicalPath) {
      // The same entry under another entry type.
      if (toReadable) entries.push(toEntry(ref, 'modified'))
      else hiddenChanges = true
    } else if (toReadable && fromReadable) {
      entries.push(toEntry(ref, 'moved', from))
    } else {
      // A move with a side this user can't read shows only the side they can, so the other
      // side's path never reaches them.
      showAdded(ref)
      showDeleted(from)
    }
  }
  for (const dels of deleted.values()) dels.forEach(showDeleted)
  for (const ref of addedShown) entries.push(toEntry(ref, 'added'))

  const titles = await Promise.all(
    deletedShown.map((ref, i) =>
      i < MAX_DELETED_TITLES ? deletedTitle(git, mergeBase, ref, flatSchema) : undefined,
    ),
  )
  deletedShown.forEach((ref, i) => {
    const title = titles[i]
    entries.push({ ...toEntry(ref, 'deleted'), ...(title !== undefined && { title }) })
  })

  entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))
  collections.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))
  otherFiles.sort()
  return {
    mergeBaseSha: mergeBase,
    entries,
    collections,
    hiddenChanges,
    ...(admin && {
      otherFiles: otherFiles.slice(0, MAX_OTHER_FILES),
      otherFilesTruncated: otherFiles.length > MAX_OTHER_FILES,
    }),
  }
}

/** A deleted entry's title as the listing would have shown it, from its file at `rev`. */
const deletedTitle = async (
  git: BranchGit,
  rev: string,
  ref: EntryRef,
  flatSchema: BranchContextWithSchema['flatSchema'],
): Promise<string | undefined> => {
  const collection = flatSchema.find(
    (item): item is CollectionSchemaItem =>
      item.type === 'collection' && item.logicalPath === ref.collectionPath,
  )
  const entryType = collection?.entries?.find((e) => e.name === ref.entryType)
  // An entry the schema no longer places is parsed by its extension, with no field list.
  const format =
    entryType?.format ?? FORMATS.find((f) => ref.physicalPath.endsWith(getFormatExtension(f)))
  if (!format) return undefined
  try {
    const raw = await git.showFile(rev, ref.physicalPath)
    if (raw === undefined) return undefined
    return resolveEntryTitle(parseEntryData(raw, format), {
      schema: entryType?.schema,
      entryTypeLabel: entryType?.label,
      slug: ref.logicalPath.slice(ref.logicalPath.lastIndexOf('/') + 1),
    })
  } catch {
    return undefined
  }
}

/**
 * What this branch changes against its base: its working tree, saved but uncommitted edits
 * included, against the commit it forked from.
 * GET /:branch/changes
 * @internal Exported for tests.
 */
export const listBranchChanges = defineEndpoint({
  namespace: 'changes',
  name: 'list',
  method: 'GET',
  path: '/:branch/changes',
  params: branchParamSchema,
  responseType: 'BranchChangesResponse',
  response: {} as BranchChangesResponse,
  defaultMockData: { base: 'main', entries: [], collections: [], hiddenChanges: false },
  guards: ['branchAccessWithSchema'] as const,
  handler: branchChangesHandler,
})

export const BRANCH_CHANGES_ROUTES = {
  list: listBranchChanges,
} as const
