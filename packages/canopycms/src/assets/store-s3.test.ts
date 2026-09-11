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

import { S3Client } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
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
// the environment. A developer running MinIO/LocalStack locally (AWS_ENDPOINT_URL_S3), or with
// FIPS/dual-stack set, would otherwise see these fail for a reason unrelated to their change.
// Cleared rather than defaulted, since these have no correct value here.
beforeEach(() => {
  for (const key of [
    'AWS_ENDPOINT_URL_S3',
    'AWS_ENDPOINT_URL',
    'AWS_USE_FIPS_ENDPOINT',
    'AWS_USE_DUALSTACK_ENDPOINT',
  ]) {
    vi.stubEnv(key, undefined as unknown as string)
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
