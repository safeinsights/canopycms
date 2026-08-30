import { loadBranchContext, loadOrCreateBranchContext } from './branch-workspace'
import { ContentStore, ContentStoreError } from './content-store'
import {
  resolveBranchPaths,
  type ContentId,
  type LogicalPath,
  type PhysicalPath,
  type Slug,
} from './paths'
import { trimSlashes } from './paths/normalize'
import { isIndexSlug } from './utils/entry-url'
import { type OperatingMode } from './operating-mode'
import type { CanopyServices } from './services'
import type { BranchContext } from './types'
import type { CanopyUser } from './user'
import { isDeployedStatic, isBuildMode } from './build-mode'
import { isNotFoundError } from './utils/error'
import { resolveEntryLinksInData } from './entry-link-resolver'

export interface ContentReaderOptions {
  services: CanopyServices
  basePathOverride?: string
  defaultBranch?: string
  createdBy?: string
  allowCreateBranch?: boolean
  getBranchContext?: (branch: string) => Promise<BranchContext | null>
}

export interface ReadContentInput {
  /**
   * Resolved schema path (e.g., content/posts or content/home). An entry-TYPE path like
   * `content/home` is valid and resolves that singleton -- except under `urlAddressableOnly`
   * below, which rejects it.
   */
  entryPath: LogicalPath
  slug?: Slug
  branch?: string
  /** User making the request. Required - use ANONYMOUS_USER for public access. */
  user: CanopyUser
  /** Whether to automatically resolve reference fields. Defaults to true. */
  resolveReferences?: boolean
  /** Whether to resolve entry:ID links in body/markdown fields. Defaults to true. */
  resolveEntryLinks?: boolean
  /**
   * This read is addressing an entry by its PUBLISHED URL, so accept only what enumeration
   * publishes. Two rules, both off by default:
   *
   * 1. `entryPath` must be a COLLECTION. A published URL is `/<collectionSegments>/<slug>` (or
   *    the collapsed collection path, for an index entry), so its non-slug segments are always
   *    collection names. An `entryPath` that resolves to an entry-TYPE item instead would be
   *    delegated by `ContentStore.buildPaths` to the parent collection -- answering at
   *    `/<collection>/<typeName>` and `/<collection>/<typeName>/<slug>`, neither of which any
   *    forward surface emits.
   * 2. The resolved entry's type must be one its collection declares, matching the
   *    `parseTypedFilename(filename, collection.entries)` check `listEntries` applies. A legacy
   *    untyped file has no type token to fail on -- see `declaresEntryType`.
   *
   * Set by `readByUrlPath` and nothing else. Note what it does NOT do: `read({ entryPath:
   * 'content/home' })` and direct `ContentStore` use keep the entry-type delegation, which is a
   * supported API and the only way to address a singleton structurally. Misusing this flag can
   * only make a read stricter, never looser.
   */
  urlAddressableOnly?: boolean
}

/**
 * Structural metadata surfaced alongside a resolved content read. Shared by
 * `ContentReader['read']` here and by `CanopyBuildContext`'s `read`/`readByUrlPath`
 * (context.ts), which both wrap this same reader.
 */
export interface ContentReadMeta {
  /**
   * Absolute filesystem path to the resolved entry file. It is **server-only**
   * -- do not serialize it to the client or embed it in public output, as it
   * reveals the deployment's filesystem layout (home dir / EFS mount / branch
   * name).
   */
  physicalPath: PhysicalPath
  /**
   * The resolved entry type name, read from the entry's own filename
   * (`{type}.{slug}.{id}.{ext}`) -- immutable once the file is created, and
   * NOT re-validated against the collection's current `entries` config on
   * every read. It is therefore usually, but not guaranteed to be, a key in
   * the collection's `entries` config: it can diverge if an entry type was
   * renamed or removed from the schema after files using the old name were
   * created, or if the file was hand-authored with an unrecognized type
   * token.
   *
   * For a legacy entry file predating embedded-type filenames (`{slug}.{ext}`),
   * there is no type recorded on disk at all -- `entryType` silently falls
   * back to the collection's DEFAULT entry type, which may or may not be what
   * the file actually is. `entryId` being `undefined` (below) is the signal
   * that this happened: when `entryId` is `undefined`, `entryType` is
   * inferred rather than read.
   */
  entryType: string
  /**
   * The entry's 12-char Base58 content ID, when the resolved file carries one.
   * Undefined only for legacy entry files predating embedded-ID filenames
   * (`{slug}.{ext}` rather than `{type}.{slug}.{id}.{ext}`) -- see the
   * `entryType` caveat above for what that implies about it.
   */
  entryId?: ContentId
}

export interface ContentReader {
  read: <T = unknown>(
    input: ReadContentInput,
    message?: string,
  ) => Promise<{
    data: T
    path: string
    meta: ContentReadMeta
  }>
}

/**
 * Server-side helper to read content directly from a branch workspace.
 * Falls back to creating the branch workspace (metadata + checkout) if missing.
 */
export const createContentReader = (options: ContentReaderOptions): ContentReader => {
  const services = options.services
  const operatingMode: OperatingMode = services.config.mode
  const basePathOverride = options.basePathOverride
  const defaultBranch =
    options.defaultBranch ??
    services.config.defaultActiveBranch ??
    services.config.defaultBaseBranch ??
    'main'
  const allowCreateBranch = options.allowCreateBranch ?? true
  const createdBy = options.createdBy ?? 'canopycms-content-reader'

  const resolveBranchContext = async (branchName: string): Promise<BranchContext> => {
    // Static deployments read from the checkout: loadOrCreateBranchContext returns a
    // synthetic cwd context without git ops, regardless of allowCreateBranch.
    if (isDeployedStatic(services.config)) {
      return loadOrCreateBranchContext({
        config: services.config,
        branchName,
        mode: operatingMode,
        basePathOverride,
        createdBy,
        remoteUrl: services.config.defaultRemoteUrl,
      })
    }

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
    if (!existing) throw new ContentStoreError(`Branch not found: ${branchName}`, 'NOT_FOUND')
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
      store: new ContentStore(branchRoot, branchFlatSchema, { contentRootName }),
    }
  }

  const resolveTarget = (input: ReadContentInput) => {
    const entryPath = input.entryPath
    if (!entryPath) {
      throw new ContentStoreError('entryPath is required', 'VALIDATION')
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
  const contentRoot = trimSlashes(services.config.contentRoot ?? 'content')
  // The `val === contentRoot` branch matters as much as the prefix one: a root-level entry's
  // collectionPath IS the content root, which does not start with `${contentRoot}/`, so without
  // it the root index reported `path: '/content'` (and a root entry `/content/about`) -- paths
  // that resolve to nothing. `computeEntryUrl` has always had both branches; this had one.
  //
  // Both branches stay guarded on `contentRoot` so an empty one passes the value through
  // unchanged, exactly as `computeEntryUrl` does. Unreachable today (`contentRootSchema` is
  // `relativePathSchema.default('content')` with `.min(1)`), but a blanket short-circuit would
  // be the WRONG answer if it ever were reachable -- it would flatten every entry to root.
  const stripRoot = (val: string) =>
    contentRoot && val === contentRoot
      ? ''
      : contentRoot && val.startsWith(`${contentRoot}/`)
        ? val.slice(contentRoot.length + 1)
        : val

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
    // An index entry's URL is its COLLECTION's path. Without this collapse `path` handed back
    // `/docs/index` for an entry advertised at `/docs` -- `resolveUrlPathCandidates`
    // deliberately does not resolve the former, so a caller linking `path` linked to a 404.
    // Same index decision as computeEntryUrl/listEntries/buildPreviewSrc, through the same
    // predicate. NOTE this builder still keeps its own content-root strip and its own encoding
    // rather than delegating wholesale -- see .claude/future-tasks/default-build-path-url-rule-copy.md.
    const encodedSlug = isIndexSlug(opts.slug) ? '' : encodeSlug(opts.slug)
    const url = encodedSlug ? `${trimmed}/${encodedSlug}` : trimmed || '/'
    return appendBranch(url)
  }

  const readDocument = async (input: ReadContentInput) => {
    const { entryPath, slug, branchName, user } = resolveTarget(input)
    const { context, branchRoot, store } = await resolveStore(branchName)

    // Rule 1 of urlAddressableOnly (see ReadContentInput): a published URL's non-slug segments
    // are collection names, so a candidate landing on an entry-TYPE item can only ever produce a
    // URL enumeration never emits. NO_SCHEMA_ITEM is what assertCollection raises for exactly
    // this condition, and readByUrlPath treats it as a miss and tries the next candidate.
    if (input.urlAddressableOnly && !store.isCollectionPath(entryPath)) {
      throw new ContentStoreError(`Path is not a collection: ${entryPath}`, 'NO_SCHEMA_ITEM')
    }

    // Get the path WITHOUT reading the file
    let relativePath: PhysicalPath
    // Absolute filesystem path to the entry file. Surfaced on read() / readByUrlPath()
    // for server-side colocated-artifact reads (e.g. a sibling profile.json). Already
    // computed here for permission checks; just carried through.
    let physicalPath: PhysicalPath
    // Entry type + content ID are already resolved as part of path resolution
    // (buildPaths() derives both from the schema item / filename) — surfaced on
    // read() / readByUrlPath() so callers can route or key by them without a
    // separate listEntries lookup or filename parse.
    let entryType: string
    let entryId: ContentId | undefined
    try {
      const resolved = await store.resolveDocumentPath(entryPath, slug ?? '')
      relativePath = resolved.relativePath
      physicalPath = resolved.absolutePath as PhysicalPath
      // resolveDocumentPath() always sets entryTypeName for a valid schema item
      // (collection entries fall back to 'entry'; entry-type items delegate to
      // their parent collection with their own name), so no further fallback
      // is needed here — id is the one field that can be legitimately absent,
      // for legacy entry files without an embedded ID (see ContentReadMeta).
      entryType = resolved.entryTypeName
      entryId = resolved.id as ContentId | undefined
    } catch (err) {
      const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
      const code = err instanceof ContentStoreError ? err.code : 'VALIDATION'
      throw new ContentStoreError(message, code)
    }

    // Rule 2 of urlAddressableOnly (see ReadContentInput): buildPaths' directory scan matches on
    // slug alone, so it happily returns a file whose type token the collection no longer (or
    // never did) declare -- a file listEntries skips. Checked here rather than inside the scan so
    // the write path can still find, edit and rename it; making it unfindable would make the
    // mistake unrecoverable through the editor.
    if (input.urlAddressableOnly && !store.declaresEntryType(entryPath, entryType)) {
      throw new ContentStoreError(
        `Entry type '${entryType}' is not declared by ${entryPath}`,
        'NO_SCHEMA_ITEM',
      )
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
        if (services.config.mode !== 'prod') {
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
          throw new ContentStoreError(`Forbidden${detail}${groupsHint}`, 'FORBIDDEN')
        }
        throw new ContentStoreError('Forbidden', 'FORBIDDEN')
      }
    }

    // ONLY if permissions pass, read the file
    try {
      const doc = await store.read(entryPath, slug ?? '', {
        resolveReferences: input.resolveReferences ?? true,
      })
      return { doc, store, physicalPath, entryType, entryId }
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
    const result = await readDocument(input)
    if (!result || typeof result.doc !== 'object' || !('data' in result.doc)) {
      const defaultMessage = `Content not found for ${entryPath}${slug ? `/${slug}` : ''} on branch ${branchName}`
      throw new ContentStoreError(message ?? defaultMessage, 'NOT_FOUND')
    }
    const { doc, store, physicalPath, entryType, entryId } = result

    // For md/mdx format, merge the body into the data so callers get a complete object.
    // The field name comes from the schema's isBody flag (defaults to 'body').
    const docRecord = doc as Record<string, unknown>
    const rawData = docRecord.data as Record<string, unknown>
    const body = docRecord.body as string | undefined
    const bodyFieldName = (docRecord.bodyFieldName as string | undefined) ?? 'body'

    // Merge body into data first, then resolve entry links across all fields
    let data = (body != null ? { ...rawData, [bodyFieldName]: body } : rawData) as T

    // Resolve entry:ID links in all string values (body + nested markdown fields)
    if (input.resolveEntryLinks ?? true) {
      const idIndex = await store.idIndex()
      data = resolveEntryLinksInData(data, idIndex, contentRoot, services.config.entryLinkUrl) as T
    }
    const path = buildEntryPath({
      collectionPath: entryPath,
      slug,
      branch: branchName,
    })
    return { data, path, meta: { physicalPath, entryType, entryId } }
  }

  return { read }
}
