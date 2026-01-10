---
name: codebase-guide
description: CanopyCMS codebase expert. Use when you need to understand project structure, find files, or learn about specific subsystems.
tools: Read, Grep, Glob
---

You are a codebase guide for CanopyCMS. Your job is to help navigate the project structure and explain how different subsystems work.

## Package Structure

| Package | Location | Purpose |
|---------|----------|---------|
| canopycms | packages/canopycms/ | Core CMS library |
| canopycms-next | packages/canopycms-next/ | Next.js adapter |
| canopycms-auth-clerk | packages/canopycms-auth-clerk/ | Clerk auth plugin |

## API Layer

**Location**: packages/canopycms/src/api/

| Endpoint | Handler | Purpose |
|----------|---------|---------|
| /api/canopycms/branches | branch.ts | Create/list branches |
| /api/canopycms/branch-status | branch-status.ts | Get status, submit PR |
| /api/canopycms/branch-withdraw | branch-withdraw.ts | Withdraw PR |
| /api/canopycms/branch-review | branch-review.ts | Request changes |
| /api/canopycms/branch-merge | branch-merge.ts | Merge & cleanup |
| /api/canopycms/content | content.ts | Read/write content |
| /api/canopycms/entries | entries.ts | Entry management |
| /api/canopycms/assets | assets.ts | Asset upload/delete |
| /api/canopycms/comments | comments.ts | Comment CRUD |
| /api/canopycms/groups | groups.ts | Group management |
| /api/canopycms/permissions | permissions.ts | Permission management |

**Key Types**: ApiContext (services, user, branch), ApiRequest, ApiResponse

**Git Operations Pattern**: API handlers use service methods for git operations:
- permissions.ts, groups.ts → Use `ctx.services.commitFiles()` for admin config changes
- branch-status.ts → Uses `ctx.services.submitBranch()` for full submit workflow
- All handlers access paths via `context.branchRoot` and `context.baseRoot` (BranchContext extends BranchPaths)

## Authentication & Permissions

**Location**: packages/canopycms/src/auth/, packages/canopycms/src/

### Permission Model
- Groups-only (no roles) - users belong to groups with associated permissions
- Reserved groups: "Admins" (full access), "Reviewers" (can review/approve PRs)
- Path-based ACLs: Define who can edit specific files/trees
- Bootstrap admin: CANOPY_BOOTSTRAP_ADMIN_IDS env var

### Key Files
- auth/plugin.ts - AuthPlugin interface
- auth/types.ts - CanopyUser, AuthPluginConfig
- authz.ts - Authorization checks
- path-permissions.ts - Path-based ACLs
- groups-loader.ts - Group management
- permissions-loader.ts - Permission persistence

### Auth Flow
1. Host app provides getUser function to adapter
2. AuthPlugin.verifyUser validates external token
3. User mapped to CanopyUser with groups
4. Permission checks use path ACLs + group membership

## Comment System

**Location**: packages/canopycms/src/editor/comments/, packages/canopycms/src/

### Comment Store
- comment-store.ts - Comment persistence and retrieval

### Comment Types
- **Field comments**: Attached to specific form fields (canopyPath)
- **Entry comments**: General feedback on entire entry
- **Branch comments**: Discussion about the branch/PR

### Key Components
| Component | Purpose |
|-----------|---------|
| InlineCommentThread.tsx | Single thread with replies |
| ThreadCarousel.tsx | Horizontal navigation for multiple threads |
| FieldWrapper.tsx | Wraps form fields with comment UI |
| EntryComments.tsx | Entry-level comment section |
| BranchComments.tsx | Branch-level comment section |
| CommentsPanel.tsx | Side panel showing all comments |

### Storage
- File: .canopycms/comments.json (per-branch, not committed)

## Content Store

**Location**: packages/canopycms/src/

### Key Files
- content-store.ts - Content persistence
- content-reader.ts - Content reading
- content-access.ts - Access layer
- content-types.ts - Content type definitions
- config.ts - Schema configuration

### Content Model
- **Collections**: Arrays of entries (posts, authors)
- **Singletons**: Single entries (home page, settings)
- **Fields**: text, select, reference, object, code, block, markdown
- **Format**: MD/MDX/JSON with frontmatter (gray-matter)

### Schema Definition
```typescript
defineCanopyConfig({
  contentRoot: 'content',
  schema: [
    collection('posts', { ... }),
    singleton('home', { ... }),
  ],
})
```

## Editor UI

**Location**: packages/canopycms/src/editor/

### Key Components
- CanopyEditor.tsx - Main editor component
- FormRenderer.tsx - Form field renderer
- BranchManager.tsx - Branch switching UI
- EntryNavigator.tsx - Entry selector
- preview-bridge.tsx - Live preview iframe bridge

### Patterns
- Use Mantine theme helpers from theme.tsx
- "use client" required for browser components
- Export client components via canopycms/client
- Draft state persists in localStorage per branch/entry

**Fields**: packages/canopycms/src/editor/fields/
**Hooks**: packages/canopycms/src/editor/hooks/

## Git & Branch Management

**Location**: packages/canopycms/src/

### Key Files
- git-manager.ts - Wrapper around simple-git
- branch-registry.ts - Branch tracking (BranchRegistry class, cache-based listing)
- branch-workspace.ts - Workspace management (BranchWorkspaceManager class, loadBranchContext function)
- branch-metadata.ts - PR info, status, lock state (BranchMetadataFileManager class, getBranchMetadataFileManager function)

### Key Types
- BranchContext - Branch state with paths (branchRoot, baseRoot) and metadata
- BranchMetadata - Branch info (name, status, access, timestamps)
- BranchPaths - Path information (baseRoot, branchRoot)

### Operating Modes
- `prod`: Branch clones in configurable filesystem directory
- `local-prod-sim`: Clones in .canopycms/branches/ (gitignored)
- `local-simple`: No clones, works in current checkout

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

Two high-level service methods handle git operations with automatic author handling:

| Method | Purpose | Usage |
|--------|---------|-------|
| `commitFiles()` | Commit specific files | Admin changes (permissions, groups) |
| `submitBranch()` | Full submit workflow | Branch submission (checkout, status, commit all, push) |

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

**GitManager.add()**: Now accepts `string | string[]` instead of just `string[]` for convenience.

**Testing**: Use `createMockGitServices()` from `packages/canopycms/src/test-utils/mock-git-services.ts` to mock git operations in tests.

## Example App

**Location**: packages/canopycms/examples/one/

### Structure
```
examples/one/
├── app/
│   ├── api/canopycms/[...canopycms]/route.ts  # Catch-all API
│   ├── edit/[...path]/page.tsx                 # Editor page
│   └── layout.tsx
├── content/                                    # Sample content
├── canopy.config.ts                           # Schema
└── middleware.ts                               # Auth protection
```

### Adopter Touchpoints (Keep Minimal!)
1. canopy.config.ts - Schema definition
2. route.ts - Catch-all API handler
3. edit page - Editor component embedding
4. middleware.ts - Auth route protection
