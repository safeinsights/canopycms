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
   * MUST stay `readonly` even though `SelectFieldConfig.options` (config/types.ts) is a
   * mutable `SelectOption[]` — but NOT for the reason you might assume. A mutable
   * constraint does not defeat `const` inference here: verified against this repo's tsc,
   * `<const T>` still infers `['a', 'b']` with the literals intact under a mutable
   * constraint, so the union would survive. The real failure is louder. An adopter who
   * declares the option list separately and shares it across schemas writes
   * `as const`, producing a `readonly` tuple — and a `readonly` array is not assignable
   * to a mutable one (TS4104), so every such schema would stop compiling at the
   * definition site. `readonly` here accepts both the inline literal and the shared
   * `as const` array.
   */
  options?: readonly (string | { label: string; value: string })[]
  /** For reference fields: the target collection's schema (from defineEntrySchema) to infer resolved types. */
  resolvedSchema?: readonly InferableField[]
  /** For reference fields: filter by entry type name (e.g., ['partner']). */
  entryTypes?: readonly string[]
  /** For reference fields: collection paths to scope the search. */
  collections?: readonly string[]
}

/**
 * Recursively flatten inline groups (type: 'group') out of a field tuple so that
 * InferContentShape sees only data-carrying fields. Inline groups contribute no
 * key to the content shape — their children are merged into the parent level.
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
 * Collapse an intersection of mapped types into one object type, preserving the `?`
 * modifier (the mapped type is homomorphic over `keyof T`, so optionality survives).
 * Without it, InferContentShape would surface as `{ a: string } & { b?: string }` —
 * structurally equivalent, but it reads badly in editor tooltips and is not accepted
 * by strict type-equality assertions.
 */
type Simplify<T> = { [K in keyof T]: T[K] }

/**
 * The value type of a field, WITHOUT any optionality. Optionality is carried solely by
 * the `?` modifier that InferContentShape applies, never duplicated as `| undefined`.
 */
type ScalarValue<F extends InferableField, V> = F['list'] extends true ? V[] : V

/**
 * The value one `select` option contributes to the field's value union. A bare string
 * option contributes itself; a `{ label, value }` option contributes its `value`, not
 * the whole object. Mixed arrays of both forms work because this distributes.
 *
 * Falls back to `string` for an option whose literal type is gone — an options array
 * annotated as `SelectOption[]` rather than inferred by `defineEntrySchema` widens to
 * `string | { label: string; value: string }`, and both arms then land on `string`.
 */
type SelectOptionValue<O> = O extends { value: infer V extends string }
  ? V
  : O extends string
    ? O
    : string

/**
 * The value type of a `select` field: the literal union of its OWN `options`.
 *
 * A select value is always a string — `SelectOption` (config/types.ts) carries
 * `value: string` in both arms, `normalizeOptions` (editor/FormRenderer.tsx) emits
 * strings, and `validateEntryData` (validation/entry-validator.ts) rejects anything
 * that is not one. This type says WHICH strings.
 *
 * Like the rest of InferContentShape, this models the SCHEMA'S declared shape, not
 * every byte the validator will tolerate on disk — the same stance that types a field
 * omitting `required` as a required property. Notably the validator also accepts `''`
 * as "not filled in" for any field that is not explicitly `required: true`, and `''` is
 * deliberately NOT in this union.
 *
 * Degrades to `string` when there is nothing to infer: no `options` key at all, or an
 * empty one. Both are schema mistakes that `ensureSelectFieldsHaveOptions`
 * (config/validation.ts) rejects — but note it runs from `createEntrySchemaRegistry`,
 * NOT from `validateCanopyConfig`, so a schema that is only ever fed to
 * `TypeFromEntrySchema` and never registered gets no runtime rejection at all.
 * Returning `never` here would type such a field as unsatisfiable, which is a worse
 * error than the bare `string` this falls back to.
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
 * Distributes over each member of a block templates union to produce a discriminated union.
 *
 * Uses a bare type parameter `T` so that the conditional type distributes:
 * given `T = { name: 'hero'; fields: [...] } | { name: 'cta'; fields: [...] }`,
 * produces `{ template: 'hero'; value: { ... } } | { template: 'cta'; value: { ... } }`
 * rather than collapsing into a single merged object.
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
 * Structural mirror of `ImageFieldValue` (config/types.ts). Kept inline
 * rather than imported so this module stays free of a FieldConfig import
 * (see the module doc comment: "importing FieldConfig is not required").
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
        ? ScalarValue<F, InferContentShape<Extract<S, readonly InferableField[]>> | null>
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
 * Infer a TypeScript data shape from a CanopyCMS FieldConfig-like array.
 * - Objects become nested objects
 * - Blocks become arrays of tagged templates with their value shapes
 * - Lists become arrays of the scalar/object type
 * - A field with an explicit `required: false` becomes an OPTIONAL property
 *   (`subheading?: string`), so a literal may omit it entirely rather than spelling it
 *   out as `undefined`. Reading it still yields `string | undefined`.
 * - A field that OMITS `required` stays a REQUIRED property. `F['required']` infers as
 *   `boolean | undefined` there, which does not extend `false`. This three-way
 *   distinction (`true` / `false` / absent) is deliberate and pinned by tests — only an
 *   explicit `required: false` opts a key into `?:`.
 * - Inline groups (type: 'group') are flattened — their fields contribute directly
 *   to the parent shape with no intermediate key.
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

/**
 * Helper to define entry schema field arrays with literal inference without sprinkling `as const`.
 */
export const defineEntrySchema = <const T extends readonly InferableField[]>(fields: T): T => fields

/**
 * Convenience alias to derive the content shape from a `defineEntrySchema` result.
 */
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
 * export const entrySchemaRegistry = createEntrySchemaRegistry({
 *   partner: partnerSchema,
 *   doc: docSchema,
 *   home: homeSchema,
 * })
 *
 * export type EntryTypes = EntryTypesFromRegistry<typeof entrySchemaRegistry>
 *
 * // Then per-schema aliases stay one line each, anchored to the registry:
 * export type PartnerContent = EntryTypes['partner']
 *
 * // And the tree-builder narrows on entryType:
 * await canopy.buildContentTree<NavFields, EntryTypes>({
 *   extract: (data, meta) => {
 *     if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
 *       // meta.indexEntry.data is typed PartnerContent
 *     }
 *   },
 * })
 * ```
 */
export type EntryTypesFromRegistry<T extends Record<string, readonly InferableField[]>> = {
  [K in keyof T]: TypeFromEntrySchema<T[K]>
}

/**
 * Define a reusable inline field group — a visual container in the editor that groups
 * related fields together without creating a nested data key. The group's fields are
 * stored flat alongside the other fields in the content file.
 *
 * Use this when you want consistent visual organization across schemas without
 * changing your content file structure.
 *
 * For data-nested grouping (fields stored under a named key), use defineNestedFieldGroup().
 *
 * @example
 * const seoGroup = defineInlineFieldGroup({
 *   name: 'seo',
 *   label: 'SEO',
 *   fields: [
 *     { name: 'metaTitle', type: 'string', label: 'Meta Title' },
 *     { name: 'metaDescription', type: 'string', label: 'Meta Description' },
 *   ],
 * })
 * // TypeFromEntrySchema: { ..., metaTitle: string, metaDescription: string }
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
 * Emits the seven fields `extractSeoFields()` reads by default (`metaTitle`,
 * `metaDescription`, `ogImage`, `ogType`, `canonical`, `noindex`, `twitterCard`), so schema and
 * read side agree with no configuration. Every field is `required: false` — SEO metadata is
 * always optional, and an unset field must fall back rather than fail validation.
 *
 * **Flat by default.** The fields are stored flat in the content file (an inline group: a
 * visual container in the editor that adds no data key). Pass `group: 'seo'` for the nested
 * convention, which stores them under that key — and then pass the same `{ group: 'seo' }` to
 * `extractSeoFields` / `entryToMetadata`.
 *
 * @example
 * // Flat (recommended): frontmatter carries `metaTitle:` at the top level.
 * const pageSchema = defineEntrySchema([
 *   { name: 'title', type: 'string' },
 *   defineSeoFieldGroup(),
 * ])
 * // TypeFromEntrySchema: { title: string; metaTitle?: string; metaDescription?: string; ... }
 *
 * @example
 * // Nested: frontmatter carries `seo: { metaTitle: … }`.
 * const pageSchema = defineEntrySchema([defineSeoFieldGroup({ group: 'seo' })])
 * const metadata = entryToMetadata(data, { group: 'seo' })
 * // TypeFromEntrySchema: { seo?: { metaTitle?: string; ... } } — the wrapper key itself is
 * // optional too, so an entry that sets no SEO fields at all can omit `seo` entirely.
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
   * The wrapper object itself is optional — an entry that sets no SEO fields at all omits the
   * `seo` key entirely, matching the runtime validator (`entry-validator.ts`), which only
   * enforces fields with `required: true`.
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
 * Define a reusable nested field group — a visual container in the editor that groups
 * related fields under a named key in the content file.
 *
 * Use this when the fields logically belong together as a sub-object (e.g., seo.metaTitle)
 * and you want that structure reflected in your content files.
 *
 * For visual-only grouping without data nesting, use defineInlineFieldGroup().
 *
 * @example
 * const seoGroup = defineNestedFieldGroup({
 *   name: 'seo',
 *   label: 'SEO',
 *   fields: [
 *     { name: 'metaTitle', type: 'string', label: 'Meta Title' },
 *     { name: 'metaDescription', type: 'string', label: 'Meta Description' },
 *   ],
 * })
 * // TypeFromEntrySchema: { ..., seo: { metaTitle: string, metaDescription: string } }
 */
export const defineNestedFieldGroup = <
  const T extends Omit<InferableField, 'type'> & { fields: readonly InferableField[] },
>(
  group: T,
): T & { readonly type: 'object' } => ({ ...group, type: 'object' as const })

/**
 * Define a reusable block template once and embed it in multiple entry schemas' `block` fields.
 *
 * A `block` field holds an ordered, repeatable list of heterogeneous section blocks discriminated by
 * a `template` key (the "flexible content" / "page blocks" pattern). Defining each template inline in
 * every schema's `templates` array duplicates the field definitions; this const-inference identity
 * helper (like defineEntrySchema) lets you define a template once and reuse it across schemas while
 * still deriving the correct discriminated-union type via TypeFromEntrySchema.
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
 *
 * // Reuse the same templates across multiple page schemas:
 * const pageSchema = defineEntrySchema([
 *   { name: 'title', type: 'string' },
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
 * Extract one template's value shape out of a block field's discriminated union.
 *
 * `Blocks` is the union itself — e.g. `Page['sections'][number]`, the element type of
 * a `block` field as derived by `TypeFromEntrySchema` — not the surrounding array.
 * `N` is one of that union's `template` literals.
 *
 * @example
 * const heroBlock = defineBlockTemplate({
 *   name: 'hero',
 *   fields: [{ name: 'headline', type: 'string' }],
 * })
 * const pageSchema = defineEntrySchema([
 *   { name: 'sections', type: 'block', templates: [heroBlock] },
 * ])
 * type Sections = TypeFromEntrySchema<typeof pageSchema>['sections'][number]
 * type HeroValue = BlockValueOf<Sections, 'hero'> // { headline: string }
 */
export type BlockValueOf<
  Blocks extends { template: string; value: unknown },
  N extends Blocks['template'],
> = Extract<Blocks, { template: N }>['value']

/**
 * A mapped type over a block field's template names, requiring exactly one component
 * per template — no more, no fewer. This makes a block → component registry exhaustive
 * *by construction*: adding a template to the schema without adding its component is a
 * compile error, and a stray/renamed key in the registry is a compile error too. That is
 * strictly stronger than a runtime "did I handle every template?" guard, since it fails
 * the build instead of failing silently at render time.
 *
 * Deliberately a type, not a `renderBlocks()` helper — the type says nothing about key
 * strategy, unknown-template handling, or how extra props reach each component, so it
 * imposes no rendering shape. Adopters write their own small loop (see the README's
 * "Block Component Registries" section for the recipe) and get exhaustiveness for free.
 *
 * @example
 * const registry: BlockComponentRegistry<Sections> = {
 *   hero: ({ data }) => <HeroSection {...data} />,
 *   // TS error here if 'hero' is missing, or if a key doesn't match a template name.
 * }
 *
 * // With extra props threaded to every block component:
 * type Props = { index: number }
 * const registryWithProps: BlockComponentRegistry<Sections, Props> = {
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
 * Const-inference identity helper for a reusable field fragment — a plain array of field
 * configs (not a group, not a template) that you spread into multiple schemas' `fields`.
 * Exists purely for discoverability: `defineEntrySchema` and `defineBlockTemplate` already
 * infer literal types from a `const fields = [...] as const` array, so spreading it works
 * without this helper too. Wrapping the definition site in `defineFieldFragment(...)` just
 * makes the pattern easy to find (and to grep for) alongside `defineInlineFieldGroup` and
 * `defineNestedFieldGroup`.
 *
 * Use this over a field group when you don't want the fields visually boxed together in
 * the editor, or when different schemas need to override one field (e.g. a different
 * `label` or `required`) — spread the fragment, then follow it with an object that
 * overrides just the field(s) that differ for that schema.
 *
 * @example
 * const ctaFields = defineFieldFragment([
 *   { name: 'ctaLabel', type: 'string', label: 'Button Label' },
 *   { name: 'ctaHref', type: 'string', label: 'Button Link' },
 * ])
 *
 * const heroSchema = defineEntrySchema([
 *   { name: 'headline', type: 'string' },
 *   ...ctaFields,
 * ])
 * const bannerSchema = defineEntrySchema([
 *   { name: 'message', type: 'string' },
 *   ...ctaFields,
 * ])
 */
export const defineFieldFragment = <const T extends readonly InferableField[]>(fields: T): T =>
  fields
