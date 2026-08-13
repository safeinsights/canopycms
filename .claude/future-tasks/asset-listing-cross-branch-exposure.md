# Asset listing exposes every branch's images to every authenticated user

Audited 2026-07-30 (question: "can an editor see or delete images from a branch they
don't have access to?"). Verified against `integration-202607-a`.

## What is true today

**Assets are not branch-scoped at all.** There is one shared, content-addressed pool
per site:

- `assets/asset-prefixes.ts` and `assets/keys.ts` build every key from `hash32` + slug.
  No branch segment anywhere.
- `AssetMeta` (`assets/types.ts`) has no `branch` field.
- The `AssetStore` interface takes no branch parameter on any method.
- `assets/factory.ts` creates exactly one store per site config, attached once to
  `ctx.assetStore` — not per branch, not per request.
- No `authorization/` branch or path ACL is consulted by any asset handler.

This is deliberate and documented in
[resolved/assets-media-system.md](resolved/assets-media-system.md) — content-addressed
storage is what lets a branch merge avoid moving blobs. `api/assets.ts` carries a
comment saying so explicitly.

### Read: unrestricted

`GET /assets` has no `guards` array, so `route-builder.ts` skips guard execution
entirely. The only gate is the base `authPlugin.authenticate` in `http/handler.ts`.
Any authenticated user — any role, any branch membership, including someone with zero
branch grants — receives `listMeta` for **every asset ever uploaded site-wide**:
filename, mime, size, uploader, timestamp, and the computed public `src` URL. The same
absence of guards applies to `presign`, `finalize`, `uploadProxied`, and the
hand-registered `GET /assets/raw/{key...}` (which bypasses `defineEndpoint` entirely).

**This is the finding that matters:** the design accepted "unlisted ≠ private" on the
basis that keys are unguessable 128-bit hashes. But the list endpoint hands out the
entire catalog, so nothing has to be guessed. The unguessability mitigation does not
actually mitigate anything as long as `GET /assets` is open.

### Delete: admin-only, and non-destructive

`DELETE /assets` carries `guards: ['admin']` — the site-wide `Admins` reserved group.
Admins already bypass branch ACLs everywhere (`authorization/branch.ts`), so this is
consistent with existing privilege semantics rather than a new escalation. Non-admins
can delete nothing at all, so there is no cross-branch delete vector.

Delete also only removes the **meta sidecar**. Originals, public objects and cached
transforms survive, so nothing another branch references breaks. `MediaLibraryBody.tsx`
already tells the user "the file itself is not deleted." Blob GC is a separate deferred
item — see [asset-review-followups.md](asset-review-followups.md).

Route shadowing (the old SEC-H3, where `DELETE /:branch` could swallow `DELETE /assets`)
is **fixed**: `http/router.ts` matches static segments before dynamic ones, with
regression tests in `router.test.ts`.

## The decision

Three options were weighed.

**(a) Accept and document.** Cheapest, matches the existing design record. Requires
stating the boundary out loud rather than leaving it implied.

**(b) Guard `GET /assets` to privileged roles. — REJECTED.** `assets.list` is what backs
`editor/media/MediaLibrary.tsx` and `editor/fields/ImageField.tsx`, i.e. the image
picker ordinary editors use. Guarding it breaks the product for the people it is for.

**(c) Branch-scope the listing.** The only option that restores real isolation, and the
open design question. Two unsolved problems, either of which can sink a naive attempt:

1. **Merge visibility.** If listing filters on "uploaded on a branch you can access",
   then once that branch merges and is deleted, its images vanish from everyone's
   picker. Needs a rule — visible-when-branch-gone? visible-when-referenced-from-base?
   — and that rule is the actual design work.
2. **Content-addressed dedup makes provenance multi-valued.** See below. This is the
   part that was not obvious and that kills the cheap version.

**Chosen for now: (a).** Nothing has been uploaded for real, and the one test deploy is
being destroyed, so there is no urgency and no data to protect yet. Revisit (c) when a
real multi-editor deployment with restricted material is on the table.

## Why "just stamp `uploadedOnBranch` now while it's free" does not work

The plan that produced this file proposed banking a provenance field immediately, on
the theory that it costs one field today and cannot be backfilled later. Inspection
killed it:

`finalizeAsset` (`assets/finalize.ts`) dedups on the content hash and returns the
**existing** meta when the blob is already present — first-name-wins — and meta is
write-once via `putMetaIfAbsent`. So if user A uploads image X on branch A, and later
user B uploads the identical image X on branch B, the stored meta still says branch A.
B's upload records nothing.

A single-valued `uploadedOnBranch` would therefore be **actively misleading** for the
purpose it was intended to serve: a future (c) implementation filtering on it would hide
an image from the very user who just uploaded it. A field that silently under-reports is
worse than no field, because it looks authoritative.

Doing it properly means provenance is a **set** of branches, appended on every dedup
hit — which turns a write-once meta record into a read-modify-write on every duplicate
upload, on a store whose whole concurrency story is built on `putMetaIfAbsent`. That is
option (c)'s design work, not a free side-effect to sneak in ahead of it.

**Conclusion: do not stamp a provenance field until (c) is actually designed.** The
"free today, impossible tomorrow" argument is wrong — what is impossible later is
recovering *historical* provenance, and with zero real uploads there is no history to
lose.

## Same caveat applies to `uploadedBy`

`uploadedBy` has the identical dedup property: it records the first uploader only. This
is why uploader-owned delete (landed alongside this file) is scoped as
"admin **or** recorded uploader, with missing `uploadedBy` falling back to admin-only" —
a second person uploading an identical file simply doesn't gain delete rights over it.
Benign (a 403 where they expected success, never the reverse), but worth knowing before
anyone builds ownership semantics on that field.

## Related

- [asset-review-followups.md](asset-review-followups.md) — blob GC. **Coupled:** if GC
  ever makes delete destroy the underlying blob, delete stops being a de-list and
  uploader-owned delete must be revisited (it would then need a reference check).
- [list-permission-level.md](list-permission-level.md) — establishes a "list ≠ read"
  permission concept for *content* that was never extended to assets. If (c) is ever
  built, reuse that vocabulary rather than inventing a parallel one.
- [resolved/assets-media-system.md](resolved/assets-media-system.md) — the design record
  that accepted the branch-agnostic tradeoff.
