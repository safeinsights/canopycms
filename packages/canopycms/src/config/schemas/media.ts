/**
 * Zod schemas for media adapter configuration validation.
 */

import { z } from 'zod'

// Media adapter configuration schema
export const mediaSchema = z.union([
  z.object({
    adapter: z.literal('local'),
    publicBaseUrl: z.string().url().optional(),
  }),
  z.object({
    adapter: z.literal('s3'),
    bucket: z.string().min(1),
    region: z.string().min(1),
    publicBaseUrl: z.string().url().optional(),
  }),
  z.object({
    adapter: z.literal('lfs'),
    publicBaseUrl: z.string().url().optional(),
  }),
  z.object({
    adapter: z.string().min(1),
    publicBaseUrl: z.string().url().optional(),
  }),
])
