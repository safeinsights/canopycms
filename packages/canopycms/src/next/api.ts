import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { createCanopyServices, type CanopyServices } from '../services'
import type { CanopyConfig } from '../config'
import { BranchRegistry } from '../branch-registry'
import type { ApiContext } from '../api/types'
import { createBranch, listBranches } from '../api/branch'
import { getBranchStatus, submitBranchForMerge } from '../api/branch-status'
import { withdrawBranch } from '../api/branch-withdraw'
import { requestChanges, approveBranch } from '../api/branch-review'
import { markAsMerged } from '../api/branch-merge'
import { readContent, writeContent } from '../api/content'
import { deleteAsset, listAssets, uploadAsset } from '../api/assets'
import { listEntries } from '../api/entries'
import { listComments, addComment, resolveComment } from '../api/comments'
import { getPermissions, updatePermissions, searchUsers, listGroups } from '../api/permissions'
import { getInternalGroups, updateInternalGroups, searchExternalGroups } from '../api/groups'
import type { BranchState } from '../types'
import { getDefaultBranchBase } from '../paths'
import { loadBranchState } from '../branch-workspace'
import { AuthPlugin } from '../auth'

export type CanopyNextHandler =
  | typeof createBranch
  | typeof listBranches
  | typeof getBranchStatus
  | typeof submitBranchForMerge
  | typeof withdrawBranch
  | typeof requestChanges
  | typeof approveBranch
  | typeof markAsMerged
  | typeof readContent
  | typeof writeContent
  | typeof listAssets
  | typeof uploadAsset
  | typeof deleteAsset
  | typeof listEntries
  | typeof listComments
  | typeof addComment
  | typeof resolveComment
  | typeof getPermissions
  | typeof updatePermissions
  | typeof searchUsers
  | typeof listGroups
  | typeof getInternalGroups
  | typeof updateInternalGroups
  | typeof searchExternalGroups

export interface CanopyNextOptions {
  services?: CanopyServices
  config?: CanopyConfig
  getUser?: (req: NextRequest) => Promise<{ userId: string; groups?: string[]; role?: string }>
  assetStore?: ApiContext['assetStore']
  getBranchState?: (branch: string) => Promise<BranchState | null>
  authPlugin?: AuthPlugin
}

const defaultGetUser = async (_req: NextRequest) => ({ id: 'anonymous' })
const toRequestUser = (user: { userId?: string; id?: string; groups?: string[]; role?: string }) => ({
  userId: user.userId ?? user.id ?? 'anonymous',
  groups: user.groups,
  role: user.role,
})

const buildContext = async (options: CanopyNextOptions): Promise<ApiContext> => {
  const services =
    options.services ?? (options.config ? createCanopyServices(options.config) : undefined)
  if (!services) {
    throw new Error('canopycms/next: config or services is required')
  }
  const branchMode = services.config.mode ?? 'local-simple'
  const registry = services.registry ?? new BranchRegistry(getDefaultBranchBase(branchMode))
  const getBranchState =
    options.getBranchState ??
    (async (branch: string) => (await loadBranchState({ branchName: branch, mode: branchMode, registry })) ?? null)
  return {
    services,
    assetStore: options.assetStore,
    getBranchState,
    authPlugin: options.authPlugin,
  }
}

export const adaptCanopyHandler = (handler: CanopyNextHandler, options: CanopyNextOptions = {}) => {
  return async (req: NextRequest, params?: Record<string, string>) => {
    const ctx = await buildContext(options)
    const userRaw = options.getUser ? await options.getUser(req) : await defaultGetUser(req)
    const searchParams =
      (req as any)?.nextUrl?.searchParams ??
      (req.url ? new URL(req.url, 'http://localhost').searchParams : undefined)
    const queryParams = searchParams ? Object.fromEntries(searchParams.entries()) : undefined
    const mergedParams = { ...(queryParams ?? {}), ...(params ?? {}) }
    let body: any
    if (req.method !== 'GET') {
      try {
        body = await req.json()
      } catch {
        // No body or invalid JSON, treat as undefined
        body = undefined
      }
    }
    const branch = (mergedParams as any)?.branch ?? (body as any)?.branch
    const apiReq = { user: toRequestUser(userRaw), body, branch }
    const result = await handler(ctx as any, apiReq as any, mergedParams as any)
    return NextResponse.json(result, { status: result.status })
  }
}

type CanopyRouteHandler = (
  req: NextRequest,
  params?: Record<string, string>
) => Promise<ReturnType<typeof NextResponse.json>>

const ROUTE_SEP = '|'
const routeKey = (method: string, segments: string[]) => `${method.toUpperCase()}${ROUTE_SEP}${segments.join('/')}`

const buildRouteMap = (options: CanopyNextOptions): Record<string, CanopyRouteHandler> => {
  const withOptions = <T extends CanopyNextHandler>(handler: T) => adaptCanopyHandler(handler, options)

  return {
    [routeKey('GET', ['branches'])]: withOptions(listBranches),
    [routeKey('POST', ['branches'])]: withOptions(createBranch),
    [routeKey('GET', [':branch', 'status'])]: withOptions(getBranchStatus),
    [routeKey('POST', [':branch', 'submit'])]: withOptions(submitBranchForMerge),
    [routeKey('POST', [':branch', 'withdraw'])]: withOptions(withdrawBranch),
    [routeKey('POST', [':branch', 'request-changes'])]: withOptions(requestChanges),
    [routeKey('POST', [':branch', 'approve'])]: withOptions(approveBranch),
    [routeKey('POST', [':branch', 'mark-merged'])]: withOptions(markAsMerged),

    [routeKey('GET', [':branch', 'comments'])]: withOptions(listComments),
    [routeKey('POST', [':branch', 'comments'])]: withOptions(addComment),
    [routeKey('POST', [':branch', 'comments', ':threadId', 'resolve'])]: withOptions(resolveComment),

    [routeKey('GET', [':branch', 'content', ':collection', '...slug'])]: withOptions(readContent),
    [routeKey('PUT', [':branch', 'content', ':collection', '...slug'])]: withOptions(writeContent),

    [routeKey('GET', ['assets'])]: withOptions(listAssets),
    [routeKey('POST', ['assets'])]: withOptions(uploadAsset),
    [routeKey('DELETE', ['assets'])]: withOptions(deleteAsset),

    [routeKey('GET', [':branch', 'entries'])]: withOptions(listEntries),

    [routeKey('GET', ['permissions'])]: withOptions(getPermissions),
    [routeKey('PUT', ['permissions'])]: withOptions(updatePermissions),
    [routeKey('GET', ['users', 'search'])]: withOptions(searchUsers),
    [routeKey('GET', ['groups'])]: withOptions(listGroups),
    [routeKey('GET', ['groups', 'internal'])]: withOptions(getInternalGroups),
    [routeKey('PUT', ['groups', 'internal'])]: withOptions(updateInternalGroups),
    [routeKey('GET', ['groups', 'search'])]: withOptions(searchExternalGroups),
  }
}

const matchDynamic = (key: string, actual: string[]): { params: Record<string, string> } | null => {
  const parts = key.slice(key.indexOf(ROUTE_SEP) + 1).split('/')
  const params: Record<string, string> = {}
  const actualCopy = [...actual]
  for (const part of parts) {
    if (part === '...slug') {
      params.slug = actualCopy.join('/')
      actualCopy.length = 0
      break
    }
    const next = actualCopy.shift()
    if (!next) return null
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(next)
    } else if (part !== next) {
      return null
    }
  }
  if (actualCopy.length > 0) return null
  return { params }
}

const findRoute = (
  map: Record<string, CanopyRouteHandler>,
  method: string,
  segments: string[]
): { handler: CanopyRouteHandler; params: Record<string, string> } | null => {
  const exactKey = routeKey(method, segments)
  if (map[exactKey]) {
    return { handler: map[exactKey], params: {} }
  }
  for (const key of Object.keys(map)) {
    const maybe = matchDynamic(key, segments)
    if (maybe && key.startsWith(method.toUpperCase())) {
      return { handler: map[key], params: maybe.params }
    }
  }
  return null
}

/**
 * Catch-all Next.js handler for a single API route (e.g., /api/canopycms/[...canopycms]).
 * It maps to the built-in handlers and uses host-provided config/services.
 */
export const createCanopyCatchAllHandler = (options: CanopyNextOptions = {}) => {
  const routes = buildRouteMap(options)
  return async (req: NextRequest, ctx?: { params?: { canopycms?: string[]; [key: string]: any } }) => {
    const segments = (ctx?.params?.canopycms ?? []).filter(Boolean)
    const match = findRoute(routes, req.method, segments)
    if (!match) {
      return NextResponse.json({ ok: false, status: 404, error: 'Not found' }, { status: 404 })
    }
    return match.handler(req, match.params)
  }
}

/**
 * Convenience to build a catch-all handler from a CanopyConfig without manually
 * creating services in the host app.
 */
export const createCanopyHandler = (
  options: { config: CanopyConfig } & Omit<CanopyNextOptions, 'services' | 'config'>
) => createCanopyCatchAllHandler({ ...options, services: createCanopyServices(options.config) })

export const canopyHandlers = {
  createBranch: (options?: CanopyNextOptions) => adaptCanopyHandler(createBranch, options),
  listBranches: (options?: CanopyNextOptions) => adaptCanopyHandler(listBranches, options),
  getBranchStatus: (options?: CanopyNextOptions) => adaptCanopyHandler(getBranchStatus, options),
  submitBranchForMerge: (options?: CanopyNextOptions) => adaptCanopyHandler(submitBranchForMerge, options),
  readContent: (options?: CanopyNextOptions) => adaptCanopyHandler(readContent, options),
  writeContent: (options?: CanopyNextOptions) => adaptCanopyHandler(writeContent, options),
  listAssets: (options?: CanopyNextOptions) => adaptCanopyHandler(listAssets, options),
  uploadAsset: (options?: CanopyNextOptions) => adaptCanopyHandler(uploadAsset, options),
  deleteAsset: (options?: CanopyNextOptions) => adaptCanopyHandler(deleteAsset, options),
  listEntries: (options?: CanopyNextOptions) => adaptCanopyHandler(listEntries, options),
}

export {
  createContentReader,
  type ContentReader,
  type ContentReaderOptions,
  type ReadContentInput,
} from '../content-reader'
