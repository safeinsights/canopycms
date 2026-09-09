# [P2] `@clerk/nextjs` is pinned to the 6.x major while 7.x is the active line

Raised 2026-09-08 by the adopter building the SafeInsights site, alongside
request #40. Filed rather than acted on: it is a decision, and a coordinated
two-major bump, not a range widening.

## The facts, as measured

```
$ npm view @clerk/nextjs version
7.9.1
```

- Latest stable: **7.9.1**.
- Latest 6.x: **6.39.6**, published **2026-07-13** — roughly eight weeks before
  this was filed, while 7.x continues to ship.
- `canopycms-auth-clerk` peers on `@clerk/nextjs: ^6.0.0` and
  `@clerk/backend: ^2.0.0`; the lockfile resolves 6.39.5 / 2.x.

So an adopter installing CanopyCMS today gets a major line one behind current,
and plausibly in maintenance.

## Why this is not a one-line range widening

`@clerk/nextjs@7.9.1` declares `@clerk/backend: ^3.17.1`. Our peer is `^2.0.0`.
Upgrading therefore moves **two** majors at once, and the second one lands
squarely on the security-critical surface:

| Package | Our call sites |
| --- | --- |
| `@clerk/backend` | `verifyToken` (`jwt-verifier.ts`, `clerk-plugin.ts`), `createClerkClient` (`clerk-plugin.ts`, `cache-writer.ts`) |
| `@clerk/nextjs` | `useClerk`, `UserButton` (`client.ts`) |
| `@clerk/nextjs/server` | `clerkMiddleware`, `createRouteMatcher` (`middleware-clerk.ts.template`) |

`verifyToken` is the **networkless PEM verification** the entire no-internet
Lambda design depends on. A behaviour change there does not fail loudly at
build time; it fails at sign-in, in production.

The published surface is small — four APIs across two packages — which is the
good news. `apps/example1`'s `SignIn`/`SignUp`/`UserProfile`/`ClerkProvider`
usage is example-app only and does not constrain adopters.

## Why the timing argument is right

The adopter's point, and it is a good one: asking now is far cheaper than a
forced major upgrade once the editor is fronting a live site. A dependency
major is a thing you want to do on a quiet week, not under a running
deployment.

## Core 3 breaking changes, checked 2026-09-08 — these land ON our surface

Read from Clerk's Core 3 upgrade guide. This is what turns the task from a
version bump into a piece of design work:

- **`verifyToken` is gone.** Core 3 consolidates
  `verifySecret()` / `verifyAccessToken()` / `verifyToken()` into a single
  `verify()`. That is our networkless PEM path, used at six call sites across
  `clerk-plugin.ts` and `jwt-verifier.ts` — and two of them type their options
  as `Parameters<typeof clerkVerifyToken>[1]`, so a consolidated signature
  breaks the types as well as the call. Not a find-and-replace: the semantics
  of the merged function have to be established, especially whether a
  `jwtKey`-only call still verifies without network.

- **`clerkMiddleware` now requires `CLERK_ENCRYPTION_KEY` whenever `secretKey`
  is passed.** This makes the open question in
  [deploy-test-lambda-plaintext-clerk-secret.md](deploy-test-lambda-plaintext-clerk-secret.md)
  strictly worse: that thread is about whether one secret has to live on an
  internet-less Lambda that is designed to hold none, and Core 3 would add a
  second. Resolve that question BEFORE upgrading, not after — the answer may
  well decide whether `clerkMiddleware` stays in the shipped template at all,
  which in turn decides how much of this bump we even need.

- **`ClerkProvider` must be inside `<body>`**, not wrapping `<html>`. Affects
  `apps/example1/app/layout.tsx` and the dual-build arrangement proved in
  `apps/dual-build-fixture/app/edit/layout.server.tsx` — so the fixture's
  CI-enforced guarantee has to be re-established under 7.x, not assumed to
  carry over.

- **`UserButton` lost its `afterSignOutUrl` / `signOutUrl` props**, moving to
  `ClerkProvider`'s `afterSignOutUrl` or a separate `SignOutButton`.
  `canopycms-auth-clerk/src/client.ts` ships `UserButton` as the editor's
  `AccountComponent`, so this is adopter-visible sign-out behaviour.

- `enableHandshake` removed (we do not use it).

Compatibility that is NOT a blocker, checked: `@clerk/nextjs@7.9.1` needs Node
`>=20.9.0` (we require `>=22`), `next ^15.5.9` among others (example1 is on
15.5.21), and React `^18.0.0` (we are on 18.3.1).

## Recommended shape

0. **Settle the `clerkMiddleware` secret question first** (see the bullet
   above). Core 3 adds `CLERK_ENCRYPTION_KEY` to it, so upgrading before that
   is decided means designing against a moving target.
1. Port `verifyToken` -> `verify()` and establish, by execution, that a
   `jwtKey`-only call still verifies with no network available.
2. **Exercise the networkless path specifically**: a `jwtKey`-only
   `verifyToken` with no network available. That is the property the AWS
   deployment rests on and the one a major is most likely to move.
3. Only then widen the peers to `^6.0.0 || ^7.0.0` and
   `^2.0.0 || ^3.0.0`, so adopters can choose, and bump the devDependencies to
   the 7.x/3.x line so CI actually exercises the new majors.

Widening the range without step 2 would be worse than leaving it pinned: it
would let an adopter resolve a combination nothing has tested.

## Related

- [clerk-middleware-runtime-key-unverified.md](clerk-middleware-runtime-key-unverified.md)
  and
  [deploy-test-lambda-plaintext-clerk-secret.md](deploy-test-lambda-plaintext-clerk-secret.md)
  both turn on `clerkMiddleware`'s key resolution, which is exactly what a
  major bump could change. Whoever takes this should read those first —
  a 7.x upgrade might resolve the `secretKey` question, or make it worse.
