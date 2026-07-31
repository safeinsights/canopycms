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
