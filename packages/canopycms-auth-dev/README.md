# canopycms-auth-dev

Development-only authentication provider for CanopyCMS that allows testing the CMS without setting up a real auth provider like Clerk.

> **Status**: This package is a placeholder with an implementation spec. See below for details on what needs to be built.

## Purpose

This package provides a mock authentication plugin for local development and testing. It allows developers to:

- Test CanopyCMS features without configuring a real auth provider
- Switch between different mock users with different roles
- Test permission-based features with various role/group combinations

## Installation (Future)

```bash
npm install canopycms-auth-dev
```

## Usage (Future)

### Server-side (API route)

```ts
// app/api/canopycms/[...canopycms]/route.ts
import { createCanopyHandler } from 'canopycms/next'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import configBundle from '../../../../canopycms.config'

const handler = createCanopyHandler({
  config: configBundle.server,
  authPlugin: createDevAuthPlugin(),
})

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
```

### Client-side (Edit page)

```tsx
// app/edit/[[...slug]]/page.tsx
import { useDevAuthConfig } from 'canopycms-auth-dev/client'
import { CanopyEditorPage } from 'canopycms/client'
import config from '../../../canopycms.config'

export default function EditPage() {
  const devAuth = useDevAuthConfig()
  const editorConfig = config.client(devAuth)
  return <CanopyEditorPage config={editorConfig} />
}
```

---

## Implementation Spec

### Server Plugin (`src/dev-plugin.ts`)

#### Factory Function

```ts
export function createDevAuthPlugin(config?: DevAuthConfig): AuthPlugin
```

#### Production Guard

The plugin MUST throw an error on instantiation if `NODE_ENV === 'production'`:

```ts
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'canopycms-auth-dev: This plugin is for development only and cannot be used in production',
  )
}
```

#### Configuration

```ts
interface DevAuthConfig {
  /**
   * Custom mock users. If not provided, uses default users.
   */
  users?: Array<{
    userId: string
    name: string
    email: string
    role: 'admin' | 'manager' | 'editor'
    groups?: string[]
  }>

  /**
   * Custom mock groups. If not provided, uses default groups.
   */
  groups?: Array<{
    id: string
    name: string
    description?: string
  }>

  /**
   * Default user ID when no user is selected.
   * @default 'dev-admin'
   */
  defaultUserId?: string
}
```

#### Default Users

```ts
const DEFAULT_USERS = [
  {
    userId: 'dev-admin',
    name: 'Dev Admin',
    email: 'admin@localhost',
    role: 'admin',
    groups: ['engineering', 'marketing', 'content'],
  },
  {
    userId: 'dev-manager',
    name: 'Dev Manager',
    email: 'manager@localhost',
    role: 'manager',
    groups: ['engineering'],
  },
  {
    userId: 'dev-editor',
    name: 'Dev Editor',
    email: 'editor@localhost',
    role: 'editor',
    groups: ['content'],
  },
]
```

#### Default Groups

```ts
const DEFAULT_GROUPS = [
  { id: 'engineering', name: 'Engineering', description: 'Engineering team' },
  { id: 'marketing', name: 'Marketing', description: 'Marketing team' },
  { id: 'content', name: 'Content', description: 'Content team' },
]
```

#### AuthPlugin Implementation

The plugin must implement the `AuthPlugin` interface from `canopycms/auth`:

```ts
interface AuthPlugin {
  verifyToken(req: NextRequest): Promise<TokenVerificationResult>
  searchUsers(query: string, limit?: number): Promise<UserSearchResult[]>
  getUserMetadata(userId: string): Promise<UserSearchResult | null>
  getGroupMetadata(groupId: string): Promise<GroupMetadata | null>
  listGroups(limit?: number): Promise<GroupMetadata[]>
}
```

##### `verifyToken(req: NextRequest)`

1. Read user ID from `x-dev-user-id` header OR `canopy-dev-user` cookie
2. If no user specified, use `defaultUserId`
3. Find user in configured users list
4. Return `{ valid: true, user: AuthUser }` or `{ valid: false, error: 'User not found' }`

```ts
async verifyToken(req: NextRequest): Promise<TokenVerificationResult> {
  const userId = req.headers.get('x-dev-user-id')
    ?? req.cookies.get('canopy-dev-user')?.value
    ?? this.config.defaultUserId
    ?? 'dev-admin'

  const user = this.users.find(u => u.userId === userId)
  if (!user) {
    return { valid: false, error: `Dev user not found: ${userId}` }
  }

  return {
    valid: true,
    user: {
      userId: user.userId,
      role: user.role,
      groups: user.groups,
      email: user.email,
      name: user.name,
    },
  }
}
```

##### `searchUsers(query: string, limit?: number)`

Filter mock users by name or email containing the query string (case-insensitive).

##### `getUserMetadata(userId: string)`

Return mock user by ID, or null if not found.

##### `getGroupMetadata(groupId: string)`

Return mock group by ID, or null if not found.

##### `listGroups(limit?: number)`

Return all mock groups (apply limit if specified).

---

### Client Component (`src/client.ts`)

#### Hook

```ts
'use client'

export function useDevAuthConfig(): Pick<CanopyClientConfig, 'editor'>
```

Returns configuration for the CanopyCMS editor with:

- `AccountComponent`: A React component that renders a user avatar/button that opens a user-switcher modal
- `onLogoutClick`: Function that resets to the default user

#### AccountComponent

The account component should:

1. Display current user's avatar or initials
2. On click, open a Mantine modal with the user switcher

#### User Switcher Modal

Using Mantine components, the modal should display:

- Title: "Switch User"
- List of available mock users with:
  - User name and email
  - Role badge (admin/manager/editor with appropriate colors)
  - Group chips
  - Checkmark or highlight for current user
- Click on a user to switch (sets `canopy-dev-user` cookie)
- Close button

```tsx
// Pseudocode structure
<Modal title="Switch User" opened={opened} onClose={close}>
  <Stack>
    {users.map((user) => (
      <Paper
        key={user.userId}
        onClick={() => switchUser(user.userId)}
        style={{ cursor: 'pointer' }}
      >
        <Group>
          <Avatar>{user.name[0]}</Avatar>
          <div>
            <Text>{user.name}</Text>
            <Text size="sm" c="dimmed">
              {user.email}
            </Text>
          </div>
          <Badge color={roleColor(user.role)}>{user.role}</Badge>
          {user.userId === currentUserId && <IconCheck />}
        </Group>
        <Group gap="xs">
          {user.groups?.map((g) => (
            <Badge key={g} variant="outline" size="sm">
              {g}
            </Badge>
          ))}
        </Group>
      </Paper>
    ))}
  </Stack>
</Modal>
```

#### Cookie Management

```ts
function switchUser(userId: string) {
  document.cookie = `canopy-dev-user=${userId}; path=/; max-age=${60 * 60 * 24 * 7}` // 7 days
  window.location.reload() // Refresh to apply new user
}

function resetToDefault() {
  document.cookie = 'canopy-dev-user=; path=/; max-age=0'
  window.location.reload()
}
```

---

## Package Structure (To Be Created)

```
packages/canopycms-auth-dev/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── README.md              # This file
└── src/
    ├── index.ts           # Server exports: createDevAuthPlugin, DevAuthConfig
    ├── dev-plugin.ts      # AuthPlugin implementation
    ├── client.ts          # Client exports: useDevAuthConfig
    └── UserSwitcher.tsx   # Mantine modal component
```

## package.json (To Be Created)

```json
{
  "name": "canopycms-auth-dev",
  "version": "0.0.0",
  "description": "Development authentication provider for CanopyCMS",
  "license": "MIT",
  "private": false,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client.ts"
  },
  "peerDependencies": {
    "canopycms": "*",
    "react": "^18.0.0",
    "@mantine/core": "^7.0.0",
    "@mantine/hooks": "^7.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@types/react": "^18.0.0",
    "typescript": "^5.6.3",
    "vitest": "^1.6.0"
  }
}
```

---

## Testing Recommendations

1. **Unit tests for dev-plugin.ts**:
   - Production guard throws error
   - verifyToken returns correct user from header
   - verifyToken returns correct user from cookie
   - verifyToken returns default user when none specified
   - searchUsers filters correctly
   - getUserMetadata returns user or null
   - listGroups returns all groups

2. **Component tests for UserSwitcher.tsx**:
   - Renders list of users
   - Highlights current user
   - Calls switchUser on click
   - Sets cookie correctly

3. **Integration tests**:
   - Plugin works with createCanopyHandler
   - User switching persists across requests
