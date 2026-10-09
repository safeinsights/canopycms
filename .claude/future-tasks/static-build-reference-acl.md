---
priority: P3
adopters: BOTH
summary: >-
  **Decided 2026-10-05 (JP): a static build is public by design.** Path read rules govern the editor and request-time reads; merged content, references to restricted entries included, is public in a static build. Kept as a future option, not planned: gate private static pages with something like a Lambda@Edge function or an authorizer in front of the site. It would need the rules (they live on the settings branch, not in the build checkout), an edge-verified identity, and a story for restricted content already embedded in public pages through references
---
# Gate private pages on a static site

## Priority: P3 [BOTH] — future, not planned yet

## Decided 2026-10-05 (JP): a static build is public by design

Path read rules govern the editor and request-time reads (`read()`, `readByUrlPath()`, listings
and the editor API on a `server` deployment). **Merged content is public in a static build**,
including references to entries the rules restrict: the build reads as `STATIC_DEPLOY_USER` and
resolves every reference in full. This follows from
[draft-publish-lifecycle.md](draft-publish-lifecycle.md)'s rule that merged means published.
README's Permission Model section states it.

The request-time half of the reference-ACL fix shipped separately; see
[reference-resolution-bypasses-path-acls.md](resolved/reference-resolution-bypasses-path-acls.md).

## Future: gating private static pages

An adopter who needs some static pages private would put a gate in front of the static site, for
example a Lambda@Edge function or an authorizer that consults the path rules per request. Not
planned. What such a gate would need:

- **The rules.** Path permissions live only on the settings orphan branch
  (`usesSeparateSettingsBranch()` is true in every mode), which a build checkout does not hold. The
  gate would need its own copy, fetched from the settings remote or published alongside the site.
- **A reader identity at the edge.** The same auth the editor uses (Clerk today), verified in the
  gate rather than in a Next.js request.
- **Embedded copies.** A page served publicly still carries its resolved references in full, so
  gating a restricted entry's own page does not hide it from pages that reference it. Either the
  build resolves restricted references to their title + URL (evaluating the rules as anonymous,
  through the same `createCheckPathAccess` matcher with `ANONYMOUS_USER`, see
  [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)), or the
  gate covers the referring pages too.

## Related

- [build-canopy-scripts-outside-next-build.md](build-canopy-scripts-outside-next-build.md) —
  `createBuildCanopy` scripts also read as `STATIC_DEPLOY_USER` and resolve in full.
