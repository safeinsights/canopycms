# Clerk signed-out follow-ups: scaffold default, example app, first live run

New 2026-10-01, left over from
[clerk-no-middleware-signin-gap.md](resolved/clerk-no-middleware-signin-gap.md). The
editor now handles signed-out users itself, so `clerkMiddleware` is optional. Three things
follow from that and are not done.

## 1. Decide what `init --auth clerk` scaffolds (decision for JP)

`init --auth clerk` still writes `middleware-clerk.ts.template`, i.e. `clerkMiddleware`,
which needs `CLERK_SECRET_KEY` in the CMS runtime and throws without it. The deployment this
package documents (`docs/deploying-to-aws.md`) keeps that secret off the Lambda, so the
scaffold's Clerk default is the one shape that does not run on the documented deploy.

- **Recommended: scaffold the passthrough for `--auth clerk` too**, with the template's
  comments offering `clerkMiddleware` as the opt-in edge check. Nothing is lost on
  sign-in UX any more, and it matches the documented posture.
- Or keep `clerkMiddleware` as the default and add an `init` flag for the secret-free shape.

Either way `init.test.ts` pins the generated middleware (`'generates clerk middleware when
authProvider is clerk'`, and the `jwtKey` test), so the change is visible in review.

## 2. The example app and the AWS example disagree

`apps/example1/middleware.ts` adopts `clerkMiddleware` under `CANOPY_AUTH_MODE=clerk`, while
`examples/aws-deployment/infrastructure/lib/cms-stack.ts` gives the Lambda only
`CLERK_JWT_KEY`. [deploy-test-lambda-plaintext-clerk-secret.md](deploy-test-lambda-plaintext-clerk-secret.md)
already noted that this reference deployment looks unable to serve an authenticated editor
request. Moving example1 to the passthrough under Clerk would fix it. That changes the
example app's integration surface, so it needs approval per `CLAUDE.md`; it should follow
whatever item 1 decides.

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
