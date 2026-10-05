# A static build embeds restricted reference targets in full: "is B public?" has no rules to ask

## Priority: P1 [BOTH] — needs a design decision before code

Split out of [reference-resolution-bypasses-path-acls.md](resolved/reference-resolution-bypasses-path-acls.md)
on 2026-10-05. That file's request-time half shipped on `fix/reference-resolution-acl`: a reader
denied a reference target now gets title + URL tagged `unavailable: true, reason: 'restricted'`
(`RestrictedReference`, entry-schema.ts) from `read()`, `readByUrlPath()`, the opted-in listings,
the editor's content read and the live-preview endpoint. This file is the half it did not ship.

## The gap

JP's 2026-08-15 decision (recorded in the resolved file) says a static build must ask "**is B
public?**", meaning path access evaluated for an anonymous reader, because the build itself reads
as `STATIC_DEPLOY_USER` (full admin) and so passes every check. Today a build and a static
deployment pass no reference predicate at all (content-reader.ts and context.ts skip permissions
in those phases), and the synthetic admin passes every check it is given, so a public page
referencing a restricted entry bakes that entry's full data into public HTML. This is unchanged
by the request-time fix.

## Why it was not done in the same PR

Reasoned from code, not measured: **a build has no path rules to ask.**

- Path permissions live only on the settings branch. Both operating strategies return `true`
  from `usesSeparateSettingsBranch()` (operating-mode/client-unsafe-strategy.ts), and
  `createContentAccessChecker` (authorization/content.ts) loads rules from
  `getSettingsBranchRoot()`, never from the checkout.
- A build reads the checkout at `process.cwd()` and touches no git (`readsFromCheckout`,
  build-mode.ts). A CI checkout of the site repo does not contain the orphan settings branch.
- `getSettingsBranchRoot()` provisions that branch's git workspace. context.ts's
  `resolveListingSourceImpl` comment records why builds deliberately never build the checker: it
  costs a settings-workspace clone and hard-fails where one cannot be provisioned.

So "evaluate as anonymous at build" needs a source of rules first, and each candidate is a
product decision:

1. **The build fetches the settings branch** (read-only clone of `canopycms-settings-<deployment>`
   in CI). Needs git credentials for the settings remote in every site build, and fails the build
   when they are missing, which is the right failure but a new adopter requirement.
2. **A committed snapshot.** The editor writes the effective public-read rules into the content
   repo on publish (or a sync step does), and the build reads that. Adds a second copy of the
   rules that can lag.
3. **Fail closed.** With no rules available, every reference target is treated as not public at
   build. Breaks every existing static adopter's references, so it would need an opt-in.

Whichever is chosen, the check must go through the same `createCheckPathAccess` matcher with
`ANONYMOUS_USER` (see [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)),
not a separate is-this-public path.

## The wider question it raises

The same build also emits restricted entries' **own** pages: `collectStaticPaths` and every build
read run as the synthetic admin, so a page under a read-restricted path is published in full on a
static site. The decision above covers references only. Decide whether a static build should skip
non-public entries entirely, since a restricted reference to an entry whose own page is public
protects nothing.

## Verification this needs

The resolved file's test 2: a static build with a non-public referenced entry, asserting on build
**output** that the HTML carries the title and link but not the restricted body. It must assert on
output, because inside the build everything resolves as admin.

## Related

- [reference-resolution-bypasses-path-acls.md](resolved/reference-resolution-bypasses-path-acls.md)
  — the decision and the request-time half.
- [build-canopy-scripts-outside-next-build.md](build-canopy-scripts-outside-next-build.md) —
  `createBuildCanopy` scripts also read as `STATIC_DEPLOY_USER` and resolve in full.
