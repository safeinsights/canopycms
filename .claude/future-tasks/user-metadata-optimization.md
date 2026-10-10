---
priority: P3
adopters: BOTH
summary: >-
  What remains after batch user lookups shipped: optionally move the user endpoints out of the `permissions` namespace into `users`/`groups`, and optionally embed user metadata in comment and branch responses. Neither fixes a load problem now that badges batch and the server caches
---
# User Metadata: API Reorganization & Embedded Metadata

**Priority: P3 [BOTH].** Badges now batch: `useUserMetadata` is SWR-backed per user, and
`editor/hooks/user-metadata-batcher.ts` sends a render's ids as one `POST /users/batch` (capped
at `MAX_USER_METADATA_BATCH`), answered by `auth/user-metadata-lookup.ts`: from the file-based auth
cache under canopycms-next, else a per-process TTL cache over the plugin's `getUsersMetadata`. What is left is structural and optional.

Re-check before doing Part 2: with batching plus SWR, comment and branch badges already cost one
request per render, so embedding mainly saves that request.

---

## Part 1: API Reorganization

### Current Structure

User-related endpoints are scattered:

```
permissions namespace:
  GET  /users/search       → searchUsers
  GET  /users/:userId      → getUserMetadata
  GET  /groups             → listGroups
  POST /users/batch        → batchGetUserMetadata
  GET  /permissions        → get permissions
  PUT  /permissions        → update permissions

user namespace:
  GET  /user/info          → getUserInfo (current user)
```

### Proposed Structure

Create dedicated `users` and `groups` namespaces:

```
users namespace:
  GET  /users/search       → searchUsers
  GET  /users/:userId      → getUserMetadata
  GET  /users/me           → getUserInfo (moved from user namespace)
  POST /users/batch        → batchGetUserMetadata

groups namespace:
  GET  /groups             → listGroups
  GET  /groups/search      → searchExternalGroups (if applicable)

permissions namespace:
  GET  /permissions        → get PathPermissions only
  PUT  /permissions        → update PathPermissions only
```

### Benefits

1. **Clear separation of concerns:** Users, groups, and permissions are distinct concepts
2. **Easier permission scoping:** Different namespaces can have different access rules
3. **Better discoverability:** `client.users.*` vs `client.permissions.*`
4. **Aligns with REST principles:** Resources grouped by entity type

### Implementation Steps

#### Step 1: Create users.ts API file

**File:** `packages/canopycms/src/api/users.ts` (NEW)

```typescript
import { z } from 'zod'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { isAdmin, isReviewer } from '../reserved-groups'
import { defineEndpoint } from './route-builder'

// Move user-related types and handlers from permissions.ts
// ... (copy searchUsers, getUserMetadata, batchGetUserMetadata, getUserInfo)

export const USER_ROUTES = {
  search: searchUsers,
  getById: getUserMetadata,
  getMe: getUserInfo,
  batch: batchGetUserMetadata,
} as const
```

#### Step 2: Create groups.ts API file

**File:** `packages/canopycms/src/api/groups.ts` (rename or refactor existing)

Currently `groups.ts` handles internal group management. Consider:

- Keep internal group CRUD in current `groups.ts`
- Add external group operations if needed
- Export as `GROUP_ROUTES`

#### Step 3: Update permissions.ts

Remove user/group endpoints, keep only PathPermission CRUD:

```typescript
export const PERMISSION_ROUTES = {
  get: getPermissions,
  update: updatePermissions,
} as const
```

#### Step 4: Update api/index.ts

```typescript
export { USER_ROUTES } from './user'
export { GROUP_ROUTES } from './groups'
export { PERMISSION_ROUTES } from './permissions'
// ... rest
```

#### Step 5: Regenerate API client

Run `pnpm generate:client` to update client with new namespaces.

#### Step 6: Update all client calls

Search for `client.permissions.searchUsers` → `client.users.search`
Search for `client.permissions.getUserMetadata` → `client.users.getById`
etc.

### Migration Considerations

**Breaking Changes:**

- Client API surface changes (namespace changes)
- All calling code must be updated

**Recommendation:**

- Add new namespaces alongside old ones for gradual migration
- Use type aliases to ease migration

---

## Part 2: Embedded User Metadata (Optional)

### Concept

Instead of fetching user metadata separately, embed it directly in API responses that reference users.

### Example: Comments API

**Current:**

```json
{
  "comments": [
    { "id": "1", "userId": "alice", "text": "Great work!" },
    { "id": "2", "userId": "bob", "text": "Thanks!" }
  ]
}
// Client makes 2 additional API calls for alice and bob metadata
```

**Proposed:**

```json
{
  "comments": [
    {
      "id": "1",
      "userId": "alice",
      "user": {
        "id": "alice",
        "name": "Alice Smith",
        "email": "alice@example.com"
      },
      "text": "Great work!"
    },
    {
      "id": "2",
      "userId": "bob",
      "user": { "id": "bob", "name": "Bob Jones", "email": "bob@example.com" },
      "text": "Thanks!"
    }
  ]
}
// Zero additional API calls needed
```

### Where to Apply

**High Value (Recommended):**

- Comments API: Small number of unique users per response
- Branch list API: Single `createdBy` user per branch
- Individual entry/content responses: Single author

**Low Value (Not Recommended):**

- Permissions API: Can have 100+ users per permission tree
- Group membership API: Can have 500+ users per group

### Implementation Pattern

```typescript
// In API handler
const comments = await loadComments(branchName)

// One cached, batched lookup for every author (auth/user-metadata-lookup.ts)
const users = await lookupUsersMetadata(authPlugin, comments.map((c) => c.userId))

// Embed user metadata in response
const commentsWithUsers = comments.map((comment) => ({
  ...comment,
  user: users.get(comment.userId) ?? null,
}))

return { ok: true, status: 200, data: { comments: commentsWithUsers } }
```

### Trade-offs

**Pros:**

- Zero additional API calls for embedded data
- Simpler client code (no async user fetching)
- Faster perceived load time

**Cons:**

- Larger response payloads
- Duplicate data if same user appears multiple times
- Server must fetch user metadata (adds server-side latency)

**Recommendation:** Use selectively for high-value, low-user-count responses (comments, individual entries); high-user-count views (permissions, groups) stay on batching.
