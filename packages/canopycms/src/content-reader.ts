import { BranchWorkspaceManager, loadBranchContext } from './branch-workspace'
import { ContentStore, ContentStoreError } from './content-store'
import type { CanopyConfig, FlatSchemaItem } from './config'
import { resolveBranchPaths, type OperatingMode } from './paths'
import { createCanopyServices, type CanopyServices } from './services'
import type { BranchContext } from './types'
import type { CanopyUser } from './user'
import { isBuildMode } from './build-mode'

export interface ContentReaderOptions {
  config?: CanopyConfig
  services?: CanopyServices
  workspaceManager?: BranchWorkspaceManager
  basePathOverride?: string
  defaultBranch?: string
  createdBy?: string
  allowCreateBranch?: boolean
  getBranchContext?: (branch: string) => Promise<BranchContext | null>
}

export interface ReadContentInput {
  /** Resolved schema path (e.g., content/posts or content/home). */
  entryPath: string
  slug?: string
  branch?: string
  /** User making the request. Required - use ANONYMOUS_USER for public access. */
  user: CanopyUser
  /** Whether to automatically resolve reference fields. Defaults to true. */
  resolveReferences?: boolean
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
  const operatingMode: OperatingMode = services.config.mode ?? 'local-simple'
  const basePathOverride = options.basePathOverride
  const workspaceManager = options.workspaceManager ?? new BranchWorkspaceManager(services.config)
  const defaultBranch = options.defaultBranch ?? services.config.defaultBaseBranch ?? 'main'
  const allowCreateBranch = options.allowCreateBranch ?? true
  const createdBy = options.createdBy ?? 'canopycms-content-reader'

  const resolveBranchContext = async (branchName: string): Promise<BranchContext> => {
    const existing = options.getBranchContext
      ? await options.getBranchContext(branchName)
      : await loadBranchContext({ branchName, mode: operatingMode, basePathOverride })
    if (existing) {
      return existing
    }
    if (!allowCreateBranch) {
      throw new ContentStoreError(`Branch not found: ${branchName}`)
    }
    return await workspaceManager.openOrCreateBranch({
      branchName,
      mode: operatingMode,
      basePathOverride,
      createdBy,
      remoteUrl: services.config.defaultRemoteUrl,
    })
  }

  const resolveStore = async (branchName: string) => {
    const context = await resolveBranchContext(branchName)
    const { branchRoot } = resolveBranchPaths(context, operatingMode, basePathOverride)
    return {
      context,
      branchRoot,
      store: new ContentStore(branchRoot, services.flatSchema),
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

  // Cache flattened schema for O(1) lookups
  const flatSchema = services.flatSchema
  const schemaMap = new Map(flatSchema.map((item) => [item.fullPath, item]))

  const encodeSlug = (value?: string): string =>
    (value ?? '')
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/')

  const findSchemaNode = (fullPath: string): FlatSchemaItem | undefined => {
    return schemaMap.get(fullPath)
  }

  // Build preview path mapping once (uses cached flatSchema)
  const contentRoot = (services.config.contentRoot ?? 'content').replace(/^\/+|\/+$/g, '')
  const stripRoot = (val: string) => (contentRoot && val.startsWith(`${contentRoot}/`) ? val.slice(contentRoot.length + 1) : val)
  const baseMap = new Map<string, string>()
  flatSchema.forEach((item) => {
    const base = stripRoot(item.fullPath)
    baseMap.set(item.fullPath, item.type === 'singleton' ? '/' : base ? `/${base}` : '/')
  })

  const buildEntryPath = (opts: { collectionPath: string; slug?: string; branch?: string }) => {
    const baseResolvedPath = opts.collectionPath
    const node = findSchemaNode(baseResolvedPath)
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
    const { context, branchRoot, store } = await resolveStore(branchName)

    // Get the path WITHOUT reading the file
    let relativePath: string
    try {
      relativePath = store.resolveDocumentPath(entryPath, slug ?? '').relativePath
    } catch (err) {
      const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
      throw new ContentStoreError(message)
    }

    // Check permissions BEFORE reading the file (security)
    const shouldCheckPermissions = !isBuildMode()
    if (shouldCheckPermissions) {
      const access = await services.checkContentAccess(context, branchRoot, relativePath, user, 'read')
      if (!access.allowed) {
        throw new ContentStoreError('Forbidden')
      }
    }

    // ONLY if permissions pass, read the file
    try {
      return await store.read(entryPath, slug ?? '', {
        resolveReferences: input.resolveReferences ?? true,
      })
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
