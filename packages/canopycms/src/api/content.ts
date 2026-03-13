import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { ContentStore, ContentStoreError, getDefaultEntryType } from '../content-store'
import type { EntrySchema, EntryTypeConfig, FlatSchemaItem } from '../config'
import { defineEndpoint } from './route-builder'
import { ReferenceValidator } from '../validation/reference-validator'
import { branchNameSchema, logicalPathSchema, entrySlugSchema } from './validators'
import type { LogicalPath, EntrySlug, PhysicalPath } from '../paths'

/** Response type for content read operations */
export type ContentReadResponse = ApiResponse<{
  format: string
  data: Record<string, unknown>
  body?: string
}>

/** Response type for content write operations */
export type ContentWriteResponse = ApiResponse<{
  format: string
  data: Record<string, unknown>
  body?: string
}>

/** Response type for reference validation */
export type ReferenceValidationResponse = ApiResponse<{
  valid: boolean
  errors?: Array<{
    field: string
    fieldPath: string
    id: string
    error: string
  }>
}>

/** Response type for entry rename operations */
export type RenameEntryResponse = ApiResponse<{
  newPath: string
}>

export interface WriteContentBody {
  format: 'json' | 'md' | 'mdx'
  data?: Record<string, unknown>
  body?: string
}

export interface ValidateReferencesBody {
  data: Record<string, unknown>
}

export interface RenameEntryBody {
  newSlug: string
}

/** Response type for reference options - re-exported for convenience */
export type { ReferenceOptionsResponse } from './reference-options'

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const readContentParamsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
})

const writeContentParamsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
  entryType: z.string().optional(), // Optional entry type name for collections with multiple entry types
})

const writeContentBodySchema = z.object({
  format: z.enum(['json', 'md', 'mdx']),
  data: z.record(z.unknown()).optional(),
  body: z.string().optional(),
})

const validateReferencesParamsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
  entryType: z.string().optional(),
})

const validateReferencesBodySchema = z.object({
  data: z.record(z.unknown()),
})

const renameEntryParamsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
})

const renameEntryBodySchema = z.object({
  newSlug: entrySlugSchema,
})

const readContentHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof readContentParamsSchema>,
): Promise<ContentReadResponse> => {
  const context = await ctx.getBranchContext(params.branch, { loadSchema: true })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const flatSchema = context.flatSchema!
  const store = new ContentStore(context.branchRoot, flatSchema)

  // Parse path segments: params.path is like "content/posts/hello"
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const pathSegments = params.path.split('/').filter(Boolean)

  // Prepend contentRoot if not already present
  const logicalPathSegments =
    pathSegments[0] === contentRoot ? pathSegments : [contentRoot, ...pathSegments]

  // Use trivial path resolution
  let schemaItem: FlatSchemaItem
  let slug: EntrySlug
  let relativePath: PhysicalPath
  try {
    const resolved = store.resolvePath(logicalPathSegments)
    schemaItem = resolved.schemaItem
    slug = resolved.slug
    const pathResult = await store.resolveDocumentPath(schemaItem.logicalPath, slug)
    relativePath = pathResult.relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: message }
  }

  const access = await ctx.services.checkContentAccess(
    context,
    context.branchRoot,
    relativePath,
    req.user,
    'read',
  )
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const doc = await store.read(schemaItem.logicalPath, slug)
  return { ok: true, status: 200, data: doc }
}

const writeContentHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof writeContentParamsSchema>,
  body: z.infer<typeof writeContentBodySchema>,
): Promise<ContentWriteResponse> => {
  const context = await ctx.getBranchContext(params.branch, { loadSchema: true })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const flatSchema = context.flatSchema!
  const store = new ContentStore(context.branchRoot, flatSchema)

  // Parse path segments: params.path is like "content/posts/hello" or "posts/hello"
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const pathSegments = params.path.split('/').filter(Boolean)

  // Prepend contentRoot if not already present
  const logicalPathSegments =
    pathSegments[0] === contentRoot ? pathSegments : [contentRoot, ...pathSegments]

  // Use trivial path resolution
  let schemaItem: FlatSchemaItem
  let slug: EntrySlug
  let relativePath: PhysicalPath
  try {
    const resolved = store.resolvePath(logicalPathSegments)
    schemaItem = resolved.schemaItem
    slug = resolved.slug
    const pathResult = await store.resolveDocumentPath(schemaItem.logicalPath, slug)
    relativePath = pathResult.relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: message }
  }

  const access = await ctx.services.checkContentAccess(
    context,
    context.branchRoot,
    relativePath,
    req.user,
    'edit',
  )
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  try {
    const result =
      body.format === 'json'
        ? await store.write(
            schemaItem.logicalPath,
            slug,
            {
              format: 'json',
              data: body.data ?? {},
            },
            params.entryType,
          )
        : await store.write(
            schemaItem.logicalPath,
            slug,
            {
              format: body.format,
              data: body.data,
              body: body.body ?? '',
            },
            params.entryType,
          )

    return { ok: true, status: 200, data: result }
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Write failed'
    return { ok: false, status: 400, error: message }
  }
}

const validateReferencesHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof validateReferencesParamsSchema>,
  body: z.infer<typeof validateReferencesBodySchema>,
): Promise<ReferenceValidationResponse> => {
  const context = await ctx.getBranchContext(params.branch, { loadSchema: true })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const flatSchema = context.flatSchema!
  const store = new ContentStore(context.branchRoot, flatSchema)

  // Parse path segments to get collection/schema info
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const pathSegments = params.path.split('/').filter(Boolean)

  const logicalPathSegments =
    pathSegments[0] === contentRoot ? pathSegments : [contentRoot, ...pathSegments]

  let schemaItem: FlatSchemaItem
  let relativePath: PhysicalPath
  try {
    const resolved = store.resolvePath(logicalPathSegments)
    schemaItem = resolved.schemaItem
    const slug = resolved.slug
    const pathResult = await store.resolveDocumentPath(schemaItem.logicalPath, slug)
    relativePath = pathResult.relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: message }
  }

  const access = await ctx.services.checkContentAccess(
    context,
    context.branchRoot,
    relativePath,
    req.user,
    'read',
  )
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  // Get ID index (automatically loads if needed)
  const idIndex = await store.idIndex()

  // Resolve fields from entry type schema
  let fields: EntrySchema = []
  if (schemaItem.type === 'entry-type') {
    fields = schemaItem.schema
  } else {
    let entryTypeConfig: EntryTypeConfig | undefined
    if (params.entryType) {
      entryTypeConfig = schemaItem.entries?.find((e) => e.name === params.entryType)
    } else {
      entryTypeConfig = getDefaultEntryType(schemaItem.entries)
    }
    fields = entryTypeConfig?.schema || []
  }

  // Validate references
  const validator = new ReferenceValidator(idIndex, fields)
  const result = await validator.validate(body.data)

  return {
    ok: true,
    status: 200,
    data: {
      valid: result.valid,
      errors: result.errors.length > 0 ? result.errors : undefined,
    },
  }
}

const renameEntryHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof renameEntryParamsSchema>,
  body: z.infer<typeof renameEntryBodySchema>,
): Promise<RenameEntryResponse> => {
  const context = await ctx.getBranchContext(params.branch, { loadSchema: true })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const flatSchema = context.flatSchema!
  const store = new ContentStore(context.branchRoot, flatSchema)

  // Parse path segments
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const pathSegments = params.path.split('/').filter(Boolean)

  // Prepend contentRoot if not already present
  const logicalPathSegments =
    pathSegments[0] === contentRoot ? pathSegments : [contentRoot, ...pathSegments]

  // Resolve to collection and slug
  let schemaItem: FlatSchemaItem
  let currentSlug: EntrySlug
  let relativePath: PhysicalPath
  try {
    const resolved = store.resolvePath(logicalPathSegments)
    schemaItem = resolved.schemaItem
    currentSlug = resolved.slug
    const pathResult = await store.resolveDocumentPath(schemaItem.logicalPath, currentSlug)
    relativePath = pathResult.relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: message }
  }

  // Check edit permission on current path
  const access = await ctx.services.checkContentAccess(
    context,
    context.branchRoot,
    relativePath,
    req.user,
    'edit',
  )
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  // Rename the entry
  try {
    const result = await store.renameEntry(schemaItem.logicalPath, currentSlug, body.newSlug)
    return { ok: true, status: 200, data: { newPath: result.newPath } }
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Rename failed'
    return { ok: false, status: 400, error: message }
  }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * Read content using path-based routing
 * GET /:branch/content/:path*
 * Example: /main/content/posts/hello or /main/content/books/1995/biography
 */
const readContent = defineEndpoint({
  namespace: 'content',
  name: 'read',
  method: 'GET',
  path: '/:branch/content/...path',
  params: readContentParamsSchema,
  responseType: 'ContentReadResponse',
  response: {} as ContentReadResponse,
  defaultMockData: { format: 'json', data: {} },
  handler: readContentHandler,
})

/**
 * Write content using path-based routing
 * PUT /:branch/content/:path*
 * Example: /main/content/posts/hello or /main/content/settings
 */
const writeContent = defineEndpoint({
  namespace: 'content',
  name: 'write',
  method: 'PUT',
  path: '/:branch/content/...path',
  params: writeContentParamsSchema,
  body: writeContentBodySchema,
  bodyType: 'WriteContentBody',
  responseType: 'ContentWriteResponse',
  response: {} as ContentWriteResponse,
  defaultMockData: { format: 'json', data: {} },
  handler: writeContentHandler,
})

/**
 * Validate references in content data
 * POST /:branch/validate-references/:path*
 * Example: /main/validate-references/content/posts/hello
 */
const validateReferences = defineEndpoint({
  namespace: 'content',
  name: 'validateReferences',
  method: 'POST',
  path: '/:branch/validate-references/...path',
  params: validateReferencesParamsSchema,
  body: validateReferencesBodySchema,
  bodyType: 'ValidateReferencesBody',
  responseType: 'ReferenceValidationResponse',
  response: {} as ReferenceValidationResponse,
  defaultMockData: { valid: true },
  handler: validateReferencesHandler,
})

/**
 * Rename an entry by changing its slug
 * PATCH /:branch/rename-entry/:path
 * Example: /main/rename-entry/posts/old-slug
 */
const renameEntry = defineEndpoint({
  namespace: 'content',
  name: 'renameEntry',
  method: 'PATCH',
  path: '/:branch/rename-entry/...path',
  params: renameEntryParamsSchema,
  body: renameEntryBodySchema,
  bodyType: 'RenameEntryBody',
  responseType: 'RenameEntryResponse',
  response: {} as RenameEntryResponse,
  defaultMockData: { newPath: 'content/posts/new-slug' },
  handler: renameEntryHandler,
})

/**
 * Exported routes for router registration
 */
export const CONTENT_ROUTES = {
  read: readContent,
  write: writeContent,
  validateReferences,
  renameEntry,
} as const
