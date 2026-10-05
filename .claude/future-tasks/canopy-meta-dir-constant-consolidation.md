# Consolidate the `.canopy-meta` directory name onto one constant

Noticed 2026-10-04 while adding `CANOPY_META_DIR` to `utils/git.ts`.

## Problem

The directory name is spelled independently in at least seven places: `CANOPY_META_DIR`
(`utils/git.ts`), `BRANCH_META_DIR` (`branch-metadata-file.ts`), private `META_DIR` constants in
`resource-generation.ts` and `utils/content-write-lock.ts`, string literals in
`comment-store.ts`, `schema/schema-store.ts`, `api/branch.ts`, `branch-health.ts` and
`cli/migrate.ts`, and the `'.canopy-meta/'` exclude pattern the operating-mode strategies return.
Nothing checks they agree, and the sync loop's "this is canopycms state" decision depends on them
agreeing.

## Fix

Point every spelling at `CANOPY_META_DIR` (`utils/git.ts` is dependency-light, but check
`pnpm lint:bundle` for any client-reachable importer), and derive the exclude pattern from it.
Pure refactor; no behavior change.
