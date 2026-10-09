---
priority: P1
adopters: BOTH
summary: >-
  The editor handles signed-out users itself, so `clerkMiddleware` is optional. Left: the live proof of the no-middleware shape on a real Clerk instance (sign-in from `/edit`, idle-token recovery, the per-request publishable key on Next 16.x; absorbs `clerk-middleware-runtime-key-unverified`), README's custom-renderers example passing no auth config, and a late 401 that can reopen the sign-in overlay once
---
# Clerk signed-out follow-ups: live Clerk proof, README example, late 401

**Priority: P1 [BOTH]** while the live proof is unrecorded.

The editor handles signed-out users itself (`EditorAuthGate` plus the provider's
`SignInComponent`), so `clerkMiddleware` is optional. `canopycms init` scaffolds a passthrough
`middleware.ts` for every auth mode, with `clerkMiddleware` and its costs as a commented opt-in, and
`apps/example1/middleware.ts` is that template verbatim. Three items remain.

## 1. Live proof of the no-middleware Clerk shape

Everything Clerk-side was verified against `@clerk/clerk-js@6.36.0`'s shipped source and a mocked
`@clerk/nextjs`, never against a live instance. A deployed editor on this shape can now provide the
observations; record each outcome here and in the status sentence of `docs/deploying-to-aws.md`
("One image for every Clerk tier"), then close this item. Use a clean browser profile.

The shape under test: `<ClerkProvider publishableKey={process.env.<plain variable>}>` in the
editor-subtree `layout.server.tsx` with `export const dynamic = 'force-dynamic'` (the prop wins over
the build-inlined `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; `apps/dual-build-fixture` pins it on Next
15.5.21); no `clerkMiddleware`; the Lambda carries only `CLERK_JWT_KEY` and the publishable key.

1. **Sign-in from `/edit` without the middleware.** `/edit` shows Clerk's sign-in, not an error,
   and signing in mounts the editor without leaving `/edit`. The browser SDK sets the `__session`
   cookie on the CMS origin and the editor's API calls carry it. DevTools shows **no** POST to
   `/edit` with a `Next-Action` header: the editor skips Clerk's Server Action, which OAC would
   403 ([fix](resolved/clerk-setactive-server-action-oac-hang.md)).
2. **Idle recovery.** After idling the tab for 5+ minutes, returning and saving immediately
   succeeds (watch for a `POST …/tokens` to Clerk's Frontend API on focus). Nothing refreshes the
   cookie server-side and `verifyTokenOnly()` rejects an expired token, so recovery depends on the
   browser SDK refreshing first.
3. **If that save 401s instead,** the sign-in overlay appears over the editor, the edit survives,
   and signing back in lets it save. Then compare `__session`'s `exp` before and after focus:
   unchanged means clerk-js is not writing the cookie at this origin, which points at the
   cross-domain cookie question (editor origin vs Clerk's Frontend API host), not at the gate.
4. **The per-request publishable-key read on Next 16.x.** Measured only on 15.5.21.

If sign-in or idle recovery fails, document the failure mode in the deploy doc and decide whether
the scaffold should generate a client-side sign-in gate.

The middleware path (one image per Clerk instance, a secret on the Lambda) is covered by
[deploy-test-lambda-plaintext-clerk-secret.md](deploy-test-lambda-plaintext-clerk-secret.md).

## 2. README's custom-renderers example passes no auth config

README's "Custom Field Renderers" example calls `NextCanopyEditorPage(config.client(),
customRenderers)` (README.md:1235), while the page `init` generates passes `useClerkAuthConfig()` or
`useDevAuthConfig()` into `config.client(...)`. Copied as written, the editor gets no account menu,
and a signed-out user sees the gate's plain "Sign in required" notice instead of the provider's
sign-in. Make the example match the generated page.

## 3. A 401 from a request that started before re-auth reopens the overlay

`EditorAuthGate`'s `handleUnauthorized` (`editor/EditorAuthGate.tsx`, line 106) treats every 401
alike. If a save and two SWR revalidations 401 together and the user re-authenticates, a late 401
from one of those earlier requests can arrive after `accepted` and reopen the overlay. It is not a
loop: `ClerkSignIn` remounts, mints a token, re-checks and closes in one round trip, and `DevSignIn`
needs one more click. The cost is a flicker or an extra click; nothing is lost.

Fix: stamp each request in the generated client (`scripts/generate-client.ts`) with a monotonic
sequence number and pass it to `onUnauthorized`. Have the gate read the client's counter when a
`check` starts, and ignore any 401 whose sequence is lower than the start of the check that last
returned `accepted`; that avoids needing the accepting `whoami`'s own sequence, which `ApiResponse`
does not carry. That changes the generated client's callback signature, so it wants its own
reviewed change, plus a test that reproduces the late 401.
