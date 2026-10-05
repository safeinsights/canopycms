# The listing memo in `context.ts` outlives a request on the build context

## Priority: P3 [BOTH]

Found 2026-10-05 while fixing
[context-read-provisions-requested-branch.md](resolved/context-read-provisions-requested-branch.md).
Reasoned from the code; not reproduced.

## The gap

`resolveListingSource` in `context.ts` memoizes a `ListingSource` (branch root,
flattened schema, path-ACL predicate) per branch for the life of one
`getContext()` result, and its comment calls that memo request-scoped. Two
callers keep one `getContext()` result for the life of the process:
`getCanopyForBuild` in `canopycms-next/src/context-wrapper.ts` (cached in
`buildContextPromise`) and `createBuildCanopy` in `build-canopy.ts`.

Under `next build` and on static deployments that is harmless, because listings
read the checkout. Under `next dev` the build context reads branch workspaces,
so its listings keep:

- the first flattened schema they saw, bypassing `branchSchemaCache`'s own
  invalidation, so a schema edit is not listed until the dev server restarts;
- a rejected promise, if the first provisioning of the active branch failed, so
  every later listing on that context fails too.

The reader was given no memo for the same reason (`resolveBranch` resolves
fresh each call).

## Fix sketch

Either drop the memo (one `branch.json` read and a cached schema lookup per
listing) or forget a rejected promise and key the memo to something that ends
with the request. Then make the comment's claim true.
