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

- **canopycms** (core): The main library containing content store, branch management, permissions, editor UI, API handlers, and AI content generation. This package is framework-agnostic and contains all business logic. It exposes multiple entrypoints: `canopycms/server` (content reading, API setup), `canopycms/client` (editor components), `canopycms/config` (configuration helpers), `canopycms/ai` (AI content route handler and generation), and `canopycms/build` (static file generation utilities).

- **canopycms-next**: Next.js adapter that provides thin integration (~10 lines of user extraction code). Wraps core context with React cache() for per-request memoization. Also provides a `withCanopy()` Next.js config wrapper that handles module transpilation and React deduplication (see [Framework Adapters](#framework-adapters) below).

- **canopycms-auth-clerk**: Authentication plugin using Clerk.

- **canopycms-auth-dev**: Development authentication plugin that provides a mock auth flow with configurable test users. Used for local development without requiring a real auth provider.

This separation keeps the core framework-agnostic while allowing adapters to be minimal integration layers. All business logic lives in core—adapters only handle framework-specific concerns like extracting user identity from request contexts.

The core package also exposes a `canopycms/test-utils` subpath export for shared test utilities (API test helpers, console spies, git test repo initialization). This replaces fragile cross-package relative imports and gives other packages in the monorepo a stable, versioned way to import test infrastructure.

## Dependency Model

### pnpm Workspace Isolation

The monorepo uses pnpm with workspaces defined in `pnpm-workspace.yaml`. pnpm's content-addressable store and strict dependency resolution provide workspace isolation by default: each package can only import dependencies it explicitly declares. There is no dependency hoisting to the root `node_modules`, so phantom dependency bugs (importing an undeclared package that happens to be hoisted by a sibling) are caught during development rather than after publishing.

**Why pnpm?** pnpm provides the same correctness guarantees that previously required npm's `install-strategy=nested`, but with better performance and lower disk usage (shared content-addressable store instead of duplicated `node_modules` trees). Inter-package references use the `workspace:` protocol (`workspace:^` for peer dependencies, `workspace:*` for dev dependencies), which pnpm resolves to real version ranges at publish time.

### Peer Dependencies for Plugins and Adapters

Auth plugins and framework adapters declare their upstream framework and UI dependencies as `peerDependencies`. This means the adopter's project provides the actual dependency instances, and the plugin links against those same instances at runtime.

For example, `canopycms-auth-clerk` declares `@clerk/nextjs` and `@clerk/backend` as peer dependencies. The adopter installs these in their project; the auth plugin uses whatever version the adopter provides (within the declared range). Similarly, `canopycms-auth-dev` declares `@mantine/core`, `@mantine/hooks`, and `react` as peers.

**For monorepo development**, the same dependencies are also listed as `devDependencies` (using `workspace:*` for internal packages, or standard version ranges for external packages) in each plugin's `package.json`. pnpm's strict resolution ensures each package resolves only its declared dependencies. When the package is published, only the `peerDependencies` declaration ships -- consumers provide the actual installations.

**Why peerDependencies?** Libraries like React and Mantine require a single instance in the bundle. If a plugin bundled its own copy of React, the adopter's app would have two React instances, causing hook crashes and context isolation bugs. Peer dependencies ensure the plugin and the adopter share the same instance.

### Standard Type Boundaries at Package Edges

The `canopycms-next` adapter uses standard Web API types (`Request` and `Response`) in its public handler signature rather than Next.js-specific types like `NextRequest`. This is a deliberate design choice that keeps package boundaries clean regardless of the package manager's dependency resolution strategy.

Even with pnpm's strict isolation, framework-specific types from different resolution contexts can cause cross-package type mismatches. Standard `Request` and `Response` types come from the global Web API type definitions, which are shared across all packages. By using these as the public contract, the adapter avoids cross-package type duplication entirely. Internally, the adapter can still use Next.js-specific APIs (like `NextResponse.json()`) for its own implementation.

**Design principle**: Package boundaries should use standard, globally-available types. Framework-specific types should be confined to the package's internal implementation.

### Root Package Hygiene

The root `package.json` contains only monorepo tooling dependencies (eslint, prettier, typescript, husky, playwright). All library dependencies live in the packages that actually use them. For example, `simple-git` and `@tabler/icons-react` are dependencies of the `canopycms` core package, not the root.

This ensures that each package's dependency declarations are accurate and complete, and that root-level tooling does not leak into package resolution.

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

**API** - API handlers, declarative guards, and route building:

- Route handlers for all API endpoints
- Declarative guard system for authorization, branch resolution, and schema loading
- Route builder with Zod validation and typed guard context
- API client for editor-to-server communication
- Settings helpers for mode-aware configuration storage

**Operating Mode** - Strategy pattern for deployment modes:

- Client-safe strategies (UI flags, simple configuration)
- Client-unsafe strategies (file system operations, git integration)
- Type definitions for strategy interfaces

**AI Content Generation** - Schema-driven content export for AI consumption:

- Entry-to-markdown conversion using schema field definitions
- Content tree walking with configurable exclusions and bundles
- Manifest generation for AI tool discovery
- Shared generation engine used by both the route handler and the build utility

**Build Utilities** - Static file generation for build-time content export:

- Static AI content writer (writes generated markdown and manifest to disk)
- Used by the CLI and during static site builds

**Validation** - Content validation utilities:

- Reference validator for checking content references
- Deletion checker for referential integrity
- Field traversal utilities for schema-aware content inspection

**Utilities** - Shared utilities:

- Type-safe error handling patterns
- Debug logging utilities
- Formatting helpers
- URL sanitization for safe rendering of CMS-sourced links

### Top-Level Files

Some files remain at the source root because they represent core domain concepts that span multiple modules:

**Branch Management:**

- Branch metadata (per-branch state storage)
- Branch registry (branch listing cache)
- Branch workspace (workspace provisioning)
- Settings branch utilities (mode-aware settings storage)

**Content:**

- Content ID index (bidirectional ID-to-path mapping)
- Content listing (shared entry-listing utilities: filename parsing, entry data reading, ordering, flat entry listing)
- Content reader (authenticated content access)
- Content store (file-based content persistence)
- Content tree (build-time content tree builder for adopter navigation, sitemaps, etc.)
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
- Build mode and deployment type detection (static vs server)

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
  registry?: BranchRegistry               // Branch cache (always present in prod and dev modes)
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
  entrySchemaRegistry,
})
```

This function:

1. Detects the effective base branch (from config or git HEAD) and bakes it into the config so all downstream code uses a single consistent value
2. Validates and flattens the schema
3. Creates authorization checkers
4. Initializes the branch registry (prod and dev modes)
5. Sets up GitHub integration (if configured)
6. Returns an immutable service container

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
  entrySchemaRegistry,
})

export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler // Handler has services injected
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
- **Branch metadata**: `.canopy-meta/branch.json` per workspace (state, PR references, sync status, conflict tracking, automatically excluded via git info/exclude)
- **Branch registry**: `branches.json` at branches root (inventory of all branches, gitignored)
- **Comments**: `.canopy-meta/comments.json` per branch (NOT committed to git, automatically excluded)
- **Settings (prod)**: `groups.json` and `permissions.json` on orphan branch `canopycms-settings-{deploymentName}` (version-controlled, deployment-specific), workspace at `{workspaceRoot}/settings/`
- **Settings (dev)**: Same orphan branch mechanism as prod (`canopycms-settings-{deploymentName}`), workspace at `.canopy-dev/settings/` (gitignored, local development only)

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

## Case Sensitivity

Content directories and filenames may have mixed casing (e.g., `content/docs/API-Reference/`), but URL-facing paths are lowercased. Here is where case sensitivity matters and where it does not:

**Case-insensitive (safe with mixed-case content on disk):**

- **Collection path resolution** (`resolveCollectionPath` in `content-id-index.ts`): Reads actual directory entries from disk and matches via `extractSlugFromFilename()`, which lowercases. A request for `content/docs/api-reference` resolves correctly even if the directory is `API-Reference.bChqT78gcaLd`.
- **Entry slug matching** (`content-store.ts`): Slugs are lowercased before comparison, so a query for slug `getting-started` finds a file named `doc.Getting-Started.a1b2c3d4e5f6.md`.
- **Content tree paths** (`content-tree.ts`): The default `buildPath` lowercases all URL paths, so `content/docs/API-Reference` produces `/docs/api-reference`.
- **`readByUrlPath`** (`context.ts`): Because it calls `read()` which flows through the case-insensitive store lookups above, lowercased URL paths resolve to mixed-case filesystem paths.

**Case-sensitive (filesystem-dependent):**

- **Direct `fs.readFile` / `fs.readdir` calls**: If code constructs a path string without going through `resolveCollectionPath`, the lookup is case-sensitive on Linux/EFS. This only affects the fallback path in `buildPaths` when a collection directory does not yet exist on disk.
- **macOS vs Linux**: macOS filesystems are case-insensitive by default; Linux and EFS are case-sensitive. Always test path resolution on a case-sensitive filesystem if your content has mixed casing.

**Rule of thumb**: Content paths are case-insensitive for reads (thanks to directory scanning), but always use lowercase for new content directories to avoid platform-dependent behavior.

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

**Field flags**: Individual fields within an entry type can carry behavioral flags:

- **isTitle**: Marks a field as the human-readable title for entries of this type. The editor UI, content listings, and tree builders use this to display meaningful labels instead of raw slugs. Only one field per entry type may be marked `isTitle`. The field must be a scalar (string-like) value that can be resolved at runtime, so `isTitle` is rejected on fields nested inside `list: true` object fields where the system cannot determine which array element to use.

**Reserved field names**: For md/mdx entry types, the field name "body" is reserved. The system uses `body` to carry the markdown content itself (everything below the frontmatter). Schema validation rejects md/mdx entry types that define a frontmatter field named "body" to prevent collisions with the content body. JSON entry types have no such restriction since they have no separate body concept.

**Key design principle**: Entry types are schema metadata, not navigable tree nodes. A collection with `entries: [{ name: 'post', ... }]` defines that entries of type "post" can be created in that collection. The entry type itself doesn't appear in navigation—only the collection does.

### Schema Registry and References

The schema registry is a centralized location for field definitions that can be referenced by collection meta files:

**Schema Definitions** (`app/schemas.ts`):

```typescript
import { createEntrySchemaRegistry } from 'canopycms/server'

export const postSchema = [
  /* field definitions */
]
export const authorSchema = [
  /* field definitions */
]
export const docSchema = [
  /* field definitions */
]

export const entrySchemaRegistry = createEntrySchemaRegistry({
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
      "schema": "postSchema",
      "default": true
    }
  ]
}
```

The `schema` property contains a string reference (like `"postSchema"`) that is resolved against the registry during initialization. Collections can define multiple entry types, each with different schemas.

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
- Extracts each collection's ContentId from its directory name (e.g., `posts.916jXZabYCxu` yields ContentId `916jXZabYCxu`)
- Returns raw metadata with string references to schema registry, plus the extracted ContentId per collection

**Step 2: Resolve references** (`resolveCollectionReferences`)

- Takes loaded meta files and schema registry
- Replaces string references (like `"postSchema"`) with actual field definitions
- Validates that all referenced schemas exist in the registry
- Builds nested collection hierarchy
- Threads each collection's ContentId into the resolved `CollectionConfig`

**Step 3: Merge with config**

- Config-defined schemas are merged with file-based schemas
- Collections are concatenated
- Config entries take precedence if root defines entries in both places

**Step 4: Flatten schema**

- Final merged schema is flattened into `Map<path, FlatSchemaItem>` for O(1) lookups
- Each flattened collection item carries its ContentId (used for conflict tracking and ordering)
- The root collection receives a sentinel `ROOT_COLLECTION_ID` since the content root directory has no embedded ID
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
const services = await createCanopyServices(config, entrySchemaRegistry)
```

**Context creation** in framework adapters:

```typescript
// Create once at module load
const canopyContextPromise = createNextCanopyContext({
  config,
  authPlugin,
  entrySchemaRegistry,
})

// Request-scoped: uses headers() + React cache()
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

// Build-scoped: no request context needed
export const getCanopyForBuild = async () => {
  const context = await canopyContextPromise
  return context.getCanopyForBuild()
}
```

**Why this pattern:**

- **One-time cost**: File scanning happens once at server startup, not per request
- **Shared services**: All requests use the same services instance with cached schemas
- **Lambda-safe**: In serverless environments, the promise resolves once per container lifecycle
- **Type safety**: Async await ensures services are fully initialized before use
- **Explicit scope**: `getCanopy()` for request-scoped contexts, `getCanopyForBuild()` for build-time contexts like `generateStaticParams`

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
- `contentId`: The collection's stable identifier, extracted from its directory name (or `ROOT_COLLECTION_ID` sentinel for the content root)
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

**Structured error codes**:

The content store uses typed error codes (`NOT_FOUND`, `NO_SCHEMA_ITEM`, `FORBIDDEN`, `VALIDATION`) on its domain error class rather than encoding failure reasons in message strings. This lets callers branch on `err.code` with exhaustive checks instead of fragile regex matching against error messages. For example, the URL-to-content resolution layer needs to distinguish "this path doesn't exist in the schema" from "the entry file is missing on disk" so it can probe multiple candidate paths without treating a missing file as a fatal error. Structured codes make that distinction reliable and refactor-safe.

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

### Declarative Guard System

API endpoints use a declarative guard system to handle common preconditions -- branch resolution, access control, schema loading, and role checks -- before the handler runs. Guards are declared as an array on the endpoint definition and execute in order, short-circuiting with an error response if any guard fails.

**How it works**: Each endpoint declares which guards it needs. The guard runner executes them sequentially, accumulating a typed guard context. If all guards pass, the handler receives this context as its first argument with full type safety -- for example, a handler guarded by `branchAccessWithSchema` receives a context where the branch context and flattened schema are guaranteed to be present and non-null.

**Available guards**:

- `branch`: Resolves the branch from request parameters (404 if not found)
- `branchAccess`: Resolves branch and checks user access permissions (404/403)
- `schema`: Resolves branch and loads the flattened schema (404/500)
- `branchAccessWithSchema`: Combines access check and schema loading (404/403/500)
- `admin`: Requires the user to be in the admin group (403)
- `reviewer`: Requires reviewer-level access (403)
- `privileged`: Requires admin or reviewer access (403)

**Design rationale**: The previous approach used imperative middleware calls (`guardBranchAccess`, `guardBranchExists`) that each handler invoked manually. This led to duplicated boilerplate -- every branch-aware handler had the same guard call, null check, and error return pattern. The declarative approach eliminates this duplication and makes each endpoint's preconditions visible at a glance in its definition. The guard system also provides stronger type guarantees: handlers with schema guards receive a context type where `flatSchema` is non-nullable, eliminating defensive null checks inside handler logic.

**Scope boundary**: Guards run inside `defineEndpoint` at handler invocation time. They do not affect HTTP dispatch, URL routing, or client code generation. The generated API client remains unchanged -- guards are purely a server-side concern.

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

The key insight is that editors never interact with git or GitHub directly. CanopyCMS abstracts away the git operations, PR creation, and branch management. When an editor hits "Publish Branch", they are _requesting to publish_—the actual merge and deployment happen separately (typically through GitHub and CI/CD).

## Branch-Based Editing

When a user opens a branch, CanopyCMS either opens an existing workspace or creates a new one:

1. **Workspace resolution**: If a clone already exists for the branch, it's used. Otherwise, a new git clone is created (in production modes).
2. **Isolation**: Each branch has its own working directory with independent files
3. **Parallel editing**: Multiple users can work on different branches simultaneously without interference

Branches have a lifecycle with several states:

- **editing**: Active work in progress
- **submitted**: Sent for review, awaiting merge
- **approved**: Approved and ready to merge
- **locked**: Temporarily locked from editing
- **archived**: Merged and preserved for audit

Users can work on main branch too—there's nothing preventing it. The branch model provides isolation for team collaboration but doesn't mandate it.

## Operating Modes

CanopyCMS supports two operating modes to fit different environments. The mode is configured in `canopycms.config.ts` and defaults to `'dev'` if not specified. After Zod validation, `config.mode` is always defined and can be used throughout the codebase without fallback checks.

### dev

Full-featured local development with branching and git operations — a local simulation of production behavior. Creates per-branch workspaces in `.canopy-dev/content-branches/` and maintains a local bare git remote at `.canopy-dev/remote.git`. This mode mirrors prod behavior: branch creation, workspace cloning, the settings branch, and the worker CLI all work the same way locally as they do in production.

`defaultBaseBranch` is auto-detected from the current git HEAD if not explicitly set in the config; the detected value is baked into the config object at service creation time so that all downstream code uses the same value without re-detecting (avoids races if HEAD changes mid-request). Settings (groups and permissions) use the same orphan branch mechanism as prod (`canopycms-settings-{deploymentName}`, default: `canopycms-settings-local`), with the workspace at `.canopy-dev/settings/`. Commits go to the local bare remote but no PR is created, keeping the workflow lightweight during development. The AI content cache is invalidated on every request in dev mode so content edits are reflected immediately.

Use `npx canopycms worker run-once` to process queued tasks, refresh the auth cache, and simulate the EC2 worker locally. Use `npx canopycms sync` to synchronize content between the developer's working tree and the CMS editor's branch workspaces (see [Content Sync CLI](#content-sync-cli) below).

### prod

Full production deployment. Branch workspaces live on persistent storage (e.g., EFS on AWS). Integrates with GitHub for PR creation and management. Designed for team collaboration with proper review workflows.

Settings (groups and permissions) are stored on a separate orphan branch whose name is computed by the operating mode strategy as `canopycms-settings-{deploymentName}` (default: `canopycms-settings-prod`). Changes create PRs for review before merging to main, ensuring permission changes go through the same review process as content changes.

Settings PR creation follows the same dual-path as content branches: when `githubService` is available the PR is created directly; when it is not (e.g., Lambda with no internet), a `push-and-create-or-update-pr` task is queued for the EC2 worker. Because the same settings branch is updated repeatedly, this task checks for an existing open PR before creating a new one.

**Security**: In both prod and dev modes, the system will throw an error if the settings branch cannot be loaded, ensuring permissions are never accidentally read from a content branch. Settings files also include a `contentVersion` field for optimistic locking to prevent concurrent admin updates from overwriting each other.

### Mode Strategy Pattern

Operating modes are implemented using the Strategy pattern, which encapsulates mode-specific behavior into strategy objects. Each mode has two strategy implementations:

- **ClientSafeStrategy**: Contains UI feature flags and simple configuration (no Node.js APIs). Safe for 'use client' components.
- **ClientUnsafeStrategy**: Extends ClientSafeStrategy with server-side functionality (file system operations, git integration).

**Key design principle**: Strategies return configuration values and flags, not business logic. Complex operations (like git commands) are handled by domain-specific managers (GitManager, BranchWorkspaceManager) that use strategy flags to make decisions.

**Workspace root as the single source of truth**: `ClientUnsafeStrategy` requires a `getWorkspaceRoot()` method that returns the mode-specific top-level directory for all CMS state:

- `prod`: `CANOPYCMS_WORKSPACE_ROOT` env var, falling back to `/mnt/efs/workspace`
- `dev`: `{cwd}/.canopy-dev`

All other path methods on `ClientUnsafeStrategy` (`getContentBranchesRoot`, `getSettingsRoot`, etc.) are derived from `getWorkspaceRoot()` internally. This consolidates the single-root principle: there is exactly one place per mode that determines where on disk the CMS writes its state, and all subdirectories fan out from there. The auth metadata cache (`.cache/`) also lives under the workspace root, making the path available automatically without adopter configuration.

## Deployment Architecture

CanopyCMS is designed to work in multiple deployment scenarios, from a single server to a split Lambda + worker architecture optimized for cost and security.

### Single Server (Simplest)

The simplest deployment runs CanopyCMS on a single server (EC2, Railway, etc.) with direct internet access:

- Auth plugin calls the provider API directly (e.g., Clerk)
- Git operations push/pull to GitHub directly
- GitHub PR operations happen synchronously in the request cycle
- No worker, no caching, no task queue needed

This is the default behavior when `githubService` is available and the auth plugin has internet access.

### Lambda + EFS + EC2 Worker (AWS, Cost-Optimized)

For low-cost AWS deployments, CanopyCMS supports splitting into two components that share an EFS filesystem:

**Lambda (no internet access):**

- Runs the CMS app (editor + preview + API)
- Authenticates via networkless JWT verification + file-based metadata cache
- Git operations use a local bare repo (`remote.git`) on EFS via `file://` URL
- PR operations are queued to a task directory on EFS
- Holds no sensitive secrets (only public keys and config)

**EC2 Worker (internet access):**

- Tiny daemon (t4g.nano spot instance, ~$1.50/month)
- Processes queued tasks: pushes branches to GitHub, creates/updates PRs
- Syncs `remote.git` with GitHub (fetches upstream changes)
- Pushes `canopycms-settings-*` branches to GitHub on each sync cycle (belt-and-suspenders for the task queue)
- Rebases active branch workspaces onto updated base branch (with conflict detection and resolution)
- Refreshes auth metadata cache (Clerk users/orgs, or dev test users)

This architecture eliminates NAT Gateway ($32/month) and keeps all secrets on the worker (not Lambda).

### Key Deployment Components

#### `remote.git` — Local Bare Repo

Both `prod` and `dev` modes use a local bare git repository as the "remote" for all branch workspace operations. Branch workspaces clone from and push to this bare repo using `file://` URLs.

- **dev**: Auto-created at `.canopy-dev/remote.git` from the local checkout
- **prod**: Created by the EC2 worker at `{workspaceRoot}/remote.git`, synced with GitHub

CanopyCMS auto-detects `remote.git` at the workspace root (via `autoDetectRemotePath` in the operating mode strategy). No explicit `CANOPYCMS_REMOTE_URL` env var needed if `remote.git` exists.

#### Auth Caching (CachingAuthPlugin)

`CachingAuthPlugin` wraps any auth plugin's JWT verification with file-based metadata lookups:

1. **Token verification**: A `TokenVerifier` function verifies the JWT locally (no API calls)
2. **Metadata lookup**: `FileBasedAuthCache` reads user/group data from JSON files on EFS

Each auth plugin package provides its own token verifier and cache writer:

- `canopycms-auth-clerk`: `createClerkJwtVerifier()` + `refreshClerkCache()`
- `canopycms-auth-dev`: `createDevTokenVerifier()` + `refreshDevCache()`

The cache is populated by the worker daemon (or `npx canopycms worker run-once` in dev mode). Lambda reads it on every request. Cache invalidation is mtime-based — when the worker writes new cache files, Lambda picks them up on the next request. In dev mode, `CachingAuthPlugin` accepts an optional lazy refresher callback that auto-populates the cache on first request if it does not yet exist, so developers do not need to run the worker manually before their first login.

**Transparent auto-wrapping via `verifyTokenOnly`**: Auth plugins can declare a `verifyTokenOnly?(context)` method on the `AuthPlugin` interface. This is a lightweight, networkless token verification path — it confirms the JWT signature and extracts a user ID without making any API calls or fetching metadata. When this optional method is present, `createNextCanopyContext` (the Next.js adapter) automatically wraps the plugin with `CachingAuthPlugin` + `FileBasedAuthCache` in `prod` and `dev` modes. Adopters do not need to wire up caching manually; the adapter detects the capability and enables caching transparently.

**Cache path derivation**: The auth cache directory is derived from the workspace root returned by the operating mode strategy: `{workspaceRoot}/.cache`. Adopters can override this with the `CANOPY_AUTH_CACHE_PATH` environment variable. Because the workspace root is already the authoritative base for all mode-specific state, no additional configuration is needed in the common case.

#### Task Queue (Async GitHub Operations)

When `githubService` is unavailable (Lambda has no internet), PR operations are queued to the filesystem:

```
.tasks/
  pending/      # Lambda writes task files here
  processing/   # Worker moves tasks here while executing
  completed/    # Successful tasks
  failed/       # Failed tasks (with error details)
```

The shared helper `github-sync.ts` provides `syncSubmitPr()` and `syncConvertToDraft()` which transparently use `githubService` directly when available, or fall back to the task queue when not. API handlers (submit, withdraw, request-changes) use these helpers without needing to know about the deployment topology.

**Task actions:**

- `push-branch` -- pushes a branch from `remote.git` to GitHub
- `push-and-create-pr` -- pushes then creates a new PR (content branches, first submit)
- `push-and-update-pr` -- pushes then updates an existing PR (content branches, re-submit)
- `push-and-create-or-update-pr` -- pushes then checks for an existing open PR before creating (used for settings PRs, which are updated repeatedly rather than creating one PR per branch)
- `convert-to-draft` -- converts a PR to draft status (withdraw)
- `close-pr` -- closes a PR
- `delete-remote-branch` -- removes a branch from GitHub

Branch metadata includes a `syncStatus` field (`synced`, `pending-sync`, `sync-failed`) so the editor UI can show sync progress. The settings branch commit operation (`commitToSettingsBranch`) returns the same `syncStatus` values, allowing the permissions and groups UI to surface sync state to admins.

#### Worker CLI

For local development in `dev` mode, the worker can be triggered manually:

```bash
npx canopycms worker run-once
```

This processes pending tasks, refreshes the auth cache, and exits. It simulates what the EC2 worker daemon does continuously in production.

#### Content Sync CLI

In dev mode, the developer's working tree and the CMS editor operate on separate git structures. The developer edits files in their normal repo, while the editor works through branch workspaces cloned from the local bare remote. These two worlds can drift apart: the developer might update content files directly, or an editor might publish changes through the CMS that the developer wants to pull back into their repo.

The `sync` command bridges this gap with bidirectional content synchronization between the developer's working tree and a specific branch workspace:

- **Push** (`npx canopycms sync --push`): Copies the developer's current working-tree content directly into the selected branch workspace and commits it there. This is useful after the developer makes direct content edits outside the CMS. Push does not update the local bare remote; `remote.git` stays current through the normal publish/submit mechanisms.

- **Pull** (`npx canopycms sync --pull`): Copies content from a branch workspace back into the developer's working tree. The developer can then review the changes with normal git tools and commit when ready. This closes the loop after content is edited through the CMS.

- **Both** (`npx canopycms sync`): Performs a proper 3-way git merge between working-tree changes and editor changes. It uses a `canopycms-sync-base` tag (set by each successful sync) as the merge base, creates a temporary branch from that base with the working-tree content, and merges it with the workspace branch. If conflicts arise, the workspace is left in a merge state for manual resolution. On a clean merge, the result is pulled back into the working tree automatically.

- **Abort** (`npx canopycms sync --abort`): Cancels a failed merge in a branch workspace by running `git merge --abort`, restoring it to the pre-merge state. This is the recovery path when a "both" sync encounters conflicts the developer does not want to resolve in the workspace.

**Safety guarantees:** Directory replacements during sync use a backup-rename pattern: the old directory is renamed to a timestamped backup, the new directory is renamed into place, and only then is the backup deleted. If the process is interrupted at any point, at least one complete copy of the content always exists on disk. Branch names provided via the `--branch` flag are validated against path traversal (the resolved path must stay within the branches directory), preventing a crafted branch name like `../../etc` from escaping the workspace root.

**Why a separate sync step?** The CMS editor intentionally does not write directly to the developer's repo. Branch workspaces act as a boundary between the developer's git state and the CMS's editing state. This isolation prevents the CMS from creating unexpected commits or modifying the developer's index. The sync command gives the developer explicit control over when content crosses that boundary.

**Why sync does not touch remote.git:** Earlier designs had push update the local bare remote and fan out fetches to all branch workspaces. This was removed because the sync command's purpose is narrow: move content between the developer's working tree and a single branch workspace. The bare remote is kept current by the existing publish and submit flows, and mixing those responsibilities in sync created confusing semantics (especially for the "both" direction).

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
- **buildContentTree()**: Build-time content tree builder (see [Content Tree Builder](#content-tree-builder) below)
- **listEntries()**: Flat content listing for static params, search indexes, sitemaps, etc. (see [Content Entry Listing](#content-entry-listing) below)
- **services**: Access to underlying services if needed
- **user**: Current authenticated user (with bootstrap admin groups applied)

The context automatically handles:

- User extraction via the provided `getUser` function
- Bootstrap admin group application (designated users get Admins group)
- Static deployment and build mode detection (returns STATIC_DEPLOY_USER with admin access when auth is unavailable)
- Permission checks during content reading

### Static Deployment and Build Mode

CanopyCMS supports two deployment types, declared via the `deployedAs` config field:

- **`'server'`** (default): A running server handles requests with full authentication and authorization. This is the standard CMS deployment.
- **`'static'`**: The site is a static export with no request context, no users, and no auth. All content is assumed publicly readable.

**The `deployedAs` field is the primary mechanism** for declaring deployment type. When `deployedAs` is `'static'`, the system uses a synthetic admin user (`STATIC_DEPLOY_USER`) and bypasses all permission checks—whether during `next build` or `next dev`. This covers the full lifecycle of a static site, not just the build phase.

**Build mode detection** (`isBuildMode()`) remains as a safety net for edge cases in server deployments. It detects when auth is unavailable during build by checking environment variables:

- `NEXT_PHASE=phase-production-build` (Next.js builds)
- `CANOPY_BUILD_MODE=true` (generic builds, other frameworks)

This covers situations like `getCanopy()` being called from `generateStaticParams` during a server deployment's build step, where there is no request context even though the deployment is not static.

**Combined check**: The content reader and context factory use `isDeployedStatic(config) || isBuildMode()` to determine when to bypass auth. The static deployment check is config-driven (stable, explicit); the build mode check is environment-driven (dynamic, safety net).

**Two-deployment model**: A single codebase can produce both a static export and a CMS server build. The `deployedAs` field in each build's config controls which deployment type is active. This enables patterns like a public-facing static site alongside a separate CMS editor deployment, both reading from the same content repository. At the build-tooling level, the `withCanopy()` Next.js config wrapper supports this via its `staticBuild` option, which controls whether CMS-only files (using the `.server.ts`/`.server.tsx` convention) are included in `pageExtensions`. See [Framework Adapters](#framework-adapters) for details.

This means you can use the same `read()` calls in both authenticated pages and static generation—the context handles the difference automatically.

### Framework Adapter Pattern

Framework adapters wrap the core context to provide framework-specific integration:

**Adapter responsibilities**:

- Extract user identity from framework-specific request context (Next.js headers, Express req, etc.)
- Apply framework-specific optimizations (React cache() for Next.js)
- Provide unified API for both pages and API routes

**What stays in core**:

- All business logic (permissions, content reading, branch management)
- Bootstrap admin group application
- Static deployment and build mode detection
- Content access control

**Auth plugin is optional for static deployments**: When `deployedAs` is `'static'`, the adapter does not require an auth plugin. If `deployedAs` is `'server'` (the default) and no auth plugin is provided, `createNextCanopyContext` throws at startup — before any traffic is served — to prevent silent misconfiguration. A `console.warn` is emitted at startup when `deployedAs` is `'static'` as a safeguard against accidentally setting this flag in a server build. The API handler receives a stub auth plugin that rejects all requests with 401, since a static deployment should never serve API requests to real users.

The Next.js adapter is ~10 lines of user extraction code. The pattern is designed so adapters for Express, Fastify, Hono, or other frameworks would be similarly minimal.

### Developer Experience

Setup is a one-time operation in a central file (e.g., `app/lib/canopy.ts`):

```typescript
// One-time setup
const { getCanopy, getCanopyForBuild, handler, services } = createNextCanopyContext({
  config: canopyConfig,
  authPlugin: clerkAuthPlugin,
})

export { getCanopy, getCanopyForBuild, handler, services }
```

Then in pages and API routes:

```typescript
// In a page/component (request-scoped)
const canopy = await getCanopy()
const { data } = await canopy.read({
  entryPath: 'content/posts',
  slug: params.slug,
})
```

No manual user management, no config imports, no auth logic. The context handles everything.

**Two context functions serve different scopes:**

- **`getCanopy()`** is request-scoped. It calls `headers()` to authenticate the current user and is wrapped with React `cache()` for per-request memoization. Use it in server components and route handlers.
- **`getCanopyForBuild()`** is process-scoped. It uses a synthetic admin user with no auth, making it safe to call from `generateStaticParams`, `generateMetadata`, and other non-request-scoped contexts where `headers()` is unavailable. It is memoized for the process lifetime. **Security note:** this context bypasses all branch and path ACLs — only use it in build-time code paths that are not exposed to end users at request time.

This dual-context pattern replaces the need for `isBuildMode()` environment detection in most cases. Instead of the framework guessing whether auth is available, adopters explicitly choose the right context for each call site.

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

- **Dev mode**: Settings on orphan branch `canopycms-settings-{deploymentName}`, workspace at `.canopy-dev/settings/` (gitignored, local development only)
- **Prod mode**: Settings on orphan branch `canopycms-settings-{deploymentName}`, workspace at `{workspaceRoot}/settings/` (version-controlled, deployment-specific)
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

### Workspace Safety

CanopyCMS creates many independent git clones (one per branch workspace, plus settings workspaces). Because these clones live as subdirectories of the adopter's project, there is a critical safety concern: if a workspace's `.git` directory becomes corrupt or is accidentally deleted, git will traverse upward and silently find the host repository's `.git` directory. This could lead to CanopyCMS overwriting the host repo's remote configuration or committing with its bot identity to the wrong repository.

Three defense-in-depth mechanisms prevent this:

- **Directory ceiling**: Every GitManager instance sets `GIT_CEILING_DIRECTORIES` to the parent of its workspace path. This tells git to stop traversing before it could reach a parent repository. If the workspace's `.git` is missing or corrupt, git fails with an error instead of silently operating on the host repo.

- **Managed workspace marker**: Before modifying sensitive git configuration (remotes, author identity), GitManager checks for a `canopycms.managed` config flag. This marker is set when CanopyCMS creates or clones a workspace. If the marker is absent, the operation throws an error. This catches cases where git somehow resolved to an unmanaged repository despite the ceiling guard.

- **Corrupt workspace recovery**: During workspace initialization, if a `.git` directory exists but is not a functional git repository, it is automatically cleaned up so a fresh clone can proceed. This prevents workspaces from getting stuck in a broken state after crashes or incomplete operations.

**Why defense-in-depth?** Any single mechanism could fail in edge cases (environment variable not propagated, race condition during initialization). The combination of filesystem-level traversal prevention, application-level identity verification, and self-healing initialization makes accidental host repo modification extremely unlikely.

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

- **dev**: Settings on orphan branch `canopycms-settings-{deploymentName}` (default: `canopycms-settings-local`), commits to local bare remote, no PR created
- **prod**: Settings on orphan branch `canopycms-settings-{deploymentName}` (default: `canopycms-settings-prod`), creates PR for review

Content operations always work on the current branch. Settings operations need to route to the appropriate settings branch based on mode.

**Two core helpers:**

**`getSettingsBranchContext()`**: Determines which branch to use for settings

- Returns appropriate branch context based on operating mode
- In both `prod` and `dev` modes: Uses the branch name computed by the operating mode strategy (`canopycms-settings-{deploymentName}`)
- Returns both the context and mode for downstream operations
- **Security**: Throws error if settings branch cannot be loaded (both prod and dev modes)

**`commitSettings()`**: Commits and pushes settings changes with mode-specific logic

- **dev**: Commits to the settings branch in the local bare remote but does not create a PR
- **prod**: Uses `commitToSettingsBranch()` with dual-path PR creation (direct via `githubService` or queued via task queue)
- `autoCreateSettingsPR`: Whether to create PR automatically in prod (default: true)

**Cross-process locking:**

The `SettingsWorkspaceManager` uses two layers of locking to safely initialize the settings git workspace across concurrent processes (e.g., multiple Lambda instances sharing EFS):

- **In-memory Promise lock**: Prevents redundant async calls within the same process (Lambda request lifecycle)
- **File-based lock**: Uses atomic file creation (`O_CREAT|O_EXCL` / `wx` flag) for cross-process synchronization. The lock file is placed as a sibling of the settings root directory. Stale locks older than 30 seconds are automatically cleaned up, handling cases where a process crashed during initialization.

This dual-layer approach is necessary because Lambda instances share an EFS filesystem but each instance has its own process memory. The file lock ensures only one instance initializes the workspace at a time, while the in-memory lock avoids redundant concurrent calls within a single instance.

**Code reduction impact:**

Before settings-helpers, both `permissions.ts` and `groups.ts` contained ~20 lines each of duplicate mode-checking logic. The helpers eliminate approximately 40 lines of duplicated code by extracting the common pattern.

Handler code before:

```
const mode = ctx.services.config.mode ?? 'dev'
const strategy = operatingStrategy(mode)
let branchName: string
if (strategy.usesSeparateSettingsBranch()) {
  branchName = strategy.getSettingsBranchName(config)
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

## Branch Synchronization and Conflict Detection

When the base branch (typically `main`) receives new commits from merged PRs, active editing branches can fall behind. The worker daemon periodically rebases these branches to incorporate upstream changes, and surfaces conflicts to editors through a non-blocking notification system.

### Rebase Behavior

The worker's synchronization cycle fetches the latest base branch from GitHub into the local bare repo, then iterates over all active branch workspaces and rebases them.

**Branches that are skipped:**

- **In review** (`submitted` or `approved` status): Rebasing would rewrite commit history under a PR that reviewers are actively looking at. These branches are left untouched until they return to `editing` status.
- **Archived**: Already merged branches have no reason to be rebased.
- **Dirty working tree**: If the branch has uncommitted changes (an editor is actively saving), rebasing would fail or destroy their work. The worker skips the branch and tries again on the next cycle.

**Clean rebases**: When no files conflict, the rebase applies cleanly. The branch gets the base branch's latest changes, and any previous conflict state is cleared.

### Conflict Resolution Strategy

When a rebase encounters conflicting files (the same file was changed on both the base branch and the editing branch), the worker uses a resolve-and-continue strategy rather than aborting:

- **Non-conflicting files** receive the base branch's latest changes normally
- **Conflicting files** keep the editor's version (the branch's content wins)

This is implemented using `git checkout --theirs` during the rebase. Git reverses its `ours`/`theirs` semantics during rebase operations: `--theirs` refers to the branch being replayed (the editor's work), while `--ours` refers to the rebase target (the base branch). The worker uses `--theirs` to preserve the editor's content.

After resolving all conflicts in a rebase step, the worker continues the rebase. If a resolution produces an empty commit (no effective changes), the worker skips that commit. A safety limit prevents infinite loops in pathological cases.

### Conflict Tracking

After a rebase with conflicts, the worker records which items conflicted in the branch's metadata. Conflicting items are tracked by their ContentId (the immutable 12-character Base58 identifier embedded in every content filename and directory name) rather than by file path. This is important because:

- ContentIds are stable across slug renames and file moves
- They provide a reliable identifier that survives future rebases
- Both entry files and collection metadata files are tracked

**How ContentIds are resolved for conflicting files:**

- **Entry files** (e.g., `post.hello.a1b2c3d4e5f6.mdx`): The ContentId is extracted directly from the filename
- **Collection metadata** (`.collection.json` in a subcollection like `posts.cNbR5xFm2Kpd/`): The ContentId is extracted from the parent directory name
- **Root collection metadata** (`content/.collection.json`): The root content directory has no embedded ID, so a sentinel value (`ROOT_COLLECTION_ID`) is used. This sentinel uses underscores, which can never collide with real Base58 IDs
- **Non-content files** (e.g., `README.md`): Files with no embedded ContentId in either their filename or parent directory are excluded from conflict tracking

The branch metadata stores:

- **conflictStatus**: Either `clean` (no conflicts) or `conflicts-detected`
- **conflictFiles**: Array of ContentIds for entries and collections where the editor's version was kept

This state is cleared automatically when a subsequent rebase completes without conflicts.

### Editor Conflict Notification

Conflicts are surfaced to editors at two levels in the UI:

- **Entry-level notices**: When an editor opens an entry that has a content conflict, the editor form displays a non-blocking informational notice at the top of the form. The notice tells the editor that someone else recently changed the same content and that a reviewer will reconcile the changes during the review process.
- **Collection-level badges**: When a collection's `.collection.json` conflicted during rebase, the sidebar navigation shows a conflict badge on that collection. This alerts editors that the collection structure (ordering, entry type configuration) may need review, even if individual entries within the collection are unaffected.

Both levels use the same `conflictFiles` array from branch metadata, matching each item's ContentId against the recorded conflict IDs.

**Design decisions behind this approach:**

- **Conflicts are non-blocking**: Editors can continue editing and submitting normally. The conflict is informational, not a gate. This prevents editors from being stuck on merge conflicts they don't understand.
- **Reviewer reconciliation**: The PR on GitHub will show the full diff, including the editor's version of conflicted files. Reviewers (who understand the content) can decide how to reconcile.
- **No editor-facing git concepts**: The notice uses plain language about "recent changes" rather than exposing git terminology like "rebase conflict."
- **Per-item granularity**: Notices appear only on the specific entries or collections that conflicted, not on the entire branch. This is possible because conflicts are tracked by ContentId.

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

- **Link to specific collections**: Constrain references to certain entry types (e.g., only allow linking to "posts")
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

**POST /:branch/validate-references/:path\***: Validate references in an entry

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

**Bundle separation**: Public sites can be built without any editor code. The editor is exported from `canopycms/client` and can be imported only where needed. This means your production site visitors never download editor JavaScript. At the file level, CMS-only routes (API handlers, editor pages) use the `.server.ts`/`.server.tsx` extension convention. The `withCanopy()` config wrapper controls whether Next.js processes these files, so static builds exclude them entirely rather than relying on tree-shaking alone.

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

## AI Content Generation

CanopyCMS can export its content as clean, AI-consumable markdown with a structured manifest. This enables AI tools, LLMs, and external indexing services to discover and ingest site content without parsing CMS-specific file formats or navigating the internal content ID system.

### Design Goals

- **Read-only, public access**: AI content is generated from the default branch (typically `main`) and requires no authentication. It represents the current published state of the site, not in-progress branch edits.
- **Schema-aware conversion**: The generator uses schema field definitions to produce structured markdown rather than dumping raw JSON. Field labels, descriptions, select option labels, nested objects, and block structures are all rendered meaningfully.
- **No internal identifiers exposed**: Embedded content IDs (the 12-character Base58 identifiers in filenames) are stripped from all output. AI consumers see clean paths and slugs only.
- **Opt-out exclusion model**: All content is included by default. Adopters configure exclusions (by collection, entry type, or custom predicate) rather than inclusions.

### Content Transformation

The generation engine walks the schema tree, reads each entry from the content store, and converts it to markdown:

- **MD/MDX entries**: Frontmatter fields are rendered as labeled metadata, and the markdown body is appended verbatim.
- **JSON entries**: All fields undergo schema-driven conversion. Each field type (string, boolean, image, code, select, reference, object, block) has a dedicated rendering strategy that produces idiomatic markdown.
- **Field descriptions**: The `description` field on schema configs (collections, entry types, blocks, and fields) is included in the markdown output, giving AI consumers semantic context about each field's purpose.
- **Field transforms**: Adopters can provide custom per-entry-type, per-field markdown override functions for cases where the default conversion is insufficient (e.g., rendering a complex data structure as a table).

### Output Structure

The generator produces three kinds of files:

- **Per-entry files** (e.g., `posts/hello-world.md`): One markdown file per content entry, with YAML-style frontmatter containing slug, collection, and type metadata.
- **Per-collection rollup files** (e.g., `posts/all.md`): A single markdown file concatenating all entries in a collection (including subcollections), separated by horizontal rules. Useful for feeding an entire collection to an LLM in one request.
- **Bundle files** (e.g., `bundles/research-data.md`): Named, filtered subsets of content defined by the adopter. Bundles can filter by collection, entry type, path glob, or custom predicate. Multiple filters are AND'd together. Bundles are additive views -- they do not remove content from per-entry or per-collection files.

A **manifest** (`manifest.json`) describes the full content tree: collections with their entries and subcollections, root-level entries, and bundles. Each manifest entry includes a file path, entry count, and optional metadata (title, description, label). AI tools can read the manifest to discover available content without crawling the file tree.

### Delivery Mechanisms

The same generation engine powers two delivery paths. Both read from the default branch and share the same configuration and output format.

**Route handler** (`canopycms/ai` entrypoint): A Next.js-native catch-all GET handler mounted at a separate route (e.g., `/ai/[...path]/route.ts`). It generates content lazily on first request and caches the result in memory. In dev mode, the cache is bypassed on every request so content changes are reflected immediately. In production, responses include a short `Cache-Control` header. The route handler returns standard `Response` objects directly -- it does not use the CanopyCMS `CanopyRequest`/`CanopyResponse` abstraction or the editor API's guard system, because it has no authentication or branch resolution requirements.

**Static build utility** (`canopycms/build` entrypoint): Writes all generated files to a directory on disk (e.g., `public/ai/`). Used during the build step (e.g., `pnpm build`) or via the `npx canopycms generate-ai-content` CLI command. This path is appropriate for pure static exports where no Next.js server is running at request time.

### Why a Separate Route Handler?

The AI content handler is mounted at its own catch-all route rather than going through the existing editor API route. This is a deliberate separation:

- **No authentication**: The editor API requires authentication for every request. AI content is public and read-only.
- **No branch context**: The editor API resolves a branch for every request. AI content always reads from the default branch.
- **Different caching model**: The editor API is stateless per-request. The AI handler uses a lazy singleton cache that persists across requests.
- **Framework-native responses**: The handler returns `Response` objects directly, which is the natural API for Next.js route handlers. Wrapping this in `CanopyRequest`/`CanopyResponse` would add abstraction with no benefit.

### Configuration

AI content generation is configured via a `defineAIContentConfig()` helper that provides type-checked configuration. The configuration is shared between the route handler and the build utility and includes:

- **Exclusions**: Collections to skip, entry types to skip globally, and a custom predicate for fine-grained filtering.
- **Bundles**: Named filtered views with collection, entry type, path glob, and predicate filters.
- **Field transforms**: Per-entry-type, per-field markdown override functions.

### Package Entrypoints

This feature introduces two new package entrypoints:

- **`canopycms/ai`**: Exports the route handler factory, the generation engine, config helpers, and all related types. This is a server-side entrypoint (uses Node.js APIs for content reading).
- **`canopycms/build`**: Exports the static file writer. This is a build-time entrypoint (uses `node:fs` to write files to disk).

These join the existing entrypoints (`canopycms/server`, `canopycms/client`, `canopycms/config`).

## Content Tree Builder

CanopyCMS provides a build-time content tree builder that walks the schema and filesystem to produce a structured tree of content nodes. This gives adopters a single call to get their entire content hierarchy without understanding internal filesystem conventions, content ID encoding, or schema resolution.

### Purpose

Adopters frequently need a structured view of their content for navigation menus, sitemaps, breadcrumbs, search indexes, and similar build-time concerns. Without the content tree builder, they would need to understand CanopyCMS's internal schema flattening, filename conventions (type.slug.id.ext), collection directory naming, and ordering semantics. The builder encapsulates all of this behind a single `buildContentTree()` call on the context object.

### How It Works

The builder takes the flattened schema (already computed at service initialization) and walks the filesystem to discover entries in each collection:

1. **Schema traversal**: Starting from the content root (or an optional `rootPath`), the builder groups collections by parent and traverses the hierarchy depth-first.
2. **Entry discovery**: For each collection, it reads the directory to find entry files, parses their filenames to extract type, slug, and content ID, and reads their data (frontmatter for md/mdx, parsed JSON for json).
3. **Interleaving**: Child collections and entries within a collection are interleaved according to the collection's `order` array. Items listed in the order array appear first in their specified order; remaining items are sorted alphabetically. Adopters can supply a custom `sort` comparator that fully replaces this default ordering.
4. **Node construction**: Each node in the tree carries structural facts from CanopyCMS (logical path, content ID, collection metadata, entry metadata) but leaves display concerns to the adopter.

### Adopter Customization

The builder supports several options that let adopters shape the tree to their needs:

- **extract**: A callback that receives each node's raw data and returns typed custom fields. This is how adopters pull specific frontmatter fields (like `title`, `description`, `publishDate`) into the tree without the builder needing to know about adopter-specific schemas.
- **filter**: A callback that excludes nodes (and their descendants) from the tree. Runs after `extract`, so adopter-extracted fields are available for filtering decisions.
- **sort**: A custom comparator that fully replaces the default child ordering (order array followed by alphabetical) at each level. Runs after `extract` and `filter`, so adopter-extracted fields are available for sorting decisions. This is useful when adopters need to sort by a frontmatter field like `publishDate` or `weight` rather than relying on the schema's order array.
- **buildPath**: A callback that controls URL path generation. The default strips the content root prefix and joins segments with `/`. Adopters can override this for custom URL structures.
- **maxDepth**: Limits traversal depth for performance or to build shallow navigation trees.

The generic `<T>` parameter flows through the entire tree, so adopters get full type safety on their extracted fields.

### Shared Content Listing Layer

The content tree builder, the flat entry listing, and the entries API endpoint all need to list entries in a collection directory. To avoid duplication, a shared content-listing module provides the common operations: filename parsing (extracting type, slug, and ID from the `type.slug.id.ext` pattern), entry data reading (frontmatter fields plus markdown body for md/mdx, or parsed JSON), and ordering by a collection's order array. This single source of truth ensures that entry-listing behavior is consistent across the API (editor UI), the tree builder (navigation/sitemaps), and the flat listing (static params/search indexes).

### Export Strategy

The `buildContentTree()` and `listEntries()` functions and their types are exported from `canopycms/server` for direct use. Types only (`ContentTreeNode`, `BuildContentTreeOptions`, `ListEntriesItem`, `ListEntriesOptions`) are also exported from the root `canopycms` entrypoint for use in adopter type definitions without importing server-side code.

The primary access path for adopters is through the context object: `canopy.buildContentTree(options)` and `canopy.listEntries(options)`. These handle branch resolution (reading from the default branch) and schema setup automatically, so adopters do not need to manage branch contexts or flattened schemas themselves.

### Design Rationale

**Why both a tree and a flat list?** Content in CanopyCMS is inherently hierarchical (collections contain entries and subcollections). The tree preserves this structure for navigation, breadcrumbs, and sitemap generation. However, many common use cases (static params generation, search indexing, RSS feeds) naturally work with flat arrays. Rather than forcing adopters to flatten the tree themselves, `listEntries()` provides a purpose-built flat listing that is simpler and more efficient for those use cases.

**Why separate from the AI content generator?** The AI content generator produces markdown files optimized for LLM consumption, with schema-aware field rendering and bundle rollups. The content tree builder returns structured data optimized for programmatic use (navigation, search indexes, routing). They serve different audiences and have different output formats, even though both walk the schema and filesystem.

**Why on the context object?** Placing `buildContentTree()` on `CanopyContext` means adopters use the same `canopy` object for both content reading and tree building. The context handles branch resolution and schema access internally, keeping the adopter API surface minimal.

## Content Entry Listing

CanopyCMS provides a flat entry listing function (`listEntries()`) that returns all content entries as a flat array. While `buildContentTree()` produces a hierarchical tree suited for navigation and breadcrumbs, `listEntries()` is optimized for use cases where a flat collection of entries is more natural: `generateStaticParams`, search indexing, sitemaps, RSS feeds, and similar build-time concerns.

### How It Works

The listing function walks the flattened schema to discover all collections, reads entries from each in parallel, and returns a flat array of entry items. Each item includes structural metadata (path segments, slug, logical path, content ID, collection path, entry type, format) plus the entry's data.

For md/mdx entries, the raw data includes both frontmatter fields and the markdown body content (as `data.body`). For JSON entries, it includes all parsed fields. This means adopters can access the full content of each entry without additional read calls.

### Adopter Customization

The listing supports the same customization pattern as the content tree builder:

- **extract**: Transform raw entry data into typed custom fields. Receives the full raw data (including body for md/mdx) and entry metadata.
- **filter**: Exclude entries from results. Runs after extract, so transformed fields are available for filtering.
- **rootPath**: Scope the listing to a specific collection subtree for efficiency (skips loading entries outside the scope).
- **sort**: Custom comparator for ordering results.

The generic `<T>` parameter flows through, giving adopters type safety on extracted fields.

### Relationship to Content Tree Builder

Both `listEntries()` and `buildContentTree()` share the same underlying content listing layer for entry discovery, filename parsing, and data reading. They differ in output shape: the tree builder produces a nested hierarchy preserving parent-child relationships, while `listEntries()` produces a flat array with path segments for adopters who need to reconstruct structure themselves or do not need hierarchy at all.

Both are available on the `CanopyContext` object, using the same `canopy` instance that handles branch resolution and schema access.

## Extensibility Points

### Authentication

Authentication is abstracted out and provided by separate packages. The core CanopyCMS package has no built-in auth provider—you must install an auth package.

Auth plugins implement the `AuthPlugin` interface, which provides:

- User identity extraction from requests
- Group membership lookup
- Session validation

The interface also has one optional method:

- **`verifyTokenOnly(context)`**: Lightweight, networkless JWT verification that returns just a user ID (no metadata). When implemented, framework adapters automatically enable file-based auth caching in prod and dev modes. This is the recommended path for Lambda deployments that have no internet access, and ensures dev mode mirrors prod behavior.

This abstraction means you can use Clerk, Auth0, NextAuth, Supabase Auth, or a custom solution. See `canopycms-auth-clerk` as a reference implementation. Creating a new auth plugin involves implementing the interface and publishing it as a package.

### Framework Adapters

Framework adapters provide thin integration between the framework and CanopyCMS core. They handle two main concerns:

1. **User extraction**: Extract user identity from framework-specific request context (Next.js headers, Express req, etc.)
2. **Request/response adaptation**: Convert framework request/response objects to core `CanopyRequest`/`CanopyResponse` types for API handlers

The `canopycms-next` adapter is ~10 lines for user extraction plus the request/response wrapper. All business logic stays in core—adapters are purely integration code.

**Standard type boundaries**: The adapter's public handler API accepts standard `Request` and returns standard `Response` rather than `NextRequest`/`NextResponse`. This avoids type duplication across package boundaries -- pnpm's strict isolation means each package resolves its own copy of framework libraries, and framework-specific types from different copies are incompatible. Standard Web API types are globally shared, so they work correctly across all packages. See [Dependency Model](#dependency-model) for details.

**Next.js Config Wrapper (`withCanopy`)**:

The `canopycms-next` package also provides a `withCanopy()` function that wraps the adopter's Next.js config to handle three build-tooling concerns:

- **Module transpilation**: CanopyCMS packages export raw TypeScript. `withCanopy()` auto-detects which Canopy packages are installed (via `require.resolve`) and adds only those to `transpilePackages`. The core `canopycms` package is always included; optional packages like `canopycms-next`, `canopycms-auth-clerk`, `canopycms-auth-dev`, and `canopycms-cdk` are included only if found in the consumer's `node_modules`. This avoids Next.js build errors from listing uninstalled packages.
- **React deduplication**: When consuming Canopy packages via `file:` references or linked packages during local development, the bundler can follow symlinks into the linked package's `node_modules` and resolve a second copy of React. Dual React instances cause "Invalid hook call" crashes. `withCanopy()` resolves React modules from the consumer's project root via scoped Webpack aliases (applied only to canopycms source files), ensuring a single React instance without interfering with Next.js internals.
- **Dual-build page extensions**: `withCanopy()` supports a `staticBuild` option that controls whether CMS-only files are included in the Next.js build. By convention, CMS-only routes (API handlers, editor pages) use `.server.ts` or `.server.tsx` file extensions. In dev and CMS builds (default), `withCanopy()` adds `server.ts` and `server.tsx` to Next.js `pageExtensions` so these files are processed normally. When `staticBuild: true` is set, these extensions are omitted, causing Next.js to ignore the CMS-only files entirely. This is the build-tooling mechanism that enables the two-deployment model described above -- a single codebase produces both a public static export (no editor code) and a CMS server build (with editor routes), controlled by a build-time flag rather than runtime checks.

When installed from npm (not symlinked), the React aliases are harmless -- they resolve to the same React the project already uses. Note that Turbopack does not currently support the absolute-path aliases used for React deduplication, so consumers using `file:` symlinks for local development must use `next dev --webpack`; Turbopack works fine when packages are installed from npm.

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

### Why do settings use a separate branch?

In both prod and dev modes, permission and group changes are stored on a dedicated orphan settings branch (named `canopycms-settings-{deploymentName}`) rather than on content branches. The branch name is deployment-specific so that multiple deployments sharing the same git repository can maintain independent settings. In dev mode, this branch lives in the local bare remote (`.canopy-dev/remote.git`) and is never pushed to GitHub. This design provides several benefits:

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

**Dev mode uses local files:**

- In `dev`, settings are stored in `.canopy-dev/` (not in git) for simplicity
- No separate branch management needed for local development
- Settings changes are immediate (no PR workflow needed)

The `settings-helpers` pattern abstracts this branching logic so API handlers don't need mode-specific conditionals.

### Why are rebase conflicts non-blocking for editors?

The alternative would be to block editing on conflicted entries until the conflict is resolved, but that would require editors to understand merge conflicts—a git concept that non-technical users shouldn't need to know. Instead, the system keeps the editor's version during rebase and surfaces a gentle notification. The PR diff on GitHub shows both versions, letting reviewers (who understand the content and context) reconcile during review. This keeps the editing experience simple while still surfacing that a conflict exists.

### Why track conflicts by ContentId instead of file path?

File paths can change when entries are renamed (slug changes). ContentIds are immutable identifiers embedded in every content filename and directory name that persist across renames and moves. Using ContentIds ensures that conflict tracking remains accurate even if the editor renames an entry or collection after a conflict is detected. For collection metadata files (`.collection.json`), the ContentId comes from the parent directory rather than the file itself. The root collection uses a sentinel value since the content root directory has no embedded ID.

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

### Why pnpm with strict workspace isolation?

The monorepo uses pnpm, which provides strict dependency isolation by default. Unlike npm's hoisted `node_modules`, pnpm's content-addressable store means each package can only import dependencies it explicitly declares. This catches phantom dependency bugs during development rather than after publishing.

The monorepo previously used npm with `install-strategy=nested` to achieve the same correctness guarantee, but pnpm provides this natively with better performance and lower disk usage (a shared store instead of duplicated `node_modules` trees). Inter-package references use the `workspace:` protocol, which pnpm resolves to real version ranges at publish time.

This strict isolation motivates two related design choices:

- **Peer dependencies for plugins**: Auth plugins and adapters use `peerDependencies` for their upstream framework and UI dependencies (React, Mantine, Clerk, etc.). This prevents duplicate instances of libraries that require singleton semantics. The same deps are listed as `devDependencies` (using `workspace:*` for internal packages) for local building and testing.

- **Standard types at package boundaries**: The Next.js adapter accepts `Request`/`Response` (standard Web API types) rather than `NextRequest`/`NextResponse`. Framework-specific types can cause cross-package type mismatches when packages resolve their own copies of framework libraries. Standard types are globally shared and avoid this entirely.

### Why standard Request/Response types at adapter boundaries?

When packages resolve their own copies of a framework library (which can happen with pnpm's isolated `node_modules` or any strict package manager), framework-specific types like `NextRequest` become different types across packages even though they are structurally identical. TypeScript's nominal type checking for class instances means the adopter's `NextRequest` and the adapter's `NextRequest` are incompatible at the type level.

Standard Web API types (`Request`, `Response`) are defined in the global TypeScript lib and shared across all packages. Using them at the adapter's public API boundary eliminates cross-package type mismatches entirely. Internally, the adapter still uses framework-specific APIs (like `NextResponse.json()`) for its own implementation.

This principle generalizes: any type that appears in a cross-package API should be either a standard global type or a type exported from a shared package, never a type from a framework-specific package that might be duplicated.

### Why git operations in the request cycle, with optional worker?

Local git operations (clone, commit, push to `remote.git`) happen synchronously during API requests — they're fast because they operate on local filesystems. This avoids the complexity of job queues for the common case.

The worker daemon handles **internet-requiring** operations that can't happen in the request cycle when the web server has no internet access (Lambda with no NAT):

- Pushing from `remote.git` to GitHub
- Creating/updating PRs via the GitHub API
- Fetching upstream changes from GitHub
- Refreshing auth provider metadata cache

On a single server with internet access, no worker is needed — `githubService` handles PR operations synchronously and the auth plugin calls the provider API directly. The worker architecture is additive, not required.

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

- **Consistency**: Bootstrap admin groups, static deployment detection, and permission checks work identically across all frameworks
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

### Why separate `deployedAs` from build mode detection?

The old approach used `isBuildMode()` and a `BUILD_USER` to detect and handle static generation. But the real question is not "are we building?" — it is "is this deployed as a static site?" A static deployment means no users, no request context, and no auth, whether during `next build` or `next dev`.

**The `deployedAs: 'static'` config field** makes this explicit. It is a stable, config-driven declaration that applies across the entire lifecycle of a static deployment. This is the primary mechanism for static sites.

**`isBuildMode()` remains as a safety net** for server deployments. During `next build` of a server-deployed site, functions like `generateStaticParams` run without a request context. The preferred solution is for adopters to use `getCanopyForBuild()` instead of `getCanopy()` in these contexts, which explicitly provides a non-request-scoped context with a synthetic admin user. Build mode detection remains as a fallback for cases where `getCanopy()` is called without a request context.

**Why two checks instead of one?**

- `deployedAs` is a static declaration: "this deployment never has users." It works in build and dev.
- `isBuildMode()` is a dynamic detection: "auth is unavailable right now, even though this is normally a server deployment." It only applies during build.
- Combining them (`isDeployedStatic(config) || isBuildMode()`) covers all cases where permissions should be bypassed.

**Why rename BUILD_USER to STATIC_DEPLOY_USER?**

The synthetic admin user is used in both static deployments and build phases. The name `STATIC_DEPLOY_USER` reflects the primary concept (static deployment) rather than the secondary use case (build phase). This makes the code's intent clearer.

**Why is authPlugin optional for static deployments?**

Static sites have no users and no request context. Requiring an auth plugin for a static deployment would force adopters to install and configure an auth package they will never use. Making it optional reduces adopter friction. The framework adapter provides a clear error if `authPlugin` is omitted but `deployedAs` is not `'static'`, preventing silent misconfiguration.

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

### Why a Next.js config wrapper for React deduplication?

CanopyCMS packages export raw TypeScript (no pre-compilation step). This means the Next.js bundler must transpile them, which requires adding each package to `transpilePackages`. Additionally, during local development the monorepo's `workspace:` references are resolved by pnpm as symlinks.

Symlinks create a subtle problem: when the bundler follows a symlink into the linked package's directory, it can resolve React from that package's `node_modules` instead of from the consumer's `node_modules`. Two React instances in the same bundle cause "Invalid hook call" crashes that are notoriously difficult to debug.

The `withCanopy()` wrapper in `canopycms-next` solves both problems in one call:

- Auto-detects installed Canopy packages (via `require.resolve`) and adds only those to `transpilePackages`, avoiding build errors from uninstalled optional packages
- Resolves React (and react-dom) from the consumer's project root via `createRequire()`, using scoped Webpack aliases that apply only to canopycms source files so they don't interfere with Next.js internals

**Why solve this in the adapter package?** The dual-React problem is specific to how Next.js resolves modules through symlinks. It is a build-tooling concern, not business logic. Placing it in the adapter keeps the core package clean and makes the fix discoverable for Next.js adopters in the package they already import. Other framework adapters would handle their bundler's equivalent quirks in their own way.

**Why not require pre-compilation?** Pre-compiling Canopy packages would eliminate the `transpilePackages` requirement but would add a build step to the development workflow, slow down iteration, and make debugging harder (source maps through compiled output). Exporting raw TypeScript keeps the development loop fast and debuggable.

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

### Why a URL sanitization utility in core?

CMS content is user-authored, so URLs entered in link fields, CTAs, and rich text blocks are untrusted input. A malicious or accidental `javascript:` or `data:` URL rendered into an `href` attribute creates a cross-site scripting vector, and an unchecked redirect URL can be used for phishing.

Rather than expecting every adopter to independently solve this, the core package provides a `sanitizeHref` utility that parses a URL with the standard `URL` constructor and only allows `http:` and `https:` protocols. The function returns a new string derived from the parsed URL object rather than the original input, which breaks static-analysis taint chains (CodeQL, Semgrep, etc.) and gives adopters a single, auditable point for URL safety.

**Why protocol allowlisting instead of denylisting?** Blocking known-bad schemes (`javascript:`, `vbscript:`, `data:`) is fragile because new schemes or parser quirks can bypass the list. Allowlisting only `http:` and `https:` is a closed set that cannot be bypassed by novel scheme names.

**Why in core rather than in a separate security package?** URL sanitization is needed wherever CMS content is rendered, which is the adopter's site. Shipping it in the core package means adopters get it as a zero-cost import with no extra dependency, and the utility evolves alongside the content model it protects.

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
- Clearer separation between structure (collections) and entry types

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
  entrySchemaRegistry,
})

// Request-scoped: uses headers() + React cache()
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

// Build-scoped: no request context needed (generateStaticParams, etc.)
export const getCanopyForBuild = async () => {
  const context = await canopyContextPromise
  return context.getCanopyForBuild()
}
```

**Benefits:**

- **One-time cost**: File scanning happens once per server/container lifecycle
- **Shared services**: All requests await the same promise, get the same services instance
- **Lambda optimization**: In serverless, the promise resolves once per container and is reused
- **Error handling**: Initialization errors are thrown once, not on every request
- **Type safety**: TypeScript enforces await at call sites
- **Explicit scope**: Adopters choose request-scoped or build-scoped context at each call site, avoiding implicit environment detection

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
- Entry types = schema definitions for entries
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
- Both are entry types; the only difference is how many instances are allowed

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

### Why is AI content served from a separate route, not the editor API?

The AI content handler uses a fundamentally different request model than the editor API:

**No authentication or branch resolution**: The editor API authenticates every request and resolves a branch context. AI content is public, read-only, and always reads from the default branch. Routing through the editor API would require either bypassing the authentication pipeline (fragile, special-cased) or adding a no-auth mode to the pipeline (risky, increases security surface).

**Different caching semantics**: The editor API is stateless per request -- each call resolves fresh branch state. The AI handler uses a lazy singleton cache that generates all content on first request and serves it from memory thereafter. These models are incompatible within a single handler.

**Framework-native responses**: The AI handler returns standard `Response` objects, which is the natural API for Next.js route handlers. The editor API uses `CanopyRequest`/`CanopyResponse` abstractions for framework portability. Since AI content delivery is simpler and does not need framework-agnostic abstraction, the `Response` API is the better fit.

**Minimal surface area**: The AI handler depends only on `ContentStore` and the schema -- it does not import the full service container, branch registry, authorization module, or any editor infrastructure. This keeps the dependency graph small and makes the feature easy to reason about in isolation.

### Why in-memory caching for the AI route handler?

The AI handler generates all content lazily on first request and caches the result as a singleton `Map<string, string>` in memory. In dev mode, the cache is invalidated on every request.

**Why not per-request generation?** Generating AI content walks the entire content tree, reads every entry, and converts each to markdown. This is too expensive to repeat on every request (potentially hundreds of milliseconds for large sites).

**Why not filesystem caching?** Filesystem caching would add complexity (cache directory management, invalidation logic, file I/O on every request). In-memory caching is simpler and faster. The AI content is regenerated on deploy (when the Lambda container restarts or the server process restarts), which matches the expected invalidation cadence for published content.

**Why no cache in dev mode?** Developers edit content and expect to see changes immediately. Always regenerating in dev mode ensures the AI output reflects the latest content without requiring a manual cache clear.

### Why two delivery mechanisms (route handler and static build)?

Different deployment models need different content delivery strategies:

**Route handler for server deployments**: When a Next.js server is running, the route handler serves AI content dynamically. This is simpler to set up (mount one route) and always reflects the latest published content.

**Static build for static exports**: Pure static sites (e.g., `next export`) have no server at request time. The build utility writes files to `public/ai/` during the build step, and the hosting platform serves them as static assets. The CLI command (`npx canopycms generate-ai-content`) can also be used in CI/CD pipelines or as a standalone generation step.

Both share the same generation engine and configuration, so the output is identical regardless of delivery mechanism. The separation is purely about how and when the content reaches consumers.

### Why schema-driven markdown conversion instead of raw JSON export?

The AI content generator uses schema field definitions to produce structured markdown rather than exposing the raw JSON data store:

**Meaningful structure**: Schema-aware conversion renders field labels, descriptions, select option labels, and nested object/block structures as readable markdown sections. Raw JSON would require consumers to understand the CMS data model.

**No internal identifiers**: The raw content store uses embedded IDs in filenames and stores reference fields as opaque ID strings. The markdown output strips these, producing clean paths and human-readable references.

**Field description propagation**: The `description` field on schema configs gives AI consumers semantic context about each field's purpose. This metadata exists in the schema but not in the raw content files.

**Custom transforms**: The field transform system lets adopters override the default conversion for specific fields (e.g., rendering a complex data structure as a markdown table). This extensibility point would not exist with a raw JSON export.
