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

## DONE 2026-09-08. What the upgrade guide said vs what the code does

Both of the two findings that made this look like design work **evaporated on
inspection of the shipped packages**, and this file's earlier revision was
wrong about them because it was written from Clerk's upgrade guide rather than
from the source. Recorded rather than silently deleted, because the wrong
version was committed and pushed.

**`verifyToken` was NOT removed.** The guide's "`verifySecret()` /
`verifyAccessToken()` / `verifyToken()` are replaced by `verify()`" describes
the machine-auth surface. Session-token `verifyToken` is still exported from
`@clerk/backend@3.17.1` (`dist/index.d.ts:7`), and its option set is
**byte-identical** to 2.x's:

```
2.x: apiUrl apiVersion audience authorizedParties clockSkewInMs headerType jwksCacheTtlInMs jwtKey secretKey skipJwksCache
3.x: apiUrl apiVersion audience authorizedParties clockSkewInMs headerType jwksCacheTtlInMs jwtKey secretKey skipJwksCache
```

We use only `jwtKey`, `secretKey` and `authorizedParties`. Zero call-site
changes; the `Parameters<typeof clerkVerifyToken>[1]` typings still resolve.

**`CLERK_ENCRYPTION_KEY` does not reach us.** The throw is
`if (requestData.secretKey && !ENCRYPTION_KEY)` (`server/utils.js:142` in
`@clerk/nextjs@7.9.1`), and `requestData` is `resolvedParams` — the caller's
OWN options object, passed as such at `clerkMiddleware.js:220-227` — not the
env-merged set. Our `middleware-clerk.ts.template` passes only
`{ jwtKey: ... }` and never `secretKey`, so the condition is false.

**Unchanged, and still open elsewhere:** `clerkMiddleware` still requires a
non-empty `secretKey` in 7.x (`clerkMiddleware.js:55-56`, `assertKey`), and
7.x actually **dropped** 6.x's `keyless?.secretKey` fallback, so it is if
anything stricter. The upgrade neither resolves nor worsens
[deploy-test-lambda-plaintext-clerk-secret.md](../deploy-test-lambda-plaintext-clerk-secret.md);
that question is independent and still needs a live deploy to settle.

## Networkless verification, proven by execution

The one thing that genuinely had to be established, run **sandboxed with no
network available** so a JWKS fetch would fail loudly:

```
{ "fetchCalls": 0, "result": "VERIFIED", "sub": "user_probe123",
  "wrongKey": "rejected (correct)" }
```

A locally-generated RS256 keypair, a hand-minted Clerk-shaped session token,
`verifyToken(token, { jwtKey: pem, authorizedParties: [...] })` — verified with
zero `fetch` calls. The negative control (same token, signed with a different
key) was rejected, so the check is real rather than vacuously accepting.

## What actually changed

- `@clerk/nextjs` 6.39.5 -> 7.9.1, `@clerk/backend` 2.33.5 -> 3.17.1 in
  `canopycms-auth-clerk` (dev), `apps/example1` and `apps/dual-build-fixture`.
- Peers widened to `^6.0.0 || ^7.0.0` and `^2.0.0 || ^3.0.0`, AFTER the
  networkless path was proven — an adopter can now choose either major.
- `apps/example1/app/layout.tsx`: `ClerkProvider` moved INSIDE `<body>`. This
  was the only real code change Core 3 required of us; the pre-7.x shape
  wrapped `<html>`. The dual-build fixture's provider is a nested layout and
  was already inside `<body>`.
- `UserButton` needed nothing: `client.ts` passes it as a component reference
  with no props, so losing `afterSignOutUrl`/`signOutUrl` does not touch us.

The dual-build guarantee was **re-established, not assumed**: under 7.x, moving
the provider back to the fixture's root layout still turns the suite red (4
failures, the static build refusing outright with "Server Actions are not
supported with static export").

## Recommended shape (followed; kept for the record)

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

- [clerk-middleware-runtime-key-unverified.md](../clerk-middleware-runtime-key-unverified.md)
  and
  [deploy-test-lambda-plaintext-clerk-secret.md](../deploy-test-lambda-plaintext-clerk-secret.md)
  both turn on `clerkMiddleware`'s key resolution, which is exactly what a
  major bump could change. Whoever takes this should read those first —
  a 7.x upgrade might resolve the `secretKey` question, or make it worse.
