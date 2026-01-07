# CanopyCMS Architecture

This document explains how CanopyCMS works at a systems level. For usage instructions, see [README.md](README.md). For contributor workflows, see [DEVELOPING.md](DEVELOPING.md).

## What is CanopyCMS?

CanopyCMS is a schema-driven, branch-aware content management system for git-backed, statically-generated websites. It provides an editing interface on top of a git-backed content store, enabling non-technical users to edit website content without touching Git directly.

Key characteristics:
- **Editing interface**: Schema-driven forms, block-based page building, live preview
- **Git as source of truth**: All content lives as files in git, enabling version history, rollback, and familiar workflows
- **Branch-based editing**: Each editing session works on its own branch, enabling review workflows
- **Schema-driven**: Content structure is defined by a schema, ensuring type safety and validation
- **File system based**: No external databases or caching servers—designed for deployment with an attached file system
- **Framework-agnostic core**: The core library works with any framework; adapters provide integration

## Package Architecture

CanopyCMS is organized as a monorepo with separate packages for extensibility:

- **canopycms** (core): The main library containing content store, branch management, permissions, editor UI, and API handlers. This package is framework-agnostic and contains all business logic.

- **canopycms-next**: Next.js adapter that provides thin integration (~10 lines of user extraction code). Wraps core context with React cache() for per-request memoization.

- **canopycms-auth-clerk**: Authentication plugin using Clerk.

This separation keeps the core framework-agnostic while allowing adapters to be minimal integration layers. All business logic lives in core—adapters only handle framework-specific concerns like extracting user identity from request contexts.

## Storage Architecture

CanopyCMS is entirely file system based. There are no external databases, no Redis/Valkey caching servers, and no separate worker processes by default. This simplifies deployment and operations.

**What gets stored:**
- **Content**: MD/MDX/JSON files in the content directory (committed to git)
- **Branch metadata**: `.canopycms/branch.json` per workspace (state, PR references)
- **Branch registry**: `.canopycms/branches.json` (inventory of all branches)
- **Comments**: `.canopycms/comments.json` per branch (NOT committed to git)
- **Groups**: `.canopycms/groups.json` (internal group definitions, committed)
- **Permissions**: `.canopycms/permissions.json` (path-based permissions, committed)

**Deployment model**: CanopyCMS is designed to be deployed to a server or serverless function with an attached file system shared by all server processes. On AWS, this could mean Lambda + EFS.

## Content Identification System

Every entry and collection in CanopyCMS has a stable, globally unique identifier that persists across renames and moves. This enables robust reference fields, relationship tracking, and reliable content linking.

### Short UUIDs

CanopyCMS uses **short UUIDs** (22-character Base58-encoded strings) for all content IDs. These are generated using the `short-uuid` package and provide:
- **Global uniqueness**: No collisions across the entire system
- **Compact representation**: 22 characters instead of 36 (standard UUID format)
- **URL-safe**: Can be used in URLs and APIs without encoding
- **Human-friendly**: Shorter than UUIDs but still not memorable like sequential numbers

Example ID: `SmVpC5wd3j9Z6xY2pQsL`

### ID Storage via Symlinks

IDs are stored as symlinks in a centralized `content/_ids_/` directory. This design provides several benefits:

```
content/
  _ids_/
    SmVpC5wd3j9Z6xY2pQsL → ../posts/hello.json
    aB7xK4mN9pR2tL8vQ3sW → ../posts/
    ...
  posts/
    hello.json
    world.json
    drafts/
      unpublished.json
```

**Why symlinks?**
- **Stable IDs across moves**: Rename or reorganize files without breaking references
- **Single source of truth**: The symlink itself stores the ID; no separate database needed
- **Filesystem-native**: Fits naturally with git-backed storage; symlinks are committed to the repository
- **Atomic creation**: Creating a symlink is atomic on all modern filesystems

### Bidirectional ID Index

The `ContentIdIndex` class maintains an in-memory bidirectional mapping between IDs and file paths:

```
Forward map:  ID → {path, type, collection, slug}
Reverse map:  path → ID
```

This enables O(1) lookups in both directions:
- **Forward**: "What file does ID abc123 refer to?"
- **Reverse**: "What ID does the file at content/posts/hello.json have?"

**Lazy loading optimization**: The index is built on first access by scanning the `_ids_/` directory. This minimizes Lambda cold starts—building the index for 1000 entries takes approximately 10-50ms. Subsequent accesses are instant (index already in memory).

**Performance characteristics**:
- Cold start (first access): ~10-50ms for 1000 entries
- Warm execution (index in memory): 0ms
- Memory overhead: ~1KB per entry

### Multi-Process Consistency

The index is NOT thread-safe, but the system is designed for eventual consistency across processes:

- **Symlinks are source of truth**: Each process rebuilds its index from symlinks on disk
- **Atomic operations**: Symlink creation is atomic; all processes discover the same symlinks
- **Unique ID generation**: Multiple processes can't create duplicate IDs (globally unique)
- **Eventual consistency**: One process creating an entry might not be visible to another until that process rebuilds its index (acceptable for human-paced editing workflows)

In most CMS use cases (where editors work at human speeds), race conditions are rare and eventual consistency is sufficient.

## Core Mental Model

Content in CanopyCMS flows through a predictable lifecycle:

```
Git Repository (source of truth)
        ↓
   Create/Open Branch (isolated workspace)
        ↓
   Edit Content (changes stay in branch)
        ↓
   Submit for Review (requests publication)
        ↓
   Review & Approve (on GitHub)
        ↓
   Merge PR (outside CanopyCMS)
        ↓
   Deploy Updated Site (outside CanopyCMS)
```

The key insight is that editors never interact with git or GitHub directly. CanopyCMS abstracts away the git operations, PR creation, and branch management. When an editor hits "Publish Branch", they are *requesting to publish*—the actual merge and deployment happen separately (typically through GitHub and CI/CD).

## Branch-Based Editing

When a user opens a branch, CanopyCMS either opens an existing workspace or creates a new one:

1. **Workspace resolution**: If a clone already exists for the branch, it's used. Otherwise, a new git clone is created (in production modes).
2. **Isolation**: Each branch has its own working directory with independent files
3. **Parallel editing**: Multiple users can work on different branches simultaneously without interference

Branches have a lifecycle with three states:
- **editing**: Active work in progress
- **submitted**: Sent for review, awaiting merge
- **archived**: Merged and preserved for audit

Users can work on main branch too—there's nothing preventing it. The branch model provides isolation for team collaboration but doesn't mandate it.

## Operating Modes

CanopyCMS supports three operating modes to fit different environments:

### local-simple
Direct file editing in the current checkout. No git cloning occurs. Best for solo development where the developer manages their own branch via git commands.

### local-prod-sim
Simulates production behavior locally. Creates per-branch clones in `.canopycms/branches/` and maintains a local git remote at `.canopycms/remote.git`. Use this for testing the full branch workflow without deploying.

### prod
Full production deployment. Branch workspaces live on persistent storage (e.g., EFS on AWS). Integrates with GitHub for PR creation and management. Designed for team collaboration with proper review workflows.

## Context Architecture

CanopyCMS provides a context system that manages authentication, permissions, and content access in a framework-agnostic way.

### Core Context Factory

The core provides `createCanopyContext(options)` which takes:
- **config**: CanopyCMS configuration
- **getUser**: Framework-specific function to extract current user

Returns:
- **getContext()**: Function that returns authenticated context with `read()` method
- **services**: Underlying services (branch manager, permissions, etc.)

This factory is framework-agnostic—it doesn't know about Next.js, Express, or any other framework. The framework adapter provides the `getUser` function.

### Authenticated Context

Calling `getContext()` returns a `CanopyContext` with:
- **read()**: Content reader with user already injected, no need to pass user manually
- **services**: Access to underlying services if needed
- **user**: Current authenticated user (with bootstrap admin groups applied)

The context automatically handles:
- User extraction via the provided `getUser` function
- Bootstrap admin group application (designated users get Admins group)
- Build mode detection (returns BUILD_USER with admin access during static generation)
- Permission checks during content reading

### Build Mode Support

Build mode allows content to be read during static site generation without authentication:

**Detection**: Checks environment variables in a framework-agnostic way:
- `NEXT_PHASE=phase-production-build` (Next.js builds)
- `CANOPY_BUILD_MODE=true` (generic builds, other frameworks)

**Behavior**: When build mode is active:
- Context returns `BUILD_USER` (special user with Admins group)
- Content reader bypasses all permission checks
- All content becomes readable for static generation

This means you can use the same `read()` calls in both authenticated pages and build-time static generation—the context handles the difference automatically.

### Framework Adapter Pattern

Framework adapters wrap the core context to provide framework-specific integration:

**Adapter responsibilities**:
- Extract user identity from framework-specific request context (Next.js headers, Express req, etc.)
- Apply framework-specific optimizations (React cache() for Next.js)
- Provide unified API for both pages and API routes

**What stays in core**:
- All business logic (permissions, content reading, branch management)
- Bootstrap admin group application
- Build mode detection and handling
- Content access control

The Next.js adapter is ~10 lines of user extraction code. The pattern is designed so adapters for Express, Fastify, Hono, or other frameworks would be similarly minimal.

### Developer Experience

Setup is a one-time operation in a central file (e.g., `app/lib/canopy.ts`):

```typescript
// One-time setup
const { getCanopy, handler, services } = createNextCanopyContext({
  config: canopyConfig,
  authPlugin: clerkAuthPlugin
})

export { getCanopy, handler, services }
```

Then in pages and API routes:

```typescript
// In a page/component
const canopy = await getCanopy()
const { data } = await canopy.read({ entryPath: 'content/posts', slug: params.slug })
```

No manual user management, no config imports, no auth logic. The context handles everything.

## The Permission Model

Access control uses three layers that all must pass:

### Layer 1: Branch Access
Per-branch ACLs control who can access a branch. Branches can be restricted to specific users or groups. Admins and reviewers always have access.

### Layer 2: Path Permissions
Glob patterns (e.g., `content/posts/**`) restrict who can edit specific content paths. First matching rule wins. Only admins bypass path rules.

### Layer 3: Content Access
Combines branch and path checks into a single decision. Returns detailed denial reasons for debugging.

**Reserved groups** provide consistent roles:
- **admins**: Full access to all operations
- **reviewers**: Can review branches, request changes, approve PRs

**Where permissions are stored:**
- Groups and path permissions are stored in `.canopycms/groups.json` and `.canopycms/permissions.json`
- These files ARE committed to git, providing version history and PR-reviewable changes
- Branch ACLs are stored in each branch's metadata file

## Content Workflow

### Creating and Editing
1. User opens or creates a branch
2. System opens existing workspace or creates new clone (in prod modes)
3. User makes edits through the editor UI
4. Each save writes directly to files in the branch workspace
5. Live preview shows changes immediately

### Submitting for Review
1. User clicks "Submit"
2. System commits all changes and pushes to remote
3. GitHub PR is created (if GitHub integration configured)
4. Branch status changes to "submitted"

**Important**: Clicking "Submit" requests publication—it does not actually publish. The content becomes live only after the PR is merged on GitHub and the site is rebuilt/deployed. This separation means CanopyCMS doesn't control the actual publication moment; that's handled by your CI/CD pipeline.

### Review Process
1. Reviewers see submitted branches and can add comments
2. Comments attach to specific fields, entries, or the whole branch
3. Reviewers can approve or request changes
4. Requesting changes returns branch to "editing" status

### Merging and Archiving
1. PR is merged on GitHub (outside CanopyCMS, by someone with merge permissions)
2. User clicks "Mark as Merged" in CanopyCMS
3. System verifies merge via GitHub API
4. Branch moves to "archived" status
5. Site rebuild/deploy happens via other processes (e.g. CI/CD)

## Reference System

The reference system allows content to link to other content entries using stable content IDs. This enables relationship modeling, cross-references, and maintains data integrity.

### Reference Fields

Reference fields are schema fields that can reference other entries by their content ID:

```javascript
// Example schema field
{
  name: 'relatedPosts',
  type: 'reference',
  collections: ['posts'],  // Constrain to specific collections
  isArray: true            // Allow multiple references
}
```

References can:
- **Link to specific collections**: Constrain references to certain content types (e.g., only allow linking to "posts")
- **Support both single and multiple references**: A field can reference one entry or an array of entries
- **Be validated**: The system checks that referenced IDs exist and belong to allowed collections

### Reference Resolution

The `ReferenceResolver` class handles loading and displaying referenced content:

- **Resolve single ID**: Convert a content ID to its display value (e.g., post title)
- **Load reference options**: Dynamically fetch all available options for a reference field (used for dropdown/select UI)
- **Search and filter**: Find reference options by search term or apply collection constraints
- **Batch resolution**: Resolve multiple IDs efficiently

### Reference Validation

The `ReferenceValidator` class ensures reference integrity:

- **ID format validation**: Checks that ID strings are valid short UUIDs
- **Existence validation**: Verifies that referenced entries actually exist
- **Collection constraint validation**: Ensures referenced entries belong to allowed collections
- **Detailed error reporting**: Reports which reference field failed validation and why

Validation can run on entire entries or individual references, supporting both batch checks during content saves and real-time validation in the editor.

### Reference Integrity Checking

Before deleting an entry, the system checks for broken references:

- **Identify all references**: Find which entries reference the entry being deleted
- **Report referrers**: Show users which content would be broken
- **Prevent cascade deletes**: Entries with incoming references can be marked as "deletion blocked"

This prevents orphaned references and keeps the content relationship graph intact.

### API Endpoints

**GET /:branch/reference-options**: Dynamically load reference options
- Query parameters: `collections` (comma-separated), `displayField`, `search`
- Returns: Array of options with ID, label, and collection
- Used by editor to populate dropdowns with current available entries

**POST /:branch/validate-references/:path***: Validate references in an entry
- Checks all reference fields in the entry data
- Returns: Validation result with any errors found
- Provides real-time feedback in the editor

## Comments & Collaboration

The comment system supports asynchronous review workflows.

**Three attachment levels:**
- **Field comments**: Attached to specific form fields (e.g., title, description)
- **Entry comments**: General feedback on an entire content entry
- **Branch comments**: Discussion about the overall branch/changeset

**Key characteristics:**
- Comments are stored per-branch in `.canopycms/comments.json`
- Comments are NOT committed to git—they're review artifacts, not content
- Thread resolution is controlled by the thread author, reviewers, or admins

## Editor Architecture

The editor provides a rich editing experience with schema-driven forms, block-based page building, and live preview.

**Bundle separation**: Public sites can be built without any editor code. The editor is exported from `canopycms/client` and can be imported only where needed. This means your production site visitors never download editor JavaScript.

**Integration options:**
- Embed editor in the same Next.js app (simpler setup)
- Run editor as a separate application (stricter separation)
- Public sites can optionally import and embed the editor, but they don't have to

**Server imports**: Adopting apps also import from `canopycms/server` for content reading and API setup.

**Live preview**: The editor can show a live preview of content changes. The preview is an iframe that loads your actual site pages, and the editor communicates with it via postMessage. When you edit a field, the preview updates immediately. Clicking on elements in the preview focuses the corresponding form field. This preview bridge enables real-time feedback without page reloads.

## Extensibility Points

### Authentication
Authentication is abstracted out and provided by separate packages. The core CanopyCMS package has no built-in auth provider—you must install an auth package.

Auth plugins implement the `AuthPlugin` interface, which provides:
- User identity extraction from requests
- Group membership lookup
- Session validation

This abstraction means you can use Clerk, Auth0, NextAuth, Supabase Auth, or a custom solution. See `canopycms-auth-clerk` as a reference implementation. Creating a new auth plugin involves implementing the interface and publishing it as a package.

### Framework Adapters
Framework adapters provide thin integration between the framework and CanopyCMS core. They handle two main concerns:

1. **User extraction**: Extract user identity from framework-specific request context (Next.js headers, Express req, etc.)
2. **Request/response adaptation**: Convert framework request/response objects to core `CanopyRequest`/`CanopyResponse` types for API handlers

The `canopycms-next` adapter is ~10 lines for user extraction plus the request/response wrapper. All business logic stays in core—adapters are purely integration code.

**Creating a new adapter**:
- Implement user extraction (read auth headers/cookies, call auth plugin)
- Wrap core context creation with framework-specific optimizations (like React cache() for Next.js)
- Provide unified API that works in both pages and API routes
- Optionally wrap the core API handler for framework-specific routing

See `canopycms-next` as a reference implementation. Creating adapters for Express, Fastify, Hono, or other frameworks follows the same minimal pattern.

## Key Design Decisions

### Why file system based (no external databases)?
Simplifies deployment and operations. Git already provides versioning, and the file system provides persistence. No need to sync state between a database and git. Works well with serverless + attached storage (Lambda + EFS).

### Why branch-per-workspace?
Each branch gets its own git clone to prevent conflicts. Editors can work simultaneously without stepping on each other. The workspace isolation also means a crash or bad edit on one branch can't affect others.

### Why aren't comments committed to git?
Comments are review artifacts, not content. They're ephemeral discussion about changes, not part of the final published content. Keeping them out of git prevents clutter and keeps the content repository clean.

### Why are groups and permissions committed to git?
Unlike comments, groups and permissions are configuration that should be version-controlled. Changes to who can edit what should be reviewable via PR, and you should be able to roll back permission changes if needed.

### Why three permission layers?
Defense in depth. Branch access controls who can see a branch. Path permissions control what content they can edit. Combining them provides flexible policies: you might let someone access a branch but restrict them to certain content paths within it.

### Why separate packages for auth and framework adapters?
Keeps the core framework-agnostic. Adopters only install what they need. Testing is simpler because the core doesn't depend on Next.js or Clerk. New frameworks and auth providers can be supported without modifying core code.

### Why do git operations in the request cycle (no worker)?
Simplicity. Git operations (clone, commit, push) happen synchronously during API requests rather than being queued to a separate worker process. This avoids the complexity of job queues, worker coordination, and eventual consistency. For most content editing use cases, git operations complete fast enough. If this becomes a bottleneck, a worker architecture could be added later.

### Why "Publish Branch" doesn't actually publish?
Separation of concerns. CanopyCMS handles content editing and PR creation. The actual publication (merging the PR and deploying the site) is handled by GitHub and your CI/CD pipeline. This makes the system more flexible—you can have any merge/deploy workflow you want, and CanopyCMS doesn't need credentials to actually push to production.

### Why is the branch registry a cache, not a source of truth?

The branch registry (`branches.json`) is a **read-only cache** for fast branch listing. Individual `branch.json` files in each branch workspace are the source of truth.

**Design:**
- When branch state changes, the registry cache is invalidated (atomic rename to `branches.stale.json`)
- `list()` regenerates the cache on-demand by scanning branch directories
- Concurrent regeneration is safe—all processes produce identical output from the same `branch.json` files
- No write conflicts because the cache is never directly updated, only regenerated

**Why this design:**
- **Single source of truth**: Eliminates synchronization bugs between `branch.json` and `branches.json`
- **Atomic invalidation**: Prevents race conditions on concurrent updates
- **Lazy regeneration**: Amortizes the cost of directory scanning across reads
- **Self-healing**: If the cache becomes corrupted or stale, the next read fixes it

### Why framework-agnostic context creation?

The context architecture centralizes business logic in core while keeping framework adapters minimal.

**Benefits:**
- **Consistency**: Bootstrap admin groups, build mode, and permission checks work identically across all frameworks
- **Testability**: Core context can be tested without Next.js, Express, or any framework installed
- **Maintainability**: Bug fixes and features only need to be implemented once in core
- **Extensibility**: New frameworks require ~10 lines of user extraction code, not reimplementing business logic

The `getUser` function pattern inverts the dependency—core doesn't know about frameworks, frameworks provide core with what it needs.

### Why automatic bootstrap admin group application?

Bootstrap admins are designated in config (e.g., by email or user ID). These users should always have the Admins group, regardless of what the auth provider returns.

Handling this in core context creation ensures:
- **Single application point**: Can't be forgotten or applied inconsistently
- **Framework-agnostic**: Works the same in Next.js, Express, or any other framework
- **Early in request lifecycle**: Applied before any content reading or permission checks
- **Transparent to pages**: Page code doesn't need to know about bootstrap admins

Without this, every page would need to manually apply bootstrap groups or risk inconsistent permissions.

### Why bypass permissions in build mode?

Static site generators need to read all content to pre-render pages. Running permission checks during build would require:
- Mock authentication in the build environment
- Knowing all possible users ahead of time
- Risk of incomplete pre-rendering if permission checks fail

Build mode solves this by:
- **Detecting build environment automatically** (via `NEXT_PHASE` or `CANOPY_BUILD_MODE`)
- **Providing BUILD_USER with admin access** (bypasses all permission checks)
- **Working with the same `read()` calls** (no special build-specific code paths)

This means you write `await canopy.read(...)` once, and it works in both authenticated runtime requests and build-time static generation.

### Why minimal framework adapters?

Keeping adapters thin (like the ~10 line Next.js user extraction) provides several benefits:

**For core maintainers:**
- Features and fixes only need to be implemented once in core
- Core can be tested without installing every framework
- API surface area is small and stable

**For framework adapter authors:**
- Less code to write and maintain
- Less that can go wrong (minimal surface area for bugs)
- Easy to understand reference implementations

**For adopters:**
- Consistent behavior across frameworks
- Easier to switch frameworks (just change the adapter)
- Confidence that adapters are just thin wrappers, not reimplementations

If adapters contained business logic, we'd risk behavior divergence, duplicate maintenance, and harder-to-debug issues.

### Why symlink-based content IDs?

A robust reference system requires stable, globally unique identifiers that survive file renames and moves. The decision to use symlinks in `content/_ids_/` provides several advantages over alternatives:

**Alternative approaches considered:**
- **Database IDs**: Would add external dependency, complicating deployment and git synchronization
- **File-based registry** (e.g., JSON mapping): Requires synchronization logic and introduces write conflicts in concurrent environments
- **Git objects** (blob hashes): Not stable across file edits; changes whenever content changes

**Why symlinks?**
- **Filesystem-native**: No external database or registry file needed
- **Atomic writes**: Symlink creation is atomic; no partial state or race conditions
- **Git-friendly**: Symlinks can be committed to git, providing version history and audit trail
- **Process-agnostic**: Multiple processes can safely read the same symlinks without synchronization
- **Self-documenting**: The symlink target shows what ID refers to what file

The symlink approach trades a small amount of filesystem overhead (one symlink per entry) for simplicity, atomicity, and git integration.

### Why lazy index loading for Lambda cold starts?

Scanning thousands of symlinks during every request would be expensive. The lazy loading approach defers index building until first access:

- **First access** (cold start): Scan all symlinks in `_ids_/` and build in-memory maps. ~10-50ms for 1000 entries.
- **Subsequent accesses** (warm): Index already in memory. Lookups are 0ms.
- **Cross-request**: In serverless functions, subsequent requests reuse the same Lambda execution context, so the index stays warm.

This optimization is critical for serverless deployments where cold starts are inevitable. The 10-50ms cost is paid once per container lifecycle, not per request.

### Why in-memory index over filesystem queries?

Once built, the index enables O(1) lookups instead of filesystem syscalls:

- **Filesystem queries**: Each lookup would require `readlink()` + directory scans. Much slower.
- **In-memory maps**: Two hashmap lookups (forward and reverse). Microsecond-level latency.
- **Memory cost**: ~1KB per entry. For 10,000 entries, ~10MB. Acceptable for serverless budgets.

The tradeoff favors speed over raw memory usage, which is the right choice for request-path latency.

### Why eventual consistency for the index?

The index is per-process, not globally synchronized. This design choice accepts eventual consistency for robustness:

- **No locking**: Avoids distributed lock complexity and deadlock risks
- **No write conflicts**: Each process independently rebuilds from the authoritative symlinks
- **Self-healing**: If a process's index gets stale, it rebuilds on next access
- **Suitable for CMS workflows**: Editors work at human speeds; millisecond-level race conditions don't materialize in practice

For a system handling hundreds of concurrent API requests (serverless autoscaling), process-local indexes with eventual consistency is simpler and more scalable than a shared, synchronized index.
