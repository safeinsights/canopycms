# Clerk signed-out follow-ups: scaffold default, example app, first live run

New 2026-10-01, left over from
[clerk-no-middleware-signin-gap.md](resolved/clerk-no-middleware-signin-gap.md). The
editor now handles signed-out users itself, so `clerkMiddleware` is optional. Three things
follow from that; the first two are done.

## 1. DONE 2026-10-01: `init --auth clerk` scaffolds the passthrough

JP chose the passthrough. `init` writes the same `middleware.ts.template` for every auth mode,
with `clerkMiddleware` and its two costs as a commented opt-in; `middleware-clerk.ts.template`
is gone, and so is the passthrough's mode-mismatch warning, since one file now serves both modes.

## 2. DONE 2026-10-01: example1 uses the scaffold's passthrough

JP approved. `apps/example1/middleware.ts` is now `middleware.ts.template` verbatim, so the
example app no longer needs `CLERK_SECRET_KEY` for its middleware, matching
`examples/aws-deployment`, which gives the Lambda only `CLERK_JWT_KEY`. example1 has no
server-side Clerk calls (`auth()`, `currentUser()`) that would need the middleware.

## 3. First live run against a real Clerk instance

Everything Clerk-side was verified against `@clerk/clerk-js@6.36.0`'s shipped source and a
mocked `@clerk/nextjs`, never against a live instance. The first deploy of the no-middleware
shape (an adopter's, or deploy-test) should confirm, in a clean browser profile:

1. `/edit` shows Clerk's sign-in, not an error, and signing in mounts the editor without
   leaving `/edit`.
2. After idling the tab for 5+ minutes, returning and saving immediately succeeds. Watch for
   a `POST …/tokens` to Clerk's Frontend API on focus.
3. If that save 401s instead, the sign-in overlay appears over the editor, the edit
   survives, and signing back in lets it save. Then compare `__session`'s `exp` before and
   after focus: unchanged means clerk-js is not writing the cookie at this origin, which
   points at the cross-domain cookie question (editor origin vs Clerk's Frontend API host),
   not at the gate.

The marketing-site adopter gets all of this with no code change once it upgrades: its edit
page already calls `useClerkAuthConfig()`, which now supplies `ClerkSignIn`.

## 4. README's custom-renderers example passes no auth config

README's "Custom Field Renderers" example calls `NextCanopyEditorPage(config.client(),
customRenderers)`, while the page `init` generates passes `useClerkAuthConfig()` or
`useDevAuthConfig()` into `config.client(...)`. Copied as written, the editor gets no account
menu, and a signed-out user sees the gate's plain "Sign in required" notice instead of the
provider's sign-in. That was already true of the account menu; the notice is new only in that
the editor now has a signed-out state at all. Make the example match the generated page.

## 5. A 401 from a request that started before re-auth reopens the overlay

`EditorAuthGate`'s `handleUnauthorized` treats every 401 alike. If a save and two SWR
revalidations 401 together and the user re-authenticates, a late 401 from one of those earlier
requests can arrive after `accepted` and reopen the overlay. It is not a loop: `ClerkSignIn`
remounts, mints a token, re-checks and closes it again in one round trip, and `DevSignIn` needs
one more click. So the cost is a flicker or an extra click, and nothing is lost.

Fix: stamp each request in the generated client (`scripts/generate-client.ts`) with a
monotonic sequence number and pass it to `onUnauthorized`. Have the gate read the client's
counter when a `check` starts, and ignore any 401 whose sequence is lower than the start of
the check that last returned `accepted`. That avoids needing the accepting `whoami`'s own
sequence, which `ApiResponse` does not carry. That changes the generated
client's callback signature, so it wants its own reviewed change, plus a test that reproduces
the late 401.
