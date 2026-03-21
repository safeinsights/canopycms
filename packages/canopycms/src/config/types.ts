/**
 * Type definitions for CanopyCMS configuration.
 * These are pure TypeScript types - Zod schemas are in ./schemas/
 */

import type { CanopyGroupId, CanopyUserId } from '../types'
import type { OperatingMode } from '../operating-mode'
import type { AuthPlugin } from '../auth/plugin'
import type { LogicalPath, ContentId } from '../paths/types'
import type { PermissionPath } from '../authorization/types'

// Field types
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

export const fieldTypes = [...primitiveFieldTypes, 'select', 'reference', 'object', 'block'] as const

export type PrimitiveFieldType = (typeof primitiveFieldTypes)[number]
export type FieldType = (typeof fieldTypes)[number]
export type ContentFormat = 'md' | 'mdx' | 'json'
export type MediaAdapterKind = 'local' | 's3' | 'lfs' | (string & {})

// Permission types
export type PermissionLevel = 'read' | 'edit' | 'review'

export interface PermissionTarget {
  allowedUsers?: CanopyUserId[]
  allowedGroups?: CanopyGroupId[]
}

export interface PathPermission {
  path: PermissionPath
  read?: PermissionTarget
  edit?: PermissionTarget
  review?: PermissionTarget
}

// Select/Reference options
export type SelectOption = string | { label: string; value: string }
export type ReferenceOption = string | { label: string; value: string }

// Field configuration types
export interface BaseFieldConfig {
  name: string
  label?: string
  required?: boolean
  list?: boolean
}

export interface PrimitiveFieldConfig extends BaseFieldConfig {
  type: PrimitiveFieldType
}

export interface SelectFieldConfig extends BaseFieldConfig {
  type: 'select'
  options: SelectOption[]
}

export interface ReferenceFieldConfig extends BaseFieldConfig {
  type: 'reference'
  collections: string[]
  displayField?: string
  options?: ReferenceOption[]
}

export interface BlockConfig {
  name: string
  label?: string
  fields: FieldConfig[]
}

export interface BlockFieldConfig extends BaseFieldConfig {
  type: 'block'
  templates: BlockConfig[]
}

export interface ObjectFieldConfig extends BaseFieldConfig {
  type: 'object'
  fields: FieldConfig[]
}

/**
 * Custom field config for user-defined field types.
 * The type must not conflict with built-in types.
 * Note: We use a branded type approach to avoid index signature issues.
 */
export type CustomFieldConfig = BaseFieldConfig & {
  type: Exclude<string, FieldType>
}

export type FieldConfig =
  | PrimitiveFieldConfig
  | SelectFieldConfig
  | ReferenceFieldConfig
  | BlockFieldConfig
  | ObjectFieldConfig
  | CustomFieldConfig

// Media configuration
export type MediaConfig =
  | { adapter: 'local'; publicBaseUrl?: string }
  | { adapter: 's3'; bucket: string; region: string; publicBaseUrl?: string }
  | { adapter: 'lfs'; publicBaseUrl?: string }
  | { adapter: string; publicBaseUrl?: string }

/**
 * Field definitions for one entry type — the array of FieldConfig that
 * describes which fields an entry of this type contains.
 *
 * Contrast with BranchSchema, which is the full collection tree for a branch.
 */
export type EntrySchema = readonly FieldConfig[]

/**
 * Entry type config: defines a type of content within a collection.
 * Each type has its own entry schema (fields) and can have cardinality constraints.
 *
 * Examples:
 * - { name: 'post', format: 'mdx', schema: postSchema } - unlimited posts
 * - { name: 'settings', format: 'json', schema: settingsSchema, maxItems: 1 } - restricted to one instance
 */
export type EntryTypeConfig = {
  readonly name: string
  readonly format: ContentFormat
  readonly schema: EntrySchema
  /** Entry schema registry key (e.g., "postSchema"). Set during schema resolution. */
  readonly schemaRef?: string
  readonly label?: string
  readonly default?: boolean // Is this the default type for "Add" button?
  readonly maxItems?: number // Limit instances (e.g., 1 = only one entry allowed)
}

/**
 * Collection: contains nested collections and typed entries.
 * The entries array defines the types of content allowed in this collection.
 */
export type CollectionConfig = {
  readonly name: string
  readonly path: string
  readonly label?: string
  /** 12-char content ID from the collection's directory name. Optional: absent in static configs. */
  readonly contentId?: ContentId
  /** Array of entry types allowed in this collection */
  readonly entries?: readonly EntryTypeConfig[]
  readonly collections?: readonly CollectionConfig[]
  /** Ordering of items by embedded ID. Items not in order appear at end alphabetically. */
  readonly order?: readonly string[]
}

/**
 * Root schema configuration for CanopyCMS.
 * Contains top-level collections and entries (typed content at the root level).
 */
export type RootCollectionConfig = {
  /** Optional label for the root collection (e.g., "All Files", "Content") */
  readonly label?: string
  /** Entry types at the root level */
  readonly entries?: readonly EntryTypeConfig[]
  readonly collections?: readonly CollectionConfig[]
  /** Ordering of root items by embedded ID. Items not in order appear at end alphabetically. */
  readonly order?: readonly string[]
}

/**
 * The full collection structure tree for one branch — the resolved schema
 * describing all collections, entry types, and their fields.
 *
 * Contrast with EntrySchema, which is the field definitions for a single entry type.
 */
export type BranchSchema = RootCollectionConfig

// Editor configuration
export interface CanopyEditorConfig {
  title?: string
  subtitle?: string
  theme?: unknown
  previewBase?: Record<string, string>
  onAccountClick?: () => void
  onLogoutClick?: () => void
  AccountComponent?: React.ComponentType
}

// Default value types
export type DefaultBranchAccess = 'allow' | 'deny'
export type DefaultPathAccess = 'allow' | 'deny'
export type DefaultBaseBranch = string
export type DefaultRemoteName = string
export type DefaultRemoteUrl = string
export type GitBotAuthorName = string
export type GitBotAuthorEmail = string
export type GithubTokenEnvVar = string
export type CanopyOperatingMode = OperatingMode
export type ContentRoot = string
export type SourceRoot = string | undefined

/**
 * Validated CanopyConfig - the runtime configuration object.
 */
export interface CanopyConfig {
  media?: MediaConfig
  defaultBranchAccess?: DefaultBranchAccess
  defaultPathAccess?: DefaultPathAccess
  defaultBaseBranch?: DefaultBaseBranch
  defaultRemoteName?: DefaultRemoteName
  defaultRemoteUrl?: DefaultRemoteUrl
  gitBotAuthorName: GitBotAuthorName
  gitBotAuthorEmail: GitBotAuthorEmail
  githubTokenEnvVar?: GithubTokenEnvVar
  mode: CanopyOperatingMode
  settingsBranch?: string
  autoCreateSettingsPR?: boolean
  deploymentName?: string
  contentRoot: ContentRoot
  sourceRoot?: SourceRoot
  editor?: CanopyEditorConfig
  authPlugin?: AuthPlugin
}

/**
 * Input type for config authoring (allows looser types before validation)
 */
export interface CanopyConfigInput {
  media?: MediaConfig
  defaultBranchAccess?: DefaultBranchAccess
  defaultPathAccess?: DefaultPathAccess
  defaultBaseBranch?: string
  defaultRemoteName?: string
  defaultRemoteUrl?: string
  gitBotAuthorName: string
  gitBotAuthorEmail: string
  githubTokenEnvVar?: string
  mode?: OperatingMode
  settingsBranch?: string
  autoCreateSettingsPR?: boolean
  deploymentName?: string
  contentRoot?: string
  sourceRoot?: string
  editor?: CanopyEditorConfig
  authPlugin?: AuthPlugin
}

export type CanopyConfigFragment = Partial<CanopyConfigInput>

/**
 * Flattened schema item for efficient lookups.
 * Discriminated union of collection or entry type with logical path resolved.
 * Used for O(1) schema lookups via Map<logicalPath, FlatSchemaItem>.
 */
export type FlatSchemaItem =
  | {
      type: 'collection'
      logicalPath: LogicalPath
      name: string
      label?: string
      /** 12-char content ID from the collection's directory name. Optional: absent in static configs. */
      contentId?: ContentId
      parentPath?: LogicalPath
      /** Array of entry types in this collection */
      entries?: readonly EntryTypeConfig[]
      collections?: readonly CollectionConfig[]
      /** Ordering of items by embedded ID. Items not in order appear at end alphabetically. */
      order?: readonly string[]
    }
  | {
      /** An entry type within a collection */
      type: 'entry-type'
      logicalPath: LogicalPath
      /** The entry type name (e.g., 'post', 'doc') */
      name: string
      label?: string
      /** Path of the parent collection */
      parentPath: LogicalPath
      format: ContentFormat
      schema: EntrySchema
      /** Entry schema registry key (e.g., "postSchema"). Set during schema resolution. */
      schemaRef?: string
      default?: boolean
      maxItems?: number
    }

/**
 * Client config - subset safe for browser (DRY - derived from CanopyConfig)
 * Use flatSchema for O(1) cached access to the flattened schema structure.
 * Schema is loaded from .collection.json files on the server and provided as flatSchema.
 */
export type CanopyClientConfig = Pick<
  CanopyConfig,
  'defaultBaseBranch' | 'contentRoot' | 'editor' | 'mode'
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
