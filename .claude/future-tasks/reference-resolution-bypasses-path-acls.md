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

### DECIDED 2026-08-15 by JP: a denied reference resolves to **title + URL, tagged**

The options considered were a bare ID, null/omitted, or a partial value. Partial wins,
and the reasoning is specific to what CanopyCMS is for: **mostly-public static sites.**

The motivating case is a public page linking to restricted content. An anonymous reader
of that page still needs to see *what they are being linked to* — clicking through to a
sign-in page is a fine outcome; a link that renders as nothing is not. A bare ID cannot
be rendered, and null is indistinguishable from a broken reference.

Two refinements on top of the bare decision:

**Tag the partial.** A partial value that is shape-indistinguishable from a full one
makes a renderer reading `data.body` receive `undefined` and emit a half-empty card with
no explanation — the silent-nothing failure mode this backlog keeps rediscovering. Carry
an explicit marker (`restricted: true` or equivalent) so a renderer can deliberately show
a lock, a sign-in prompt, or skip the block. That marker also answers the open question
about author visibility: the editor can surface "this reference resolves to a restricted
entry" from the same signal.

The primitives already exist: `resolveEntryTitle` (`utils/title-field.ts:60`, exported
from `canopycms/server` and the root entry since the go-live epic) and `computeEntryUrl`
(`utils/entry-url.ts:23`).

**The static case asks a different question, and it is the more dangerous one.** A static
build resolves as `STATIC_DEPLOY_USER` — full admin (`canopycms-next/src/context-wrapper.ts:388`).
So on a static export no ACL fires at build, and a public page referencing restricted
content embeds that content **in full, into public HTML**. For the deployment shape this
package mostly serves, the exposure is not "a denied reader sees too little" but "the
build bakes restricted content into a public artifact and nothing ever checks."

Therefore the check cannot be "can *this reader* see B?", because at build time the
reader is an admin. For a static build it must be "**is B public?**" — path access
evaluated against anonymous, not against the build identity. Same partial shape, a
different question asked, selected by phase. Getting this wrong in the obvious direction
(checking the build user) produces a system that looks correct in tests and leaks in
production.

## Verification this needs

Three tests, because the decision above has three distinct failure modes:

1. **Server mode, denied reader.** Two users and a path rule denying one of them the
   referenced entry; assert the denied user's `read()` of the referring entry carries
   title, URL and the restricted marker — and none of the referenced entry's other field
   values. The existing reference-resolution tests all run as a permissive user, which is
   why this was never caught.
2. **Static build, non-public referenced entry.** Assert the emitted HTML contains the
   title and link but not the restricted body. This is the test that would catch the
   check being wired to the build user instead of anonymous — and it has to assert on
   build *output*, because at that layer everything resolves.
3. **The unrestricted path is unchanged.** A public reference still resolves fully; the
   marker is absent. Otherwise this quietly becomes a breaking change for every existing
   adopter.

## Related — and what the decision above means for each

- [listentries-acl-awareness.md](resolved/listentries-acl-awareness.md) — the listing
  half, already enforced. **No security interaction, despite appearances.** An earlier
  draft of this file claimed the decision let a *denied* reference carry more information
  through `read()` than a *permitted* one does through `listEntries()`. That compared
  across two APIs answering different questions, and it is not a meaningful ordering.
  Within each API the behaviour is monotonic and correct: `read()` gives full data when
  permitted and title+URL when denied; `listEntries()` gives a bare ID to everyone,
  because it does not resolve references at all — not because of any access decision.
  **Nobody gains by being denied**, which is the only property that would matter.

  What is real is a shape inconsistency an adopter will notice: navigation built from
  `listEntries` must resolve titles itself, while the same field arrives resolved through
  `read`. That predates this decision and is documented as the shared-blocks caveat below.
- [resolved/shared-blocks-listentries-caveat.md](resolved/shared-blocks-listentries-caveat.md)
  — the same shape inconsistency from the other side, and **the one forward constraint
  worth carrying**: if `listEntries` ever gains reference resolution, it inherits this
  decision wholesale, including the phase-dependent question — "is B public?" at build,
  "can this reader see B?" at request. Implementing it with the request-time question
  only would pass every test and leak in a static build.
- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
  — reuse `createContentAccessChecker`; do not add a sixth matcher. **The static case
  needs care here:** "evaluate against anonymous" must go through the same matcher with
  an anonymous principal, not a separate is-this-public code path, or the count goes to
  six after all.
- [draft-publish-lifecycle.md](draft-publish-lifecycle.md) — why there is no fallback
  signal. **The decision softens this:** a tagged partial *is* graceful degradation, so
  the absence of a per-entry publish flag stops being the only thing standing between a
  denied reader and a blank render. It does not remove the reason this file is P1 — the
  full-data leak is still a leak — but it means the fix does not depend on a draft
  concept ever existing.
  signal
