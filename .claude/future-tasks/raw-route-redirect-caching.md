# Raw-route presigned redirects are never cached by the browser

**Status:** Open. **Priority: P3.** Filed 2026-10-06 from review round 2 of
[image-materialization-epic.md](image-materialization-epic.md) Phase 1.

## State

On an S3 store, `api/assets.ts`'s raw route answers every stored object with a `302` to a
presigned GET marked `Cache-Control: no-store`, and `S3AssetStore.presignPublicObjectRead` signs a
fresh URL (5-minute expiry) per call. Neither the redirect nor the S3 object behind it is ever a
browser cache hit across loads, so each preview-iframe reload, entry switch or editor reload sends
every image back through the CMS Lambda (one invocation plus a HEAD each). That Lambda's reserved
concurrency (default 50) is shared with editor chunk loads, and the media library requests up to
40 thumbnails at once. Within one document, repeated renders of the same src do not refetch.

## Proposal

Cache the redirect privately for well under the presign expiry, e.g. `private, max-age=60`
(anything up to about 240 s keeps a cached redirect pointing at a still-valid URL). Measure first:
the Phase 1 brief chose `no-store`, and Lambda role credentials can expire before a URL's own
`X-Amz-Expires`, which bounds how long a cached redirect stays valid. Optionally reuse one signed
URL per key per process for the same window so the S3 object itself can be a cache hit.
