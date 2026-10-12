---
priority: P2
adopters: BOTH
summary: >-
  `GET /branches` awaits the branch owners' profiles before it answers. With `CachingAuthPlugin` that is an in-memory read, but any other auth plugin makes the listing wait on the user directory's API, so a slow directory delays the Branches drawer and the editor's first load. Bound the wait, or answer first and fill names in later.
---

# Branch listing waits on the user directory

`branchListResponse` in `packages/canopycms/src/api/branch.ts` awaits `lookupUserProfiles`
for every listed branch's `createdBy` before responding. `lookupUsersMetadata` in
`packages/canopycms/src/auth/user-metadata-lookup.ts` answers a `CachingAuthPlugin` from its
file-backed cache, but for any other plugin a cache miss calls the plugin's
`getUsersMetadata`/`getUserMetadata`, which for a hosted directory is a network round trip. A
failure already costs only the names; a slow answer costs the whole listing.

## Options

- Race the lookup against a short timeout and return whatever resolved; the editor already
  shows "Name unavailable" for a missing profile.
- Return the listing without names and let the editor fetch owners through the existing user
  lookup.

## Done when

A stalled user directory delays `GET /branches` by at most the chosen bound, with a test that
uses a never-resolving `getUsersMetadata`.
