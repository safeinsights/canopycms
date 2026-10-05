# Editor preview iframe src skips `trailingSlash`

**Status: RESOLVED 2026-10-05**, branch `feat/preview-prefix`, base `int-202610-a`, together with
the single preview prefix (`editor.previewPrefix`).

- `buildPreviewSrc` emits the host's trailing-slash form through `matchTrailingSlash`, gated on
  the build-time flag. The flag is renamed `CANOPY_TRAILING_SLASH` and read by
  `readTrailingSlashEnv()` in `utils/url-prefix.ts`, now that it serves more than the API.
- With the flag off, it also drops the slash Next would redirect away, as on a `basePath` root.
- Both bridge ends compare URLs through `editor/preview-path.ts`, so a slash difference no
  longer drops drafts or focus clicks.
- Still not measured in a live build. The redirect rules were read from Next 15.5.21's
  `load-custom-routes.js`; [trailing-slash-build-smoke.md](../trailing-slash-build-smoke.md)
  covers a build-level check.

## Priority: P3 [BOTH]

Filed 2026-10-04 alongside the editor-API trailing-slash fix. **Not measured**: reasoned from the code.

## The gap

`buildPreviewSrc` (`packages/canopycms/src/editor/editor-utils.ts`) builds the preview iframe's
URL as `/<collection>/<slug>?branch=<name>`, with no trailing slash. On a host built with
`trailingSlash: true`, Next likely answers that with a 308 to `/<collection>/<slug>/?branch=…`,
so every preview load (and every entry switch) costs an extra round trip, and on the deployed CMS
an extra Lambda invocation.

## Proposed solution

- Measure first: load an entry in the editor on a `trailingSlash: true` build and check the iframe
  request for a 308.
- If confirmed, slash the raw preview path with `withTrailingSlash()` (`utils/url-prefix.ts`)
  when `readApiTrailingSlashEnv()` (`api/request-url.ts`) is true, before `joinUrlPrefix` adds
  `basePath`, and leave an adopter's `entry.previewSrc` escape hatch untouched. If the env key
  then serves more than the API, rename it; see
  [seo-trailing-slash-default-from-withcanopy.md](../seo-trailing-slash-default-from-withcanopy.md).

## Related

- [trailing-slash-router-helpers.md](../trailing-slash-router-helpers.md): site links, the same rule.
