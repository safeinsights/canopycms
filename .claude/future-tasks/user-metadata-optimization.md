# User Metadata Optimization - Bulk Fetching & API Reorganization

## Context

The UserBadge component has been successfully implemented across all 5 components (PermissionManager, GroupManager, BranchManager, CommentsPanel, InlineCommentThread) with 9 total integration points. The current implementation fetches user metadata one-at-a-time via individual API calls to `GET /users/:userId`.

**Current Performance Analysis:**

- PermissionManager: 90-480 individual API calls when displaying permission tree
- GroupManager: 120-500 individual API calls when displaying group members
- BranchManager: 2-10 individual API calls (branch owner + access users)
- CommentsPanel: 5-25 individual API calls (unique comment authors)
- InlineCommentThread: 1-5 individual API calls per thread

**Total Impact:** Hundreds of API calls per page load in permission-heavy views.

## Objective

Optimize user metadata fetching to reduce API calls by 90-500x through bulk fetching and consider API reorganization for better structure.

---

## Part 1: Bulk Fetching Implementation

### Overview

Replace one-at-a-time user metadata fetching with batch requests that fetch multiple users in a single API call.

### Architecture

```typescript
// Current: One request per user
UserBadge (user1) → API call 1
UserBadge (user2) → API call 2
UserBadge (user3) → API call 3
// Result: N API calls for N users

// Proposed: One request for all users
Component → Collect all user IDs → Single batch API call → Distribute results
// Result: 1 API call for N users
```

### Implementation Steps

#### Step 1: Add Batch Endpoint

**File:** `packages/canopycms/src/api/permissions.ts`

Add new endpoint:

```typescript
/**
 * Batch fetch user metadata by IDs
 * POST /users/batch
 * Body: { userIds: string[] }
 * Response: { users: Record<string, UserSearchResult> }
 */

const batchGetUserMetadataBodySchema = z.object({
  userIds: z.array(z.string()),
})

export type BatchGetUserMetadataBody = z.infer<typeof batchGetUserMetadataBodySchema>
export type BatchGetUserMetadataResponse = ApiResponse<{
  users: Record<string, UserSearchResult>
}>

const batchGetUserMetadataHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof batchGetUserMetadataBodySchema>,
): Promise<BatchGetUserMetadataResponse> => {
  // Require admin or reviewer for user metadata
  if (!isAdmin(req.user.groups) && !isReviewer(req.user.groups)) {
    return {
      ok: false,
      status: 403,
      error: 'Admin or Reviewer access required',
    }
  }

  const authPlugin = ctx.authPlugin
  if (!authPlugin) {
    return { ok: false, status: 501, error: 'Auth plugin not configured' }
  }

  try {
    // Fetch all users in parallel
    const userPromises = body.userIds.map((userId) =>
      authPlugin
        .getUserMetadata(userId)
        .then((user) => ({ userId, user }))
        .catch(() => ({ userId, user: null })),
    )

    const results = await Promise.all(userPromises)

    // Convert array to Record<userId, UserSearchResult>
    const users: Record<string, UserSearchResult> = {}
    for (const { userId, user } of results) {
      if (user) {
        users[userId] = user
      }
    }

    return { ok: true, status: 200, data: { users } }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'Failed to fetch user metadata',
    }
  }
}

const batchGetUserMetadata = defineEndpoint({
  namespace: 'permissions',
  name: 'batchGetUserMetadata',
  method: 'POST',
  path: '/users/batch',
  body: batchGetUserMetadataBodySchema,
  bodyType: 'BatchGetUserMetadataBody',
  responseType: 'BatchGetUserMetadataResponse',
  response: {} as BatchGetUserMetadataResponse,
  defaultMockData: { users: {} },
  handler: batchGetUserMetadataHandler,
})

// Add to exports
export const PERMISSION_ROUTES = {
  // ... existing routes
  batchGetUserMetadata: batchGetUserMetadata,
} as const
```

**Important:** Run `npm run generate:client` after adding the endpoint to regenerate the API client.

#### Step 2: Create useBatchUserMetadata Hook

**File:** `packages/canopycms/src/editor/hooks/useBatchUserMetadata.ts` (NEW)

```typescript
import { useEffect, useState } from 'react'
import type { UserSearchResult } from '../../auth/types'
import type { CanopyUserId } from '../../types'

export interface UseBatchUserMetadataResult {
  /** Map of userId -> user metadata */
  userMetadataMap: Record<string, UserSearchResult>
  /** Loading state */
  isLoading: boolean
  /** Error state */
  error: Error | null
  /** Get metadata for a specific user (convenience method) */
  getUserMetadata: (userId: string) => UserSearchResult | null
}

/**
 * Fetches user metadata in batch for multiple users.
 *
 * @param userIds - Array of user IDs to fetch
 * @param batchGetUserMetadata - Function to fetch batch user metadata
 * @param cachedUsers - Optional: pre-cached user data to avoid fetching
 */
export function useBatchUserMetadata(
  userIds: CanopyUserId[],
  batchGetUserMetadata: (userIds: string[]) => Promise<Record<string, UserSearchResult>>,
  cachedUsers?: Record<string, UserSearchResult>,
): UseBatchUserMetadataResult {
  const [userMetadataMap, setUserMetadataMap] = useState<Record<string, UserSearchResult>>(
    cachedUsers || {},
  )
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    // If all users are cached, skip fetch
    if (cachedUsers) {
      const allCached = userIds.every((id) => cachedUsers[id] || id === 'anonymous')
      if (allCached) {
        setIsLoading(false)
        return
      }
    }

    let cancelled = false

    const fetchUsers = async () => {
      setIsLoading(true)

      // Filter out anonymous users and already cached users
      const userIdsToFetch = userIds.filter((id) => {
        if (id === 'anonymous') return false
        if (cachedUsers && cachedUsers[id]) return false
        return true
      })

      // Add anonymous user to result map
      const anonymousUsers: Record<string, UserSearchResult> = {}
      if (userIds.includes('anonymous')) {
        anonymousUsers['anonymous'] = {
          id: 'anonymous',
          name: 'Anonymous',
          email: 'public',
        }
      }

      if (userIdsToFetch.length === 0) {
        // No users to fetch, just use cached + anonymous
        if (!cancelled) {
          setUserMetadataMap({ ...cachedUsers, ...anonymousUsers })
          setIsLoading(false)
        }
        return
      }

      try {
        const fetchedUsers = await batchGetUserMetadata(userIdsToFetch)
        if (!cancelled) {
          setUserMetadataMap({
            ...cachedUsers,
            ...fetchedUsers,
            ...anonymousUsers,
          })
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error('Failed to fetch users'))
          // Still use cached + anonymous even on error
          setUserMetadataMap({ ...cachedUsers, ...anonymousUsers })
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    fetchUsers()

    return () => {
      cancelled = true
    }
  }, [JSON.stringify(userIds.sort()), batchGetUserMetadata, cachedUsers])

  const getUserMetadata = (userId: string) => {
    return userMetadataMap[userId] || null
  }

  return { userMetadataMap, isLoading, error, getUserMetadata }
}
```

#### Step 3: Create handleBatchGetUserMetadata in useGroupManager

**File:** `packages/canopycms/src/editor/hooks/useGroupManager.ts`

Add new function:

```typescript
export interface UseGroupManagerReturn {
  // ... existing returns
  handleGetUserMetadata: (userId: string) => Promise<UserSearchResult | null>
  handleBatchGetUserMetadata: (userIds: string[]) => Promise<Record<string, UserSearchResult>> // NEW
  // ... rest
}

// Implementation
const handleBatchGetUserMetadata = async (userIds: string[]) => {
  try {
    const result = await getApiClient().permissions.batchGetUserMetadata({
      userIds,
    })
    if (!result.ok) return {}
    return result.data?.users ?? {}
  } catch (err) {
    console.error('Batch get user metadata failed:', err)
    return {}
  }
}

return {
  // ... existing returns
  handleGetUserMetadata,
  handleBatchGetUserMetadata, // NEW
  // ... rest
}
```

#### Step 4: Refactor Components to Use Batch Fetching

##### Option A: Component-Level Batching (Recommended for initial implementation)

Each component collects all user IDs and fetches in batch.

**Example: PermissionManager**

```typescript
import { useBatchUserMetadata } from '../hooks/useBatchUserMetadata'

export const PermissionManager: React.FC<PermissionManagerProps> = ({
  permissions,
  onBatchGetUserMetadata, // NEW: replaces onGetUserMetadata
  // ... other props
}) => {
  // Collect all user IDs from permissions tree
  const allUserIds = useMemo(() => {
    const userIds = new Set<string>()

    const collectUserIds = (perms: PathPermission[]) => {
      for (const perm of perms) {
        perm.allowedUsers?.forEach(uid => userIds.add(uid))
        // Recursively collect from inherited permissions
        // ... (traverse permission tree)
      }
    }

    collectUserIds(permissions)
    return Array.from(userIds)
  }, [permissions])

  // Batch fetch all users
  const { userMetadataMap, isLoading } = useBatchUserMetadata(
    allUserIds,
    onBatchGetUserMetadata
  )

  // Create a getUserMetadata function for UserBadge
  const getUserMetadata = useCallback(
    async (userId: string) => {
      return userMetadataMap[userId] || null
    },
    [userMetadataMap]
  )

  // Pass getUserMetadata to UserBadge components
  return (
    // ... render with UserBadge using getUserMetadata
  )
}
```

##### Option B: Global Batching with Context (More complex, better performance)

Create a context that batches ALL user metadata requests across the entire editor.

**File:** `packages/canopycms/src/editor/contexts/UserMetadataContext.tsx` (NEW)

```typescript
import React, { createContext, useContext, useMemo } from 'react'
import { useBatchUserMetadata } from '../hooks/useBatchUserMetadata'
import type { UserSearchResult } from '../../auth/types'

interface UserMetadataContextValue {
  getUserMetadata: (userId: string) => UserSearchResult | null
  isLoading: boolean
}

const UserMetadataContext = createContext<UserMetadataContextValue | null>(null)

export const UserMetadataProvider: React.FC<{
  userIds: string[]
  batchGetUserMetadata: (userIds: string[]) => Promise<Record<string, UserSearchResult>>
  children: React.ReactNode
}> = ({ userIds, batchGetUserMetadata, children }) => {
  const { userMetadataMap, isLoading, getUserMetadata } = useBatchUserMetadata(
    userIds,
    batchGetUserMetadata
  )

  const value = useMemo(
    () => ({ getUserMetadata, isLoading }),
    [getUserMetadata, isLoading]
  )

  return (
    <UserMetadataContext.Provider value={value}>
      {children}
    </UserMetadataContext.Provider>
  )
}

export const useUserMetadataContext = () => {
  const context = useContext(UserMetadataContext)
  if (!context) {
    throw new Error('useUserMetadataContext must be used within UserMetadataProvider')
  }
  return context
}
```

#### Step 5: Update Editor.tsx

**File:** `packages/canopycms/src/editor/Editor.tsx`

```typescript
// Add to destructured returns from useGroupManager
const {
  // ... existing
  handleGetUserMetadata,
  handleBatchGetUserMetadata, // NEW
} = useGroupManager({ isOpen: groupManagerOpen })

// Pass to components
<PermissionManager
  // ... existing props
  onBatchGetUserMetadata={handleBatchGetUserMetadata} // NEW (if using Option A)
  // OR keep onGetUserMetadata for backward compatibility
/>
```

### Testing Strategy

1. **Unit Tests:**
   - Test `useBatchUserMetadata` hook with various user ID arrays
   - Test anonymous user handling
   - Test error handling
   - Test caching behavior

2. **Integration Tests:**
   - Verify batch endpoint returns correct data format
   - Test with 0 users, 1 user, 100+ users
   - Test with mix of valid/invalid user IDs
   - Test with duplicate user IDs

3. **Performance Tests:**
   - Before: Count API calls in DevTools Network tab
   - After: Verify single batch API call replaces hundreds of individual calls
   - Measure load time improvement

### Migration Path

**Phase 1:** Add batch endpoint and hook (no breaking changes)

- Add `POST /users/batch` endpoint
- Add `useBatchUserMetadata` hook
- Add `handleBatchGetUserMetadata` to useGroupManager
- Regenerate API client

**Phase 2:** Migrate PermissionManager and GroupManager (high user count)

- Refactor to use batch fetching
- Keep `onGetUserMetadata` for backward compatibility
- Measure performance improvement

**Phase 3:** Optionally migrate other components

- BranchManager, CommentsPanel, InlineCommentThread have fewer users
- One-at-a-time may be acceptable for these
- Migrate if performance testing shows benefit

---

## Part 2: API Reorganization

### Current Structure

User-related endpoints are scattered:

```
permissions namespace:
  GET  /users/search       → searchUsers
  GET  /users/:userId      → getUserMetadata
  GET  /groups             → listGroups
  POST /users/batch        → batchGetUserMetadata (after Part 1)
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

Run `npm run generate:client` to update client with new namespaces.

#### Step 6: Update all client calls

Search for `client.permissions.searchUsers` → `client.users.search`
Search for `client.permissions.getUserMetadata` → `client.users.getById`
etc.

### Migration Considerations

**Breaking Changes:**

- Client API surface changes (namespace changes)
- All calling code must be updated

**Recommendation:**

- Do API reorganization in a separate PR/session after bulk fetching
- OR add new namespaces alongside old ones for gradual migration
- Use type aliases to ease migration

---

## Part 3: Embedded User Metadata (Optional)

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

// Fetch user metadata for all unique user IDs
const userIds = [...new Set(comments.map((c) => c.userId))]
const usersMap = await Promise.all(
  userIds.map(async (userId) => {
    const user = await authPlugin.getUserMetadata(userId)
    return [userId, user] as const
  }),
).then((pairs) => Object.fromEntries(pairs))

// Embed user metadata in response
const commentsWithUsers = comments.map((comment) => ({
  ...comment,
  user: usersMap[comment.userId] || null,
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
- Harder to implement granular caching

**Recommendation:** Use selectively for high-value, low-user-count responses (comments, individual entries). Use bulk fetching for high-user-count views (permissions, groups).

---

## Recommended Implementation Order

### Session 1: Bulk Fetching

1. Add `POST /users/batch` endpoint
2. Create `useBatchUserMetadata` hook
3. Regenerate API client
4. Test endpoint with various inputs

### Session 2: PermissionManager Migration

1. Refactor PermissionManager to collect user IDs
2. Use `useBatchUserMetadata` for batch fetching
3. Test with large permission trees
4. Measure performance improvement

### Session 3: GroupManager Migration

1. Refactor GroupManager similarly
2. Test with groups containing 100+ members
3. Measure performance improvement

### Session 4: API Reorganization (Optional)

1. Create `users.ts` and refactor `groups.ts`
2. Update `permissions.ts` to remove user/group endpoints
3. Regenerate API client
4. Update all calling code
5. Test thoroughly

### Session 5: Embedded Metadata (Optional)

1. Add user embedding to comments API
2. Add user embedding to branch list API
3. Update client code to use embedded data
4. Measure performance vs bulk fetching

---

## Success Metrics

**Performance:**

- PermissionManager: 90-480 API calls → 1-2 API calls (98-99% reduction)
- GroupManager: 120-500 API calls → 1-2 API calls (98-99% reduction)
- Page load time: Measure before/after with Chrome DevTools

**Code Quality:**

- Clean namespace separation (users, groups, permissions)
- Reusable batch fetching pattern
- Backward compatible (optional prop pattern)

**User Experience:**

- Faster perceived load time
- No flickering from sequential user loads
- Consistent avatar display across all components

---

## Notes

- Caching is intentionally excluded from this document and deferred to a separate task (see `user-metadata-caching.md`)
- Bulk fetching and caching are complementary - implement bulk fetching first, then add caching layer on top
- API reorganization is independent and can be done before or after bulk fetching
- Embedded metadata is the lowest priority and may not be needed if bulk fetching + caching work well
