---
'canopycms': patch
---

### Media-library thumbnails are stored at upload and cached by the browser — **behaviour change**

<!-- migration
area: Assets
action: None
row: Editor thumbnails stored at upload; raw-route redirects cacheable
-->

**What changed.** Finalizing a raster upload also stores the three widths the editor shows it at (`assets/t/w=80`, `w=160`, `w=320`), so the media library's first view reads stored objects instead of transforming in the request. Uploading a file that already exists stores any of those widths it lacks. This adds roughly 0.1 s to a typical photo's upload and up to about 0.6 s for a 24-megapixel PNG, measured locally; a failure is logged and never fails the upload. On S3, the authenticated asset route's redirect to a presigned URL is now `private, max-age` until the end of the hour rather than `no-store`, and the URL stays the same for that hour, so reopening the media library makes no asset requests. A cached redirect can outlive a sign-out by at most that hour; it points only at a public-prefix object under an unguessable key.
