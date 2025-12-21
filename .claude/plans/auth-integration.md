# Auth Integration & Group Management

## Overview

CanopyCMS implements a two-layer access control system:

1. **Branch-level access**: Controls who can view/edit specific branches
2. **Path-level permissions**: Fine-grained control over content paths within branches

Access is granted to users and groups. Groups can be:
- **Internal Groups**: Defined and managed within CanopyCMS (stored in `.canopycms/groups.json`)
- **External Groups**: Provided by auth plugin (e.g., Clerk organizations)

## Architecture

### Auth Plugin Interface

The `AuthPlugin` interface defines how CanopyCMS integrates with authentication providers:

```typescript
// packages/canopycms/src/auth/plugin.ts
export interface AuthPlugin {
  verifyToken(req: NextRequest): Promise<TokenVerificationResult>
  searchUsers(query: string, limit?: number): Promise<UserSearchResult[]>
  getUserMetadata(userId: CanopyUserId): Promise<UserSearchResult | null>
  getGroupMetadata(groupId: CanopyGroupId): Promise<GroupMetadata | null>
  listGroups(limit?: number): Promise<GroupMetadata[]>
  searchExternalGroups?(query: string): Promise<Array<{ id: CanopyGroupId; name: string }>>
}
```

### Permission Management

Permissions are stored in `.canopycms/permissions.json` with this structure:

```typescript
{
  version: 1,
  updatedAt: "2024-01-01T00:00:00.000Z",
  updatedBy: "user-123",
  permissions: [
    {
      path: "/blog",
      access: [
        { type: "user", id: "user-123", permission: "write" },
        { type: "group", id: "editors", permission: "write" },
        { type: "group", id: "viewers", permission: "read" }
      ]
    }
  ]
}
```

**Permission Manager Component** ([src/editor/PermissionManager.tsx](packages/canopycms/src/editor/PermissionManager.tsx)):
- Tree-based UI for managing path permissions
- Admin-only access
- User and group search
- Read/write permission levels
- Accessible via Settings menu (gear icon)

### Group Management

#### Internal Groups

Internal groups are CMS-managed and stored in `.canopycms/groups.json`:

```typescript
{
  version: 1,
  updatedAt: "2024-01-01T00:00:00.000Z",
  updatedBy: "admin-123",
  groups: [
    {
      id: "editors",
      name: "Content Editors",
      description: "Team members who can edit content",
      members: ["user-1", "user-2", "user-3"]
    }
  ]
}
```

**Group Manager Component** ([src/editor/GroupManager.tsx](packages/canopycms/src/editor/GroupManager.tsx)):
- Tabbed interface: Internal Groups | External Groups
- **Internal Groups Tab**:
  - Create, edit, delete groups
  - Manage group members with user search
  - Full CRUD operations
- **External Groups Tab**:
  - Search external groups from auth provider
  - Read-only display (ID and name)
  - Uses `authPlugin.searchExternalGroups()` if available
- Admin-only access
- Accessible via Settings menu (gear icon)

#### External Groups

External groups come from the auth provider (e.g., Clerk organizations):
- Read-only in CanopyCMS
- Only ID and name are surfaced
- Can be assigned permissions but not edited
- Optional feature (requires `searchExternalGroups` in auth plugin)

## Files & Components

### Core Files

**Group Management**:
- [src/groups-file.ts](packages/canopycms/src/groups-file.ts) - Schema definition for groups.json
- [src/groups-loader.ts](packages/canopycms/src/groups-loader.ts) - Load/save functions for groups file
- [src/api/groups.ts](packages/canopycms/src/api/groups.ts) - API endpoints for group CRUD
- [src/editor/GroupManager.tsx](packages/canopycms/src/editor/GroupManager.tsx) - Group management UI component

**Permission Management**:
- [src/permissions-file.ts](packages/canopycms/src/permissions-file.ts) - Schema definition for permissions.json
- [src/permissions-loader.ts](packages/canopycms/src/permissions-loader.ts) - Load/save functions for permissions file
- [src/api/permissions.ts](packages/canopycms/src/api/permissions.ts) - API endpoints for permission CRUD
- [src/editor/PermissionManager.tsx](packages/canopycms/src/editor/PermissionManager.tsx) - Permission management UI component

**Auth Integration**:
- [src/auth/plugin.ts](packages/canopycms/src/auth/plugin.ts) - Auth plugin interface
- [src/auth/types.ts](packages/canopycms/src/auth/types.ts) - Auth-related type definitions

**Editor Integration**:
- [src/editor/Editor.tsx](packages/canopycms/src/editor/Editor.tsx) - Main editor with settings menu (lines 1068-1314)

### API Endpoints

#### Groups API

**GET /api/groups/internal** (Admin only)
- Returns list of internal groups
- Loads from `.canopycms/groups.json` in main branch

**POST /api/groups/internal** (Admin only)
- Updates internal groups
- Commits change to git with message "Update internal groups"
- Request body: `{ groups: InternalGroup[] }`

**GET /api/groups/external/search?query=...** (Admin only)
- Searches external groups via auth plugin
- Returns: `{ groups: Array<{ id, name }> }`
- Returns 501 if `searchExternalGroups` not implemented

#### Permissions API

**GET /api/permissions** (Admin only)
- Returns current path permissions
- Loads from `.canopycms/permissions.json` in main branch

**POST /api/permissions** (Admin only)
- Updates path permissions
- Commits change to git with message "Update permissions"
- Request body: `{ permissions: PathPermission[] }`

**GET /api/permissions/users/search?query=...&limit=...** (Admin/Manager)
- Searches users via auth plugin
- Used for adding users to permissions and groups

**GET /api/permissions/groups** (Admin/Manager)
- Lists all groups via auth plugin
- Used for permission assignment dropdowns

## IMPLEMENTATION STATUS - UPDATED 2024-12-21

### ✅ What's Complete

1. **Auth Plugin Interface** - Fully defined in [src/auth/plugin.ts](packages/canopycms/src/auth/plugin.ts)
2. **Clerk Auth Plugin** - Complete with 35+ tests in [src/auth/providers/clerk.ts](packages/canopycms/src/auth/providers/clerk.ts)
3. **Group Management Backend**:
   - Schema and storage in [src/groups-file.ts](packages/canopycms/src/groups-file.ts), [src/groups-loader.ts](packages/canopycms/src/groups-loader.ts)
   - API endpoints in [src/api/groups.ts](packages/canopycms/src/api/groups.ts) (12 tests)
   - GroupManager UI in [src/editor/GroupManager.tsx](packages/canopycms/src/editor/GroupManager.tsx) (33+ tests, 13 Storybook stories)
4. **Permission Management Backend**:
   - API endpoints in [src/api/permissions.ts](packages/canopycms/src/api/permissions.ts)
   - PermissionManager UI in [src/editor/PermissionManager.tsx](packages/canopycms/src/editor/PermissionManager.tsx)
5. **Settings Menu Integration** - Gear icon menu in [Editor.tsx:1068-1083](packages/canopycms/src/editor/Editor.tsx#L1068-L1083)

### ❌ What's Missing

1. **API Routes Not Registered** - Groups endpoints (getInternalGroups, updateInternalGroups, searchExternalGroups) are not registered in [src/next/api.ts](packages/canopycms/src/next/api.ts)
2. **Editor UI Handlers** - Placeholder console.log handlers in [Editor.tsx:1259-1314](packages/canopycms/src/editor/Editor.tsx#L1259-L1314) need to be wired to real API calls
3. **Data Loading** - Managers are passed empty arrays instead of loading data from API
4. **Example App Configuration** - No Clerk auth configured in example app
5. **Auth Check Verification** - Need to verify path-based permissions and branch access checks are enforced
6. **Comment Permissions** - Need to verify who can comment and resolve threads
7. **Admin Configuration** - Need pluggable way for adopters to define admin users (function that returns true if user is admin)

---

## Implementation Steps to Complete Auth

### Step 1: Register Groups API Routes (CRITICAL - Must Be First)

**File**: [packages/canopycms/src/next/api.ts](packages/canopycms/src/next/api.ts)

**Add imports** (after line 16):
```typescript
import { getInternalGroups, updateInternalGroups, searchExternalGroups } from '../api/groups'
```

**Update type union** (add to CanopyNextHandler around line 43):
```typescript
| typeof getInternalGroups
| typeof updateInternalGroups
| typeof searchExternalGroups
```

**Register routes** (in buildRouteMap() around line 140, after the groups route):
```typescript
[routeKey('GET', ['groups', 'internal'])]: withOptions(getInternalGroups),
[routeKey('PUT', ['groups', 'internal'])]: withOptions(updateInternalGroups),
[routeKey('GET', ['groups', 'search'])]: withOptions(searchExternalGroups),
```

### Step 2: Wire Editor.tsx UI Handlers

**File**: [packages/canopycms/src/editor/Editor.tsx](packages/canopycms/src/editor/Editor.tsx)

**2.1: Add imports** (top of file):
```typescript
import type { InternalGroup } from '../groups-file'
import type { PathPermission } from '../config'
```

**2.2: Add state** (around line 122):
```typescript
const [groupsData, setGroupsData] = useState<InternalGroup[]>([])
const [permissionsData, setPermissionsData] = useState<PathPermission[]>([])
const [groupsLoading, setGroupsLoading] = useState(false)
const [permissionsLoading, setPermissionsLoading] = useState(false)
```

**2.3: Add loading functions** (around line 560):
```typescript
const loadGroups = async () => {
  setGroupsLoading(true)
  try {
    const res = await fetch('/api/canopycms/groups/internal')
    if (!res.ok) throw new Error('Failed to load groups')
    const data = await res.json()
    setGroupsData(data.data?.groups ?? [])
  } catch (err) {
    console.error('Failed to load groups:', err)
    notifications.show({ message: 'Failed to load groups', color: 'red' })
  } finally {
    setGroupsLoading(false)
  }
}

const loadPermissions = async () => {
  setPermissionsLoading(true)
  try {
    const res = await fetch('/api/canopycms/permissions')
    if (!res.ok) throw new Error('Failed to load permissions')
    const data = await res.json()
    setPermissionsData(data.data?.permissions ?? [])
  } catch (err) {
    console.error('Failed to load permissions:', err)
    notifications.show({ message: 'Failed to load permissions', color: 'red' })
  } finally {
    setPermissionsLoading(false)
  }
}
```

**2.4: Add useEffect hooks** (around line 427):
```typescript
useEffect(() => {
  if (groupManagerOpen) loadGroups()
}, [groupManagerOpen])

useEffect(() => {
  if (permissionManagerOpen) loadPermissions()
}, [permissionManagerOpen])
```

**2.5: Define handler functions** (around line 570, after loading functions):
```typescript
const handleSaveGroups = async (groups: InternalGroup[]) => {
  try {
    const res = await fetch('/api/canopycms/groups/internal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups }),
    })
    if (!res.ok) {
      const payload = await res.json()
      throw new Error(payload.error || 'Failed to save groups')
    }
    notifications.show({
      title: 'Groups Saved',
      message: 'Internal groups have been updated',
      color: 'green',
    })
    await loadGroups()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save groups'
    notifications.show({ message, color: 'red' })
    throw err
  }
}

const handleSearchUsers = async (query: string, limit?: number) => {
  try {
    const params = new URLSearchParams({ query, limit: String(limit ?? 10) })
    const res = await fetch(`/api/canopycms/users/search?${params}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.data?.users ?? []
  } catch (err) {
    console.error('User search failed:', err)
    return []
  }
}

const handleSearchExternalGroups = async (query: string) => {
  try {
    const params = new URLSearchParams({ query })
    const res = await fetch(`/api/canopycms/groups/search?${params}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.data?.groups ?? []
  } catch (err) {
    console.error('External group search failed:', err)
    return []
  }
}

const handleSavePermissions = async (permissions: PathPermission[]) => {
  try {
    const res = await fetch('/api/canopycms/permissions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions }),
    })
    if (!res.ok) {
      const payload = await res.json()
      throw new Error(payload.error || 'Failed to save permissions')
    }
    notifications.show({
      title: 'Permissions Saved',
      message: 'Permissions have been updated',
      color: 'green',
    })
    await loadPermissions()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save permissions'
    notifications.show({ message, color: 'red' })
    throw err
  }
}

const handleListGroups = async () => {
  try {
    const res = await fetch('/api/canopycms/groups')
    if (!res.ok) return []
    const data = await res.json()
    return data.data?.groups ?? []
  } catch (err) {
    console.error('Group list failed:', err)
    return []
  }
}
```

**2.6: Update GroupManager component** (lines 1260-1284):
```typescript
<GroupManager
  internalGroups={groupsData}
  canEdit={true}
  onSave={handleSaveGroups}
  onSearchUsers={handleSearchUsers}
  onSearchExternalGroups={handleSearchExternalGroups}
  onClose={() => setGroupManagerOpen(false)}
/>
```

**2.7: Update PermissionManager component** (lines 1288-1314):
```typescript
<PermissionManager
  schema={collections?.map(c => ({
    type: c.type,
    name: c.name,
    label: c.label,
    path: c.id,
    format: c.format,
    fields: [],
  })) ?? []}
  permissions={permissionsData}
  canEdit={true}
  onSave={handleSavePermissions}
  onSearchUsers={handleSearchUsers}
  onListGroups={handleListGroups}
  onClose={() => setPermissionManagerOpen(false)}
/>
```

### Step 3: Configure Clerk in Example App

**3.1: Create .env.local** file at [packages/canopycms/examples/one/.env.local](packages/canopycms/examples/one/.env.local):
```env
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
```

**3.2: Update route handler** at [packages/canopycms/examples/one/app/api/canopycms/[...canopycms]/route.ts](packages/canopycms/examples/one/app/api/canopycms/[...canopycms]/route.ts):
```typescript
import config from '../../../../canopycms.config'
import { BranchWorkspaceManager, loadBranchState } from 'canopycms'
import { createCanopyHandler } from 'canopycms/next'
import { createClerkAuthPlugin } from 'canopycms/auth/providers/clerk'
import type { NextRequest } from 'next/server'

const branchMode = config.mode ?? 'local-simple'
const defaultBranch = config.defaultBaseBranch ?? 'main'
const workspaceManager = new BranchWorkspaceManager(config)

const ensureBranchState = async (branch: string) => {
  const existing = await loadBranchState({ branchName: branch, mode: branchMode })
  if (existing) return existing
  const workspace = await workspaceManager.openOrCreateBranch({
    branchName: branch,
    mode: branchMode,
    createdBy: 'demo-editor',
  })
  return workspace.state
}

await ensureBranchState(defaultBranch)

// Initialize auth plugin
const authPlugin = createClerkAuthPlugin({
  secretKey: process.env.CLERK_SECRET_KEY,
  roleMetadataKey: 'canopyRole',
  useOrganizationsAsGroups: true,
})

// Add auth to config
config.authPlugin = authPlugin

const getUser = async (req: NextRequest) => {
  try {
    const result = await authPlugin.verifyToken(req)
    if (!result.valid || !result.user) {
      // Fallback for development
      return { userId: 'demo-editor', role: 'admin' }
    }
    return {
      userId: result.user.userId,
      role: result.user.role ?? 'editor',
      groups: result.user.groups,
    }
  } catch (err) {
    console.error('Auth failed, using demo user:', err)
    return { userId: 'demo-editor', role: 'admin' }
  }
}

const handler = createCanopyHandler({
  config,
  getUser,
  getBranchState: ensureBranchState,
})

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
```

**3.3: Add ClerkProvider** to [packages/canopycms/examples/one/app/layout.tsx](packages/canopycms/examples/one/app/layout.tsx):
```typescript
import type { Metadata } from 'next'
import React from 'react'
import { ClerkProvider } from '@clerk/nextjs'

import './globals.css'

export const metadata: Metadata = {
  title: 'CanopyCMS Examples: One',
  description: 'Schema-driven form + preview using mock data',
}

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}

export default RootLayout
```

### Step 4: Verify Auth Checks Are Working

**4.1: Branch Access Control** (Already Implemented ✅)

Branch access is checked in [src/authz.ts](packages/canopycms/src/authz.ts):
- `checkBranchAccessWithDefault()` function checks:
  - Admin and manager roles bypass all restrictions
  - `allowedUsers` and `allowedGroups` in branch metadata
  - Falls back to `defaultBranchAccess` config setting

**Verified in**:
- [src/api/comments.ts](packages/canopycms/src/api/comments.ts) - Lines 31-34, 58-61, 108-111
- All branch API endpoints use `ctx.services.checkBranchAccess(state, req.user)`

**4.2: Path-Based Permissions** (Needs Verification ⚠️)

Path permissions are defined in [src/path-permissions.ts](packages/canopycms/src/path-permissions.ts) but **need to verify they're enforced** in:
- Content read/write operations
- Entry listing

**TODO**: Check if `checkPathAccess()` is being called in content API handlers.

**4.3: Comment Permissions** (Already Implemented ✅)

Comment permissions in [src/comment-store.ts](packages/canopycms/src/comment-store.ts):
- **Anyone with branch access can comment** (verified in addComment handler)
- **Who can resolve**:
  - Thread author (created by)
  - Comment author (only their own comments)
  - Reviewer role
  - Admin role

**Verified in**: [src/api/comments.ts](packages/canopycms/src/api/comments.ts) resolveComment handler checks permissions.

**4.4: Admin Configuration** (MISSING ❌ - Needs Implementation)

**Current State**: Admin role is hardcoded via `req.user.role === 'admin'` checks.

**Needed**: Pluggable admin check function in config:
```typescript
// In CanopyConfig
isAdmin?: (userId: CanopyUserId, context?: { groups?: CanopyGroupId[] }) => Promise<boolean>
```

**Why**: Adopters need flexibility to define admins:
- Via auth provider custom claims (Clerk public metadata)
- Via hardcoded user ID list
- Via database lookup
- Via organization ownership

**Implementation**: Add optional `isAdmin` function to config, fall back to `role === 'admin'` if not provided.

### Step 5: Testing

**Run existing tests**:
```bash
npm test src/api/groups.test.ts
npm test src/api/permissions.test.ts
npm test src/auth/providers/clerk.test.ts
npm test src/authz.test.ts
npm test src/path-permissions.test.ts
```

**Manual testing checklist**:
1. Start example app: `npm run dev` in examples/one
2. **Test Branch Access**:
   - Create branch as non-admin user
   - Verify admin can access all branches
   - Verify non-admin restricted to allowed branches
3. **Test GroupManager** (Settings > Manage Groups):
   - Verify only admins can access
   - Verify groups load
   - Create/edit/delete groups
   - Search users
   - Search external groups (Clerk orgs)
   - Save and verify success
4. **Test PermissionManager** (Settings > Manage Permissions):
   - Verify only admins can access
   - Verify permissions load
   - Modify permissions
   - Search users and groups
   - Save and verify success
5. **Test Path Permissions**:
   - Set read-only permission on a path
   - Verify user cannot edit content at that path
   - Verify admin can still edit (admin bypass)
6. **Test Comment Permissions**:
   - Create comment as regular user
   - Verify only author/reviewer/admin can resolve
   - Verify non-authors cannot resolve
7. Test error cases (network failures, invalid auth, permission denied)

## Testing

### Component Tests

**GroupManager** ([src/editor/GroupManager.test.tsx](packages/canopycms/src/editor/GroupManager.test.tsx)):
- 33 tests covering:
  - Rendering (5 tests)
  - Tab navigation (2 tests)
  - Internal group management (4 tests)
  - Creating groups (2 tests)
  - Editing groups (2 tests)
  - Deleting groups (1 test)
  - Member management (7 tests)
  - External group search (5 tests)
  - Saving (4 tests)
  - Close button (2 tests)

**API Tests** ([src/api/groups.test.ts](packages/canopycms/src/api/groups.test.ts)):
- 12 tests covering:
  - Permission checks (admin-only)
  - Loading groups
  - Saving groups
  - Git commits
  - External group search
  - Error handling

### Running Tests

```bash
npm test src/editor/GroupManager.test.tsx
npm test src/api/groups.test.ts
npm test src/api/permissions.test.ts
```

## Storybook Stories

**GroupManager Stories** ([src/editor/GroupManager.stories.tsx](packages/canopycms/src/editor/GroupManager.stories.tsx)):

13 stories demonstrating:
- Default state with internal and external groups
- Internal groups only
- Empty state
- Read-only mode (non-admin)
- Loading state
- Error states (save error, search errors)
- Edge cases (no search, many members, long names)
- Mixed scenario

View stories:
```bash
npm run storybook
```

## Access Control Flow

1. **User authenticates** via auth plugin (e.g., Clerk)
2. **Auth plugin returns user metadata** including role (admin/manager/editor)
3. **Branch-level access check**:
   - Check if user/group in `branch.access`
   - Admins bypass all restrictions
4. **Path-level permission check**:
   - Load `.canopycms/permissions.json`
   - Find most specific path match
   - Check if user/group has required permission (read/write)
   - Admins bypass all restrictions
5. **Group membership resolution**:
   - Internal groups: Load from `.canopycms/groups.json`
   - External groups: Query auth plugin's `getGroupMetadata()`

## Configuration Reference

### Groups File Schema

```typescript
{
  version: 1,                    // Schema version
  updatedAt: string,             // ISO 8601 timestamp
  updatedBy: CanopyUserId,       // User who made last change
  groups: [
    {
      id: CanopyGroupId,         // Unique identifier
      name: string,              // Display name
      description?: string,      // Optional description
      members: CanopyUserId[]    // User IDs in this group
    }
  ]
}
```

### Permissions File Schema

```typescript
{
  version: 1,                    // Schema version
  updatedAt: string,             // ISO 8601 timestamp
  updatedBy: CanopyUserId,       // User who made last change
  permissions: [
    {
      path: string,              // Content path (e.g., "/blog")
      access: [
        {
          type: "user" | "group",
          id: CanopyUserId | CanopyGroupId,
          permission: "read" | "write"
        }
      ]
    }
  ]
}
```

## Summary

The auth integration and group management system provides:

✅ **Admin UI** for managing groups and permissions
✅ **Internal groups** stored in `.canopycms/groups.json`
✅ **External groups** from auth provider (optional)
✅ **Path-based permissions** for fine-grained access control
✅ **Git-backed changes** for audit trail
✅ **Pluggable auth** for any provider
✅ **Comprehensive tests** (45+ tests total)
✅ **Storybook stories** for visual verification

All admin tools are accessible via the Settings menu (gear icon) in the editor's right sidebar.

---

## Related Plans

- **[Overall Plan](./overall-plan.md)** - Overall project roadmap
- **[Auth Provider Refactoring](./auth-provider-refactor.md)** - 🚨 **MUST BE DONE FIRST - BLOCKING**

**CRITICAL**: The auth provider refactoring plan **must be executed BEFORE** completing the implementation steps above. The current Clerk integration has npm resolution problems that prevent `@clerk/nextjs` from being resolved in the example app. Moving Clerk to a separate package fixes this blocking issue.

**Execution Order**:
1. ✅ Complete auth provider refactoring ([auth-provider-refactor.md](./auth-provider-refactor.md))
2. ⏸️ Then complete auth integration steps above
