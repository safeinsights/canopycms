---
name: codebase-guide
description: CanopyCMS codebase expert. Use when you need to understand project structure, find files, or learn about specific subsystems.
tools: Read, Grep, Glob
---

You are a codebase guide for CanopyCMS. Your job is to help navigate the project structure and explain how different subsystems work.

## Package Structure

| Package              | Location                       | Purpose                                                          |
| -------------------- | ------------------------------ | ---------------------------------------------------------------- |
| canopycms            | packages/canopycms/            | Core CMS library                                                 |
| canopycms-next       | packages/canopycms-next/       | Next.js adapter                                                  |
| canopycms-auth-clerk | packages/canopycms-auth-clerk/ | Clerk auth plugin                                                |
| canopycms-auth-dev   | packages/canopycms-auth-dev/   | Dev auth plugin with cache-writer, JWT verifier for prod-sim     |
| canopycms-cdk        | packages/canopycms-cdk/        | AWS CDK constructs for deployment (VPC, EFS, Lambda, EC2 worker) |

**Apps** (in apps/, not packages/):

| App      | Location       | Purpose                                           |
| -------- | -------------- | ------------------------------------------------- |
| example1 | apps/example1/ | Example Next.js app showing CanopyCMS integration |
| test-app | apps/test-app/ | E2E test application                              |

## Source Code Organization

The codebase uses a modular structure with clear separation:

**Core Modules** (packages/canopycms/src/):

| Module          | Location            | Purpose                                                                                |
| --------------- | ------------------- | -------------------------------------------------------------------------------------- |
| authorization/  | src/authorization/  | Unified access control (branch + path permissions, groups)                             |
| config/         | src/config/         | Configuration types, Zod schemas, validation                                           |
| schema/         | src/schema/         | Schema loading, resolution, and CRUD (SchemaOps) from .collection.json                 |
| paths/          | src/paths/          | Path utilities with branded types (LogicalPath, PhysicalPath)                          |
| operating-mode/ | src/operating-mode/ | Operating mode strategies (prod, prod-sim, dev)                                        |
| api/            | src/api/            | API handlers, middleware, route builder                                                |
| http/           | src/http/           | HTTP request handling (router, types)                                                  |
| editor/         | src/editor/         | React editor components, contexts, hooks                                               |
| validation/     | src/validation/     | Validation utilities (field traversal, references)                                     |
| utils/          | src/utils/          | Shared utilities (error handling, debug logging)                                       |
| auth/           | src/auth/           | Authentication plugin interface and cache system                                       |
| worker/         | src/worker/         | CMS Worker daemon for background tasks (git sync, task processing, auth cache refresh) |
| task-queue/     | src/task-queue/     | Generic file-based persistent task queue (zero Canopy dependencies; EFS/NFS-safe)      |
| cli/            | src/cli/            | CLI bootstrapping (`npx canopycms init`, `init-deploy aws`, `worker run-once`)         |
| test-utils/     | src/test-utils/     | Test helpers (API test helpers, console spy)                                           |

**Top-level files** (intentionally not modularized):

| File                     | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| services.ts              | CanopyServices factory with git operations                             |
| context.ts               | Context creation and management                                        |
| types.ts                 | Core types (BranchContext, BranchMetadata, SyncStatus, ConflictStatus) |
| branch-metadata.ts       | Branch metadata persistence                                            |
| branch-registry.ts       | Branch tracking and listing                                            |
| branch-workspace.ts      | Branch workspace management                                            |
| branch-schema-cache.ts   | Per-branch schema caching                                              |
| settings-workspace.ts    | Settings branch workspace                                              |
| settings-branch-utils.ts | Settings branch utility helpers                                        |
| content-store.ts         | Content persistence                                                    |
| content-reader.ts        | Content reading                                                        |
| content-id-index.ts      | Content ID indexing                                                    |
| entry-schema.ts          | Entry schema definitions (defineEntrySchema, TypeFromEntrySchema)      |
| entry-schema-registry.ts | Entry schema registry for reusable field definitions                   |
| git-manager.ts           | Git operations wrapper                                                 |
| github-service.ts        | GitHub API integration                                                 |
| comment-store.ts         | Comment persistence                                                    |
| reference-resolver.ts    | Reference resolution                                                   |
| asset-store.ts           | Asset storage                                                          |
| build-mode.ts            | Build mode detection                                                   |
| user.ts                  | User utilities                                                         |
| server.ts                | Server entrypoint exports                                              |

## API Layer

**Location**: packages/canopycms/src/api/

| Endpoint                          | Handler               | Purpose                                                       |
| --------------------------------- | --------------------- | ------------------------------------------------------------- |
| /api/canopycms/branches           | branch.ts             | Create/list branches                                          |
| /api/canopycms/branch-status      | branch-status.ts      | Get status, submit PR                                         |
| /api/canopycms/branch-withdraw    | branch-withdraw.ts    | Withdraw PR                                                   |
| /api/canopycms/branch-review      | branch-review.ts      | Request changes                                               |
| /api/canopycms/branch-merge       | branch-merge.ts       | Merge & cleanup                                               |
| /api/canopycms/content            | content.ts            | Read/write content                                            |
| /api/canopycms/entries            | entries.ts            | Entry management                                              |
| /api/canopycms/assets             | assets.ts             | Asset upload/delete                                           |
| /api/canopycms/comments           | comments.ts           | Comment CRUD                                                  |
| /api/canopycms/groups             | groups.ts             | Group management                                              |
| /api/canopycms/permissions        | permissions.ts        | Permission management                                         |
| /api/canopycms/reference-options  | reference-options.ts  | Reference field options                                       |
| /api/canopycms/resolve-references | resolve-references.ts | Resolve reference IDs to data                                 |
| /api/canopycms/user               | user.ts               | Current user info                                             |
| /api/canopycms/schema             | schema.ts             | Schema CRUD (collections, entry types, ordering) - admin only |

**API Support Files**:

| File                | Purpose                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| route-builder.ts    | Declarative route builder with Zod validation and code generation metadata                   |
| github-sync.ts      | GitHub sync helpers (submit PR, convert to draft) - delegates to githubService or task queue |
| settings-helpers.ts | Settings branch context resolution and commit helpers for permissions/groups                 |
| validators.ts       | Zod schemas for branded types at API boundaries                                              |
| types.ts            | ApiContext, ApiRequest, ApiResponse types                                                    |
| client.ts           | Generated API client                                                                         |

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

- permissions.ts, groups.ts -> Use `ctx.services.commitFiles()` for admin config changes
- branch-status.ts -> Uses `ctx.services.submitBranch()` for full submit workflow
- github-sync.ts -> Delegates to githubService (direct) or task queue (async) depending on internet availability
- All handlers access paths via `context.branchRoot` and `context.baseRoot` (BranchContext extends BranchPaths)

## Authentication & Permissions

### Auth Module

**Location**: packages/canopycms/src/auth/

| File                     | Purpose                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| plugin.ts                | AuthPlugin interface definition                                                                         |
| types.ts                 | CanopyUser, AuthPluginConfig, AuthenticationResult, UserSearchResult, GroupMetadata types               |
| context-helpers.ts       | Auth context helper utilities (extractHeaders, isCanopyRequest)                                         |
| caching-auth-plugin.ts   | CachingAuthPlugin - wraps token verifier with cached metadata lookups; AuthCacheProvider interface      |
| file-based-auth-cache.ts | FileBasedAuthCache - reads JSON cache from EFS; writeAuthCacheSnapshot - atomic snapshot+symlink writes |
| cache.ts                 | Server-only re-exports for `canopycms/auth/cache` import path                                           |
| index.ts                 | Public exports (types only for cache; implementations via `canopycms/auth/cache`)                       |

### Auth Cache System

For Lambda/production environments where the auth provider API is unreachable (no internet):

**Architecture**: Token verification is done locally (JWT). User/group metadata comes from JSON files on EFS populated by the EC2 worker.

| Component              | Location                      | Purpose                                                  |
| ---------------------- | ----------------------------- | -------------------------------------------------------- |
| AuthCacheProvider      | auth/caching-auth-plugin.ts   | Interface for any cache backend                          |
| CachingAuthPlugin      | auth/caching-auth-plugin.ts   | AuthPlugin impl: local token verify + cached metadata    |
| TokenVerifier          | auth/caching-auth-plugin.ts   | Function type: extract/verify token from request context |
| FileBasedAuthCache     | auth/file-based-auth-cache.ts | Reads users.json, orgs.json, memberships.json from EFS   |
| writeAuthCacheSnapshot | auth/file-based-auth-cache.ts | Atomic write: timestamped snapshot dir + symlink swap    |

**Import paths**:

- Types: `import type { AuthCacheProvider, TokenVerifier } from 'canopycms/auth'`
- Implementations (server-only): `import { FileBasedAuthCache, CachingAuthPlugin } from 'canopycms/auth/cache'`

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

**Production (Lambda) auth flow**:

1. CachingAuthPlugin verifies JWT locally (TokenVerifier)
2. User/group metadata looked up from FileBasedAuthCache (EFS JSON files)
3. Cache is populated externally by EC2 worker (refreshClerkCache or refreshDevCache)

### canopycms-auth-dev Package

**Location**: packages/canopycms-auth-dev/src/

| File            | Purpose                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| dev-plugin.ts   | DevAuthPlugin - mock users/groups for development; DEFAULT_USERS, DEFAULT_GROUPS                |
| cookie-utils.ts | Dev user cookie extraction                                                                      |
| jwt-verifier.ts | createDevTokenVerifier - extracts userId from headers/cookies for CachingAuthPlugin in prod-sim |
| cache-writer.ts | refreshDevCache - writes dev users/groups to EFS-style cache for FileBasedAuthCache             |
| client.ts       | Client-side components (UserSwitcherModal, UserSwitcherButton)                                  |
| index.ts        | All public exports                                                                              |

## Worker Module

**Location**: packages/canopycms/src/worker/

The CMS Worker daemon handles operations that Lambda (with no internet) cannot perform.

| File                 | Purpose                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| cms-worker.ts        | CmsWorker class - main daemon with task processing, git sync, auth cache refresh |
| task-queue.ts        | CMS-specific task queue wrapper with TaskAction types                            |
| task-queue-config.ts | getTaskQueueDir() - resolves .tasks/ directory per operating mode                |

**CmsWorker responsibilities**:

- Process queued tasks from Lambda (push branches, create/update PRs, convert to draft, close PRs, delete remote branches)
- Sync bare repo (remote.git) with GitHub on a schedule
- Rebase active branch workspaces when upstream changes (resolve-and-continue strategy with ContentId-based conflict tracking)
- Refresh auth metadata cache (pluggable callback)

**Rebase conflict handling** (`rebaseActiveBranches()`):

1. Skips branches that are `submitted`/`approved` (in review) or have uncommitted changes (dirty tree)
2. On conflict: applies `--theirs` (the branch's version in rebase context) to keep editor work, then continues
3. Records conflicting files as `ContentId[]` in `BranchMetadata.conflictFiles`
4. For `.collection.json` files: extracts ContentId from the parent directory name; falls back to `ROOT_COLLECTION_ID` for the root content directory
5. Non-entry files with no extractable ContentId are excluded from `conflictFiles`
6. Test file: `worker/cms-worker-rebase.test.ts` (11 integration tests using real git)

**Task Actions** (TaskAction type):

| Action                       | Purpose                               |
| ---------------------------- | ------------------------------------- |
| push-branch                  | Push a branch to GitHub               |
| push-and-create-pr           | Push + create new PR                  |
| push-and-update-pr           | Push + update existing PR             |
| push-and-create-or-update-pr | Push + idempotent PR create-or-update |
| convert-to-draft             | Convert PR to draft (via GraphQL)     |
| close-pr                     | Close a PR                            |
| delete-remote-branch         | Delete a remote branch ref            |

**Worker lock**: Uses EFS-based lock file (.tasks/.worker-lock) with atomic O_CREAT|O_EXCL to prevent concurrent workers.

## Task Queue Module

**Location**: packages/canopycms/src/task-queue/

Generic file-based persistent task queue with zero Canopy dependencies.

| File          | Purpose                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| task-queue.ts | Core queue operations: enqueue, dequeue, complete, fail, retry, recover, cleanup, query |
| types.ts      | Task, TaskStatus, QueueStats, TaskQueueLogger interfaces                                |
| index.ts      | Public re-exports                                                                       |

**Directory structure** on filesystem:

```
.tasks/
  pending/      -- ready to be picked up
  processing/   -- currently being executed
  completed/    -- finished successfully
  failed/       -- permanently failed (exhausted retries)
  corrupt/      -- unreadable files moved here for inspection
```

**Key features**:

- FIFO ordering by createdAt with stable tiebreaker
- Retry with exponential backoff (5s -> 10s -> 20s -> 40s -> 60s cap)
- Crash recovery: recoverOrphanedTasks moves stale processing/ tasks back to pending/
- Deduplication: skips tasks that already exist in completed/ or failed/
- Auto-cleanup: completed/failed tasks deleted after 30 days

## CLI Module

**Location**: packages/canopycms/src/cli/

Bootstrapping scripts run via `npx canopycms <command>`.

| File         | Purpose                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| init.ts      | CLI entrypoint with init(), initDeployAws(), workerRunOnce() commands              |
| templates.ts | Template file loader (reads .template files from templates/ directory)             |
| templates/   | Template files for scaffolding (config, route, edit page, Dockerfile, CI workflow) |

**Commands**:

| Command                     | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `canopycms init`            | Scaffold CanopyCMS into a Next.js app (config, API route, edit page, schemas) |
| `canopycms init-deploy aws` | Generate AWS deployment artifacts (Dockerfile.cms, GitHub Actions workflow)   |
| `canopycms worker run-once` | Process pending tasks, refresh auth cache, then exit                          |

## CDK Package (canopycms-cdk)

**Location**: packages/canopycms-cdk/

AWS CDK constructs for deploying CanopyCMS to AWS.

| File                               | Purpose                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| src/constructs/cms-service.ts      | CanopyCmsService construct (VPC, EFS, Lambda, EC2 worker ASG)                           |
| src/constructs/cms-distribution.ts | CanopyCmsDistribution construct (CloudFront, ACM cert, Route53 records)                 |
| worker/index.ts                    | EC2 worker entrypoint - reads Secrets Manager, wires Clerk auth cache, starts CmsWorker |

**CanopyCmsService creates**:

- VPC (2 AZs, public + private subnets, no NAT)
- EFS filesystem with access point at /workspace
- Lambda function (Docker image, EFS mount, private subnet, no internet)
- Lambda Function URL (for CloudFront origin)
- EC2 Worker (t4g.nano spot in ASG, public subnet, EFS mount, systemd service)

**CanopyCmsDistribution creates** (optional):

- ACM certificate (DNS validated)
- CloudFront distribution with Function URL origin
- Route53 A/AAAA alias records

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

| File                     | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| content-store.ts         | Content persistence (write operations)                            |
| content-reader.ts        | Content reading                                                   |
| entry-schema.ts          | Entry schema definitions (defineEntrySchema, TypeFromEntrySchema) |
| entry-schema-registry.ts | Entry schema registry for reusable field definitions              |
| content-id-index.ts      | Content ID indexing for lookups                                   |
| reference-resolver.ts    | Reference field resolution                                        |

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

| File                  | Purpose                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| meta-loader.ts        | Load .collection.json files from filesystem; extracts ContentId from directory names |
| resolver.ts           | High-level schema resolution API                                                     |
| schema-store.ts       | SchemaOps class - CRUD for collections, entry types, ordering                        |
| schema-store-types.ts | Types for schema store operations                                                    |
| types.ts              | EntrySchemaRegistry, SchemaResolutionResult types                                    |

**Pattern**: Schema structure comes from .collection.json files (single source of truth), field schemas come from an entry schema registry for reusability.

```typescript
import { resolveSchema } from 'canopycms/schema'

const { schema, sources } = await resolveSchema(contentRoot, entrySchemaRegistry)
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

### Conflict Notice

Conflict indicators appear at two levels:

- **Per-entry**: `FormRenderer` accepts a `conflictNotice?: boolean` prop that displays a non-blocking informational alert when the current entry has a content conflict with the base branch. `Editor.tsx` computes this by checking whether `currentEntry.contentId` appears in `currentBranch.conflictFiles`.
- **Per-collection (navigator)**: `EntryNavCollection` has an optional `conflictNotice?: boolean` field. When true, `EntryNavigator.tsx` renders an orange "conflict" badge next to the collection name. `Editor.tsx` computes this by matching each collection's `contentId` against `currentBranch.conflictFiles`.

`EditorCollection` now carries `contentId?: ContentId` (threaded from `FlatSchemaItem` via `buildEditorCollections` in `editor-config.ts`).

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

| File                     | Purpose                                                       |
| ------------------------ | ------------------------------------------------------------- |
| git-manager.ts           | Wrapper around simple-git                                     |
| branch-registry.ts       | Branch tracking (BranchRegistry class, cache-based listing)   |
| branch-workspace.ts      | Workspace management (BranchWorkspaceManager class)           |
| branch-metadata.ts       | PR info, status, lock state (BranchMetadataFileManager class) |
| branch-schema-cache.ts   | Per-branch schema caching with invalidation                   |
| settings-workspace.ts    | Settings branch workspace management                          |
| settings-branch-utils.ts | Settings branch utility helpers                               |
| github-service.ts        | GitHub API integration (PR creation, etc.)                    |

### Key Types

- BranchContext - Branch state with paths (branchRoot, baseRoot) and metadata
- BranchMetadata - Branch info (name, status, access, timestamps, conflictStatus, conflictFiles)
- BranchPaths - Path information (baseRoot, branchRoot)
- SyncStatus - 'synced' | 'pending-sync' | 'sync-failed' (for async task queue)

### Operating Mode Module

**Location**: packages/canopycms/src/operating-mode/

| File                      | Purpose                                   |
| ------------------------- | ----------------------------------------- |
| client-safe-strategy.ts   | Client-safe strategy (no Node.js imports) |
| client-unsafe-strategy.ts | Full server-side strategy                 |
| types.ts                  | Strategy interfaces                       |

**Operating Modes**:

- `prod`: Branch clones in configurable filesystem directory (e.g., EFS)
- `prod-sim`: Clones in .canopy-prod-sim/ (gitignored)
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

1. Create branch -> BranchWorkspaceManager provisions clone
2. Edit content -> Writes to branch workspace
3. Submit for merge -> Commits, pushes, creates PR via Octokit (or queues task for worker)
4. Review -> Request changes unlocks, approval locks
5. Merge -> Clean up remote branch, archive clone

### Storage

- .canopycms/branch.json - Per-branch metadata
- .canopycms/branches.json - Branch registry
- .canopycms/comments.json - Comment threads

### GitHub Sync (Direct vs. Async)

**Location**: packages/canopycms/src/api/github-sync.ts

In prod mode, Lambda has no internet access. GitHub operations are handled two ways:

| Scenario                | Path       | Description                                                          |
| ----------------------- | ---------- | -------------------------------------------------------------------- |
| githubService available | Direct     | Calls GitHub API immediately (dev mode, or if internet is available) |
| No githubService        | Task queue | Enqueues task for EC2 worker; branch gets syncStatus 'pending-sync'  |

The `syncSubmitPr()` and `syncConvertToDraft()` functions in github-sync.ts abstract this choice.

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

| File                | Purpose                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| types.ts            | Branded types: LogicalPath, PhysicalPath, BranchName, SanitizedBranchName, ContentId, CollectionSlug, EntrySlug; `ROOT_COLLECTION_ID` sentinel |
| normalize.ts        | Client-safe normalization; createLogicalPath, createPhysicalPath, unsafeAsLogicalPath, unsafeAsPhysicalPath                                    |
| normalize-server.ts | Server-only functions (requires Node.js path)                                                                                                  |
| validation.ts       | Security validation; parseLogicalPath, parsePhysicalPath, parseBranchName, parseContentId, parseSlug, unsafeAsEntrySlug                        |
| resolve.ts          | resolveLogicalPath for path resolution                                                                                                         |
| branch.ts           | Branch workspace path resolution                                                                                                               |
| test-utils.ts       | Test-only casts: unsafeAsBranchName, unsafeAsCollectionSlug (NOT exported from index)                                                          |

**Branded Types** provide type safety for different path semantics:

- `LogicalPath`: Content-relative paths without embedded IDs (e.g., "content/posts/my-post"); used for all collection paths
- `PhysicalPath`: Filesystem paths that may contain embedded content IDs
- `BranchName`: Git branch names (validated against git naming rules)
- `SanitizedBranchName`: Branch name safe for filesystem use
- `ContentId`: 12-character Base58-encoded content ID
- `CollectionSlug`: Single collection path segment (e.g., "posts")
- `EntrySlug`: Single entry slug (e.g., "my-first-post")
- `ROOT_COLLECTION_ID`: Sentinel `ContentId` value (`'__rootcoll__'`) for the root content directory, which has no embedded ID in its name. Uses underscores to avoid collision with real Base58 IDs.

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

| File      | Purpose                                                                                     |
| --------- | ------------------------------------------------------------------------------------------- |
| error.ts  | Type-safe error handling (getErrorMessage, isNodeError, isNotFoundError, isFileExistsError) |
| debug.ts  | Debug logging utilities (createDebugLogger)                                                 |
| format.ts | Formatting utilities                                                                        |

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

**Location**: apps/example1/

### Adopter Touchpoints (Keep Minimal!)

1. canopycms.config.ts - Schema definition
2. app/api/canopycms/[...canopycms]/route.ts - Catch-all API handler
3. app/edit/page.tsx - Editor component embedding
4. app/lib/canopy.ts - Canopy context setup (auth plugin wiring)
5. app/schemas.ts - Entry schema definitions
6. middleware.ts - Auth route protection

### Expected Structure

```
apps/example1/
  app/
    api/canopycms/[...canopycms]/route.ts  # Catch-all API
    edit/page.tsx                           # Editor page
    lib/canopy.ts                          # Context setup
    schemas.ts                             # Entry schemas
    layout.tsx
  content/                                 # Content files
  canopycms.config.ts                     # Config
  middleware.ts                            # Auth protection
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
packages/canopycms/src/auth/         # Auth plugins and cache
packages/canopycms/src/config/       # Configuration
packages/canopycms/src/schema/       # Schema loading and CRUD
packages/canopycms/src/paths/        # Path utilities
packages/canopycms/src/operating-mode/ # Mode strategies
packages/canopycms/src/editor/       # UI components
packages/canopycms/src/validation/   # Validation utilities
packages/canopycms/src/utils/        # Shared utilities
packages/canopycms/src/worker/       # CMS Worker daemon
packages/canopycms/src/task-queue/   # Generic task queue
packages/canopycms/src/cli/          # CLI bootstrapping
packages/canopycms-cdk/              # AWS CDK constructs
packages/canopycms-auth-dev/         # Dev auth plugin + cache
apps/example1/                       # Example app
```
