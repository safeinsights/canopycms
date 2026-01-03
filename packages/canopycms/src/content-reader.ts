import { BranchWorkspaceManager, loadBranchState } from './branch-workspace'
import { ContentStore, ContentStoreError, type ContentDocument } from './content-store'
import type { CanopyConfig, ResolvedSchemaItem } from './config'
import { resolveBranchWorkspace, type BranchMode } from './paths'
import { createCanopyServices, type CanopyServices } from './services'
import type { BranchState } from './types'
import type { CanopyUser } from './user'
import { resolveSchema } from './config'

export interface ContentReaderOptions {
  config?: CanopyConfig
  services?: CanopyServices
  workspaceManager?: BranchWorkspaceManager
  basePathOverride?: string
  defaultBranch?: string
  createdBy?: string
  allowCreateBranch?: boolean
  getBranchState?: (branch: string) => Promise<BranchState | null>
}

export interface ReadContentInput {
  /** Resolved schema path (e.g., content/posts or content/home). */
  entryPath: string
  slug?: string
  branch?: string
  /** User making the request. Required - use ANONYMOUS_USER for public access. */
  user: CanopyUser
}

export interface ContentReader {
  read: <T = unknown>(input: ReadContentInput, message?: string) => Promise<{ data: T; path: string }>
}

/**
 * Server-side helper to read content directly from a branch workspace.
 * Falls back to creating the branch workspace (metadata + checkout) if missing.
 */
export const createContentReader = (options: ContentReaderOptions): ContentReader => {
  if (!options.config && !options.services) {
    throw new Error('canopycms: config or services is required for createContentReader')
  }

  const services = options.services ?? createCanopyServices(options.config!)
  const branchMode: BranchMode = services.config.mode ?? 'local-simple'
  const basePathOverride = options.basePathOverride
  const workspaceManager = options.workspaceManager ?? new BranchWorkspaceManager(services.config)
  const defaultBranch = options.defaultBranch ?? services.config.defaultBaseBranch ?? 'main'
  const allowCreateBranch = options.allowCreateBranch ?? true
  const createdBy = options.createdBy ?? 'canopycms-content-reader'

  const resolveBranchState = async (branchName: string): Promise<BranchState> => {
    const existing = options.getBranchState
      ? await options.getBranchState(branchName)
      : await loadBranchState({ branchName, mode: branchMode, basePathOverride })
    if (existing) return existing
    if (!allowCreateBranch) {
      throw new ContentStoreError(`Branch not found: ${branchName}`)
    }
    const workspace = await workspaceManager.openOrCreateBranch({
      branchName,
      mode: branchMode,
      basePathOverride,
      createdBy,
      remoteUrl: services.config.defaultRemoteUrl,
    })
    return workspace.state
  }

  const resolveStore = async (branchName: string) => {
    const state = await resolveBranchState(branchName)
    const { branchRoot } = resolveBranchWorkspace(state, branchMode, basePathOverride)
    return {
      state,
      branchRoot,
      store: new ContentStore(branchRoot, services.config),
    }
  }

  const resolveTarget = (input: ReadContentInput) => {
    const entryPath = input.entryPath
    if (!entryPath) {
      throw new ContentStoreError('entryPath is required')
    }
    const branchName = input.branch ?? defaultBranch
    return { entryPath, slug: input.slug, branchName, user: input.user }
  }

  const encodeSlug = (value?: string): string =>
    (value ?? '')
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/')

  const findSchemaNode = (fullPath: string): ResolvedSchemaItem | undefined => {
    const resolved = resolveSchema(services.config.schema, services.config.contentRoot)
    const stack: ResolvedSchemaItem[] = [...resolved]
    while (stack.length) {
      const node = stack.pop()!
      if (node.fullPath === fullPath) return node
      if (node.children) stack.push(...node.children)
    }
    return undefined
  }

  const buildEntryPath = (opts: { collectionPath: string; slug?: string; branch?: string }) => {
    const baseResolvedPath = opts.collectionPath
    const node = findSchemaNode(baseResolvedPath)
    const contentRoot = (services.config.contentRoot ?? 'content').replace(/^\/+|\/+$/g, '')
    const stripRoot = (val: string) => (contentRoot && val.startsWith(`${contentRoot}/`) ? val.slice(contentRoot.length + 1) : val)
    const baseMap = new Map<string, string>()

    const resolvedSchema = resolveSchema(services.config.schema, services.config.contentRoot)
    const collect = (nodes: ResolvedSchemaItem[]) => {
      nodes.forEach((n) => {
        const base = stripRoot(n.fullPath)
        baseMap.set(n.fullPath, n.type === 'singleton' ? '/' : base ? `/${base}` : '/')
        if (n.children) collect(n.children)
      })
    }
    collect(resolvedSchema)

    const base = baseMap.get(baseResolvedPath) ?? '/'
    const appendBranch = (url: string) =>
      opts.branch ? `${url}${url.includes('?') ? '&' : '?'}branch=${encodeURIComponent(opts.branch)}` : url
    if (node?.type === 'singleton') {
      return appendBranch(base || '/')
    }
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
    const encodedSlug = encodeSlug(opts.slug)
    const url = encodedSlug ? `${trimmed}/${encodedSlug}` : trimmed || '/'
    return appendBranch(url)
  }

  const readDocument = async (input: ReadContentInput) => {
    const { entryPath, slug, branchName, user } = resolveTarget(input)
    const { state, branchRoot, store } = await resolveStore(branchName)

    let relativePath: string
    try {
      relativePath = store.resolveDocumentPath(entryPath, slug ?? '').relativePath
    } catch (err) {
      const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
      throw new ContentStoreError(message)
    }

    const access = await services.checkContentAccess(state, branchRoot, relativePath, user, 'read')
    if (!access.allowed) {
      throw new ContentStoreError('Forbidden')
    }

    try {
      return await store.read(entryPath, slug ?? '')
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null
      throw err
    }
  }

  const read: ContentReader['read'] = async <T = unknown>(
    input: ReadContentInput,
    message?: string
  ) => {
    const { entryPath, slug, branchName } = resolveTarget(input)
    const doc = await readDocument(input)
    if (!doc || typeof doc !== 'object' || !('data' in doc)) {
      const defaultMessage = `Content not found for ${entryPath}${slug ? `/${slug}` : ''} on branch ${branchName}`
      throw new ContentStoreError(message ?? defaultMessage)
    }
    const data = (doc as any).data as T
    const path = buildEntryPath({ collectionPath: entryPath, slug, branch: branchName })
    return { data, path }
  }

  return { read }
}
