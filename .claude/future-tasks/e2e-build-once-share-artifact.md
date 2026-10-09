---
priority: P3
adopters: BOTH
summary: >-
  Each e2e shard pays ~70s of `canopycms-next` + `next build` inside the Playwright webServer command, on top of ~48s setup — so ~2m of every shard's ~3.6m is fixed cost, and it scales with shard count. No prep job or artifact sharing exists in `ci.yml` today. Build once and share the artifact
---
# Build the e2e test app once and share it across shards

**Priority:** P3 — CI latency; no correctness impact
**Measured:** 2026-07-30, run 30589885335

## The number

Each e2e shard spends **~2 minutes before it runs a single test**:

- ~48s of setup/post steps (checkout, node, pnpm install, Playwright browser
  cache, system deps)
- **~70s of `pnpm --filter canopycms-next build && pnpm --filter
  canopycms-test-app build`**, which happens *inside* the Playwright
  `webServer` command and is therefore invisible in the step list — it is
  folded into the "Run E2E tests" step's 184s, of which only ~115s is actual
  test execution.

That build is paid **once per shard**, so it scales the wrong way: raising
sharding 3 → 4 buys ~16s of wall-clock and spends another ~70s of build.

## Why it matters now

The e2e shards are now the floor of PR CI latency: in run 37990964730 the
validate jobs, split and run in parallel, finished at 2.4m, and the four shards
took 3.2–3.7m, plus 0.4m to merge the report. The fixed overhead is the remaining
lever, but a prep job serializes ahead of the shards, so it shortens the critical
path only if each shard's own ~48s of setup overlaps the prep build.

Model that fits the measured data: `wall ≈ 118s + 1.09 × local_test_time`.
Removing the build from each shard would take the constant from ~118s to ~48s —
worth roughly 70s off every shard, which is far more than any resharding.

## Approach

Add a prep job that runs `pnpm --filter canopycms-next build` and
`pnpm --filter canopycms-test-app build` once, uploads `.next` (plus
`canopycms-next/dist`) as an artifact, and have each shard download it and run
only `next start`. Points to get right:

- The Playwright `webServer` command currently does the build inline for both
  the CI and local `E2E_PROD_SERVER=1` paths — keep the local path working
  (it should still build, since there is no prep job locally).
- `canopycms-next/dist` is genuinely required: the test app's `next.config.mjs`
  imports `withCanopy` from `canopycms-next/config`, which ships from `dist/`.
- The prep job serializes ahead of the shards, so it only wins if the artifact
  round trip is cheaper than the ~70s build it replaces. Measure before keeping.
- The existing "Cache Next.js build cache" step already helps; check how much
  of the 70s survives a warm cache before investing.

## Related

Do not raise shard count past 4 to work around this: each shard runs only
37–78s of tests against 60–90s of building and starting the test app, so a
fifth shard adds a full build to save ~15s.
See `apps/test-app/e2e/E2E-FAILURE-ANALYSIS.md` §7 for the earlier measurements.
