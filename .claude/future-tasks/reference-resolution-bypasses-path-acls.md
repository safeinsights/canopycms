# Reference resolution embeds a referenced entry's data without checking access to it

## Priority: P1 [BOTH] — pre-existing, but it becomes load-bearing at the first real ACL deployment

Found by the independent security review of the go-live epic (2026-08-14). **Not
introduced by that epic** — the reviewer confirmed the code is unchanged — but the epic
is what makes it matter, so it is filed now rather than left implicit.

## The gap

`content-store.ts`'s single-entry reference resolution (`resolveSingleReference`, around
`:1706-1743`) loads the referenced entry and embeds its **full `data`** into the
resolving entry's result. It performs **no path-ACL check on the referenced entry**.

So: a user permitted to read entry A, where A has a reference field pointing at entry B,
receives B's content — even when the path rules deny them B.

Reachable through `read()` and `readByUrlPath()` with `resolveReferences` enabled, which
is the default on the read path.

## Why it is worth fixing now rather than later

Three things changed around it in the same epic, and together they remove every
mitigation it was implicitly relying on:

1. **Path ACLs became real.** Listing and tree building are now filtered
   (`listentries-acl-awareness.md`), so path rules stop being decorative. Reference
   resolution is now the one place behind that new layer that does not consult them.
2. **Publish state is branch-only** ([draft-publish-lifecycle.md](draft-publish-lifecycle.md)).
   There is no per-entry draft flag and there never will be, so there is no second
   signal that could independently mark the referenced entry as not-for-this-reader.
3. **Two deployments with multiple editors of differing permission are imminent.** Until
   now every adopter ran fully permissive defaults, so no rule existed for this to
   violate.

The listing path is not affected — `listEntries` never resolves references at all, which
is separately documented as a limitation
([resolved/shared-blocks-listentries-caveat.md](resolved/shared-blocks-listentries-caveat.md)).
That asymmetry is itself worth noting: the same content is filtered when listed and
unfiltered when resolved.

## Fix direction

Check access to the **referenced** entry before embedding its data, using the same
`services.createContentAccessChecker(branchContext, branchRoot, user)` the listing and
tree paths now use — so this does not add a sixth ACL matcher (see
[authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md),
which counts the existing divergence).

The real design question is **what a denied reference should resolve to**, and it should
be decided deliberately rather than fallen into:

- **Unresolved (bare ID)** — matches what `listEntries` already returns for every
  reference, so adopter code that handles the listing case already handles this. Leaks
  the existence of the ID, which the referring entry already contained.
- **Null / omitted** — cleanest for rendering, but a renderer expecting a resolved object
  may crash, and it is indistinguishable from a broken reference.
- **Partial (title/URL only)** — probably what a navigation or "related content" UI
  actually wants, but it is a third shape to specify, type and test.

Also decide whether resolution failure should be visible to the *author* of the
referring entry, who may not understand why their reference renders empty.

## Verification this needs

A test with two users and a path rule denying one of them the referenced entry, asserting
the denied user's `read()` of the referring entry does not contain the referenced entry's
field values. The existing reference-resolution tests all run as a permissive user, which
is why this was never caught.

## Related

- [listentries-acl-awareness.md](resolved/listentries-acl-awareness.md) — the listing
  half, now enforced; this is the same question one layer over
- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
  — reuse an existing matcher, do not add another
- [draft-publish-lifecycle.md](draft-publish-lifecycle.md) — why there is no fallback
  signal
