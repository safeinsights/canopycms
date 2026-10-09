---
priority: P3
adopters: BOTH
summary: >-
  Live preview's reference resolver can cache an older answer for an id when two in-flight `resolveReferences` requests for it settle out of order; the stale target shows until the open entry or branch changes. Needs the target to change within one debounce window plus network latency. Fix with a per-key sequence number that drops a response older than the latest request for that key. Accepted as LOW in #449's review.
---
# Preview reference resolver can keep an out-of-order response

## Problem

`useReferenceResolution` (`packages/canopycms/src/editor/hooks/useReferenceResolution.ts`)
asks for every id the cache lacks, including ids whose request is still in flight. Each
debounced fetch calls `fetchReferences` and then `storeReferences`
(`packages/canopycms/src/editor/client-reference-resolver.ts`), which writes whatever the
response holds under `branch` + `id`, with no check that a newer request for that key has
already answered.

So when two requests for the same id are in flight and the referenced entry changes between
them, the older response can settle last and overwrite the newer one. The preview then shows
the stale target until `entryKey` changes (which expires the cache) or the branch changes
(which replaces it).

The window is narrow: the target has to change inside one 300 ms debounce window plus network
latency. Accepted as LOW in #449's review.

## Suggested fix

A per-key sequence number. Record the sequence of the latest request issued for each
`branch` + `id`, carry it with each request, and have `storeReferences` drop any id whose
response is older than the latest request for that key. A unit test can hold two
`resolveReferences` promises and resolve them in reverse order.
