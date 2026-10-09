---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-08, from PR #428's claim check, unreproduced. The opt-in `auth.protect()` snippet in example1's middleware and the init template reportedly answers a signed-out API call 404, so a lapsed session shows an error instead of the sign-in overlay and `unauthenticatedStatus` does not apply. Reproduce, then keep the API routes out of the snippet's matcher
---
# The opt-in `auth.protect()` middleware answers a signed-out API call 404

## Priority: P3 [BOTH]

## The gap

`apps/example1/middleware.ts` and `cli/template-files/middleware.ts.template` carry an opt-in,
commented-out `clerkMiddleware` / `auth.protect()` snippet. Reported from `@clerk/nextjs` 7.9.1's
source (`protect.js`, `clerkMiddleware.js`), not yet reproduced: for a signed-out request that is
not a page navigation, `auth.protect()` calls `notFound()`, which the middleware turns into a
rewrite to a missing route, so the API answers **404** before the CMS handler runs.

That 404 is neither HTTP 401 nor an ApiResponse body saying 401, so the API client never fires
`onUnauthorized`: an editor whose session lapses mid-edit sees an error rather than the sign-in
overlay, and `unauthenticatedStatus` does not apply to these calls.

## Suggested shape

First reproduce it against the installed Clerk version. If it holds, either exclude
`/api/canopycms/*` from the snippet's matcher (the handler already authenticates every API
request), or say in the snippet that it must not cover the API routes.
