/**
 * Zod schemas for collection configuration validation.
 */

import { z } from 'zod'
import { isAbsolute } from 'pathe'

import { fieldSchema } from './field'

// Relative path schema - validates and normalizes paths
export const relativePathSchema = z
  .string()
  .min(1)
  .refine((val) => !isAbsolute(val), { message: 'Path must be relative' })
  .refine((val) => !val.split(/[\\/]+/).includes('..'), {
    message: 'Path must not contain ".."',
  })
  .transform((val) =>
    val
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/'),
  )

/**
 * Entry type schema: defines a type of content within a collection.
 * Each type has its own schema (fields) and can have cardinality constraints.
 *
 * Examples:
 * - { name: 'post', format: 'mdx', schema: postSchema } - unlimited posts
 * - { name: 'settings', format: 'json', schema: settingsSchema, maxItems: 1 } - restricted to one instance
 */
export const entryTypeSchema = z.object({
  name: z.string().min(1),
  format: z.enum(['md', 'mdx', 'json']),
  schema: z.array(z.lazy(() => fieldSchema)).min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

// Recursive collection schema
const collectionSchema: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      name: z.string().min(1),
      path: relativePathSchema,
      label: z.string().optional(),
      description: z.string().optional(),
      entries: z.array(entryTypeSchema).optional(),
      collections: z.array(collectionSchema).optional(),
      order: z.array(z.string()).optional(), // Embedded IDs for ordering items
    })
    .refine((data) => data.entries || data.collections, {
      message: 'Collection must have entries or collections',
    }),
)

// Root collection: no name/path required (top-level schema)
export const rootCollectionSchema = z.object({
  entries: z.array(entryTypeSchema).optional(),
  collections: z.array(collectionSchema).optional(),
  order: z.array(z.string()).optional(), // Embedded IDs for ordering items
})

export { collectionSchema }
