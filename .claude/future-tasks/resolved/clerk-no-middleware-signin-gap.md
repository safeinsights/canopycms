# Clerk without `clerkMiddleware`: no sign-in surface, and no documented path

**RESOLVED 2026-10-01, branch `feat/editor-signed-out-state`.** Options 1 and 2 below both
shipped, plus a signed-out state for dev auth so the path is exercised without a real Clerk
instance. What remains, including option 3, is in
[clerk-signed-out-followups.md](../clerk-signed-out-followups.md).

- **Editor:** `EditorAuthGate` decides signed-in vs signed-out from the API's 401s. A 401
  before mount shows `editor.SignInComponent` full-screen, and a 401 after mount overlays it
  on the still-mounted editor. The generated API client gained `onUnauthorized`.
- **Clerk:** `useClerkAuthConfig()` supplies `ClerkSignIn`, publishable key only.
- **Dev:** sign-out writes a reserved cookie value that the single resolver
  (`resolve-user.ts`) turns into "no user"; `DevSignIn` is a user picker.
- **Scaffold + docs:** both middleware templates, README "Protect editor routes", and the
  AWS guide now state that `clerkMiddleware` is optional and is the only thing that needs
  `CLERK_SECRET_KEY` in the CMS runtime.

The analysis below is the problem as found, kept as the reference for why.

New 2026-10-01, from a research question about whether Clerk's client-side
sign-in and session maintenance survive without `clerkMiddleware`. Measured
against `@clerk/nextjs@7.9.8`, `@clerk/backend@3.21.0` and `@clerk/clerk-js@6.36.0`
(the last `npm pack`ed — it is **never** in `node_modules`, see below).

## The conflict this package currently ships

CanopyCMS tells adopters two things that cannot both be followed:

1. **Keep the secret off the editor Lambda.** `verifyTokenOnly` /
   `createClerkJwtVerifier` verify networklessly from `jwtKey`, a public PEM;
   the worker holds `CLERK_SECRET_KEY`. This is the stated security model for a
   no-internet Lambda.
2. **Scaffold `clerkMiddleware`.** `canopycms init --auth clerk` emits
   `cli/template-files/middleware-clerk.ts.template`, whose `clerkMiddleware`
   calls `assertKey(secretKey, …)` before any route logic
   (`@clerk/nextjs` `dist/esm/server/clerkMiddleware.js:50-53`). Adopt it and the
   secret must be on the Lambda.

An adopter who follows (1) drops the middleware. Nothing in the package tells
them what else drops with it.

## What actually breaks — and what does not

**Session refresh is fine. This is not the problem.** `__session` is refreshed
entirely browser-side by clerk-js's `AuthCookieService`, with no middleware
involved: a Web-Worker-timer poller (1.5s focused / 5s unfocused, serialized by
a `clerk.lock.refreshSessionToken` Web Lock), a `focus`/`visibilitychange`
handler calling `refreshSessionToken({updateCookieImmediately: true})`, a token
cache that evicts at `exp - 5s` and proactively refreshes at `exp - 17s`, and a
cross-tab `BroadcastChannel("clerk:session_token")`. The middleware's own
refresh (`@clerk/backend` `chunk-JNP6ZZ2T.mjs:7403 attemptRefresh`) needs an
`apiClient` (→ secret key) and exists only to repair server-side `auth()`, which
CanopyCMS never calls.

**Sign-in is the problem, and the cause is `auth.protect()`, not key handling.**
In the scaffolded shape, `clerkMiddleware`'s `auth.protect()` is what redirects
an unauthenticated visitor to a sign-in page. Drop the middleware and:

- nothing redirects, and
- **the package ships no sign-in surface of its own.** A monorepo grep for
  `SignIn|SignedOut|SignedIn|RedirectToSignIn|SignInButton` returns exactly one
  hit — `apps/example1/app/auth/sign-in/[[...sign-in]]/page.tsx`, the example
  app's own route. `useClerkAuthConfig` supplies only `AccountComponent`
  (`UserButton`, which renders nothing when signed out) and `onLogoutClick`.

So `/edit` renders the editor shell, `useUserContext` calls `whoami`, gets 401,
and `setError(...)` puts a message on screen. There is **no 401 handling and no
retry anywhere in the editor** (`api/client.ts` `request()` sets no
`Authorization` header and never inspects status; the `__session` cookie riding
the default `same-origin` credentials mode is the entire auth transport). The
user sees an error with no way to sign in.

`example1` never exercises this, because its `middleware.ts` **does** adopt
`clerkMiddleware` with `auth.protect()`. The no-middleware shape has no in-repo
coverage at all.

## Fix — three options, cheapest first

1. **Docs + scaffold comment (S).** Say in `middleware-clerk.ts.template` and the
   README that `clerkMiddleware` is optional, that dropping it is what keeps the
   secret off the Lambda, and that `auth.protect()` is also the sign-in redirect
   — so an adopter dropping it must supply a sign-in surface. This alone stops
   the next adopter falling in.
2. **A signed-out affordance in the editor (M).** `CanopyClientConfig.editor`
   has `AccountComponent` and `onLogoutClick` but nothing for signed-out. Add a
   `SignedOutComponent` (or have the editor render a supplied fallback when
   `whoami` 401s) so a 401 is a sign-in prompt rather than an error string. This
   is the real package gap: the editor has no signed-out state.
3. **A no-middleware Clerk scaffold variant (M/L).** Emit an edit page wrapping
   the editor in `<SignedOut><SignIn routing="hash" /></SignedOut>` /
   `<SignedIn>`. All of `SignIn`, `SignedIn`, `SignedOut`, `RedirectToSignIn`
   live in `@clerk/nextjs/dist/esm/client-boundary/` — client components, **publishable
   key only, no secret**. Note the dual-build constraint: this must stay inside the
   CMS-only subtree, since `@clerk/nextjs` registers Server Actions and
   `output: 'export'` rejects any reachable Server Action.

(1) and (2) are independent and both worth doing; (3) is a call about how much
of the no-middleware shape this package wants to own.

## Files

- `packages/canopycms/src/cli/template-files/middleware-clerk.ts.template`
- `packages/canopycms-auth-clerk/src/client.ts` (`useClerkAuthConfig`)
- `packages/canopycms/src/editor/hooks/useUserContext.tsx` (401 → `setError`)
- `packages/canopycms/src/api/client.ts` (`request()`, no 401 path)
- Contrast case: `apps/example1/middleware.ts` + `apps/example1/app/auth/sign-in/`
