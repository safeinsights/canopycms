# Request-scoped `read` provisions a workspace for any requested branch

## Priority: P1 [BOTH]

Found 2026-10-04 while fixing
[context-listing-branch-pinning.md](resolved/context-listing-branch-pinning.md).
Reasoned from the code; not reproduced against a deployment.

## The gap

`context.ts` builds the request-scoped reader with
`createContentReader({ services })`, so `allowCreateBranch` takes its default of
`true` (`content-reader.ts`). `read`/`readByUrlPath` with a `branch` therefore
resolve it through `loadOrCreateBranchContext`. For a name with no workspace,
that calls `BranchWorkspaceManager.openOrCreateBranch`: a clone, branch
metadata and a registry entry. `readDocument` runs `resolveStore` (the
provisioning) **before** `checkContentAccess`.

The README's documented page pattern passes `branch: searchParams?.branch`
straight through, so on a public-read `deployedAs: 'server'` site any anonymous
visitor can create a branch workspace on EFS per distinct `?branch=` value.
A traversal name throws `BranchPathError` (a 500, not a 404).

## Fix sketch

Do what the listing methods now do (`loadExistingBranch` in `context.ts`):
a requested branch other than the active one is load-only, a missing or
traversal name reads as not-found (null from `readByUrlPath`, `NOT_FOUND` from
`read`), and branch access is checked before the branch's files are read.
Probably `allowCreateBranch: false` plus a `getBranchContext` that provisions
only the active branch. Check that no editor or API path relies on page-side
reads provisioning a branch. The editor API has its own reader.

## Acceptance

- `read({ branch: 'never-created' })` on the request-scoped context creates no
  workspace and throws `NOT_FOUND`; `readByUrlPath` returns null.
- `read({ branch: '../x' })` does not 500 from `readByUrlPath`.
- The active branch still provisions on first read.
