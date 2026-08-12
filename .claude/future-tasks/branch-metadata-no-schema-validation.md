# `branch.json` is parsed with a bare cast — no schema validation anywhere

## Priority: P2

Raised by the independent adversarial review of PR #189 (2026-08-12) as a
pre-existing gap, after that PR had to add a fail-closed clause specifically to
survive it.

## Problem

`branch-metadata.ts` reads branch metadata as:

```ts
return JSON.parse(raw) as BranchMetadataFile   // :112, and again at :139
```

There is no Zod schema for `BranchMetadata` anywhere in the package — unlike
config, API bodies, and entry content, which are all validated. So the types on
`BranchMetadata` (`status: BranchStatus`, `name: string`, `access`, `createdBy`)
are compile-time fiction with respect to what is actually on disk. Any field can
be missing, null, or the wrong type at runtime, and nothing notices at the parse
boundary.

This is not hypothetical: the corrupt-metadata quarantine (#150) and the
branch-health scan exist precisely because malformed `branch.json` happens on
EFS. Those handle *unparseable* JSON. They do not handle JSON that parses but is
structurally wrong, which flows onward as a well-typed lie.

Concrete consequence already paid for: `getBranchWriteProtection` takes `status`
as a **required** parameter typed to admit `undefined`, purely so a missing
status fails closed rather than silently unlocking a branch. That workaround is
correct but local — every other consumer of branch metadata still trusts the
cast.

## Fix sketch

Add a Zod schema for `BranchMetadataFile` and parse through it in
`BranchMetadataFileManager.loadOnly` / the read used by `getBranchContext`.
Decide the failure mode deliberately, and note it interacts with quarantine:

- Reject → the branch is quarantined like unparseable JSON. Coherent with #150,
  but a single bad optional field takes a branch offline.
- Repair-with-defaults → log loudly and fill known-safe values. Risky for
  `status` specifically (defaulting to `editing` would unlock a branch under
  review — the exact failure #189 closed), so `status` should reject even if
  other fields repair.

Prefer strict rejection for the authorization-relevant fields (`status`,
`access`, `createdBy`) and tolerance for cosmetic ones (`title`,
`description`).

Once this lands, `getBranchWriteProtection`'s required-`undefined` parameter can
be revisited — though keeping a fail-closed default is cheap insurance.

## Files

- `packages/canopycms/src/branch-metadata.ts:112`, `:139`
- `packages/canopycms/src/types.ts` (`BranchMetadata`, `BranchMetadataFile`)
- `packages/canopycms/src/authorization/protected-branch.ts`
  (`getBranchWriteProtection`'s fail-closed clause and its rationale)

## Related

- [[submitted-branch-edit-locking]] (resolved) — added the fail-closed clause
- [[approved-status-dead-end]] — the other status-model gap from the same review
