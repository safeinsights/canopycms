import { isAbsolute, join, normalize } from 'pathe'

import { z } from 'zod'

import type { CanopyGroupId, CanopyUserId } from './types'
import type { BranchMode } from './paths'
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

const pathPermissionSchema = z.object({
  path: z.string().min(1),
  allowedUsers: z.array(z.string() as z.ZodType<CanopyUserId>).optional(),
  allowedGroups: z.array(z.string() as z.ZodType<CanopyGroupId>).optional(),
  managerOrAdminAllowed: z.boolean().optional(),
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
const defaultBaseBranchSchema = z.string().default('main')
const defaultRemoteNameSchema = z.string().default('origin')
const defaultRemoteUrlSchema = z.string().min(1)
const gitBotAuthorNameSchema = z.string().min(1)
const gitBotAuthorEmailSchema = z.string().email()
const githubTokenEnvVarSchema = z.string().default('GITHUB_BOT_TOKEN')
const branchModeSchema = z.enum(['prod', 'local-prod-sim', 'local-simple']).default('local-simple')
const contentRootSchema = relativePathSchema.default('content')
const sourceRootSchema = z.string().min(1).optional()

const schemaBase = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  path: relativePathSchema,
  format: z.enum(['md', 'mdx', 'json']),
  fields: z.array(z.lazy(() => fieldSchema)).min(1),
})

let schemaItemSchema: z.ZodTypeAny

const collectionSchema = schemaBase.extend({
  type: z.literal('collection'),
  children: z.array(z.lazy(() => schemaItemSchema)).optional(),
})

const singletonSchema = schemaBase.extend({
  type: z.literal('singleton'),
  children: z.never().optional(),
})

const editorConfigSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  theme: z.unknown().optional(),
  previewBase: z.record(z.string()).optional(),
})

schemaItemSchema = z.discriminatedUnion('type', [collectionSchema, singletonSchema])

export const CanopyConfigSchema = z
  .object({
    schema: z.array(schemaItemSchema).min(1),
    pathPermissions: z.array(pathPermissionSchema).optional(),
    media: mediaSchema.optional(),
    defaultBranchAccess: defaultBranchAccessSchema.optional(),
    defaultBaseBranch: defaultBaseBranchSchema.optional(),
    defaultRemoteName: defaultRemoteNameSchema.optional(),
    defaultRemoteUrl: defaultRemoteUrlSchema.optional(),
    gitBotAuthorName: gitBotAuthorNameSchema,
    gitBotAuthorEmail: gitBotAuthorEmailSchema,
    githubTokenEnvVar: githubTokenEnvVarSchema.optional(),
    mode: branchModeSchema.optional(),
    contentRoot: contentRootSchema.default('content'),
    sourceRoot: sourceRootSchema.optional(),
    editor: editorConfigSchema.optional(),
    authPlugin: z.custom<AuthPlugin>().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.schema?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one collection or singleton is required',
      })
    }
    // Show deprecation warning for config-based pathPermissions
    if (data.pathPermissions && data.pathPermissions.length > 0) {
      console.warn(
        'DEPRECATION WARNING: config.pathPermissions is deprecated. ' +
          'Use .canopycms/permissions.json instead. ' +
          'Permissions from config will be used as fallback if .canopycms/permissions.json does not exist.',
      )
    }
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
export type CollectionConfig = z.infer<typeof collectionSchema>
export type SingletonCollectionConfig = z.infer<typeof singletonSchema>
export type SchemaItemConfig = z.infer<typeof schemaItemSchema>
export type PathPermission = z.infer<typeof pathPermissionSchema>
export type MediaConfig = z.infer<typeof mediaSchema>
export type CanopyConfig = z.infer<typeof CanopyConfigSchema>
export type CanopyConfigInput = z.input<typeof CanopyConfigSchema>
export type CanopyEditorConfig = z.infer<typeof editorConfigSchema>
export type DefaultBranchAccess = z.infer<typeof defaultBranchAccessSchema>
export type DefaultBaseBranch = z.infer<typeof defaultBaseBranchSchema>
export type DefaultRemoteName = z.infer<typeof defaultRemoteNameSchema>
export type DefaultRemoteUrl = z.infer<typeof defaultRemoteUrlSchema>
export type GitBotAuthorName = z.infer<typeof gitBotAuthorNameSchema>
export type GitBotAuthorEmail = z.infer<typeof gitBotAuthorEmailSchema>
export type GithubTokenEnvVar = z.infer<typeof githubTokenEnvVarSchema>
export type CanopyBranchMode = BranchMode
export type ContentRoot = z.infer<typeof contentRootSchema>
export type SourceRoot = z.infer<typeof sourceRootSchema>

export type CanopyConfigFragment = Partial<CanopyConfigInput>

export type ResolvedSchemaItem = (CollectionConfig | SingletonCollectionConfig) & {
  fullPath: string
  parentPath?: string
  children?: ResolvedSchemaItem[]
}

export type FlatCollection = Omit<ResolvedSchemaItem, 'children'> & {
  type: 'collection' | 'singleton'
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

  const walkSchema = (nodes?: any[]) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      checkFields(node?.fields)
      if (node?.children) {
        walkSchema(node.children)
      }
    }
  }

  walkSchema((config as any)?.schema)
}

const normalizeSchemaPaths = (items: SchemaItemConfig[], parentPath = ''): SchemaItemConfig[] => {
  return items.map((item) => {
    const fullPath = parentPath ? join(parentPath, item.path) : item.path
    const normalizedFull = normalizePathValue(fullPath)
    if (!normalizedFull || normalizedFull.includes('..')) {
      throw new Error(`Invalid path for schema item "${item.name}"`)
    }
    const normalizedItem = {
      ...item,
      path: normalizePathValue(item.path),
    } as SchemaItemConfig
    if (item.type === 'collection' && item.children) {
      return {
        ...normalizedItem,
        children: normalizeSchemaPaths(item.children, normalizedFull),
      }
    }
    return normalizedItem
  })
}

export const resolveSchema = (items: SchemaItemConfig[], basePath = ''): ResolvedSchemaItem[] => {
  const base = normalizePathValue(basePath || '')
  const walk = (nodes: SchemaItemConfig[], parentPath: string): ResolvedSchemaItem[] => {
    return nodes.map((item) => {
      const normalizedItemPath = normalizePathValue(item.path)
      let fullPath: string
      if (!parentPath && base) {
        if (normalizedItemPath === base || normalizedItemPath.startsWith(`${base}/`)) {
          fullPath = normalizedItemPath
        } else {
          fullPath = join(base, normalizedItemPath)
        }
      } else if (parentPath) {
        fullPath = join(parentPath, normalizedItemPath)
      } else {
        fullPath = normalizedItemPath
      }
      const normalizedFull = normalizePathValue(fullPath)
      const resolved: ResolvedSchemaItem = {
        ...item,
        fullPath: normalizedFull,
        parentPath: parentPath || undefined,
      }
      if (item.type === 'collection' && item.children) {
        resolved.children = walk(item.children, normalizedFull)
      }
      return resolved
    })
  }

  return walk(items, '')
}

export const flattenSchema = (items: ResolvedSchemaItem[]): FlatCollection[] => {
  const flat: FlatCollection[] = []
  const walk = (node: ResolvedSchemaItem) => {
    const { children, ...rest } = node
    flat.push(rest as FlatCollection)
    if (node.type === 'collection' && children) {
      children.forEach((child: ResolvedSchemaItem) => walk(child))
    }
  }
  items.forEach((node) => walk(node))
  return flat
}

export const validateCanopyConfig = (config: unknown): CanopyConfig => {
  ensureSelectFieldsHaveOptions(config)
  const parsed = CanopyConfigSchema.parse(config)
  const normalized = {
    ...parsed,
    contentRoot: normalizePathValue(parsed.contentRoot ?? 'content'),
    schema: normalizeSchemaPaths(parsed.schema),
  }
  // Ensure paths are resolvable and traversal-safe
  resolveSchema(normalized.schema, normalized.contentRoot)
  return normalized
}

/**
 * Helper for authoring typed config files (canopycms.config.ts).
 * Performs runtime validation using the CanopyConfig schema.
 */
type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

export type CanopyConfigAuthoring = Omit<CanopyConfigInput, 'schema' | 'pathPermissions'> & {
  schema: DeepReadonly<CanopyConfigInput['schema']>
  pathPermissions?: DeepReadonly<CanopyConfigInput['pathPermissions']>
}

export function defineCanopyConfig(config: CanopyConfigInput): CanopyConfig
export function defineCanopyConfig(config: CanopyConfigAuthoring): CanopyConfig
export function defineCanopyConfig(
  config: CanopyConfigInput | CanopyConfigAuthoring,
): CanopyConfig {
  return validateCanopyConfig(config as CanopyConfigInput)
}

/**
 * Helper to compose config fragments defined across multiple files.
 * Later fragments can override media, and path permissions are concatenated.
 */
export const composeCanopyConfig = (...fragments: CanopyConfigFragment[]): CanopyConfig => {
  const schema: SchemaItemConfig[] = []
  let pathPermissions: PathPermission[] | undefined
  let media: MediaConfig | undefined
  let contentRoot: ContentRoot | undefined
  let sourceRoot: SourceRoot | undefined
  let defaultBranchAccess: DefaultBranchAccess | undefined
  let defaultBaseBranch: DefaultBaseBranch | undefined
  let defaultRemoteName: DefaultRemoteName | undefined
  let defaultRemoteUrl: DefaultRemoteUrl | undefined
  let gitBotAuthorName: GitBotAuthorName | undefined
  let gitBotAuthorEmail: GitBotAuthorEmail | undefined
  let mode: CanopyBranchMode | undefined

  for (const fragment of fragments) {
    if (fragment.schema) {
      schema.push(...fragment.schema)
    }
    if (fragment.pathPermissions) {
      pathPermissions = [...(pathPermissions ?? []), ...fragment.pathPermissions]
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
  }

  const merged: CanopyConfigInput = {
    schema,
    gitBotAuthorName: gitBotAuthorName as string,
    gitBotAuthorEmail: gitBotAuthorEmail as string,
    ...(pathPermissions ? { pathPermissions } : {}),
    ...(media ? { media } : {}),
    ...(contentRoot ? { contentRoot } : {}),
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(defaultBranchAccess ? { defaultBranchAccess } : {}),
    ...(defaultBaseBranch ? { defaultBaseBranch } : {}),
    ...(defaultRemoteName ? { defaultRemoteName } : {}),
    ...(defaultRemoteUrl ? { defaultRemoteUrl } : {}),
    ...(gitBotAuthorName ? { gitBotAuthorName } : {}),
    ...(gitBotAuthorEmail ? { gitBotAuthorEmail } : {}),
    ...(mode ? { mode } : {}),
  }

  return validateCanopyConfig(merged)
}
