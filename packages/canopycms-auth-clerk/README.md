# canopycms-auth-clerk

Clerk authentication provider for CanopyCMS.

## Installation

```bash
npm install canopycms canopycms-auth-clerk @clerk/nextjs
```

## Usage

### Basic Setup

In `app/lib/canopy.ts`, pass the plugin to `createNextCanopyContext` and re-export its
handler from your catch-all API route:

```typescript
import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

const authPlugin = createClerkAuthPlugin({
  useOrganizationsAsGroups: true, // Map Clerk organizations to CMS groups
})

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin,
  entrySchemaRegistry,
})

export const getHandler = async () => (await canopyContextPromise).handler
```

`apps/example1/app/lib/canopy.ts` is the full reference wiring, including the
fail-closed dev/Clerk plugin selection.

### Editor sign-in

`useClerkAuthConfig()` (from `canopycms-auth-clerk/client`) supplies the editor's account
button (Clerk's `UserButton`) and its sign-in screen (`ClerkSignIn`, wrapping Clerk's
`<SignIn>`). Signed-out users get Clerk's sign-in in place of the editor; when a session
lapses mid-edit it reappears over the open editor, and unsaved edits survive signing back
in as the same user. It all runs in the browser on the publishable key, so
`clerkMiddleware` is optional. See the root README's
[Protect editor routes](../../README.md#5-protect-editor-routes) for when to adopt it: it
requires `CLERK_SECRET_KEY` in the CMS runtime.

To customize Clerk's `<SignIn>` (appearance, sign-up URL), override the component at
module scope; `routing` and the return URL stay fixed so sign-in returns to the editor:

```tsx
import { ClerkSignIn, useClerkAuthConfig } from 'canopycms-auth-clerk/client'
import type { EditorSignInProps } from 'canopycms/client'

const SignIn = (p: EditorSignInProps) => <ClerkSignIn {...p} signInProps={{ appearance }} />
// in the edit page:
const clerkAuth = useClerkAuthConfig()
config.client({ editor: { ...clerkAuth.editor, SignInComponent: SignIn } })
```

### Configuration Options

```typescript
interface ClerkAuthConfig {
  /** Clerk secret key (defaults to process.env.CLERK_SECRET_KEY). */
  secretKey?: string
  /** Public PEM for networkless JWT verification (defaults to process.env.CLERK_JWT_KEY). */
  jwtKey?: string
  /** Allowed token origins (defaults to process.env.CLERK_AUTHORIZED_PARTIES). */
  authorizedParties?: string[]
  /** Use organizations as groups. @default true */
  useOrganizationsAsGroups?: boolean
}
```

Under `createNextCanopyContext` in prod and dev mode, requests are verified by
`verifyTokenOnly()` from `jwtKey` alone, with no network. `secretKey` is read only where
Clerk's API is called: refreshing the user/group cache (the worker, in prod) and
`authenticate()` when the plugin is used unwrapped. A deployed CMS runtime therefore needs
no secret.

### Groups-Only Permission Model

CanopyCMS uses a groups-only permission model. The Clerk plugin extracts the user ID and group memberships from Clerk organizations:

- **User ID**: Clerk's `userId` is used as the CMS user identifier
- **Groups**: When `useOrganizationsAsGroups` is enabled, Clerk organization memberships are returned as group names

### Reserved Groups in CanopyCMS

CanopyCMS uses reserved groups for permissions:

- **Admins**: Full access to all operations (manage groups, merge PRs, delete branches, etc.)
- **Reviewers**: Can review branches, request changes, approve PRs

To grant admin access to a user, add them to the "Admins" group in CanopyCMS's group management UI, or use the bootstrap admin mechanism:

```bash
# Set bootstrap admins via environment variable
CANOPY_BOOTSTRAP_ADMIN_IDS=user_abc123,user_def456
```

Bootstrap admins are automatically treated as members of the Admins group, even before the group system is configured.

### Using Organizations as Groups

When `useOrganizationsAsGroups` is enabled (default), Clerk organizations are automatically mapped to CanopyCMS groups for permission management. Create an organization named "Admins" or "Reviewers" in Clerk and add users to grant them those permissions.

## Example App Integration

See the [example app](../../apps/example1) for a complete integration example.

## License

MIT
