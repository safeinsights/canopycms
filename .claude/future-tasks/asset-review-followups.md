# Future Task: Asset system review follow-ups (deferred from PR #126)

Status: **captured from debshila's PR #126 review, 2026-07-23.** The 11 actionable
code findings were fixed in commit d8eb807; these are the items deliberately deferred
as non-blocking (LOW/NIT or larger-than-the-bug scope). None affect correctness of the
happy path.

## Editor

- **Upload abort / unmount cleanup (M12)** — `editor/media/xhr-upload.ts` has an
  `xhr.onabort` handler but nothing ever calls `xhr.abort()`, and no layer accepts an
  `AbortSignal`. Closing the drawer / unmounting `ImageField` mid-upload leaves the
  XHR + the following presign→finalize chain running, and a resolved upload can call
  `onChange` on an unmounted field. Fix: thread an `AbortController` through
  `xhr-upload` → `useAssetUpload`, abort on unmount and on a user-facing Cancel control.
- **MediaLibraryBody upload-rejection uses the wrong error slot** — `handleReject`
  writes into `listError` (whose Retry reloads the list), not a dedicated upload-error
  slot like `ImageField`/`MdxImageDialog` use. Give it its own `dropError`.
- **MDX inline image preview ignores `assetBaseUrl`** — only matters in the
  cross-origin editor/site config.
- **CropStep silent no-op** when `cropAreaPercentToRect` returns null (practically
  unreachable under an aspect constraint) — add a guard/message.
- **URL-tab scheme check** in `MdxImageDialog` — light `http(s):`/root-relative
  validation for UX (not a security issue — image `src` doesn't execute).

## API / store

- **Post-delete blob GC** — `delete` removes only the meta sidecar; the original,
  public object, and cached transforms stay readable via the raw route (an admin
  "delete" delists but doesn't stop serving, and always returns `{deleted:true}`).
  This is the "later worker GC hard-deletes unreferenced blobs" already noted in
  [assets-media-system.md](resolved/assets-media-system.md); this is the concrete ticket for it.
  Decide the contract: synchronous public-object+original delete, or documented
  delist-only + async GC.

  **COUPLED — read before implementing.** As of 2026-07-30, delete is no longer
  admin-only: a non-admin may delete an asset whose `uploadedBy` is them
  (`api/assets.ts`'s `deleteAssetHandler`). That permission is only safe *because*
  delete is a de-list — nothing another branch references breaks. If this GC work
  makes delete destroy the underlying blob, the uploader-owned permission must be
  revisited at the same time: it would then need a reference check, or to revert
  to admin-only. Do not land destructive GC without deciding that.
  See [asset-listing-cross-branch-exposure.md](asset-listing-cross-branch-exposure.md).
- **Multipart `filename` not shape-validated** (`api/assets.ts` uploadProxied override)
  — bypasses `filenameSchema`; stored unbounded in `meta.filename`. Not an injection
  risk (slug is capped, Content-Disposition uses the RFC 5987 lib), just inconsistent.
- **Raster total-byte cap at finalize** — currently relies on the presign
  content-length-range; add a defensive `staged.byteLength` cap (the H1 fix added the
  pixel cap; this is the byte-cap companion at the finalize boundary).
- **`altOptional` + omitted `alt`** — an omitted `alt` still fails validation
  ("required"); only explicit `alt: ''` passes under `altOptional: true`. Align for
  direct-API writers; add a test.
- **`isValidStagingKey` hardcodes the default staging prefix** while `S3AssetStore`
  accepts a `prefixes` override — a custom staging prefix would break finalize.
  Currently unused; take the store's configured prefix.

## Nits (do opportunistically)

- `entry-schema.ts` `ImageValue` is a hand-maintained mirror of `ImageFieldValue` —
  add a `// keep in sync with` cross-reference.
- Test doubles use `const services: any` in `api/assets.test.ts` /
  `http/handler-binary.test.ts` — move to a typed `Partial<CanopyServices>`.
- `@mantine/dropzone` is pinned exactly (7.17.8) while other `@mantine/*` are `^7.14.2`
  — intentional (dropzone peer-pins the exact core version), but if core ever resolves
  past 7.17.8 the peer mismatches; revisit if it bites.
- `canary/bin/canary.ts` hardcodes the sandbox account id (deliberate for the canary,
  but note it).
- ~~Transform error-status flattening: the dev route collapses rejections to 502 and
  the Lambda collapses 400|413|422 to 422 — map `transformed.status` through in both
  so a client-input error isn't reported as a server error.~~ **RESOLVED
  (2026-07-30, fix/finalize-validates-decodability):** both `serveLazyTransform`
  (api/assets.ts) and the transform Lambda handler (canopycms-cdk/lambda/asset-transform/handler.ts)
  now pass `transformed.status` through verbatim; handler.test.ts and assets.test.ts
  assert 400/413/422 pass-through.
