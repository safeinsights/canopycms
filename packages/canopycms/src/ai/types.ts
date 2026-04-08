/**
 * Type definitions for AI-ready content generation.
 *
 * These types define the configuration for generating AI-consumable markdown
 * from CanopyCMS content, and the output manifest/metadata structures.
 */

import type { FieldConfig } from '../config'

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Metadata about an entry, provided to filter/predicate functions.
 * Does not include the full data payload — use `where` predicates for
 * data-level filtering.
 */
export interface AIEntryMeta {
  slug: string
  /** Clean collection path without content root (e.g., 'posts', 'datasets/openstax') */
  collection: string
  collectionName: string
  entryType: string
  format: string
  /** The entry's parsed data (frontmatter for MD/MDX, full data for JSON) */
  data: Record<string, unknown>
}

/**
 * Exclusion config — opt-out model. Everything is included unless excluded.
 */
export interface ExcludeConfig {
  /** Collection paths to skip (e.g., 'content/drafts'). Matches with or without content root prefix. */
  collections?: string[]
  /** Entry type names to skip everywhere (e.g., 'internal-note') */
  entryTypes?: string[]
  /** Custom predicate — return true to exclude the entry */
  where?: (entry: AIEntryMeta) => boolean
}

/**
 * Filter criteria for bundles. Filters are AND'd when combined.
 */
export interface BundleFilter {
  /** Include entries under these collection paths */
  collections?: string[]
  /** Include entries of these type names */
  entryTypes?: string[]
  /** Include entries matching glob patterns on clean path */
  paths?: string[]
  /** Custom predicate — return true to include the entry */
  where?: (entry: AIEntryMeta) => boolean
}

/**
 * A named bundle — an additive filtered view producing a concatenated markdown file.
 */
export interface BundleConfig {
  /** Unique name, used in URLs/filenames (e.g., 'openstax-researcher') */
  name: string
  /** Human description, included in the bundle header and manifest */
  description?: string
  /** Filter criteria (AND'd when multiple are specified) */
  filter: BundleFilter
}

/**
 * Per-field markdown override function.
 * Return a markdown string to replace the default conversion for this field.
 */
export type FieldTransformFn = (value: unknown, fieldConfig: FieldConfig) => string

/**
 * Field transform overrides, keyed by entry type name, then field name.
 *
 * @example
 * ```ts
 * {
 *   dataset: {
 *     dataFields: (value, fieldConfig) =>
 *       `## Data Fields\n| Name | Type |\n|---|---|\n${value.map(f => `| ${f.name} | ${f.type} |`).join('\n')}`,
 *   },
 * }
 * ```
 */
export type FieldTransforms = Record<string, Record<string, FieldTransformFn>>

/**
 * Parsed props from a JSX component tag.
 * Values are always strings (parsed from attribute syntax).
 * Boolean attributes (no value) are represented as `"true"`.
 */
export type ComponentProps = Record<string, string>

/**
 * Transform function for a specific MDX component.
 * Return `undefined` to keep the original JSX unchanged.
 *
 * @param props - Parsed props from the JSX tag
 * @param children - Inner content between open/close tags (empty string for self-closing)
 * @returns Markdown string to replace the component, or `undefined` to keep original
 */
export type ComponentTransformFn = (props: ComponentProps, children: string) => string | undefined

/**
 * Component transform overrides, keyed by PascalCase component name.
 * Applied to all MD/MDX entry types — component names are global to a project.
 *
 * @example
 * ```ts
 * {
 *   Callout: (props, children) => `> **${props.type ?? 'Note'}:** ${children}`,
 *   Spacer: () => '',
 *   ChecklistItem: (props, children) =>
 *     `- [ ] ${props.label ? `**${props.label}:** ` : ''}${children}`,
 * }
 * ```
 */
export type ComponentTransforms = Record<string, ComponentTransformFn>

/**
 * Body transform function for MD/MDX entry bodies.
 * Receives the body after stripMdxImports and componentTransforms have been applied.
 */
export type BodyTransformFn = (body: string, entry: AIEntryMeta) => string

/**
 * Body transform overrides, keyed by entry type name.
 *
 * @example
 * ```ts
 * {
 *   guideline: (body) => body.replace(/\s*\|\|[^\n]+/g, ''),
 * }
 * ```
 */
export type BodyTransforms = Record<string, BodyTransformFn>

/**
 * Main AI content configuration. Shared by route handler and build utility.
 */
export interface AIContentConfig {
  /** Opt-out exclusions — content to skip */
  exclude?: ExcludeConfig
  /** Custom bundles — filtered content subsets */
  bundles?: BundleConfig[]
  /** Per-entry-type, per-field markdown overrides */
  fieldTransforms?: FieldTransforms
  /** Per-component MDX transforms (applied before bodyTransforms) */
  componentTransforms?: ComponentTransforms
  /** Per-entry-type body transforms (applied after componentTransforms) */
  bodyTransforms?: BodyTransforms
}

/**
 * Identity function for type-checking AI content config.
 * Similar to `defineCanopyConfig` — validates the shape at the type level.
 */
export function defineAIContentConfig(config: AIContentConfig): AIContentConfig {
  return config
}

// ---------------------------------------------------------------------------
// Output / manifest types
// ---------------------------------------------------------------------------

/** Manifest entry metadata */
export interface AIManifestEntry {
  slug: string
  title?: string
  file: string
}

/** Manifest collection metadata (recursive for subcollections) */
export interface AIManifestCollection {
  name: string
  label?: string
  description?: string
  path: string
  /** Path to the concatenated all.md file. Absent when the collection has no entries. */
  allFile?: string
  entryCount: number
  entries: AIManifestEntry[]
  subcollections?: AIManifestCollection[]
}

/** Manifest bundle metadata */
export interface AIManifestBundle {
  name: string
  description?: string
  file: string
  entryCount: number
}

/** Top-level manifest for AI content */
export interface AIManifest {
  generated: string
  /** Root-level entries (outside any collection) */
  entries: AIManifestEntry[]
  collections: AIManifestCollection[]
  bundles: AIManifestBundle[]
}

// ---------------------------------------------------------------------------
// Internal generation types
// ---------------------------------------------------------------------------

/** A fully-loaded entry ready for markdown conversion */
export interface AIEntry extends AIEntryMeta {
  /** Markdown body for MD/MDX entries */
  body?: string
  /** Schema fields for this entry type */
  fields: readonly FieldConfig[]
}
