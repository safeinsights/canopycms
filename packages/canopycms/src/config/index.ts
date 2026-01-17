/**
 * CanopyCMS Configuration Module
 *
 * This module provides types, schemas, and utilities for configuring CanopyCMS.
 *
 * @example
 * ```ts
 * import { defineCanopyConfig, type FieldConfig } from 'canopycms/config'
 * ```
 */

// Re-export all types
export type {
  // Field types
  PrimitiveFieldType,
  FieldType,
  ContentFormat,
  MediaAdapterKind,
  // Permission types
  PermissionLevel,
  PermissionTarget,
  PathPermission,
  // Field configs
  SelectOption,
  ReferenceOption,
  FieldConfig,
  BlockConfig,
  BlockFieldConfig,
  SelectFieldConfig,
  ReferenceFieldConfig,
  ObjectFieldConfig,
  CustomFieldConfig,
  // Schema types
  SingletonConfig,
  CollectionEntriesConfig,
  CollectionConfig,
  RootCollectionConfig,
  // Media
  MediaConfig,
  // Editor
  CanopyEditorConfig,
  // Config types
  DefaultBranchAccess,
  DefaultPathAccess,
  DefaultBaseBranch,
  DefaultRemoteName,
  DefaultRemoteUrl,
  GitBotAuthorName,
  GitBotAuthorEmail,
  GithubTokenEnvVar,
  CanopyOperatingMode,
  ContentRoot,
  SourceRoot,
  CanopyConfig,
  CanopyConfigInput,
  CanopyConfigFragment,
  FlatSchemaItem,
  CanopyClientConfig,
  ClientOnlyFields,
} from './types'

// Re-export type constants
export { primitiveFieldTypes, fieldTypes } from './types'

// Re-export schemas (for advanced use cases)
export { CanopyConfigSchema } from './schemas/config'
export {
  fieldSchema,
  blockSchema,
  selectOptionSchema,
  referenceOptionSchema,
} from './schemas/field'
export {
  collectionSchema,
  rootCollectionSchema,
  singletonSchema,
  collectionEntriesSchema,
  relativePathSchema,
} from './schemas/collection'
export { permissionTargetSchema, pathPermissionSchema } from './schemas/permissions'
export { mediaSchema } from './schemas/media'

// Re-export utilities
export { flattenSchema, normalizePathValue, normalizeSchemaPathsRoot } from './flatten'
export { validateCanopyConfig, ensureSelectFieldsHaveOptions } from './validation'
export { defineCanopyConfig, composeCanopyConfig, type CanopyConfigAuthoring } from './helpers'
