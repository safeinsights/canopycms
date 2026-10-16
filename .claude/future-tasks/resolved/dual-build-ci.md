---
summary: >-
  RESOLVED (2026-07-30, feat/dual-build-ci-safety-net) — `apps/dual-build-fixture` runs real `next build`s for both `CANOPY_BUILD` flavors and `dual-build.test.ts` asserts the static export has zero editor/Mantine code and no CMS-only routes, the cms build has `/edit` + the catch-all API route, and both builds read the same content (verified live via `next start`). Gated `dual-build` CI job added to ci.yml (paths-filter inside the job, not on the workflow trigger, to avoid the required-check-stuck-pending trap). Also surfaced that `canopycms-next`'s `dist/config.{cjs,mjs}` was never built in CI before (no app importing `canopycms-next/config` was `next build`-ed there) — the new job builds it explicitly.
---
# Dual-Build CI Fixture

**Priority: P2** (was ADO-H1 in the July 2026 baseline review — high finding, deferred as bigger design work)

## Problem

The dual-build deploy shape — a public static build (`CANOPY_BUILD=static`, zero editor code) plus a separate editor build — has zero example-app or build-level verification. No app in the repo uses `CANOPY_BUILD` / `.server.ts` exclusion in CI; `init.test.ts` only asserts template *string content*, never runs `next build`. A regression in `withCanopy()`'s pageExtensions exclusion or the `deployedAs` conditionals would ship unnoticed and only surface in an adopter's production build.

## Fix shape

A CI fixture (likely a minimal app or a matrix job on apps/example1) that actually runs `next build` twice — once per deploy shape — and asserts:

- the static build contains no editor chunks (grep the build output for editor entry points / Mantine),
- the editor build serves `/edit`,
- both builds read the same content.

Runtime cost is the concern (two Next builds); consider gating on changes to `canopycms-next`, `cli/template-files`, or the build/static modules.
