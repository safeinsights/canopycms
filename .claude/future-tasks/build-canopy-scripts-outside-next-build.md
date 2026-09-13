# [P2] Content-reading entry points outside `next build` still read a branch clone

**Priority:** P2 — silent stale reads for whoever hits it; an explicit env var works around it today
**Found:** 2026-09-12, left open by [cms-image-build-epic.md](cms-image-build-epic.md) PR 1
(`fix/build-reads-working-tree`), which made every build-time read come from the working tree.

## Problem

Since PR 1, WHERE content is read is decided by `readsFromCheckout(config)` in
`packages/canopycms/src/build-mode.ts`: `isDeployedStatic(config) || isBuildMode()`, where
`isBuildMode()` is true only under `NEXT_PHASE=phase-production-build` or
`CANOPY_BUILD_MODE=true`. For `deployedAs: 'server'`, three content-reading entry points
normally run with neither set, so they still resolve and provision a branch workspace — in dev
mode a clone under `.canopy-dev/content-branches/`, seeded from git-committed state, and in a
directory without git, an error:

1. **`createBuildCanopy`** (`packages/canopycms/src/build-canopy.ts`). Its doc comment says it
   is for "standalone scripts that run entirely outside a Next.js request or build phase" and
   that it "reads the filesystem directly". It authorizes as `STATIC_DEPLOY_USER`, but its reads
   go through `createCanopyContext` → `loadOrCreateBranchContext`, which reads the checkout only
   when `readsFromCheckout` is true. In a plain `tsx` script against a server config it never
   is, so "reads the filesystem directly" is false there, and `createCanopyServices` also
   detects the active branch from git HEAD in dev mode.
2. **`canopycms generate-ai-content`** (`cli/generate-ai-content.ts` →
   `build/generate-ai-content.ts` → `ai/resolve-branch.ts`'s `resolveBranchRoot`). Same
   predicate, same outcome; in dev mode `resolveBranchRoot` detects the branch from git HEAD.
3. **A content read from `next.config.*`** (for example, computing redirects from content). Next
   loads the config before it sets `NEXT_PHASE` — in 15.5.21 and 16.1.7, `loadConfig(PHASE_PRODUCTION_BUILD, …)`
   runs long before `process.env.NEXT_PHASE` is assigned, immediately ahead of creating the static
   worker — so `isBuildMode()` is false there. The `isBuildMode` JSDoc says so.

The generated `Dockerfile.cms` sets `ENV CANOPY_BUILD_MODE=true` in its builder stage, ahead of the
build command, so inside the image build all three read the working tree. The exposure is everywhere else: local
runs, CI steps, and adopter scripts.

## Decision needed

- **Option A — these entry points always read the checkout.** `createBuildCanopy` and
  `generateAIContentFiles` are build/admin by construction; they could pass an explicit signal
  down (for instance an option on `createCanopyServices` that `readsFromCheckout` honors) rather
  than depend on the environment. Changes behavior for anyone relying on a script reading a
  branch clone today.
- **Option B — document the env var.** Keep behavior; say in README and in both doc comments that
  a script outside `next build` must set `CANOPY_BUILD_MODE=true` to read the working tree.
  Cheapest, and leaves the trap for anyone who doesn't read it.
- Content reads from `next.config.*` are adopter code: at minimum, document the limitation where
  adopters will see it.

Whichever option lands, fix README.md's AI-Ready Content section too ("Sibling files must exist
where the exporter reads"): it says the static build reads your repo checkout, which is true for
`generate-ai-content` only under `deployedAs: 'static'` or `CANOPY_BUILD_MODE=true`.

## Verify

A script calling `createBuildCanopy(serverConfig)` in a dev-mode git repo with an uncommitted
entry: expect it not to list that entry and to create `.canopy-dev` today, and with
`CANOPY_BUILD_MODE=true` to list it and create nothing.
