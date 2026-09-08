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

## Recommended shape

1. Verify the four call sites against `@clerk/nextjs@7.x` + `@clerk/backend@3.x`
   — read both packages' migration notes, then actually run
   `canopycms-auth-clerk`'s suite against the new majors.
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
