/**
 * Zod schemas for media adapter configuration validation.
 */

import { z } from 'zod'

// Media adapter configuration schema.
// Keyed as a discriminated union on `adapter` so each adapter's required fields are
// enforced at parse time. With a plain z.union, a malformed s3 config (e.g. missing
// `region`) could fall through to a looser branch, silently stripping fields instead
// of failing validation. There is no generic/custom adapter branch: only 'local', 's3',
// and 'lfs' are implemented (see BACKLOG.md "Asset adapters"); add a literal branch here
// when a new adapter ships.
export const mediaSchema = z.discriminatedUnion('adapter', [
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
])
