/**
 * Public exports for canopycms/ai entrypoint.
 *
 * Provides AI-ready content generation: config helpers,
 * route handler for runtime serving, and content types.
 */

export { defineAIContentConfig } from './types'
export { createAIContentHandler } from './handler'
export { generateAIContent } from './generate'
/** See `to-plain-text.ts`'s module doc for the pipeline and why it differs from the AI-content path above. */
export { toPlainText } from './to-plain-text'
export type {
  AIContentConfig,
  ExcludeConfig,
  BundleConfig,
  BundleFilter,
  FieldTransformFn,
  FieldTransforms,
  ComponentProps,
  ComponentTransformFn,
  ComponentTransforms,
  BodyTransformFn,
  BodyTransforms,
  EntryTransformFn,
  EntryTransforms,
  EntryTransformContext,
  AIManifest,
  AIManifestCollection,
  AIManifestEntry,
  AIManifestBundle,
  AIEntry,
  AIEntryMeta,
} from './types'
export type { AIContentHandlerOptions } from './handler'
export type { GenerateOptions, GenerateResult } from './generate'
