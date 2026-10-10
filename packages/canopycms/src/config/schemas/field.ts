/**
 * Zod schemas for field configuration validation.
 */

import { z } from 'zod'

import { fieldTypes, markdownFieldTypes, primitiveFieldTypes } from '../types'
import type { FieldType, MdxAllowlist } from '../types'
import {
  SAFE_HTML_TAGS,
  isComponentName,
  isRefusedComponentProp,
  markdownFieldOptionsError,
} from '../../validation/mdx-allowlist'

const fieldBaseSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  list: z.boolean().optional(),
  isTitle: z.boolean().optional(),
  isBody: z.boolean().optional(),
})

export const selectOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string().min(1),
    value: z.string().min(1),
  }),
])

export const referenceOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string().min(1),
    value: z.string().min(1),
  }),
])

const primitiveFieldSchema = fieldBaseSchema.extend({
  type: z.enum(primitiveFieldTypes).exclude([...markdownFieldTypes]),
})

const mdxPropAllowSchema = z.union([
  z.literal(true),
  z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
])

/** Strict, so a misspelt key is an error rather than a silently wider policy. */
export const mdxAllowlistSchema: z.ZodType<MdxAllowlist> = z
  .object({
    components: z
      .record(
        z.string().refine(isComponentName, {
          message:
            'must be a component name: capitalised, with no dot, and not MDXContent or MDXLayout',
        }),
        z
          .object({
            props: z
              .record(
                z
                  .string()
                  .min(1)
                  .refine((name) => !isRefusedComponentProp(name), {
                    message:
                      'event handlers, srcdoc and dangerouslySetInnerHTML are always refused',
                  }),
                mdxPropAllowSchema,
              )
              .optional(),
          })
          .strict(),
      )
      .optional(),
    htmlTags: z
      .array(
        z.string().refine((tag) => SAFE_HTML_TAGS.has(tag), {
          message: 'must be one of the HTML tags the base MDX policy accepts',
        }),
      )
      .optional(),
    expressions: z.boolean().optional(),
    fragments: z.boolean().optional(),
  })
  .strict()

const markdownFieldSchema = fieldBaseSchema.extend({
  type: z.enum(markdownFieldTypes),
  executable: z.boolean().optional(),
  renderAs: z.literal('mdx').optional(),
  mdxAllow: mdxAllowlistSchema.optional(),
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

const selectFieldSchema = fieldBaseSchema.extend({
  type: z.literal('select'),
  options: z.array(selectOptionSchema).min(1),
})

// At least one of `collections` or `entryTypes` must be specified (enforced by config validation).
/** @internal Exported for tests. */
export const referenceFieldSchema = fieldBaseSchema.extend({
  type: z.literal('reference'),
  collections: z.array(z.string().min(1)).min(1).optional(),
  entryTypes: z.array(z.string().min(1)).min(1).optional(),
  displayField: z.string().min(1).optional(),
  options: z.array(referenceOptionSchema).optional(),
  // Must be listed here, not just on ReferenceFieldConfig: zod strips unknown keys by
  // default, so a consumer that adopts this schema's parse output would silently delete a
  // runtime-consumed flag and the feature would no-op with no error. (`resolvedSchema` is
  // absent on purpose — it is type-inference-only and stripping it changes no behavior.)
  includeBody: z.boolean().optional(),
})

// Use a mutable holder to enable forward references in recursive z.lazy() closures.
// blockSchema/objectFieldSchema reference fieldHolder[0] via z.lazy, which is resolved
// after the full fieldSchema is constructed below.
const fieldHolder: [z.ZodTypeAny] = [z.never()]

export const blockSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(z.lazy(() => fieldHolder[0])).min(1),
})

const blockFieldSchema = fieldBaseSchema.extend({
  type: z.literal('block'),
  templates: z.array(blockSchema).min(1),
})

const objectFieldSchema = fieldBaseSchema.extend({
  type: z.literal('object'),
  fields: z.array(z.lazy(() => fieldHolder[0])).min(1),
  itemTitleField: z.string().min(1).optional(),
})

// Inline group field: visual grouping only, no data nesting
const inlineGroupFieldSchema = z.object({
  type: z.literal('group'),
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(z.lazy(() => fieldHolder[0])).min(1),
})

const customFieldSchema = z.lazy(() =>
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

const knownFieldSchema: z.ZodTypeAny = z
  .discriminatedUnion('type', [
    primitiveFieldSchema,
    markdownFieldSchema,
    selectFieldSchema,
    referenceFieldSchema,
    imageFieldSchema,
    objectFieldSchema,
    blockFieldSchema,
    inlineGroupFieldSchema,
  ])
  .superRefine((field, ctx) => {
    if (field.type !== 'markdown' && field.type !== 'mdx') return
    const message = markdownFieldOptionsError(field)
    if (message !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  })

const fieldSchema: z.ZodTypeAny = z.lazy(() => z.union([knownFieldSchema, customFieldSchema]))
fieldHolder[0] = fieldSchema

export { fieldSchema }
