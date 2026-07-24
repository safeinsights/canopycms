# `/[slug]` dynamic route throws NoFallbackError (500) for unknown slugs instead of 404

## Status: RESOLVED (2026-07-24, server-mode-500-errors branch)

Direction 1 (split the page) shipped, with a `withCanopy()` mechanism to select the
right variant per build automatically:

- `withCanopy(nextConfig, { staticBuild })` in `packages/canopycms-next/src/with-canopy.ts`
  now adds `static.ts`/`static.tsx` to `pageExtensions` when `staticBuild: true` (instead
  of passing `pageExtensions` through unchanged), alongside the existing
  `server.ts`/`server.tsx` behavior for `staticBuild: false`/dev.
- The documented convention (README.md's "Dual-Build Sites" section and
  `docs/deploying-to-aws.md`'s "Dual Build Support" section) is to split a shared
  content route into a plain implementation file plus two thin route variants:
  `page.static.tsx` (re-exports default + `generateStaticParams`, plus
  `dynamicParams = false` as required by `output: 'export'`) and `page.server.tsx`
  (re-exports default only, plus `export const dynamic = 'force-dynamic'` and NO
  `generateStaticParams`, so every request renders at request time and unknown slugs
  hit the page's own `notFound()`). `withCanopy`'s per-build `pageExtensions` makes
  each build see only its own variant.

Two dead ends were verified against the deploy-test harness so nobody retries them:

1. A single shared page with
   `export const dynamicParams = process.env.CANOPY_BUILD !== 'static'` — Next 15.5
   statically parses route-segment config and hard-fails the build ("Unsupported node
   type BinaryExpression" / "Invalid segment configuration export detected") because
   the value isn't a literal.
2. `page.server.tsx` re-exporting `generateStaticParams` with `dynamicParams = true` —
   builds, and eliminates NoFallbackError, but on the production server an unknown
   slug is rendered as on-demand *static* generation, where the request-scoped read's
   `headers()` call throws `DYNAMIC_SERVER_USAGE` (still a 500). Prerendering on the
   CMS build also serves build-time content to anonymous visitors, bypassing runtime
   path ACLs — which is why the server variant prerenders nothing at all.

Original description below.

---

Found during the deployment-test epic (2026-07-24), observed in the deployed CMS
Lambda's CloudWatch logs and locally.

## Symptom

A Next.js `[slug]` route generated for the adopter (dual-build, `output: 'export'`
requires `dynamicParams = false`) throws `Error: Internal: NoFallbackError` from
`.next/server/app/[slug]/page.js` when a path outside `generateStaticParams()` is
requested at runtime on the server (CMS) build. It surfaces as a 500, not a 404.

Repeated entries in the deployed Lambda logs:
```
Error: Internal: NoFallbackError
  at n (.next/server/app/[slug]/page.js:2:1062)
  at responseGenerator (.next/server/app/[slug]/page.js:2:1918)
```

## Root cause

`dynamicParams = false` is mandatory for the static export leg (it forbids
on-demand params), and the same page module is shared by the server/CMS build. On
the server build, an unknown slug then hits Next's no-fallback path → NoFallbackError
→ 500. The page's own `if (!result) return notFound()` is never reached because Next
rejects the request before the component runs.

## Why it matters

- Every adopter using dual-build + a catch-all/[slug] content route inherits this:
  any 404-worthy URL on the CMS deployment returns a 500.
- It's noise in the logs and misrepresents "not found" as "server error" (the same
  category error as the earlier server-mode-anonymous-read finding).

## Possible directions (decide, don't assume)

1. Guidance/template: for dual-build apps, split the page into a `.server.tsx`
   (server build, `dynamicParams` can be true → clean 404s) vs the static export
   variant, or document a catch-all with an explicit not-found.
2. A CanopyCMS helper/wrapper that maps NoFallbackError → `notFound()` for the
   server build.
3. init template: generate the [slug] route in a shape that 404s cleanly in both
   build flavors.

## Repro

deploy-test repo, request any unknown path on the deployed CMS
(https://<cf-domain>/does-not-exist) → 500 with NoFallbackError in the Lambda log;
locally `CANOPY_BUILD=cms npm start` then `curl /nope`. Relates to
[[server-mode-anonymous-read-500]] (both are "content-read edge cases surface as 500").
