# One Docker image serving multiple Clerk instances/tiers is unverified

**Status:** Open. **Priority: P2.** Found 2026-09-08 while investigating adopter request #40
(dual-build `<ClerkProvider>` placement) on branch `docs/clerk-provider-dual-build`.

## Problem

Adopter request #40's second half asked whether `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (baked into
the CMS Docker image at build time via `buildArgs`, per `docs/deploying-to-aws.md`'s "Build-time
client keys") could instead be resolved at runtime, so one image could serve several
tiers/Clerk-instances (dev/staging/prod) instead of one image per tier.

Confirmed (by reading `@clerk/nextjs@6.39.5`'s source, not just its docs):

- `<ClerkProvider publishableKey={...}>`'s explicit prop **does** take precedence over
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (`mergeNextClerkPropsWithEnv`: `props.publishableKey ||
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`). Reading a plain (non-`NEXT_PUBLIC_`-prefixed)
  env var inside a server component and passing it explicitly is a genuine per-request runtime
  read, not build-time-inlined — demonstrated empirically in `apps/dual-build-fixture`'s
  `app/edit/layout.server.tsx`, whose fake key rendered correctly.
- **But** `clerkMiddleware` (used by `middleware-clerk.ts.template` to gate `/edit` and
  `/api/canopycms`) resolves its own `publishableKey`/`secretKey` completely independently —
  there is no shared state between Next middleware and the React render tree. Its shipped
  template only passes `{ jwtKey: process.env.CLERK_JWT_KEY }`, so its `publishableKey` falls
  back to the module-scope `PUBLISHABLE_KEY` constant, which reads the build-time-baked
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. `clerkMiddleware` **does** support a per-request resolver
  (`params` may be a function, called on every request) or explicit `publishableKey`/`secretKey`
  options — so the mechanism to thread a runtime key through exists, but nothing generates or
  documents it today.
- `clerkMiddleware` also unconditionally requires a non-empty `secretKey`
  (`assertKey(resolvedParams.secretKey || SECRET_KEY || ..., throwMissingSecretKeyError)` —
  `throwMissingSecretKeyError(): never`, i.e. it throws, not warns) — `jwtKey` alone does not
  satisfy this call. `CLERK_SECRET_KEY` is deliberately kept out of the CMS Lambda's environment
  today (`packages/canopycms-cdk/src/constructs/cms-service.ts`'s Lambda `environment` block has
  no Clerk secret at all; only `CLERK_JWT_KEY` reaches the Lambda, via
  `examples/aws-deployment/infrastructure/lib/cms-stack.ts`) — see `docs/deploying-to-aws.md`
  Step 6, "The Lambda does NOT need these secrets — only the EC2 worker reads them." Making
  `clerkMiddleware` resolve a real per-tier key would mean also giving it a real `secretKey`,
  which means either bringing `CLERK_SECRET_KEY` into the Lambda (a security-boundary change from
  the current documented model) or confirming `jwtKey`-only verification is sufficient for
  whatever `assertKey` is actually gating in practice.

Not independently investigated here (out of scope for #40, flagged only because it surfaced
while reading `assertKey`'s call site): `.claude/future-tasks/resolved/cms-service-deployment-test.md`
says the 2026-07 deployment-test proved sign-in end-to-end with "Lambda holds only
`CLERK_JWT_KEY` (public)" — which appears to contradict `clerkMiddleware`'s unconditional
`secretKey` assertion as read in the currently-installed `@clerk/nextjs@6.39.5`. Worth resolving
that apparent contradiction (version drift since the July test? a filler `secretKey` value that
was never written down? a misreading of `assertKey`'s call graph?) before touching this.

## Why it was left alone

Adopter request #40 asked for the placement mechanism (proven, documented) and an honest
confidence read on the publishable-key question (documented as unverified) — not a working
multi-tenant implementation, which would need a real Clerk account across at least two instances
and a real two-tier deploy to validate, neither available in this sandbox.

## Suggested resolution

1. First, resolve the `secretKey`-assertion contradiction noted above — it may mean the current
   single-tier-per-image deployment is already relying on undocumented behavior.
2. If runtime per-tier keys are still wanted: extend `middleware-clerk.ts.template` to accept
   (or a new CLI flag to generate) a `params` resolver function reading plain runtime env vars
   for both `publishableKey` and `secretKey`, matching what the provider side already does.
3. Decide, explicitly, whether `CLERK_SECRET_KEY` (or a per-tier equivalent) is allowed onto the
   CMS Lambda, and update `docs/deploying-to-aws.md`'s security model section either way.
4. Only then update `docs/deploying-to-aws.md`'s "publishable key still ships per Docker image"
   paragraph (added alongside this file) to describe a verified mechanism instead of an
   unverified one.

## Related

- `docs/deploying-to-aws.md` — Dual Build Support section, "The publishable key still ships per
  Docker image, not per request" paragraph.
- `packages/canopycms/src/cli/template-files/middleware-clerk.ts.template`
- `packages/canopycms-auth-clerk/src/clerk-plugin.ts` — `ClerkAuthPlugin.getSecretKey()` already
  reads `CLERK_SECRET_KEY` genuinely at runtime (memoized on first use); this is CanopyCMS's own
  auth plugin used inside `/api/canopycms`, separate from Next's `clerkMiddleware` gate discussed
  here.
- `packages/canopycms-cdk/src/constructs/cms-service.ts` — the CMS Lambda's `environment` block.
- `apps/dual-build-fixture/app/edit/layout.server.tsx` — the empirical fixture proving the
  provider-side precedence.
