# Anonymous reads on a `deployedAs: 'server'` site render 500, not 401/404

## Status: RESOLVED (2026-07-24, server-mode-500-errors branch)

Fixed by two changes:

1. `defaultPathAccess` now accepts a level-scoped object form
   (`{ read?: 'allow' | 'deny', edit?: ..., review?: ... }` — see
   `packages/canopycms/src/config/types.ts`'s `DefaultPathAccessLevels`, resolved by
   `resolveDefaultPathAccess` in `packages/canopycms/src/authorization/path.ts`), so an
   adopter can set `defaultPathAccess: { read: 'allow' }` for public read without
   opening edit/review (option 2 from this file's "possible directions").
2. `CanopyBuildContext.readByUrlPath` (`packages/canopycms/src/context.ts`) now swallows
   a `FORBIDDEN` `ContentStoreError` from a candidate read and returns `null`, same as a
   lookup miss, so the adopter's existing `if (!result) return notFound()` produces a
   404 instead of an unhandled 500 (option 1). The denial reason is emitted via the
   module's debug logger (`CANOPYCMS_DEBUG=true`). The strict `read()` API is
   unaffected and still throws on FORBIDDEN — this only applies to the
   URL-path-resolving helper most page code uses.

Documented in README.md's Permission Model section ("Public read on server
deployments") and the `defaultPathAccess` config table row, plus
`docs/deploying-to-aws.md`'s Dual Build Support section.

Original description below.

---

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
