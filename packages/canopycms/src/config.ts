import { isAbsolute, join, normalize } from 'pathe'

import { z } from 'zod'

import type { CanopyGroupId, CanopyUserId } from './types'
import type { OperatingMode } from './operating-mode'
import type { AuthPlugin } from './auth/plugin'

export const primitiveFieldTypes = [
  'string',
  'number',
  'boolean',
  'datetime',
  'rich-text',
  'markdown',
  'mdx',
  'image',
  'code',
] as const

export const fieldTypes = [
  ...primitiveFieldTypes,
  'select',
  'reference',
  'object',
  'block',
] as const

export type PrimitiveFieldType = (typeof primitiveFieldTypes)[number]
export type FieldType = (typeof fieldTypes)[number]
export type ContentFormat = 'md' | 'mdx' | 'json'
export type MediaAdapterKind = 'local' | 's3' | 'lfs' | (string & {})

// Schemas
const fieldBase = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  list: z.boolean().optional(),
})

const selectOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string().min(1),
    value: z.string().min(1),
  }),
])

const referenceOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string().min(1),
    value: z.string().min(1),
  }),
])

const primitiveFieldSchema = fieldBase.extend({
  type: z.enum(primitiveFieldTypes),
})

const selectFieldSchema = fieldBase.extend({
  type: z.literal('select'),
  options: z.array(selectOptionSchema).min(1),
})

const referenceFieldSchema = fieldBase.extend({
  type: z.literal('reference'),
  collections: z.array(z.string().min(1)).min(1),
  displayField: z.string().min(1).optional(),
  options: z.array(referenceOptionSchema).optional(),
})

let fieldSchema: z.ZodTypeAny
let knownFieldSchema: z.ZodTypeAny

const blockSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  fields: z.array(z.lazy(() => fieldSchema)).min(1),
})

const blockFieldSchema = fieldBase.extend({
  type: z.literal('block'),
  templates: z.array(blockSchema).min(1),
})

const objectFieldSchema = fieldBase.extend({
  type: z.literal('object'),
  fields: z.array(z.lazy(() => fieldSchema)).min(1),
})

const customFieldSchema = z.lazy(() =>
  fieldBase
    .extend({
      type: z
        .string()
        .min(1)
        .refine((val) => !fieldTypes.includes(val as FieldType), {
          message: 'Custom field types must not conflict with built-in types',
        }),
    })
    .passthrough(),
)

knownFieldSchema = z.discriminatedUnion('type', [
  primitiveFieldSchema,
  selectFieldSchema,
  referenceFieldSchema,
  objectFieldSchema,
  blockFieldSchema,
])

fieldSchema = z.lazy(() => z.union([knownFieldSchema, customFieldSchema]))

export type PermissionLevel = 'read' | 'edit' | 'review'

const permissionTargetSchema = z.object({
  allowedUsers: z.array(z.string() as z.ZodType<CanopyUserId>).optional(),
  allowedGroups: z.array(z.string() as z.ZodType<CanopyGroupId>).optional(),
})

export type PermissionTarget = z.infer<typeof permissionTargetSchema>

const pathPermissionSchema = z.object({
  path: z.string().min(1),
  read: permissionTargetSchema.optional(),
  edit: permissionTargetSchema.optional(),
  review: permissionTargetSchema.optional(),
})

const mediaSchema = z.union([
  z.object({
    adapter: z.literal('local'),
    publicBaseUrl: z.string().url().optional(),
  }),
  z.object({
    adapter: z.literal('s3'),
    bucket: z.string().min(1),
    region: z.string().min(1),
    publicBaseUrl: z.string().url().optional(),
  }),
  z.object({
    adapter: z.literal('lfs'),
    publicBaseUrl: z.string().url().optional(),
  }),
  z.object({
    adapter: z.string().min(1),
    publicBaseUrl: z.string().url().optional(),
  }),
])

const relativePathSchema = z
  .string()
  .min(1)
  .refine((val) => !isAbsolute(val), { message: 'Path must be relative' })
  .refine((val) => !val.split(/[\\/]+/).includes('..'), { message: 'Path must not contain ".."' })
  .transform((val) =>
    val
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/'),
  )

const normalizePathValue = (val: string): string =>
  normalize(val).split('/').filter(Boolean).join('/')

const defaultBranchAccessSchema = z.enum(['allow', 'deny']).default('deny')
const defaultPathAccessSchema = z.enum(['allow', 'deny']).default('deny')
const defaultBaseBranchSchema = z.string().default('main')
const defaultRemoteNameSchema = z.string().default('origin')
const defaultRemoteUrlSchema = z.string().min(1)
const gitBotAuthorNameSchema = z.string().min(1)
const gitBotAuthorEmailSchema = z.string().email()
const githubTokenEnvVarSchema = z.string().default('GITHUB_BOT_TOKEN')
const operatingModeSchema = z.enum(['prod', 'prod-sim', 'dev']).default('dev')
const contentRootSchema = relativePathSchema.default('content')
const sourceRootSchema = z.string().min(1).optional()
const deploymentNameSchema = z.string().default('prod')

// Singleton: A single-instance file with unique schema
const singletonSchema = z.object({
  name: z.string().min(1),
  path: relativePathSchema,
  format: z.enum(['md', 'mdx', 'json']),
  fields: z.array(z.lazy(() => fieldSchema)).min(1),
  label: z.string().optional(),
})

// Collection entries config: shared schema for repeatable entries
const collectionEntriesSchema = z.object({
  format: z.enum(['md', 'mdx', 'json']).optional(),
  fields: z.array(z.lazy(() => fieldSchema)).min(1),
})

let collectionSchema: z.ZodTypeAny
let rootCollectionSchema: z.ZodTypeAny

// Nested collection: must have name and path
collectionSchema = z.lazy(() =>
  z
    .object({
      name: z.string().min(1),
      path: relativePathSchema,
      label: z.string().optional(),
      entries: collectionEntriesSchema.optional(),
      collections: z.array(collectionSchema).optional(),
      singletons: z.array(singletonSchema).optional(),
    })
    .refine((data) => data.entries || data.collections || data.singletons, {
      message: 'Collection must have entries, collections, or singletons',
    }),
)

// Root collection: no name/path required
rootCollectionSchema = z.object({
  entries: collectionEntriesSchema.optional(),
  collections: z.array(collectionSchema).optional(),
  singletons: z.array(singletonSchema).optional(),
})

const editorConfigSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  theme: z.unknown().optional(),
  previewBase: z.record(z.string()).optional(),
  // UI handler functions (runtime only, don't serialize)
  onAccountClick: z.function().returns(z.void()).optional(),
  onLogoutClick: z.function().returns(z.void()).optional(),
  // Optional: custom account component (e.g., Clerk's UserButton)
  AccountComponent: z.custom<React.ComponentType>().optional(),
})

export const CanopyConfigSchema = z.object({
  schema: rootCollectionSchema.optional(),
  media: mediaSchema.optional(),
  defaultBranchAccess: defaultBranchAccessSchema.optional(),
  defaultPathAccess: defaultPathAccessSchema.optional(),
  defaultBaseBranch: defaultBaseBranchSchema.optional(),
  defaultRemoteName: defaultRemoteNameSchema.optional(),
  defaultRemoteUrl: defaultRemoteUrlSchema.optional(),
  gitBotAuthorName: gitBotAuthorNameSchema,
  gitBotAuthorEmail: gitBotAuthorEmailSchema,
  githubTokenEnvVar: githubTokenEnvVarSchema.optional(),
  mode: operatingModeSchema, // Has .default(), so not optional in output type
  settingsBranch: z.string().optional(),
  autoCreateSettingsPR: z.boolean().optional(),
  deploymentName: deploymentNameSchema.optional(),
  contentRoot: contentRootSchema.default('content'),
  sourceRoot: sourceRootSchema.optional(),
  editor: editorConfigSchema.optional(),
  authPlugin: z.custom<AuthPlugin>().optional(),
})

export type FieldConfig = z.infer<typeof fieldSchema>
export type BlockConfig = z.infer<typeof blockSchema>
export type BlockFieldConfig = z.infer<typeof blockFieldSchema>
export type SelectOption = z.infer<typeof selectOptionSchema>
export type ReferenceOption = z.infer<typeof referenceOptionSchema>
export type SelectFieldConfig = Extract<FieldConfig, { type: 'select' }>
export type ReferenceFieldConfig = Extract<FieldConfig, { type: 'reference' }>
export type ObjectFieldConfig = Extract<FieldConfig, { type: 'object' }>
export type CustomFieldConfig = Exclude<FieldConfig, { type: FieldType }>

/**
 * Singleton: A single-instance file with unique schema
 * Made readonly-compatible to support `as const` in tests
 */
export type SingletonConfig = {
  readonly name: string
  readonly path: string
  readonly format: 'md' | 'mdx' | 'json'
  readonly fields: readonly FieldConfig[]
  readonly label?: string
}

/**
 * Collection entries config: shared schema for repeatable entries
 * Made readonly-compatible to support `as const` in tests
 */
export type CollectionEntriesConfig = {
  readonly format?: 'md' | 'mdx' | 'json'
  readonly fields: readonly FieldConfig[]
}

/**
 * Collection: contains nested collections, singletons, or entries
 * Manual definition needed because collectionSchema is z.ZodTypeAny (recursive)
 */
export type CollectionConfig = {
  readonly name: string
  readonly path: string
  readonly label?: string
  readonly entries?: CollectionEntriesConfig
  readonly collections?: readonly CollectionConfig[]
  readonly singletons?: readonly SingletonConfig[]
}

/**
 * Root schema configuration for CanopyCMS.
 * Contains top-level collections and singletons arrays.
 * Can be nested recursively with collections containing sub-collections and singletons.
 * Manual definition needed because rootCollectionSchema is z.ZodTypeAny (recursive)
 */
export type RootCollectionConfig = {
  readonly entries?: CollectionEntriesConfig
  readonly collections?: readonly CollectionConfig[]
  readonly singletons?: readonly SingletonConfig[]
}

// Type assertions: Ensure manual types stay in sync with Zod schemas
// Note: These compare structure ignoring readonly modifiers and recursion

// Assert SingletonConfig matches singletonSchema (non-recursive)
type _AssertSingletonConfigCompatible =
  Omit<SingletonConfig, 'fields'> extends Omit<z.infer<typeof singletonSchema>, 'fields'>
    ? Omit<z.infer<typeof singletonSchema>, 'fields'> extends Omit<SingletonConfig, 'fields'>
      ? true
      : 'SingletonConfig has extra/missing properties compared to singletonSchema'
    : 'SingletonConfig structure does not match singletonSchema'

type _AssertCollectionEntriesConfigCompatible =
  Omit<CollectionEntriesConfig, 'fields'> extends Omit<
    z.infer<typeof collectionEntriesSchema>,
    'fields'
  >
    ? Omit<z.infer<typeof collectionEntriesSchema>, 'fields'> extends Omit<
        CollectionEntriesConfig,
        'fields'
      >
      ? true
      : 'CollectionEntriesConfig has extra/missing properties compared to collectionEntriesSchema'
    : 'CollectionEntriesConfig structure does not match collectionEntriesSchema'

// For recursive types (collectionSchema, rootCollectionSchema), we can't use z.infer directly
// since they're typed as z.ZodTypeAny. Instead, we validate the structure by checking that
// our manual types would be assignable to the inferred types if they weren't any.
//
// We validate the non-recursive parts (since recursive parts reference themselves):
type _AssertCollectionConfigCompatible =
  Omit<CollectionConfig, 'collections' | 'singletons' | 'entries'> extends {
    readonly name: string
    readonly path: string
    readonly label?: string
  }
    ? true
    : 'CollectionConfig base properties (name, path, label) do not match expected structure'

type _AssertRootCollectionConfigCompatible =
  Omit<RootCollectionConfig, 'collections' | 'singletons' | 'entries'> extends Record<string, never>
    ? true
    : 'RootCollectionConfig should only have optional collections, singletons, and entries properties'

// Verify the recursive types reference the correct child types
type _AssertCollectionConfigChildren = CollectionConfig['collections'] extends
  | readonly CollectionConfig[]
  | undefined
  ? CollectionConfig['singletons'] extends readonly SingletonConfig[] | undefined
    ? CollectionConfig['entries'] extends CollectionEntriesConfig | undefined
      ? true
      : 'CollectionConfig.entries type is incorrect'
    : 'CollectionConfig.singletons type is incorrect'
  : 'CollectionConfig.collections type is incorrect'

type _AssertRootCollectionConfigChildren = RootCollectionConfig['collections'] extends
  | readonly CollectionConfig[]
  | undefined
  ? RootCollectionConfig['singletons'] extends readonly SingletonConfig[] | undefined
    ? RootCollectionConfig['entries'] extends CollectionEntriesConfig | undefined
      ? true
      : 'RootCollectionConfig.entries type is incorrect'
    : 'RootCollectionConfig.singletons type is incorrect'
  : 'RootCollectionConfig.collections type is incorrect'

export type PathPermission = z.infer<typeof pathPermissionSchema>
export type MediaConfig = z.infer<typeof mediaSchema>
/**
 * Validated CanopyConfig.
 */
export type CanopyConfig = z.infer<typeof CanopyConfigSchema>
export type CanopyConfigInput = z.input<typeof CanopyConfigSchema>
export type CanopyEditorConfig = z.infer<typeof editorConfigSchema>

/**
 * Client config - subset safe for browser (DRY - derived from CanopyConfig)
 * Use services.flatSchema for O(1) cached access to the flattened schema structure.
 */
export type CanopyClientConfig = Pick<
  CanopyConfig,
  'schema' | 'defaultBaseBranch' | 'contentRoot' | 'editor' | 'mode'
> & {
  flatSchema: FlatSchemaItem[]
}

// Client-only fields that can be provided as overrides (e.g., from auth providers)
export interface ClientOnlyFields {
  editor?: {
    onAccountClick?: () => void
    onLogoutClick?: () => void | Promise<void>
    AccountComponent?: React.ComponentType
  }
}

export type DefaultBranchAccess = z.infer<typeof defaultBranchAccessSchema>
export type DefaultPathAccess = z.infer<typeof defaultPathAccessSchema>
export type DefaultBaseBranch = z.infer<typeof defaultBaseBranchSchema>
export type DefaultRemoteName = z.infer<typeof defaultRemoteNameSchema>
export type DefaultRemoteUrl = z.infer<typeof defaultRemoteUrlSchema>
export type GitBotAuthorName = z.infer<typeof gitBotAuthorNameSchema>
export type GitBotAuthorEmail = z.infer<typeof gitBotAuthorEmailSchema>
export type GithubTokenEnvVar = z.infer<typeof githubTokenEnvVarSchema>
export type CanopyOperatingMode = OperatingMode
export type ContentRoot = z.infer<typeof contentRootSchema>
export type SourceRoot = z.infer<typeof sourceRootSchema>

export type CanopyConfigFragment = Partial<CanopyConfigInput>

/**
 * Flattened schema item for efficient lookups.
 * Discriminated union of collection or singleton with full path resolved.
 * Used for O(1) schema lookups via Map<fullPath, FlatSchemaItem>.
 */
export type FlatSchemaItem =
  | {
      type: 'collection'
      fullPath: string
      name: string
      label?: string
      parentPath?: string
      entries?: CollectionEntriesConfig
      collections?: readonly CollectionConfig[]
      singletons?: readonly SingletonConfig[]
    }
  | {
      type: 'singleton'
      fullPath: string
      name: string
      label?: string
      parentPath?: string
      format: ContentFormat
      fields: readonly FieldConfig[]
    }

const ensureSelectFieldsHaveOptions = (config: any) => {
  const checkFields = (fields: any[] | undefined) => {
    if (!Array.isArray(fields)) return
    for (const field of fields) {
      if (
        field?.type === 'select' &&
        (!Array.isArray(field.options) || field.options.length === 0)
      ) {
        const fieldName = field?.name ?? 'unknown'
        throw new Error(`Select field "${fieldName}" requires options`)
      }
      if (field?.type === 'object') {
        checkFields(field.fields)
      }
      if (field?.type === 'block' && Array.isArray(field.templates)) {
        for (const template of field.templates) {
          checkFields(template.fields)
        }
      }
    }
  }

  const walkSchema = (root: any) => {
    if (!root) return
    // Check entries fields
    if (root.entries?.fields) {
      checkFields(root.entries.fields)
    }
    // Check singletons
    if (Array.isArray(root.singletons)) {
      for (const singleton of root.singletons) {
        checkFields(singleton?.fields)
      }
    }
    // Recursively check nested collections
    if (Array.isArray(root.collections)) {
      for (const collection of root.collections) {
        walkSchema(collection)
      }
    }
  }

  walkSchema((config as any)?.schema)
}

/**
 * Normalize all paths in the root collection schema
 */
const normalizeSchemaPathsRoot = (root: RootCollectionConfig): RootCollectionConfig => {
  const normalizeCollection = (collection: CollectionConfig, parentPath = ''): CollectionConfig => {
    const fullPath = parentPath ? join(parentPath, collection.path) : collection.path
    const normalizedFull = normalizePathValue(fullPath)
    if (!normalizedFull || normalizedFull.includes('..')) {
      throw new Error(`Invalid path for collection "${collection.name}"`)
    }

    return {
      ...collection,
      path: normalizePathValue(collection.path),
      singletons: collection.singletons?.map((s: SingletonConfig) => ({
        ...s,
        path: normalizePathValue(s.path),
      })),
      collections: collection.collections?.map((c: CollectionConfig) =>
        normalizeCollection(c, normalizedFull),
      ),
    }
  }

  return {
    ...root,
    singletons: root.singletons?.map((s: SingletonConfig) => ({
      ...s,
      path: normalizePathValue(s.path),
    })),
    collections: root.collections?.map((c: CollectionConfig) => normalizeCollection(c)),
  }
}

/**
 * Flatten the root collection schema into a flat array for O(1) lookups.
 * Traverses the nested schema structure and returns all collections and singletons
 * with their full paths resolved.
 *
 * @param root - The root collection configuration
 * @param basePath - Optional base path to prepend (e.g., 'content')
 * @returns Array of flattened schema items with full paths
 *
 * @example
 * const flat = flattenSchema(config.schema, 'content')
 * const map = new Map(flat.map(item => [item.fullPath, item]))
 * const item = map.get('content/posts') // O(1) lookup
 */
export const flattenSchema = (root: RootCollectionConfig, basePath = ''): FlatSchemaItem[] => {
  const flat: FlatSchemaItem[] = []
  const base = normalizePathValue(basePath || '')

  const walkCollection = (collection: CollectionConfig, parentPath: string) => {
    const normalizedPath = normalizePathValue(collection.path)
    // Build fullPath: if we have a parent, join with parent; otherwise use collection path
    let fullPath: string
    if (parentPath) {
      // Child collection: use only the collection name (leaf segment), not the full path
      // The full path from collection.path includes parent path segments that are already in parentPath
      fullPath = join(parentPath, collection.name)
    } else {
      // Root-level collection: prepend base path
      fullPath = base ? join(base, normalizedPath) : normalizedPath
    }
    const normalizedFull = normalizePathValue(fullPath)

    // Add the collection itself
    flat.push({
      type: 'collection',
      fullPath: normalizedFull,
      name: collection.name,
      label: collection.label,
      parentPath: parentPath || undefined,
      entries: collection.entries,
      collections: collection.collections,
      singletons: collection.singletons,
    })

    // Add singletons in this collection
    if (collection.singletons) {
      for (const singleton of collection.singletons) {
        const singletonPath = join(normalizedFull, normalizePathValue(singleton.path))
        flat.push({
          type: 'singleton',
          fullPath: normalizePathValue(singletonPath),
          name: singleton.name,
          label: singleton.label,
          parentPath: normalizedFull,
          format: singleton.format,
          fields: singleton.fields,
        })
      }
    }

    // Recursively process nested collections
    if (collection.collections) {
      for (const child of collection.collections) {
        walkCollection(child, normalizedFull)
      }
    }
  }

  // Add root-level singletons
  if (root.singletons) {
    for (const singleton of root.singletons) {
      const singletonPath = base
        ? join(base, normalizePathValue(singleton.path))
        : normalizePathValue(singleton.path)
      flat.push({
        type: 'singleton',
        fullPath: normalizePathValue(singletonPath),
        name: singleton.name,
        label: singleton.label,
        parentPath: undefined,
        format: singleton.format,
        fields: singleton.fields,
      })
    }
  }

  // Process root-level collections
  if (root.collections) {
    for (const collection of root.collections) {
      walkCollection(collection, '')
    }
  }

  return flat
}

export const validateCanopyConfig = (config: unknown): CanopyConfig => {
  ensureSelectFieldsHaveOptions(config)
  const parsed = CanopyConfigSchema.parse(config)
  const normalized = {
    ...parsed,
    contentRoot: normalizePathValue(parsed.contentRoot ?? 'content'),
    schema: parsed.schema ? normalizeSchemaPathsRoot(parsed.schema) : undefined,
  }

  return normalized as CanopyConfig
}

/**
 * Helper for authoring typed config files (canopycms.config.ts).
 * Performs runtime validation using the CanopyConfig schema.
 * Returns a bundle with `server` (full config) and `client(overrides)` (safe subset).
 */
type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

export type CanopyConfigAuthoring = Omit<CanopyConfigInput, 'schema'> & {
  schema: DeepReadonly<CanopyConfigInput['schema']>
}

export function defineCanopyConfig(config: CanopyConfigInput | CanopyConfigAuthoring) {
  const validated = validateCanopyConfig(config as CanopyConfigInput)

  return {
    // Full server config - all fields including sensitive data
    server: validated,

    // Client config helper - extracts safe subset and merges overrides
    client: (clientOverrides?: ClientOnlyFields): CanopyClientConfig => {
      const { schema, defaultBaseBranch, contentRoot, editor, mode } = validated
      const clientConfig: CanopyClientConfig = {
        schema,
        defaultBaseBranch,
        contentRoot,
        editor,
        mode,
        flatSchema: schema ? flattenSchema(schema, contentRoot) : [],
      }

      // Merge client overrides (e.g., auth handlers from useClerkAuthConfig)
      if (clientOverrides?.editor) {
        clientConfig.editor = {
          ...clientConfig.editor,
          ...clientOverrides.editor,
        }
      }

      return clientConfig
    },
  }
}

/**
 * Helper to compose config fragments defined across multiple files.
 * Later fragments can override media.
 */
export const composeCanopyConfig = (...fragments: CanopyConfigFragment[]): CanopyConfig => {
  const collections: CollectionConfig[] = []
  const singletons: SingletonConfig[] = []
  let media: MediaConfig | undefined
  let contentRoot: ContentRoot | undefined
  let sourceRoot: SourceRoot | undefined
  let defaultBranchAccess: DefaultBranchAccess | undefined
  let defaultPathAccess: DefaultPathAccess | undefined
  let defaultBaseBranch: DefaultBaseBranch | undefined
  let defaultRemoteName: DefaultRemoteName | undefined
  let defaultRemoteUrl: DefaultRemoteUrl | undefined
  let gitBotAuthorName: GitBotAuthorName | undefined
  let gitBotAuthorEmail: GitBotAuthorEmail | undefined
  let mode: CanopyOperatingMode | undefined
  let deploymentName: string | undefined

  for (const fragment of fragments) {
    if (fragment.schema) {
      if (fragment.schema.collections) {
        collections.push(...fragment.schema.collections)
      }
      if (fragment.schema.singletons) {
        singletons.push(...fragment.schema.singletons)
      }
    }
    if (fragment.media) {
      media = fragment.media
    }
    if (fragment.contentRoot) {
      contentRoot = fragment.contentRoot
    }
    if (fragment.sourceRoot) {
      sourceRoot = fragment.sourceRoot
    }
    if (fragment.defaultBranchAccess) {
      defaultBranchAccess = fragment.defaultBranchAccess
    }
    if (fragment.defaultPathAccess) {
      defaultPathAccess = fragment.defaultPathAccess
    }
    if (fragment.defaultBaseBranch) {
      defaultBaseBranch = fragment.defaultBaseBranch
    }
    if (fragment.defaultRemoteName) {
      defaultRemoteName = fragment.defaultRemoteName
    }
    if (fragment.defaultRemoteUrl) {
      defaultRemoteUrl = fragment.defaultRemoteUrl
    }
    if (fragment.gitBotAuthorName) {
      gitBotAuthorName = fragment.gitBotAuthorName
    }
    if (fragment.gitBotAuthorEmail) {
      gitBotAuthorEmail = fragment.gitBotAuthorEmail
    }
    if (fragment.mode) {
      mode = fragment.mode
    }
    if (fragment.deploymentName) {
      deploymentName = fragment.deploymentName
    }
  }

  const schema: RootCollectionConfig = {
    ...(collections.length > 0 ? { collections } : {}),
    ...(singletons.length > 0 ? { singletons } : {}),
  }

  const merged: CanopyConfigInput = {
    schema,
    gitBotAuthorName: gitBotAuthorName as string,
    gitBotAuthorEmail: gitBotAuthorEmail as string,
    ...(media ? { media } : {}),
    ...(contentRoot ? { contentRoot } : {}),
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(defaultBranchAccess ? { defaultBranchAccess } : {}),
    ...(defaultPathAccess ? { defaultPathAccess } : {}),
    ...(defaultBaseBranch ? { defaultBaseBranch } : {}),
    ...(defaultRemoteName ? { defaultRemoteName } : {}),
    ...(defaultRemoteUrl ? { defaultRemoteUrl } : {}),
    ...(gitBotAuthorName ? { gitBotAuthorName } : {}),
    ...(gitBotAuthorEmail ? { gitBotAuthorEmail } : {}),
    ...(mode ? { mode } : {}),
    ...(deploymentName ? { deploymentName } : {}),
  }

  return validateCanopyConfig(merged)
}
