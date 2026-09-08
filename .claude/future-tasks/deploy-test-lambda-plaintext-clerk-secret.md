# [P2] `deploy-test` passes `CLERK_SECRET_KEY` to the CMS Lambda in plaintext

Filed 2026-09-08 while fixing the `CLERK_JWT_KEY` classification (adopter request
#37). **The fix is in a different repository**, which is the only reason this is a
task file rather than part of that change.

## Where

`github.com/canopycms/deploy-test` — `infra/bin/app.ts:105-115`:

```ts
// Accepted test deviation: the CMS Lambda has no Secrets-Manager-fetch path
// of its own today (only the EC2 worker does, via CanopyCmsServiceProps'
// secretsArns/*SecretArn props below) - for this deploy test only, these
// two optional Clerk values are passed straight through as plaintext Lambda
// environment variables instead of being fetched from Secrets Manager.
if (deployConfig.clerkJwtKey) {
  environment.CLERK_JWT_KEY = deployConfig.clerkJwtKey
}
if (deployConfig.clerkSecretKey) {
  environment.CLERK_SECRET_KEY = deployConfig.clerkSecretKey
}
```

`CLERK_JWT_KEY` there is correct — it is a public PEM. `CLERK_SECRET_KEY` is not: it
carries full Clerk backend API access, and it lands in the CMS Lambda's environment
where anyone with `lambda:GetFunctionConfiguration` can read it.

## Why it matters more than "it is only a test harness"

`deploy-test` is the reference implementation adopters are pointed at, and it is the
only end-to-end example of the deployment. A deviation there propagates by copying.

The deviation's stated *reason* is also the misconception that adopter request #37 was
filed about: "the CMS Lambda has no Secrets-Manager-fetch path of its own today" frames
an absence as a gap. It is not a gap — the Lambda has no internet access, so it could
not use such a path, and it is designed to need none. `docs/deploying-to-aws.md`'s
Security Model section now states that posture in prose precisely so this inference
stops being available.

## CORRECTION 2026-09-08: do NOT simply drop the passthrough

**An earlier version of this file said "nothing reads it, so removal is
behaviour-preserving." That was wrong, and acting on it would break deploy-test's
editor.** Recorded here rather than silently edited, because the wrong version was
committed and may have been read.

`clerkMiddleware` reads it, and throws without it. Verified against the installed
`@clerk/nextjs@6.39.5`:

- `dist/esm/server/constants.js:7` — `const SECRET_KEY = process.env.CLERK_SECRET_KEY || ''`
- `dist/esm/server/clerkMiddleware.js:62-65` —
  `assertKey(resolvedParams.secretKey || SECRET_KEY || keyless?.secretKey, () => errorThrower.throwMissingSecretKeyError())`
- `dist/esm/server/utils.js:103-108` — `assertKey` calls `onError()` when the key is
  falsy, and `throwMissingSecretKeyError` throws.

So an unset `CLERK_SECRET_KEY` makes an empty string, which is falsy, which throws — per
request, inside middleware. And the shipped
`cli/template-files/middleware-clerk.ts.template` passes only
`{ jwtKey: process.env.CLERK_JWT_KEY }`, with `matcher: ['/edit(.*)', '/api/canopycms(.*)']`
— i.e. every editor route and every API call.

**This inverts the finding.** deploy-test's passthrough is not an "accepted test
deviation" it can drop; on the evidence it is load-bearing, and the comment calling it a
deviation is what is wrong. Meanwhile
`examples/aws-deployment/infrastructure/lib/cms-stack.ts:110-113` passes only
`CLERK_JWT_KEY` under "Lambda environment: public config only, never secrets" — so the
documented reference deployment looks unable to serve an authenticated editor request at
all, and deploy-test works precisely because it deviates.

## The actual decision

Not "remove the passthrough" but "reconcile the security model with the shipped
middleware", which is a real architectural call and not a deploy-test-local cleanup:

1. **Bring `CLERK_SECRET_KEY` into the CMS Lambda** and retract the "no sensitive
   secrets" half of the Security Model. Honest, but gives up the property that makes a
   Lambda compromise survivable, and the Lambda has no internet so it cannot fetch from
   Secrets Manager — it would have to arrive as a plaintext environment variable, exactly
   what request #37 objected to.
2. **Stop using `clerkMiddleware` for gating** and protect those routes with a
   `jwtKey`-only verification path — CanopyCMS already has one
   (`ClerkAuthPlugin.verifyTokenOnly()`, networkless, PEM-only, no secret required). The
   middleware would become a thin check that never constructs a Clerk backend client.
3. **Pass an explicit dummy/derived `secretKey` to `clerkMiddleware`** purely to satisfy
   `assertKey`, if nothing on the middleware path actually calls the backend API. Needs
   proving rather than assuming — `auth.protect()`'s behaviour with a bogus secret is the
   thing to establish.

(2) looks right and is the only one that keeps the documented posture true, but it needs a
deploy to confirm, and it is a change to the shipped template, not to deploy-test.

**Verify before designing:** confirm on a live deploy that an authenticated editor request
against a Lambda with no `CLERK_SECRET_KEY` really does 500. Everything above is read from
the SDK source and the templates; no deploy was run. If it somehow does not throw, find
out why before touching anything, because then one of these readings is wrong.

See also [clerk-middleware-runtime-key-unverified.md](clerk-middleware-runtime-key-unverified.md),
which reached the same `secretKey` requirement from the one-image-per-tier direction.

## Still worth doing regardless

Rewrite deploy-test's comment so it stops citing a "Secrets-Manager-fetch path" the
Lambda is designed not to need, and consider
whether `infra/deploy-config.ts:74-89`'s `console.warn` for a missing `CLERK_JWT_KEY`
should be a hard failure there too — this package's own scaffold
(`cli/template-files/cdk-app.ts.template:63`) uses `required()` and refuses the synth,
because an unset value makes Clerk fall back to a network JWKS fetch that the
internet-less Lambda hangs on.

## Check while there

Whether `deploy-test`'s CloudFront wiring still lists `/assets/t/*` before `/assets/*`
(`infra/bin/app.ts:197-209`). It does today, hand-maintained under an explanatory
comment. Once `AssetSupport.attachTo()` lands it should use that instead, so the
ordering stops depending on that comment surviving future edits.
