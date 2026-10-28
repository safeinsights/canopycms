import type { z } from 'zod'

import type { BranchContextWithSchema } from '../types'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { CollectionSchemaItem } from '../content-listing'
import { entryRefFromRepoPath, parseEntryData, type RepoPathRef } from '../content-listing'
import { defineEndpoint } from './route-builder'
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
  /** The branch shares no history with its base, so nothing could be compared. */
  baseUnavailable?: boolean
  /** Changed files that are neither entries nor collection settings. Admins only. */
  otherFiles?: string[]
}

export type BranchChangesResponse = ApiResponse<BranchChangesData>

/** Deleted entries whose titles are read from the base, one `git show` each. */
const MAX_DELETED_TITLES = 200
const MAX_OTHER_FILES = 200

type FileStatus = 'A' | 'M' | 'D'
type EntryRef = Extract<RepoPathRef, { kind: 'entry' }>
const COLLECTION_STATUS = { A: 'added', M: 'modified', D: 'deleted' } as const

/**
 * Every changed file's status against `mergeBase`: tracked changes plus untracked files as
 * added. A path both deleted from the index and present untracked is a modified file.
 */
const changedFiles = async (
  git: ReturnType<ApiContext['services']['createGitManagerFor']>,
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
  // A half-rebased tree would report the base's own changes as this branch's.
  if (await isRebaseInProgress(branchContext.branchRoot)) {
    return {
      ok: false,
      status: 409,
      error: `This branch is being synced with ${base}. Try again in a moment.`,
    }
  }

  const git = ctx.services.createGitManagerFor(branchContext.branchRoot, {
    baseBranch: branchContext.branch.baseBranch,
  })
  let mergeBase: string | undefined
  try {
    mergeBase = await git.mergeBaseWithBase()
  } catch (err) {
    canopyLogWarn(
      `CanopyCMS: could not find where ${branchContext.branch.name} forked from ${base}:`,
      redactCredentials(getErrorMessage(err)),
    )
  }
  if (!mergeBase) return { ok: true, status: 200, data: { ...empty, baseUnavailable: true } }

  const files = await changedFiles(git, mergeBase)
  const flatSchema = branchContext.flatSchema
  const contentRoot = config.contentRoot || 'content'
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )
  const readable = (logicalPath: LogicalPath) => checkAccess(logicalPath, 'read').allowed

  let hiddenChanges = false
  const entries: BranchChangeEntry[] = []
  const collections: BranchChangesData['collections'] = []
  const otherFiles: string[] = []
  const added = new Map<string, EntryRef>()
  const deleted = new Map<string, EntryRef>()
  const modified: EntryRef[] = []

  for (const [path, status] of files) {
    const ref = entryRefFromRepoPath(path, flatSchema, contentRoot)
    if (ref.kind === 'other') {
      otherFiles.push(ref.physicalPath)
    } else if (ref.kind === 'collection-meta') {
      // `/*`, as entries.ts probes a collection: a rule for its contents decides too.
      if (readable(ref.collectionPath) && readable(`${ref.collectionPath}/*` as LogicalPath)) {
        collections.push({ status: COLLECTION_STATUS[status], logicalPath: ref.collectionPath })
      } else hiddenChanges = true
    } else if (status === 'A') added.set(ref.contentId, ref)
    else if (status === 'D') deleted.set(ref.contentId, ref)
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
  const deletedShown: EntryRef[] = []

  for (const ref of modified) {
    if (readable(ref.logicalPath)) entries.push(toEntry(ref, 'modified'))
    else hiddenChanges = true
  }
  for (const [contentId, ref] of added) {
    const from = deleted.get(contentId)
    if (from) deleted.delete(contentId)
    const toReadable = readable(ref.logicalPath)
    const fromReadable = from ? readable(from.logicalPath) : false
    if (from && from.logicalPath === ref.logicalPath) {
      // The same entry under another entry type.
      if (toReadable) entries.push(toEntry(ref, 'modified'))
      else hiddenChanges = true
    } else if (from && toReadable && fromReadable) {
      entries.push(toEntry(ref, 'moved', from))
    } else {
      // A move with a side this user can't read shows only the side they can, so the other
      // side's path never reaches them.
      if (toReadable) entries.push(toEntry(ref, 'added'))
      if (from && fromReadable) deletedShown.push(from)
      if (!toReadable || (from && !fromReadable)) hiddenChanges = true
    }
  }
  for (const ref of deleted.values()) {
    if (readable(ref.logicalPath)) deletedShown.push(ref)
    else hiddenChanges = true
  }

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
  return {
    ok: true,
    status: 200,
    data: {
      base,
      mergeBaseSha: mergeBase,
      entries,
      collections,
      hiddenChanges,
      ...(isAdmin(req.user.groups) && {
        otherFiles: otherFiles.sort().slice(0, MAX_OTHER_FILES),
      }),
    },
  }
}

/** A deleted entry's title as the listing would have shown it, from its file at `rev`. */
const deletedTitle = async (
  git: ReturnType<ApiContext['services']['createGitManagerFor']>,
  rev: string,
  ref: EntryRef,
  flatSchema: BranchContextWithSchema['flatSchema'],
): Promise<string | undefined> => {
  const collection = flatSchema.find(
    (item): item is CollectionSchemaItem =>
      item.type === 'collection' && item.logicalPath === ref.collectionPath,
  )
  const entryType = collection?.entries?.find((e) => e.name === ref.entryType)
  if (!entryType) return undefined
  try {
    const raw = await git.showFile(rev, ref.physicalPath)
    if (raw === undefined) return undefined
    return resolveEntryTitle(parseEntryData(raw, entryType.format), {
      schema: entryType.schema,
      entryTypeLabel: entryType.label,
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
