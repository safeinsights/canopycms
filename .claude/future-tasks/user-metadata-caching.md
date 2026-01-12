# Future Task: Implement User Metadata Caching System

## Context

The UserBadge component (implemented separately) displays user information (avatar, name, email) by fetching metadata via the auth plugin's `getUserMetadata(userId)` API. Currently, each render that needs user data makes an API call, which can result in many redundant requests.

## Problem

Multiple components throughout the application display user information:
- PermissionManager (shows users in permission tree nodes)
- GroupManager (shows group members)
- BranchManager (shows branch owners/collaborators)
- Comments (shows comment authors and resolvers)

Each location may show the same users repeatedly, and user metadata changes infrequently, making it an ideal candidate for caching.

## Current Implementation

The `useUserMetadata` hook (in [src/editor/hooks/useUserMetadata.ts](packages/canopycms/src/editor/hooks/useUserMetadata.ts)) fetches user data on-demand:

```typescript
export function useUserMetadata(userId: CanopyUserId) {
  // Currently: Makes API call to authPlugin.getUserMetadata(userId)
  // every time a component mounts
}
```

## Goal

Implement an intelligent caching layer that:
1. Reduces redundant API calls for frequently-displayed users
2. Keeps data reasonably fresh (15-minute TTL suggested)
3. Works across both server and client contexts
4. Can be applied to other cacheable data (groups, branch metadata, etc.)

## Caching Architecture Considerations

### Question 1: Client-side vs Server-side Caching

**Client-side (browser) caching:**
- Pros: Reduces network calls, faster UI, works offline
- Cons: Per-session, doesn't help initial page loads, memory limited
- Implementation: React state/context, localStorage, IndexedDB

**Server-side caching:**
- Pros: Shared across all users, reduces auth provider API load, faster SSR
- Cons: Requires cache invalidation strategy, memory/storage overhead
- Implementation: In-memory Map, Redis, file-based cache

**Hybrid approach:**
- Server caches auth provider responses
- Client caches server responses
- Best of both worlds but more complexity

**Decision needed**: Which caching layer(s) make sense for CanopyCMS architecture?

### Question 2: Cache Storage Location

For **client-side**:
- In-memory (React state/context): Fast, lost on refresh
- localStorage: Persists across sessions, 5-10MB limit
- IndexedDB: Large capacity, more complex API

For **server-side**:
- In-memory Map: Fast, lost on restart
- File-based (`.canopycms/user-cache.json`): Survives restart, slower
- Redis/external cache: Scalable, requires additional infrastructure

### Question 3: TTL Strategy

**Options**:
1. **Fixed TTL**: 15 minutes (simple, may show stale data)
2. **Stale-while-revalidate**: Serve stale data, fetch fresh in background
3. **Event-based invalidation**: Clear cache on user profile updates (complex)
4. **Adaptive TTL**: Longer TTL for rarely-updated data

**Recommendation**: Start with fixed TTL + stale-while-revalidate fallback

### Question 4: Scope of Caching

Should we build a general-purpose caching system or user-specific?

**User-specific cache** (narrow scope):
- Just cache `getUserMetadata()` responses
- Simpler to implement and reason about
- Quick win for current problem

**General caching system** (broad scope):
- Cache API responses, file reads, computed data
- Could cache: user metadata, group metadata, branch lists, permission trees
- More complex but broader benefits
- Consider existing patterns (e.g., React Query, SWR)

**Recommendation**: Start user-specific, design for extensibility

## Implementation Approach

### Phase 1: Server-side Caching (if server-rendered)

If CanopyCMS has a server component:

**File**: `src/server/services/user-metadata-cache.ts`

```typescript
interface CachedUserMetadata {
  data: UserSearchResult
  cachedAt: number
  ttl: number // 15 minutes
}

class ServerUserCache {
  private cache: Map<CanopyUserId, CachedUserMetadata>
  private authPlugin: AuthPlugin

  async get(userId: CanopyUserId): Promise<UserSearchResult | null> {
    // Check cache, return if fresh
    // If expired, fetch from authPlugin and update cache
  }

  async getMany(userIds: CanopyUserId[]): Promise<Map<...>> {
    // Batch fetch multiple users efficiently
  }
}
```

**Integration**: Wrap auth plugin calls with cache layer

### Phase 2: Client-side Caching

**Option A: React Context + in-memory cache**

```typescript
// src/editor/contexts/UserCacheContext.tsx
const UserCacheContext = React.createContext<UserCache>(...)

export function UserCacheProvider({ children }) {
  const cache = useRef(new Map<CanopyUserId, CachedUserMetadata>())
  // Provide get/getMany methods
}

// Update useUserMetadata to use context
export function useUserMetadata(userId: CanopyUserId) {
  const cache = useContext(UserCacheContext)
  // Check cache first, then fetch
}
```

**Option B: React Query / SWR**

Use established caching libraries:

```typescript
import { useQuery } from '@tanstack/react-query'

export function useUserMetadata(userId: CanopyUserId) {
  return useQuery({
    queryKey: ['user', userId],
    queryFn: () => authPlugin.getUserMetadata(userId),
    staleTime: 15 * 60 * 1000, // 15 minutes
  })
}
```

Pros: Battle-tested, includes stale-while-revalidate, request deduplication
Cons: Additional dependency

**Option C: Custom hook with localStorage**

```typescript
export function useUserMetadata(userId: CanopyUserId) {
  // Check localStorage cache
  // If expired or missing, fetch from API
  // Update localStorage
}
```

Pros: Persists across sessions
Cons: Limited storage, serialization overhead

### Phase 3: Optimization - Batch Loading

Add batch loading to reduce API calls when displaying lists:

```typescript
// src/editor/hooks/useUserMetadataBatch.ts
export function useUserMetadataBatch(userIds: CanopyUserId[]) {
  // Fetch all users in a single request (if auth plugin supports)
  // Or deduplicate concurrent individual requests
}
```

Use in PermissionManager, GroupManager to preload users.

### Phase 4: Cache Invalidation

**Strategy**:
1. Automatic TTL expiry (15 minutes)
2. Manual invalidation API: `invalidateUserCache(userId?)`
3. Consider: invalidate on auth plugin events (user updated, etc.)

## Files to Create/Modify

**New files**:
- `src/server/services/user-metadata-cache.ts` (if server-side)
- `src/editor/contexts/UserCacheContext.tsx` (if using React Context)
- `src/editor/hooks/useUserMetadataBatch.ts` (for batch loading)

**Modify**:
- `src/editor/hooks/useUserMetadata.ts` - Add cache layer
- `src/editor/components/UserBadge.tsx` - Use cached data if available
- Auth plugin integration points

## Testing Considerations

**Test scenarios**:
- Cache hit returns data without API call
- Cache miss triggers API call
- TTL expiry refreshes data
- Concurrent requests for same user are deduplicated
- Batch loading reduces API calls
- Cache survives appropriate boundaries (page refresh, server restart)

**Metrics to track**:
- API call reduction (before/after)
- Cache hit rate
- Memory usage
- Time to display user info

## Broader Caching Strategy

If implementing a general caching system, consider caching:

1. **User metadata** (this task)
2. **Group metadata** - Similar pattern, changes infrequently
3. **Branch lists** - Could cache branch summaries
4. **Permission trees** - Expensive to compute, good caching candidate
5. **File reads** - Some config files read repeatedly
6. **Computed values** - Derived data that's expensive to calculate

**Architecture for general cache**:
```typescript
interface CacheStrategy<T> {
  key: string
  fetch: () => Promise<T>
  ttl: number
  storage: 'memory' | 'disk' | 'localStorage'
}

class CacheManager {
  register<T>(strategy: CacheStrategy<T>): CachedResource<T>
  // Provides: get, invalidate, refresh
}
```

## Questions to Answer Before Implementation

1. **Server vs Client**: Where should caching live? Both?
2. **Storage**: In-memory, disk, localStorage, IndexedDB, Redis?
3. **Library**: Use React Query/SWR or build custom?
4. **Scope**: User-specific or general caching system?
5. **Invalidation**: Just TTL or more sophisticated?
6. **Batch loading**: Does auth plugin support batch getUserMetadata?

## Recommended Approach (Incremental)

**Phase 1: Quick win - Client in-memory cache**
- Use React Context with Map-based cache
- 15-minute TTL
- No persistence
- ~1 day of work

**Phase 2: Add persistence**
- Use localStorage or IndexedDB
- Survives page refresh
- ~1 day of work

**Phase 3: Server-side cache (if applicable)**
- Cache on server to reduce auth provider load
- Shared across all clients
- ~2-3 days of work

**Phase 4: General caching (future)**
- Extract pattern, apply to groups, branches, etc.
- ~1 week of work

## Success Metrics

After implementation:
- Measure API calls to `getUserMetadata()` before/after
- Target: 80%+ reduction in redundant calls
- Page load time improvement (especially for permission-heavy pages)
- User experience: instant display of user info after first load

## Related Files

- Auth plugin interface: [src/auth/plugin.ts](packages/canopycms/src/auth/plugin.ts) line 28
- User types: [src/auth/types.ts](packages/canopycms/src/auth/types.ts)
- UserBadge component: [src/editor/components/UserBadge.tsx](packages/canopycms/src/editor/components/UserBadge.tsx)
- useUserMetadata hook: [src/editor/hooks/useUserMetadata.ts](packages/canopycms/src/editor/hooks/useUserMetadata.ts)

## References

- **React Query**: https://tanstack.com/query/latest
- **SWR**: https://swr.vercel.app/
- **Stale-while-revalidate pattern**: https://web.dev/stale-while-revalidate/
- **IndexedDB**: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
