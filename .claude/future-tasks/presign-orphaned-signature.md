# The presign handler mints a signature before deciding to refuse the request

**Status:** Open. **Priority: P3.** Pre-existing; filed 2026-09-10 while working nearby on
`media.uploadUrl`.

## Problem

`api/assets.ts`'s `presignAssetHandler` runs its checks in this order:

1. 501 if no asset store
2. 415 if the content type is not in `ALLOWED_UPLOAD_CONTENT_TYPES`
3. **`beginUpload()`** — which calls `createPresignedPost` and produces a real, signed,
   15-minute upload credential
4. 413 if `body.size` exceeds `target.maxBytes`

So a request that declares an over-cap size still mints a presigned POST, which is then
discarded and returned to nobody. The credential is never handed out, so this is not a leak; it
is an orphaned signature and a pointless signing operation on a rejected request.

## Why it is only P3

Nothing is written to the bucket — the presign is a pure computation over the key and policy,
and the staging object only exists once the browser POSTs. The signature never leaves the
process. The cost is a wasted HMAC and a slightly confusing read of the handler.

## Fix

Move the declared-size check above `beginUpload()`. It needs `target.maxBytes`, which today
comes from the store — so either read the cap from the store directly (it is
`S3AssetStoreOptions.maxUploadBytes`, defaulted in both stores to the same
`DEFAULT_MAX_UPLOAD_BYTES`) or expose it on the `AssetStore` interface rather than only on the
value `beginUpload()` returns. Note `uploadProxiedHandler` already does something in this
family, calling `beginUpload` with a throwaway filename purely to read `.maxBytes` before
buffering — so a cap that is readable without minting a presign would tidy both call sites.
