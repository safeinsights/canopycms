/**
 * Zod schemas for media adapter configuration validation.
 */

import { z } from 'zod'

import { relativePathSchema } from './collection'
import { assetMountUrlSchema, uploadTargetUrlSchema } from './url'

// Media adapter configuration schema.
// Keyed as a discriminated union on `adapter` so each adapter's required fields are
// enforced at parse time. With a plain z.union, a malformed s3 config (e.g. missing
// `region`) could fall through to a looser branch, silently stripping fields instead
// of failing validation. There is no generic/custom adapter branch: only 'local', 's3',
// and 'lfs' are implemented (see BACKLOG.md "Asset adapters"); add a literal branch here
// when a new adapter ships.
//
// Bucket-prefix layout (asset-originals/, asset-staging/, asset-meta/, assets/) is
// intentionally NOT configurable here — those are constants in assets/keys.ts, not
// per-site config (see .claude/future-tasks/assets-media-system.md).
//
// Every branch is .strict(). This is load-bearing, not tidiness: CanopyConfigSchema's own
// .strict() does NOT recurse into nested schemas, so until these branches carried their own,
// `media: { adapter: 's3', …, uploadURL: '/x' }` parsed successfully with the misspelled key
// silently stripped — and the adopter got the raw S3 endpoint back with no diagnostic
// anywhere. A config field whose whole purpose is to fail loudly at parse time cannot sit in
// a container that swallows typos.
export const mediaSchema = z.discriminatedUnion('adapter', [
  z
    .object({
      adapter: z.literal('local'),
      publicBaseUrl: assetMountUrlSchema.optional(),
      /** Root directory for local asset storage. Defaults to the caller's dev-assets dir. */
      directory: relativePathSchema.optional(),
    })
    .strict(),
  z
    .object({
      adapter: z.literal('s3'),
      bucket: z.string().min(1),
      region: z.string().min(1),
      publicBaseUrl: assetMountUrlSchema.optional(),
      /**
       * Where the browser POSTs a presigned direct upload. Absolute http(s) URL or a
       * site-relative path; defaults to the S3 REST endpoint the AWS SDK returns.
       *
       * Set this to route uploads through your own CDN so they are same-origin with the
       * editor, which removes the need for a bucket CORS rule naming an exact origin. The
       * signature is unaffected — a presigned POST's string-to-sign is the base64 policy
       * alone, so the host never enters it (pinned by store-s3.test.ts).
       *
       * NOT a prefix. Unlike `publicBaseUrl`, nothing is joined onto this value; it replaces
       * the POST target outright and is passed through byte-for-byte. Do not route it through
       * `joinUrlPrefix` "for consistency" — that would strip the trailing slash and silently
       * stop a CDN path pattern like `/asset-upload/*` from matching.
       */
      uploadUrl: uploadTargetUrlSchema.optional(),
      /** Max upload size in bytes for presigned direct uploads. Defaults to 50 MiB. */
      maxUploadBytes: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      adapter: z.literal('lfs'),
      publicBaseUrl: assetMountUrlSchema.optional(),
    })
    .strict(),
])
