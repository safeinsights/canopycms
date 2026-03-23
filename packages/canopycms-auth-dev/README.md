# canopycms-auth-dev

Development-only authentication provider for CanopyCMS that allows testing the CMS without setting up a real auth provider like Clerk.

**⚠️ Development Only**: This package throws an error if `NODE_ENV === 'production'`. Never use it in production.

## Features

- **Zero configuration**: Works out of the box with 5 default users
- **UI-based user switching**: Click avatar to switch between users in the editor
- **Test compatibility**: Supports `X-Test-User` header for Playwright tests
- **Group-based permissions**: Test team-based access control with external groups
- **Internal groups**: Configure reserved groups (Admins, Reviewers) via `.canopycms/groups.json`

## Installation

```bash
npm install canopycms-auth-dev
```

## Quick Start

### 1. Server-side Setup

Replace your auth plugin in the API route:

```ts
// app/lib/canopy.ts
import { createNextCanopyContext } from 'canopycms-next'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import configBundle from '../../canopycms.config'

const { handler } = createNextCanopyContext({
  config: configBundle.server,
  authPlugin: createDevAuthPlugin(),
})

export { handler }
```

### 2. Client-side Setup

Use the dev auth hook in your edit page:

```tsx
// app/edit/page.tsx
'use client'

import { useDevAuthConfig } from 'canopycms-auth-dev/client'
import { NextCanopyEditorPage } from 'canopycms-next/client'
import config from '../../canopycms.config'

export default function EditPage() {
  const devAuth = useDevAuthConfig()
  const clientConfig = config.client(devAuth)
  const EditorPage = NextCanopyEditorPage(clientConfig)
  return <EditorPage />
}
```

### 3. Configure Bootstrap Admins

Add admin1's user ID to your config:

```ts
// canopycms.config.ts
export default defineCanopyConfig({
  // ... other config
  bootstrapAdminIds: ['dev_admin_3xY6zW1qR5'], // admin1
})
```

### 4. Create Internal Groups (Optional)

For Reviewers and other internal groups, create `.canopycms/groups.json`:

```json
{
  "version": 1,
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "updatedBy": "canopycms-system",
  "groups": [
    {
      "id": "Reviewers",
      "name": "Reviewers",
      "description": "Users who can review and approve branches",
      "members": ["dev_reviewer_9aB4cD2eF7"]
    }
  ]
}
```

## Default Users

The plugin comes with 5 pre-configured users:

| User         | ID                        | Email                   | External Groups        |
| ------------ | ------------------------- | ----------------------- | ---------------------- |
| User One     | `dev_user1_2nK8mP4xL9`    | user1@localhost.dev     | team-a, team-b         |
| User Two     | `dev_user2_7qR3tY6wN2`    | user2@localhost.dev     | team-b                 |
| User Three   | `dev_user3_5vS1pM8kJ4`    | user3@localhost.dev     | team-c                 |
| Reviewer One | `dev_reviewer_9aB4cD2eF7` | reviewer1@localhost.dev | team-a                 |
| Admin One    | `dev_admin_3xY6zW1qR5`    | admin1@localhost.dev    | team-a, team-b, team-c |

**Note**: admin1 gets the 'Admins' group via `bootstrapAdminIds` config, not from external groups.

## User Switching

### In the UI

1. Open the editor (`/edit`)
2. Click the avatar button in the top-right
3. Select a user from the modal
4. Page reloads with the new user

### In Tests (Playwright)

Send the `X-Test-User` header with one of these values:

```ts
// In your test
await page.setExtraHTTPHeaders({
  'X-Test-User': 'admin', // Maps to admin1 (dev_admin_3xY6zW1qR5)
})
```

Test user mappings:

- `admin` → admin1 (dev_admin_3xY6zW1qR5)
- `editor` → user1 (dev_user1_2nK8mP4xL9)
- `viewer` → user2 (dev_user2_7qR3tY6wN2)
- `reviewer` → reviewer1 (dev_reviewer_9aB4cD2eF7)

## Configuration

Customize users and groups:

```ts
import { createDevAuthPlugin } from 'canopycms-auth-dev'

const authPlugin = createDevAuthPlugin({
  defaultUserId: 'dev_user1_2nK8mP4xL9', // user1
  users: [
    {
      userId: 'custom_user1',
      name: 'Custom User',
      email: 'custom@example.com',
      externalGroups: ['team-x'],
    },
  ],
  groups: [{ id: 'team-x', name: 'Team X', description: 'Custom team' }],
})
```

## How It Works

### Authentication Flow

1. **Request arrives** → Plugin checks for user identifier
2. **Priority order**:
   - `X-Test-User` header (for tests)
   - `x-dev-user-id` header (custom)
   - `canopy-dev-user` cookie (from UI)
   - Default user (user1)
3. **User lookup** → Find user in config
4. **Groups assigned**:
   - External groups (from auth plugin)
   - Bootstrap admin groups (from config)
   - Internal groups (from `.canopycms/groups.json`)

### Group Types

- **External groups**: Returned by auth plugin (e.g., team-a, team-b, team-c)
- **Bootstrap admins**: Added automatically from `bootstrapAdminIds` config
- **Internal groups**: Loaded from `.canopycms/groups.json` (managed by admins via UI)

### Reserved Groups

- **`Admins`**: Full access to all CMS operations
- **`Reviewers`**: Can review branches, request changes, approve PRs

## API

### `createDevAuthPlugin(config?)`

Factory function that creates a dev auth plugin.

**Parameters:**

- `config.users?` - Custom user list
- `config.groups?` - Custom group list
- `config.defaultUserId?` - Default user when none specified

**Returns:** `AuthPlugin`

### `useDevAuthConfig()`

React hook that provides editor configuration with user switcher.

**Returns:** `Pick<CanopyClientConfig, 'editor'>`

### Exports

```ts
// Server-side
export { createDevAuthPlugin, DevAuthPlugin, DEFAULT_USERS, DEFAULT_GROUPS }
export type { DevAuthConfig, DevUser, DevGroup }

// Client-side (import from 'canopycms-auth-dev/client')
export { useDevAuthConfig }
```

## Switching Between Auth Providers

You can configure your app to switch between dev auth and production auth (like Clerk) using environment variables:

### Server-side (app/lib/canopy.ts)

```ts
import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import type { AuthPlugin } from 'canopycms/auth'
import config from '../../canopycms.config'

function getAuthPlugin(): AuthPlugin {
  const authMode = process.env.CANOPY_AUTH_MODE || 'dev'

  if (authMode === 'dev') {
    return createDevAuthPlugin()
  }

  if (authMode === 'clerk') {
    return createClerkAuthPlugin({
      useOrganizationsAsGroups: true,
    })
  }

  throw new Error(`Invalid CANOPY_AUTH_MODE: "${authMode}". Must be "dev" or "clerk".`)
}

const canopyContext = createNextCanopyContext({
  config: config.server,
  authPlugin: getAuthPlugin(),
})

export const getCanopy = canopyContext.getCanopy
export const handler = canopyContext.handler
```

### Client-side (app/edit/page.tsx)

```tsx
'use client'

import { useClerkAuthConfig } from 'canopycms-auth-clerk/client'
import { useDevAuthConfig } from 'canopycms-auth-dev/client'
import { NextCanopyEditorPage } from 'canopycms-next/client'
import config from '../../canopycms.config'

function useAuthConfig() {
  const authMode = process.env.NEXT_PUBLIC_CANOPY_AUTH_MODE || 'dev'

  if (authMode === 'dev') {
    return useDevAuthConfig()
  }

  if (authMode === 'clerk') {
    return useClerkAuthConfig()
  }

  throw new Error(`Invalid NEXT_PUBLIC_CANOPY_AUTH_MODE: "${authMode}". Must be "dev" or "clerk".`)
}

export default function EditPage() {
  const authConfig = useAuthConfig()
  const clientConfig = config.client(authConfig)
  const EditorPage = NextCanopyEditorPage(clientConfig)
  return <EditorPage />
}
```

### Environment Configuration

**Default: Dev auth is enabled by default** (no configuration needed)

To switch to Clerk, create `.env.local`:

```bash
# Use Clerk authentication
CANOPY_AUTH_MODE=clerk
NEXT_PUBLIC_CANOPY_AUTH_MODE=clerk

# Clerk configuration
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_key
CLERK_SECRET_KEY=your_secret

# Bootstrap admin (use your Clerk user ID)
CANOPY_BOOTSTRAP_ADMIN_IDS=user_xxxxxxxxxxxxx
```

To switch back to dev auth, just remove `.env.local` or set the mode to `dev`.

**Optional dev auth configuration** (`.env.local`):

```bash
# Bootstrap admin for dev mode
CANOPY_BOOTSTRAP_ADMIN_IDS=dev_admin_3xY6zW1qR5
```

### Benefits

- **No code changes**: Switch auth modes by changing environment variables
- **Team flexibility**: Developers can use dev auth locally while staging/production uses Clerk
- **Easy testing**: Quickly test features without auth provider setup
- **Clean separation**: Same codebase works with multiple auth providers

## Production Safety

⚠️ **WARNING**: This plugin is for development and testing only. Do not use in production environments.

## License

MIT
