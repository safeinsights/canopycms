# [P3] knip guard: what `pnpm lint:exports` cannot see

**Status:** Open. Filed 2026-09-14 from the manager's review of the Chip B encapsulation PR in
[baseline-quality-202609.md](resolved/baseline-quality-202609.md). Sibling of
[comment-guard-scope-gaps.md](comment-guard-scope-gaps.md).

`knip.json` judges unused-ness at the declaration site only:

- `ignore` covers `src/**/index.{ts,tsx}` and the two editor re-export shims
  (`editor/GroupManager.tsx`, `editor/PermissionManager.tsx`, tracked in
  [editor-compat-shims.md](editor-compat-shims.md)). A dead barrel specifier or a dead
  re-export line, the class the chip removed 49 of by hand, is never reported again. Without
  the exclusion every unused symbol was reported twice (origin and barrel) and 92 test-only
  barrel paths, including the generated `api/__test__/mock-client.ts`, would have needed
  rewriting.
- `config/index.ts` and `authorization/groups/index.ts` are declared entries because the
  package entrypoints star-export them and knip follows an entry's `export *` only one hop.
  Their own dead re-exports are invisible for the same reason.
- `include` is exports and types only: unused files and unused dependencies are not checked.

Related, pre-existing: `api/index.ts` value-exports `USER_ROUTES`, which makes `api/user.ts`
client-reachable; only `pnpm lint:bundle` holds that edge.

Fix shape: a second, non-gating knip run without the barrel exclusion, or a small script that
lists barrel specifiers nobody imports; widen `include` once the unused-file and
unused-dependency reports are triaged.
