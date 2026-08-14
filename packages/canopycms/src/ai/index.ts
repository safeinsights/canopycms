/**
 * Public exports for canopycms/ai entrypoint.
 *
 * Provides AI-ready content generation: config helpers,
 * route handler for runtime serving, and content types.
 */

export { defineAIContentConfig } from './types'
export { createAIContentHandler } from './handler'
export { generateAIContent } from './generate'
/**
 * Convert MDX/Markdown body content to plain prose text (for a search index
 * or any other "just the words" consumer). Distinct from the AI-content
 * pipeline above: this strips markup down to human-readable text rather
 * than preparing MDX for model consumption. See the source JSDoc for the
 * full pipeline and why paired custom components keep their inner text
 * while losing their tags.
 */
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
