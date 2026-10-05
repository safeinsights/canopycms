# Editor preview iframe src skips `trailingSlash`

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
  [seo-trailing-slash-default-from-withcanopy.md](seo-trailing-slash-default-from-withcanopy.md).

## Related

- [trailing-slash-router-helpers.md](trailing-slash-router-helpers.md): site links, the same rule.
