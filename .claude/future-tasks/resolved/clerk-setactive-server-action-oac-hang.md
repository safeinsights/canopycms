# Clerk sign-in hangs behind CloudFront OAC: `setActive` awaits a Server Action that 403s

**RESOLVED 2026-10-01, branch `fix/clerk-setactive-oac-hang`: option 1.** The fix is still **not
observed live**. That check is item 3 of
[clerk-signed-out-followups.md](../clerk-signed-out-followups.md).

- **What shipped.** `useSkipClerkSetActiveAction()` (`canopycms-auth-clerk/client`) replaces both
  hook names with an immediate resolve, while any holder is mounted. `useClerkAuthConfig()` and
  `ClerkSignIn` hold it, so the editor needs no adopter change. It is exported for Clerk components
  on an adopter's own CMS-build pages.
- **Why skipping is safe.** Clerk's after-hook is `router.refresh()`, a GET that OAC passes, and
  Next's refresh reducer invalidates the whole router cache, exactly as the action does.
- **Where Clerk drifts, CI fails.** A contract test renders the real installed `@clerk/nextjs`
  provider with a rejecting action. It reproduces the hang, then shows the fix resolving it.
- **What research added.**
  - `@clerk/nextjs` 6.x has the same bug under `window.__unstable__onBeforeSetActive`.
  - 7.9.10 (latest) is byte-identical to 7.9.8.
  - clerk-js 6.37.0 is unchanged.
- **Still open:** adopters' own Server Actions on the CMS build, and proxied-store FormData. See
  [oac-unhashed-body-requests.md](../oac-unhashed-body-requests.md), which holds option 3.

New 2026-10-01. Reported by the website adopter's W5-3 session as SUSPECTED; every link below
was then read from source in this repo's session. **Not yet observed live**: it needs a real Clerk
instance behind the OAC-fronted Lambda to confirm.

## The chain

1. **`@clerk/nextjs` registers a Server Action on every `setActive`.**
   `dist/esm/app-router/client/ClerkProvider.js` (7.9.1 and 7.9.8):
   `window.__internal_onBeforeSetActive = (intent) => new Promise(resolve => { if (Next 15|16 &&
   intent === 'sign-out') resolve(); else void invalidateCacheAction().then(() => resolve()) })`.
   `server-actions.js` is `"use server"` and only deletes a cookie to invalidate Next's client
   router cache. Note there is no `catch`.
2. **clerk-js awaits it before activating the session.** `@clerk/clerk-js` 6.36.0, `setActive`:
   `c?.status!=="pending" && await o(null===c ? "sign-out" : void 0)`. Sign-in and session or org
   switches pass `undefined`, and the session is set active only after (`#tp(c)`).
3. **Next rejects the action on a non-RSC response.** Next 15.5.21 and 16.1.7,
   `server-action-reducer.js` `fetchServerAction`: a response that is neither `text/x-component`
   nor a redirect throws "An unexpected response was received from the server."
4. **The Function URL 403s the action's POST.** Behind `CanopyCmsDistribution`'s OAC
   (`SigningBehavior: always`), any body-carrying request without `x-amz-content-sha256` is
   rejected. See `docs/deploying-to-aws.md`, "CloudFront OAC and request body signing". Next's
   action POST has a body (`[]`) and no such header. CanopyCMS's own client adds it
   (`api/request-body-hash.ts`), which is why editor API calls are fine.

So: the action rejects, `.then(resolve)` never runs, `setActive` hangs, and `isSignedIn` never
flips. The user completes Clerk's form and the sign-in never finishes.

## Reach

- **Hit:** any in-app `setActive`: the embedded `<SignIn>` inside `ClerkSignIn`
  (`packages/canopycms-auth-clerk/src/ClerkSignIn.tsx`), plus account and org switching from
  `UserButton`.
- **Not hit:** sign-out on Next 15/16 (intent `sign-out` resolves immediately; on Next 13/14 it
  runs the action too), and the gate's mid-session path when Clerk is still signed in (`getToken`
  only).
- **Not hit either: a hosted Account Portal sign-in.** On the return trip, clerk-js's
  `updateClient` sets the first session directly, without `setActive`.
- **Not a middleware question.** The POST is rejected at the Function URL before Next.js runs,
  so adopting `clerkMiddleware` (and putting `CLERK_SECRET_KEY` on the Lambda) would not help.
  The no-secret decision stands either way.

## Options (to research and plan, not decided)

1. **Neutralize the hook inside the editor.** Have `canopycms-auth-clerk` replace
   `window.__internal_onBeforeSetActive` with one that resolves even if the action fails, or
   skips it. The editor is client-rendered and reads data from the CMS API, so invalidating
   Next's router cache buys it nothing. Costs: it is a Clerk `__internal_` global, so it couples
   to Clerk versions. And `ClerkProvider` sets the hook in a layout effect, which runs after a
   child's layout effect, so ordering needs care.
2. **Hosted sign-in.** `ClerkSignIn` redirects to Clerk's Account Portal instead of embedding
   `<SignIn>`. The return path does avoid `setActive`, but a full-page redirect loses unsaved
   edits on a mid-session re-sign-in, and `UserButton` switching would still hang.
3. **A payload-hash Lambda@Edge in `canopycms-cdk`.** An origin-request function with body
   access computes `x-amz-content-sha256` before OAC signs. It fixes every body-carrying request
   at once, including adopters' own Server Actions on the CMS build and `FormData` bodies, which
   cannot carry the header today (`uploadProxied` sends one, but only a proxied store routes it
   through OAC; S3 uploads go direct). Costs: Lambda@Edge's latency,
   regions and price, plus deploy complexity. A CloudFront Function cannot do it, because
   functions cannot read bodies.
4. **A provider without Server Actions.** The website session's lead: mount `@clerk/react`'s
   provider for the editor subtree. Unverified that `@clerk/nextjs`'s `SignIn` and `useAuth`
   work under it.

Constraint from the website session: OAC `always` is required on basic-auth tiers. It replaces
the viewer's `Authorization: Basic` with SigV4; `no-override` would forward the Basic header and
the Lambda would reject it.

## Verify first

Reproduce on a real deploy, or a local CloudFront-OAC stand-in if one is cheap: embedded sign-in
on `/edit`, and watch for a POST to `/edit` with a `Next-Action` header returning 403.
