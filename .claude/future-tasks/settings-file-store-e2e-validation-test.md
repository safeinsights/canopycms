# groups file store: no test that an invalid mutation result is rejected

**Priority: P3 [BOTH].** Thin glue, low risk.

## Gap

`mutateGroupsFile` parses the mutated payload through the concrete `GroupsFileSchema` before
writing. `permissions-loader.test.ts` covers that path for permissions (real
`mutatePermissionsFile`, invalid payload rejected, nothing written). Groups has no equivalent:
`settings-workspace.test.ts` calls the real `mutateGroupsFile` with a valid payload only, and the
API handler tests (`api/groups.test.ts`) mock the mutator with a non-validating fake. A
schema/mutator drift would surface only at runtime as a 400/500, not in CI.

## Fix

One test in a groups-loader test file: real temp dir, call `mutateGroupsFile` with a mutation the
schema rejects, assert the error surfaces and the file is untouched. Add a valid-mutation case that
round-trips through `loadGroupsFile` with the OCC `version` advanced.

Files: `packages/canopycms/src/authorization/groups/loader.ts`,
`packages/canopycms/src/authorization/__tests__/permissions-loader.test.ts` (the pattern to copy).
