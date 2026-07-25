# Schema write endpoints load branch context twice per request

## Priority: P2

Surfaced by the protected-base-branch code review (2026-07-24), finding #6. Real
efficiency regression, deferred from the fix pass (findings 1-5 were fixed).

## Problem

The 7 schema-mutation endpoints (create/update/deleteCollection, add/update/
removeEntryType, updateOrder) changed from `guards: ['admin']` to
`guards: ['admin', 'writableBranch']`. Because `admin` contributes no branch
context, `runWritableBranchGuard` (`api/guards.ts`) resolves the branch context
via `ctx.getBranchContext(branch)` — a `branch.json` read (an EFS round-trip in
prod). The handlers then discard that guard-resolved context (they're typed
`_gc: Record<string, never>`) and call `getSchemaOps(ctx, params.branch)`
(`api/schema.ts:~422`), which calls `ctx.getBranchContext` again. There is no
per-request cache to dedupe (`buildContext` wires `getBranchContext` straight to
`loadBranchContext` → `BranchMetadataFileManager.loadOnly` → `fs.readFile`).

Result: each schema write does two branch-metadata reads where it previously did
one.

## Fix sketch

Type the 7 handlers' first param as `{ branchContext: BranchContext }` and pass
the already-resolved context into `getSchemaOps` instead of re-fetching — exactly
how `api/content.ts` and `api/entries.ts` already thread the accumulated context
from the `['schema', 'writableBranch']` chain. `getSchemaOps` needs a small
signature change to accept a pre-resolved `BranchContext`.

## Related

- `api/guards.ts` `resolveBranchContext` / `runWritableBranchGuard`
- `api/schema.ts` `getSchemaOps` and the 7 handlers
- Compare `api/content.ts` `writeContentHandler` (already does this correctly)
