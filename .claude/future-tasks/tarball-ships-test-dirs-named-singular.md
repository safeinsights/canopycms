# Two `__test__` (singular) directories ship inside the published tarball

Found 2026-08-20 while resolving
[canopycms-test-utils-export-unbuilt.md](resolved/canopycms-test-utils-export-unbuilt.md),
by listing a real `pnpm pack` tarball. Same defect class as commit `461ef995`
("Fix publish: exclude test files from tarball") — that commit just missed these two.

## What's wrong

`packages/canopycms/tsconfig.build.json` excludes `"**/__tests__/**"` — **plural**. Two
directories in the tree are named `__test__` — **singular** — so the pattern misses them and
their contents are compiled into `dist/` and published:

```
package/dist/api/__test__/mock-client.js       + .d.ts
package/dist/editor/hooks/__test__/test-utils.js + .d.ts
```

Sources: `packages/canopycms/src/api/__test__/mock-client.ts` and
`packages/canopycms/src/editor/hooks/__test__/test-utils.tsx`. Every other test directory in
the package uses the plural form (`src/ai/__tests__`, `src/authorization/__tests__`,
`src/config/__tests__`, `src/config/schemas/__tests__`, `src/operating-mode/__tests__`,
`src/paths/__tests__`, `src/validation/__tests__`), so these two are the outliers.

Impact is limited — neither is reachable through the `exports` map, so no consumer can import
them by subpath — but they are test-only modules taking up space in a published artifact, and
`mock-client.d.ts` exposes internal API-client shapes in the tarball.

## The decision to make

`mock-client.ts` is **generated** by `packages/canopycms/scripts/generate-client.ts` (the
`prebuild` step emits both `client.ts` and `mock-client.ts`), so check whether anything relies
on it being built before deleting it from the build. Two directions:

1. **Rename both directories to the plural `__tests__`** so the existing exclusion catches
   them, matching the other seven. Simplest, and removes the outlier naming.
2. **Add `"**/__test__/**"` to the exclude list** alongside the plural form. Leaves the
   inconsistent naming in place but is a one-line change.

Either way, consider whether the exclusion patterns should be asserted rather than trusted —
the mismatch survived because nothing checks the tarball's contents. A cheap guard would be a
test (or an extension of `scripts/check-esm-imports.mjs`) asserting no `__test__`/`__tests__`
path appears in `pnpm pack`'s file list.
