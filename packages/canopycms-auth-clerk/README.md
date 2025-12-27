# canopycms-auth-clerk

Clerk authentication provider for CanopyCMS.

## Installation

```bash
npm install canopycms canopycms-auth-clerk @clerk/nextjs
```

## Usage

### Basic Setup

```typescript
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import { createCanopyHandler } from 'canopycms/next'

const authPlugin = createClerkAuthPlugin({
  secretKey: process.env.CLERK_SECRET_KEY,
  useOrganizationsAsGroups: true, // Map Clerk organizations to CMS groups
})

const handler = createCanopyHandler({
  config,
  authPlugin,
  // ...
})
```

### Configuration Options

```typescript
interface ClerkAuthConfig {
  /**
   * Clerk secret key (defaults to process.env.CLERK_SECRET_KEY)
   */
  secretKey?: string

  /**
   * Use organizations as groups
   * @default true
   */
  useOrganizationsAsGroups?: boolean
}
```

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

See the [example app](../../examples/one) for a complete integration example.

## License

MIT
