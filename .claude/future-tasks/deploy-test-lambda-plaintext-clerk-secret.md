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

1. **Bring `CLERK_SECRET_KEY` into the CMS Lambda as a plaintext env var** and retract
   the "no sensitive secrets" half of the Security Model. Honest, but gives up the
   property that makes a Lambda compromise survivable.

1b. **Fetch it at init over a Secrets Manager interface VPC endpoint.** Added 2026-09-09
   after the website adopter pointed out that the objection which killed this option is
   wrong — and it is. The original objection ("the Lambda has no internet so it cannot
   fetch from Secrets Manager") confuses *no internet route* with *no route*. The Lambda
   runs in `PRIVATE_ISOLATED` subnets of the VPC `CanopyCmsService` creates, and a VPC
   endpoint reaches an AWS service from there with no internet at all. **This construct
   already does exactly that**: `cms-service.ts` adds a gateway endpoint for S3
   (`this.vpc.addGatewayEndpoint('S3Endpoint', …)`) precisely because the isolated subnet
   would otherwise have no route to S3 and the Lambda's asset writes would hang. Secrets
   Manager needs the *interface* variety rather than the free gateway one, so it costs an
   hourly rate plus per-GB — a cost argument, not an impossibility.

   This is the only option that makes the documented Security Model **true** rather than
   requiring it to be softened, which is why it is worth the endpoint cost. Note the
   adopter's observation that their request #37 is now on its third version and **version
   one was right**: it was filed as "no fetch path is a gap", retracted on the
   no-internet objection, and re-filed once that objection turned out not to hold.

### 1b is more tractable than first thought, and needs TWO levers

Worked out 2026-09-09 across both sessions. An earlier version of this file called the
module-scope env read "the hard part" and proposed spiking it. **That blocker does not
exist** — the website adopter found the mechanism, and it is a documented public API.

**Lever 1 — `clerkMiddleware` takes an options CALLBACK, awaited per request.**
`@clerk/nextjs@7.9.1`, `dist/types/server/clerkMiddleware.d.ts:33,48`:

```ts
type ClerkMiddlewareOptionsCallback = (req: NextRequest) =>
  ClerkMiddlewareOptions | Promise<ClerkMiddlewareOptions>
(handler: ClerkMiddlewareHandler, options?: ClerkMiddlewareOptionsCallback): NextMiddleware
```

and the implementation awaits it one line above the assertion everyone keeps quoting
(`dist/esm/server/clerkMiddleware.js:50,55-58`):

```js
const resolvedParams = typeof params === "function" ? await params(request2) : params
const secretKey = assertKey(resolvedParams.secretKey || SECRET_KEY, () => ...)
```

`resolvedParams.secretKey` is FIRST in the chain, so a callback value beats the
module-scope constant outright. `secretKey` is properly declared on the option type, not
read opportunistically: `ClerkMiddlewareOptions` -> `AuthenticateRequestOptions` ->
`VerifyTokenOptions` -> `Omit<LoadClerkJWKFromRemoteOptions,'kid'>`, which declares
`secretKey?: string` (`@clerk/backend@3.17.1`, `dist/tokens/keys.d.ts:30`). So the shape
is `clerkMiddleware(handler, async () => ({ jwtKey, secretKey: await getSecret() }))`,
memoizing after first use — a runtime assignment, which is exactly what module-scope
evaluation forbids before and permits after.

**Lever 2 — the plugin needs its own, and already has one.** The options callback reaches
`clerkMiddleware` only. `ClerkAuthPlugin` resolves the secret in a METHOD
(`clerk-plugin.ts:158-168`'s `getSecretKey()`, `this.secretKeyOverride ??
process.env.CLERK_SECRET_KEY`, memoized into `resolvedSecretKey`), and
`secretKeyOverride` comes from the existing `config.secretKey` option
(`clerk-plugin.ts:149`). That method's own doc comment already describes deferral as the
point — "Resolves (and memoizes) the Clerk secret key at first use. Fail-closed."

**Both levers are required.** Landing the middleware half and finding `users.getUser`
still broken is the plausible half-landing, because the two read the secret through
completely separate paths.

### The remaining risk: which runtime runs the middleware

An AWS SDK Secrets Manager call needs the **Node** runtime, and Next middleware defaults
to **edge**, where it is unavailable no matter where it is called from. So 1b depends on
being able to select a Node-runtime middleware.

**You can, and it needs no experimental flag.** Verified in both Next versions this
package supports, because the answer had already been stated wrongly twice:

| | Next 15.5.21 | Next 16.1.7 |
| --- | --- | --- |
| `experimental.nodeMiddleware` typed in `dist/server/config-shared.d.ts` | **absent** | **absent** |
| `loadNodeMiddleware()` gate (`dist/server/next-server.js`) | `NEXT_MINIMAL`, then `functions['/_middleware']` in the build manifest | identical |
| `FunctionsConfigManifest.functions[].runtime` (`dist/build/index.d.ts`) | `runtime?: 'nodejs'` | identical |

The mechanism, the same on both: `middleware.ts` declares
`export const config = { runtime: 'nodejs' }`; the build records
`functions['/_middleware'].runtime` into `FUNCTIONS_CONFIG_MANIFEST`; at runtime
`loadNodeMiddleware()` requires `server/middleware.js` when that entry is present. Stable
declared config, not a flag.

**RETRACTED, and the retraction matters more than the fact.** An earlier version of this
section said the path was "gated behind `experimental.nodeMiddleware`", and escalated a
decision to JP about whether a production editor should depend on an experimental flag.
**That decision does not exist.** The claim came from grepping the identifier
`nodeMiddleware` in `next-server.js`, finding it at `:1145-1146`, and inferring a config
option — but those two lines are a **local variable at the call site inside
`hasMiddleware()`**. The function itself was never opened.

The website adopter caught it, and **their correction needs correcting the same way**: they
framed it as a version split — "real for 15.x adopters, empty for this site" — which is
more generous than the facts. There is no split. It was empty in both, and accepting the
split would have left a false constraint standing for 15.x adopters in this very file.

**Still a reading, not a measurement.** What is established is that the runtime is
selectable by declared config. Nobody has built a Next app with a `runtime: 'nodejs'`
middleware and confirmed the AWS SDK actually loads and reaches a Secrets Manager
interface endpoint from inside a Lambda. That is the build-level check to run before
committing to 1b — and given how this section has gone, run it rather than read it.

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
