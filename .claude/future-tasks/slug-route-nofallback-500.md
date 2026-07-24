# `/[slug]` dynamic route throws NoFallbackError (500) for unknown slugs instead of 404

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
