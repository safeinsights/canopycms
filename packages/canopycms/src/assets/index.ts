/**
 * Internal module barrel for the assets/ store implementation. NOT a package
 * entrypoint — server code within canopycms imports from here or from the
 * individual files; client-side code (the editor) must `import type` from
 * ./types directly instead, so node:fs/S3-SDK imports never reach a browser
 * bundle.
 */

export type {
  AssetMeta,
  AssetStore,
  BeginUploadInput,
  PublicObject,
  StagedUploadTarget,
} from './types'

export {
  ASSET_PREFIXES,
  createKeyBuilders,
  hashBytes,
  metaKey,
  metaPrefix,
  originalKey,
  originalPrefix,
  publicKey,
  slugifyFilename,
  stagingKey,
  type AssetPrefixes,
} from './keys'

export { LocalAssetStore, type LocalAssetStoreOptions } from './store-local'
export { S3AssetStore, type S3AssetStoreOptions } from './store-s3'
export { createAssetStore } from './factory'

export {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  runFinalizePipeline,
  type FinalizeInput,
  type FinalizePublicObject,
  type FinalizeResult,
  type FinalizeRejection,
  type FinalizeSuccess,
} from './pipeline'

export { finalizeAsset, finalizeStagedUpload, type FinalizeAssetResult } from './finalize'

export { sanitizeSvg } from './svg-sanitizer'

export { assetSrc, IDENTITY_TRANSFORM_DIRECTIVE } from './asset-src'

export {
  formatDirectives,
  isAllowedTransformWidth,
  isValidCropRect,
  parseTransformPath,
  type CropRect,
  type IdentityDirectives,
  type OutputFormat,
  type ParsedTransformPath,
  type ParseTransformPathResult,
  type ResizeDirectives,
  type TransformDirectives,
} from './transform-directives'

export { applyTransform, type ApplyTransformInput, type TransformResult } from './transform'

export { assetUrl, assetSrcSet, type AssetRef, type AssetUrlOptions } from './asset-url'
