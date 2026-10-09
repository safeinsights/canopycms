---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-09, from marketing-site request 47. The auth-clerk README ties `useSkipClerkSetActiveAction` to rendering Clerk components; the trigger is any `setActive` with no holder mounted. Restate it by mechanism
---
# `useSkipClerkSetActiveAction`'s README states the wrong condition

**Priority:** P3 [BOTH]. **Found:** marketing-site request 47; still true at `fecc04a0`.

## Problem

`canopycms-auth-clerk/README.md` says the hook "is only for a CMS build that renders `<SignIn>`,
`UserButton` or `OrganizationSwitcher` outside the editor". The trigger is `setActive` itself:
`@clerk/nextjs` runs its cache-invalidation Server Action for every `setActive` intent except sign-out
on Next 15/16, and the hook is a mounted patch, so the real condition is any CMS-build page where
`setActive` can run while no holder is mounted. A missed case hangs with no error.

## Proposal

State the condition by mechanism (a Clerk component, an adopter's own `setActive`, or a sign-in
redirect that lands outside the editor), keep the component list as examples, and say sign-out is
exempt. Open question from the adopter: does a hosted Account Portal return to a CMS-build page call
`setActive` on load there?
