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

/**
 * What a create-only write did. Every key the store writes this way is content-addressed, so no
 * correct writer ever replaces an object: `already-exists` means an object was already at the key
 * and was left alone.
 */
export type CreateOnlyResult = 'created' | 'already-exists'

export interface AssetStore {
  readonly capabilities: { directUpload: boolean }
  beginUpload(input: BeginUploadInput): Promise<StagedUploadTarget>
  writeStaging(stagingKey: string, data: Uint8Array, contentType?: string): Promise<void>
  readStaging(stagingKey: string): Promise<Uint8Array | null>
  deleteStaging(stagingKey: string): Promise<void>
  /** Create-only; see `CreateOnlyResult`. */
  putOriginal(input: {
    hash32: string
    ext: string
    data: Uint8Array
    contentType: string
  }): Promise<CreateOnlyResult>
  /**
   * `ext` is where the original is expected (its meta's `ext`): that key is read first, and any
   * `{hash32}.*` is looked for only on a miss. A hit needs no list permission; on S3 without
   * `s3:ListBucket` a miss is a 403, which throws.
   */
  readOriginal(
    hash32: string,
    ext?: string,
  ): Promise<{ data: Uint8Array; ext: string; contentType?: string } | null>
  /** Create-only; see `CreateOnlyResult`. */
  putPublicObject(input: {
    key: string
    data: Uint8Array
    contentType: string
    contentDisposition?: string
    cacheControl?: string
    /** Object tags; bucket lifecycle rules can filter on them. */
    tags?: Readonly<Record<string, string>>
  }): Promise<CreateOnlyResult>
  readPublicObject(key: string): Promise<PublicObject | null>
  /** Whether a public object exists at `key`, without reading its body. */
  hasPublicObject(key: string): Promise<boolean>
  /** Every public object key under `prefix`, in the store's own pages. S3 only. */
  listPublicObjectKeys?(prefix: string): AsyncIterable<string>
  /** A short-lived URL a browser can GET `key` from directly, or `null` if absent. S3 only. */
  presignPublicObjectRead?(key: string): Promise<string | null>
  putMetaIfAbsent(hash32: string, meta: AssetMeta): Promise<CreateOnlyResult>
  getMeta(hash32: string): Promise<AssetMeta | null>
  listMeta(input?: {
    cursor?: string
    limit?: number
  }): Promise<{ items: AssetMeta[]; nextCursor?: string }>
  deleteMeta(hash32: string): Promise<void>
}
