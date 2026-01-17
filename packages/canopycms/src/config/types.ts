/**
 * Type definitions for CanopyCMS configuration.
 * These are pure TypeScript types - Zod schemas are in ./schemas/
 */

import type { CanopyGroupId, CanopyUserId } from '../types'
import type { OperatingMode } from '../operating-mode'
import type { AuthPlugin } from '../auth/plugin'

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

// Permission types
export type PermissionLevel = 'read' | 'edit' | 'review'

export interface PermissionTarget {
  allowedUsers?: CanopyUserId[]
  allowedGroups?: CanopyGroupId[]
}

export interface PathPermission {
  path: string
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
 * Singleton: A single-instance file with unique schema
 * Made readonly-compatible to support `as const` in tests
 */
export type SingletonConfig = {
  readonly name: string
  readonly path: string
  readonly format: ContentFormat
  readonly fields: readonly FieldConfig[]
  readonly label?: string
}

/**
 * Collection entries config: shared schema for repeatable entries
 * Made readonly-compatible to support `as const` in tests
 */
export type CollectionEntriesConfig = {
  readonly format?: ContentFormat
  readonly fields: readonly FieldConfig[]
}

/**
 * Collection: contains nested collections, singletons, or entries
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
 */
export type RootCollectionConfig = {
  readonly entries?: CollectionEntriesConfig
  readonly collections?: readonly CollectionConfig[]
  readonly singletons?: readonly SingletonConfig[]
}

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
  schema?: RootCollectionConfig
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
  schema?: RootCollectionConfig
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
