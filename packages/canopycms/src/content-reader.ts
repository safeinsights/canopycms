import { loadBranchContext, loadOrCreateBranchContext } from './branch-workspace'
import { ContentStore, ContentStoreError } from './content-store'
import { resolveBranchPaths, type LogicalPath, type PhysicalPath, type EntrySlug } from './paths'
import { type OperatingMode } from './operating-mode'
import type { CanopyServices } from './services'
import type { BranchContext } from './types'
import type { CanopyUser } from './user'
import { isDeployedStatic, isBuildMode } from './build-mode'
import { isNotFoundError } from './utils/error'

export interface ContentReaderOptions {
  services: CanopyServices
  basePathOverride?: string
  defaultBranch?: string
  createdBy?: string
  allowCreateBranch?: boolean
  getBranchContext?: (branch: string) => Promise<BranchContext | null>
}

export interface ReadContentInput {
  /** Resolved schema path (e.g., content/posts or content/home). */
  entryPath: LogicalPath
  slug?: EntrySlug
  branch?: string
  /** User making the request. Required - use ANONYMOUS_USER for public access. */
  user: CanopyUser
  /** Whether to automatically resolve reference fields. Defaults to true. */
  resolveReferences?: boolean
}

export interface ContentReader {
  read: <T = unknown>(
    input: ReadContentInput,
    message?: string,
  ) => Promise<{ data: T; path: string }>
}

/**
 * Server-side helper to read content directly from a branch workspace.
 * Falls back to creating the branch workspace (metadata + checkout) if missing.
 */
export const createContentReader = (options: ContentReaderOptions): ContentReader => {
  const services = options.services
  const operatingMode: OperatingMode = services.config.mode
  const basePathOverride = options.basePathOverride
  const defaultBranch = options.defaultBranch ?? services.config.defaultBaseBranch ?? 'main'
  const allowCreateBranch = options.allowCreateBranch ?? true
  const createdBy = options.createdBy ?? 'canopycms-content-reader'

  const resolveBranchContext = async (branchName: string): Promise<BranchContext> => {
    // Check custom resolver first (e.g., from HTTP handler)
    if (options.getBranchContext) {
      const existing = await options.getBranchContext(branchName)
      if (existing) return existing
    }

    if (allowCreateBranch) {
      return loadOrCreateBranchContext({
        config: services.config,
        branchName,
        mode: operatingMode,
        basePathOverride,
        createdBy,
        remoteUrl: services.config.defaultRemoteUrl,
      })
    }

    // Not allowed to create — must exist
    const existing = await loadBranchContext({
      branchName,
      mode: operatingMode,
      basePathOverride,
    })
    if (!existing) throw new ContentStoreError(`Branch not found: ${branchName}`)
    return existing
  }

  const resolveStore = async (branchName: string) => {
    const context = await resolveBranchContext(branchName)
    const { branchRoot } = resolveBranchPaths(context, operatingMode, basePathOverride)

    // Load per-branch schema dynamically
    const branchSchemaCache = services.branchSchemaCache
    const contentRootName = services.config.contentRoot || 'content'
    const { flatSchema: branchFlatSchema } = await branchSchemaCache.getSchema(
      branchRoot,
      services.entrySchemaRegistry,
      contentRootName,
    )

    return {
      context,
      branchRoot,
      store: new ContentStore(branchRoot, branchFlatSchema),
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

  // Build preview paths using simple path construction
  const contentRoot = (services.config.contentRoot ?? 'content').replace(/^\/+|\/+$/g, '')
  const stripRoot = (val: string) =>
    contentRoot && val.startsWith(`${contentRoot}/`) ? val.slice(contentRoot.length + 1) : val

  const buildEntryPath = (opts: {
    collectionPath: LogicalPath
    slug?: string
    branch?: string
  }) => {
    // Construct preview path from collectionPath
    const stripped = stripRoot(opts.collectionPath)
    const base = stripped ? `/${stripped}` : '/'

    const appendBranch = (url: string) =>
      opts.branch
        ? `${url}${url.includes('?') ? '&' : '?'}branch=${encodeURIComponent(opts.branch)}`
        : url
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
    const encodedSlug = encodeSlug(opts.slug)
    const url = encodedSlug ? `${trimmed}/${encodedSlug}` : trimmed || '/'
    return appendBranch(url)
  }

  const readDocument = async (input: ReadContentInput) => {
    const { entryPath, slug, branchName, user } = resolveTarget(input)
    const { context, branchRoot, store } = await resolveStore(branchName)

    // Get the path WITHOUT reading the file
    let relativePath: PhysicalPath
    try {
      const resolved = await store.resolveDocumentPath(entryPath, slug ?? '')
      relativePath = resolved.relativePath
    } catch (err) {
      const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
      throw new ContentStoreError(message)
    }

    // Check permissions BEFORE reading the file (security)
    const shouldCheckPermissions = !(isDeployedStatic(services.config) || isBuildMode())
    if (shouldCheckPermissions) {
      const access = await services.checkContentAccess(
        context,
        branchRoot,
        relativePath,
        user,
        'read',
      )
      if (!access.allowed) {
        if (services.config.mode === 'dev' || services.config.mode === 'prod-sim') {
          const reasons: string[] = []
          if (!access.branch.allowed) {
            reasons.push(`branch access denied (${access.branch.reason})`)
          }
          if (!access.path.allowed) {
            reasons.push(`path access denied (${access.path.reason ?? 'unknown'})`)
          }
          const detail = reasons.length > 0 ? `: ${reasons.join(', ')}` : ''
          const groupsHint =
            user.groups.length === 0
              ? ' (user has no group memberships — is CANOPY_BOOTSTRAP_ADMIN_IDS configured?)'
              : ''
          throw new ContentStoreError(`Forbidden${detail}${groupsHint}`)
        }
        throw new ContentStoreError('Forbidden')
      }
    }

    // ONLY if permissions pass, read the file
    try {
      return await store.read(entryPath, slug ?? '', {
        resolveReferences: input.resolveReferences ?? true,
      })
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  const read: ContentReader['read'] = async <T = unknown>(
    input: ReadContentInput,
    message?: string,
  ) => {
    const { entryPath, slug, branchName } = resolveTarget(input)
    const doc = await readDocument(input)
    if (!doc || typeof doc !== 'object' || !('data' in doc)) {
      const defaultMessage = `Content not found for ${entryPath}${slug ? `/${slug}` : ''} on branch ${branchName}`
      throw new ContentStoreError(message ?? defaultMessage)
    }
    // For md/mdx format, merge the body into the data so callers get a complete object
    const docRecord = doc as Record<string, unknown>
    const rawData = docRecord.data as Record<string, unknown>
    const body = docRecord.body as string | undefined
    const data = (body != null ? { ...rawData, body } : rawData) as T
    const path = buildEntryPath({
      collectionPath: entryPath,
      slug,
      branch: branchName,
    })
    return { data, path }
  }

  return { read }
}
