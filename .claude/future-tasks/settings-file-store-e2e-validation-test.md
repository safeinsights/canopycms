# settings-file-store: no end-to-end test through the real Zod schemas

Found by the human review of PR #149 (2026-07-24, NIT). Thin glue, low risk.

## Gap

`mutateGroupsFile` / `mutatePermissionsFile` parse the mutated payload through the
concrete `GroupsFileSchema` / `PermissionsFileSchema` before writing, but no test
exercises that path end-to-end: the settings-file-store tests use a synthetic
`TestFile` schema, and the API handler tests mock the mutators with non-validating
fakes. A schema/mutator drift (e.g. a mutator producing a shape the Zod schema
rejects) would surface only at runtime as a 400/500, not in CI.

## Suggested fix

One integration test per file type: real temp dir, call `mutateGroupsFile` /
`mutatePermissionsFile` with a realistic mutation, assert the file round-trips
through `loadGroupsFile` / `loadPermissionsFile` with the OCC `version` advanced;
plus one case asserting an invalid mutation result is rejected (schema error
surfaces, file untouched).

## Where to look

- `packages/canopycms/src/authorization/groups/loader.ts`, `permissions/loader.ts`
- `packages/canopycms/src/authorization/settings-file-store.test.ts` (synthetic TestFile pattern)
