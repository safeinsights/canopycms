/**
 * Store orchestration around the (pure) finalize pipeline: dedup, write, and
 * best-effort staging cleanup. Split from pipeline.ts so the pipeline itself
 * stays store-agnostic and trivially unit-testable with plain byte fixtures.
 */

import { runFinalizePipeline, type FinalizeInput, type FinalizeRejection } from './pipeline'
import { ASSET_PREFIXES } from './keys'
import type { AssetMeta, AssetStore } from './types'

/**
 * A client-supplied staging key must be exactly `asset-staging/{uuid}` — the
 * shape beginUpload generates. Without this check, finalize's read + cleanup
 * would operate on ANY key the store can reach (asset-meta/, asset-originals/,
 * or in a shared bucket even builds/), letting a non-admin delete arbitrary
 * objects via the best-effort deleteStaging. Stores with overridden staging
 * prefixes must parameterize this check if that escape hatch is ever used.
 */
const STAGING_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isValidStagingKey(key: string): boolean {
  const prefix = `${ASSET_PREFIXES.staging}/`
  return key.startsWith(prefix) && STAGING_UUID_PATTERN.test(key.slice(prefix.length))
}

export type FinalizeAssetResult = { ok: true; meta: AssetMeta } | FinalizeRejection

/**
 * Run the finalize pipeline over raw bytes and persist the result.
 *
 * Order matters here too: dedup FIRST (after hashing, inside the pipeline) -
 * if an identical blob already exists, return the existing meta and skip all
 * writes entirely (first-name-wins). Otherwise write the original, then the
 * optional public object, then `putMetaIfAbsent` LAST: meta is the commit
 * point for an asset's existence, so a crash between `putOriginal` and here
 * leaves only orphaned (harmless, content-addressed) blobs, never a meta
 * record pointing at a missing blob.
 */
export async function finalizeAsset(
  store: AssetStore,
  input: FinalizeInput,
): Promise<FinalizeAssetResult> {
  const result = await runFinalizePipeline(input)
  if (!result.ok) return result

  const { meta, data, publicObject } = result

  const existing = await store.getMeta(meta.hash32)
  if (existing) return { ok: true, meta: existing }

  await store.putOriginal({ hash32: meta.hash32, ext: meta.ext, data, contentType: meta.mime })
  if (publicObject) {
    await store.putPublicObject(publicObject)
  }

  const putResult = await store.putMetaIfAbsent(meta.hash32, meta)
  if (putResult === 'already-exists') {
    // Lost a race against a concurrent identical upload - the winner's meta
    // (already committed) is authoritative; return it rather than ours.
    const winner = await store.getMeta(meta.hash32)
    if (winner) return { ok: true, meta: winner }
  }

  return { ok: true, meta }
}

/**
 * Finalize a previously-staged upload: read the staged bytes, run
 * `finalizeAsset`, and best-effort delete the staging object regardless of
 * outcome (success OR pipeline rejection - a rejected upload's staged bytes
 * are just as much litter as an accepted one's).
 */
export async function finalizeStagedUpload(
  store: AssetStore,
  stagingKey: string,
  filename: string,
  uploadedBy?: string,
): Promise<FinalizeAssetResult | { ok: false; status: 400 | 404; error: string }> {
  if (!isValidStagingKey(stagingKey)) {
    return { ok: false, status: 400, error: 'Invalid staging key' }
  }
  const staged = await store.readStaging(stagingKey)
  if (!staged) {
    return { ok: false, status: 404, error: 'Staged upload not found or expired' }
  }

  const result = await finalizeAsset(store, { data: staged, filename, uploadedBy })
  await store.deleteStaging(stagingKey).catch(() => {})
  return result
}
