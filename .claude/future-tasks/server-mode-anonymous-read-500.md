# Anonymous reads on a `deployedAs: 'server'` site render 500, not 401/404

Found during the deployment-test epic (2026-07-23), validating the deploy-test
harness's dev server.

## Symptom

With the default `defaultPathAccess: 'deny'` and no permissions rules, an
anonymous request to a public content page on a server-mode site (e.g. `/` or
`/about` rendered via `getCanopy().read` / `readByUrlPath`) throws
`Error: Forbidden: path access denied (no_rule_match)` (`content-reader.ts:203`)
out of the server component, which Next renders as a **500** error page.

## Why it matters

- The deny-by-default is CORRECT security posture for the CMS deployment
  (public traffic belongs to the static export; the CMS Lambda serves
  authenticated editors). But a 500 misrepresents an authorization condition
  and pages ops for what is expected behavior.
- Adopters running `deployedAs: 'server'` for genuinely public sites will hit
  this immediately and have no documented path: neither `canopycms init` nor
  the docs mention `defaultPathAccess` or how to grant anonymous read.

## Possible directions (decide, don't assume)

1. Page-level guidance: document that server-component reads should catch
   FORBIDDEN and `notFound()` (or redirect to sign-in), possibly with a helper.
2. A first-class "public read" configuration (e.g. `defaultPathAccess: 'allow'`
   scoped to read level only — today `no_rule_match` + `allow` would
   default-allow ALL levels including edit, which is too broad).
3. init template: render a friendlier error boundary.

## Repro

deploy-test repo (canopycms/deploy-test), `npm run dev`, `curl -i
http://localhost:3000/about` → 500 with the FORBIDDEN digest in the dev log.
Authenticated (`x-dev-user-id: <bootstrap admin>`) → 200.
