# A live preview's first paint loads images from the public path

**Status:** Open. **Priority: P2.** Filed 2026-10-07 from the final review of
[image-materialization-epic.md](resolved/image-materialization-epic.md). Needs a decision before code: every
option changes how a preview view gets its asset prefix.

## State

`editor/preview-asset-base.ts` returns `undefined` on the server, so the CMS build's server render
of a preview page (`canopycms-next`'s `createPreviewPage` views, or any page using the preview
hooks) emits public `/assets/t/…` URLs. The browser requests them while parsing the HTML. Under
`AssetSupport`'s S3-only default, a derivative no build produced (a fresh crop, a new width) is a
403 until the first draft message sets the prefix in `usePreviewData` and that component
re-renders. Two consequences:

- Every preview load of a draft with new crops shows broken images for a moment.
- An image rendered outside the component that called the hook (a layout, a memoized sibling)
  never re-renders and stays 403.

Each preview session also adds public-path 403s, which the proposed
[assets-transform-4xx-alarm.md](assets-transform-4xx-alarm.md) would count.

## Options

1. **Server-side prefix for a preview request.** The preview route already knows the request is an
   authenticated preview. `canopycms/server` registers a request-scoped getter (AsyncLocalStorage)
   into the slot `asset-url.ts` reads, set by the preview page, so the server render and hydration
   both emit raw-route URLs. `asset-url.ts` stays dependency-free, since it only reads an injected
   getter. Covers images outside the hook's subtree.
2. **Pass the prefix as a view prop** and have adopters hand it to `assetUrl`'s `baseUrl`. That is
   simple, but it is a new adopter touchpoint and easy to forget per image.
3. **Accept and document** the first-paint flash, as a same-origin preview's known limitation.

Option 1 is the likely answer. Check it against every preview shape the README documents,
including pages that use the preview hooks without `createPreviewPage`.
