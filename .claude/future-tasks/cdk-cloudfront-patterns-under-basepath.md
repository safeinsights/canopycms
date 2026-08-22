# CloudFront path patterns don't match under a deployment `basePath`

**Status:** Open. **Priority: P3.** Found 2026-08-21 while closing
[assets-basepath-deployments.md](resolved/assets-basepath-deployments.md) — surveying what else a
Next `basePath` breaks turned this up. Degraded behaviour, not breakage, which is why it is P3 and
was not fixed alongside the rest.

## Problem

`canopycms-cdk` attaches CloudFront cache behaviors on literal, root-anchored path patterns. Under
a deployment `basePath` (e.g. `/preview-123`) the request paths gain that prefix and stop matching:

- `packages/canopycms-cdk/src/constructs/cms-distribution.ts` — the `/_next/static/*` behavior.
  Non-matching requests fall through to the default behavior, which is the no-cache policy against
  the Lambda origin. So every hashed static chunk becomes uncached and Lambda-served: it still
  works, but it is slow and it bills per request for content that is immutable by construction.
- `packages/canopycms-cdk/src/constructs/asset-support.ts` — the `/assets/t/*` and `/assets/*`
  behaviors have the same non-match.

## Why it is not urgent

On the AWS topology the asset space does **not** move under a `basePath` — the behaviors are
anchored at the distribution root and the transform Lambda hard-rejects anything not under
`/assets/t/`, which is why the shipped guidance tells adopters to pass **no** `baseUrl` there. So
asset requests keep going to the un-prefixed paths and keep matching. The exposure is the
`/_next/static/*` case, and only for someone running a basePath deployment on this stack — which
nobody does today.

## What to do

Decide whether the constructs should take an optional deployment-prefix option and emit
`{prefix}/_next/static/*` (plus the asset patterns, if the deployment is one where Next serves
them), or whether the supported answer is "one distribution per deployment, mounted at its root".
The second is probably right — a basePath exists to multiplex several builds behind one host, which
is a different shape from one CloudFront distribution per site — in which case this becomes a
documented constraint rather than code.

Check `cms-distribution.ts`'s default behavior first: confirm the fall-through really is the
no-cache Lambda policy before quoting that as the cost.
