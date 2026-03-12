type InferableField = {
  name: string
  type: string
  required?: boolean
  list?: boolean
  fields?: readonly InferableField[]
  templates?: ReadonlyArray<{ name: string; fields: readonly InferableField[] }>
}

type RequiredValue<F extends InferableField, V> = F['required'] extends false ? V | undefined : V

type ScalarValue<F extends InferableField, V> = RequiredValue<F, F['list'] extends true ? V[] : V>

type ObjectValue<F extends InferableField & { fields: readonly InferableField[] }> = RequiredValue<
  F,
  F['list'] extends true ? Array<InferContentShape<F['fields']>> : InferContentShape<F['fields']>
>

type BlockValue<
  F extends InferableField & { templates: ReadonlyArray<{ name: string; fields: readonly InferableField[] }> }
> = RequiredValue<
  F,
  Array<
    F['templates'][number] extends { name: infer N; fields: infer Fields }
      ? { template: N & string; value: InferContentShape<Extract<Fields, readonly InferableField[]>> }
    : never
  >
>

type FieldValue<F extends InferableField> = F extends { type: 'object'; fields: infer Fields }
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
  : F extends { type: 'reference' }
  ? ScalarValue<F, Record<string, unknown> | null>
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
 *
 * Works with any structurally compatible array; importing FieldConfig is not required.
 */
export type InferContentShape<Fields extends readonly InferableField[]> = {
  [F in Fields[number] as F['name']]: FieldValue<F>
}

/**
 * Helper to define entry schema field arrays with literal inference without sprinkling `as const`.
 */
export const defineEntrySchema = <const T extends readonly InferableField[]>(fields: T): T => fields

/**
 * Convenience alias to derive the content shape from a `defineEntrySchema` result.
 */
export type TypeFromEntrySchema<T extends readonly InferableField[]> = InferContentShape<T>

/** @deprecated Use defineEntrySchema instead */
export const defineSchema = defineEntrySchema
/** @deprecated Use TypeFromEntrySchema instead */
export type TypeFromSchema<T extends readonly InferableField[]> = TypeFromEntrySchema<T>
