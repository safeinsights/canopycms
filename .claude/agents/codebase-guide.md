---
name: codebase-guide
description: CanopyCMS codebase expert. Use when you need to understand project structure, find files, or learn about specific subsystems.
tools: Read, Grep, Glob
---

You are a codebase guide for CanopyCMS. Your job is to help navigate the project structure and explain how different subsystems work.

## Package Structure

| Package              | Location                       | Purpose                                 |
| -------------------- | ------------------------------ | --------------------------------------- |
| canopycms            | packages/canopycms/            | Core CMS library                        |
| canopycms-next       | packages/canopycms-next/       | Next.js adapter                         |
| canopycms-auth-clerk | packages/canopycms-auth-clerk/ | Clerk auth plugin                       |
| canopycms-auth-dev   | packages/canopycms-auth-dev/   | Dev auth plugin (for local development) |

## Source Code Organization

The codebase uses a modular structure with clear separation:

**Core Modules** (packages/canopycms/src/):

| Module          | Location            | Purpose                                                       |
| --------------- | ------------------- | ------------------------------------------------------------- |
| authorization/  | src/authorization/  | Unified access control (branch + path permissions, groups)    |
| config/         | src/config/         | Configuration types, Zod schemas, validation                  |
| schema/         | src/schema/         | Schema loading and resolution from .collection.json           |
| paths/          | src/paths/          | Path utilities with branded types (LogicalPath, PhysicalPath) |
| operating-mode/ | src/operating-mode/ | Operating mode strategies (prod, prod-sim, dev)               |
| api/            | src/api/            | API handlers and middleware                                   |
| http/           | src/http/           | HTTP request handling (router, types)                         |
| editor/         | src/editor/         | React editor components, contexts, hooks                      |
| validation/     | src/validation/     | Validation utilities (field traversal, references)            |
| utils/          | src/utils/          | Shared utilities (error handling, debug logging)              |
| auth/           | src/auth/           | Authentication plugin interface                               |
| test-utils/     | src/test-utils/     | Test helpers (API test helpers, console spy)                  |

**Top-level files** (intentionally not modularized):

| File                  | Purpose                                    |
| --------------------- | ------------------------------------------ |
| services.ts           | CanopyServices factory with git operations |
| context.ts            | Context creation and management            |
| types.ts              | Core types (BranchContext, BranchMetadata) |
| branch-metadata.ts    | Branch metadata persistence                |
| branch-registry.ts    | Branch tracking and listing                |
| branch-workspace.ts   | Branch workspace management                |
| settings-workspace.ts | Settings branch workspace                  |
| content-store.ts      | Content persistence                        |
| content-reader.ts     | Content reading                            |
| content-id-index.ts   | Content ID indexing                        |
| git-manager.ts        | Git operations wrapper                     |
| github-service.ts     | GitHub API integration                     |
| comment-store.ts      | Comment persistence                        |
| reference-resolver.ts | Reference resolution                       |
| asset-store.ts        | Asset storage                              |

## API Layer

**Location**: packages/canopycms/src/api/

| Endpoint                          | Handler               | Purpose                       |
| --------------------------------- | --------------------- | ----------------------------- |
| /api/canopycms/branches           | branch.ts             | Create/list branches          |
| /api/canopycms/branch-status      | branch-status.ts      | Get status, submit PR         |
| /api/canopycms/branch-withdraw    | branch-withdraw.ts    | Withdraw PR                   |
| /api/canopycms/branch-review      | branch-review.ts      | Request changes               |
| /api/canopycms/branch-merge       | branch-merge.ts       | Merge & cleanup               |
| /api/canopycms/content            | content.ts            | Read/write content            |
| /api/canopycms/entries            | entries.ts            | Entry management              |
| /api/canopycms/assets             | assets.ts             | Asset upload/delete           |
| /api/canopycms/comments           | comments.ts           | Comment CRUD                  |
| /api/canopycms/groups             | groups.ts             | Group management              |
| /api/canopycms/permissions        | permissions.ts        | Permission management         |
| /api/canopycms/reference-options  | reference-options.ts  | Reference field options       |
| /api/canopycms/resolve-references | resolve-references.ts | Resolve reference IDs to data |
| /api/canopycms/user               | user.ts               | Current user info             |

**Key Types**: ApiContext (services, user, branch), ApiRequest, ApiResponse

### API Middleware

**Location**: packages/canopycms/src/api/middleware/

| Middleware       | Purpose                                                     |
| ---------------- | ----------------------------------------------------------- |
| branch-access.ts | Branch access guards (guardBranchAccess, guardBranchExists) |

**Pattern**: Use `guardBranchAccess()` for combined branch existence + user access check, or `guardBranchExists()` when doing content-level permission checks later.

```typescript
const result = await guardBranchAccess(ctx, req, params.branch)
if (isBranchAccessError(result)) return result
const { context } = result
```

**Git Operations Pattern**: API handlers use service methods for git operations:

- permissions.ts, groups.ts → Use `ctx.services.commitFiles()` for admin config changes
- branch-status.ts → Uses `ctx.services.submitBranch()` for full submit workflow
- All handlers access paths via `context.branchRoot` and `context.baseRoot` (BranchContext extends BranchPaths)

## Authentication & Permissions

### Auth Module

**Location**: packages/canopycms/src/auth/

| File               | Purpose                            |
| ------------------ | ---------------------------------- |
| plugin.ts          | AuthPlugin interface definition    |
| types.ts           | CanopyUser, AuthPluginConfig types |
| context-helpers.ts | Auth context helper utilities      |
| index.ts           | Public exports                     |

### Authorization Module

**Location**: packages/canopycms/src/authorization/

This module provides unified access control with a layered architecture:

| File         | Purpose                                                         |
| ------------ | --------------------------------------------------------------- |
| content.ts   | Main entry - combined branch + path access (checkContentAccess) |
| branch.ts    | Branch-level access control (checkBranchAccessWithDefault)      |
| path.ts      | Path-level permissions (checkPathAccess)                        |
| helpers.ts   | Utility functions (isAdmin, isReviewer, isPrivileged)           |
| types.ts     | Type definitions (BranchAccessResult, ContentAccessResult)      |
| permissions/ | Permissions file schema (Zod) and loader                        |
| groups/      | Groups file schema (Zod) and loader                             |

**Usage Pattern**:

```typescript
import { checkContentAccess } from './authorization'

const result = await checkContentAccess(
  deps,
  context,
  branchRoot,
  'content/posts/post.mdx',
  user,
  'edit',
)
if (result.allowed) {
  // User can edit the file
}
```

### Permission Model

- Groups-only (no roles) - users belong to groups with associated permissions
- Reserved groups: "Admins" (full access), "Reviewers" (can review/approve PRs)
- Path-based ACLs: Define who can edit specific files/trees
- Bootstrap admin: CANOPY_BOOTSTRAP_ADMIN_IDS env var

### Auth Flow

1. Host app provides getUser function to adapter
2. AuthPlugin.verifyUser validates external token
3. User mapped to CanopyUser with groups
4. Permission checks use path ACLs + group membership

## Comment System

**Location**: packages/canopycms/src/

### Comment Store

- comment-store.ts - Comment persistence and retrieval

### Comment Types

- **Field comments**: Attached to specific form fields (canopyPath)
- **Entry comments**: General feedback on entire entry
- **Branch comments**: Discussion about the branch/PR

### Storage

- File: .canopycms/comments.json (per-branch, not committed)

## Content Store

**Location**: packages/canopycms/src/

### Key Files

| File                  | Purpose                                |
| --------------------- | -------------------------------------- |
| content-store.ts      | Content persistence (write operations) |
| content-reader.ts     | Content reading                        |
| content-types.ts      | Content type definitions               |
| content-id-index.ts   | Content ID indexing for lookups        |
| reference-resolver.ts | Reference field resolution             |

### Content Model

- **Collections**: Containers for entries (posts, authors)
- **Entry Types**: Define content structure within collections; `maxItems: 1` for single-instance entries
- **Fields**: text, select, reference, object, code, block, markdown
- **Format**: MD/MDX/JSON with frontmatter (gray-matter)

## Configuration Module

**Location**: packages/canopycms/src/config/

| File                   | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| types.ts               | TypeScript type definitions for all config |
| schemas/config.ts      | Zod schema for CanopyConfig                |
| schemas/field.ts       | Zod schemas for field types                |
| schemas/collection.ts  | Zod schemas for collections/entry types    |
| schemas/permissions.ts | Zod schemas for permissions                |
| schemas/media.ts       | Zod schema for media config                |
| flatten.ts             | Schema flattening for O(1) lookups         |
| validation.ts          | Config validation utilities                |
| helpers.ts             | defineCanopyConfig, composeCanopyConfig    |

### Schema Definition

```typescript
import { defineCanopyConfig } from 'canopycms/config'

defineCanopyConfig({
  contentRoot: 'content',
  mode: 'prod-sim',
  // ...
})
```

## Schema Module

**Location**: packages/canopycms/src/schema/

| File           | Purpose                                           |
| -------------- | ------------------------------------------------- |
| meta-loader.ts | Load .collection.json files from filesystem       |
| resolver.ts    | High-level schema resolution API                  |
| types.ts       | EntrySchemaRegistry, SchemaResolutionResult types |

**Pattern**: Schema structure comes from .collection.json files (single source of truth), field schemas come from a registry for reusability.

```typescript
import { resolveSchema } from 'canopycms/schema'

const { schema, sources } = await resolveSchema(contentRoot, schemaRegistry)
```

## Editor UI

**Location**: packages/canopycms/src/editor/

### Context Providers

**Location**: packages/canopycms/src/editor/context/

| Provider            | Purpose                                    |
| ------------------- | ------------------------------------------ |
| ApiClientProvider   | Dependency injection for API client        |
| EditorStateProvider | Loading states, modal states, preview data |

**Usage**:

```tsx
<ApiClientProvider>
  <EditorStateProvider>
    <Editor />
  </EditorStateProvider>
</ApiClientProvider>
```

### Custom Hooks

**Location**: packages/canopycms/src/editor/hooks/

| Hook                   | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| useBranchManager       | Branch switching and creation                     |
| useBranchActions       | Branch workflow actions (submit, withdraw, merge) |
| useEntryManager        | Entry loading and saving                          |
| useDraftManager        | Draft state persistence (localStorage)            |
| useCommentSystem       | Comment CRUD operations                           |
| useGroupManager        | Group management operations                       |
| usePermissionManager   | Permission management operations                  |
| useEditorLayout        | Editor panel layout state                         |
| useUserContext         | Current user context                              |
| useUserMetadata        | User metadata fetching                            |
| useReferenceResolution | Resolve reference IDs to display values           |

### Permission Manager

**Location**: packages/canopycms/src/editor/permission-manager/

| File                       | Purpose                    |
| -------------------------- | -------------------------- |
| types.ts                   | Permission tree types      |
| utils.ts                   | Permission utilities       |
| hooks/usePermissionTree.ts | Tree state management      |
| hooks/useGroupsAndUsers.ts | Groups/users data fetching |

### Group Manager

**Location**: packages/canopycms/src/editor/group-manager/

| File                            | Purpose                   |
| ------------------------------- | ------------------------- |
| types.ts                        | Group management types    |
| hooks/useGroupState.ts          | Group state management    |
| hooks/useUserSearch.ts          | User search functionality |
| hooks/useExternalGroupSearch.ts | External group search     |

### Patterns

- Use Mantine theme helpers from theme.tsx
- "use client" required for browser components
- Export client components via canopycms/client
- Draft state persists in localStorage per branch/entry

**Fields**: packages/canopycms/src/editor/fields/
**Components**: packages/canopycms/src/editor/components/

## Git & Branch Management

**Location**: packages/canopycms/src/

### Key Files

| File                  | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| git-manager.ts        | Wrapper around simple-git                                     |
| branch-registry.ts    | Branch tracking (BranchRegistry class, cache-based listing)   |
| branch-workspace.ts   | Workspace management (BranchWorkspaceManager class)           |
| branch-metadata.ts    | PR info, status, lock state (BranchMetadataFileManager class) |
| settings-workspace.ts | Settings branch workspace management                          |
| github-service.ts     | GitHub API integration (PR creation, etc.)                    |

### Key Types

- BranchContext - Branch state with paths (branchRoot, baseRoot) and metadata
- BranchMetadata - Branch info (name, status, access, timestamps)
- BranchPaths - Path information (baseRoot, branchRoot)

### Operating Mode Module

**Location**: packages/canopycms/src/operating-mode/

| File                      | Purpose                                   |
| ------------------------- | ----------------------------------------- |
| client-safe-strategy.ts   | Client-safe strategy (no Node.js imports) |
| client-unsafe-strategy.ts | Full server-side strategy                 |
| types.ts                  | Strategy interfaces                       |

**Operating Modes**:

- `prod`: Branch clones in configurable filesystem directory (e.g., EFS)
- `prod-sim`: Clones in .canopycms/branches/ (gitignored)
- `dev`: No clones, works in current checkout

**Usage**:

```typescript
// Client components (safe for 'use client')
import { clientOperatingStrategy } from '@/operating-mode'
const strategy = clientOperatingStrategy(mode)
if (strategy.supportsBranching()) { ... }

// Server code
import { operatingStrategy } from '@/operating-mode'
const strategy = operatingStrategy(mode)
const branchRoot = strategy.getContentBranchRoot('my-branch')
```

### Branch Lifecycle

1. Create branch → BranchWorkspaceManager provisions clone
2. Edit content → Writes to branch workspace
3. Submit for merge → Commits, pushes, creates PR via Octokit
4. Review → Request changes unlocks, approval locks
5. Merge → Clean up remote branch, archive clone

### Storage

- .canopycms/branch.json - Per-branch metadata
- .canopycms/branches.json - Branch registry
- .canopycms/comments.json - Comment threads

### Git Operations (Service Methods)

**Location**: packages/canopycms/src/services.ts

Service methods handle git operations with automatic author handling:

| Method                     | Purpose                     | Usage                                                  |
| -------------------------- | --------------------------- | ------------------------------------------------------ |
| `commitFiles()`            | Commit specific files       | Admin changes (permissions, groups)                    |
| `submitBranch()`           | Full submit workflow        | Branch submission (checkout, status, commit all, push) |
| `commitToSettingsBranch()` | Commit to settings branch   | Permission/group changes with optional PR              |
| `getSettingsBranchRoot()`  | Get settings workspace root | Ensures workspace exists                               |

**Pattern**: Use `context.branchRoot` directly instead of `resolveBranchPaths()`. BranchContext extends BranchPaths, so it already has `branchRoot` and `baseRoot` properties.

**commitFiles Example** (permissions.ts, groups.ts):

```typescript
await ctx.services.commitFiles({
  context,
  files: '.canopycms/permissions.json',
  message: 'Update permissions',
})
```

**submitBranch Example** (branch-status.ts):

```typescript
await ctx.services.submitBranch({ context })
```

**Git Author Handling**: Both methods automatically call `git.ensureAuthor()` using `gitBotAuthorName` and `gitBotAuthorEmail` from config. No manual author setup needed.

**GitManager.add()**: Accepts `string | string[]` for convenience.

## Path Utilities Module

**Location**: packages/canopycms/src/paths/

| File                | Purpose                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| types.ts            | Branded types: LogicalPath, PhysicalPath, BranchName, SanitizedBranchName, ContentId, CollectionSlug, EntrySlug         |
| normalize.ts        | Client-safe normalization; createLogicalPath, createPhysicalPath, unsafeAsLogicalPath, unsafeAsPhysicalPath             |
| normalize-server.ts | Server-only functions (requires Node.js path)                                                                           |
| validation.ts       | Security validation; parseLogicalPath, parsePhysicalPath, parseBranchName, parseContentId, parseSlug, unsafeAsEntrySlug |
| resolve.ts          | resolveLogicalPath for path resolution                                                                                  |
| branch.ts           | Branch workspace path resolution                                                                                        |
| test-utils.ts       | Test-only casts: unsafeAsBranchName, unsafeAsCollectionSlug (NOT exported from index)                                   |

**Branded Types** provide type safety for different path semantics:

- `LogicalPath`: Content-relative paths without embedded IDs (e.g., "content/posts/my-post"); used for all collection paths
- `PhysicalPath`: Filesystem paths that may contain embedded content IDs
- `BranchName`: Git branch names (validated against git naming rules)
- `SanitizedBranchName`: Branch name safe for filesystem use
- `ContentId`: 12-character Base58-encoded content ID
- `CollectionSlug`: Single collection path segment (e.g., "posts")
- `EntrySlug`: Single entry slug (e.g., "my-first-post")

Note: `CollectionPath` brand was eliminated; use `LogicalPath` with a `content/` prefix for all collection paths.

### Branded Type Conventions

**Boundary validation** (`parse*` functions) - validate before branding, use at API/input boundaries:

```typescript
import { parseLogicalPath, parseBranchName, parseContentId, parseSlug } from '../paths'

const result = parseLogicalPath(params.path)
if (!result.ok) return { status: 400, error: result.error }
const path: LogicalPath = result.path
```

**Trusted internal construction** (`create*` functions) - validate segments, throw on traversal:

```typescript
import { createLogicalPath, createPhysicalPath } from '../paths'

const path = createLogicalPath('content', 'posts', 'my-post')
```

**Unsafe production casts** (`unsafeAs*` in normalize.ts/validation.ts) - NO validation, for trusted internal data only:

```typescript
import { unsafeAsLogicalPath, unsafeAsPhysicalPath } from '../paths'
import { unsafeAsEntrySlug } from '../paths'

// OK: data already validated on write, read from internal storage
const logicalPath = unsafeAsLogicalPath(entry.collection)
```

**Test-only casts** (in test-utils.ts, NOT exported from index):

```typescript
import { unsafeAsBranchName, unsafeAsCollectionSlug } from '../paths/test-utils'
```

### Zod Validators for API Boundaries

**Location**: packages/canopycms/src/api/validators.ts

| Schema               | Branded Type   | Validates                               |
| -------------------- | -------------- | --------------------------------------- |
| branchNameSchema     | BranchName     | Git naming rules                        |
| logicalPathSchema    | LogicalPath    | No traversal, not a physical path       |
| contentIdSchema      | ContentId      | 12-char Base58                          |
| entrySlugSchema      | EntrySlug      | Lowercase, hyphens, max 64 chars        |
| collectionSlugSchema | CollectionSlug | Lowercase, hyphens, max 64 chars        |
| permissionPathSchema | PermissionPath | No traversal, from authorization module |

```typescript
import { branchNameSchema, logicalPathSchema } from '../api/validators'

const paramsSchema = z.object({
  branch: branchNameSchema,
  path: logicalPathSchema,
})
const params = paramsSchema.parse(req.params)
// params.branch is BranchName, params.path is LogicalPath
```

### PermissionPath (authorization module)

`PermissionPath` is a branded type defined in `authorization/types.ts`, not in `paths/`.

- Production: use `permissionPathSchema` from `api/validators.ts` or `parsePermissionPath` from `authorization`
- Tests: use `unsafeAsPermissionPath` from `authorization/test-utils.ts`

## Validation Module

**Location**: packages/canopycms/src/validation/

| File                   | Purpose                        |
| ---------------------- | ------------------------------ |
| field-traversal.ts     | Schema-aware field traversal   |
| reference-validator.ts | Reference field validation     |
| deletion-checker.ts    | Referential integrity checking |

**Field Traversal** - generic way to walk nested data according to schema:

```typescript
import { traverseFields, findFieldsByType } from '../validation/field-traversal'

// Find all reference fields in data
const refs = findFieldsByType(schema, data, 'reference')
```

## Utility Module

**Location**: packages/canopycms/src/utils/

| File      | Purpose                                                                  |
| --------- | ------------------------------------------------------------------------ |
| error.ts  | Type-safe error handling (getErrorMessage, isNodeError, isNotFoundError) |
| debug.ts  | Debug logging utilities                                                  |
| format.ts | Formatting utilities                                                     |

**Error Handling Pattern**:

```typescript
import { getErrorMessage, isNotFoundError } from '../utils/error'

try {
  await fs.readFile(path)
} catch (err: unknown) {
  if (isNotFoundError(err)) return null
  throw new Error(`Failed: ${getErrorMessage(err)}`)
}
```

## HTTP Module

**Location**: packages/canopycms/src/http/

| File       | Purpose                             |
| ---------- | ----------------------------------- |
| types.ts   | CanopyRequest, CanopyResponse types |
| router.ts  | Route matching and dispatch         |
| handler.ts | Request handler factory             |

## Test Utilities

**Location**: packages/canopycms/src/test-utils/

| File                | Purpose                   |
| ------------------- | ------------------------- |
| api-test-helpers.ts | API testing utilities     |
| console-spy.ts      | Console mocking for tests |

**Integration Tests**: packages/canopycms/src/**integration**/

## Example App

Note: Example app location may vary. Check project root or packages/ for examples.

### Adopter Touchpoints (Keep Minimal!)

1. canopy.config.ts - Schema definition
2. route.ts - Catch-all API handler
3. edit page - Editor component embedding
4. middleware.ts - Auth route protection

### Expected Structure

```
app/
├── api/canopycms/[...canopycms]/route.ts  # Catch-all API
├── edit/[...path]/page.tsx                 # Editor page
└── layout.tsx
content/                                    # Content files
canopy.config.ts                           # Config
middleware.ts                               # Auth protection
```

## Test Organization

- **Unit tests**: Co-located in `__tests__/` subdirectories within each module
- **Integration tests**: `packages/canopycms/src/__integration__/`
- **Test utilities**: `packages/canopycms/src/test-utils/`

## Key Directories to Monitor

When maintaining this guide, watch for changes in:

```
packages/canopycms/src/api/          # API endpoints
packages/canopycms/src/authorization/# Auth & permissions
packages/canopycms/src/config/       # Configuration
packages/canopycms/src/schema/       # Schema loading
packages/canopycms/src/paths/        # Path utilities
packages/canopycms/src/operating-mode/ # Mode strategies
packages/canopycms/src/editor/       # UI components
packages/canopycms/src/validation/   # Validation utilities
packages/canopycms/src/utils/        # Shared utilities
```
