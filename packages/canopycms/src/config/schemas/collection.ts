/**
 * Zod schemas for collection configuration validation.
 */

import { z } from 'zod'
import { isAbsolute } from 'pathe'

import { fieldSchema } from './field'

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

export const entryTypeSchema = z.object({
  name: z.string().min(1),
  format: z.enum(['md', 'mdx', 'json', 'yaml']),
  schema: z.array(z.lazy(() => fieldSchema)).min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

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

export { collectionSchema }
