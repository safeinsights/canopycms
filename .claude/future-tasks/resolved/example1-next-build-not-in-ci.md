# `apps/example1` is never built in CI — a broken reference app ships green

**RESOLVED** (2026-08-21, branch `fix/example1-build-gate`, epic `adopter-request-intake`) — see
the bottom of this file for what shipped and what was learned closing it.

**Priority:** P2 — no user-facing bug today, but it removes the safety net from the one app every
doc snippet, adopter example and integration pattern is written against
**Found:** 2026-08-21, on `feat/sitemap-path-for-index-entries` (adopter request log #20), while
re-modelling example1's home entry as a root `index` entry

## Problem

CI never runs `next build` for `apps/example1`. `.github/workflows/ci.yml` runs `pnpm run build`
with `working-directory: packages/canopycms`; the other build steps cover the published packages,
`apps/dual-build-fixture`, and `apps/test-app` (e2e). `apps/example1/package.json` stubs its own
test script (`echo "No tests for example app yet"`). What DOES reach the app is static-only:
`pnpm typecheck`, the recursive `pnpm lint` (the app has its own `eslint app/`), and
`prettier --check .`.

So the reference app is protected against type, lint and formatting errors — and nothing that
requires actually running it. Every runtime-only failure
mode is invisible: a route that resolves no content, a `generateStaticParams` that emits nothing, a
sitemap that advertises the wrong URLs, a prerender that quietly falls through to `notFound()`.

## How it showed up

Re-modelling `home` as a root `index` entry changed the on-disk slug, which broke
`app/page.tsx`'s `read({ entryPath: 'content/home' })` — a slugless read defaults the slug to the
entry-type name (`content-store.ts`'s `effectiveSlug = slug || schemaItem.name`), so it looked for
slug `home`, found nothing once the slug became `index`, and `/` rendered the 404 page.

**The build stayed green.** Next prerendered `/` successfully; it just prerendered the not-found
boundary into it. Nothing in CI, and nothing in the build output, distinguishes "prerendered the
home page" from "prerendered a 404 at the home page's URL". It was caught only because the build
was run by hand and the emitted HTML and `sitemap.xml` were read.

That is the same failure class as the sitemap work in this area generally: green, silent, and
wrong.

## Suggested fix

Add an example1 build step to CI. Two parts, the second being the one that carries the value:

1. **Run `pnpm --filter canopycms-example-one build`** (that is the package name — `example1` is
   only the directory, and `--filter example1` matches nothing). Catches hard failures (a throwing build guard, a
   contested URL — `assertNoDuplicateUrlPaths` fails a production build and would otherwise never
   run against this app).
2. **Assert on the OUTPUT, not just the exit code.** A build that succeeds proves very little here.
   The cheap, high-value assertions:
   - `/` prerenders the home entry, not the not-found boundary (grep the emitted `index.html` for a
     known string from `content/home.index.*.json`, e.g. the hero title).
   - the emitted `sitemap.xml` contains `/` and the expected entry URLs, and does NOT contain a
     structural URL no route serves.

   A tiny node script over `.next/server/app/` is enough; this does not need Playwright.

Note the interaction with
[dev-mode-build-reads-branch-clone-not-working-tree.md](../dev-mode-build-reads-branch-clone-not-working-tree.md):
a `mode: 'dev'` build reads the git-committed branch clone, so in CI (a fresh clone of the commit
under test) it reads exactly the committed content — which is what you want here, but it does mean
a local run of the same check needs the content committed first.

## Related

- [../dev-mode-build-reads-branch-clone-not-working-tree.md](../dev-mode-build-reads-branch-clone-not-working-tree.md)
  — why a local build of this app can disagree with the working tree
- [../adopter-request-log-intake.md](../adopter-request-log-intake.md) — item #20, the change that
  surfaced this
- [../example1-typecheck-ts2742-duplicate-next.md](../example1-typecheck-ts2742-duplicate-next.md)
  — the other standing CI gap in this app, still open

## Resolution (2026-08-21)

Shipped as `apps/example1/build-verify.test.ts` (vitest, run via the app's new `verify:build`
script) plus a new path-gated `example1-build` CI job. Both suggested fix parts landed: the app is
now actually built in CI, and the build alone was deliberately NOT trusted — the suite asserts on
the emitted `.next/server/app/index.html` (contains the home entry's real `hero.title`, read from
its content file rather than hardcoded) and `.next/server/app/sitemap.xml.body` (`/` present,
`/home` absent, at least 8 URLs present as a floor against a silently-empty sitemap).

Duplicate-URL collisions were deliberately NOT re-checked with a separate `findDuplicateUrlPaths`
pass, contrary to this file's third option: `app/sitemap.ts`'s `contentSitemap()` call and both
content routes' `generateStaticParams` already run `assertNoDuplicateUrlPaths` during a normal
`next build` (via `collectRoutableEntries`/`collectStaticPaths`), so a real collision already fails
the build outright. Re-running the same check in the test suite would only duplicate a guard the
build itself cannot skip.

Both halves of the historical bug were reproduced and confirmed to turn the new suite red (then
reverted): pointing `readByUrlPath('/')` at a URL nothing answers reproduces the empty-home-page
half; a detached HEAD with a stale local `main` reproduces BOTH halves at once (see below).

**One thing this file did not anticipate, found while proving the gate fails correctly:** this
app is always `mode: 'dev'` (no static-export flavor, unlike `apps/dual-build-fixture`), and dev
mode's base-branch resolution falls back to the literal name `main` whenever HEAD is detached —
which is exactly what `actions/checkout` leaves it as, and this holds for the BUILD-TIME read too,
not only a request-time one. Verified empirically: under a detached HEAD with a pre-existing local
`main` at an older commit, the build silently read `main`'s content instead of the checked-out
commit's, reproducing the empty home page AND the stale `/home` sitemap URL simultaneously — the
exact failure this task exists to catch, but caused by CI plumbing rather than a real regression in
the PR under test. The `example1-build` job therefore attaches HEAD to a real branch pointing at
the checked-out commit before building (`git checkout -B main`), the same fix
`apps/dual-build-fixture`'s CI job already uses for its own CMS-flavor build — that job's comment
claiming only request-time reads need it is correct for its OWN fixture (whose static flavor
short-circuits branch resolution entirely via `isDeployedStatic`), but does not generalize to a
plain `mode: 'dev'` app like this one, whose build-time reads go through the same branch resolution
as its request-time ones.

Placement: a new `example1-build` job, gated the same way `dual-build` is (always runs; the
expensive build+verify step is skipped via per-step `if:` on a `dorny/paths-filter` result scoped
to `apps/example1/**`, `packages/canopycms-next/**`, `packages/canopycms/src/static/**`,
`packages/canopycms/src/build/**`, `packages/canopycms/package.json`, `pnpm-lock.yaml` and the
workflow file). Kept separate from `dual-build` rather than folded into it: the two jobs verify
structurally different things (the static/CMS deploy-shape split vs. this app's content-serving
correctness), and mixing a third `next build` with an unrelated pass/fail meaning into `dual-build`
would make a red result ambiguous about which regression fired.
