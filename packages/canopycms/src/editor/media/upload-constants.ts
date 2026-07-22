/**
 * Client-side upload UX constants. Deliberately duplicated from
 * assets/pipeline.ts's `ALLOWED_UPLOAD_CONTENT_TYPES`/size caps rather than
 * imported from it: pipeline.ts is server-only (pulls in `file-type` and
 * `image-size`) and must never reach a browser bundle. These are UX-only
 * (Dropzone's `accept`/`maxSize` props reject bad files before an upload even
 * starts) - the server-side finalize pipeline is the actual source of truth
 * and re-validates independently.
 */

/**
 * Mirrors assets/pipeline.ts's RASTER_MIME_TYPES + SVG_MIME_TYPE + PDF_MIME_TYPE.
 * A plain (not `readonly`/`as const`) `string[]` - `@mantine/dropzone`'s
 * `accept` prop takes `string[] | Accept`, neither of which accepts a
 * readonly tuple.
 */
export const ACCEPTED_ASSET_MIME_TYPES: string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
]

/** Mirrors store-local.ts/store-s3.ts's DEFAULT_MAX_UPLOAD_BYTES. The real limit is enforced by the presigned target's `maxBytes` (S3 content-length-range or the local store's own cap); this only avoids a doomed upload attempt. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
