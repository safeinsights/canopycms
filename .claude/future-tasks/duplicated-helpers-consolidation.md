# Helpers that exist, and the call sites that reimplement them

## Priority: P2

Found 2026-08-23 by the [baseline structural evaluation](../../docs/reviews/2026-08-structure.md).
All re-verified at `64d804f5`.

The theme the August bug review named — *"when this codebase finds a bug class, the
fix tends to land at the site rather than at the abstraction"* — with the specific
instances that have not been consolidated yet. Two have **already drifted**, which
is what makes this P2 rather than tidying.

## 1. `atomicWriteFile` exists and three modules reimplement it — one weaker

`utils/atomic-write.ts` does mkdir → temp write → rename → unlink-on-failure. Six
modules use it. Three hand-roll it:

- `branch-registry.ts:248-259` — full copy
- `branch-schema-cache.ts:335-346` — full copy, and its own comment says it
  *"matches every other atomic write in the codebase, e.g. `utils/atomic-write.ts`"*,
  i.e. it knowingly restated the helper instead of calling it
- `auth/file-based-auth-cache.ts:238-240` — **weaker**: temp write + rename with
  **no cleanup on failed rename**, so it leaks `.tmp` files the shared helper would not

This is the exact drift signature `utils/url-prefix.ts` documents for the bug it was
created to fix: two copies, one of them wrong. **Fix: 3 call sites**, and
`atomicWriteFile` already does the `mkdir`.

## 2. `permissionPathSchema` is defined twice, byte-identical

`api/validators.ts:146-159` and `authorization/permissions/schema.ts:18-31`. Same
`parsePermissionPath` → `ctx.addIssue` → `z.NEVER` body, same
`as unknown as z.ZodType<PermissionPath>` cast, same "SECURITY: prevents path
traversal" doc. Neither imports the other. **Fix: delete one, import the other.**

While in that file: `api/validators.ts` has **five near-identical branded-schema
wrappers** (`branchNameSchema:52`, `logicalPathSchema:74`, `contentIdSchema:93`,
`slugSchema:117`, `permissionPathSchema:146`) differing only in the `parseX`
function and the target brand. A `brandedSchema(parseFn)` factory collapses ~65
lines to ~15. Also: the JSDoc at `:129-138` is **orphaned** — `branchParamSchema`
was inserted between it and the declaration it describes.

## 3. The settings loaders are copy-paste twins that have already diverged

`authorization/permissions/loader.ts` and `authorization/groups/loader.ts` are
structurally identical, parameterized only by (path resolver, zod schema):

- `loadPermissionsFile:31-54` ↔ `loadGroupsFile:28-45`
- `mutatePermissionsFile:81-99` ↔ `mutateGroupsFile:123-142`

**They already disagree on error behavior for the same failure class**: on a
parse/validation failure (non-ENOENT), permissions logs and throws a wrapped
`Invalid permissions file: …`; groups rethrows raw. Same file kind, same lock
stack, two behaviors.

They also disagree on import spelling for the same module — `import fs from
'node:fs/promises'` vs `import { promises as fs } from 'node:fs'`; the repo-wide
ratio is 96:2 for the former and this is one of the two exceptions.

**Fix:** a `createSettingsFileAccessor({ getPath, schema })` factory yielding
`load`/`mutate`. ~60 lines removed, and one decision about which error behavior is
correct — that decision is the point, not the line count.

## 4. Three slugify implementations that disagree on the same input

- `assets/keys.ts:59-81` — NFKD + strip combining marks + lowercase + `[^a-z0-9]+`→`-`
- `cli/migrate.ts:72-79` `slugifyName` — lowercase + `[^a-z0-9-]+`→`-`, **no diacritic handling**
- `paths/validation.ts:87-93` `sanitizeForPath` — a genuinely different operation
  (fs-unsafe char removal); reasonably separate, leave it

The first two produce the same *shape* but disagree on input: `"Café"` → `cafe` vs
`caf-`. `migrate.ts` then runs its output through `parseSlug` and throws on failure,
so **a migration of accented filenames fails where an asset upload of the same name
succeeds**. Lower urgency than it looks (CLI migrate path only), but it is a real
behavioral fork.

## Related

- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
  — the biggest instance of this theme (five diverging ACL matchers), already filed
- [get-error-message-fallback-overload.md](get-error-message-fallback-overload.md)
