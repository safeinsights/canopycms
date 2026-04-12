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

type RequiredValue<F extends InferableField, V> = F['required'] extends false ? V | undefined : V

type ScalarValue<F extends InferableField, V> = RequiredValue<F, F['list'] extends true ? V[] : V>

type ObjectValue<F extends InferableField & { fields: readonly InferableField[] }> = RequiredValue<
  F,
  F['list'] extends true ? Array<InferContentShape<F['fields']>> : InferContentShape<F['fields']>
>

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
> = RequiredValue<F, Array<DistributeBlockTemplate<F['templates'][number]>>>

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
      ? ScalarValue<F, string | number>
      : F extends { type: 'reference'; resolvedSchema: infer S }
        ? ScalarValue<F, InferContentShape<Extract<S, readonly InferableField[]>> | null>
        : F extends { type: 'reference' }
          ? ScalarValue<F, string | null>
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
 * - Non-required fields include `undefined`
 * - Inline groups (type: 'group') are flattened — their fields contribute directly
 *   to the parent shape with no intermediate key.
 *
 * Works with any structurally compatible array; importing FieldConfig is not required.
 */
type InferContentShape<Fields extends readonly InferableField[]> = {
  [F in FlattenInlineGroups<Fields>[number] as F['name']]: FieldValue<F>
}

/**
 * Helper to define entry schema field arrays with literal inference without sprinkling `as const`.
 */
export const defineEntrySchema = <const T extends readonly InferableField[]>(fields: T): T => fields

/**
 * Convenience alias to derive the content shape from a `defineEntrySchema` result.
 */
export type TypeFromEntrySchema<T extends readonly InferableField[]> = InferContentShape<T>

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
  const T extends Omit<InferableField, 'type'> & {
    name: string
    fields: readonly InferableField[]
  },
>(
  group: T,
): T & { readonly type: 'group' } => ({ ...group, type: 'group' as const })

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
