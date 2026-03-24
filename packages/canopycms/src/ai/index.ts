/**
 * Public exports for canopycms/ai entrypoint.
 *
 * Provides AI-ready content generation: config helpers,
 * route handler for runtime serving, and content types.
 */

export { defineAIContentConfig } from './types'
export { createAIContentHandler } from './handler'
export { generateAIContent } from './generate'
export type {
  AIContentConfig,
  ExcludeConfig,
  BundleConfig,
  BundleFilter,
  FieldTransformFn,
  FieldTransforms,
  AIManifest,
  AIManifestCollection,
  AIManifestEntry,
  AIManifestBundle,
  AIEntry,
  AIEntryMeta,
} from './types'
export type { AIContentHandlerOptions } from './handler'
export type { GenerateOptions, GenerateResult } from './generate'
