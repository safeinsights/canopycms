import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import {
  BranchSyncingError,
  ContentStore,
  ContentStoreError,
  ContentConflictError,
  DuplicateContentIdError,
  UrlPathConflictError,
  getDefaultEntryType,
  type WriteInput,
} from '../content-store'
import type { EntrySchema, EntryTypeConfig, EntryValidationIssue, FlatSchemaItem } from '../config'
import { defineEndpoint } from './route-builder'
import { ReferenceValidator } from '../validation/reference-validator'
import {
  findUnknownKeys,
  mergeBodyIntoData,
  normalizeReferenceValues,
  validateEntryData,
  type EntryFieldError,
} from '../validation/entry-validator'
import { validateEntryLinks } from '../validation/entry-link-validator'
import { branchNameSchema, logicalPathSchema, slugSchema } from './validators'
import { parseSlug, type Slug, type PhysicalPath } from '../paths'
import type { BranchContextWithSchema } from '../types'
import { getErrorMessage, isNotFoundError, sanitizeErrorMessage } from '../utils/error'
import { isDataOnlyFormat } from '../utils/format'

/**
 * Parse an API path into logical path segments, prepending the content root if needed.
 * Shared by all content API handlers.
 */
function parseApiPath(apiPath: string, contentRoot: string): string[] {
  const segments = apiPath.split('/').filter(Boolean)
  return segments[0] === contentRoot ? segments : [contentRoot, ...segments]
}

export type ContentReadResponse = ApiResponse<{
  format: string
  data: Record<string, unknown>
  body?: string
  /** OCC version token: file mtime in ms. Pass back as `expectedVersion` on next write. */
  version?: number
}>

export type ContentWriteResponse = ApiResponse<{
  format: string
  data: Record<string, unknown>
  body?: string
  /** OCC version token: file mtime after the write. Pass back as `expectedVersion` on next write. */
  version?: number
  /**
   * Warning-level issues surfaced from a successful save: the adopter's `validateEntry`
   * hook, unknown-schema-key detection, and broken `entry:ID` links in body/markdown
   * content are all folded into this one channel (see the write handler below) so the
   * editor has exactly one save-warnings notification to render (useEntryManager.ts).
   */
  validationWarnings?: EntryValidationIssue[]
}>

export type ReferenceValidationResponse = ApiResponse<{
  valid: boolean
  errors?: Array<{
    field: string
    fieldPath: string
    id: string
    error: string
  }>
}>

export type RenameEntryResponse = ApiResponse<{
  newPath: string
}>

/**
 * How many stale field paths the unknown-key warning names before summarising the rest. The
 * editor shows warnings in one notification, so this bounds a schema-wide rename to a readable
 * sentence rather than a wall of paths.
 */
const UNKNOWN_KEY_WARNING_LIMIT = 10

export interface WriteContentBody {
  format: 'json' | 'md' | 'mdx' | 'yaml'
  data?: Record<string, unknown>
  body?: string
  /**
   * OCC / create-intent token. Omit for a blind write (no opinion). A number
   * from a prior read/write response rejects the write with 409 if the file
   * has changed since. `null` means "this entry must not already exist" —
   * the create path uses this so a create against an existing slug is
   * rejected with 409 instead of silently overwriting it.
   */
  expectedVersion?: number | null
}

export interface ValidateReferencesBody {
  data: Record<string, unknown>
}

export interface RenameEntryBody {
  newSlug: string
}

/** Re-exported for convenience. */

const readContentParamsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
})

const writeContentParamsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
  entryType: z.string().optional(), // Optional entry type name for collections with multiple entry types
})

/**
 * Bounds on write/validate payload size (API-M1): content body text and
 * structured field data are otherwise unbounded, letting any authenticated
 * caller force arbitrarily large writes/validation work. These caps are
 * generous for real content (a long MDX article, a large field-data object)
 * while keeping worst-case request size bounded.
 */
const MAX_CONTENT_BODY_CHARS = 2_000_000 // ~2MB of markdown/mdx body text
const MAX_CONTENT_DATA_BYTES = 2_000_000 // ~2MB of structured field data (serialized)

const boundedContentDataSchema = z
  .record(z.unknown())
  // TextEncoder measures actual UTF-8 bytes; String#length counts UTF-16 code
  // units and undercounts multi-byte content by up to 3x.
  .refine(
    (data) => new TextEncoder().encode(JSON.stringify(data)).length <= MAX_CONTENT_DATA_BYTES,
    {
      message: `data payload exceeds maximum size of ${MAX_CONTENT_DATA_BYTES} bytes`,
    },
  )

const writeContentBodySchema = z.object({
  format: z.enum(['json', 'md', 'mdx', 'yaml']),
  data: boundedContentDataSchema.optional(),
  body: z.string().max(MAX_CONTENT_BODY_CHARS).optional(),
  // null = create-intent ("must not already exist"); see WriteContentBody.
  expectedVersion: z.number().nullish(),
})

const validateReferencesParamsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
  entryType: z.string().optional(),
})

const validateReferencesBodySchema = z.object({
  data: boundedContentDataSchema,
})

const renameEntryParamsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
})

const renameEntryBodySchema = z.object({
  newSlug: slugSchema,
})

const readContentHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof readContentParamsSchema>,
): Promise<ContentReadResponse> => {
  const { branchContext } = gc
  const flatSchema = branchContext.flatSchema
  const store = new ContentStore(branchContext.branchRoot, flatSchema, {
    contentRootName: ctx.services.config.contentRoot || 'content',
  })

  const contentRoot = ctx.services.config.contentRoot || 'content'
  const logicalPathSegments = parseApiPath(params.path, contentRoot)

  let schemaItem: FlatSchemaItem
  let slug: Slug
  let relativePath: PhysicalPath
  try {
    const resolved = store.resolvePath(logicalPathSegments)
    schemaItem = resolved.schemaItem
    slug = resolved.slug
    const pathResult = await store.resolveDocumentPath(schemaItem.logicalPath, slug)
    relativePath = pathResult.relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: sanitizeErrorMessage(message) }
  }

  const access = await ctx.services.checkContentAccess(
    branchContext,
    branchContext.branchRoot,
    relativePath,
    req.user,
    'read',
  )
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  try {
    const doc = await store.read(schemaItem.logicalPath, slug)
    return { ok: true, status: 200, data: doc }
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      return { ok: false, status: 404, error: 'Content not found' }
    }
    throw err
  }
}

const writeContentHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof writeContentParamsSchema>,
  body: z.infer<typeof writeContentBodySchema>,
): Promise<ContentWriteResponse> => {
  const { branchContext } = gc
  const flatSchema = branchContext.flatSchema
  const store = new ContentStore(branchContext.branchRoot, flatSchema, {
    contentRootName: ctx.services.config.contentRoot || 'content',
  })

  const contentRoot = ctx.services.config.contentRoot || 'content'
  const logicalPathSegments = parseApiPath(params.path, contentRoot)

  let schemaItem: FlatSchemaItem
  let slug: Slug
  let relativePath: PhysicalPath
  try {
    const resolved = store.resolvePath(logicalPathSegments)
    schemaItem = resolved.schemaItem
    slug = resolved.slug
    const pathResult = await store.resolveDocumentPath(schemaItem.logicalPath, slug)
    relativePath = pathResult.relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: sanitizeErrorMessage(message) }
  }

  const access = await ctx.services.checkContentAccess(
    branchContext,
    branchContext.branchRoot,
    relativePath,
    req.user,
    'edit',
  )
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  // Authoritative schema validation at the write boundary (COMPOUND-2): the server re-checks
  // required fields, type/format correctness, and non-empty required references (rules shared
  // with the editor via validation/entry-validator), plus reference EXISTENCE and
  // EntryTypeConfig.maxItems (SCH-H3) — so a direct API call can't bypass what the editor's form
  // enforces client-side.
  //
  // Carve-out: a create scaffold (target doesn't exist yet, payload is entirely empty `{}`/no
  // body) skips field validation, since the editor's create flow writes an empty scaffold before
  // the user fills the form.

  // Resolve the entry-type config the store will write with (mirrors ContentStore.write)
  let entryTypeConfig: EntryTypeConfig | undefined
  let fields: EntrySchema = []
  let maxItems: number | undefined
  let entryTypeName: string | undefined
  if (schemaItem.type === 'entry-type') {
    fields = schemaItem.schema
    maxItems = schemaItem.maxItems
    entryTypeName = schemaItem.name
  } else {
    // An entryType param naming an unknown type is always a bad request,
    // regardless of whether the target entry exists yet.
    if (params.entryType) {
      const requestedConfig = schemaItem.entries?.find((e) => e.name === params.entryType)
      if (!requestedConfig) {
        return {
          ok: false,
          status: 400,
          error: `Entry type '${params.entryType}' not found`,
        }
      }
    }

    // For an existing entry, validate against its REAL on-disk type. Entry
    // filenames embed the type (`{type}.{slug}.{id}.{ext}`) and
    // ContentStore.write() preserves it regardless of what's requested (see
    // buildPaths in content-store.ts) — so resolving from params.entryType
    // or the default here instead would let a direct API write validate a
    // payload against the WRONG entry type's schema. The
    // editor always sends the entry's real entryType, so this only changes
    // behavior for non-editor callers.
    const existingEntryType = await store.getExistingEntryType(schemaItem.logicalPath, slug)
    if (existingEntryType) {
      if (params.entryType && params.entryType !== existingEntryType) {
        return {
          ok: false,
          status: 409,
          error: `Entry type conflict: entry already exists with type '${existingEntryType}', but request specified '${params.entryType}'`,
        }
      }
      entryTypeConfig = schemaItem.entries?.find((e) => e.name === existingEntryType)
      entryTypeName = existingEntryType
    } else if (params.entryType) {
      entryTypeConfig = schemaItem.entries?.find((e) => e.name === params.entryType)
      entryTypeName = entryTypeConfig?.name
    } else {
      entryTypeConfig = getDefaultEntryType(schemaItem.entries)
      entryTypeName = entryTypeConfig?.name
    }
    fields = entryTypeConfig?.schema ?? []
    maxItems = entryTypeConfig?.maxItems
  }

  const data = body.data ?? {}
  const isDataOnly = isDataOnlyFormat(body.format)

  try {
    const exists = await store.documentExists(schemaItem.logicalPath, slug)

    // Create-intent guard: a create request (expectedVersion === null) against a slug that
    // already has content must never silently overwrite it — short-circuit with 409 before field
    // validation runs, so the error names the real problem instead of "field is required" or a
    // bare conflict. store.write() re-enforces this itself inside its per-entry lock against a
    // fresh stat (the race-safe authoritative check); this is just a cheaper fast path for the
    // common case.
    if (body.expectedVersion === null && exists) {
      return {
        ok: false,
        status: 409,
        error: `An entry with slug "${slug}" already exists`,
      }
    }

    // [SLUG] Create-only routability check: `writeContentParamsSchema.path`'s `parseLogicalPath`
    // has no charset rule, and `ContentStore.resolvePath` only lowercases the slug — so this is
    // the only place on the write chain that applies `parseSlug` (besides `renameEntry`'s
    // `newSlug`). Without it, a non-routable slug like `my_post` would build and then 404 on
    // every visit. `store.write()` re-enforces this inside its per-entry lock; this is the
    // cheaper, clearer-messaged fast path.
    //
    // Create-only: an entry with an existing non-conforming slug must stay saveable and
    // renameable, since renaming it is the only way to fix the build.
    if (!exists) {
      const routable = parseSlug(slug)
      if (!routable.ok) {
        return {
          ok: false,
          status: 400,
          error:
            `Cannot create entry "${slug}": ${routable.error}. An entry whose slug is not ` +
            'addressable as a URL segment would build and then 404 on every visit.',
        }
      }
    }

    // SCH-H3: enforce maxItems server-side — the editor only gates its "Add" button, so a direct
    // API create could otherwise exceed the cap. Best-effort under concurrency: count-then-create
    // isn't atomic, so two simultaneous creates can still race past the cap; this guards the
    // single-request bypass, not the race.
    if (!exists && maxItems !== undefined && entryTypeName) {
      const collectionPath =
        schemaItem.type === 'entry-type' ? schemaItem.parentPath : schemaItem.logicalPath
      const count = await store.countEntriesOfType(collectionPath, entryTypeName)
      if (count >= maxItems) {
        return {
          ok: false,
          status: 422,
          error: `Cannot create entry: type "${entryTypeName}" allows at most ${maxItems} ${maxItems === 1 ? 'entry' : 'entries'}`,
        }
      }
    }

    const isCreateScaffold =
      !exists && Object.keys(data).length === 0 && (isDataOnly || !body.body?.trim())

    if (!isCreateScaffold) {
      // Pure rules (shared with the editor). For md/mdx the body is validated
      // as the schema's isBody field.
      const dataForValidation = isDataOnly ? data : mergeBodyIntoData(fields, data, body.body ?? '')
      const fieldErrors: EntryFieldError[] = validateEntryData(fields, dataForValidation)

      // Reference existence (server-only: reads the content ID index). Editor
      // payloads may still carry resolved `{ id, ... }` objects from a prior
      // read, so collapse them to id strings before checking.
      if (fieldErrors.length === 0) {
        const idIndex = await store.idIndex()
        const refValidator = new ReferenceValidator(
          idIndex,
          fields,
          (name) => store.resolveCollectionItem(name)?.logicalPath,
        )
        const refResult = await refValidator.validate(normalizeReferenceValues(fields, data))
        fieldErrors.push(
          ...refResult.errors.map((e) => ({ fieldPath: e.fieldPath, message: e.error })),
        )
      }

      if (fieldErrors.length > 0) {
        return {
          ok: false,
          status: 422,
          // '; '-joined: the editor shows this in a notification, which collapses newlines
          error: fieldErrors.map((e) => `${e.fieldPath}: ${e.message}`).join('; '),
          fieldErrors,
        }
      }
    }
  } catch (err) {
    if (err instanceof ContentStoreError) {
      return { ok: false, status: 400, error: sanitizeErrorMessage(err.message) }
    }
    throw err
  }

  // Adopter save-time validation, run BEFORE the file is written: 'error' issues
  // refuse the save (e.g. a body that would break the site's production build),
  // 'warning' issues are returned alongside the successful write.
  let validationWarnings: EntryValidationIssue[] | undefined
  const validateEntry = ctx.services.config.validateEntry
  // Collapse resolved reference objects back to bare ID strings before persisting (the reference
  // validator above gets its own copy). The editor's GET resolves references by default, so form
  // state round-trips `{...target data, id, slug, collection, urlPath}` for each reference field;
  // left unnormalized, a save would freeze that snapshot into the file (resolution only
  // re-resolves plain ID strings), permanently severing the reference from its target. Idempotent:
  // a payload that already holds ID strings is unchanged.
  const normalizedData =
    body.data === undefined ? undefined : normalizeReferenceValues(fields, body.data)
  // Computed before the validateEntry hook and the entry-link scan too, not just the write, so
  // every consumer agrees on the same bytes — otherwise an adopter's hook could see a resolved
  // object while the file got an ID string, depending on whether the post came from the editor.

  // Keys with no counterpart in the schema: validateEntryData iterates the SCHEMA, so it can't
  // catch the inverse — a renamed/reshaped field whose old key lingers on disk forever, silently
  // read back as `undefined`. Checked against normalizedData (the bytes that will actually be
  // persisted) so a resolved reference collapsed to an ID string isn't mistaken for a stray key.
  // A warning, never a rejection: the key is kept in the file, just unread and uneditable — an
  // editor can't remove a key the form doesn't render or change the schema. One issue listing all
  // stale keys (capped), not one per key, since the editor renders warnings as a single
  // notification (useEntryManager.ts).
  if (normalizedData !== undefined) {
    const unknownKeys = findUnknownKeys(fields, normalizedData)
    if (unknownKeys.length > 0) {
      const shown = unknownKeys.slice(0, UNKNOWN_KEY_WARNING_LIMIT)
      const overflow = unknownKeys.length - shown.length
      const list = overflow > 0 ? `${shown.join(', ')} (and ${overflow} more)` : shown.join(', ')
      validationWarnings = [
        {
          level: 'warning',
          message:
            `Saved. ${unknownKeys.length === 1 ? 'One field is' : `${unknownKeys.length} fields are`} ` +
            `not part of this entry type’s schema: ${list}. They are kept in the file, but nothing ` +
            `reads them — ask a developer to add them to the schema or remove them from the content.`,
        },
      ]
    }
  }

  if (validateEntry) {
    let issues: EntryValidationIssue[]
    try {
      issues = await validateEntry({
        entryPath: logicalPathSegments.join('/'),
        branch: params.branch,
        ...(params.entryType ? { entryType: params.entryType } : {}),
        format: body.format,
        data: normalizedData ?? {},
        body: body.body,
      })
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: `validateEntry hook failed: ${sanitizeErrorMessage(getErrorMessage(err))}`,
      }
    }
    const errors = issues.filter((issue) => issue.level === 'error')
    if (errors.length > 0) {
      return {
        ok: false,
        status: 422,
        // '; '-joined: the editor shows this in a notification, which collapses newlines
        error: errors
          .map((issue) =>
            issue.fieldPath ? `${issue.fieldPath}: ${issue.message}` : issue.message,
          )
          .join('; '),
      }
    }
    // Appended, not assigned: the unknown-key scan above may already have found some, and the
    // editor shows the channel as one notification.
    const warnings = issues.filter((issue) => issue.level === 'warning')
    if (warnings.length > 0) validationWarnings = [...(validationWarnings ?? []), ...warnings]
  }

  try {
    const writeInput: WriteInput = isDataOnlyFormat(body.format)
      ? {
          format: body.format as 'json' | 'yaml',
          data: normalizedData ?? {},
          expectedVersion: body.expectedVersion,
        }
      : {
          format: body.format as 'md' | 'mdx',
          data: normalizedData,
          body: body.body ?? '',
          expectedVersion: body.expectedVersion,
        }

    // Pass the resolved entryTypeName (not the raw, possibly-omitted
    // params.entryType) so the store's own format check agrees with the type
    // we just validated against.
    const result = await store.write(schemaItem.logicalPath, slug, writeInput, entryTypeName)

    // Validate entry links in body content (warnings only, don't block save).
    // Reuses the entry-type fields resolved above for schema validation. Folded into
    // `validationWarnings` (not a separate `entryLinkWarnings` field) so the editor's one
    // save-warnings notification (useEntryManager.ts) is the single place any save-time
    // warning surfaces.
    const idIndex = await store.idIndex()
    const linkValidation = validateEntryLinks(normalizedData ?? {}, fields, idIndex, body.body)
    if (linkValidation.warnings.length > 0) {
      const linkWarnings: EntryValidationIssue[] = linkValidation.warnings.map((warning) => ({
        level: 'warning',
        message: warning.message,
        fieldPath: warning.fieldPath,
      }))
      validationWarnings = [...(validationWarnings ?? []), ...linkWarnings]
    }

    return { ok: true, status: 200, data: { ...result, validationWarnings } }
  } catch (err) {
    if (err instanceof ContentConflictError) {
      // [SYNC-C1] Not an editor collision: the branch is mid-rebase. Usually the write was
      // refused outright, but a lock compromised mid-write can still land it — each case carries
      // its own message, so pass `err.message` through rather than the generic conflict below.
      if (err instanceof BranchSyncingError) {
        return { ok: false, status: 409, error: err.message }
      }
      // [F1] Also not an editor collision: this content ID is quarantined on two files
      // (ContentIdIndex's duplicate-ID detection). The generic message below would send the
      // editor into a reload-and-retry loop that can't help until an admin runs
      // repair-content-duplicates, so surface this error's own message instead.
      if (err instanceof DuplicateContentIdError) {
        return { ok: false, status: 409, error: err.message }
      }
      // [URL] Also not an editor collision, and not a same-slug conflict either — a DIFFERENT
      // entry (a sibling collection's index entry, or this one's parent) claims the same URL.
      // Surface its own message rather than telling the editor to look for an entry that exists.
      if (err instanceof UrlPathConflictError) {
        return { ok: false, status: 409, error: err.message }
      }
      // Race-safe fallback: the early `exists` check above catches the common case; this covers a
      // collision that lands between that check and store.write()'s in-lock stat.
      if (body.expectedVersion === null) {
        return {
          ok: false,
          status: 409,
          error: `An entry with slug "${slug}" already exists`,
        }
      }
      return {
        ok: false,
        status: 409,
        error: 'Content conflict: entry was modified by another editor',
      }
    }
    // C2: a ContentStoreError is an expected client fault (bad slug, validation, etc.) and keeps
    // its 400. Anything else — ENOSPC, EACCES, a bug — is a genuine server fault and must not be
    // mislabeled as the client's mistake; rethrow so it surfaces as a 500.
    if (err instanceof ContentStoreError) {
      return { ok: false, status: 400, error: sanitizeErrorMessage(err.message) }
    }
    throw err
  }
}

const validateReferencesHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof validateReferencesParamsSchema>,
  body: z.infer<typeof validateReferencesBodySchema>,
): Promise<ReferenceValidationResponse> => {
  const { branchContext } = gc
  const flatSchema = branchContext.flatSchema
  const store = new ContentStore(branchContext.branchRoot, flatSchema, {
    contentRootName: ctx.services.config.contentRoot || 'content',
  })

  const contentRoot = ctx.services.config.contentRoot || 'content'
  const logicalPathSegments = parseApiPath(params.path, contentRoot)

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
    return { ok: false, status: 400, error: sanitizeErrorMessage(message) }
  }

  const access = await ctx.services.checkContentAccess(
    branchContext,
    branchContext.branchRoot,
    relativePath,
    req.user,
    'read',
  )
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  // Get ID index (automatically loads if needed)
  const idIndex = await store.idIndex()

  let fields: EntrySchema = []
  if (schemaItem.type === 'entry-type') {
    fields = schemaItem.schema
  } else {
    let entryTypeConfig: EntryTypeConfig | undefined
    if (params.entryType) {
      entryTypeConfig = schemaItem.entries?.find((e) => e.name === params.entryType)
      if (!entryTypeConfig) {
        return {
          ok: false,
          status: 400,
          error: `Entry type '${params.entryType}' not found`,
        }
      }
    } else if (schemaItem.entries && schemaItem.entries.length === 1) {
      entryTypeConfig = schemaItem.entries[0]
    } else {
      return {
        ok: false,
        status: 400,
        error: 'entryType param required for collections with multiple entry types',
      }
    }
    fields = entryTypeConfig.schema || []
  }

  const validator = new ReferenceValidator(
    idIndex,
    fields,
    (name) => store.resolveCollectionItem(name)?.logicalPath,
  )
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
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof renameEntryParamsSchema>,
  body: z.infer<typeof renameEntryBodySchema>,
): Promise<RenameEntryResponse> => {
  const { branchContext } = gc
  const flatSchema = branchContext.flatSchema
  const store = new ContentStore(branchContext.branchRoot, flatSchema, {
    contentRootName: ctx.services.config.contentRoot || 'content',
  })

  const contentRoot = ctx.services.config.contentRoot || 'content'
  const logicalPathSegments = parseApiPath(params.path, contentRoot)

  let schemaItem: FlatSchemaItem
  let currentSlug: Slug
  let relativePath: PhysicalPath
  try {
    const resolved = store.resolvePath(logicalPathSegments)
    schemaItem = resolved.schemaItem
    currentSlug = resolved.slug
    const pathResult = await store.resolveDocumentPath(schemaItem.logicalPath, currentSlug)
    relativePath = pathResult.relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: sanitizeErrorMessage(message) }
  }

  const access = await ctx.services.checkContentAccess(
    branchContext,
    branchContext.branchRoot,
    relativePath,
    req.user,
    'edit',
  )
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  try {
    const result = await store.renameEntry(schemaItem.logicalPath, currentSlug, body.newSlug)
    return { ok: true, status: 200, data: { newPath: result.newPath } }
  } catch (err) {
    // [SYNC-C1] Mid-rebase, not a bad request -- 409 + retry, never 400.
    if (err instanceof ContentConflictError) {
      // [URL] A contested-URL refusal needs its own message: the generic one below tells the
      // editor to reload and retry, which can't succeed until they pick a different slug.
      const passThrough = err instanceof BranchSyncingError || err instanceof UrlPathConflictError
      return {
        ok: false,
        status: 409,
        error: passThrough ? err.message : 'Content conflict: entry was modified by another editor',
      }
    }
    // C2: same rule as writeContentHandler's catch above (ContentStoreError -> 400, everything
    // else -> 500).
    if (err instanceof ContentStoreError) {
      return { ok: false, status: 400, error: sanitizeErrorMessage(err.message) }
    }
    throw err
  }
}

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
  guards: ['schema'] as const,
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
  guards: ['schema', 'writableBranch'] as const,
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
  guards: ['schema'] as const,
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
  guards: ['schema', 'writableBranch'] as const,
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
