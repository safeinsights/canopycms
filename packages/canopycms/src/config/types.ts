/**
 * Type definitions for CanopyCMS configuration.
 * These are pure TypeScript types - Zod schemas are in ./schemas/
 */

import type { CanopyGroupId, CanopyUserId } from '../types'
import type { OperatingMode } from '../operating-mode'
import type { AuthPlugin } from '../auth/plugin'
import type { LogicalPath, ContentId } from '../paths/types'
import type { PermissionPath } from '../authorization/types'
import type { EntryLinkUrlResolver } from '../entry-link-resolver'
import type { CropRect } from '../assets/transform-directives'

// Field types
export const primitiveFieldTypes = [
  'string',
  'number',
  'boolean',
  'datetime',
  'rich-text',
  'markdown',
  'mdx',
  'code',
] as const

// 'image' is not a primitive: it has a structured value (ImageFieldValue) and
// its own per-type config (ImageFieldConfig, below), so it gets a dedicated
// entry rather than sharing PrimitiveFieldConfig's flat shape.
export const fieldTypes = [
  ...primitiveFieldTypes,
  'image',
  'select',
  'reference',
  'object',
  'block',
  'group',
] as const

export type PrimitiveFieldType = (typeof primitiveFieldTypes)[number]
export type FieldType = (typeof fieldTypes)[number]
export type ContentFormat = 'md' | 'mdx' | 'json' | 'yaml'
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
  description?: string
  required?: boolean
  list?: boolean
  /** Mark this field as the display title for entries using this schema. At most one field per schema. */
  isTitle?: boolean
  /**
   * Mark this field as the body content for md/mdx entries.
   * The field must be type 'markdown' or 'mdx'. At most one per schema.
   * When present, the file's markdown content is mapped to this field,
   * making TypeFromEntrySchema include it without manual `& { body: string }`.
   */
  isBody?: boolean
}

export interface PrimitiveFieldConfig extends BaseFieldConfig {
  type: PrimitiveFieldType
}

export interface SelectFieldConfig extends BaseFieldConfig {
  type: 'select'
  options: SelectOption[]
}

/**
 * Runtime reference field config. Note: `resolvedSchema` for type inference
 * lives only on InferableField in entry-schema.ts — do not add it here,
 * as it would flow into validation, serialization, and editor code.
 */
export interface ReferenceFieldConfig extends BaseFieldConfig {
  type: 'reference'
  collections?: string[]
  entryTypes?: string[]
  displayField?: string
  options?: ReferenceOption[]
}

/**
 * Image field config. The value is a structured object (see `ImageFieldValue`
 * below), not a bare URL string.
 */
export interface ImageFieldConfig extends BaseFieldConfig {
  type: 'image'
  /**
   * "W:H" aspect ratio (e.g. "16:9", "1:1") that triggers a crop step in the
   * editor. Validated at config-parse time: positive integers on both sides.
   */
  aspect?: string
  /** Allow an empty `alt`. Default: alt text is required (accessibility). */
  altOptional?: boolean
}

/**
 * Structured value stored for an `image` field. `src` is typically a
 * root-relative `/assets/...` URL from the asset pipeline, but any URL string
 * is accepted — adopters may reference external images. `alt` is required
 * unless the field config sets `altOptional: true`. `crop` is a normalized
 * rect using the same constraints as the transform directive parser's `c=`
 * directive (see `assets/transform-directives.ts`).
 */
export interface ImageFieldValue {
  src: string
  alt: string
  width?: number
  height?: number
  crop?: CropRect
}

export interface BlockConfig {
  name: string
  label?: string
  description?: string
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
 * Inline group field config: visually groups fields in the editor without creating
 * a nested data key. Fields inside the group are stored flat in the parent content.
 * Use defineInlineFieldGroup() to create these.
 * For data-nested grouping, use ObjectFieldConfig / defineNestedFieldGroup() instead.
 */
export interface InlineGroupFieldConfig {
  type: 'group'
  name: string // React key + duplicate-name validation; NOT a data key
  label?: string
  description?: string
  fields: FieldConfig[] // FieldConfig includes InlineGroupFieldConfig — nested groups work
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
  | ImageFieldConfig
  | BlockFieldConfig
  | ObjectFieldConfig
  | InlineGroupFieldConfig
  | CustomFieldConfig

// Media configuration.
// Kept in sync with the discriminated `mediaSchema` in config/schemas/media.ts — only
// implemented adapters get a literal branch here (see BACKLOG.md "Asset adapters").
export type MediaConfig =
  | { adapter: 'local'; publicBaseUrl?: string; directory?: string }
  | {
      adapter: 's3'
      bucket: string
      region: string
      publicBaseUrl?: string
      maxUploadBytes?: number
    }
  | { adapter: 'lfs'; publicBaseUrl?: string }

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
  readonly description?: string
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
  readonly description?: string
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
export type DeployedAs = 'static' | 'server'

/**
 * How the dev server surfaces working-tree content edits that diverge from the branch clone it serves.
 * - 'warn' (default): on startup and on content/** changes, log a warning naming files when the
 *   working tree diverges from the dev branch clone (so the staleness is visible, not silent).
 * - 'off': no watcher, no warnings.
 *
 * Note: there is no 'auto' (auto-push) mode. Auto-overwriting the branch clone from the working tree
 * would silently clobber uncommitted editor "Save" state with no Canopy-level recovery path for the
 * editor. Reconcile explicitly via `canopycms sync push` (which has interactive conflict handling).
 */
export type DevContentSyncMode = 'off' | 'warn'

/** Dev-mode-only behavior. Ignored when `mode !== 'dev'`. */
export interface DevConfig {
  contentSync?: DevContentSyncMode
}

/** Issue returned by the `validateEntry` hook. `error` rejects the save; `warning` is returned with it. */
export interface EntryValidationIssue {
  level: 'error' | 'warning'
  message: string
  /** Path of the offending field (e.g. 'body'), when known. */
  fieldPath?: string
}

/** Input passed to the `validateEntry` hook on every editor save. */
export interface ValidateEntryInput {
  /** Logical entry path including the content root (e.g. 'content/posts/hello-world'). */
  entryPath: string
  branch: string
  /** Entry type name when the editor specifies one (collections with multiple entry types). */
  entryType?: string
  format: 'md' | 'mdx' | 'json' | 'yaml'
  data: Record<string, unknown>
  /** Markdown body for md/mdx formats. */
  body?: string
}

/**
 * Adopter-defined save-time validation (e.g. "body must compile as MDX" so a bad
 * draft can't break the site's production build). Runs server-side before the
 * entry file is written.
 */
export type ValidateEntryHook = (
  input: ValidateEntryInput,
) => EntryValidationIssue[] | Promise<EntryValidationIssue[]>

/**
 * Validated CanopyConfig - the runtime configuration object.
 */
export interface CanopyConfig {
  media?: MediaConfig
  defaultBranchAccess?: DefaultBranchAccess
  defaultPathAccess?: DefaultPathAccess
  defaultBaseBranch?: DefaultBaseBranch
  /** Which workspace to serve content from by default. Auto-detected from git HEAD in dev mode. */
  defaultActiveBranch?: string
  defaultRemoteName?: DefaultRemoteName
  defaultRemoteUrl?: DefaultRemoteUrl
  gitBotAuthorName: GitBotAuthorName
  gitBotAuthorEmail: GitBotAuthorEmail
  githubTokenEnvVar?: GithubTokenEnvVar
  mode: CanopyOperatingMode
  /** How this build is deployed. 'static' = no request context, no auth. Default: 'server'. */
  deployedAs: DeployedAs
  settingsBranch?: string
  autoCreateSettingsPR?: boolean
  deploymentName?: string
  contentRoot: ContentRoot
  sourceRoot?: SourceRoot
  editor?: CanopyEditorConfig
  authPlugin?: AuthPlugin
  /** Custom URL resolver for entry links. Overrides the default URL computation. */
  entryLinkUrl?: EntryLinkUrlResolver
  /** Save-time validation hook. 'error' issues reject the save; 'warning' issues are returned with it. */
  validateEntry?: ValidateEntryHook
  /** Dev-mode-only behavior (content-sync divergence detection). Ignored when mode !== 'dev'. */
  dev?: DevConfig
}

/**
 * Input type for config authoring (allows looser types before validation)
 */
export interface CanopyConfigInput {
  media?: MediaConfig
  defaultBranchAccess?: DefaultBranchAccess
  defaultPathAccess?: DefaultPathAccess
  defaultBaseBranch?: string
  /** Which workspace to serve content from by default. Auto-detected from git HEAD in dev mode. */
  defaultActiveBranch?: string
  defaultRemoteName?: string
  defaultRemoteUrl?: string
  gitBotAuthorName: string
  gitBotAuthorEmail: string
  githubTokenEnvVar?: string
  /**
   * Operating mode: 'prod' or 'dev'. Required — no default (SEC-C1). A prod deploy that
   * omits this would otherwise silently run header-trusting dev auth semantics; the Zod
   * schema fails validation loudly instead.
   */
  mode: OperatingMode
  /** How this build is deployed. 'static' = no request context, no auth. Default: 'server'. */
  deployedAs?: DeployedAs
  settingsBranch?: string
  autoCreateSettingsPR?: boolean
  deploymentName?: string
  contentRoot?: string
  sourceRoot?: string
  editor?: CanopyEditorConfig
  authPlugin?: AuthPlugin
  /** Custom URL resolver for entry links. Overrides the default URL computation. */
  entryLinkUrl?: EntryLinkUrlResolver
  /** Save-time validation hook. 'error' issues reject the save; 'warning' issues are returned with it. */
  validateEntry?: ValidateEntryHook
  /** Dev-mode-only behavior (content-sync divergence detection). Ignored when mode !== 'dev'. */
  dev?: DevConfig
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
      description?: string
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
      description?: string
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
  'defaultBaseBranch' | 'defaultActiveBranch' | 'contentRoot' | 'editor' | 'mode' | 'entryLinkUrl'
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
