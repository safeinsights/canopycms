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
  ImageFieldConfig,
  ImageFieldValue,
  ObjectFieldConfig,
  InlineGroupFieldConfig,
  CustomFieldConfig,
  // Schema types
  EntrySchema,
  BranchSchema,
  EntryTypeConfig,
  CollectionConfig,
  RootCollectionConfig,
  // Media
  MediaConfig,
  // Editor
  CanopyEditorConfig,
  // Config types
  DefaultBranchAccess,
  DefaultPathAccess,
  DefaultPathAccessLevel,
  DefaultPathAccessLevels,
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
  // Save-time validation hook
  EntryValidationIssue,
  ValidateEntryInput,
  ValidateEntryHook,
} from './types'

// Re-export type constants
export { primitiveFieldTypes, fieldTypes } from './types'

// Re-export schemas (for advanced use cases)
export { CanopyConfigSchema, getConfigDefaults, DEFAULT_PROD_WORKSPACE } from './schemas/config'
export {
  fieldSchema,
  blockSchema,
  selectOptionSchema,
  referenceOptionSchema,
  imageFieldSchema,
} from './schemas/field'
export { collectionSchema, entryTypeSchema, relativePathSchema } from './schemas/collection'
export { permissionTargetSchema, pathPermissionSchema } from './schemas/permissions'
export { mediaSchema } from './schemas/media'

// Re-export utilities
export { flattenSchema, normalizePathValue } from './flatten'
export { validateCanopyConfig, ensureSelectFieldsHaveOptions } from './validation'
export { defineCanopyConfig, composeCanopyConfig, type CanopyConfigAuthoring } from './helpers'
