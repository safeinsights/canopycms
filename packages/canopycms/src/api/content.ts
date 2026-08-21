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
import type { Slug, PhysicalPath } from '../paths'
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

/** Response type for content read operations */
export type ContentReadResponse = ApiResponse<{
  format: string
  data: Record<string, unknown>
  body?: string
  /** OCC version token: file mtime in ms. Pass back as `expectedVersion` on next write. */
  version?: number
}>

/** Response type for content write operations */
export type ContentWriteResponse = ApiResponse<{
  format: string
  data: Record<string, unknown>
  body?: string
  /** OCC version token: file mtime after the write. Pass back as `expectedVersion` on next write. */
  version?: number
  entryLinkWarnings?: Array<{
    field: string
    fieldPath: string
    id: string
    message: string
  }>
  /** Warning-level issues from the adopter's validateEntry hook (save succeeded). */
  validationWarnings?: EntryValidationIssue[]
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

  // Parse path segments: params.path is like "content/posts/hello"
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const logicalPathSegments = parseApiPath(params.path, contentRoot)

  // Use trivial path resolution
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

  // Parse path segments: params.path is like "content/posts/hello" or "posts/hello"
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const logicalPathSegments = parseApiPath(params.path, contentRoot)

  // Use trivial path resolution
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

  // ------------------------------------------------------------------
  // Authoritative schema validation at the write boundary (COMPOUND-2).
  //
  // The server rejects structurally invalid entry data even when the client
  // is bypassed: required fields, type/format correctness, non-empty required
  // references (pure rules shared with the editor via validation/entry-validator),
  // plus reference EXISTENCE (server-only: reads the content ID index) and
  // EntryTypeConfig.maxItems at the create boundary (SCH-H3).
  //
  // One narrow carve-out: the editor's create flow scaffolds a brand-new entry
  // by writing entirely empty data (`{}` and an empty body) and only then lets
  // the user fill the form — so a create scaffold (target file does not exist
  // yet AND the payload is completely empty) skips field validation. Any write
  // carrying actual data, and every write to an existing entry, is validated.
  // ------------------------------------------------------------------

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
    // payload against the WRONG entry type's schema (post-review M2). The
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

    // Create-intent guard (August 2026 baseline review, Critical finding): a
    // create request (expectedVersion === null, "must not already exist")
    // against a slug that already has content must never silently overwrite
    // it. Without this, an entry type with no required fields passes field
    // validation on the create path's empty payload and falls through to a
    // blind store.write() — this short-circuits with an unambiguous 409
    // before that validation (and the maxItems count below) even runs, so
    // the error always names the real problem instead of a confusing
    // "field is required" message or a bare conflict. store.write() also
    // enforces this same guard itself, inside its per-entry lock against a
    // fresh stat — that is the race-safe authoritative check; this early
    // return is just a cheaper, clearer-messaged fast path for the common
    // (non-racing) case.
    if (body.expectedVersion === null && exists) {
      return {
        ok: false,
        status: 409,
        error: `An entry with slug "${slug}" already exists`,
      }
    }

    // SCH-H3: enforce maxItems server-side at the create boundary. The editor
    // only gates its "Add" button; a direct API create could otherwise exceed
    // the cap. Best-effort under concurrency: the count-then-create below is
    // not atomic, so two simultaneous creates can still race past the cap —
    // the guard's real target is the single-request direct-API bypass.
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
  // Collapse resolved reference objects back to bare ID strings before PERSISTING, not just
  // before validating (the reference validator gets its own normalized copy above).
  //
  // The editor round-trips whole documents: its GET reads through `store.read()`, whose
  // `resolveReferences` defaults to TRUE, so form state holds `{...target data, id, slug,
  // collection, urlPath}` for every reference field, and a save posts that straight back. Left
  // unnormalized it lands in the content file verbatim — and because resolution only re-resolves
  // a `typeof value === 'string'`, every later read passes the frozen snapshot through and every
  // later save rewrites it. The reference is then permanently severed from its target: renaming
  // or editing the target changes nothing, silently.
  //
  // The mechanism predates reference resolution reaching listings, but `includeBody` makes it
  // materially worse — the snapshot now carries the target's entire prose — and `urlPath` adds a
  // value that goes stale the moment the target is renamed. Normalizing here is schema-driven and
  // idempotent: a payload that already holds ID strings is unchanged.
  const normalizedData =
    body.data === undefined ? undefined : normalizeReferenceValues(fields, body.data)
  //
  // Computed BEFORE the validateEntry hook and the entry-link scan, not just before the write,
  // so every consumer of the payload agrees with the bytes that land on disk. Otherwise an
  // adopter's hook inspecting a reference field saw a resolved object while the file got an ID
  // string -- and saw it only when the post came from the editor, since a client posting bare
  // IDs already gave the hook bare IDs. Normalizing first makes the hook's input deterministic
  // regardless of caller.

  // Keys with no counterpart in the schema. validateEntryData iterates the SCHEMA, so nothing
  // reported the inverse: a renamed or reshaped field left its old key on disk forever (the
  // editor round-trips the whole record, so every save rewrote it) and the only symptom was a
  // component receiving `undefined`. Adopter request log item 29.
  //
  // Run against normalizedData -- the shape that will actually be persisted -- so the report
  // matches the bytes, and so a resolved reference collapsed back to an ID string cannot be
  // mistaken for anything. A warning, never a rejection: the key is still written (with its
  // comments, see utils/content-serialize.ts), it is just not editable and nothing reads it.
  //
  // ONE issue, not one per key. The editor joins every warning into a single non-auto-closing
  // notification (useEntryManager.ts), so one-per-key repeated the same explanatory sentence
  // once per stale key, on every save, for a condition that is permanent until someone edits the
  // schema. The keys are listed in the message instead, capped so a schema-wide rename cannot
  // produce an unreadable wall of text. Worded for who can actually act: an editor cannot remove
  // a key the form does not render, and cannot change the schema.
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
    // Reuses the entry-type fields resolved above for schema validation.
    const idIndex = await store.idIndex()
    const linkValidation = validateEntryLinks(normalizedData ?? {}, fields, idIndex, body.body)
    const entryLinkWarnings =
      linkValidation.warnings.length > 0 ? linkValidation.warnings : undefined

    return { ok: true, status: 200, data: { ...result, entryLinkWarnings, validationWarnings } }
  } catch (err) {
    if (err instanceof ContentConflictError) {
      // [SYNC-C1] Not an editor-vs-editor collision at all: the branch's
      // working tree is being rebased. Usually the write was refused outright
      // rather than acknowledged and then rolled back; the one exception is a
      // lock compromised mid-write, where the write DID land but we can no
      // longer prove it was exclusive. Each case carries its own message
      // (retry vs. reload-then-decide), so pass it through -- checked first,
      // since the generic branches below would otherwise blame another editor.
      if (err instanceof BranchSyncingError) {
        return { ok: false, status: 409, error: err.message }
      }
      // [F1] Also not an editor-vs-editor collision: this entry's content ID
      // is on two files (ContentIdIndex's duplicate-ID quarantine), so the
      // save was refused rather than allowed to mutate an ambiguous target.
      // Surface its own message — the generic one below would tell the editor
      // to reload and retry, which cannot help and would have them hammering
      // a save that stays refused until an admin runs repair-content-duplicates.
      if (err instanceof DuplicateContentIdError) {
        return { ok: false, status: 409, error: err.message }
      }
      // [URL] Also not an editor-vs-editor collision, and critically NOT the
      // same-slug case the branch below reports: no entry with this slug
      // exists in this collection (the early `exists` check passed). What
      // exists is a DIFFERENT entry claiming the same URL -- a sibling
      // collection's index entry, or the parent entry this index entry would
      // collide with. Falling through would tell the editor to look for an
      // entry that is not there, and discard the one message that names the
      // actual offender and what to do about it.
      if (err instanceof UrlPathConflictError) {
        return { ok: false, status: 409, error: err.message }
      }
      // The early `exists` short-circuit above catches this in the common
      // case; this is the race-safe fallback for a collision that landed
      // between that check and store.write()'s in-lock stat.
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
    // C2: a ContentStoreError is a known/expected client fault (validation,
    // bad slug, etc.) and keeps its existing 400. Anything else - ENOSPC,
    // EACCES, a bug - is a genuine server fault and must not be mislabeled
    // as the client's mistake; rethrow so it surfaces as a 500 (see
    // readContentHandler's store.read() catch above, which already follows
    // this same pattern).
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

  // Parse path segments to get collection/schema info
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

  // Resolve fields from entry type schema
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

  // Validate references
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

  // Parse path segments
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const logicalPathSegments = parseApiPath(params.path, contentRoot)

  // Resolve to collection and slug
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

  // Check edit permission on current path
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

  // Rename the entry
  try {
    const result = await store.renameEntry(schemaItem.logicalPath, currentSlug, body.newSlug)
    return { ok: true, status: 200, data: { newPath: result.newPath } }
  } catch (err) {
    // [SYNC-C1] The rename was refused because the branch is mid-rebase, not
    // because the request was bad -- 409 + retry, never a 400.
    if (err instanceof ContentConflictError) {
      // [URL] A contested-URL refusal must carry its own message. The generic
      // one below tells the editor to reload and retry, which cannot succeed
      // here -- the rename stays refused until they pick a different slug or
      // remove the other claimant -- which is exactly the loop
      // UrlPathConflictError's doc comment exists to prevent.
      const passThrough = err instanceof BranchSyncingError || err instanceof UrlPathConflictError
      return {
        ok: false,
        status: 409,
        error: passThrough ? err.message : 'Content conflict: entry was modified by another editor',
      }
    }
    // C2: same distinction as writeContentHandler above - a ContentStoreError
    // is an expected client fault and keeps its 400; anything else is a
    // genuine server fault and must surface as a 500, not get mislabeled as
    // "Rename failed" (the client's mistake).
    if (err instanceof ContentStoreError) {
      return { ok: false, status: 400, error: sanitizeErrorMessage(err.message) }
    }
    throw err
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
