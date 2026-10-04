/**
 * The entry-schema authoring API — the surface ADOPTERS write against.
 * `defineEntrySchema`, `defineInlineFieldGroup`, `defineNestedFieldGroup` and
 * `defineSeoFieldGroup` declare a host app's content model in TypeScript, with the
 * field list inferring the entry's data type, so changing a signature here is an
 * adopter-facing breaking change, not an internal one.
 *
 * Type-level half only: loading `.collection.json`, resolving it and validating
 * content against it live in `schema/` and `validation/`.
 * `RESOLVED_REFERENCE_KEYS`/`buildResolvedReference` define the shape a resolved
 * reference takes and must agree with `validation/entry-validator.ts`'s inverse
 * `normalizeReferenceValues`.
 *
 * Module map: ./AGENTS.md.
 */
import type { ComponentType } from 'react'
// The recommended SEO field names, shared with the read side (extractSeoFields) so the schema
// this module emits and the fields that module looks for cannot drift apart.
import { DEFAULT_SEO_FIELD_NAMES } from './static/seo'

/** Structural constraint for fields that can be inferred by TypeFromEntrySchema. */
type InferableField = {
  name: string
  type: string
  required?: boolean
  list?: boolean
  isTitle?: boolean
  isBody?: boolean
  fields?: readonly InferableField[]
  templates?: ReadonlyArray<{ name: string; fields: readonly InferableField[] }>
  /**
   * For select fields: the option list. Inferring the literal union of these values is
   * what makes a select field's type its own options rather than a bare `string`.
   *
   * MUST stay `readonly`, though `SelectFieldConfig.options` (config/types.ts) is a mutable
   * `SelectOption[]`: an adopter who declares the option list separately and shares it
   * across schemas writes `as const`, and a `readonly` array is not assignable to a mutable
   * one (TS4104), so every such schema would stop compiling at its definition site.
   * `readonly` accepts both the inline literal and the shared `as const` array. (A mutable
   * constraint would not by itself defeat `const` inference — that is not the reason.)
   */
  options?: readonly (string | { label: string; value: string })[]
  /** For reference fields: the target collection's schema (from defineEntrySchema) to infer resolved types. */
  resolvedSchema?: readonly InferableField[]
  /** For reference fields: filter by entry type name (e.g., ['partner']). */
  entryTypes?: readonly string[]
  /** For reference fields: collection paths to scope the search. */
  collections?: readonly string[]
  /** For reference fields: resolve the target's body too. See ReferenceFieldConfig.includeBody. */
  includeBody?: boolean
}

/**
 * The fields reference resolution adds to a target's own data, on top of whatever
 * `resolvedSchema` declares.
 *
 * `urlPath` is what makes a resolved reference linkable without a second lookup; it follows
 * the same collection+slug rule `listEntries` publishes as `item.urlPath`, so an index entry
 * collapses to its parent path.
 */
export const RESOLVED_REFERENCE_KEYS = ['id', 'slug', 'collection', 'urlPath'] as const

/**
 * Runtime counterpart of {@link ResolvedReferenceMeta}'s keys — the names reference resolution
 * reserves on a resolved value. Kept beside the type so the two cannot drift, and consumed by
 * both the resolver (which applies these last, so a target cannot shadow them) and the entry
 * schema registry (which rejects a body field named one of them, since the body is assigned by
 * key and would otherwise be the one way around that ordering).
 */
export interface ResolvedReferenceMeta {
  /** The referenced entry's 12-char content ID. */
  id: string
  /** The referenced entry's slug. */
  slug: string
  /** The referenced entry's collection logical path (e.g. `content/snippets`). */
  collection: string
  /** URL path for the referenced entry, e.g. `/guides/getting-started`. */
  urlPath: string
}

/**
 * Assemble a resolved reference: the target's own data, then its body if the field asked to
 * embed it, then the reserved metadata.
 *
 * Exists so the two places that construct one — the server resolver in content-store.ts and
 * the editor's live-preview endpoint in api/resolve-references.ts — cannot drift.
 *
 * The ordering is the contract, not a detail. Metadata LAST means a target that models `id` as
 * a content field cannot shadow the real content ID, which the write boundary recovers from
 * `value.id` (`referenceValueId`) — a shadowed id makes a re-save persist the wrong value and
 * silently repoint the reference. Body before metadata closes the same hole for a body field
 * named `id`; the entry schema registry also rejects that schema outright, so this ordering is
 * the guarantee and that check is the loud error rather than a silent drop.
 */
export function buildResolvedReference(
  data: Record<string, unknown>,
  meta: ResolvedReferenceMeta,
  body?: { fieldName: string; value: string | undefined },
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...data }
  // Truthiness, matching `readEntryData`'s own merge: a listed md entry with an empty body
  // carries no body key, so resolving one to `''` would reintroduce a listed-vs-resolved
  // shape mismatch.
  if (body && body.value) resolved[body.fieldName] = body.value
  resolved.id = meta.id
  resolved.slug = meta.slug
  resolved.collection = meta.collection
  resolved.urlPath = meta.urlPath
  return resolved
}

/**
 * Recursively flatten inline groups (type: 'group') out of a field tuple: they contribute
 * no key to the content shape, so their children merge into the parent level and
 * InferContentShape sees only data-carrying fields.
 */
type FlattenInlineGroups<Fields extends readonly InferableField[]> = Fields extends readonly [
  infer Head,
  ...infer Rest extends readonly InferableField[],
]
  ? Head extends { type: 'group'; fields: infer GFields extends readonly InferableField[] }
    ? [...FlattenInlineGroups<GFields>, ...FlattenInlineGroups<Rest>]
    : [Head, ...FlattenInlineGroups<Rest>]
  : []

/**
 * Collapse an intersection of mapped types into one object type, preserving the `?` modifier
 * (homomorphic over `keyof T`, so optionality survives). Without it InferContentShape surfaces
 * as `{ a: string } & { b?: string }` — structurally equivalent, but it reads badly in editor
 * tooltips and fails strict type-equality assertions.
 */
type Simplify<T> = { [K in keyof T]: T[K] }

/**
 * The value type of a field, WITHOUT any optionality. Optionality is carried solely by
 * the `?` modifier that InferContentShape applies, never duplicated as `| undefined`.
 */
type ScalarValue<F extends InferableField, V> = F['list'] extends true ? V[] : V

/**
 * The value one `select` option contributes to the field's value union: a bare string option
 * contributes itself, a `{ label, value }` option its `value`. Mixed arrays work because this
 * distributes. Falls back to `string` for an option whose literal type is gone — an array
 * annotated `SelectOption[]` rather than inferred by `defineEntrySchema` widens to
 * `string | { label: string; value: string }`, and both arms land on `string`.
 */
type SelectOptionValue<O> = O extends { value: infer V extends string }
  ? V
  : O extends string
    ? O
    : string

/**
 * The value type of a `select` field: the literal union of its OWN `options`. A select value is
 * always a string — `SelectOption` (config/types.ts) carries `value: string` in both arms,
 * `normalizeOptions` (editor/FormRenderer.tsx) emits strings, and `validateEntryData`
 * (validation/entry-validator.ts) rejects anything else — so this says WHICH strings.
 *
 * Like the rest of InferContentShape, it models the SCHEMA'S declared shape, not every byte the
 * validator tolerates on disk: the validator also accepts `''` as "not filled in" for any field
 * that is not explicitly `required: true`, and `''` is deliberately NOT in this union.
 *
 * Degrades to `string` when there is nothing to infer (no `options` key, or an empty one). Both
 * are schema mistakes `ensureSelectFieldsHaveOptions` (config/validation.ts) rejects — but it
 * runs from `createEntrySchemaRegistry`, so a schema only ever fed to `TypeFromEntrySchema` and
 * never registered gets no runtime rejection. `never` here would type such a field as
 * unsatisfiable, a worse error than this bare `string`.
 */
type SelectValue<F extends InferableField> = F extends {
  options: infer O extends readonly unknown[]
}
  ? [O[number]] extends [never]
    ? string
    : SelectOptionValue<O[number]>
  : string

type ObjectValue<F extends InferableField & { fields: readonly InferableField[] }> =
  F['list'] extends true ? Array<InferContentShape<F['fields']>> : InferContentShape<F['fields']>

/**
 * Distributes over each member of a block-templates union to produce a discriminated union. The
 * bare type parameter `T` is what makes the conditional distribute: `{ name: 'hero'; ... } |
 * { name: 'cta'; ... }` yields two `{ template; value }` members rather than one merged object.
 */
type DistributeBlockTemplate<T> = T extends {
  name: infer N
  fields: infer Fields
}
  ? { template: N & string; value: InferContentShape<Extract<Fields, readonly InferableField[]>> }
  : never

type BlockValue<
  F extends InferableField & {
    templates: ReadonlyArray<{
      name: string
      fields: readonly InferableField[]
    }>
  },
> = Array<DistributeBlockTemplate<F['templates'][number]>>

/**
 * Structural mirror of `ImageFieldValue` (config/types.ts), inline rather than imported so this
 * module stays free of a FieldConfig import.
 */
type ImageValue = {
  src: string
  alt: string
  width?: number
  height?: number
  crop?: { x: number; y: number; w: number; h: number }
}

type FieldValue<F extends InferableField> = F extends {
  type: 'object'
  fields: infer Fields
}
  ? ObjectValue<F & { fields: Extract<Fields, readonly InferableField[]> }>
  : F extends { type: 'block'; templates: infer Templates }
    ? BlockValue<
        F & {
          templates: NonNullable<
            Extract<Templates, ReadonlyArray<{ name: string; fields: readonly InferableField[] }>>
          >
        }
      >
    : F extends { type: 'select' }
      ? ScalarValue<F, SelectValue<F>>
      : F extends { type: 'reference'; resolvedSchema: infer S }
        ? ScalarValue<
            F,
            | (InferContentShape<Extract<S, readonly InferableField[]>> & ResolvedReferenceMeta)
            | null
          >
        : F extends { type: 'reference' }
          ? ScalarValue<F, string | null>
          : F extends { type: 'image' }
            ? ScalarValue<F, ImageValue>
            : F extends { type: 'boolean' }
              ? ScalarValue<F, boolean>
              : F extends { type: 'number' }
                ? ScalarValue<F, number>
                : F extends { type: 'date' }
                  ? ScalarValue<F, string>
                  : ScalarValue<F, string>

/**
 * Infer a TypeScript data shape from a CanopyCMS FieldConfig-like array: objects nest, blocks
 * become arrays of tagged templates, lists become arrays of the scalar/object type, and inline
 * groups (type: 'group') flatten into the parent shape with no intermediate key.
 *
 * Optionality is three-way (`true` / `false` / absent), deliberate and pinned by tests: only an
 * explicit `required: false` opts a key into `?:` (`subheading?: string`, so a literal may omit
 * it rather than spell out `undefined`; reading it still yields `string | undefined`). A field
 * that OMITS `required` stays REQUIRED, because `F['required']` infers there as
 * `boolean | undefined`, which does not extend `false`.
 *
 * Works with any structurally compatible array; importing FieldConfig is not required.
 */
type InferContentShape<Fields extends readonly InferableField[]> = Simplify<
  {
    [F in FlattenInlineGroups<Fields>[number] as F['required'] extends false
      ? never
      : F['name']]: FieldValue<F>
  } & {
    [F in FlattenInlineGroups<Fields>[number] as F['required'] extends false
      ? F['name']
      : never]?: FieldValue<F>
  }
>

/** Define an entry schema's field array with literal inference, without sprinkling `as const`. */
export const defineEntrySchema = <const T extends readonly InferableField[]>(fields: T): T => fields

/** Content shape derived from a `defineEntrySchema` result. */
export type TypeFromEntrySchema<T extends readonly InferableField[]> = InferContentShape<T>

/**
 * Derive a map of entry-type-name → content-shape from an `entrySchemaRegistry`.
 *
 * Pass `typeof entrySchemaRegistry` as the type argument. The registry must be keyed
 * by entry-type name (the filename token, also the value of `meta.entryType` in
 * `buildContentTree` callbacks) for the derived map to plug straight into
 * `buildContentTree`'s `TEntryTypes` generic.
 *
 * @example
 * ```ts
 * export type EntryTypes = EntryTypesFromRegistry<typeof entrySchemaRegistry>
 * // Per-schema aliases stay one line each, anchored to the registry:
 * export type PartnerContent = EntryTypes['partner']
 *
 * // And the tree-builder narrows on entryType: inside this extract,
 * // meta.indexEntry.data is typed PartnerContent once meta.indexEntry?.entryType
 * // has been checked against 'partner'.
 * await canopy.buildContentTree<NavFields, EntryTypes>({ extract: (data, meta) => { … } })
 * ```
 */
export type EntryTypesFromRegistry<T extends Record<string, readonly InferableField[]>> = {
  [K in keyof T]: TypeFromEntrySchema<T[K]>
}

/**
 * Define a reusable inline field group — a visual container in the editor that groups related
 * fields without creating a nested data key, so they are stored FLAT alongside the other fields.
 * Use it for consistent visual organization across schemas without changing the content file
 * structure; for data-nested grouping, use defineNestedFieldGroup().
 *
 * @example
 * const seoGroup = defineInlineFieldGroup({
 *   name: 'seo',
 *   label: 'SEO',
 *   fields: [{ name: 'metaTitle', type: 'string', label: 'Meta Title' }],
 * })
 * // TypeFromEntrySchema: { ..., metaTitle: string }
 */
export const defineInlineFieldGroup = <
  const T extends {
    name: string
    label?: string
    description?: string
    fields: readonly InferableField[]
  },
>(
  group: T,
): T & { readonly type: 'group' } => ({ ...group, type: 'group' as const })

/**
 * The recommended SEO field group, ready to drop into any entry schema.
 *
 * Emits the seven fields `extractSeoFields()` reads by default (`metaTitle`, `metaDescription`,
 * `ogImage`, `ogType`, `canonical`, `noindex`, `twitterCard`), so schema and read side agree with
 * no configuration. Every field is `required: false`: SEO metadata is always optional, and an
 * unset field must fall back rather than fail validation.
 *
 * **Flat by default** — an inline group, stored at the top level of the content file with no data
 * key of its own. `group: 'seo'` nests them under that key instead, and the same
 * `{ group: 'seo' }` must then be passed to `extractSeoFields` / `entryToMetadata`.
 *
 * @example
 * // Flat (recommended): frontmatter carries `metaTitle:` at the top level.
 * defineEntrySchema([{ name: 'title', type: 'string' }, defineSeoFieldGroup()])
 * // TypeFromEntrySchema: { title: string; metaTitle?: string; ... }
 *
 * @example
 * // Nested: frontmatter carries `seo: { metaTitle: … }`, and the `seo` key is itself optional.
 * defineEntrySchema([defineSeoFieldGroup({ group: 'seo' })])
 * const metadata = entryToMetadata(data, { group: 'seo' })
 */
const SEO_GROUP_FIELDS = [
  {
    name: DEFAULT_SEO_FIELD_NAMES.title,
    type: 'string',
    label: 'Meta Title',
    description: 'Overrides the page title in search results and social cards.',
    required: false,
  },
  {
    name: DEFAULT_SEO_FIELD_NAMES.description,
    type: 'string',
    label: 'Meta Description',
    description: 'Summary shown under the title in search results.',
    required: false,
  },
  {
    name: DEFAULT_SEO_FIELD_NAMES.ogImage,
    type: 'string',
    label: 'Social Image URL',
    description: 'Image for social cards. Site-relative or absolute.',
    required: false,
  },
  {
    name: DEFAULT_SEO_FIELD_NAMES.ogType,
    type: 'select',
    label: 'OpenGraph Type',
    options: ['website', 'article', 'profile'],
    required: false,
  },
  {
    name: DEFAULT_SEO_FIELD_NAMES.canonical,
    type: 'string',
    label: 'Canonical URL',
    description: 'Set only to point at a different canonical copy of this page.',
    required: false,
  },
  {
    name: DEFAULT_SEO_FIELD_NAMES.noindex,
    type: 'boolean',
    label: 'Hide from search engines',
    description: 'Marks the page noindex AND drops it from the sitemap.',
    required: false,
  },
  {
    name: DEFAULT_SEO_FIELD_NAMES.twitterCard,
    type: 'select',
    label: 'Twitter Card',
    options: ['summary', 'summary_large_image'],
    required: false,
  },
] as const

/** The seven recommended SEO fields, as a literal-typed field tuple. */
export type SeoGroupFields = typeof SEO_GROUP_FIELDS

interface SeoFieldGroupOptions {
  /** Editor label for the group. Default 'SEO'. */
  label?: string
  /** Editor description for the group. */
  description?: string
}

/** Flat (inline) SEO group: fields are stored at the top level of the content file. */
export type InlineSeoFieldGroup = {
  name: 'seo'
  label: string
  description?: string
  fields: SeoGroupFields
  type: 'group'
}

/** Nested SEO group: fields are stored under the group's own key in the content file. */
export type NestedSeoFieldGroup<G extends string> = {
  name: G
  label: string
  description?: string
  fields: SeoGroupFields
  type: 'object'
  /**
   * The wrapper object itself is optional: an entry that sets no SEO fields omits the key
   * entirely, matching `entry-validator.ts`, which enforces only `required: true` fields.
   */
  required: false
}

export function defineSeoFieldGroup(
  opts?: SeoFieldGroupOptions & { group?: undefined },
): InlineSeoFieldGroup
export function defineSeoFieldGroup<const G extends string>(
  opts: SeoFieldGroupOptions & {
    /**
     * Nest the fields under this data key instead of storing them flat. Must match the `group`
     * option passed to `extractSeoFields` / `entryToMetadata`.
     */
    group: G
  },
): NestedSeoFieldGroup<G>
export function defineSeoFieldGroup(
  opts: SeoFieldGroupOptions & { group?: string } = {},
): InlineSeoFieldGroup | NestedSeoFieldGroup<string> {
  const base = {
    label: opts.label ?? 'SEO',
    ...(opts.description ? { description: opts.description } : {}),
    fields: SEO_GROUP_FIELDS,
  }
  // 'object' nests the fields under `name`; 'group' is the inline (flat) container, whose name
  // is an editor-only label anchor and contributes no key to the content file.
  return opts.group
    ? { ...base, name: opts.group, type: 'object' as const, required: false as const }
    : { ...base, name: 'seo', type: 'group' as const }
}

/**
 * Define a reusable nested field group — a visual container in the editor whose fields are
 * stored under a named key in the content file (e.g. seo.metaTitle). Use it when the fields
 * belong together as a sub-object and that structure should be reflected on disk; for
 * visual-only grouping without data nesting, use defineInlineFieldGroup().
 *
 * @example
 * const seoGroup = defineNestedFieldGroup({
 *   name: 'seo',
 *   label: 'SEO',
 *   fields: [{ name: 'metaTitle', type: 'string', label: 'Meta Title' }],
 * })
 * // TypeFromEntrySchema: { ..., seo: { metaTitle: string } }
 */
export const defineNestedFieldGroup = <
  const T extends Omit<InferableField, 'type'> & { fields: readonly InferableField[] },
>(
  group: T,
): T & { readonly type: 'object' } => ({ ...group, type: 'object' as const })

/**
 * Define a reusable block template once and embed it in multiple entry schemas' `block` fields.
 *
 * A `block` field holds an ordered, repeatable list of heterogeneous section blocks discriminated
 * by a `template` key (the "flexible content" / "page blocks" pattern). This const-inference
 * identity helper (like defineEntrySchema) keeps a template's field definitions in one place
 * across schemas while TypeFromEntrySchema still derives the discriminated union.
 *
 * @example
 * const heroBlock = defineBlockTemplate({
 *   name: 'hero',
 *   label: 'Hero',
 *   fields: [
 *     { name: 'heading', type: 'string' },
 *     { name: 'subheading', type: 'string', required: false },
 *   ],
 * })
 * const ctaBlock = defineBlockTemplate({
 *   name: 'cta',
 *   fields: [{ name: 'label', type: 'string' }, { name: 'href', type: 'string' }],
 * })
 * const pageSchema = defineEntrySchema([
 *   { name: 'sections', type: 'block', templates: [heroBlock, ctaBlock] },
 * ])
 * // TypeFromEntrySchema<typeof pageSchema>['sections'] narrows to:
 * //   Array<{ template: 'hero'; value: { heading: string; subheading?: string } }
 * //        | { template: 'cta';  value: { label: string; href: string } }>
 */
export const defineBlockTemplate = <
  const T extends {
    name: string
    label?: string
    description?: string
    fields: readonly InferableField[]
  },
>(
  template: T,
): T => template

/**
 * Extract one template's value shape out of a block field's discriminated union. `Blocks` is the
 * union itself — e.g. `Page['sections'][number]`, the element type of a `block` field as derived
 * by `TypeFromEntrySchema` — not the surrounding array; `N` is one of its `template` literals.
 *
 * @example
 * type Sections = TypeFromEntrySchema<typeof pageSchema>['sections'][number]
 * type HeroValue = BlockValueOf<Sections, 'hero'> // { headline: string }
 */
export type BlockValueOf<
  Blocks extends { template: string; value: unknown },
  N extends Blocks['template'],
> = Extract<Blocks, { template: N }>['value']

/**
 * A mapped type over a block field's template names requiring exactly one component per template
 * — no more, no fewer. That makes a block → component registry exhaustive *by construction*: a
 * template added to the schema without its component, or a stray/renamed registry key, is a
 * compile error rather than a silent gap at render time.
 *
 * Deliberately a type, not a `renderBlocks()` helper — it says nothing about key strategy,
 * unknown-template handling or how extra props reach each component, so it imposes no rendering
 * shape. Adopters write their own small loop (README, "Block Component Registries").
 *
 * @example
 * // Extra props are threaded to every block component through the second parameter:
 * const registry: BlockComponentRegistry<Sections, { index: number }> = {
 *   hero: ({ data, index }) => <HeroSection {...data} position={index} />,
 * }
 */
export type BlockComponentRegistry<
  Blocks extends { template: string; value: unknown },
  ExtraProps extends object = object,
> = {
  [N in Blocks['template']]: ComponentType<{ data: BlockValueOf<Blocks, N> } & ExtraProps>
}

/**
 * Const-inference identity helper for a reusable field fragment — a plain array of field configs
 * (not a group, not a template) spread into several schemas' `fields`. Purely for
 * discoverability: `defineEntrySchema` and `defineBlockTemplate` already infer literal types from
 * a `const fields = [...] as const` array, so spreading works without this helper; wrapping the
 * definition site just makes the pattern easy to find alongside `defineInlineFieldGroup` and
 * `defineNestedFieldGroup`.
 *
 * Use it over a field group when the fields should not be visually boxed together in the editor,
 * or when schemas need to override one field (a different `label` or `required`) — spread the
 * fragment, then follow it with an object overriding just the fields that differ.
 *
 * @example
 * const ctaFields = defineFieldFragment([
 *   { name: 'ctaLabel', type: 'string', label: 'Button Label' },
 *   { name: 'ctaHref', type: 'string', label: 'Button Link' },
 * ])
 * const heroSchema = defineEntrySchema([{ name: 'headline', type: 'string' }, ...ctaFields])
 */
export const defineFieldFragment = <const T extends readonly InferableField[]>(fields: T): T =>
  fields
