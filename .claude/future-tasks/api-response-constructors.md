# `api/` has 230 hand-written response literals and no response constructors

## Priority: P2

Found 2026-08-23 by the [baseline structural evaluation](../../docs/reviews/2026-08-structure.md).

## Problem

Across the 17 non-test `api/*.ts` files: **230 `{ ok: false, ... }` literals, 67
`{ ok: true, ... }` literals, 253 inline `status: NNN` numbers.** There is exactly
one response helper in the codebase (`http/types.ts:74 jsonResponse`) and it is a
transport-layer wrapper, not an API-result constructor.

So there is no single place to change what a 500 looks like on the wire. Adding a
`code` field, changing sanitization, or adding structured `fieldErrors` is a
230-edit change, and every new endpoint is written by copying an existing one.

Concrete repeated blocks:

- **catch → 500 ladder, 19 verbatim copies** of
  `{ ok: false, status: 500, error: sanitizeErrorMessage(getErrorMessage(error)) }`
  — `api/schema.ts` ×8, `api/permissions.ts` ×5, `api/groups.ts` ×3,
  `api/branch.ts` ×2, `api/content.ts` ×1
- **`SchemaStoreBusyError` → 409, 6 verbatim copies** in `api/schema.ts:484-486,
  525-527, 565-567, 606-608, 658-660, 698-700`
- **Settings conflict → 409, 2 verbatim copies**: `api/permissions.ts:162-168` and
  `api/groups.ts:282-288`
- **Inside the guard system itself**: `api/guards.ts:141-149` and `:180-188` are the
  identical `checkBranchAccess → 403` block

## The consistency this hides

`sanitizeErrorMessage` — which exists specifically to strip absolute filesystem
paths and embedded git credentials before a message reaches a client — is applied
to **25 of 39** API error responses. The other **14 return `getErrorMessage(err)`
raw**: `api/admin-branch-health.ts:184,292,320,331,434,463`;
`api/admin.ts:255,283,318,362`; `api/branch.ts:416,427,700`; `api/entries.ts:500`.

`api/branch.ts` is internally inconsistent — it imports `sanitizeErrorMessage` at
line 13 and uses it in some paths while returning raw messages at three others.

Prior reviews covered the security angle. This is the "which convention applies"
angle: the reason for the split is invisible, so the next handler author has a
coin-flip chance of picking wrong.

## Fix

`api/responses.ts` with `ok(data)`, `err(status, message)`, and a
`mapKnownErrors(err)` ladder covering the busy/conflict/version cases. Sanitize by
default inside `err()`, which fixes the 14 unsanitized sites for free. Then a
mechanical sweep.

Also fold in the two guard-internal duplications: `runBranchGuard` and
`runBranchAccessGuard` hand-roll
`accumulated.branchContext ?? await ctx.getBranchContext(branch)` while the two
schema guards correctly route through `resolveBranchContext`.

## Related

- [route-registry-parity-test.md](route-registry-parity-test.md) — the other
  api-layer structural gap found in the same pass
