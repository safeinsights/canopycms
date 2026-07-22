/**
 * S3-backed AssetStore. Same bucket-prefix layout as LocalAssetStore (see
 * keys.ts). Assumes an EXISTING content bucket (versioning/SSE/replication
 * already configured by the site's CDK stack) — this store only ever reads
 * and writes objects under the five asset prefixes.
 */

import { randomUUID } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'

import { ASSET_PREFIXES, createKeyBuilders, type AssetPrefixes } from './keys'
import type {
  AssetMeta,
  AssetStore,
  BeginUploadInput,
  PublicObject,
  StagedUploadTarget,
} from './types'

export interface S3AssetStoreOptions {
  bucket: string
  region: string
  publicBaseUrl?: string
  /** Defaults to 50 MiB. */
  maxUploadBytes?: number
  /** Override the default bucket-prefix layout (rarely needed). */
  prefixes?: AssetPrefixes
}

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const PRESIGN_EXPIRY_SECONDS = 15 * 60

/**
 * Shape of the fields an AWS SDK v3 service exception carries, narrowed from
 * `unknown` without resorting to `any`. S3 does not model a conditional-write
 * (412) failure as its own exception class — it surfaces as a generic
 * exception whose `name`/`$metadata.httpStatusCode` identify it.
 */
interface AwsServiceErrorShape {
  name?: string
  $metadata?: { httpStatusCode?: number }
}

function matchesAwsError(err: unknown, name: string, httpStatusCode: number): boolean {
  if (!(err instanceof Error)) return false
  const shaped = err as Error & AwsServiceErrorShape
  return shaped.name === name || shaped.$metadata?.httpStatusCode === httpStatusCode
}

const isPreconditionFailed = (err: unknown): boolean =>
  matchesAwsError(err, 'PreconditionFailed', 412)

const isNoSuchKey = (err: unknown): boolean => matchesAwsError(err, 'NoSuchKey', 404)

export class S3AssetStore implements AssetStore {
  readonly capabilities = { directUpload: true }
  private readonly client: S3Client
  private readonly bucket: string
  private readonly maxUploadBytes: number
  private readonly keys: ReturnType<typeof createKeyBuilders>
  private readonly stagingPrefix: string

  constructor(options: S3AssetStoreOptions) {
    this.bucket = options.bucket
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
    this.client = new S3Client({ region: options.region })
    const prefixes = options.prefixes ?? ASSET_PREFIXES
    this.keys = createKeyBuilders(prefixes)
    this.stagingPrefix = `${prefixes.staging}/`
  }

  /**
   * Staging methods accept caller-influenced keys (finalize receives the key
   * from the client), so they must never operate outside the staging prefix —
   * in a shared content bucket an unguarded deleteStaging would reach deploy
   * artifacts under builds/. The API layer validates too; defense-in-depth.
   */
  private assertStagingKey(key: string): void {
    if (!key.startsWith(this.stagingPrefix)) {
      throw new Error(`Not a staging key: ${key}`)
    }
  }

  async beginUpload(input: BeginUploadInput): Promise<StagedUploadTarget> {
    const key = this.keys.stagingKey(randomUUID())
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, this.maxUploadBytes],
        { 'Content-Type': input.contentType },
      ],
      Fields: {
        'Content-Type': input.contentType,
      },
      Expires: PRESIGN_EXPIRY_SECONDS,
    })
    return { mode: 'direct', url, fields, stagingKey: key, maxBytes: this.maxUploadBytes }
  }

  async writeStaging(key: string, data: Uint8Array, contentType?: string): Promise<void> {
    this.assertStagingKey(key)
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    )
  }

  async readStaging(key: string): Promise<Uint8Array | null> {
    this.assertStagingKey(key)
    return this.getObjectBytes(key)
  }

  async deleteStaging(key: string): Promise<void> {
    this.assertStagingKey(key)
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async putOriginal(input: {
    hash32: string
    ext: string
    data: Uint8Array
    contentType: string
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keys.originalKey(input.hash32, input.ext),
        Body: input.data,
        ContentType: input.contentType,
      }),
    )
  }

  async readOriginal(
    hash32: string,
  ): Promise<{ data: Uint8Array; ext: string; contentType?: string } | null> {
    const prefix = this.keys.originalPrefix(hash32)
    const listed = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1 }),
    )
    const foundKey = listed.Contents?.[0]?.Key
    if (!foundKey) return null

    const result = await this.getObject(foundKey)
    if (!result) return null
    const data = await result.Body?.transformToByteArray()
    if (!data) return null
    return { data, ext: foundKey.slice(prefix.length), contentType: result.ContentType }
  }

  async putPublicObject(input: {
    key: string
    data: Uint8Array
    contentType: string
    contentDisposition?: string
    cacheControl?: string
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.data,
        ContentType: input.contentType,
        ContentDisposition: input.contentDisposition,
        CacheControl: input.cacheControl,
      }),
    )
  }

  async readPublicObject(key: string): Promise<PublicObject | null> {
    const result = await this.getObject(key)
    if (!result) return null
    const data = await result.Body?.transformToByteArray()
    if (!data) return null
    return {
      data,
      contentType: result.ContentType,
      contentDisposition: result.ContentDisposition,
      cacheControl: result.CacheControl,
    }
  }

  async putMetaIfAbsent(hash32: string, meta: AssetMeta): Promise<'created' | 'already-exists'> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.keys.metaKey(hash32),
          Body: JSON.stringify(meta),
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      )
      return 'created'
    } catch (err: unknown) {
      if (isPreconditionFailed(err)) return 'already-exists'
      throw err
    }
  }

  async getMeta(hash32: string): Promise<AssetMeta | null> {
    const bytes = await this.getObjectBytes(this.keys.metaKey(hash32))
    if (!bytes) return null
    return JSON.parse(Buffer.from(bytes).toString('utf-8')) as AssetMeta
  }

  async listMeta(input?: { cursor?: string; limit?: number }): Promise<{
    items: AssetMeta[]
    nextCursor?: string
  }> {
    const listed = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.keys.metaPrefix(),
        MaxKeys: input?.limit,
        ContinuationToken: input?.cursor,
      }),
    )
    const objectKeys = (listed.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => Boolean(key))

    const fetched = await Promise.all(
      objectKeys.map(async (key) => {
        const bytes = await this.getObjectBytes(key)
        // A meta object deleted between LIST and GET (deleteMeta race) reads
        // as null; skip it rather than failing the whole page.
        if (!bytes) return null
        return JSON.parse(Buffer.from(bytes).toString('utf-8')) as AssetMeta
      }),
    )

    return {
      items: fetched.filter((meta): meta is AssetMeta => meta !== null),
      nextCursor: listed.IsTruncated ? listed.NextContinuationToken : undefined,
    }
  }

  async deleteMeta(hash32: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keys.metaKey(hash32) }),
    )
  }

  private async getObject(key: string) {
    try {
      return await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    } catch (err: unknown) {
      if (isNoSuchKey(err)) return null
      throw err
    }
  }

  private async getObjectBytes(key: string): Promise<Uint8Array | null> {
    const result = await this.getObject(key)
    if (!result) return null
    const bytes = await result.Body?.transformToByteArray()
    return bytes ?? null
  }
}
