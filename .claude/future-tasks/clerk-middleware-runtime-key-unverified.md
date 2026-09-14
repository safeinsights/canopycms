# One Docker image for every Clerk tier: supported without `clerkMiddleware`, unproven live

**Status:** Open. **Priority: P2.** Found 2026-09-08 while investigating adopter request #40
(dual-build `<ClerkProvider>` placement). **Shape settled 2026-09-12** by
[cms-image-build-epic.md](resolved/cms-image-build-epic.md) PR 6; what stays open is a live proof.

## The settled shape

`docs/deploying-to-aws.md` documents it under Dual Build Support, "One image for every Clerk
tier":

- `<ClerkProvider publishableKey={process.env.<plain variable>}>` in the editor-subtree
  `layout.server.tsx`. The prop wins over `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
  (`mergeNextClerkPropsWithEnv`: `props.publishableKey || process.env.NEXT_PUBLIC_…`, in both
  `@clerk/nextjs` 6.39.5, at `dist/cjs/utils/mergeNextClerkPropsWithEnv.js:30`, and 7.9.1).
- **`export const dynamic = 'force-dynamic'` in that layout.** The earlier version of this file
  missed this. It called the fixture's read "a genuine per-request runtime read", but the fixture
  passed a constant. Measured 2026-09-12 on Next 15.5.21, with real `next build` + `next start`
  runs and a key set differently at build and at serve: `/edit` prerendered at build (`○`,
  `edit.html` emitted) and served the build-time value both with no segment config and with
  `dynamic` exported from the `'use client'` page. Only `dynamic = 'force-dynamic'` (or
  `await connection()`) in the server-component layout made `/edit` dynamic (`ƒ`) and served the
  run-time value. `apps/dual-build-fixture` now pins it: the builds run without
  `FIXTURE_CLERK_PUBLISHABLE_KEY`, the server starts with it, and the served `/edit` must carry it.
- **No `clerkMiddleware`.** CanopyCMS's own auth on the Lambda doesn't use it:
  `createNextCanopyContext` wraps `ClerkAuthPlugin` in `CachingAuthPlugin`, which calls
  `verifyTokenOnly()` (`CLERK_JWT_KEY` only) and reads users and groups from the worker-refreshed
  cache (`canopycms-next/src/context-wrapper.ts`, `canopycms-auth-clerk/src/clerk-plugin.ts`).
  `middleware-clerk.ts.template` now says the middleware is optional and what it costs.
- The Lambda's `environment` carries `CLERK_JWT_KEY` and the publishable key, both public.

## The middleware path

Keeping `clerkMiddleware` still means one image per Clerk instance and a secret on the Lambda. It
reads the build-inlined `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` unless given explicit keys or an
options callback, and it throws on every matched request without a resolvable `secretKey`
(`@clerk/nextjs` 7.9.1: `dist/esm/server/constants.js:9,11`, `dist/esm/server/clerkMiddleware.js:50-58`;
6.39.5: `dist/esm/server/clerkMiddleware.js:62-65`).
[deploy-test-lambda-plaintext-clerk-secret.md](deploy-test-lambda-plaintext-clerk-secret.md) holds
the options for that path.

The earlier version also flagged a contradiction: the 2026-07 deployment test recorded sign-in
working with "Lambda holds only `CLERK_JWT_KEY`", despite that assertion. The likeliest
explanation is in that file: deploy-test passes `CLERK_SECRET_KEY` to its CMS Lambda as a
plaintext environment variable.

## What remains unverified

Nothing here has run against a real Clerk instance. The first adopter's live deploy of this shape
is the proof. Record the outcome of each:

1. **Sign-in from `/edit` without the middleware.** The browser SDK has to set the `__session`
   cookie on the CMS origin, and the editor's API calls have to carry it. That is Clerk's browser
   behaviour, not code in this repo.
2. **An editor request after the tab idles past the session token's lifetime.** Nothing refreshes
   the cookie server-side, and `verifyTokenOnly()` rejects an expired token, so recovery depends on
   the browser SDK refreshing first.
3. **The per-request read on Next 16.x.** Measured only on 15.5.21.
4. **Sending a signed-out visitor to sign-in.** The scaffold has no gate once the middleware is
   gone, so this is whatever the adopter adds.

## Suggested resolution

When the live deploy reports back, record 1-4 here and update the status sentence in the deploy
doc. Close this file if they pass. If sign-in or idle recovery fails, document the failure mode
there, and decide whether the scaffold should generate a client-side sign-in gate.

## Related

- `docs/deploying-to-aws.md`: Dual Build Support ("One image for every Clerk tier"), Build-time
  client keys, Security Model.
- `packages/canopycms/src/cli/template-files/middleware-clerk.ts.template`
- `apps/dual-build-fixture/app/edit/layout.server.tsx` and `dual-build.test.ts`
