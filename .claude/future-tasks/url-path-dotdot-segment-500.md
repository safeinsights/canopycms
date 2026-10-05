# A `..` inside a URL segment makes `readByUrlPath` a 500, not a 404

## Priority: P2 [BOTH]

Filed 2026-10-05, from the round-1 review of the `createPreviewPage` PR. **Measured** on
`apps/example1` (`next dev`), pre-existing on every public catch-all route.

## The gap

`GET /posts/hello..world`, `/docs/guides/v1..v2`, `/preview/posts/...` and an encoded
`..%2Fposts%2Fhello-world` all answer **500**. The log shows
`Error: Invalid path: contains traversal sequence: content/posts/...`.

The chain:
- `resolveUrlPathCandidates` (`packages/canopycms/src/url-path-resolver.ts`, the index candidate)
  builds `content/<all segments>`.
- `createLogicalPath` (`paths/normalize.ts`) throws a plain `Error` on the `..`.
- `readByUrlPath` (`context.ts`) swallows only `ContentStoreError`, so the plain `Error`
  escapes as a 500.

No data is exposed and nothing is provisioned. It is a noisy 500 where the contract says
"null → 404", and a dotted-slug typo is a realistic trigger.

## Proposed solution

Have `resolveUrlPathCandidates` return `[]` when any segment contains `..`, since no collection
or slug can. Alternatively, `readByUrlPath` could treat the traversal error as a miss. Add a test
for each spelling above.
