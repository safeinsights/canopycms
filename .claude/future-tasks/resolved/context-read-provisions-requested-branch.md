# Request-scoped `read` provisions a workspace for any requested branch

## RESOLVED 2026-10-05, branch `fix/context-read-no-provision`

**Reproduced first** (`context-read-branch.test.ts`, real workspace layout under
a temporary prod root with only the git clone stubbed): `read({ branch:
'never-created' })` created `content-branches/never-created/` with a
`branch.json`, and did so under `defaultBranchAccess: 'deny'` too, where the read
then failed FORBIDDEN after provisioning.

`read`/`readByUrlPath` now resolve their branch through the same
`resolveBranch` in `context.ts` as the listing methods: the active branch
provisions, any other is load-only, its branch access is checked before its
schema or content is read, and a missing, denied, non-string or traversal name
throws `NOT_FOUND` from `read` (null from `readByUrlPath`). A denied active
branch still throws FORBIDDEN, as before. `createContentReader` now defaults
`allowCreateBranch` to `false`, treats a `getBranchContext` resolver as
authoritative (null is NOT_FOUND), and reads a traversal name as NOT_FOUND.
The package README had told adopters to pass `searchParams.branch` into
`createContentReader` directly, which was the same hole.

`allowCreateBranch` callers: `context.ts` passes a resolver, so the flag does not
apply there; the remaining callers are tests. The editor's provisioning paths
(`api/branch.ts`'s `createBranchHandler`, `http/handler.ts`'s base/active/settings
auto-create, `ai/resolve-branch.ts`'s active branch) never used the reader and
are unchanged.


## Priority: P1 [BOTH]

Found 2026-10-04 while fixing
[context-listing-branch-pinning.md](context-listing-branch-pinning.md).
Reasoned from the code; not reproduced against a deployment.

## The gap

`context.ts` builds the request-scoped reader with
`createContentReader({ services })`, so `allowCreateBranch` takes its default of
`true` (`content-reader.ts:121`). `read`/`readByUrlPath` with a `branch`
therefore resolve it through `loadOrCreateBranchContext` (`:145`). For a name
with no workspace, that calls `BranchWorkspaceManager.openOrCreateBranch`,
which sets up a git workspace and saves branch metadata, invalidating the branch
registry (`branch-workspace.ts:135-146`). `readDocument` runs `resolveStore`
(the provisioning, `content-reader.ts:244`) **before** `checkContentAccess`
(`:295`).

The README's documented page pattern passes `branch: searchParams?.branch`
straight through, so on a public-read `deployedAs: 'server'` site any anonymous
visitor can create a branch workspace on EFS per distinct `?branch=` value.
A traversal name throws `BranchPathError`, which `readByUrlPath` does not
swallow (it catches only `ContentStoreError`), so the page 500s rather than 404s.

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
