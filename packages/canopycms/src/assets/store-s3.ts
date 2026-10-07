/**
 * S3-backed AssetStore. Same bucket-prefix layout as LocalAssetStore (see
 * keys.ts). Assumes an EXISTING content bucket (versioning/SSE/replication
 * already configured by the site's CDK stack) — this store only ever reads
 * and writes objects under the five asset prefixes.
 */

import { randomUUID } from 'node:crypto'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
  paginateListObjectsV2,
} from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { isHttpUrlOrSameOriginPath } from '../utils/sanitize-href'
import { ASSET_PREFIXES, createKeyBuilders, type AssetPrefixes } from './keys'
import type {
  AssetMeta,
  AssetStore,
  BeginUploadInput,
  CreateOnlyResult,
  PublicObject,
  StagedUploadTarget,
} from './types'

export interface S3AssetStoreOptions {
  bucket: string
  region: string
  /** Defaults to 50 MiB. */
  maxUploadBytes?: number
  /**
   * POST target for presigned direct uploads, replacing the S3 REST endpoint the AWS SDK
   * returns. Absolute http(s) URL or a site-relative path. See `mediaSchema`'s s3 branch for
   * what this is for; see `isHttpUrlOrSameOriginPath` for what is accepted.
   *
   * Not a public base URL: nothing is joined onto it and it is never rendered or stored -
   * it is the endpoint the browser posts to, returned to the client inside the presign
   * response rather than in the client config.
   */
  uploadUrl?: string
  /** Override the default bucket-prefix layout (rarely needed). */
  prefixes?: AssetPrefixes
  /** @internal Test seam for the conditional-write retry delay. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const PRESIGN_EXPIRY_SECONDS = 15 * 60
/** A presigned read is followed by the browser at once; it is never stored or cached. */
const PRESIGNED_READ_EXPIRY_SECONDS = 5 * 60

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

/**
 * S3's 409 for a conditional write racing another write to the same key that is still in flight.
 * Matched by name only: a 409 is also `OperationAborted`, which is not this.
 */
const isConditionalRequestConflict = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ConditionalRequestConflict'

/** At most 4 attempts and under 1.75 s of waiting; a race still unresolved after that throws the 409. */
const CONFLICT_ATTEMPTS = 4
const CONFLICT_BASE_DELAY_MS = 250

/**
 * A missing key, never a missing bucket: S3 answers both with 404, and only a GET's error code names
 * which. A HEAD's 404 has no body, so `hasPublicObject` reads either as absent; a caller that must
 * tell them apart follows with a GET (assets/materialize.ts does).
 */
const isNoSuchKey = (err: unknown): boolean =>
  matchesAwsError(err, 'NoSuchKey', 404) && (err as AwsServiceErrorShape).name !== 'NoSuchBucket'

export class S3AssetStore implements AssetStore {
  readonly capabilities = { directUpload: true }
  private readonly client: S3Client
  private readonly bucket: string
  private readonly maxUploadBytes: number
  private readonly uploadUrl: string | undefined
  private readonly keys: ReturnType<typeof createKeyBuilders>
  private readonly stagingPrefix: string
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: S3AssetStoreOptions) {
    this.bucket = options.bucket
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
    // Re-validated here even though mediaSchema already checks it: this class is exported and
    // constructible directly, so config validation is not on every path that reaches it. Same
    // defense-in-depth reasoning as assertStagingKey below.
    if (options.uploadUrl !== undefined && !isHttpUrlOrSameOriginPath(options.uploadUrl)) {
      throw new Error(`Invalid uploadUrl: ${options.uploadUrl}`)
    }
    this.uploadUrl = options.uploadUrl
    this.client = new S3Client({ region: options.region })
    const prefixes = options.prefixes ?? ASSET_PREFIXES
    this.keys = createKeyBuilders(prefixes)
    this.stagingPrefix = `${prefixes.staging}/`
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Sends one create-only request (`IfNoneMatch: '*'`), so S3 answers a taken key with 412. A
   * `ConditionalRequestConflict` is retried here, the only retry layer for it, so a caller with no
   * retry of its own (the lazy transform Lambda, finalize) ends in one of the two results.
   */
  private async createIfAbsent(send: () => Promise<unknown>): Promise<CreateOnlyResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        await send()
        return 'created'
      } catch (err: unknown) {
        if (isPreconditionFailed(err)) return 'already-exists'
        if (!isConditionalRequestConflict(err) || attempt >= CONFLICT_ATTEMPTS) throw err
        await this.sleep(CONFLICT_BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + Math.random() / 2))
      }
    }
  }

  private putIfAbsent(
    input: Omit<PutObjectCommandInput, 'Bucket' | 'IfNoneMatch'>,
  ): Promise<CreateOnlyResult> {
    return this.createIfAbsent(() =>
      this.client.send(new PutObjectCommand({ ...input, Bucket: this.bucket, IfNoneMatch: '*' })),
    )
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

  /**
   * `uploadUrl` replaces only the returned `url`. `createPresignedPost` must still run — we
   * need its `fields`, which carry the policy and signature — and it must still be called
   * against the real bucket endpoint: a presigned POST's string-to-sign is the base64 policy
   * alone, so the host is not signed and does not belong in the presign's input. Routing
   * `uploadUrl` into the S3 client's `endpoint` instead would also mangle it, prepending the
   * bucket as a subdomain (or, with forcePathStyle, exposing it in the path).
   */
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
    return {
      mode: 'direct',
      url: this.uploadUrl ?? url,
      fields,
      stagingKey: key,
      maxBytes: this.maxUploadBytes,
    }
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
  }): Promise<CreateOnlyResult> {
    return this.putIfAbsent({
      Key: this.keys.originalKey(input.hash32, input.ext),
      Body: input.data,
      ContentType: input.contentType,
    })
  }

  async readOriginal(
    hash32: string,
    ext?: string,
  ): Promise<{ data: Uint8Array; ext: string; contentType?: string } | null> {
    if (ext !== undefined) {
      const direct = await this.getObject(this.keys.originalKey(hash32, ext))
      const data = await direct?.Body?.transformToByteArray()
      if (data) return { data, ext, contentType: direct?.ContentType }
    }

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
    tags?: Readonly<Record<string, string>>
  }): Promise<CreateOnlyResult> {
    // `encodeURIComponent` writes a space as `%20`, which reads the same to any decoder;
    // URLSearchParams writes `+`.
    const tagging = Object.entries(input.tags ?? {})
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')
    return this.putIfAbsent({
      Key: input.key,
      Body: input.data,
      ContentType: input.contentType,
      ContentDisposition: input.contentDisposition,
      CacheControl: input.cacheControl,
      Tagging: tagging || undefined,
    })
  }

  /**
   * A server-side CopyObject. S3 URL-decodes `CopySource`, and keys hold `=`, `,` and `:`, so each
   * segment is encoded and the `/` between them is not. `MetadataDirective: 'COPY'` keeps the
   * source's Content-Type, Cache-Control and Content-Disposition; `TaggingDirective: 'REPLACE'`
   * with no `Tagging` leaves the copy untagged.
   */
  async copyPublicObject(
    sourceKey: string,
    destKey: string,
  ): Promise<CreateOnlyResult | 'source-missing'> {
    const copySource = `${this.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`
    try {
      return await this.createIfAbsent(() =>
        this.client.send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            Key: destKey,
            CopySource: copySource,
            IfNoneMatch: '*',
            MetadataDirective: 'COPY',
            TaggingDirective: 'REPLACE',
          }),
        ),
      )
    } catch (err: unknown) {
      // By name alone: a copy's error always carries its code, and a missing bucket is a 404 too.
      if (err instanceof Error && err.name === 'NoSuchKey') return 'source-missing'
      throw err
    }
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

  /**
   * A HEAD. S3 answers a missing key with 403, not 404, unless the caller may `s3:ListBucket`,
   * so a role without it sees an error here rather than `false`.
   */
  async hasPublicObject(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (err: unknown) {
      if (isNoSuchKey(err)) return false
      throw err
    }
  }

  async *listPublicObjectKeys(prefix: string): AsyncIterable<string> {
    const pages = paginateListObjectsV2(
      { client: this.client },
      { Bucket: this.bucket, Prefix: prefix },
    )
    for await (const page of pages) {
      for (const object of page.Contents ?? []) {
        if (object.Key) yield object.Key
      }
    }
  }

  /** HEADs first: signing is local and succeeds for a missing key too. */
  async presignPublicObjectRead(key: string): Promise<string | null> {
    if (!(await this.hasPublicObject(key))) return null
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: PRESIGNED_READ_EXPIRY_SECONDS,
    })
  }

  async putMetaIfAbsent(hash32: string, meta: AssetMeta): Promise<CreateOnlyResult> {
    return this.putIfAbsent({
      Key: this.keys.metaKey(hash32),
      Body: JSON.stringify(meta),
      ContentType: 'application/json',
    })
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
