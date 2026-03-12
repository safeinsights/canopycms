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

## Module Structure

The core package organizes code into focused modules, each with a single responsibility. This modular structure emerged from decomposing larger monolithic files into smaller, more maintainable units.

### Modularized Domains

**Authorization** - Unified access control combining branch and path permissions:
- Branch-level access control (who can access which branches)
- Path-level permissions (who can edit which content paths)
- Combined content access checks (main entry point for authorization)
- Helper functions for role checking (isAdmin, isReviewer, etc.)
- File loaders for permissions and groups configuration

**Configuration** - Configuration types, schemas, and validation:
- Type definitions for all configuration options
- Zod schemas organized by concern (field, collection, permissions, media)
- Schema flattening utilities for O(1) path lookups
- Validation and helper functions for config authoring

**Schema** - Schema loading and resolution:
- Meta file loader for `.collection.json` files
- Reference resolution against schema registries
- High-level resolver that combines loading and resolution

**Paths** - Path utilities with branded types for type safety:
- Branded types: `LogicalPath`, `PhysicalPath`, `CollectionPath`, `SanitizedBranchName`
- Normalization utilities (client-safe and server-only variants)
- Security validation for path traversal prevention
- Branch workspace path resolution

**Editor** - React components, hooks, and context providers:
- Context providers for dependency injection (ApiClient, EditorState)
- Extracted hooks for state management (branch, entry, draft, comment, permissions, groups)
- Component subdirectories for permission-manager and group-manager utilities

**API** - API handlers and middleware:
- Route handlers for all API endpoints
- Middleware patterns for common guards (branch access checking)
- API client for editor-to-server communication
- Settings helpers for mode-aware configuration storage

**Operating Mode** - Strategy pattern for deployment modes:
- Client-safe strategies (UI flags, simple configuration)
- Client-unsafe strategies (file system operations, git integration)
- Type definitions for strategy interfaces

**Validation** - Content validation utilities:
- Reference validator for checking content references
- Deletion checker for referential integrity
- Field traversal utilities for schema-aware content inspection

**Utilities** - Shared utilities:
- Type-safe error handling patterns
- Debug logging utilities
- Formatting helpers

### Top-Level Files

Some files remain at the source root because they represent core domain concepts that span multiple modules:

**Branch Management:**
- Branch metadata (per-branch state storage)
- Branch registry (branch listing cache)
- Branch workspace (workspace provisioning)
- Settings branch utilities (mode-aware settings storage)

**Content:**
- Content ID index (bidirectional ID-to-path mapping)
- Content reader (authenticated content access)
- Content store (file-based content persistence)
- Content types (content data structures)

**Git:**
- Git manager (low-level git operations)
- GitHub service (GitHub API integration)

**Core:**
- Services (service container and factory)
- Context (request context creation)
- Types (shared type definitions)
- User (user data structures)
- ID generation

**Other:**
- Asset store (media file management)
- Comment store (review comment persistence)
- Reference resolver (content reference handling)
- Settings workspace (settings file management)
- Build mode (static generation detection)

### Design Rationale

**Why modularize?** The original codebase had several large files (600-1100+ lines) that made navigation difficult and created implicit coupling. Breaking these into focused modules with explicit exports improves:
- Discoverability (clear module boundaries)
- Testability (smaller units with defined interfaces)
- Maintainability (changes are localized)

**Why keep some files at root?** Files that represent core domain concepts used across many modules remain at the root to avoid deep import chains. These are stable abstractions that change infrequently.

**Why branded types for paths?** Path handling is error-prone because different contexts need different path representations (logical content paths vs physical filesystem paths). Branded types make the compiler catch misuse at development time rather than runtime.

## Service Architecture

CanopyCMS uses **dependency injection** to manage service lifecycle and avoid global singletons. Services are created once at initialization and passed down through the call stack.

### Service Container

The `CanopyServices` interface (defined in [services.ts](packages/canopycms/src/services.ts)) is the central service container that holds all global services and factory functions:

```typescript
export interface CanopyServices {
  config: CanopyConfig                    // Validated configuration
  flatSchema: FlatSchemaItem[]            // Flattened schema for O(1) lookups
  checkBranchAccess: (...)                // Branch permission checker
  checkPathAccess: (...)                  // Path permission checker
  checkContentAccess: (...)               // Combined content access checker
  registry?: BranchRegistry               // Branch cache (undefined in dev mode)
  githubService?: GitHubService           // GitHub API client (if configured)
  createGitManagerFor: (...)              // Factory for git operations
  commitFiles: (...)                      // Helper for committing files
  submitBranch: (...)                     // Helper for submitting branches
}
```

**Service Creation:**

Services are created once at application startup using `createCanopyServices()`:

```typescript
const services = await createCanopyServices({
  config,
  authPlugin,
  schemaRegistry,
})
```

This function:
1. Validates and flattens the schema
2. Creates authorization checkers
3. Initializes the branch registry (prod/prod-sim modes only)
4. Sets up GitHub integration (if configured)
5. Returns an immutable service container

### Service Access Patterns

Different layers of the application access services in different ways:

**API Handlers** receive services via `ApiContext`:
```typescript
const readContentHandler = async (
  ctx: ApiContext,        // Contains services
  req: ApiRequest,
  params: ValidatedParams
): Promise<ApiResponse> => {
  const store = new ContentStore(branchRoot, ctx.services.flatSchema)
  const hasAccess = await ctx.services.checkContentAccess(...)
  // ...
}
```

**Content Readers** receive services at creation:
```typescript
const reader = createContentReader({ services })
const doc = await reader.read({ branch, path })
```

**Editor Components** use the ApiClient hook (never access services directly):
```typescript
export function MyComponent() {
  const client = useApiClient()
  const data = await client.content.read(...)
}
```

**Framework Adapters** create services once and inject them:
```typescript
// apps/example1/app/lib/canopy.ts
const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin: getAuthPlugin(),
  schemaRegistry,
})

export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler  // Handler has services injected
}
```

### Scoped vs Global Services

**Global Services** (created once, shared across requests):
- Configuration (`config`)
- Flattened schema (`flatSchema`)
- Authorization checkers (`checkBranchAccess`, `checkPathAccess`)
- Branch registry (`registry`)
- GitHub service (`githubService`)

**Scoped Services** (created per-request or per-operation):
- **ContentStore**: Created for each branch context (lightweight wrapper)
- **GitManager**: Created via factory for specific repository paths
- **ReferenceResolver**: Created when resolving references

**Why this split?** Global services are stateless or contain shared caches. Scoped services are tied to specific branch contexts or operations and must be created fresh to avoid cross-contamination.

### Default Value Handling

CanopyCMS centralizes default values in the configuration layer using Zod schemas. The `getConfigDefaults()` helper extracts default values from schemas:

```typescript
import { getConfigDefaults } from 'canopycms/config'

const defaults = getConfigDefaults()
// { baseBranch: 'main', remoteName: 'origin', ... }
```

This ensures:
- Single source of truth for defaults
- Type safety from Zod schema validation
- No hardcoded defaults scattered across the codebase

**Usage in services:**
```typescript
const configDefaults = getConfigDefaults()
const createGitManagerFor = (repoPath, opts?) =>
  new GitManager({
    repoPath,
    baseBranch: opts?.baseBranch ?? config.defaultBaseBranch ?? configDefaults.baseBranch,
    remote: opts?.remote ?? config.defaultRemoteName ?? configDefaults.remoteName,
  })
```

### Testing with Services

Mock services for testing by creating a minimal `CanopyServices` object:

```typescript
const mockServices: CanopyServices = {
  config: testConfig,
  flatSchema: flattenSchema(testConfig.schema, testConfig.contentRoot),
  checkBranchAccess: async () => ({ allowed: true }),
  checkPathAccess: async () => 'write',
  checkContentAccess: async () => ({ allowed: true, level: 'write' }),
  createGitManagerFor: () => mockGitManager,
  // ...
}

const ctx: ApiContext = {
  services: mockServices,
  getBranchContext: async () => mockBranchContext,
}

await handler(ctx, req, params)
```

### Benefits of This Architecture

1. **No Global State**: Services are explicitly passed, making dependencies clear
2. **Testable**: Easy to mock services for unit tests
3. **Type Safe**: TypeScript ensures all services are provided
4. **Lambda-Friendly**: Services created once per Lambda instance, reused across requests
5. **Clear Boundaries**: Each layer knows exactly what it has access to

## Storage Architecture

CanopyCMS is entirely file system based. There are no external databases, no Redis/Valkey caching servers, and no separate worker processes by default. This simplifies deployment and operations.

**What gets stored:**
- **Content**: MD/MDX/JSON files in the content directory (committed to git)
- **Branch metadata**: `.canopy-meta/branch.json` per workspace (state, PR references, automatically excluded via git info/exclude)
- **Branch registry**: `branches.json` at branches root (inventory of all branches, gitignored)
- **Comments**: `.canopy-meta/comments.json` per branch (NOT committed to git, automatically excluded)
- **Settings (prod/prod-sim)**: `groups.json` and `permissions.json` on orphan branch `canopycms-settings-{deploymentName}` (version-controlled, deployment-specific)
- **Settings (dev)**: `.canopy-dev/groups.json` and `.canopy-dev/permissions.json` (gitignored, for local development)

**Deployment model**: CanopyCMS is designed to be deployed to a server or serverless function with an attached file system shared by all server processes. On AWS, this could mean Lambda + EFS.

## Content Identification System

Every entry and collection in CanopyCMS has a stable, globally unique identifier that persists across renames and moves. This enables robust reference fields, relationship tracking, and reliable content linking.

### Short UUIDs

CanopyCMS uses **short UUIDs** (12-character Base58-encoded strings) for all content IDs. These are generated using the `short-uuid` package (truncated to 12 chars) and provide:
- **Global uniqueness**: ~58^12 = 2.6 × 10^21 possible IDs; collision probability with 10,000 entries is ~0.000000002%
- **Compact representation**: 12 characters (vs. 36 for standard UUIDs)
- **URL-safe**: Can be used in URLs and APIs without encoding
- **Human-friendly**: Short enough to include in filenames while maintaining uniqueness

Example ID: `a1b2c3d4e5f6`

### ID Storage in Filenames

IDs are embedded directly in filenames and directory names using a simple pattern:

```
content/
  .collection.json
  home.home.agfzDt2RLpSn.json
  posts.916jXZabYCxu/
    .collection.json
    post.hello-world.vh2WdhwAFiSL.json
    post.mermaid-demo.tuggGbrydvYr.json
  authors.q52DCVPuH4ga/
    .collection.json
    author.alice.5NVkkrB1MJUv.json
    author.bob.jm6FYVAtJie8.json
```

**Filename Pattern:**
- Entries: `type.slug.id.ext` (e.g., `post.hello-world.vh2WdhwAFiSL.json`)
- Directories: `slug.id` (e.g., `posts.916jXZabYCxu`)
- Metadata files: No ID (e.g., `.collection.json`, `.gitignore`)

**Benefits:**
- **Stable IDs across moves**: Rename slug portion without breaking references; ID stays in filename
- **Self-contained**: No separate database or symlink directory needed
- **Git-friendly**: IDs visible in diffs, file moves preserve IDs via git mv
- **Atomic operations**: Filesystem renames are atomic
- **Human-readable**: Filenames show both human-friendly slug and unique ID

### Bidirectional ID Index

The `ContentIdIndex` class maintains an in-memory bidirectional mapping between IDs and file paths by scanning filenames:

```
Forward map:  ID → {path, type, collection, slug}
Reverse map:  path → ID
```

This enables O(1) lookups in both directions:
- **Forward**: "What file does ID `a1b2c3d4e5f6` refer to?"
- **Reverse**: "What ID does the file at `content/posts/hello.json` have?"

**Lazy loading optimization**: The index is built on first access by recursively scanning filenames in the content directory. This minimizes Lambda cold starts—building the index for 1000 entries takes approximately 10-50ms. Subsequent accesses are instant (index already in memory).

**Performance characteristics**:
- Cold start (first access): ~10-50ms for 1000 entries
- Warm execution (index in memory): 0ms
- Memory overhead: ~1KB per entry

### Multi-Process Consistency

The index is NOT thread-safe, but the system is designed for eventual consistency across processes:

- **Filenames are source of truth**: Each process rebuilds its index by scanning filenames on disk
- **Atomic operations**: File renames are atomic; all processes discover the same filenames
- **Unique ID generation**: Multiple processes can't create duplicate IDs (globally unique)
- **Collision detection**: Index build fails if duplicate IDs are found
- **Eventual consistency**: One process creating an entry might not be visible to another until that process rebuilds its index (acceptable for human-paced editing workflows)

In most CMS use cases (where editors work at human speeds), race conditions are rare and eventual consistency is sufficient.

## Schema-Driven Content Model

CanopyCMS uses a schema model based on **collections** and **entry types**. Schemas can be defined in two ways:

1. **Configuration-based**: Schema defined directly in `canopycms.config.ts`
2. **File-based**: Schema defined in `.collection.json` files alongside content (with references to a centralized schema registry)

These approaches can be mixed—file-based and config-based schemas are merged together during initialization.

### Schema Structure

The schema is defined as a `RootCollectionConfig` with two optional properties:
- **entries**: Array of entry type configurations (typed content items)
- **collections**: Nested collection hierarchies

**Entry types** define the types of content allowed in a collection. Each entry type has:
- **name**: The type identifier (e.g., 'post', 'doc', 'settings')
- **format**: Content format (md, mdx, json)
- **fields**: Field schema definitions
- **maxItems**: Optional cardinality limit (1 = only one instance allowed, like a singleton)
- **default**: Whether this is the default type for "Add" button

**Collections** contain entry types and can nest other collections. The root itself is a collection (the content root), creating a uniform model where every collection behaves identically.

**Key design principle**: Entry types are schema metadata, not navigable tree nodes. A collection with `entries: [{ name: 'post', ... }]` defines that entries of type "post" can be created in that collection. The entry type itself doesn't appear in navigation—only the collection does.

### Schema Registry and References

The schema registry is a centralized location for field definitions that can be referenced by collection meta files:

**Schema Definitions** (`app/schemas.ts`):
```typescript
import { createSchemaRegistry } from 'canopycms/server'

export const postSchema = [/* field definitions */]
export const authorSchema = [/* field definitions */]
export const docSchema = [/* field definitions */]

export const schemaRegistry = createSchemaRegistry({
  postSchema,
  authorSchema,
  docSchema,
})
```

**Collection Meta File** (`content/posts/.collection.json`):
```json
{
  "name": "posts",
  "label": "Posts",
  "entries": [
    {
      "name": "post",
      "format": "json",
      "fields": "postSchema",
      "default": true
    }
  ]
}
```

The `fields` property contains a string reference (like `"postSchema"`) that is resolved against the registry during initialization. Collections can define multiple entry types, each with different schemas.

**Benefits:**
- **DRY principle**: Field definitions live in one place, referenced by multiple collections
- **Type safety**: Schema registry is defined in TypeScript with full type checking
- **Separation of concerns**: Content structure (meta files) is separate from field definitions (registry)
- **Co-location**: Collection metadata lives with content files, not in config
- **Merge flexibility**: Config-based and file-based schemas can coexist

### Schema Meta Files

Each collection folder can contain a `.collection.json` file that defines:
- Collection name and label
- Entry type configurations (array of typed content definitions)

**Structure:**
```
content/
  .collection.json           # Root collection (optional)
  posts/
    .collection.json         # Posts collection definition
    hello.json
    world.json
  docs/
    .collection.json         # Docs collection
    guides/
      .collection.json       # Nested guides collection
      getting-started.md
```

**Root collection** (`content/.collection.json`):
- No `name` or `path` fields (derived from contentRoot)
- Can define root-level entry types
- Optional—system works without it

**Nested collections**:
- Collection path is derived from folder structure, not from meta file
- Each collection can have its own `.collection.json`
- Nesting is detected automatically by scanning subdirectories

**Entry type cardinality**: Entry types with `maxItems: 1` provide singleton-like behavior where only one instance of that type can exist. For example, a settings entry type with `maxItems: 1` ensures only one settings file can be created.

### Schema Resolution System

Schema resolution happens during service initialization through a multi-step process:

**Step 1: Load meta files** (`loadCollectionMetaFiles`)
- Recursively scans content directory for `.collection.json` files
- Parses and validates each file using Zod schemas
- Returns raw metadata with string references to schema registry

**Step 2: Resolve references** (`resolveCollectionReferences`)
- Takes loaded meta files and schema registry
- Replaces string references (like `"postSchema"`) with actual field definitions
- Validates that all referenced schemas exist in the registry
- Builds nested collection hierarchy

**Step 3: Merge with config**
- Config-defined schemas are merged with file-based schemas
- Collections are concatenated
- Config entries take precedence if root defines entries in both places

**Step 4: Flatten schema**
- Final merged schema is flattened into `Map<path, FlatSchemaItem>` for O(1) lookups
- All path resolution and validation happens at initialization, not request time

**Error handling:**
- Clear error messages when referenced schemas don't exist
- Lists available schema registry keys in error messages
- Validates collection structure during parse (must have entries or collections)
- Throws if no schema is provided (neither config nor meta files)

### Async Initialization Pattern

The schema resolution system requires async initialization because it reads files from disk:

**Service creation** is async:
```typescript
const services = await createCanopyServices(config, schemaRegistry)
```

**Context creation** in framework adapters:
```typescript
// Create once at module load
const canopyContextPromise = createNextCanopyContext({
  config,
  authPlugin,
  schemaRegistry,
})

// Export getters that await the promise
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}
```

**Why this pattern:**
- **One-time cost**: File scanning happens once at server startup, not per request
- **Shared services**: All requests use the same services instance with cached schemas
- **Lambda-safe**: In serverless environments, the promise resolves once per container lifecycle
- **Type safety**: Async await ensures services are fully initialized before use

### Watch System for Meta Files

In development mode, the system watches for changes to `.collection.json` files:

```typescript
watchCollectionMetaFiles(contentRoot, onChange)
```

**Implementation:**
- Uses `chokidar` library for efficient file watching
- Watches pattern: `${contentRoot}/**/.collection.json`
- Triggers callback on: add, change, unlink events
- Returns cleanup function to stop watching

**Current limitation:**
- Watch system exists but auto-reload is not yet implemented
- Server restart required after meta file changes
- Future: Hot reload of schema without server restart

### Schema Flattening

At initialization, the hierarchical schema is flattened into a `Map<path, FlatSchemaItem>` for O(1) lookups. Each flattened item is a discriminated union:

**Collection item**:
- `type: 'collection'`
- `logicalPath`: Complete logical path from content root (e.g., "content/blog") - branded type for compile-time safety
- `entries`: Optional array of entry type configurations
- `collections`: Optional nested collections
- `name`, `label`, `parentPath`: For navigation and display

**Entry type item**:
- `type: 'entry-type'`
- `logicalPath`: Complete logical path including entry type name (e.g., "content/posts/post") - branded type
- `name`: Entry type name (e.g., 'post', 'doc')
- `format`: Content format (md, mdx, json)
- `fields`: Field definitions
- `maxItems`: Optional cardinality limit
- `parentPath`: Logical path of the parent collection

**Important**: The content root itself is included as a collection with `type: 'collection'`, `logicalPath: 'content'`, and `parentPath: undefined`. Root-level collections have `parentPath: 'content'`, making them children of the content root. This eliminates all special-casing for root vs. nested collections.

### Content Store Integration

The `ContentStore` uses the flat schema index for O(1) path resolution:

**Path resolution** (`resolvePath`):
1. Split the path into segments
2. Look up the collection in the flat schema map
3. Determine if the path refers to an entry type (has a slug) or the collection itself
4. Return the schema item, slug, and entry type

**Reading and writing**:
- `read()` and `write()` accept a collection path and slug
- All entries use the unified filename pattern `{type}.{slug}.{id}.{ext}`
- The entry type configuration determines format, fields, and file extension
- `maxItems` is enforced as a schema constraint, not a filename difference

The API works uniformly across all entry types regardless of cardinality constraints.

### API Layer

The API exposes collections through a unified interface:

**Collection summaries** (`buildCollectionSummaries`):
- Returns only collections (not individual entry types)
- Collections have `type: 'collection'`
- Entry types are part of the collection configuration, accessed via `collection.entries`

**Entries list** (`listCollectionEntries`):
- Returns entries based on the collection's entry type configurations
- Supports multiple entry types per collection (each type can have different schemas)
- Entry types with `maxItems: 1` are included if they exist
- Entry filenames include type information for multi-type collections

**Entry identification**:
- Entries have a `slug` derived from filename
- Entry type is determined by filename pattern or extension
- All entries have a `collectionId` pointing to their parent collection path

### API Middleware

Common patterns in API handlers are extracted into middleware functions to reduce duplication and ensure consistent behavior.

**Branch Access Guards**: The `guardBranchAccess` middleware extracts the common pattern of checking both branch existence and user access permissions. It returns either a success result with the branch context or an error response ready to be returned to the client.

```
// Before: duplicated in many handlers
const branch = await ctx.services.branchRegistry.get(branchName)
if (!branch) return ctx.json({ error: 'Branch not found' }, 404)
const hasAccess = await checkBranchAccess(...)
if (!hasAccess) return ctx.json({ error: 'Access denied' }, 403)

// After: single middleware call
const result = await guardBranchAccess(ctx, branchName)
if (isBranchAccessError(result)) return result.response
const { context } = result
```

**Guard Variants**:
- `guardBranchAccess`: Checks both existence and user permissions (for most handlers)
- `guardBranchExists`: Checks only existence (for handlers that do their own permission logic)

This pattern reduces code duplication across API handlers while keeping the authorization logic visible and explicit.

### Editor Integration

The editor uses collection-based navigation:

**Navigation**:
- `buildEditorCollections()` returns only collections, not individual entry types
- Entry types are schema metadata that define what can be created in a collection
- Collections appear as navigable tree nodes in the content navigator
- Entry types appear in "Add" buttons and entry type selectors, not as navigation nodes

**Preview URLs**:
- Collections map to base preview paths
- Individual entries append their slug to the collection's preview base
- Entry types with `maxItems: 1` use their type name as the slug

**Form rendering**:
- All entries use the same field rendering infrastructure
- Entry type configuration determines which fields appear
- Multi-type collections can have different forms for different entry types

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

CanopyCMS supports three operating modes to fit different environments. The mode is configured in `canopycms.config.ts` and defaults to `'dev'` if not specified. After Zod validation, `config.mode` is always defined and can be used throughout the codebase without fallback checks.

### dev
Direct file editing in the current checkout. No git cloning occurs. Best for solo development where the developer manages their own branch via git commands.

### prod-sim
Simulates production behavior locally. Creates per-branch clones in `.canopy-prod-sim/branches/` and maintains a local git remote at `.canopy-prod-sim/remote.git`. Use this for testing the full branch workflow without deploying.

### prod
Full production deployment. Branch workspaces live on persistent storage (e.g., EFS on AWS). Integrates with GitHub for PR creation and management. Designed for team collaboration with proper review workflows.

Settings (groups and permissions) are stored on a separate `settingsBranch` (default: 'canopycms-settings') in prod mode, with changes creating PRs for review before merging to main. This ensures permission changes go through the same review process as content changes.

**Security**: In prod/prod-sim modes, the system will throw an error if the settings branch cannot be loaded, ensuring permissions are never accidentally read from a content branch. Settings files also include a `contentVersion` field for optimistic locking to prevent concurrent admin updates from overwriting each other.

### Mode Strategy Pattern

Operating modes are implemented using the Strategy pattern, which encapsulates mode-specific behavior into strategy objects. Each mode has two strategy implementations:

- **ClientSafeStrategy**: Contains UI feature flags and simple configuration (no Node.js APIs). Safe for 'use client' components.
- **ClientUnsafeStrategy**: Extends ClientSafeStrategy with server-side functionality (file system operations, git integration).

**Key design principle**: Strategies return configuration values and flags, not business logic. Complex operations (like git commands) are handled by domain-specific managers (GitManager, BranchWorkspaceManager) that use strategy flags to make decisions.

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

Access control uses three layers that all must pass. These are implemented in the unified authorization module.

### Layer 1: Branch Access
Per-branch ACLs control who can access a branch. Branches can be restricted to specific users or groups. Admins and reviewers always have access. Implemented in the `branch.ts` submodule.

### Layer 2: Path Permissions
Glob patterns (e.g., `content/posts/**`) restrict who can edit specific content paths. First matching rule wins. Only admins bypass path rules. Implemented in the `path.ts` submodule.

### Layer 3: Content Access
Combines branch and path checks into a single decision. Returns detailed denial reasons for debugging. The `checkContentAccess` function in `content.ts` is the main entry point for most authorization checks.

**Reserved groups** provide consistent roles:
- **admins**: Full access to all operations
- **reviewers**: Can review branches, request changes, approve PRs

Helper functions (`isAdmin`, `isReviewer`, `isPrivileged`) provide convenient role checking.

**Where permissions are stored:**
- **Dev mode**: Settings in `.canopy-dev/groups.json` and `.canopy-dev/permissions.json` (gitignored, local development only)
- **Prod/prod-sim modes**: Settings on orphan branch `canopycms-settings-{deploymentName}` (version-controlled, deployment-specific)
- Branch ACLs are stored in each branch's metadata file (`.canopy-meta/branch.json`)

The `permissions/` and `groups/` subdirectories handle file schema definitions and loading logic for these configuration files.

## Git Operations Architecture

CanopyCMS uses a layered approach to Git operations, separating low-level primitives from high-level business logic.

### Three-Layer Architecture

**Layer 1: GitManager (Low-level primitives)**
- Wraps simple-git library with basic git operations
- Methods: `status()`, `add()`, `commit()`, `push()`, `checkout()`, etc.
- No knowledge of CanopyCMS concepts (branches, authors, context)
- Pure git operations that could be used outside of CanopyCMS

**Layer 2: CanopyServices git methods (High-level operations)**
- Provides context-aware git operations with automatic author handling
- `commitFiles({ context, files, message })` - Commits files with automatic git author injection
- `submitBranch({ context, message? })` - Full submission workflow (status check, commit, push)
- Encapsulates common patterns: create GitManager, configure author, perform operations
- Uses BranchContext which contains all necessary path information

**Layer 3: API handlers (Business workflows)**
- Call service methods to perform git operations
- Focus on workflow logic (permissions, metadata updates, PR creation)
- No direct git author configuration or path resolution needed

### GitManager and Strategies

GitManager provides low-level git primitives (status, add, commit, push, etc.). It uses operating mode strategies to get configuration values:

```typescript
// Strategy provides configuration
const config = strategy.getRemoteUrlConfig()
// Returns: { shouldAutoInitLocal: boolean, defaultRemotePath: string, envVarName: string }

// GitManager owns the logic
if (config.shouldAutoInitLocal) {
  const gitRoot = await GitManager.findGitRoot()
  const localRemotePath = path.join(gitRoot, config.defaultRemotePath)
  await GitManager.ensureLocalSimulatedRemote({ remotePath: localRemotePath, ... })
  return localRemotePath
}
```

This separation ensures strategies remain simple value objects while GitManager handles complex git operations.

### Design Rationale

**Why separate primitives from business logic?**
- GitManager can be tested independently of CanopyCMS concepts
- Service methods centralize author configuration (no forgotten credentials)
- API handlers stay focused on workflow, not git mechanics

**Why automatic author handling in service methods?**
- Eliminates boilerplate: reduces 8-12 lines to 1 line per operation
- Prevents bugs from forgotten `ensureAuthor()` calls
- Author credentials come from config, injected automatically

**Why use named arguments?**
- Better API ergonomics: `commitFiles({ context, files, message })` is clearer than positional arguments
- Extensible: can add optional parameters without breaking existing calls
- Self-documenting: parameter names visible at call site

**Why BranchContext contains path information?**
- Context already has `branchRoot` and `baseRoot` from branch resolution
- No need to re-derive paths or use intermediate `branchPaths` objects
- Single source of truth for branch-related paths

### Code Reduction Impact

The refactoring eliminated the `branchMode` + `resolveBranchPaths` pattern across 18 API handler instances. Previously, handlers would:

```
const branchMode = ctx.services.config.mode ?? 'dev'
const branchPaths = resolveBranchPaths(branchMode, context.branch.name)
const git = ctx.services.createGitManagerFor(branchPaths.branchRoot)
await git.ensureAuthor({
  name: ctx.services.config.gitBotAuthorName,
  email: ctx.services.config.gitBotAuthorEmail,
})
await git.add('.')
await git.commit(message)
await git.push(context.branch.name)
```

Now handlers simply:

```
await ctx.services.submitBranch({ context })
```

This reduces complexity, improves readability, and ensures consistent author handling across all git operations.

### Settings-Specific Git Helpers

Groups and permissions (collectively "settings") have unique git operation requirements that differ from content operations. The `settings-helpers.ts` module provides centralized, mode-aware logic for settings operations.

**Why separate helpers for settings?**

Settings files need different branch handling across modes:
- **dev**: Settings in `.canopy-dev/` (not in git)
- **prod-sim**: Settings on orphan branch `canopycms-settings-{deploymentName}`, regular git operations
- **prod**: Settings on orphan branch `canopycms-settings-{deploymentName}`, creates PR for review

Content operations always work on the current branch. Settings operations need to route to the appropriate branch based on mode.

**Two core helpers:**

**`getSettingsBranchContext()`**: Determines which branch to use for settings
- Returns appropriate branch context based on operating mode
- In `prod` mode: Uses `settingsBranch` config (default: 'canopycms-settings')
- In local modes: Uses `defaultBaseBranch` (default: 'main')
- Returns both the context and mode for downstream operations
- **Security**: Throws error if settings branch cannot be loaded in prod/prod-sim modes

**`commitSettings()`**: Commits and pushes settings changes with mode-specific logic
- **dev**: No-op (no git operations)
- **prod-sim**: Regular `commitFiles()` call
- **prod**: Uses `commitToSettingsBranch()` with optional PR creation

**Configuration:**
- `settingsBranch`: Branch name for settings in prod mode (default: 'canopycms-settings')
- `autoCreateSettingsPR`: Whether to create PR automatically in prod (default: true)

**Code reduction impact:**

Before settings-helpers, both `permissions.ts` and `groups.ts` contained ~20 lines each of duplicate mode-checking logic. The helpers eliminate approximately 40 lines of duplicated code by extracting the common pattern.

Handler code before:
```
const mode = ctx.services.config.mode ?? 'dev'
let branchName: string
if (mode === 'prod') {
  branchName = ctx.services.config.settingsBranch ?? 'settings'
} else {
  branchName = ctx.services.config.defaultBaseBranch ?? 'main'
}
const context = await ctx.getBranchContext(branchName)
// ... then mode-specific commit logic
```

Handler code after:
```
const result = await getSettingsBranchContext(ctx)
const { context, mode } = result
// ... operate on settings
await commitSettings(ctx, { context, branchRoot, fileName, message, mode })
```

**Why this design?**

- **Single source of truth**: Mode-to-branch mapping logic exists in one place
- **Consistent behavior**: Permissions and groups APIs use identical logic
- **Testability**: Settings helpers can be tested independently of API handlers
- **Extensibility**: Future settings (site config, workflow rules) can reuse the same helpers

This pattern complements the general git service methods by addressing the unique branch routing requirements of settings files.

## Content Workflow

### Creating and Editing
1. User opens or creates a branch
2. System opens existing workspace or creates new clone (in prod modes)
3. User makes edits through the editor UI
4. Each save writes directly to files in the branch workspace
5. Live preview shows changes immediately

### Submitting for Review
1. User clicks "Submit"
2. Service layer commits all changes and pushes to remote (via `submitBranch()`)
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
- Comments are stored per-branch in `.canopy-meta/comments.json`
- Comments are NOT committed to git—they're review artifacts, automatically excluded via git info/exclude
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

### State Management

The editor uses React Context for dependency injection and state management:

**ApiClientContext**: Provides the API client instance to all editor components. This replaces lazy singletons with explicit dependency injection, improving testability and eliminating global state.

**EditorStateContext**: Consolidates editor-wide state including:
- Loading states (which operations are in progress)
- Modal states (which dialogs are open)
- Preview data (current preview state)

This context-based architecture allows components to access shared state without prop drilling while maintaining clear boundaries for testing and state isolation.

### Custom Hooks

Complex state management logic is extracted into custom hooks:
- **useBranchManager**: Branch selection and lifecycle management
- **useEntryManager**: Entry CRUD operations
- **useDraftManager**: Draft state and auto-save
- **useCommentSystem**: Comment threading and resolution
- **useGroupManager**: Group administration
- **usePermissionManager**: Permission rule management
- **useReferenceResolution**: Async reference data loading with caching

This extraction keeps components focused on rendering while hooks encapsulate business logic and side effects.

### Live Preview Reference Resolution

The live preview needs to display full referenced content (e.g., author names/data) instead of just reference IDs. This is accomplished through a synchronous resolution system with background caching.

**The Challenge:**

When a user selects a reference (e.g., choosing "Alice" as the post author), the form stores just the ID (`5NVkkrB1MJUvnLqEDqDkRN`). But the preview needs the full author object with `name`, `bio`, etc. to render properly. Naively fetching this data asynchronously creates race conditions during state transitions (like "Discard All Drafts").

**The Solution: Synchronous Resolution with Background Caching**

The system uses a two-phase approach:

1. **Synchronous Transform (useMemo):**
   - When form data changes, immediately compute a "resolved value" by applying cached reference data
   - If a reference ID is in cache, substitute the full object; otherwise, keep the ID
   - This happens synchronously during render, so there are no async gaps
   - The preview always receives complete, valid data

2. **Background Async Resolution (useEffect):**
   - Identify which reference IDs aren't in cache yet
   - After a 300ms debounce, fetch those IDs from the API endpoint
   - Update the cache with resolved objects
   - Trigger a re-computation of the synchronous transform
   - The preview updates again, now with full data

**Key Architectural Decisions:**

- **Single source of truth**: The resolved value is computed from `form data + cache`, not maintained as separate state
- **No race conditions**: The synchronous transform guarantees the preview never receives partial/empty data
- **Progressive enhancement**: Preview shows IDs initially (loading state), then full objects after resolution
- **Persistent cache**: Cache survives across edits, so subsequent renders are instant
- **Branch-scoped cache**: Cache clears when switching branches to avoid stale cross-branch data

**Implementation Files:**

- `src/api/resolve-references.ts` - API endpoint that resolves reference IDs to full objects
- `src/editor/client-reference-resolver.ts` - Client-side utility for incremental resolution
- `src/editor/FormRenderer.tsx` - Synchronous resolution logic using useMemo + background caching

**Example Flow:**

1. User selects "Alice" as author → form stores ID `5NVkkrB1MJUvnLqEDqDkRN`
2. useMemo runs: cache is empty, so resolvedValue has `author: "5NVkkrB1MJUvnLqEDqDkRN"` (ID)
3. Preview renders with ID (AuthorCard shows loading state)
4. After 300ms, useEffect fetches Alice's full data from API
5. Cache updated with `{"5NVkkrB1MJUvnLqEDqDkRN": {id: "...", name: "Alice", bio: "..."}}`
6. useMemo re-runs: now resolvedValue has full author object
7. Preview updates, AuthorCard shows "Alice" with bio

**Why This Approach:**

Alternative approaches (async state, callbacks, separate resolution state) create synchronization problems between two state trees (form data + resolved data). By computing resolved data synchronously from a single source (form data + cache), we eliminate timing issues and race conditions entirely.

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

### Why do settings use a separate branch in prod mode?
In production, permission and group changes are stored on a dedicated settings branch (default: 'settings') rather than on content branches. This design provides several benefits:

**Isolation from content changes:**
- Permission updates don't interfere with content editing workflows
- Content PRs don't accidentally include permission changes
- Settings changes can be reviewed independently

**Controlled merge process:**
- Settings PRs must be explicitly reviewed and merged
- No automatic merging—requires deliberate action
- Prevents accidental permission escalation or lockout

**Audit trail:**
- Dedicated settings branch provides clear history of permission changes
- Easy to see who changed permissions and when
- Can diff settings branch against main to see current vs proposed state

**Local modes use main branch:**
- In `dev` and `prod-sim`, settings are stored on main for simplicity
- No separate branch management needed for local development
- Settings changes are immediate (no PR workflow needed)

The `settings-helpers` pattern abstracts this branching logic so API handlers don't need mode-specific conditionals.

### Why three permission layers?
Defense in depth. Branch access controls who can see a branch. Path permissions control what content they can edit. Combining them provides flexible policies: you might let someone access a branch but restrict them to certain content paths within it.

### Why modularize into focused subdirectories?

The codebase underwent a major refactoring to decompose large files (600-1100+ lines) into focused modules. This provides several benefits:

**Improved navigation**: Instead of scrolling through a 1000-line file looking for a function, developers can navigate to a specific module with a clear name. The module index file serves as documentation of what the module provides.

**Explicit dependencies**: When a module imports from another module, the dependency is visible. This makes the architecture easier to understand and helps prevent circular dependencies.

**Testability**: Smaller modules with well-defined interfaces are easier to test in isolation. Mock boundaries become clearer.

**Code ownership**: Different modules can have different owners or expertise requirements. Authorization logic can be reviewed by security-focused developers while UI components can be reviewed by frontend specialists.

**Bundle optimization**: Client-safe code is separated from server-only code (e.g., `normalize.ts` vs `normalize-server.ts` in paths module). This prevents accidental inclusion of Node.js APIs in browser bundles.

**Examples of decomposition**:
- Authorization: Branch access, path permissions, and content access separated into focused files with a unified entry point
- Configuration: Zod schemas organized by concern (field, collection, permissions, media)
- Paths: Branded types, normalization, validation, and branch resolution in separate files
- Editor hooks: Each major feature (branch, entry, draft, comments, etc.) has its own hook

The tradeoff is slightly more complex import paths, but the improved maintainability is worth it for a codebase of this size.

### Why separate packages for auth and framework adapters?
Keeps the core framework-agnostic. Adopters only install what they need. Testing is simpler because the core doesn't depend on Next.js or Clerk. New frameworks and auth providers can be supported without modifying core code.

### Why do git operations in the request cycle (no worker)?
Simplicity. Git operations (clone, commit, push) happen synchronously during API requests rather than being queued to a separate worker process. This avoids the complexity of job queues, worker coordination, and eventual consistency. For most content editing use cases, git operations complete fast enough. If this becomes a bottleneck, a worker architecture could be added later.

### Why layer git operations (GitManager vs service methods)?

The three-layer architecture separates concerns and improves maintainability:

**GitManager (primitives):**
- Pure git operations without CanopyCMS knowledge
- Can be tested independently
- Reusable in contexts outside CanopyCMS

**Service methods (business logic):**
- Encapsulate common patterns: author configuration, context handling
- Provide single-line operations for complex workflows
- Centralize author credential management (prevents forgotten `ensureAuthor()` calls)
- Use BranchContext which already contains all necessary path information

**API handlers (workflows):**
- Focus on business logic: permissions, metadata, PR creation
- No direct git mechanics or path resolution needed
- Cleaner, more readable code (8-12 lines reduced to 1)

**Why automatic author injection in service methods?**

Git commits require author information. Without centralization, each handler would need:

```
const git = createGitManagerFor(...)
await git.ensureAuthor({
  name: config.gitBotAuthorName,
  email: config.gitBotAuthorEmail,
})
```

This pattern appeared in 18+ handlers. Forgetting it causes cryptic git errors. Service methods like `commitFiles()` and `submitBranch()` handle this automatically, pulling credentials from config. This is a form of dependency injection—handlers declare what operation they want, the service layer provides the dependencies.

**Why named arguments in service methods?**

Compare positional vs named:

```
// Positional (unclear, rigid)
await commitFiles(context, ['file.json'], 'Save content')

// Named (self-documenting, extensible)
await commitFiles({ context, files: ['file.json'], message: 'Save content' })
```

Named arguments:
- Make call sites self-documenting (no need to check parameter order)
- Allow adding optional parameters without breaking existing calls
- Prevent argument order mistakes
- Align with modern JavaScript/TypeScript patterns

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

### Why React Context for editor state management?

The editor previously used module-level singletons for shared state like the API client. This approach has several problems:
- Hard to test (global state persists between tests)
- No isolation between editor instances (if you had multiple)
- Hidden dependencies (imports don't show the dependency)

React Context provides explicit dependency injection:
- **ApiClientContext**: Provides the API client to all editor components
- **EditorStateContext**: Provides shared loading/modal/preview state

**Benefits:**
- Testable: Wrap components in test providers with mock implementations
- Explicit: Dependencies are visible in the component tree
- Isolated: Each provider instance has its own state
- Standard: Uses React's built-in patterns

**Custom hooks for complex logic**: State management logic is extracted from components into custom hooks (useBranchManager, useEntryManager, etc.). This keeps components focused on rendering while hooks encapsulate side effects and business logic.

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

### Why branded types for paths?

Path handling is notoriously error-prone because different contexts need different path representations. A "logical" content path like `posts/hello` means something different from a "physical" filesystem path like `/var/data/branches/feature-1/content/posts/hello.json`.

The paths module uses TypeScript branded types to distinguish between:
- **LogicalPath**: Content-relative paths used in URLs and APIs
- **PhysicalPath**: Absolute filesystem paths
- **CollectionPath**: Paths that identify collections
- **SanitizedBranchName**: Branch names that have passed security validation

These are nominal types (string with a brand) that the compiler tracks separately. Passing a `LogicalPath` where a `PhysicalPath` is expected causes a compile error.

**Benefits:**
- Catch path misuse at compile time, not runtime
- Self-documenting function signatures
- Prevents accidental path concatenation errors
- Makes security-sensitive code more reviewable

**Tradeoffs:**
- Requires explicit conversion between path types
- Slightly more verbose at boundaries
- Need to maintain type guards and conversion functions

The safety benefits outweigh the verbosity cost, especially for security-sensitive path operations where a bug could lead to path traversal vulnerabilities.

### Why filename-embedded content IDs?

A robust reference system requires stable, globally unique identifiers that survive file renames and moves. The decision to embed IDs directly in filenames provides several advantages over alternatives:

**Alternative approaches considered:**
- **Database IDs**: Would add external dependency, complicating deployment and git synchronization
- **File-based registry** (e.g., JSON mapping): Requires synchronization logic and introduces write conflicts in concurrent environments
- **Git objects** (blob hashes): Not stable across file edits; changes whenever content changes
- **Symlink directory** (previous approach): Required separate `_ids_/` directory; added filesystem overhead and complexity

**Why filename-embedded IDs?**
- **Self-contained**: No separate database, registry, or symlink directory needed
- **Atomic operations**: File renames are atomic on all filesystems; no partial state possible
- **Git-friendly**: IDs visible in diffs and preserved through `git mv`
- **Human-readable**: Filenames show both slug (human-friendly) and ID (unique)
- **Process-agnostic**: Multiple processes can safely read the same filenames without synchronization
- **Zero overhead**: No extra files or symlinks; IDs are part of the natural filename structure

The filename-embedded approach provides the same stability and uniqueness guarantees as symlinks, but with simpler filesystem structure and better human readability.

### Why lazy index loading for Lambda cold starts?

Scanning thousands of files during every request would be expensive. The lazy loading approach defers index building until first access:

- **First access** (cold start): Recursively scan filenames in content directory and build in-memory maps. ~10-50ms for 1000 entries.
- **Subsequent accesses** (warm): Index already in memory. Lookups are 0ms.
- **Cross-request**: In serverless functions, subsequent requests reuse the same Lambda execution context, so the index stays warm.

This optimization is critical for serverless deployments where cold starts are inevitable. The 10-50ms cost is paid once per container lifecycle, not per request.

### Why in-memory index over filesystem queries?

Once built, the index enables O(1) lookups instead of filesystem syscalls:

- **Filesystem queries**: Each lookup would require directory scans and filename parsing. Much slower.
- **In-memory maps**: Two hashmap lookups (forward and reverse). Microsecond-level latency.
- **Memory cost**: ~1KB per entry. For 10,000 entries, ~10MB. Acceptable for serverless budgets.

The tradeoff favors speed over raw memory usage, which is the right choice for request-path latency.

### Why eventual consistency for the index?

The index is per-process, not globally synchronized. This design choice accepts eventual consistency for robustness:

- **No locking**: Avoids distributed lock complexity and deadlock risks
- **No write conflicts**: Each process independently rebuilds by scanning filenames
- **Self-healing**: If a process's index gets stale, it can rebuild on demand
- **Suitable for CMS workflows**: Editors work at human speeds; millisecond-level race conditions don't materialize in practice

For a system handling hundreds of concurrent API requests (serverless autoscaling), process-local indexes with eventual consistency is simpler and more scalable than a shared, synchronized index.

### Why entry types model instead of singletons?

The entry types model treats all content as typed entries within collections, with cardinality constraints (like `maxItems: 1`) providing singleton-like behavior. This design provides several advantages:

**Eliminates special cases:**
- No separate "singleton" concept—just entry types with `maxItems: 1`
- Root and nested collections have identical structure
- No need for heuristic detection of root-level singletons
- Recursive traversal becomes straightforward

**Content root as normal collection:**
- The content root (`content/`) is a collection with `type: 'collection'`, `logicalPath: 'content'`, `parentPath: undefined`
- Root-level collections are children of the content root with `parentPath: 'content'`
- No special-casing for root vs. nested collections
- Eliminates all "is this root-level?" checks

**Entry types are schema metadata:**
- Entry types define what can be created in a collection
- They don't appear as navigable nodes in the tree
- Collections are navigable; entry types are schema configuration
- Clearer separation between structure (collections) and content types (entry types)

**Type safety:**
- `FlatSchemaItem` is a discriminated union with `type: 'collection' | 'entry-type'`
- TypeScript enforces correct access to fields based on type
- Compile-time detection of invalid schema operations

### Why flatten schema into a Map?

The flattening process converts the hierarchical schema into `Map<path, FlatSchemaItem>` for performance:

**O(1) lookups:**
- Path resolution is a single Map lookup, not tree traversal
- Critical for request-path latency in serverless environments
- Scales to thousands of collections without performance degradation

**Precomputed paths:**
- Full paths are computed once at initialization
- No repeated path joining or normalization during requests
- Eliminates path traversal vulnerability checks from hot path

**Validation at init time:**
- Invalid paths or structure detected during startup
- Fast failure instead of runtime errors
- All collections verified reachable and non-conflicting

**Memory tradeoff:**
- Small memory overhead (few KB per collection)
- Flat map is much faster than hierarchical tree traversal
- Index is shared across all requests (not duplicated per-request)

The alternative (traversing the tree on every request) would add milliseconds to every content access, making serverless deployments impractical.

### Why flatten content root as a normal collection?

The content root is included in the flattened schema as a normal collection with `type: 'collection'`, `logicalPath: 'content'`, and `parentPath: undefined`:

**Eliminates special cases:**
- No separate code path for "is this root-level?" checks
- Root-level collections simply have `parentPath: 'content'`
- Entry types at root level have `parentPath: 'content'`, just like nested entry types
- Collection traversal logic works uniformly

**Simpler parent-child relationships:**
- Every collection except content root has a parent
- Content root is the only collection with `parentPath: undefined`
- Clear tree structure with a single root node
- No ambiguity about where root-level items belong

**Consistent API:**
- `buildEditorCollections()` can start with `parentPath: undefined` and find the content root
- All collections use the same lookup and traversal patterns
- No special handling for root vs. nested items

**Performance:**
- Same O(1) lookup performance
- One additional item in the flat schema (negligible)
- Eliminates conditional logic in hot paths

This design change removed extensive heuristic detection code that tried to determine if an entry type was "root-level" based on path prefixes and special cases.

### Why use entry type name for maxItems: 1 filenames?

Entry types with `maxItems: 1` store their files using the entry type name as part of the filename pattern:

**Predictable file locations:**
- File is stored at the collection root: `{collectionPath}/{entryTypeName}.{id}.{ext}`
- For root-level: `content/settings.abc123.json`
- For nested: `content/blog/config.def456.json`
- No ambiguity about where the file lives

**Consistent ID system:**
- Same ID-in-filename pattern as regular entries
- Same stable reference system
- Same rename and move handling

**Multi-type collection support:**
- A collection can have both `maxItems: 1` types and unlimited types
- Each type's files are clearly identified by type name in the filename
- No conflicts or special-casing needed

**API uniformity:**
- Same `read(path, slug)` API
- Entry type name can be used as a predictable slug
- No separate code paths for cardinality-constrained types

This approach treats `maxItems: 1` as a schema constraint, not a fundamentally different content model.

### Why async service initialization?

The introduction of schema meta files requires async initialization of CanopyCMS services. This architectural change has implications across the system:

**The problem:**
- Loading `.collection.json` files from disk is an async operation (file I/O)
- Schema resolution depends on these files
- Services need a fully resolved schema before they can operate
- Synchronous initialization is no longer possible

**The solution: Async initialization with promise caching**

Services are created once at module load time, with the promise cached:

```typescript
// Create once (async)
const canopyContextPromise = createNextCanopyContext({
  config,
  authPlugin,
  schemaRegistry,
})

// Export getters that await the promise
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}
```

**Benefits:**
- **One-time cost**: File scanning happens once per server/container lifecycle
- **Shared services**: All requests await the same promise, get the same services instance
- **Lambda optimization**: In serverless, the promise resolves once per container and is reused
- **Error handling**: Initialization errors are thrown once, not on every request
- **Type safety**: TypeScript enforces await at call sites

**Performance characteristics:**
- **Cold start**: ~10-50ms to scan and parse meta files (small projects)
- **Warm requests**: 0ms (promise already resolved, services cached)
- **Memory overhead**: Minimal (one services instance per process)

**Alternatives considered:**

**Synchronous initialization with lazy loading:**
- Would require reading meta files on first access (blocking request)
- Race conditions if multiple requests trigger loading simultaneously
- Complex locking/memoization logic needed
- Rejected: Async upfront is simpler and more predictable

**Callback pattern:**
```typescript
createCanopyServices(config, (services) => {
  // Use services
})
```
- Non-standard pattern in modern JavaScript/TypeScript
- Difficult to integrate with framework request handlers
- Rejected: Promises are standard, better error handling

**Synchronous config with runtime meta file loading:**
- Services initialize synchronously from config
- Meta files loaded lazily per-request
- Would eliminate async initialization but lose caching benefits
- Rejected: Per-request file I/O is too slow

**Why the promise caching pattern works:**

In Node.js and serverless environments, module-level variables persist across requests within the same process/container. The cached promise ensures:

1. First request (cold): Promise resolves, reads meta files, creates services
2. Subsequent requests (warm): Promise is already resolved, returns immediately
3. All requests: Use the same services instance with shared schema cache

This pattern is common in Next.js and other frameworks for expensive initialization (database connections, external API clients, etc.).

**Developer experience:**

The async pattern is explicit at usage sites:

```typescript
// Clear that initialization is async
const canopy = await getCanopy()
const data = await canopy.read(...)
```

TypeScript enforces the await, preventing accidental usage before initialization completes. The pattern is consistent with async/await conventions throughout the modern JavaScript ecosystem.

### Why don't entry types appear in navigation?

Entry types are schema metadata, not navigable tree nodes. The `buildEditorCollections()` function returns only collections:

**Clear mental model:**
- Collections = navigable containers (folders)
- Entry types = content type definitions (schemas)
- Navigation tree shows structure, not schema

**Prevents confusion:**
- Without this separation, users might think entry types are special folders
- Entry types like "post" would appear as nodes alongside their parent collection "posts"
- The tree would conflate structure (where things are) with schema (what can be created)

**Simpler UI:**
- Collections have child collections (nesting)
- Entry types appear in "Add" buttons and type selectors
- Clear separation between browsing (collections) and creating (entry types)

**Consistent with filesystem:**
- Collections map to directories
- Entry types map to file types (like .md vs .json)
- You navigate directories, not file types

**Cardinality is a constraint:**
- `maxItems: 1` is a validation rule, not a structural distinction
- Entry types with `maxItems: 1` aren't fundamentally different from unlimited types
- Both are content types; the only difference is how many instances are allowed

This design emerged from removing the old singleton concept, which conflated schema constraints with navigable structure.

### Why is this architecture simpler than the old singleton model?

The transition from singletons to entry types with cardinality constraints eliminated significant complexity:

**Before (singleton model):**
- Separate `SingletonConfig` type alongside `CollectionConfig`
- Root-level singletons needed special detection ("is this path root-level?")
- Flattening logic had separate code paths for singletons vs. collections
- Navigation logic needed to distinguish between singleton nodes and collection nodes
- API layer exposed both `type: 'collection'` and `type: 'entry'` (confusing naming)
- Path resolution had singleton-first fallback logic

**After (entry types model):**
- Single `EntryTypeConfig` type used uniformly
- Content root is just a collection with `parentPath: undefined`
- All collections have identical structure regardless of nesting level
- Entry types are schema metadata, not navigable nodes
- `buildEditorCollections()` returns only collections
- No special detection or fallback needed

**Code reduction:**
- Eliminated extensive "is root-level?" heuristics throughout the codebase
- Removed separate singleton handling in navigation tree building
- Simplified path resolution (no singleton-first logic)
- Unified API responses (collections only, with entry types as configuration)

**Conceptual simplification:**
- Collections are structure (navigable containers)
- Entry types are schema (what can be created)
- Cardinality is a constraint (how many instances allowed)
- No conflation of these three concepts

The key insight: treating the content root as a normal collection eliminates the need to special-case root-level items. Every collection except the root has a parent, and the root is just the one collection with `parentPath: undefined`.

### Why schema meta files instead of all-in-config?

The schema meta file system provides an alternative to defining all schemas in `canopycms.config.ts`, offering several architectural benefits:

**Co-location with content:**
- Collection structure lives alongside content files, not in a separate config file
- Easier to understand content organization when browsing the content directory
- Adding a new collection is as simple as creating a folder with a `.collection.json`
- Git diffs show collection structure changes in the same commits as content changes

**Separation of concerns:**
- Content structure (which collections exist, where they live) is separate from field definitions (what fields those collections have)
- Content editors can understand collection hierarchy without reading TypeScript
- Developers own the schema registry (TypeScript field definitions)
- Content architects can modify collection structure and entry types without touching code

**Reduced config file size:**
- Config file can focus on operational settings (git, auth, branches)
- Large nested schema trees can make config files unwieldy
- Meta files distribute schema definition across the content directory

**Flexibility:**
- Projects can use all-in-config, all-in-meta, or a hybrid approach
- Config-defined schemas and file-based schemas are merged
- Gradual migration path: start with config, move to meta files as project grows
- Different teams can manage different parts of the schema

**Registry pattern enables reuse:**
- Field definitions (like `postSchema`) are defined once and referenced multiple times
- If multiple entry types share the same structure, they reference the same schema
- Changing a schema definition updates all entry types that reference it
- Type safety maintained because registry is TypeScript

**Limitations:**
- Requires async initialization (file I/O)
- Two sources of truth (config and meta files) can be confusing initially
- Schema registry must be maintained separately from meta files
- References are validated at runtime, not TypeScript compile time

**When to use meta files:**
- Large projects with many collections
- Content teams that need visibility into collection structure
- Projects where collection hierarchy changes frequently
- Multi-team environments where content structure ownership is distributed

**When to use config-only:**
- Small projects with 1-3 collections
- Solo developers who prefer everything in code
- Projects where TypeScript type checking is critical
- Rapid prototyping where schema changes frequently
