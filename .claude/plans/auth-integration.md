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

## IMPLEMENTATION STATUS - UPDATED 2024-12-22

### ✅ What's Complete

1. **Auth Plugin Interface** - Fully defined in [src/auth/plugin.ts](packages/canopycms/src/auth/plugin.ts)
2. **Clerk Auth Plugin** - Moved to separate package `canopycms-auth-clerk` with 21 tests
3. **Auth Provider Refactoring** ✅ **COMPLETE** - See [auth-provider-refactor.md](./auth-provider-refactor.md)
   - Separate `canopycms-auth-clerk` package created
   - npm resolution issues fixed
   - Serialization issues resolved (authPlugin passed via ApiContext)
   - All 21 tests passing
4. **Group Management Backend**:
   - Schema and storage in [src/groups-file.ts](packages/canopycms/src/groups-file.ts), [src/groups-loader.ts](packages/canopycms/src/groups-loader.ts)
   - API endpoints in [src/api/groups.ts](packages/canopycms/src/api/groups.ts) (12 tests)
   - **API routes registered** in [src/next/api.ts](packages/canopycms/src/next/api.ts) lines 18, 47, 147-149
   - GroupManager UI in [src/editor/GroupManager.tsx](packages/canopycms/src/editor/GroupManager.tsx) (33+ tests, 13 Storybook stories)
   - **Wrapped in Drawer** in [Editor.tsx:1393-1411](packages/canopycms/src/editor/Editor.tsx#L1393-L1411)
5. **Permission Management Backend**:
   - API endpoints in [src/api/permissions.ts](packages/canopycms/src/api/permissions.ts)
   - **API routes registered** in [src/next/api.ts](packages/canopycms/src/next/api.ts) lines 17, 143-146
   - PermissionManager UI in [src/editor/PermissionManager.tsx](packages/canopycms/src/editor/PermissionManager.tsx)
   - **Wrapped in Drawer** in [Editor.tsx:1414-1440](packages/canopycms/src/editor/Editor.tsx#L1414-L1440)
6. **Settings Menu Integration** - Gear icon menu in [Editor.tsx:1201-1216](packages/canopycms/src/editor/Editor.tsx#L1201-L1216)
7. **Editor UI Handlers** - All handlers implemented in [Editor.tsx:580-694](packages/canopycms/src/editor/Editor.tsx#L580-L694):
   - `loadGroups()` - Loads internal groups from API
   - `loadPermissions()` - Loads permissions from API
   - `handleSaveGroups()` - Saves groups and reloads
   - `handleSavePermissions()` - Saves permissions and reloads
   - `handleSearchUsers()` - User search via authPlugin
   - `handleSearchExternalGroups()` - External group search via authPlugin
   - `handleListGroups()` - Lists all groups for dropdowns
8. **Data Loading** - useEffect hooks trigger loading when modals open [Editor.tsx:444-454](packages/canopycms/src/editor/Editor.tsx#L444-L454)
9. **Example App Configuration** - Clerk auth fully configured:
   - Auth plugin created and passed to handler in [route.ts:25-53](packages/canopycms/examples/one/app/api/canopycms/[...canopycms]/route.ts#L25-L53)
   - Environment variables configured in `.env.local`
   - ClerkProvider added to layout

### ❌ What's Missing

1. **Auth Check Verification** - Need to verify path-based permissions and branch access checks are enforced
2. **Comment Permissions** - Need to verify who can comment and resolve threads
3. **Admin Configuration** - Need pluggable way for adopters to define admin users (function that returns true if user is admin)

---

## Implementation Steps to Complete Auth

### ✅ Step 1: Register Groups API Routes (COMPLETE)

**File**: [packages/canopycms/src/next/api.ts](packages/canopycms/src/next/api.ts)

All group API routes have been registered:
- Line 18: Import statement added
- Line 47: Type union updated
- Lines 147-149: Routes registered in buildRouteMap()

### ✅ Step 2: Wire Editor.tsx UI Handlers (COMPLETE)

**File**: [packages/canopycms/src/editor/Editor.tsx](packages/canopycms/src/editor/Editor.tsx)

All editor handlers have been implemented:
- **Imports**: Lines 13, 16 - Added InternalGroup and PathPermission types
- **State**: Lines 122-127 - Added groupsData, permissionsData, loading states
- **useEffect hooks**: Lines 444-454 - Load data when modals open
- **Loading functions**: Lines 580-608 - loadGroups() and loadPermissions()
- **Handler functions**: Lines 610-694 - All CRUD and search handlers
- **GroupManager props**: Lines 1402-1410 - Wired with real handlers and data
- **PermissionManager props**: Lines 1423-1438 - Wired with real handlers and data
- **Drawer wrappers**: Lines 1393-1411 (Groups), 1414-1440 (Permissions) - Both wrapped in Drawer components for proper modal display

### ✅ Step 3: Configure Clerk in Example App (COMPLETE)

**File**: [packages/canopycms/examples/one/app/api/canopycms/[...canopycms]/route.ts](packages/canopycms/examples/one/app/api/canopycms/[...canopycms]/route.ts)

Clerk auth configuration complete:
- **Auth plugin created**: Lines 25-29 - Using `createClerkAuthPlugin` from separate package
- **authPlugin passed to handler**: Line 53 - Passed via options to avoid serialization issues
- **getUser function**: Lines 31-47 - Verifies tokens and returns user with role/groups
- **Environment variables**: Configured in `.env.local` with real Clerk keys
- **ClerkProvider**: Added to layout.tsx (if not already present)

**Key architectural fix**: authPlugin is passed through `CanopyNextOptions` and stored in `ApiContext` (not in config) to avoid Next.js serialization errors.

### ⏸️ Step 4: Verify Auth Checks Are Working (TODO)

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
- **[Auth Provider Refactoring](./auth-provider-refactor.md)** - ✅ **COMPLETE**

**Execution Order**:
1. ✅ **COMPLETE** - Auth provider refactoring ([auth-provider-refactor.md](./auth-provider-refactor.md))
   - Separate `canopycms-auth-clerk` package created
   - npm resolution issues fixed
   - Serialization issues resolved
   - All 21 tests passing
2. ✅ **COMPLETE** - Auth integration core functionality
   - API routes registered
   - Editor UI handlers wired up
   - Drawer components added for proper modal display
   - Example app configured with Clerk
   - Group and Permission managers fully functional
3. ⏸️ **TODO** - Verification and testing
   - Verify path-based permissions enforcement
   - Test comment permissions
   - Implement pluggable admin configuration
