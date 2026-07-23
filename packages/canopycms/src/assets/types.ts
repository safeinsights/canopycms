/**
 * Asset store v2 contract.
 *
 * Pure type declarations only — no runtime imports. This lets client-side code
 * (the editor) `import type` from this file without ever pulling node:fs or the
 * S3 SDK into a browser bundle. The concrete stores (store-local.ts, store-s3.ts)
 * and the factory are server-only and must never be imported from client code.
 */

export interface AssetMeta {
  hash32: string // sha-256 truncated to 32 hex chars
  filename: string // exact original filename
  slug: string // slugified filename (no extension), safe charset [a-z0-9-]
  ext: string // normalized extension without dot
  mime: string
  size: number
  width?: number
  height?: number
  kind: 'raster' | 'svg' | 'pdf'
  uploadedBy?: string
  uploadedAt: string // ISO 8601
}

export type StagedUploadTarget =
  | {
      mode: 'direct'
      url: string
      fields: Record<string, string>
      stagingKey: string
      maxBytes: number
    }
  | { mode: 'proxied'; stagingKey: string; maxBytes: number }

export interface BeginUploadInput {
  filename: string
  contentType: string
  size?: number
}

export interface PublicObject {
  data: Uint8Array
  contentType?: string
  contentDisposition?: string
  cacheControl?: string
}

export interface AssetStore {
  readonly capabilities: { directUpload: boolean }
  beginUpload(input: BeginUploadInput): Promise<StagedUploadTarget>
  writeStaging(stagingKey: string, data: Uint8Array, contentType?: string): Promise<void>
  readStaging(stagingKey: string): Promise<Uint8Array | null>
  deleteStaging(stagingKey: string): Promise<void>
  putOriginal(input: {
    hash32: string
    ext: string
    data: Uint8Array
    contentType: string
  }): Promise<void>
  readOriginal(
    hash32: string,
  ): Promise<{ data: Uint8Array; ext: string; contentType?: string } | null>
  putPublicObject(input: {
    key: string
    data: Uint8Array
    contentType: string
    contentDisposition?: string
    cacheControl?: string
  }): Promise<void>
  readPublicObject(key: string): Promise<PublicObject | null>
  putMetaIfAbsent(hash32: string, meta: AssetMeta): Promise<'created' | 'already-exists'>
  getMeta(hash32: string): Promise<AssetMeta | null>
  listMeta(input?: {
    cursor?: string
    limit?: number
  }): Promise<{ items: AssetMeta[]; nextCursor?: string }>
  deleteMeta(hash32: string): Promise<void>
}
