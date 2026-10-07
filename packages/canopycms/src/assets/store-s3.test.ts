/**
 * S3AssetStore specifics that have no LocalAssetStore counterpart, so they can't live in
 * store-parity.test.ts: the local store's beginUpload returns `mode: 'proxied'` with no `url`
 * at all.
 *
 * Everything here is about the presigned-POST target. Before this file existed, nothing in
 * the repo asserted `beginUpload()`'s returned `url` or `fields` — store-parity.test.ts calls
 * it once and reads only `.stagingKey`.
 */

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { S3AssetStore } from './store-s3'

// createPresignedPost resolves credentials through the S3 client's provider chain, bypassing
// aws-sdk-client-mock entirely. Dummy static credentials let the REAL signer run without
// touching AWS or the network — which is what makes the signature assertions below meaningful.
beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id'
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key'
})

// The endpoint assertions below pin the SDK's RESOLVED endpoint, and endpoint resolution reads
// developer machine state. A developer running MinIO/LocalStack, or with FIPS/dual-stack set,
// would otherwise see these fail for a reason unrelated to their change.
//
// Two sources, not one. The env vars are the obvious half; the shared config file is the half
// that is easy to miss, because `@smithy/middleware-endpoint` gives `endpoint_url` a
// `configFileSelector` as well as an `environmentVariableSelector` — so `~/.aws/config`
// carrying `endpoint_url` defeats an env-only fix. Pointing the SDK at paths that do not exist
// is what actually neutralizes it.
beforeEach(() => {
  for (const key of [
    'AWS_ENDPOINT_URL_S3',
    'AWS_ENDPOINT_URL',
    'AWS_USE_FIPS_ENDPOINT',
    'AWS_USE_DUALSTACK_ENDPOINT',
    'AWS_PROFILE',
  ]) {
    // vitest's stubEnv DELETES on undefined rather than storing the string 'undefined'.
    vi.stubEnv(key, undefined as unknown as string)
  }
  for (const key of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) {
    vi.stubEnv(key, path.join(os.tmpdir(), 'canopy-nonexistent-aws-config'))
  }
})

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: vi.fn(),
}))

const FIXED_UUID = '00000000-0000-4000-8000-000000000000'
const BUCKET = 'example-content-bucket'
const REGION = 'us-east-1'

// Both the staging key (via randomUUID) and the policy (via X-Amz-Date) vary per call, so
// without pinning BOTH, two presigns differ for reasons that have nothing to do with the
// property under test and the comparison below would be meaningless.
beforeEach(() => {
  vi.mocked(randomUUID).mockReturnValue(FIXED_UUID)
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Narrows to the 'direct' variant — S3AssetStore never returns 'proxied', and the union's
 *  other arm carries no `url` to assert against. */
const beginUpload = async (uploadUrl?: string) => {
  const target = await new S3AssetStore({ bucket: BUCKET, region: REGION, uploadUrl }).beginUpload({
    filename: 'photo.png',
    contentType: 'image/png',
  })
  if (target.mode !== 'direct') throw new Error(`expected a direct target, got ${target.mode}`)
  return target
}

describe('S3AssetStore.beginUpload upload target', () => {
  it('returns the SDK-resolved S3 endpoint when uploadUrl is unset', async () => {
    const target = await beginUpload()

    // Pinned exactly, trailing slash included: this records the value uploadUrl replaces, so
    // an SDK change to the endpoint shape is visible here rather than in an adopter's browser.
    expect(target).toMatchObject({
      mode: 'direct',
      url: `https://${BUCKET}.s3.${REGION}.amazonaws.com/`,
    })
  })

  it.each([
    ['an absolute URL', 'https://cdn.example.com/asset-upload/'],
    ['a site-relative path', '/asset-upload/'],
  ])('POSTs to the configured uploadUrl when set to %s', async (_label, uploadUrl) => {
    const target = await beginUpload(uploadUrl)

    expect(target).toMatchObject({ mode: 'direct', url: uploadUrl })
  })

  it('passes uploadUrl through byte-for-byte, without normalizing the trailing slash', async () => {
    // A CDN path pattern of `/asset-upload/*` does not match a literal `/asset-upload`, and
    // vice versa. We cannot see which the adopter deployed, so we must not pick one.
    expect(await beginUpload('/asset-upload')).toMatchObject({ url: '/asset-upload' })
    expect(await beginUpload('/asset-upload/')).toMatchObject({ url: '/asset-upload/' })
  })

  it('changes url and NOTHING else on the returned target', async () => {
    const withoutOverride = await beginUpload()
    const withOverride = await beginUpload('/asset-upload/')

    expect(withOverride.url).not.toBe(withoutOverride.url)
    expect({ ...withOverride, url: null }).toEqual({ ...withoutOverride, url: null })
    // Deliberately NOT also asserting Object.keys(fields) equality between these two: both
    // come from the same createPresignedPost call path in the same process, so no change to
    // our code could make that differ. It reads like a guard on multipart field order and
    // cannot fail by construction. The order that matters is `file` last, which is pinned for
    // real against the code that builds the body, in editor/media/xhr-upload.test.ts.
  })

  it('rejects an invalid uploadUrl at construction rather than at upload time', () => {
    // S3AssetStoreOptions is exported and constructible directly, so mediaSchema is not on
    // every path that reaches this class. Same defense-in-depth as assertStagingKey.
    expect(
      () => new S3AssetStore({ bucket: BUCKET, region: REGION, uploadUrl: '//evil.example.com' }),
    ).toThrow(/Invalid uploadUrl/)
  })
})

describe('S3AssetStore.presignPublicObjectRead', () => {
  const KEY = `assets/t/w=320/${'a'.repeat(32)}/photo.png`
  const s3Mock = mockClient(S3Client)

  afterEach(() => {
    s3Mock.reset()
  })

  it('returns null without signing when the HEAD finds no object', async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(new NotFound({ message: 'Not Found', $metadata: { httpStatusCode: 404 } }))
    const store = new S3AssetStore({ bucket: BUCKET, region: REGION })

    expect(await store.presignPublicObjectRead(KEY)).toBeNull()
    expect(s3Mock.commandCalls(HeadObjectCommand)[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Key: KEY,
    })
  })

  it('signs a short-lived GET of exactly that key when the object exists', async () => {
    s3Mock.on(HeadObjectCommand).resolves({})
    const store = new S3AssetStore({ bucket: BUCKET, region: REGION })

    const signed = await store.presignPublicObjectRead(KEY)
    if (signed === null) throw new Error('expected a presigned URL')
    const url = new URL(signed)

    // The signer percent-encodes `=` in the directive segment; S3 decodes it back to the key.
    expect(url.origin).toBe(`https://${BUCKET}.s3.${REGION}.amazonaws.com`)
    expect(decodeURIComponent(url.pathname)).toBe(`/${KEY}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // Signing is local: the only request the store made was the HEAD.
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0)
  })

  it('propagates a HEAD failure that is not a missing object', async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error('AccessDenied'))
    const store = new S3AssetStore({ bucket: BUCKET, region: REGION })

    await expect(store.presignPublicObjectRead(KEY)).rejects.toThrow('AccessDenied')
  })
})

describe('S3AssetStore missing key vs missing bucket', () => {
  let s3Mock: ReturnType<typeof mockClient>

  beforeEach(() => {
    s3Mock = mockClient(S3Client)
  })

  afterEach(() => {
    s3Mock.restore()
  })

  const awsError = (name: string) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } })

  it('reads a missing key as absent', async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError('NoSuchKey'))
    const store = new S3AssetStore({ bucket: BUCKET, region: REGION })
    expect(await store.getMeta('a'.repeat(32))).toBeNull()
  })

  it('reads an original by its expected ext without listing, and lists only on a miss', async () => {
    const body = { transformToByteArray: async () => new TextEncoder().encode('png-bytes') }
    s3Mock
      .on(GetObjectCommand, { Key: `asset-originals/${'a'.repeat(32)}.png` })
      .resolves({ Body: body, ContentType: 'image/png' } as never)
    s3Mock
      .on(GetObjectCommand, { Key: `asset-originals/${'a'.repeat(32)}.jpg` })
      .rejects(awsError('NoSuchKey'))
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] })
    const store = new S3AssetStore({ bucket: BUCKET, region: REGION })

    expect(await store.readOriginal('a'.repeat(32), 'png')).toMatchObject({ ext: 'png' })
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0)

    expect(await store.readOriginal('a'.repeat(32), 'jpg')).toBeNull()
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1)
  })

  it('throws for a missing bucket rather than reading every key as absent', async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError('NoSuchBucket'))
    const store = new S3AssetStore({ bucket: BUCKET, region: REGION })
    await expect(store.getMeta('a'.repeat(32))).rejects.toThrow('NoSuchBucket')
  })
})

describe('S3AssetStore.listPublicObjectKeys', () => {
  // Created per test, not per describe: a second describe-level mockClient(S3Client) would
  // replace the stub the presign suite above installed at collection time.
  let s3Mock: ReturnType<typeof mockClient>

  beforeEach(() => {
    s3Mock = mockClient(S3Client)
  })

  afterEach(() => {
    s3Mock.restore()
  })

  it('follows continuation tokens and yields every key under the prefix', async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'assets/t/w=320/a/x.png' }, { Key: 'assets/t/w=320/b/y.png' }],
        IsTruncated: true,
        NextContinuationToken: 'next',
      })
      .resolvesOnce({ Contents: [{ Key: 'assets/t/w=320/c/z.png' }], IsTruncated: false })
    const store = new S3AssetStore({ bucket: BUCKET, region: REGION })

    const keys: string[] = []
    for await (const key of store.listPublicObjectKeys('assets/t/w=320/')) keys.push(key)

    expect(keys).toEqual([
      'assets/t/w=320/a/x.png',
      'assets/t/w=320/b/y.png',
      'assets/t/w=320/c/z.png',
    ])
    // The paginator reuses one input object across pages, so only the last state is observable.
    const calls = s3Mock.commandCalls(ListObjectsV2Command)
    expect(calls).toHaveLength(2)
    expect(calls[1].args[0].input).toMatchObject({
      Bucket: BUCKET,
      Prefix: 'assets/t/w=320/',
      ContinuationToken: 'next',
    })
  })
})

describe('S3AssetStore.putPublicObject tags', () => {
  let s3Mock: ReturnType<typeof mockClient>

  beforeEach(() => {
    s3Mock = mockClient(S3Client)
    s3Mock.on(PutObjectCommand).resolves({})
  })

  afterEach(() => {
    s3Mock.restore()
  })

  const put = (tags?: Record<string, string>) =>
    new S3AssetStore({ bucket: BUCKET, region: REGION }).putPublicObject({
      key: 'assets/t/w=320/a/x.png',
      data: new Uint8Array([1]),
      contentType: 'image/png',
      tags,
    })

  it('sends tags as the URL-encoded Tagging header', async () => {
    await put({ 'canopy-transform': 'lazy', k: 'a&b c' })
    const calls = s3Mock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].input.Tagging).toBe('canopy-transform=lazy&k=a%26b%20c')
  })

  it.each([undefined, {}])('sends no Tagging header for tags %j', async (tags) => {
    await put(tags)
    const calls = s3Mock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0].args[0].input)).toContain('Key')
    expect(calls[0].args[0].input.Tagging).toBeUndefined()
  })
})

/**
 * UPSTREAM CONTRACT PIN — not a test of our code.
 *
 * The whole feature rests on one property of @aws-sdk/s3-presigned-post: a presigned POST's
 * string-to-sign is the base64 policy alone, so the endpoint host never enters the signature
 * and can therefore be swapped for a CDN hostname after the fact.
 *
 * If this fails after a dependency bump, the SDK has started signing the host and
 * `media.uploadUrl` is UNSOUND — every configured upload would 403. Do not "fix" this test;
 * the feature has to be withdrawn or redesigned.
 */
describe('@aws-sdk/s3-presigned-post contract', () => {
  it('produces identical policy and signature regardless of the client endpoint', async () => {
    const presignAgainst = (endpoint?: string) =>
      createPresignedPost(new S3Client({ region: REGION, endpoint }), {
        Bucket: BUCKET,
        Key: 'asset-staging/fixed-key',
        Conditions: [['content-length-range', 1, 100]],
        Fields: { 'Content-Type': 'image/png' },
        Expires: 900,
      })

    // Endpoint is the ONLY difference. Two regions would differ in X-Amz-Credential, and
    // forcePathStyle moves the bucket name into `fields.bucket` — either would make an
    // identical-fields assertion fail for a reason unrelated to the host.
    const atS3 = await presignAgainst()
    const atCdn = await presignAgainst('https://cdn.example.com')

    expect(atCdn.url).not.toBe(atS3.url)
    expect(atCdn.fields).toEqual(atS3.fields)
    expect(atCdn.fields['X-Amz-Signature']).toBe(atS3.fields['X-Amz-Signature'])
    expect(atCdn.fields.Policy).toBe(atS3.fields.Policy)
  })
})
