/**
 * Zod schemas for collection and singleton configuration validation.
 */

import { z } from 'zod'
import { isAbsolute } from 'pathe'

import { fieldSchema } from './field'

// Relative path schema - validates and normalizes paths
export const relativePathSchema = z
  .string()
  .min(1)
  .refine((val) => !isAbsolute(val), { message: 'Path must be relative' })
  .refine((val) => !val.split(/[\\/]+/).includes('..'), { message: 'Path must not contain ".."' })
  .transform((val) =>
    val
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/'),
  )

// Singleton: A single-instance file with unique schema
export const singletonSchema = z.object({
  name: z.string().min(1),
  path: relativePathSchema,
  format: z.enum(['md', 'mdx', 'json']),
  fields: z.array(z.lazy(() => fieldSchema)).min(1),
  label: z.string().optional(),
})

// Collection entries config: shared schema for repeatable entries
export const collectionEntriesSchema = z.object({
  format: z.enum(['md', 'mdx', 'json']).optional(),
  fields: z.array(z.lazy(() => fieldSchema)).min(1),
})

// Forward declaration for recursive collection schema
let collectionSchema: z.ZodTypeAny

// Nested collection: must have name and path
collectionSchema = z.lazy(() =>
  z
    .object({
      name: z.string().min(1),
      path: relativePathSchema,
      label: z.string().optional(),
      entries: collectionEntriesSchema.optional(),
      collections: z.array(collectionSchema).optional(),
      singletons: z.array(singletonSchema).optional(),
    })
    .refine((data) => data.entries || data.collections || data.singletons, {
      message: 'Collection must have entries, collections, or singletons',
    }),
)

// Root collection: no name/path required (top-level schema)
export const rootCollectionSchema = z.object({
  entries: collectionEntriesSchema.optional(),
  collections: z.array(collectionSchema).optional(),
  singletons: z.array(singletonSchema).optional(),
})

export { collectionSchema }
