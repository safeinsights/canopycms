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
  roleMetadataKey: 'canopyRole',
  useOrganizationsAsGroups: true,
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
   * Field in public metadata for role mapping
   * @default 'canopyRole'
   */
  roleMetadataKey?: string

  /**
   * Use organizations as groups
   * @default true
   */
  useOrganizationsAsGroups?: boolean
}
```

### Setting User Roles

Add a role to a user's public metadata in Clerk (e.g., via the Clerk Dashboard):

```json
{
  "canopyRole": "admin"
}
```

Supported roles: `admin`, `manager`, `editor`

### Using Organizations as Groups

When `useOrganizationsAsGroups` is enabled (default), Clerk organizations are automatically mapped to CanopyCMS groups for permission management.

## Example App Integration

See the [example app](../../examples/one) for a complete integration example.

## License

MIT
