# The editor's asset mount point is inferred, and the inference is wrong on CloudFront

**Status:** Open. **Priority: P3.** Found 2026-08-21 by the second independent review pass on
PR #261, which shipped the inference being questioned here. Not a 404 and not a correctness bug —
a silent cost/latency regression on one topology — but it contradicts the model that same PR
documents, so it should be settled deliberately rather than left as a guess.

## Problem

`editor/context/AssetContext.tsx`'s `AssetContextProvider` resolves the editor's asset mount point
as `baseUrl ?? basePath` — `media.publicBaseUrl` if set, otherwise the deployment `basePath`. The
fallback is unconditional and consults no topology.

But PR #261's whole thesis is that whether a Next `basePath` moves the **asset** URL space is
topology-dependent:

- **Next serves `/assets`** (local/lfs adapter, `next dev`, S3 with no distribution) — the
  `withCanopy` rewrite is auto-prefixed, so the basePath applies. The fallback is right here.
- **CloudFront via `canopycms-cdk`'s `AssetSupport`** — behaviors are anchored at the distribution
  root and the transform Lambda rejects anything outside the transform prefix, so a basePath does
  **not** move the asset space. The fallback is wrong here.

The READMEs tell adopters exactly this, including "do not derive `baseUrl` from `next.config`'s
`basePath` unconditionally — on the AWS topology that breaks working URLs." The editor now does
precisely that.

## Why it is only P3

Traced by the review: on CloudFront + basePath + no `publicBaseUrl`, an editor thumbnail requests
`/{prefix}/assets/t/…`, misses both root-anchored CloudFront behaviors, falls through to the default
behavior (the CMS Lambda), and is then caught by `withCanopy`'s auto-prefixed `/assets/:path*`
rewrite, which serves it from the asset store. **The images render.** What is lost is everything the
CDN behaviors exist for: cache hits, the S3 direct read, and the origin-group failover to the
dedicated transform Lambda. Every editor thumbnail becomes a Lambda invocation.

There is also a real, undocumented workaround: `media.publicBaseUrl` accepts any absolute URL and
takes precedence, so setting it to the distribution origin defeats the fallback.

## Options

1. **Relax `media.publicBaseUrl`'s validation** (`config/schemas/media.ts`, currently
   `z.string().url()`) to accept an absolute URL **or** a leading-slash path, and drop the
   `basePath` fallback entirely. The absolute-only constraint the fallback exists to work around is
   a validation *choice*, not a law. This is the option most consistent with the PR's own "one
   prefix concept, stated per topology" thesis: one knob, one rule, no inference. The reviewer's
   recommendation.
2. **Keep the fallback, make its assumption explicit** — done in-code as of the PR; add a fourth
   row to the README mount table for "editor under a basePath on CloudFront → set
   `media.publicBaseUrl` to your distribution origin". Cheap, but leaves a wrong default on a
   documented topology.
3. **A boolean** like `media.assetsFollowBasePath`. Not recommended — a third name in a space where
   `basePath` collisions are already this work's stated trap.

Option 1 is the recommendation. It is a small change to adopter-facing validation, which is why it
was not taken unilaterally inside PR #261.

## Update 2026-09-10 — option 1's validation half is DONE; only the behaviour half is left

Adopter request #44 needed the same "absolute URL **or** a leading-slash path" shape for a new
write-side field (`media.uploadUrl`), so the predicate was built once and shared rather than
twice. `media.publicBaseUrl` now uses `assetMountUrlSchema`
(`config/schemas/url.ts`, over `isHttpUrlOrSameOriginPath` in `utils/sanitize-href.ts`) and
**accepts a site-relative path today**. It also now rejects non-http(s) schemes, which the old
`z.string().url()` allowed.

So the constraint this task was written around is gone, and what remains of option 1 is only its
second half: **dropping the `baseUrl ?? basePath` fallback** in
`editor/context/AssetContext.tsx`. That is a one-line change plus its test, and the doc comment
there has been rewritten to say the fallback is now kept purely so existing basePath deployments
do not break on upgrade — not because `publicBaseUrl` cannot express a path.

That makes this a straight behaviour decision with no validation work attached: removing the
fallback means an adopter on a `basePath` deployment with no `publicBaseUrl` set loses the
inferred mount point and must state it. Worth pairing with a migration note telling them to set
`publicBaseUrl` to their `basePath`. Options 2 and 3 are unchanged and still not recommended.
