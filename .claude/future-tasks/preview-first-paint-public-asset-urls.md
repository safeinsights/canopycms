# A hook-only preview page's first paint loads images from the public path

**Status:** Open. **Priority: P2.** Filed 2026-10-07 from the final review of
[image-materialization-epic.md](resolved/image-materialization-epic.md). `createPreviewPage` views
are fixed. This file holds what remains: pages that call the preview hooks without it.

## State

A `createPreviewPage` view renders after hydration with the signed-in asset prefix already set,
and server components its `load` returns read a request-scoped prefix (`usePreviewAssetBaseGate`,
`canopycms-next`'s `preview-page.tsx`). A page that calls `useCanopyPreview` itself gets no such
signal: its server render does not know the request is a preview, so it emits public `/assets/t/…`
URLs. Under `AssetSupport`'s S3-only default, a derivative no build produced is a 403 until the
first draft message sets the prefix and that component re-renders. An image outside the hooked
component (a layout, a memoized sibling) stays 403.

Each such preview load also adds public-path 403s, which the proposed
[assets-transform-4xx-alarm.md](assets-transform-4xx-alarm.md) would count.

## Why it was not fixed with `createPreviewPage`

- Next renders a page's client components on the server in an async context of its own. A value an
  `AsyncLocalStorage` holds for the page never reaches it, and one entered during render is lost
  on Suspense retries. So only the page's own props can carry "this is a preview".
- A hook-only page is the adopter's own server component, so carrying that signal means a new
  adopter touchpoint: the page would have to pass something to its views.

## Options

1. **An opt-in prop or helper.** The adopter's server page hands its preview views the prefix,
   for example through a helper on the context that returns `previewAssetBase` for an
   authenticated `?branch=` request. The views then use the same gate. This is additive, not
   breaking.
2. **Point adopters at `createPreviewPage`** for every same-origin preview under the S3-only
   default, and leave hook-only pages as they are.
