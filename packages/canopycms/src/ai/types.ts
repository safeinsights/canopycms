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
 * Context passed to an entry transform. Lets an adopter fold a colocated machine-generated
 * sibling artifact (e.g. `<contentId>.profile.json`) into the generated markdown — the AI-export
 * counterpart of reading a sibling from `meta.physicalPath` in a page render.
 *
 * The transform sees a single entry plus its colocated sibling *files*; it cannot see other
 * entries. Cross-entry context (e.g. an index of all entries) must be built adopter-side.
 */
export interface EntryTransformContext {
  /**
   * Stable content ID (Base58) of this entry — matches the id embedded in the entry's filename
   * and is invariant under slug edits. Use it to name sibling artifacts.
   */
  contentId: string
  /**
   * Read a sibling file colocated in this entry's directory. `name` must be a bare filename —
   * no slashes, no `..`, not absolute. Resolves to the file's UTF-8 contents, or `null` if the
   * file is missing or is not a regular file. Path-safety and IO are performed inside Canopy;
   * the entry's absolute filesystem path is never exposed (it must not leak into published output).
   */
  readSibling: (name: string) => Promise<string | null>
}

/**
 * Per-entry-type transform. Runs once per entry at generation time (may be async). Return a
 * markdown string to APPEND after the entry's body/fields, or `undefined` to append nothing.
 * Append-only by design — `entryToMarkdown` remains the sole owner of base serialization.
 *
 * Unlike `bodyTransforms` (which fire only for MD/MDX bodies), entry transforms fire for every
 * format, including data-only JSON/YAML entries.
 *
 * @example
 * ```ts
 * {
 *   dataset: async (entry, { contentId, readSibling }) => {
 *     const raw = await readSibling(`${contentId}.profile.json`)
 *     if (!raw) return
 *     return renderProfileSchema(entry.data, JSON.parse(raw))
 *   },
 * }
 * ```
 */
export type EntryTransformFn = (
  entry: AIEntry,
  ctx: EntryTransformContext,
) => Promise<string | undefined> | string | undefined

/**
 * Entry transform overrides, keyed by entry type name.
 */
export type EntryTransforms = Record<string, EntryTransformFn>

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
  /** Per-entry-type transforms that append markdown (e.g. folding in a colocated sibling artifact) */
  entryTransforms?: EntryTransforms
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
  /**
   * When this content was generated, ISO-8601.
   *
   * OPTIONAL, and absent when the manifest carries a `buildId` and `SOURCE_DATE_EPOCH` is unset:
   * under build-once-promote one artifact is built once and may be served months later, so a
   * build clock describes the runner that produced it rather than the content, and anything
   * reading it as "how fresh is this?" is misled by design. An adopter who has declared a build
   * id has told us the date is not the identifying fact, so it is omitted rather than filled in
   * with something arbitrary. Present unconditionally when neither env var is set.
   */
  generated?: string
  /**
   * Identifies the artifact this content was built into (`CANOPY_BUILD_ID`). Absent unless that
   * variable is set. This — not `generated` — is what a content-addressed deployment keys on.
   */
  buildId?: string
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
  /**
   * Markdown produced by an entry transform, appended after the entry's body/fields.
   * Computed once at generation time and reused across the per-entry file, the collection
   * `all.md`, and any bundle that includes this entry. Internal — not part of `AIEntryMeta`.
   */
  appendedSections?: string
}
