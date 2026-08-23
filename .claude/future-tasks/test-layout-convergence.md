# Test files live in three layouts, helpers in six homes, and the doc describes the layout 11% use

## Priority: P3 — low risk, and the `paths/` half is a 15-minute fix

Found 2026-08-23 by the [baseline structural evaluation](../../docs/reviews/2026-08-structure.md).

## Problem

`DEVELOPING.md:1673` states: *"Unit tests | `src/**/__tests__/*.test.ts`"*. Actual,
across 249 test files:

| Location | Files | % |
| --- | --- | --- |
| Colocated (sibling to source) | 206 | **83%** |
| `__tests__/` | 27 | 11% |
| `__integration__/` | 16 | 6% |

The documented convention is the one 11% of the suite follows.

Worse, four directories are **mixed**, so there is no local rule either:

- **`paths/` has the same filename in both layouts.** `paths/branch.test.ts` *and*
  `paths/__tests__/branch.test.ts` both exist; `paths/validation.test.ts` (501
  lines) *and* `paths/__tests__/validation.test.ts` (61 lines) both exist. Same
  names, two directories, different functions under test. **Adding a `parseSlug`
  test requires guessing.** Fix this one first regardless of the rest.
- `validation/` — `reference-validator.test.ts` colocated, its five siblings in `__tests__/`
- `authorization/` — two colocated, six in `__tests__/`
- `api/__test__/` and `editor/hooks/__test__/` (singular `__test__`) contain **no
  tests at all** — only `mock-client.ts` and `test-utils.tsx`

## Helpers live in six places

`test-utils/` is the designated home and a package export (`canopycms/test-utils`).
Also holding test helpers: `src/config-test.ts` (test-only, at package root, named
like production code, and matched by `tsconfig.json`'s `include: ["src"]` so it
compiles into `dist`), `paths/test-utils.ts`, `authorization/test-utils.ts`,
`editor/hooks/__test__/test-utils.tsx`, `editor/{test-setup,setup-test-dom}.ts`,
`__integration__/test-utils/` + `fixtures/`,
`operating-mode/deployment-name-fixtures.ts`, and a separate
`canopycms-next/src/test-utils.ts` with no sharing.

Adoption where a shared helper exists is partial: 20 of 25 `api/*.test.ts` use
`test-utils/api-test-helpers`, but **59 test files hand-roll `mkdtemp` workspace
fixtures** despite `git-helpers.initTestRepo` and
`__integration__/test-utils/test-workspace.ts` existing.

## Fix

1. **`paths/` filename collision** — merge the four files into two. Do this alone if
   nothing else here gets done.
2. Pick colocated (it already won 83–11), move the 27 stragglers, and update
   `DEVELOPING.md:1673` to describe reality.
3. Relocate the two helpers out of the empty `__test__/` directories and delete them.
4. Move `config-test.ts` → `test-utils/config.ts` and `createTestCanopyServices`
   (currently in production `services.ts:179`, and published via a wildcard
   re-export) → `test-utils/services.ts`. That also removes both from the published
   surface for free.

## Related

- [test-gap-backfill.md](test-gap-backfill.md) — coverage gaps, as opposed to layout
- [editor-compat-shims.md](editor-compat-shims.md) — mentions `permission-manager/`
  having no tests in-directory
