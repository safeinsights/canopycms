# Add "list" Permission Level

## Overview

Currently, CanopyCMS has two primary permission levels for content: `'read'` and `'edit'`. This task adds a third permission level, `'list'`, to provide more granular access control. With list permission, users can see that content exists and view its metadata (title, status, etc.) without being able to read or edit the actual content.

## Current Behavior

**Permission Levels:**
- `'read'`: User can view content
- `'edit'`: User can modify content (implies read access)
- `'review'`: User can approve/merge changes (implies edit access)

**listEntriesHandler Behavior:**
- Checks `'read'` permission for each entry
- Filters out entries where `readAccess.allowed === false`
- Entries that pass read check include `canEdit` flag
- No indication of permission level is shown in the UI

## Proposed Changes

### 1. Add "list" Permission Level

**File**: [packages/canopycms/src/config.ts](packages/canopycms/src/config.ts)

Update `PermissionLevel` type:
```typescript
export type PermissionLevel = 'list' | 'read' | 'edit' | 'review'
```

**Permission Hierarchy:**
- `list` < `read` < `edit` < `review`
- Each higher level implies the lower levels
- `list` is the minimum permission to see that content exists

### 2. Update listEntriesHandler

**File**: [packages/canopycms/src/api/entries.ts](packages/canopycms/src/api/entries.ts)

**Update `CollectionItem` interface:**
```typescript
export interface CollectionItem {
  id: string
  slug: string
  collectionId: string
  collectionName: string
  format: ContentFormat
  entryType: string              // Entry type name (e.g., 'post', 'home')
  path: string
  title?: string
  updatedAt?: string
  exists?: boolean
  canRead?: boolean   // NEW: indicates if user has read permission
  canEdit?: boolean   // EXISTING: indicates if user has edit permission
}
```

**Update handler logic:**
Instead of filtering by read access, filter by list access and include both `canRead` and `canEdit` flags:

```typescript
// Example for recursive mode (line 266):
const listAccess = await ctx.services.checkContentAccess(context, root, item.path, req.user, 'list')
if (!listAccess.allowed) continue  // Filter by list, not read

const readAccess = await ctx.services.checkContentAccess(context, root, item.path, req.user, 'read')
const editAccess = await ctx.services.checkContentAccess(context, root, item.path, req.user, 'edit')

entries.push({
  ...item,
  canRead: readAccess.allowed,
  canEdit: editAccess.allowed
})

// Similar changes needed at lines 306 (entry types) and 343 (collections)
```

**Result:**
- Users with only `list` permission see entries in the navigator with restricted indicators
- Entries include both `canRead` and `canEdit` flags
- Navigator can show permission icons based on these flags

### 3. Update Editor Entry Interface

**File**: [packages/canopycms/src/editor/Editor.tsx](packages/canopycms/src/editor/Editor.tsx)

```typescript
export interface EditorEntry {
  id: string
  label: string
  status?: string
  schema: readonly FieldConfig[]
  apiPath: string
  previewSrc?: string
  collectionId?: string
  collectionName?: string
  slug?: string
  format?: ContentFormat
  entryType?: string
  canRead?: boolean   // NEW
  canEdit?: boolean   // EXISTING
}
```

### 4. Update Entry Building Logic

**File**: [packages/canopycms/src/editor/editor-utils.ts](packages/canopycms/src/editor/editor-utils.ts)

Update `buildEntriesFromListResponse` to include `canRead`:
```typescript
return {
  // ... existing fields
  canRead: entry.canRead,
  canEdit: entry.canEdit,
}
```

### 5. Update Editor Pane Logic

**File**: [packages/canopycms/src/editor/Editor.tsx](packages/canopycms/src/editor/Editor.tsx)

**Left Pane (Preview):**
```typescript
// Show message when user lacks read permission
const defaultPreview = !currentEntry ? (
  <Paper /* ... centered */>
    <Text>Select an item to start editing.</Text>
  </Paper>
) : currentEntry.canRead === false ? (
  <Paper /* ... centered */>
    <Text>You don't have permission to view this content.</Text>
  </Paper>
) : (
  // Normal preview rendering
)
```

**Right Pane (Form):**
```typescript
form={
  !currentEntry ? (
    <CenteredMessage>Select an item to start editing.</CenteredMessage>
  ) : currentEntry.canRead === false ? (
    <CenteredMessage>You don't have permission to view this content.</CenteredMessage>
  ) : currentEntry.canEdit === false ? (
    <CenteredMessage>You don't have permission to edit this content.</CenteredMessage>
  ) : schema.length > 0 && effectiveValue ? (
    <FormRenderer /* ... */ />
  ) : (
    <CenteredMessage>No fields to edit.</CenteredMessage>
  )
}
```

### 6. Add Permission Icons in Navigator

**File**: [packages/canopycms/src/editor/EntryNavigator.tsx](packages/canopycms/src/editor/EntryNavigator.tsx) (or similar)

Add visual indicators for entries with restricted permissions:

```typescript
import { IconEyeOff, IconLock } from '@tabler/icons-react'

// In the entry rendering logic:
const PermissionIcon = ({ entry }: { entry: EditorEntry }) => {
  if (entry.canRead === false) {
    return <IconEyeOff size={14} color="gray" title="No read access" />
  }
  if (entry.canEdit === false) {
    return <IconLock size={14} color="gray" title="Read-only" />
  }
  return null
}

// Use in entry list item:
<NavLink /* ... */>
  {entry.label}
  <PermissionIcon entry={entry} />
</NavLink>
```

**Icons:**
- `IconEyeOff` (eye with slash): User has list permission only (can see title, but can't read content)
- `IconLock`: User has read permission but not edit (read-only)
- No icon: User has edit permission (full access)

### 7. Update Path Permissions Type

**File**: [packages/canopycms/src/config.ts](packages/canopycms/src/config.ts)

Update `PathPermission` to support list level:
```typescript
export interface PathPermission {
  path: string
  list?: PathPermissionRule
  read?: PathPermissionRule
  edit?: PathPermissionRule
}
```

### 8. Update Permission Checking Logic

**File**: [packages/canopycms/src/path-permissions.ts](packages/canopycms/src/path-permissions.ts)

Update `checkPathAccess` to handle `'list'` level:
```typescript
export const checkPathAccess = (
  rules: PathPermission[],
  defaultAccess: DefaultPathAccess,
  params: { relativePath: string; user: CanopyUser; level: PermissionLevel }
): PathPermissionResult => {
  // ... existing logic ...

  // Check for 'list' level
  if (params.level === 'list') {
    // Similar logic as read/edit but check rule.list
  }

  // ... rest of logic
}
```

## Permission Matrix

| Permission Level | See in Navigator | View Title/Metadata | View Content | Edit Content |
|-----------------|-----------------|---------------------|--------------|--------------|
| None | ❌ | ❌ | ❌ | ❌ |
| List | ✅ (with 👁️‍🗨️) | ✅ | ❌ | ❌ |
| Read | ✅ (with 🔒) | ✅ | ✅ | ❌ |
| Edit | ✅ | ✅ | ✅ | ✅ |

## Use Cases

1. **Content Discovery**: Allow users to see what content exists without accessing sensitive data
2. **Team Coordination**: Team members can see structure and organization without full read access
3. **Workflow Visibility**: Users can see pending/published status without reading content
4. **Gradual Access**: Provide visibility before granting full read access

## Testing

Add tests for:
1. List permission filtering in `entries.test.ts`
2. `canRead` and `canEdit` flags in API response
3. Icon rendering in navigator based on permission flags
4. Message display in editor panes based on permission levels
5. Permission hierarchy (list < read < edit < review)

## Migration

**Breaking Change**: Existing path permissions that don't specify `list` level should default to:
- If `read` or `edit` is specified → `list` inherits the same rule
- If neither is specified → `list` uses `defaultPathAccess`

This ensures backward compatibility while enabling the new granularity.

## Benefits

✅ **More Granular Control**: Fine-tune who can see vs. read vs. edit content
✅ **Better Team Collaboration**: Visibility without access to sensitive data
✅ **Clear Visual Indicators**: Icons make permission level immediately clear
✅ **Backward Compatible**: Existing permissions continue to work with sensible defaults
✅ **Improved UX**: Users understand their access level at a glance
