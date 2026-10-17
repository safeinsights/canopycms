---
'canopycms': minor
---

### Media-library thumbnails are stored at upload and cached by the browser — **breaking (AssetStore.presignPublicObjectRead) / behaviour change**

<!-- migration
area: Assets
action: Custom AssetStore only
row: Thumbnails stored at upload; presigned reads return a reuse time
-->

**What changed.** Finalizing a raster upload also stores the three widths the editor shows it at (`assets/t/w=80`, `w=160`, `w=320`), so the media library's first view reads stored objects instead of transforming in the request. Uploading a file that already exists stores any of those widths it lacks. Animated images are skipped; their first view transforms them as before. This adds roughly 0.1 s to a typical photo's upload; a failure is logged and never fails the upload. On S3, the authenticated asset route's redirect to a presigned URL is now `private, max-age` until the end of the hour rather than `no-store`, and the URL stays the same for that hour, so reopening the media library fetches no thumbnails. A cached redirect can outlive a sign-out by at most that hour; it points only at a public-prefix object under an unguessable key. A streamed object stored without a `Cache-Control` is now sent as `private, max-age=31536000, immutable`, since every public-prefix key is content-addressed.

**To adopt.** Only a custom `AssetStore` that implements `presignPublicObjectRead` changes: it returns `PresignedRead` (`{ url, maxAgeSeconds }`, from `canopycms/server`) or `null`, instead of a URL string. `maxAgeSeconds` is how long a browser may reuse that URL; return `0` to keep the old `no-store` behaviour.
