/**
 * Zod schemas for field configuration validation.
 */

import { z } from 'zod'

import { primitiveFieldTypes, fieldTypes } from '../types'
import type { FieldType } from '../types'

// Base field schema - shared properties
export const fieldBaseSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  list: z.boolean().optional(),
  isTitle: z.boolean().optional(),
  isBody: z.boolean().optional(),
})

// Select option schema
export const selectOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string().min(1),
    value: z.string().min(1),
  }),
])

// Reference option schema
export const referenceOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string().min(1),
    value: z.string().min(1),
  }),
])

// Primitive field (string, number, boolean, etc.)
export const primitiveFieldSchema = fieldBaseSchema.extend({
  type: z.enum(primitiveFieldTypes),
})

// "W:H" aspect ratio, e.g. "16:9" or "1:1" — positive integers on both sides,
// no leading zeros (leading zero would parse as `0` via Number(), which the
// field's own regex already rejects as the first character class excludes it).
const ASPECT_RATIO_RE = /^[1-9][0-9]*:[1-9][0-9]*$/

// Image field: aspect and altOptional configure the editor's crop step and alt
// text requirement (see ImageFieldConfig in ../types). The field VALUE itself
// ({ src, alt, width?, height?, crop? }) is validated at the write boundary by
// validation/entry-validator.ts, not here — this schema only covers the field
// definition's own config.
export const imageFieldSchema = fieldBaseSchema.extend({
  type: z.literal('image'),
  aspect: z
    .string()
    .regex(ASPECT_RATIO_RE, 'aspect must be "W:H" with positive integers (e.g. "16:9")')
    .optional(),
  altOptional: z.boolean().optional(),
})

// Select field with options
export const selectFieldSchema = fieldBaseSchema.extend({
  type: z.literal('select'),
  options: z.array(selectOptionSchema).min(1),
})

// Reference field pointing to other collections and/or entry types.
// At least one of `collections` or `entryTypes` must be specified (enforced by config validation).
export const referenceFieldSchema = fieldBaseSchema.extend({
  type: z.literal('reference'),
  collections: z.array(z.string().min(1)).min(1).optional(),
  entryTypes: z.array(z.string().min(1)).min(1).optional(),
  displayField: z.string().min(1).optional(),
  options: z.array(referenceOptionSchema).optional(),
})

// Use a mutable holder to enable forward references in recursive z.lazy() closures.
// blockSchema/objectFieldSchema reference fieldHolder[0] via z.lazy, which is resolved
// after the full fieldSchema is constructed below.
const fieldHolder: [z.ZodTypeAny] = [z.never()]

// Block template schema
export const blockSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(z.lazy(() => fieldHolder[0])).min(1),
})

// Block field with templates
export const blockFieldSchema = fieldBaseSchema.extend({
  type: z.literal('block'),
  templates: z.array(blockSchema).min(1),
})

// Object field with nested fields
export const objectFieldSchema = fieldBaseSchema.extend({
  type: z.literal('object'),
  fields: z.array(z.lazy(() => fieldHolder[0])).min(1),
})

// Inline group field: visual grouping only, no data nesting
export const inlineGroupFieldSchema = z.object({
  type: z.literal('group'),
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(z.lazy(() => fieldHolder[0])).min(1),
})

// Custom field (user-defined type)
export const customFieldSchema = z.lazy(() =>
  fieldBaseSchema
    .extend({
      type: z
        .string()
        .min(1)
        .refine((val) => !fieldTypes.includes(val as FieldType), {
          message: 'Custom field types must not conflict with built-in types',
        }),
    })
    .passthrough(),
)

// Known built-in field types (discriminated union)
const knownFieldSchema: z.ZodTypeAny = z.discriminatedUnion('type', [
  primitiveFieldSchema,
  selectFieldSchema,
  referenceFieldSchema,
  imageFieldSchema,
  objectFieldSchema,
  blockFieldSchema,
  inlineGroupFieldSchema,
])

// Complete field schema (built-in or custom)
const fieldSchema: z.ZodTypeAny = z.lazy(() => z.union([knownFieldSchema, customFieldSchema]))
fieldHolder[0] = fieldSchema

export { fieldSchema, knownFieldSchema }
