# Auth Provider Refactoring Plan

**Created**: 2024-12-21
**Status**: Planning
**Priority**: High (after current auth integration completion)
**Estimated Effort**: 4-6 hours

---

## Problem Statement

The current Clerk authentication integration has architectural issues that conflict with the goal of supporting multiple auth providers:

### Issues with Current Architecture

1. **Package Dependency Problems**:
   - `@clerk/nextjs` is an optional peer dependency in the core `canopycms` package
   - Example apps need direct imports from `@clerk/nextjs` (e.g., `ClerkProvider`)
   - npm workspace hoisting causes `@clerk/nextjs` to not be available in example app's node_modules
   - Next.js can't resolve the package even though it exists in workspace root

2. **Coupling in Core Package**:
   - Clerk-specific code lives in [packages/canopycms/src/auth/providers/clerk.ts](../../packages/canopycms/src/auth/providers/clerk.ts)
   - Core package has optional dependency on `@clerk/nextjs`
   - Creates maintenance burden (testing optional dependencies)
   - Violates separation of concerns (auth provider is extension, not core)

3. **Example App Coupling**:
   - Example's [layout.tsx](../../packages/canopycms/examples/one/app/layout.tsx) directly imports `ClerkProvider`
   - Cannot demonstrate other auth providers without duplicating examples
   - "Pluggable auth" is internal to canopycms, not exposed to adopters

4. **Lazy Loading Complexity**:
   - [src/auth/index.ts](../../packages/canopycms/src/auth/index.ts) uses `loadClerkAuthPlugin()` to lazy-load Clerk
   - Dynamic imports with webpack ignore comments (`/* webpackIgnore: true */`)
   - Adds complexity without solving the fundamental architecture issue

### User Impact

- Adopters who want different auth (Auth0, NextAuth, Supabase, custom) must:
  - Still have Clerk as a peer dependency (even if unused)
  - Work around npm resolution issues
  - Navigate confusing "optional but still coupled" architecture

---

## Proposed Solution: Separate Auth Provider Packages

**Move auth provider implementations to separate npm packages:**

```
packages/
  canopycms/                    # Core - NO auth provider code
  canopycms-auth-clerk/         # Separate package for Clerk
  canopycms-auth-nextauth/      # Future: NextAuth package
  canopycms-auth-supabase/      # Future: Supabase package
```

### Benefits

1. ✅ **Clean separation**: Core package has zero auth provider dependencies
2. ✅ **Explicit choice**: Adopters explicitly install and import the auth package they need
3. ✅ **No npm resolution issues**: Each auth package manages its own dependencies
4. ✅ **Easier maintenance**: Auth provider updates don't affect core
5. ✅ **Clear examples**: Example apps explicitly show which auth system they use
6. ✅ **Follows industry patterns**: Similar to Prisma adapters, NextAuth providers
7. ✅ **Future-proof**: New auth providers don't touch core package

---

## Implementation Plan

### Phase 1: Create `canopycms-auth-clerk` Package (2-3 hours)

**1.1: Create package structure**

Create new package at `packages/canopycms-auth-clerk/`:

```
packages/canopycms-auth-clerk/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── src/
│   ├── index.ts              # Public API
│   ├── clerk-plugin.ts       # ClerkAuthPlugin class
│   └── clerk-plugin.test.ts  # Tests
├── dist/                      # Build output
└── README.md
```

**1.2: Setup package.json**

```json
{
  "name": "canopycms-auth-clerk",
  "version": "0.0.0",
  "description": "Clerk authentication provider for CanopyCMS",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "files": ["dist"],
  "peerDependencies": {
    "canopycms": "workspace:*",
    "@clerk/nextjs": "^5.0.0 || ^6.0.0",
    "next": "^14.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "typescript": "^5.6.3",
    "vitest": "^1.6.0"
  }
}
```

**Key points**:

- `canopycms` is a peer dependency (not bundled)
- `@clerk/nextjs` is a **required** peer dependency (not optional)
- No lazy loading needed - consumers explicitly install this package

**1.3: Move Clerk implementation**

**Copy from**:

- [packages/canopycms/src/auth/providers/clerk.ts](../../packages/canopycms/src/auth/providers/clerk.ts) → `packages/canopycms-auth-clerk/src/clerk-plugin.ts`
- [packages/canopycms/src/auth/providers/clerk.test.ts](../../packages/canopycms/src/auth/providers/clerk.test.ts) → `packages/canopycms-auth-clerk/src/clerk-plugin.test.ts`

**Update imports**:

```typescript
// In clerk-plugin.ts
import type { NextRequest } from 'next/server'
import type { AuthPlugin } from 'canopycms/auth' // Import from core
import type {
  AuthUser,
  UserSearchResult,
  GroupMetadata,
  TokenVerificationResult,
} from 'canopycms/auth'
import type { Role, CanopyUserId, CanopyGroupId } from 'canopycms'
```

**Simplify lazy loading** (NO MORE NEEDED):

```typescript
// Before (in core package - complex lazy loading)
let clerkClientPromise: Promise<any> | null = null
function getClerkClient() {
  if (!clerkClientPromise) {
    const clerkPackage = ['@clerk/nextjs', 'server'].join('/')
    clerkClientPromise = import(/* webpackIgnore: true */ clerkPackage)
      .then((mod: any) => mod.clerkClient)
      .catch(() => {
        throw new Error('...')
      })
  }
  return clerkClientPromise
}

// After (in separate package - direct import!)
import { clerkClient } from '@clerk/nextjs/server'

export class ClerkAuthPlugin implements AuthPlugin {
  async verifyToken(req: NextRequest): Promise<TokenVerificationResult> {
    // Direct usage, no lazy loading needed
    const session = await clerkClient.sessions.verifySession(sessionToken)
    // ...
  }
}
```

**1.4: Public API** (`packages/canopycms-auth-clerk/src/index.ts`):

```typescript
export { ClerkAuthPlugin } from './clerk-plugin'
export { createClerkAuthPlugin } from './clerk-plugin'
export type { ClerkAuthConfig } from './clerk-plugin'
```

**1.5: Add to workspace**

Update root `package.json` workspaces:

```json
{
  "workspaces": ["packages/*", "apps/*", "packages/canopycms/examples/*"]
}
```

This already includes `packages/*`, so no change needed.

---

### Phase 2: Update Core Package (1 hour)

**2.1: Remove Clerk-specific code**

**Delete files**:

- `packages/canopycms/src/auth/providers/clerk.ts`
- `packages/canopycms/src/auth/providers/clerk.test.ts`

**2.2: Remove lazy loading helper**

**Update** [packages/canopycms/src/auth/index.ts](../../packages/canopycms/src/auth/index.ts):

```typescript
// Before:
export async function loadClerkAuthPlugin() {
  const mod = await import('./providers/clerk')
  return {
    ClerkAuthPlugin: mod.ClerkAuthPlugin,
    createClerkAuthPlugin: mod.createClerkAuthPlugin,
  }
}

// After: REMOVE THIS FUNCTION ENTIRELY
```

Update exports to only include types:

```typescript
// packages/canopycms/src/auth/index.ts
export type { AuthPlugin, AuthPluginFactory } from './plugin'
export type { AuthUser, UserSearchResult, GroupMetadata, TokenVerificationResult } from './types'
```

**2.3: Remove Clerk peer dependency**

**Update** [packages/canopycms/package.json](../../packages/canopycms/package.json):

```json
// REMOVE these lines:
"peerDependencies": {
  "@clerk/nextjs": "^5.0.0"
},
"peerDependenciesMeta": {
  "@clerk/nextjs": {
    "optional": true
  }
}
```

**2.4: Add export for auth types**

**Update** [packages/canopycms/package.json](../../packages/canopycms/package.json) exports:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client.ts",
    "./next": "./src/next/api.ts",
    "./auth": "./src/auth/index.ts" // NEW: Allow importing auth types
  }
}
```

---

### Phase 3: Update Example App (30 minutes)

**3.1: Add auth provider package dependency**

**Update** [packages/canopycms/examples/one/package.json](../../packages/canopycms/examples/one/package.json):

```json
{
  "dependencies": {
    "@clerk/nextjs": "^6.36.5",
    "canopycms": "file:../../",
    "canopycms-auth-clerk": "file:../../canopycms-auth-clerk", // NEW
    "next": "14.2.25",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
```

**3.2: Update route handler**

**Update** [packages/canopycms/examples/one/app/api/canopycms/[...canopycms]/route.ts](../../packages/canopycms/examples/one/app/api/canopycms/[...canopycms]/route.ts):

```typescript
// Before:
import { BranchWorkspaceManager, loadBranchState, loadClerkAuthPlugin } from 'canopycms'
const { createClerkAuthPlugin } = await loadClerkAuthPlugin()
const authPlugin = createClerkAuthPlugin({ ... })

// After (cleaner!):
import { BranchWorkspaceManager, loadBranchState } from 'canopycms'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'

const authPlugin = createClerkAuthPlugin({
  secretKey: process.env.CLERK_SECRET_KEY,
  roleMetadataKey: 'canopyRole',
  useOrganizationsAsGroups: true,
})
```

**3.3: Update layout (NO CHANGE NEEDED)**

The [layout.tsx](../../packages/canopycms/examples/one/app/layout.tsx) already imports from `@clerk/nextjs` directly:

```typescript
import { ClerkProvider } from '@clerk/nextjs'
```

This is correct - `ClerkProvider` comes from Clerk's package, not ours.

**3.4: Run npm install**

```bash
cd /path/to/canopycms
rm -rf node_modules package-lock.json
npm install
```

This will:

- Install `@clerk/nextjs` as a direct dependency of the example
- Install `canopycms-auth-clerk` package
- Resolve all dependencies correctly in node_modules

---

### Phase 4: Testing & Verification (1 hour)

**4.1: Run tests**

```bash
# Test the new auth package
npm test --workspace=canopycms-auth-clerk

# Test core package (Clerk tests should be gone)
npm test --workspace=canopycms

# Build everything
npm run build
```

**4.2: Verify example app**

```bash
cd packages/canopycms/examples/one
npm run dev
```

**Test checklist**:

- ✅ App starts without errors
- ✅ `@clerk/nextjs` resolves correctly
- ✅ Clerk auth plugin works
- ✅ GroupManager and PermissionManager load
- ✅ User search works via Clerk
- ✅ Organization search works

**4.3: Verify package resolution**

```bash
# Check that @clerk/nextjs exists in node_modules
ls -la node_modules/@clerk/nextjs

# Should exist in workspace root OR in example's node_modules
# (npm will hoist or keep local depending on version conflicts)
```

---

### Phase 5: Documentation (30 minutes)

**5.1: Update README for new package**

Create [packages/canopycms-auth-clerk/README.md](../../packages/canopycms-auth-clerk/README.md):

````markdown
# canopycms-auth-clerk

Clerk authentication provider for CanopyCMS.

## Installation

```bash
npm install canopycms canopycms-auth-clerk @clerk/nextjs
```
````

## Usage

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

## Configuration

See [CanopyCMS Auth Documentation](../canopycms/docs/auth.md) for details.

````

**5.2: Update core package README**

Update [packages/canopycms/README.md](../../packages/canopycms/README.md) auth section:

```markdown
## Authentication

CanopyCMS has a pluggable authentication system. Install an auth provider package:

- **Clerk**: `npm install canopycms-auth-clerk @clerk/nextjs`
- **NextAuth** _(coming soon)_: `npm install canopycms-auth-nextauth`
- **Supabase** _(coming soon)_: `npm install canopycms-auth-supabase`

Example usage:

```typescript
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'

const authPlugin = createClerkAuthPlugin({
  secretKey: process.env.CLERK_SECRET_KEY,
})
````

See [packages/canopycms-auth-clerk](../canopycms-auth-clerk) for Clerk-specific docs.

````

**5.3: Update auth integration plan**

Add reference to this plan in [.claude/plans/auth-integration.md](.claude/plans/auth-integration.md):

```markdown
## Related Plans

- **[Auth Provider Refactoring](.claude/plans/auth-provider-refactor.md)** - Plan to move Clerk to separate package (high priority after current work)
````

---

## Files Changed Summary

### New Files

- `packages/canopycms-auth-clerk/package.json`
- `packages/canopycms-auth-clerk/tsconfig.json`
- `packages/canopycms-auth-clerk/tsconfig.build.json`
- `packages/canopycms-auth-clerk/src/index.ts`
- `packages/canopycms-auth-clerk/src/clerk-plugin.ts` (moved from core)
- `packages/canopycms-auth-clerk/src/clerk-plugin.test.ts` (moved from core)
- `packages/canopycms-auth-clerk/README.md`

### Deleted Files

- `packages/canopycms/src/auth/providers/clerk.ts`
- `packages/canopycms/src/auth/providers/clerk.test.ts`

### Modified Files

- `packages/canopycms/src/auth/index.ts` - Remove `loadClerkAuthPlugin()` function
- `packages/canopycms/package.json` - Remove Clerk peer dependency, add auth export
- `packages/canopycms/README.md` - Update auth documentation
- `packages/canopycms/examples/one/package.json` - Add canopycms-auth-clerk dependency
- `packages/canopycms/examples/one/app/api/canopycms/[...canopycms]/route.ts` - Update imports
- `.claude/plans/auth-integration.md` - Add reference to this plan
- `.claude/plans/overall-plan.md` - Add reference to this plan in backlog

---

## Future Auth Provider Packages

Once this pattern is established, adding new auth providers is straightforward:

### canopycms-auth-nextauth (Future)

```typescript
// packages/canopycms-auth-nextauth/src/index.ts
import type { AuthPlugin } from 'canopycms/auth'
import NextAuth from 'next-auth'

export function createNextAuthPlugin(config: NextAuthConfig): AuthPlugin {
  // Implementation using NextAuth API
}
```

**Package dependencies**:

```json
{
  "peerDependencies": {
    "canopycms": "workspace:*",
    "next-auth": "^4.0.0 || ^5.0.0"
  }
}
```

### canopycms-auth-supabase (Future)

```typescript
// packages/canopycms-auth-supabase/src/index.ts
import type { AuthPlugin } from 'canopycms/auth'
import { createClient } from '@supabase/supabase-js'

export function createSupabaseAuthPlugin(config: SupabaseConfig): AuthPlugin {
  // Implementation using Supabase API
}
```

**Package dependencies**:

```json
{
  "peerDependencies": {
    "canopycms": "workspace:*",
    "@supabase/supabase-js": "^2.0.0"
  }
}
```

---

## Migration Guide for Adopters

For existing CanopyCMS users who have Clerk integration:

### Before (current setup):

```typescript
import { loadClerkAuthPlugin } from 'canopycms'
const { createClerkAuthPlugin } = await loadClerkAuthPlugin()
```

### After (new setup):

```bash
npm install canopycms-auth-clerk
```

```typescript
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
```

**Breaking change**: Yes, but minimal impact

- Only affects route handler file (one import change)
- Auth plugin API remains unchanged
- All existing auth logic continues to work

---

## Success Criteria

- ✅ `canopycms-auth-clerk` package builds successfully
- ✅ All Clerk auth tests pass in new package
- ✅ Core `canopycms` package has zero Clerk dependencies
- ✅ Example app works with new package structure
- ✅ No npm resolution errors
- ✅ `@clerk/nextjs` can be directly imported in example app
- ✅ Documentation updated
- ✅ Pattern established for future auth providers

---

## Benefits Summary

**For CanopyCMS Core**:

- Cleaner codebase (no optional dependencies)
- Faster to understand (auth is clearly external)
- Easier to maintain (auth provider updates don't affect core)

**For Adopters**:

- Explicit choice of auth system
- No confusion about "optional but coupled" dependencies
- Clear package boundaries
- Standard npm dependency resolution

**For Future Development**:

- Pattern established for new auth providers
- No changes to core package needed for new auth systems
- Community can contribute auth providers independently

---

## Timeline

**Total Estimated Effort**: 4-6 hours

1. **Phase 1**: Create canopycms-auth-clerk package (2-3 hours)
2. **Phase 2**: Update core package (1 hour)
3. **Phase 3**: Update example app (30 minutes)
4. **Phase 4**: Testing & verification (1 hour)
5. **Phase 5**: Documentation (30 minutes)

**Recommended Schedule**: Execute after current auth integration work is complete and tested.

---

## Related Plans

- **[Overall Plan](./overall-plan.md)** - Overall project roadmap
- **[Auth Integration](./auth-integration.md)** - Current auth implementation (complete this first)

---

## Approval & Next Steps

**Ready to execute when**:

1. Current auth integration is complete and working
2. All tests passing
3. Example app demonstrates Clerk integration
4. User approves this refactoring approach

**To begin implementation**:

1. Create todo list from phases above
2. Execute Phase 1-5 sequentially
3. Run full test suite
4. Verify example app works
5. Update master plan to mark this complete
