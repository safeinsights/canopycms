# Developing CanopyCMS

This document contains development guidelines and patterns for contributors to CanopyCMS.

## Code Patterns from Major Refactoring (Phases 1-10)

The codebase underwent a major refactoring to establish consistent patterns. Contributors should follow these patterns.

### Error Handling

Use `catch (err: unknown)` with utilities from `src/utils/error.ts`:

```typescript
import { getErrorMessage, isNotFoundError, isNodeError } from './utils/error'

try {
  await riskyOperation()
} catch (err: unknown) {
  // Check for expected error conditions
  if (isNotFoundError(err)) {
    return null // File not found is expected
  }

  // Check for permission errors
  if (isNodeError(err) && err.code === 'EACCES') {
    throw new Error(`Permission denied: ${getErrorMessage(err)}`)
  }

  // Re-throw with context
  throw new Error(`Operation failed: ${getErrorMessage(err)}`)
}
```

**Available utilities:**

| Function                 | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `getErrorMessage(err)`   | Extract message string from unknown error          |
| `isNodeError(err)`       | Type guard for Node.js errors with `code` property |
| `isNotFoundError(err)`   | Check if error is ENOENT (file not found)          |
| `isPermissionError(err)` | Check if error is EACCES (permission denied)       |

**Why this pattern:** TypeScript's `unknown` type is safer than `any` for caught errors. These utilities provide type-safe access to error properties without casting.

### Path Handling with Branded Types

Use branded types from `src/paths/` for type-safe path handling:

```typescript
// Client code - import directly from normalize to avoid server-only modules
import { createLogicalPath, normalizeCollectionId } from './paths/normalize'

// Server code - can use the barrel export
import {
  createLogicalPath,
  createPhysicalPath,
  validateAndNormalizePath,
  resolveLogicalPath,
  type LogicalPath,
  type PhysicalPath,
  type CollectionPath,
} from './paths'
```

**Path types:**

| Type             | Purpose                                                     | Example                                                 |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `LogicalPath`    | User-facing, schema-defined paths without IDs               | `content/posts` or `content/docs/api`                   |
| `PhysicalPath`   | Actual filesystem paths with embedded content IDs           | `content/posts.abc123` or `content/docs.xyz/api.def456` |
| `CollectionPath` | Collection identifiers (deprecated in favor of LogicalPath) | `posts` or `blog/posts`                                 |

**Logical vs Physical Paths:**

CanopyCMS embeds unique IDs in directory names to ensure stable references even when content is moved or renamed:

- **Logical paths** are schema-defined and user-facing (e.g., `content/authors`)
- **Physical paths** include embedded IDs (e.g., `content/authors.q52DCVPuH4ga`)

This distinction is critical:

- **ContentStore APIs** expect `LogicalPath` parameters
- **ID index** stores `PhysicalPath` locations
- Use `resolveLogicalPath()` to convert between them

**Creating paths:**

```typescript
// Validates and creates a logical path (throws on traversal sequences)
const path = createLogicalPath('content', 'posts', 'my-post')
// Type: LogicalPath

// Creates a physical path (for files with embedded IDs)
const filePath = createPhysicalPath('content', 'posts', 'my-post.ABC123.mdx')
// Type: PhysicalPath

// Normalize collection ID (strips content root if present)
const collectionId = normalizeCollectionId('content/posts') // Returns 'posts'
```

**Resolving physical paths to logical paths:**

When working with the ID index (which stores physical paths), use `resolveLogicalPath()` to convert to logical paths before calling ContentStore methods:

```typescript
import { resolveLogicalPath } from './paths'

// ID index returns physical path with embedded IDs
const physicalPath = 'content/authors.q52DCVPuH4ga'

// Resolve to logical path for ContentStore
const logicalPath = resolveLogicalPath(physicalPath, schemaItems)
// Returns: 'content/authors'

// Now safe to use with ContentStore
const doc = await contentStore.read(logicalPath, slug)
```

**Algorithm details:**

The path matching algorithm handles:

- ✅ Nested collections with IDs at multiple levels
- ✅ Collections with similar name prefixes (e.g., `post` vs `posts`)
- ✅ Collections with dots in their logical names (e.g., `v1.0`)
- ✅ Exact matches without ID suffixes

Matching logic: For each segment pair, match if `physicalSeg === logicalSeg OR physicalSeg.startsWith(logicalSeg + '.')`. This ensures the dot separator is required, preventing false matches.

**Client/server boundary:** Client code must import from `./paths/normalize` directly because the barrel export (`./paths`) includes server-only modules that use Node.js `path`. This prevents bundler errors when code is used in the browser.

### Field Traversal

Use the shared utility for schema-aware data traversal:

```typescript
import { traverseFields, findFieldsByType } from './validation/field-traversal'

// Find all reference fields in nested data
const refs = findFieldsByType(schema.fields, data, 'reference')
// Returns: [{ field, value, path }, ...]

// Custom traversal with visitor pattern
const results = traverseFields(schema.fields, data, ({ field, value, path }) => {
  if (field.type === 'reference' && value) {
    return [{ fieldPath: path, ids: Array.isArray(value) ? value : [value] }]
  }
  return []
})
```

**Use cases:**

- Reference validation (checking all referenced IDs exist)
- Reference resolution (fetching referenced content)
- Data transformation (normalizing nested structures)

The traversal handles objects, blocks (with `_type` discriminator), and arrays automatically.

### Authorization

Use the unified authorization module at `src/authorization/`:

```typescript
import { checkContentAccess, isAdmin, isPrivileged } from './authorization'

// Check if user can perform an action on content
const result = await checkContentAccess(
  deps, // { loadPermissionsFile, loadGroupsFile }
  context, // { config }
  branchRoot, // Path to branch workspace
  'content/posts/post.mdx',
  user,
  'edit', // 'read' | 'edit'
)

if (result.allowed) {
  // Proceed with operation
} else {
  // result.reason explains why access was denied
}

// Quick admin check
if (isAdmin(user)) {
  // User is in Admins group
}

// Check if user can review/approve (admin or reviewer)
if (isPrivileged(user)) {
  // User can perform privileged operations
}
```

**Module structure:**

- `content.ts` - Combined branch + path access (recommended entry point)
- `branch.ts` - Branch-level access control
- `path.ts` - Path-level permissions
- `helpers.ts` - Utility functions (`isAdmin`, `isReviewer`, `isPrivileged`)
- `permissions/` - Permissions file schema and loader
- `groups/` - Groups file schema and loader

### State Management (Editor Components)

React Context provides dependency injection for editor components:

**API Client Context:**

```typescript
import { ApiClientProvider, useApiClient } from './context/ApiClientContext'

// In your test or app root
<ApiClientProvider client={mockClient}>
  <YourComponent />
</ApiClientProvider>

// In components
function MyComponent() {
  const client = useApiClient()
  // Use client for API calls
}
```

**Editor State Context:**

```typescript
import { EditorStateProvider, useEditorState, useEditorModals } from './context/EditorStateContext'

// Provides loading states, modal states, preview data
<EditorStateProvider>
  <Editor />
</EditorStateProvider>

// In components
function Toolbar() {
  const { openModal, closeModal, navigator } = useEditorModals()
  // ...
}
```

**Benefits:**

- Clean testing via providers (no global mutable state)
- Explicit dependencies
- Reduced prop drilling

### Module Organization

**Modules with subdirectories** (grouped for complexity):

| Directory        | Purpose                                    |
| ---------------- | ------------------------------------------ |
| `authorization/` | Access control (branch + path permissions) |
| `config/`        | Schema definitions and validation          |
| `paths/`         | Path handling and validation               |
| `schema/`        | Schema registry and resolution             |
| `editor/`        | React components and hooks                 |
| `api/`           | API handlers and client                    |

**Top-level files** (flat for discoverability):

| File                  | Purpose                     |
| --------------------- | --------------------------- |
| `content-store.ts`    | Content reading/writing     |
| `git-manager.ts`      | Git operations              |
| `branch-workspace.ts` | Branch workspace management |
| `comment-store.ts`    | Comment persistence         |
| `content-id-index.ts` | ID-to-path mapping          |

**Convention:** Group into directories when a module has multiple related files (types, helpers, tests). Keep top-level for single-file modules that are frequently imported.

## Architecture Patterns

### Framework-Agnostic Core

CanopyCMS follows a strict separation between framework-agnostic business logic and framework adapters:

**Core Packages (`canopycms`)**

- Contain all business logic, auth, content reading, services
- Accept callbacks/functions via dependency injection
- Never import framework-specific code (Next.js, Express, etc.)
- Export factory functions that return configured instances

**Adapter Packages (`canopycms-next`, etc.)**

- Thin wrappers around core functionality (prefer ~10 lines)
- Extract user/request data from framework-specific APIs
- Add framework-specific optimizations (caching, middleware, etc.)
- Provide unified API for adopters

**Example: User Extraction**

Core defines the interface:

```typescript
// packages/canopycms/src/context.ts
export interface CanopyContextOptions {
  config: CanopyConfig
  getUser: () => Promise<CanopyUser> // Injected by adapter
}
```

Adapter provides the implementation:

```typescript
// packages/canopycms-next/src/user-extraction.ts
export function createNextUserExtractor(authPlugin: AuthPlugin) {
  return async (): Promise<CanopyUser> => {
    const headersList = await headers() // Next.js-specific
    const mockRequest = {
      method: 'GET',
      url: headersList.get('referer') || 'http://localhost',
      header: (name: string) => headersList.get(name),
      json: async () => ({}),
    }
    const authResult = await authPlugin.verifyToken(mockRequest)
    return authResult.valid && authResult.user ? authResult.user : ANONYMOUS_USER
  }
}
```

### Context Factory Pattern

The core exports a `createCanopyContext()` factory that manages auth and content reading:

**Core Factory**

```typescript
// packages/canopycms/src/context.ts
export function createCanopyContext(options: CanopyContextOptions) {
  const services = createCanopyServices(options.config)

  const getContext = async (): Promise<CanopyContext> => {
    const user = await options.getUser() // Adapter-provided
    // Apply bootstrap admin groups, create content reader, etc.
    return { read, services, user }
  }

  return {
    getContext, // Call this per-request
    services, // Shared across requests
  }
}
```

**Framework Adapter**

```typescript
// packages/canopycms-next/src/context-wrapper.ts
export function createNextCanopyContext(options: NextCanopyOptions) {
  const coreContext = createCanopyContext({
    config: options.config,
    getUser: createNextUserExtractor(options.authPlugin),
  })

  // Add React cache() for per-request memoization
  const getCanopy = cache((): Promise<CanopyContext> => {
    return coreContext.getContext()
  })

  return {
    getCanopy,
    handler: createCanopyCatchAllHandler(options),
    services: coreContext.services,
  }
}
```

**Usage in Server Components**

```typescript
// app/posts/[slug]/page.tsx
const { getCanopy } = createNextCanopyContext({ config, authPlugin })

export default async function PostPage({ params }: { params: { slug: string } }) {
  const canopy = await getCanopy()
  const { data } = await canopy.read({ entryPath: 'content/posts', slug: params.slug })
  return <PostView data={data} />
}
```

### Static Deployment Detection

CanopyCMS has two deployment shapes: **server** (editor + API running at request time) and **static** (pre-built site with no request context and no auth). When running as a static deployment, auth checks are bypassed and all content is assumed publicly readable. Detection lives in `packages/canopycms/src/build-mode.ts`.

**Primary check: `isDeployedStatic(config)`**

The preferred way to detect a static deployment. Reads the `deployedAs` config field, which defaults to `'server'`:

```typescript
// packages/canopycms/src/build-mode.ts
export const isDeployedStatic = (config: { deployedAs?: string }): boolean => {
  return config.deployedAs === 'static'
}
```

The `deployedAs` field is set in the adopter's `canopycms.config.ts`, typically driven by an env var:

```typescript
// canopycms.config.ts (adopter code)
deployedAs: process.env.CANOPY_BUILD === 'true' ? 'static' : 'server',
```

**Safety net: `isBuildMode()`**

Covers edge cases like `getCanopy()` called from `generateStaticParams` in server deployments, where the config says `'server'` but there is no request context:

```typescript
// packages/canopycms/src/build-mode.ts
export const isBuildMode = (): boolean => {
  if (process.env.NEXT_PHASE === 'phase-production-build') return true
  if (process.env.CANOPY_BUILD_MODE === 'true') return true
  return false
}
```

**Combined check pattern**

Both `context.ts` and `content-reader.ts` use the combined check:

```typescript
// Anywhere auth/permissions might be skipped
if (isDeployedStatic(services.config) || isBuildMode()) {
  // Skip auth / use STATIC_DEPLOY_USER
}
```

`isDeployedStatic` is the primary, config-driven check. `isBuildMode` is the env-var safety net.

**`STATIC_DEPLOY_USER` constant**

Synthetic admin user used when auth is bypassed:

```typescript
// packages/canopycms/src/build-mode.ts
export const STATIC_DEPLOY_USER: AuthenticatedUser = Object.freeze({
  type: 'authenticated',
  userId: '__static_deploy__',
  groups: ['Admins'],
  email: 'static-deploy@canopycms',
  name: 'Static Deploy',
})
```

**`authPlugin` is optional for static deployments**

When `deployedAs` is `'static'`, the adopter does not need to provide an `authPlugin` to `createNextCanopyContext`. A stub plugin is used internally for the API handler:

```typescript
// canopy.ts (adopter code)
const isStaticDeploy = config.server.deployedAs === 'static'

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  ...(!isStaticDeploy ? { authPlugin: getAuthPlugin() } : {}),
  entrySchemaRegistry,
})
```

**Testing static deployment behavior**

The preferred approach: set `deployedAs: 'static'` in the test config. This avoids env var manipulation and cleanup:

```typescript
it('bypasses permissions for static deployments', async () => {
  const staticConfig = { ...config, deployedAs: 'static' as const }
  const context = createCanopyContext({
    services: await createCanopyServices(staticConfig, { entrySchemaRegistry }),
    extractUser: mockExtractUser, // Should NOT be called
  })
  const canopy = await context.getContext()
  expect(canopy.user).toEqual(STATIC_DEPLOY_USER)
})
```

You can also test via env var for the `isBuildMode()` safety net path, but always clean up:

```typescript
it('bypasses permissions during Next.js build phase', async () => {
  process.env.CANOPY_BUILD_MODE = 'true'
  try {
    const context = createCanopyContext({
      services,
      extractUser: mockExtractUser,
    })
    const canopy = await context.getContext()
    expect(canopy.user).toEqual(STATIC_DEPLOY_USER)
  } finally {
    delete process.env.CANOPY_BUILD_MODE
  }
})
```

### Branch Config: defaultBaseBranch vs defaultActiveBranch

CanopyCMS distinguishes between two branch config fields:

- **`defaultBaseBranch`** -- The fork point for new CMS branches. When the editor creates a branch, it forks from this branch (typically `main`). Used by `GitManager`, `BranchWorkspace`, and `GitHubService` for rebase targets and PR base branches.

- **`defaultActiveBranch`** -- Which workspace to serve content from by default. This is the branch the dev server, editor UI, content reader, and AI content resolver use when no branch is explicitly requested.

**Auto-detection in dev mode:**

`defaultActiveBranch` is auto-detected from the current git HEAD at service initialization (`detectDefaultActiveBranch()` in `services.ts`). This means if you are on branch `my-feature`, the CMS automatically serves content from that branch's workspace without any config change.

The detection priority is:

1. Explicit `defaultActiveBranch` in config (both modes)
2. Current git HEAD branch (dev mode only)
3. `defaultBaseBranch` from config
4. `'main'` as final fallback

**Where `defaultActiveBranch` is consumed:**

Content-serving code uses the pattern `config.defaultActiveBranch ?? config.defaultBaseBranch ?? 'main'`:

- `context.ts` -- determines the branch for `getContext()`
- `http/handler.ts` -- determines the branch for API requests without an explicit branch parameter
- `CanopyEditorPage.tsx` -- determines the initial branch for the editor UI
- `ai/resolve-branch.ts` -- determines the branch for AI content generation
- `content-reader.ts` -- determines the branch for `createContentReader()`

**Impact on sync CLI:**

The `canopycms sync` command defaults to the current git branch (via `detectCurrentBranch()`) and auto-creates workspaces on push with `selectBranch({ autoCreate: true })`. This means `sync --push` on a new branch will create a workspace automatically, matching the `defaultActiveBranch` auto-detection behavior.

**In tests:**

Most test configs set `defaultBaseBranch: 'main'` and do not set `defaultActiveBranch`. This is correct -- the auto-detection only runs in `createCanopyServices()`, so mock services skip it. If your test needs a specific active branch, set it explicitly:

```typescript
const services = createMockServices({
  config: { defaultBaseBranch: 'main', defaultActiveBranch: 'my-feature' },
  entrySchemaRegistry: {},
})
```

### Adding a New Framework Adapter

To add support for a new framework (Express, Fastify, SvelteKit, etc.):

1. **Create user extraction function**

   ```typescript
   // packages/canopycms-express/src/user-extraction.ts
   export function createExpressUserExtractor(authPlugin: AuthPlugin) {
     return async (req: Request): Promise<CanopyUser> => {
       const authResult = await authPlugin.verifyToken(req)
       return authResult.valid && authResult.user ? authResult.user : ANONYMOUS_USER
     }
   }
   ```

2. **Wrap core context factory**

   ```typescript
   // packages/canopycms-express/src/context-wrapper.ts
   export function createExpressCanopyContext(options: ExpressCanopyOptions) {
     const coreContext = createCanopyContext({
       config: options.config,
       getUser: createExpressUserExtractor(options.authPlugin),
     })

     // Add Express-specific middleware/caching if needed
     return {
       middleware: (req, res, next) => {
         /* ... */
       },
       getContext: coreContext.getContext,
       services: coreContext.services,
     }
   }
   ```

3. **Keep adapters thin** - 10-20 lines for user extraction is ideal
4. **Export unified API** - hide framework details from adopters
5. **Add framework-specific optimizations** - caching, middleware, etc.

## Operating Mode Strategies

CanopyCMS uses the Strategy pattern to encapsulate mode-specific behavior. Understanding this pattern is important for adding new features that behave differently across modes.

### Strategy Pattern Overview

**Two strategy layers:**

1. **ClientSafeStrategy** (`operating-mode/client-safe-strategy.ts`)
   - No Node.js imports (can be bundled for client)
   - Pure configuration values and flags
   - Methods: `supportsBranching()`, `shouldCommit()`, `getPermissionsFileName()`, etc.

2. **ClientUnsafeStrategy** (`operating-mode/client-unsafe-strategy.ts`)
   - Extends ClientSafeStrategy
   - Adds server-side functionality
   - Methods: `getBaseRoot()`, `getPermissionsFilePath()`, `getRemoteUrlConfig()`, etc.

**Key principle**: Strategies return values, not logic.

```typescript
// GOOD: Strategy returns a flag
shouldAutoInitLocal(): boolean {
  return true
}

// BAD: Strategy contains business logic
async resolveRemoteUrl(): Promise<string> {
  // Don't do git operations in strategies!
  const git = simpleGit(...)
  await git.raw([...])
  // ...
}
```

### When to Use Strategies

Add mode-specific behavior to strategies when:

- Different modes need different configuration values (file names, paths, flags)
- UI features should be enabled/disabled based on mode
- Simple boolean decisions drive behavior elsewhere

**Don't put in strategies:**

- Git operations (belongs in GitManager)
- File I/O operations (belongs in services/utilities)
- Complex business logic (belongs in domain code)

### Example: Adding Mode-Specific Behavior

```typescript
// 1. Add method to strategy interface (operating-mode/types.ts)
interface ClientSafeStrategy {
  // ... existing methods
  supportsFeatureX(): boolean
}

// 2. Implement in each strategy class
class ProdClientSafeStrategy implements ClientSafeStrategy {
  supportsFeatureX(): boolean {
    return true
  }
}

class LocalSimpleClientSafeStrategy implements ClientSafeStrategy {
  supportsFeatureX(): boolean {
    return false
  }
}

// 3. Use the flag in your code
const strategy = clientOperatingStrategy(config.mode)
if (strategy.supportsFeatureX()) {
  // Enable feature X
}
```

### Git Test Repositories

When testing code that involves git operations, use the `initTestRepo()` helper from `src/test-utils`:

```typescript
import { initTestRepo } from './test-utils'

it('should commit changes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-'))

  // Initialize a test repo with CanopyCMS marker
  const git = await initTestRepo(tmpDir)

  // Now safe to use with GitManager.ensureAuthor()
  const manager = new GitManager({ repoPath: tmpDir })
  await manager.ensureAuthor({ name: 'Bot', email: 'bot@test.com' })
})
```

**Why this matters:** `GitManager.ensureAuthor()` requires repositories to be marked as CanopyCMS-managed (via `git config canopycms.managed true`). This prevents accidental pollution of non-managed repositories. The `initTestRepo()` helper automatically adds this marker along with test user config.

### Testing Strategies

```typescript
import { operatingStrategy } from './operating-mode'

it('returns correct config for each mode', () => {
  const prodStrategy = operatingStrategy('prod')
  expect(prodStrategy.shouldAutoInitLocal()).toBe(false)

  const devStrategy = operatingStrategy('dev')
  expect(devStrategy.shouldAutoInitLocal()).toBe(true)
})
```

## Schema Architecture

CanopyCMS uses a unified schema model built on **collections** and **entry types**. There are no singletons as a separate concept -- a "singleton" is just an entry type with `maxItems: 1`.

### Schema Structure

The schema is a `RootCollectionConfig` with nested collections and entry types:

```typescript
const schema: RootCollectionConfig = {
  // Root-level entry types (e.g., a homepage with maxItems: 1)
  entries: [
    {
      name: 'home',
      format: 'json',
      fields: [{ name: 'hero', type: 'string' }],
      maxItems: 1,  // Only one instance allowed
    },
  ],
  // Top-level collections
  collections: [
    {
      name: 'posts',
      path: 'posts',
      label: 'Blog Posts',
      entries: [
        {
          name: 'post',
          format: 'md',
          default: true,  // Used by "Add" button
          fields: [
            { name: 'title', type: 'string' },
            { name: 'author', type: 'reference', collections: ['authors'] },
          ],
        },
      ],
      // Nested sub-collections
      collections: [
        {
          name: 'drafts',
          path: 'drafts',
          entries: [{ name: 'draft', format: 'md', fields: [...] }],
        },
      ],
    },
  ],
  order: ['agfzDt2RLpSn', '916jXZabYCxu'],  // Ordering by embedded content ID
}
```

**Key types** (from `packages/canopycms/src/config/types.ts`):

- `RootCollectionConfig` -- top-level schema container with `entries?`, `collections?`, `order?`
- `CollectionConfig` -- a named collection with `name`, `path`, `label?`, `entries?`, `collections?`, `order?`
- `EntryTypeConfig` -- defines content structure: `name`, `format`, `fields`, `label?`, `default?`, `maxItems?`

**On disk**, schema is stored in `.collection.json` files within each collection directory. Fields reference named schemas from a schema registry rather than inlining field definitions directly.

### Flattening Schema for Runtime

At runtime, the nested schema is flattened into a `FlatSchemaItem[]` for O(1) path lookups:

```typescript
import { flattenSchema } from './config'

const flatItems = flattenSchema(schema, 'content')
// Returns: FlatSchemaItem[]

const schemaIndex = new Map(flatItems.map((item) => [item.logicalPath, item]))

const item = schemaIndex.get('content/posts')
if (item?.type === 'collection') {
  console.log('Collection:', item.name, item.entries)
} else if (item?.type === 'entry-type') {
  console.log('Entry type:', item.name, item.format, item.maxItems)
}
```

**FlatSchemaItem** is a discriminated union with two variants:

```typescript
type FlatSchemaItem =
  | {
      type: 'collection'
      logicalPath: LogicalPath // e.g., "content/posts" (branded type)
      name: string // e.g., "posts"
      label?: string
      parentPath?: LogicalPath // Parent collection's logical path
      entries?: readonly EntryTypeConfig[]
      collections?: readonly CollectionConfig[]
      order?: readonly string[]
    }
  | {
      type: 'entry-type'
      logicalPath: LogicalPath // e.g., "content/home" (branded type)
      name: string // e.g., "home"
      label?: string
      parentPath: LogicalPath // Always present -- parent collection path
      format: ContentFormat // 'md' | 'mdx' | 'json'
      fields: readonly FieldConfig[]
      default?: boolean
      maxItems?: number // 1 = singleton behavior
    }
```

**Key points:**

- `type` discriminator is `'collection'` or `'entry-type'` (not `'singleton'`)
- `logicalPath` is a branded `LogicalPath` type (e.g., `content/posts`, `content/posts/drafts`)
- `parentPath` is always present on entry types; optional on collections (absent for root-level)
- Collections carry `entries` (the allowed entry types); entry types carry `format` and `fields` directly

### Working with ContentStore

The `ContentStore` uses the flattened schema index for all content operations.

**Path Resolution**

```typescript
// resolvePath returns { schemaItem, slug } -- no itemType field
const { schemaItem, slug } = store.resolvePath(['content', 'posts', 'hello'])
// schemaItem: FlatSchemaItem with type 'collection'
// slug: 'hello' (EntrySlug branded type)
```

Resolution works by treating the last path segment as a slug and looking up the remaining segments as a collection path. There is no separate singleton resolution -- entry-type items are accessed through their parent collection.

**Reading Content**

```typescript
// Collection entry: collection path + slug
const doc = await store.read('content/posts', 'hello-world')

// Entry-type item (e.g., maxItems: 1): collection path + empty slug
// Internally delegates to the parent collection with the entry type name as slug
const home = await store.read('content/home', '')
```

When reading, `ContentStore` checks the schema item type:

- `entry-type`: uses the entry type's `format` and `fields` directly
- `collection`: uses the default entry type's `format` and `fields` (via `getDefaultEntryType()`)

**Writing Content**

```typescript
// Collection entry
await store.write('content/posts', 'hello-world', {
  format: 'md',
  data: { title: 'Hello World' },
  body: 'Content goes here',
})

// Entry-type item (maxItems: 1)
await store.write('content/home', '', {
  format: 'json',
  data: { hero: 'Welcome' },
})
```

All entries on disk use the filename pattern `{type}.{slug}.{id}.{ext}` (e.g., `post.hello-world.a1b2c3d4e5f6.md`). The `type` prefix comes from the entry type name.

### API Response Format

**CollectionItem** -- represents an individual content entry:

```typescript
interface CollectionItem {
  logicalPath: LogicalPath
  contentId: ContentId // 12-char short UUID
  slug: EntrySlug
  collectionPath: LogicalPath
  collectionName: string
  format: ContentFormat
  entryType: string // Entry type name (e.g., 'post', 'home')
  physicalPath: PhysicalPath
  title?: string
  updatedAt?: string
  exists?: boolean
  canEdit?: boolean
}
```

**EntryCollectionSummary** -- represents a collection in the tree:

```typescript
interface EntryCollectionSummary {
  logicalPath: LogicalPath
  contentId: ContentId
  name: string
  label?: string
  format: ContentFormat // Default entry type's format
  type: 'collection' | 'entry' // CollectionKind
  schema: readonly FieldConfig[] // Default entry type's fields
  entryTypes?: EntryTypeSummary[] // All entry types in this collection
  order?: readonly string[]
  parentId?: string
  children?: EntryCollectionSummary[]
}
```

**Key points:**

- There is no `itemType` field. Use `entryType` on `CollectionItem` to identify the entry type name.
- `CollectionKind` (`'collection' | 'entry'`) on summaries indicates whether something is a container or a leaf -- not whether it is a "singleton."
- `maxItems: 1` entry types are just regular entries with a cardinality constraint. The UI enforces the limit; the API does not distinguish them from multi-instance entries.

### Testing with Schema

**Using defineCanopyTestConfig()**

```typescript
import { defineCanopyTestConfig } from './config-test'

const config = defineCanopyTestConfig({
  schema: {
    entries: [
      {
        name: 'home',
        format: 'json',
        fields: [{ name: 'hero', type: 'string' }],
        maxItems: 1,
      },
    ],
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: [
          {
            name: 'post',
            format: 'md',
            default: true,
            fields: [{ name: 'title', type: 'string' }],
          },
        ],
      },
    ],
  },
})
```

**Testing Schema Flattening**

```typescript
it('flattens collections and entry types', () => {
  const flat = flattenSchema(schema, 'content')

  const collections = flat.filter((item) => item.type === 'collection')
  const entryTypes = flat.filter((item) => item.type === 'entry-type')

  expect(collections.find((c) => c.name === 'posts')?.logicalPath).toBe('content/posts')
  expect(entryTypes.find((e) => e.name === 'home')?.maxItems).toBe(1)
})
```

**Testing Path Resolution**

```typescript
it('resolves collection entry paths', () => {
  const { schemaItem, slug } = store.resolvePath(['content', 'posts', 'hello'])
  expect(schemaItem.type).toBe('collection')
  expect(slug).toBe('hello')
})
```

## Working with Content IDs

### Using the ID Index

Content entries are identified by stable, content-addressed IDs (12-character short UUIDs). These IDs are embedded directly in filenames (e.g., `hello.a1b2c3d4e5f6.json`) and managed by the `ContentIdIndex`, which scans filenames to build an in-memory index.

When working with content IDs, use the async `idIndex()` getter to access the index:

```typescript
// Get the ID index - it loads lazily on first access
const idIndex = await store.idIndex()

// Find a location by ID
const location = idIndex.findById('abc123def456ghi789jkl')
if (location) {
  console.log(`Entry is at: ${location.relativePath}`)
}

// Find an ID by file path
const id = idIndex.findByPath('content/posts/hello-world.md')

// Add a new entry to the index (returns generated ID)
const newId = await idIndex.add({
  type: 'entry',
  relativePath: 'content/pages/about.json',
  collection: 'pages',
  slug: 'about',
})

// Remove an entry from the index
await idIndex.remove(newId)
```

**Why use the getter:** The `idIndex()` getter automatically handles lazy loading on first access. Calling it multiple times is safe - the index is loaded only once and subsequent calls return the already-loaded index. Never access `_idIndex` directly - always use the public getter.

**Pattern:**

```typescript
// Always await the getter
const idIndex = await store.idIndex()

// Not this:
// const idIndex = store._idIndex  // Wrong!
```

## Reference Field Configuration

Reference fields link entries together. Configure them with collection constraints and optional custom display fields:

**Field Schema:**

```typescript
const referenceFieldSchema = z.object({
  type: z.literal('reference'),
  name: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  list: z.boolean().optional(),
  collections: z.array(z.string().min(1)).min(1), // Which collections to reference
  displayField: z.string().min(1).optional(), // Field to show as label
  options: z.array(referenceOptionSchema).optional(), // For backward compatibility
})
```

**Example: Dynamic References with Collections**

```typescript
// Schema defining which collections can be referenced
const schema = [
  {
    type: 'collection',
    name: 'posts',
    fields: [
      {
        type: 'reference',
        name: 'author',
        label: 'Post Author',
        collections: ['authors'], // Can only reference authors collection
        displayField: 'name', // Show author's name field as label
      },
      {
        type: 'reference',
        name: 'relatedPosts',
        label: 'Related Posts',
        collections: ['posts'], // Self-reference for related content
        displayField: 'title', // Show post titles
        list: true, // Can reference multiple posts
      },
    ],
  },
  {
    type: 'collection',
    name: 'authors',
    fields: [{ type: 'string', name: 'name', label: 'Author Name' }],
  },
]
```

**Using Optional Properties:**

- `displayField`: Field name from the referenced entry to show as a label (e.g., `title`, `name`, `headline`)
- `options`: Static list of options for backward compatibility - if provided alongside `collections`, the UI can use it as a fallback

**Validation:** The `ReferenceValidator` ensures:

1. Referenced IDs are valid format
2. Referenced entries actually exist
3. Referenced entries are in allowed collections
4. Referenced entries are not collections themselves

### Implementing Live Reference Resolution in Editor

The editor's live preview needs to display full referenced content (not just IDs). This is implemented through a synchronous resolution system with background caching in `FormRenderer.tsx`.

**Core Implementation Pattern:**

```typescript
// 1. Cache for resolved references (persists across renders)
const resolvedCache = useRef<Map<string, any>>(new Map())
const [resolutionTrigger, setResolutionTrigger] = useState(0)

// 2. Synchronous resolution using useMemo (runs during render)
const resolvedValue = useMemo(() => {
  const result = { ...value }

  // For each reference field, apply cached data if available
  for (const fieldName of referenceFieldNames) {
    const fieldValue = value[fieldName]
    if (fieldValue && typeof fieldValue === 'string') {
      const cached = resolvedCache.current.get(`${branch}:${fieldValue}`)
      result[fieldName] = cached || fieldValue // Use cache or keep ID
    }
  }

  return result
}, [value, fields, branch, resolutionTrigger])

// 3. Background async resolution (updates cache)
useEffect(() => {
  // Find IDs not in cache
  const uncachedIds = findUncachedIds(value, referenceFieldNames, resolvedCache.current, branch)

  if (uncachedIds.length === 0) return

  // Debounce API calls
  const timeout = setTimeout(async () => {
    const resolved = await apiClient.content.resolveReferences({ branch }, { ids: uncachedIds })

    // Update cache
    for (const [id, data] of Object.entries(resolved.data.resolved)) {
      resolvedCache.current.set(`${branch}:${id}`, data)
    }

    // Trigger useMemo re-run
    setResolutionTrigger((prev) => prev + 1)
  }, 300)

  return () => clearTimeout(timeout)
}, [value, fields, branch])
```

**Key Implementation Details:**

1. **Cache Structure:** `Map<string, any>` with keys like `"main:5NVkkrB1MJUvnLqEDqDkRN"` (branch:id)
   - Scoped by branch to prevent stale cross-branch data
   - Cleared when branch changes
   - Persists across form edits for instant re-renders

2. **Synchronous Transform:** `useMemo` computes resolved value during render
   - Always returns complete, valid data (never empty objects)
   - Uses cache when available, otherwise keeps ID
   - No async gaps means no race conditions

3. **Background Resolution:** `useEffect` fills cache asynchronously
   - 300ms debounce prevents excessive API calls while typing
   - Only fetches IDs not already in cache (incremental)
   - Triggers useMemo re-run via `resolutionTrigger` state

4. **Parent Notification:** Pass resolved value to parent with infinite loop prevention
   ```typescript
   useEffect(() => {
     const serialized = JSON.stringify(resolvedValue)
     if (serialized !== lastNotifiedValueRef.current) {
       lastNotifiedValueRef.current = serialized
       onResolvedValueChange?.(resolvedValue)
     }
   }, [resolvedValue, onResolvedValueChange])
   ```

**Critical Gotcha: Never Pass Empty Objects**

The parent component must guard against rendering when data is undefined:

```typescript
// BAD: Will cause errors during transitions
<FormRenderer value={effectiveValue ?? {}} />

// GOOD: Only render when data exists
{effectiveValue && <FormRenderer value={effectiveValue} />}
```

**API Endpoint:**

The resolution endpoint (`POST /:branch/resolve-references`) accepts an array of IDs and returns full entry objects:

```typescript
// Request
{ ids: ["5NVkkrB1MJUvnLqEDqDkRN", "abc123"] }

// Response
{
  ok: true,
  data: {
    resolved: {
      "5NVkkrB1MJUvnLqEDqDkRN": { id: "...", name: "Alice", bio: "..." },
      "abc123": { id: "...", name: "Bob", bio: "..." }
    }
  }
}
```

**Testing:**

Test the resolution flow by:

1. Selecting a reference in the editor
2. Verifying preview shows loading state initially (ID rendered)
3. After 300ms, verify preview shows full data (name, bio, etc.)
4. Change selection and verify cache is used (instant update for previously-selected references)
5. Click "Discard All Drafts" and verify no errors (data remains complete)

See `FormRenderer.test.tsx` for examples.

## Testing Content IDs

When testing code that uses content IDs, create files with embedded IDs in their filenames:

```typescript
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ContentIdIndex } from './content-id-index'

describe('Content with IDs', () => {
  let tempDir: string
  let index: ContentIdIndex

  beforeEach(async () => {
    // Create isolated temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    await fs.mkdir(path.join(tempDir, 'content'), { recursive: true })
    index = new ContentIdIndex(tempDir)
  })

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('indexes entries with embedded IDs', async () => {
    // Create file with embedded ID in filename
    const testId = 'a1b2c3d4e5f6' // 12-character ID
    const filePath = path.join(tempDir, `content/test.${testId}.json`)
    await fs.writeFile(filePath, '{"title": "Test"}')

    // Build index by scanning filenames
    await index.buildFromFilenames('content')

    // Verify forward lookup (ID → path)
    const location = index.findById(testId)
    expect(location?.relativePath).toBe(`content/test.${testId}.json`)

    // Verify reverse lookup (path → ID)
    const foundId = index.findByPath(`content/test.${testId}.json`)
    expect(foundId).toBe(testId)
  })
})
```

**Key pattern:** IDs are embedded in filenames using the pattern `slug.id.ext` (e.g., `test.a1b2c3d4e5f6.json`). The `buildFromFilenames()` method scans filenames recursively to extract IDs and populate the in-memory index.

## Development Workflow

### Settings Management (Permissions and Groups)

CanopyCMS manages permissions and groups through JSON files. The storage location and behavior differs significantly between operating modes.

#### Local Development: `.canopy-dev/` Directory

In `dev` mode (the default for development), CanopyCMS uses the same orphan branch mechanism as prod for settings, with the workspace at `.canopy-dev/settings/`:

- **Settings storage:** `permissions.json` and `groups.json` on orphan branch `canopycms-settings-{deploymentName}`, cloned into `.canopy-dev/settings/`

- **Purpose:** These files allow you to test different permission scenarios and user roles without polluting the git history or conflicting with other developers.

- **Behavior:**
  - Changes persist across CMS restarts
  - Entire `.canopy-dev/` directory is **automatically gitignored** (via `.canopy*` pattern)
  - Settings are stored in the local bare remote only — never pushed to GitHub
  - Dev mode mirrors prod's settings architecture for consistent behavior

**Example workflow:**

```bash
# Start the CMS in dev mode (default)
pnpm dev

# 1. Login as different test users (e.g., auth-dev, Clerk dev accounts)
# 2. Add them to groups via the CMS UI
# 3. Test permission restrictions
# 4. Changes are committed to the local settings branch in .canopy-dev/
# 5. Files persist but won't show up in git status

# Verify files are gitignored
git status  # .canopy-dev/ should not appear
```

#### Understanding the Two Modes

| Mode     | Settings Files                                                      | Git Operations                            | Use Case                                          |
| -------- | ------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| **dev**  | Orphan branch `canopycms-settings-{deployment}` (gitignored clones) | Standard commits to settings branch       | Local development with full branching and git ops |
| **prod** | Orphan branch `canopycms-settings-{deployment}` (committed)         | Commits to settings branch + PR to GitHub | Production deployment                             |

**dev (Default for Development):**

- Full branch support: local bare remote at `.canopy-dev/remote.git`, branch workspaces at `.canopy-dev/content-branches/`
- Settings on separate orphan branch (deployment-specific)
- All of `.canopy-dev/` is gitignored
- `defaultActiveBranch` auto-detected from current git HEAD if not set in config (see [Branch Config: defaultBaseBranch vs defaultActiveBranch](#branch-config-defaultbasebranch-vs-defaultactivebranch))
- Tests branch creation, merging, permission inheritance locally

**prod (Production):**

- Settings tracked in git via orphan branch `canopycms-settings-{deploymentName}`
- Changes committed to settings branch, then pushed to GitHub with a PR (via `push-and-create-or-update-pr` task action)
- Settings are treated as deployment-specific configuration data
- Each deployment has its own settings branch
- Cross-process locking (file-based `wx` flag + in-memory Promise) protects concurrent workspace init on EFS

#### Production Settings Workflow

In production (`mode: 'prod'`), permission and group changes are stored on a separate **orphan branch** (no shared history with content branches):

1. **Settings Branch:** Changes are committed to an orphan branch named `canopycms-settings-{deploymentName}` (e.g., `canopycms-settings-prod`, `canopycms-settings-staging`)

2. **Commit + PR (dual-path):** `commitToSettingsBranch` in `services.ts` uses the same dual-path pattern as content branches (`api/github-sync.ts`):
   - **Direct path:** When `githubService` is available (has internet), calls `githubService.createOrUpdatePR()` synchronously
   - **Async path:** When no internet (prod Lambda), enqueues a `push-and-create-or-update-pr` task for the EC2 worker
   - Settings PRs are idempotent: the action checks for an existing open PR before creating a new one

3. **Immediate Effect:** Changes are active in the CMS immediately (read from the settings branch workspace). The PR is for persistence to GitHub, not for gating changes.

4. **Deployment-Specific:** Each deployment environment (prod, staging, dev) has its own independent settings branch

5. **Optimistic Locking:** Settings files include a `contentVersion` field that prevents concurrent admin updates from overwriting each other. If a version conflict is detected, the API returns a 409 status code.

6. **Cross-Process Locking:** `SettingsWorkspaceManager` uses two layers of locking for safe concurrent access on shared filesystems like EFS:
   - **In-memory Promise lock:** Prevents redundant async calls within the same Node.js process (Lambda request lifecycle)
   - **File-based lock (`wx` flag):** Uses `fs.open(path, 'wx')` (O_CREAT|O_EXCL) for atomic cross-process synchronization. Stale locks (>30s) are automatically cleaned up.

**Configuration:**

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  mode: 'prod',
  deploymentName: 'prod', // Settings branch: canopycms-settings-prod
  defaultRemoteUrl: 'https://github.com/your-org/your-repo.git',
  // ... other config
})
```

**How it works:**

```typescript
// Internal flow when updating permissions in prod mode
// 1. Check current contentVersion for optimistic locking
const currentFile = await loadPermissionsFile(branchRoot, mode)
if (
  expectedContentVersion !== undefined &&
  currentFile?.contentVersion !== expectedContentVersion
) {
  return { status: 409, error: 'Permissions were modified by another user' }
}

// 2. Get settings branch name from deploymentName config
const settingsBranchName = `canopycms-settings-${config.deploymentName}`
const settingsRoot = getBranchRoot(settingsBranchName)

// 3. SettingsWorkspaceManager ensures git workspace (dual-layer locking)
const manager = new SettingsWorkspaceManager(config)
await manager.ensureGitWorkspace({ settingsRoot, branchName, mode, remoteUrl })

// 4. Commits changes with incremented version
const newContentVersion = (currentFile?.contentVersion ?? 0) + 1
await savePermissions(settingsRoot, permissions, userId, mode, newContentVersion)

// 5. commitToSettingsBranch handles commit + push + PR (dual-path)
const result = await services.commitToSettingsBranch({
  branchRoot: settingsRoot,
  files: 'permissions.json', // At root of orphan branch
  message: 'Update permissions',
  createPR: true, // default — creates or updates PR via githubService or task queue
})
// result.syncStatus: 'synced' | 'pending-sync' | 'sync-failed'
```

#### Verifying Local Changes Aren't Committed

To ensure your local dev settings don't accidentally get committed:

```bash
# Check that .canopy* is in .gitignore
cat apps/example1/.gitignore
# Should contain: .canopy*

# Verify nothing shows in git status
git status
# .canopy-dev/ should NOT appear

# List what would be committed
git add -n .
# Should not include .canopy-dev/

# If you accidentally staged CanopyCMS runtime directories
git reset HEAD .canopy-dev/
```

**Common mistake:** Forgetting to add `.canopy*/` to `.gitignore` when setting up a new app.

**Fix:** Always add `.canopy*/` to your `.gitignore`. The `npx canopycms init` command does this automatically.

## Testing

### Test Coverage

The codebase maintains high test coverage (1260+ tests, 98%+ coverage):

| Test Type         | Location                           | Purpose                           |
| ----------------- | ---------------------------------- | --------------------------------- |
| Unit tests        | `src/**/__tests__/*.test.ts`       | Test individual functions/modules |
| Component tests   | `src/editor/**/*.test.tsx`         | Test React components with jsdom  |
| Integration tests | `src/__integration__/**/*.test.ts` | Test complete workflows           |

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter canopycms test

# Run a specific test file
pnpm --filter canopycms exec vitest run src/github-service.test.ts

# Run tests matching a pattern
pnpm --filter canopycms exec vitest run --grep "authorization"

# Run with coverage
pnpm --filter canopycms exec vitest run --coverage

# Watch mode for development
pnpm --filter canopycms exec vitest
```

### Integration Test Structure

Integration tests are in `src/__integration__/` with shared fixtures and utilities:

```
src/__integration__/
  fixtures/
    schemas.ts          # Shared test schemas
    content-seeds.ts    # Sample content for tests
  test-utils/
    test-workspace.ts   # Creates isolated test workspaces
    api-client.ts       # Test API client helpers
    multi-user.ts       # Multi-user scenario helpers
  errors/               # Error handling tests
  permissions/          # Permission/authorization tests
  validation/           # Input validation tests
  workflows/            # End-to-end workflow tests
```

**Creating test workspaces:**

```typescript
import { createTestWorkspace } from '../__integration__/test-utils/test-workspace'

describe('my integration test', () => {
  let workspace: TestWorkspace

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
      mode: 'dev',
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('does something with content', async () => {
    // workspace.root - path to isolated workspace
    // workspace.config - configured CanopyConfig
  })
})
```

### Working with Async Services

**createCanopyServices is now async** because it loads `.collection.json` meta files from the filesystem. This affects how you create and use services in tests.

**Basic Pattern:**

```typescript
import { createCanopyServices } from './services'

// Always await service creation
const services = await createCanopyServices(config)

// Use services in your tests
const reader = createContentReader({ services, basePathOverride: root })
```

**Why async?** CanopyCMS supports defining collections through `.collection.json` files in your content directory. These files reference schemas from a registry (e.g., `"fields": "postSchema"`). Services must scan and load these files at initialization time.

**Framework Integration:**

In Next.js apps, create services once at module initialization:

```typescript
// app/lib/canopy.ts
import { createNextCanopyContext } from 'canopycms-next'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

// Create context at module initialization (async)
const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin: getAuthPlugin(),
  entrySchemaRegistry,
})

// Export for server components
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

// Export for API routes
export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
```

**Next.js Context Wrapper:**

`createNextCanopyContext()` is also async for the same reason:

```typescript
import { createNextCanopyContext } from 'canopycms-next'

// Must await context creation
const { getCanopy, handler, services } = await createNextCanopyContext({
  config,
  authPlugin,
  entrySchemaRegistry,
})
```

### Creating Mock Services for Tests

When testing APIs or services, use the `createMockServices()` helper from test utilities:

```typescript
import { createMockServices, createMockApiContext } from '../test-utils/api-test-helpers'

it('tests some API handler', async () => {
  // Create mock services with entrySchemaRegistry (required!)
  const services = createMockServices({
    config: { mode: 'dev' },
    entrySchemaRegistry: {}, // Always include this
  })

  // Or use higher-level helper that includes entrySchemaRegistry by default
  const context = createMockApiContext({ services })

  // Test your handler
  const result = await someApiHandler(context, { user: mockUser })
  expect(result.ok).toBe(true)
})
```

**Critical: Mock services MUST include `entrySchemaRegistry` property.** This property is part of the `CanopyServices` interface and is required for schema resolution. Even if your test doesn't use schemas, include an empty object `{}` to match the interface.

**Why?** When `createCanopyServices()` became async, it started loading `.collection.json` files and building a schema registry. The registry resolves field references like `"fields": "postSchema"` to actual field configurations. Tests that bypass async service creation must manually provide this property.

**Integration Tests with Real Services:**

For integration tests, create services with `await createCanopyServices()`:

```typescript
import { createCanopyServices } from '../../services'
import { createMockApiContext } from '../../test-utils/api-test-helpers'

it('integrates with real services', async () => {
  // Create real services (loads .collection.json files)
  const services = await createCanopyServices(workspace.config)

  // Use in API context
  const context = createMockApiContext({ services })

  const result = await someHandler(context, { user: adminUser })
  expect(result.ok).toBe(true)
})
```

**When to use each approach:**

| Approach                       | Use Case                          | Pros                                  | Cons                                        |
| ------------------------------ | --------------------------------- | ------------------------------------- | ------------------------------------------- |
| `createMockServices()`         | Unit tests, simple scenarios      | Fast, no filesystem access            | Must manually set `entrySchemaRegistry: {}` |
| `await createCanopyServices()` | Integration tests, schema testing | Tests real behavior, loads meta files | Slower, requires test workspace             |

### Testing with Schema Meta Files

**What are `.collection.json` files?**

Collections can be defined via JSON files in your content directory instead of (or in addition to) the config:

```json
// content/posts/.collection.json
{
  "name": "posts",
  "label": "Posts",
  "entries": {
    "format": "json",
    "fields": "postSchema" // References registry key
  }
}
```

The `"fields": "postSchema"` reference is resolved from a schema registry provided at initialization.

**Setting up test fixtures with meta files:**

```typescript
import { createTestWorkspace } from '../test-utils/test-workspace'
import fs from 'node:fs/promises'
import path from 'node:path'

it('loads collections from .collection.json files', async () => {
  const workspace = await createTestWorkspace({
    schema: BLOG_SCHEMA, // Base schema
    mode: 'dev',
  })

  // Add a .collection.json file
  const postsDir = path.join(workspace.root, 'content/posts')
  await fs.mkdir(postsDir, { recursive: true })
  await fs.writeFile(
    path.join(postsDir, '.collection.json'),
    JSON.stringify({
      name: 'posts',
      entries: {
        format: 'json',
        fields: 'postSchema', // References schema registry
      },
    }),
  )

  // Create services (will load the meta file)
  const services = await createCanopyServices(workspace.config, {
    postSchema: [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'string' },
    ],
  })

  // Verify schema was loaded
  expect(services.flatSchema).toContainEqual(
    expect.objectContaining({
      type: 'collection',
      name: 'posts',
    }),
  )

  await workspace.cleanup()
})
```

**Entry Schema Registry Parameter:**

```typescript
// createCanopyServices accepts optional entrySchemaRegistry
const services = await createCanopyServices(
  config,
  entrySchemaRegistry, // Maps keys like 'postSchema' to FieldConfig[]
)
```

**Why use meta files?**

1. **Decoupling:** Schema definitions can live alongside content, not just in code
2. **Dynamic:** Content editors can create new collections without code changes
3. **Modular:** Each collection folder is self-contained with its schema definition

**Testing pattern:**

```typescript
// When testing code that uses meta files:
describe('Schema meta file integration', () => {
  let workspace: TestWorkspace

  beforeEach(async () => {
    workspace = await createTestWorkspace({ mode: 'dev' })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('merges meta file schemas with config schemas', async () => {
    // Setup: Create .collection.json in workspace
    // ...

    // Act: Create services (loads meta files)
    const services = await createCanopyServices(workspace.config, entrySchemaRegistry)

    // Assert: Check merged schema
    expect(services.flatSchema.length).toBeGreaterThan(0)
  })
})
```

### Mocking Git Operations

After a major refactoring, CanopyCMS tests now mock high-level git service methods instead of low-level git operations. This makes tests more maintainable and focused on API behavior.

**New Pattern: Use `createMockGitServices()`**

Import the test utility:

```typescript
import { createMockGitServices } from '../test-utils/mock-git-services'
```

Create mock services in your test setup:

```typescript
const mockGitServices = createMockGitServices()

const mockContext: ApiContext = {
  services: {
    config: testConfig,
    flatSchema: [],
    // ... other services
    commitFiles: mockGitServices.commitFiles,
    submitBranch: mockGitServices.submitBranch,
  },
  getBranchContext: vi.fn().mockResolvedValue({
    baseRoot: '/test/repo',
    branchRoot: '/test/repo',
    branch: {
      name: 'main',
      status: 'editing',
      // ... branch metadata
    },
  }),
}
```

**Verify Git Operations in Tests**

After calling an API handler, verify that `commitFiles` or `submitBranch` was called with the correct arguments:

```typescript
it('commits files when updating permissions', async () => {
  const req: ApiRequest = {
    method: 'POST',
    url: '/main/permissions',
    json: async () => ({
      path: 'content/posts',
      groups: { Editors: ['read', 'write'] },
    }),
  }

  const result = await updatePermissionsHandler(
    mockContext,
    { user: adminUser },
    { branch: 'main' },
  )

  expect(result.ok).toBe(true)

  // Verify commitFiles was called with correct arguments
  expect(mockContext.services.commitFiles).toHaveBeenCalledWith({
    context: {
      baseRoot: '/test/repo',
      branchRoot: '/test/repo',
      branch: {
        name: 'main',
        status: 'editing',
        access: { allowedUsers: [], allowedGroups: [] },
        createdBy: 'admin-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    },
    files: 'permissions.json', // At root of settings branch workspace
    message: 'Update permissions',
  })
})
```

**What Changed**

**Old Pattern (Deprecated):**

```typescript
// DON'T DO THIS - old pattern
const mockGitManager = {
  ensureAuthor: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
}

// Verify individual git operations
expect(mockGitManager.ensureAuthor).toHaveBeenCalled()
expect(mockGitManager.add).toHaveBeenCalledWith('permissions.json') // At root of settings branch
expect(mockGitManager.commit).toHaveBeenCalledWith('Update permissions')
```

**New Pattern (Current):**

```typescript
// DO THIS - new pattern
import { createMockGitServices } from '../test-utils/mock-git-services'

const mockGitServices = createMockGitServices()

// Include in ApiContext
services: {
  commitFiles: mockGitServices.commitFiles,
  submitBranch: mockGitServices.submitBranch,
}

// Verify high-level service calls
expect(mockContext.services.commitFiles).toHaveBeenCalledWith({
  context: branchContext,
  files: 'permissions.json',  // At root of settings branch workspace
  message: 'Update permissions',
})
```

**When to Use Each Method**

- `commitFiles`: For operations that modify content or metadata files (permissions, groups, content updates)
- `submitBranch`: For workflow operations that transition a branch to merge (submit for review, approve merge)

**Benefits of the New Pattern**

1. **Higher-level abstractions** - Test the service interface, not git internals
2. **Cleaner test setup** - `createMockGitServices()` creates both mocks at once
3. **Easier maintenance** - Changes to git implementation don't break tests
4. **More focused tests** - Verify what the API does, not how git works

See `/packages/canopycms/src/api/permissions.test.ts` (lines 169-185) and `/packages/canopycms/src/api/groups.test.ts` (lines 195-210) for complete examples.

### Testing with Real Git Operations

Some subsystems -- particularly the worker's rebase logic -- need to test against actual git repositories rather than mocks. The `initTestRepo()` utility and a "local remote" pattern make this practical.

**The `initTestRepo()` utility** (`src/test-utils/git-helpers.ts`):

```typescript
import { initTestRepo } from '../test-utils'

// Creates a git repo with CanopyCMS marker config and test user identity
const git = await initTestRepo(tmpDir)
await git.add(['.'])
await git.commit('Initial commit')
```

This sets `canopycms.managed=true`, `user.name`, and `user.email` so the repo works with `GitManager.ensureAuthor()`.

**Local remote pattern** (from `cms-worker-rebase.test.ts`):

When testing branch synchronization or rebase, create a local "remote" repo and clone it into a branch workspace structure:

```typescript
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { initTestRepo } from '../test-utils'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-rebase-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// Set up a local "remote" repo
const remotePath = path.join(tmpDir, 'remote')
await fs.mkdir(remotePath)
const remoteGit = await initTestRepo(remotePath)
await remoteGit.raw(['branch', '-M', 'main'])
await fs.writeFile(path.join(remotePath, '.gitkeep'), '')
await remoteGit.add(['.'])
await remoteGit.commit('initial commit')

// Clone it as a branch workspace
const branchPath = path.join(tmpDir, 'content-branches', 'my-feature')
await simpleGit().clone(remotePath, branchPath)
const branchGit = simpleGit({ baseDir: branchPath })
await branchGit.addConfig('user.name', 'Test Bot')
await branchGit.addConfig('user.email', 'test@canopycms.test')

// Prevent interactive editor during rebase --continue
await branchGit.addConfig('core.editor', 'true')

// Exclude .canopy-meta/ from git (matches production ensureGitExclude behavior)
const excludeFile = path.join(branchPath, '.git', 'info', 'exclude')
await fs.mkdir(path.dirname(excludeFile), { recursive: true })
await fs.appendFile(excludeFile, '\n.canopy-meta/\n')
```

**Why real git instead of mocks:** Rebase behavior -- especially conflict resolution, upstream tracking, and dirty-tree detection -- is too nuanced to mock reliably. Real git repos in temp directories are fast and catch edge cases that mocks would miss.

**Testing private methods via type casting:**

When the method under test is private, cast through `unknown` to access it:

```typescript
// Invoke a private method for testing
const runRebase = (worker: CmsWorker): Promise<void> =>
  (worker as unknown as { rebaseActiveBranches(): Promise<void> }).rebaseActiveBranches()
```

This is preferable to making the method public just for testing. Use it sparingly -- only when the private method has complex logic that warrants direct testing.

**Git rebase `--ours` vs `--theirs` reversal:**

During `git rebase`, the meaning of `--ours` and `--theirs` is **reversed** from their usual meaning in `git merge`:

| Context      | `--ours`                                 | `--theirs`                            |
| ------------ | ---------------------------------------- | ------------------------------------- |
| `git merge`  | Current branch (your work)               | The branch being merged in            |
| `git rebase` | The upstream commits being replayed onto | The branch being replayed (your work) |

In CanopyCMS's rebase conflict resolution, we use `git checkout --theirs <file>` to keep the **editor's version** of a conflicted file, because during rebase the editor's branch commits are "theirs." This is counterintuitive and was caught by a test -- a good example of why real git tests matter for this kind of logic.

### Testing UI Conflict Indicators

When a rebase detects conflicts, the editor UI shows a notice on affected entries. Test this with the `conflictNotice` prop on `FormRenderer`:

```typescript
import { render, screen } from '@testing-library/react'

it('shows conflict notice when conflictNotice prop is true', () => {
  render(
    <CanopyCMSProvider>
      <FormRenderer
        fields={fields}
        value={{ title: 'hello' }}
        onChange={() => {}}
        conflictNotice
      />
    </CanopyCMSProvider>
  )
  expect(screen.getByText(/Someone else has recently changed this page/)).toBeTruthy()
})

it('hides conflict notice when prop is absent', () => {
  render(
    <CanopyCMSProvider>
      <FormRenderer fields={fields} value={{ title: 'hello' }} onChange={() => {}} />
    </CanopyCMSProvider>
  )
  expect(screen.queryByText(/Someone else has recently changed this page/)).toBeNull()
})
```

**Why this pattern:** Conflict detection happens server-side (worker rebase writes `conflictFiles` to branch metadata). The editor reads this metadata and passes `conflictNotice` as a boolean prop to the form. Testing both the server-side detection (real git tests) and the client-side display (component tests) ensures the full conflict flow works end-to-end.

### Expecting Console Messages

When testing code that intentionally logs to `console.error`, `console.warn`, or `console.log`, use the `mockConsole()` utility to:

1. Capture the messages for assertion
2. Prevent them from cluttering test output
3. Verify the expected message was logged

**Import the utility:**

```typescript
import { mockConsole } from './test-utils/console-spy.js'
```

**Basic usage:**

```typescript
it('logs error when something fails', () => {
  const consoleSpy = mockConsole()

  // Call code that logs to console
  doSomethingThatLogs()

  // Assert on specific messages
  expect(consoleSpy).toHaveErrored('Failed to do something')
  expect(consoleSpy).toHaveWarned('Deprecation warning')
  expect(consoleSpy).toHaveLogged('Debug info')

  // Always restore at the end
  consoleSpy.restore()
})
```

**Available matchers:**

- `toHaveErrored(pattern)` - matches `console.error` calls
- `toHaveWarned(pattern)` - matches `console.warn` calls
- `toHaveLogged(pattern)` - matches `console.log` calls

Patterns can be strings (substring match) or RegExp.

**Debugging captured messages:**

```typescript
const consoleSpy = mockConsole()
doSomething()
console.log('Captured:', consoleSpy.all()) // Shows all captured messages by method
consoleSpy.restore()
```

**Example from the codebase:**

```typescript
// From github-service.test.ts
it('should return null when token is missing', () => {
  const consoleSpy = mockConsole()
  const service = createGitHubService(mockConfig, 'https://github.com/owner/repo.git')
  expect(service).toBeNull()
  expect(consoleSpy).toHaveWarned('GitHub token not found')
  consoleSpy.restore()
})
```

This approach ensures:

- Expected console output doesn't pollute test runs
- Unexpected console output still surfaces (helping catch real issues)
- Console behavior is properly tested as part of the functionality

### Testing Context and Auth

When testing code that uses the context factory pattern:

**Testing Bootstrap Admin Groups**

```typescript
it('applies bootstrap admin groups to authenticated users', async () => {
  const config: CanopyConfig = {
    // ... config with bootstrapAdminIds: ['admin-123']
  }

  const mockUser: AuthenticatedUser = {
    type: 'authenticated',
    userId: 'admin-123',
    groups: [], // User has no groups yet
  }

  const context = createCanopyContext({
    config,
    getUser: async () => mockUser,
  })

  const canopy = await context.getContext()

  // Bootstrap admin should now have Admins group
  expect(canopy.user.groups).toContain('Admins')
})
```

**Testing Static Deployment Bypass**

```typescript
it('returns STATIC_DEPLOY_USER for static deployments', async () => {
  const staticConfig = { ...config, deployedAs: 'static' as const }
  const services = await createCanopyServices(staticConfig, { entrySchemaRegistry })
  const mockUser: CanopyUser = { type: 'anonymous' }
  const context = createCanopyContext({
    services,
    extractUser: async () => mockUser, // This should NOT be called
  })

  const canopy = await context.getContext()

  // Should bypass extractUser and return STATIC_DEPLOY_USER
  expect(canopy.user.userId).toBe('__static_deploy__')
  expect(canopy.user.groups).toContain('Admins')
})
```

**Testing Content Reader with Auth**

```typescript
it('enforces permissions when reading content', async () => {
  const restrictedUser: CanopyUser = {
    type: 'authenticated',
    userId: 'user-123',
    groups: [], // No groups = no access
  }

  const context = createCanopyContext({
    config: configWithRestrictedContent,
    getUser: async () => restrictedUser,
  })

  const canopy = await context.getContext()

  // Should throw permission error
  await expect(canopy.read({ entryPath: 'content/restricted' })).rejects.toThrow(
    'Permission denied',
  )
})
```

**Testing Anonymous vs Authenticated**

```typescript
it('handles anonymous users correctly', async () => {
  const context = createCanopyContext({
    config,
    getUser: async () => ANONYMOUS_USER,
  })

  const canopy = await context.getContext()

  expect(canopy.user.type).toBe('anonymous')
  expect(canopy.user.groups).toEqual([])
})
```

### API Client Generation

The TypeScript API client is auto-generated from the route registry. When you add new API endpoints:

**1. Define the endpoint with `defineEndpoint()`**

In your API module (e.g., `packages/canopycms/src/api/my-module.ts`):

```typescript
import { defineEndpoint } from './route-builder'

defineEndpoint({
  namespace: 'myModule',
  name: 'getSettings',
  method: 'GET',
  path: '/settings/:id',
  paramsSchema: z.object({ id: z.string() }),
  responseTypeName: 'SettingsResponse',
  defaultMockData: {
    ok: true,
    status: 200,
    data: { id: '123', name: 'Default' },
  },
})
```

**2. Add the module import to the generator script**

In `packages/canopycms/scripts/generate-client.ts`, add the module import:

```typescript
// Import all API modules to populate ROUTE_REGISTRY
import '../src/api/my-module.js' // Add this line
```

**3. Add namespace mapping (if needed)**

If your namespace doesn't match the filename, add a mapping in `namespaceToModule()`:

```typescript
function namespaceToModule(namespace: string): string {
  const mapping: Record<string, string> = {
    // ... existing mappings
    myModule: 'my-module', // Add this
  }
  return mapping[namespace] || namespace
}
```

**4. Generate the client**

```bash
pnpm run generate:client
```

This creates typed methods in `src/api/client.ts` and mock helpers in `src/api/__test__/mock-client.ts`.

**Usage in client code:**

```typescript
// Auto-generated and type-safe
const response = await client.myModule.getSettings({ id: '123' })
if (response.ok) {
  console.log(response.data) // Type: SettingsResponse
}
```

**Why this pattern:** The route registry eliminates regex parsing and keeps endpoint definitions close to implementations. All metadata (params, response types, mock data) flows through the registry into the generated client.

### Integration Testing with Framework Adapters

When testing framework-specific adapters:

**Next.js Adapter Testing**

```typescript
// Mock Next.js headers
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => {
      if (name === 'authorization') return 'Bearer valid-token'
      return null
    },
  })),
}))

it('extracts user from Next.js headers', async () => {
  const { getCanopy } = createNextCanopyContext({ config, authPlugin })
  const canopy = await getCanopy()

  expect(canopy.user.type).toBe('authenticated')
  expect(canopy.user.userId).toBe('expected-user-id')
})
```

**Testing Per-Request Caching**

```typescript
it('caches context per request with React cache()', async () => {
  const getUserSpy = vi.fn(async () => mockUser)

  const coreContext = createCanopyContext({
    config,
    getUser: getUserSpy,
  })

  const getCanopy = cache(() => coreContext.getContext())

  // Multiple calls in same request should use cache
  await getCanopy()
  await getCanopy()

  expect(getUserSpy).toHaveBeenCalledTimes(1) // Cached!
})
```

## Deployment Infrastructure

### CmsWorker (canopycms/worker/cms-worker)

The `CmsWorker` class handles internet-requiring operations that Lambda cannot perform. It is cloud-agnostic and auth-agnostic:

- **Task queue processing**: Polls `.tasks/pending/` on the workspace filesystem
- **Git sync**: Fetches from GitHub into `remote.git`, rebases active branch workspaces, and pushes `canopycms-settings-*` branches to GitHub (belt-and-suspenders for the task queue -- ensures settings reach GitHub even if a task queue entry is lost)
- **Auth cache refresh**: Calls a pluggable `refreshAuthCache` callback

The worker lives in the core `canopycms` package, not in `canopycms-cdk`, because it has no cloud dependencies.

### Task Queue (canopycms/worker/task-queue)

File-based task queue for async GitHub operations:

```typescript
import { enqueueTask, dequeueTask, completeTask } from 'canopycms/worker/task-queue'

// Lambda side: enqueue
const taskId = await enqueueTask(taskDir, {
  action: 'push-and-create-pr',
  payload: { branch: 'feature-x', title: 'New feature' },
})

// Worker side: dequeue and process
const task = await dequeueTask(taskDir)
// ... execute task ...
await completeTask(taskDir, task.id, { prUrl: '...' })
```

**Task actions (`TaskAction` union in `worker/task-queue.ts`):**

| Action                         | Purpose                                              | Used by                                                           |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `push-and-create-pr`           | Push branch, create new PR                           | Content branch submit (new PR)                                    |
| `push-and-update-pr`           | Push branch, update existing PR                      | Content branch submit (existing PR)                               |
| `push-and-create-or-update-pr` | Push branch, find existing open PR or create new one | Settings branches (idempotent -- settings get updated repeatedly) |
| `convert-to-draft`             | Convert PR to draft state                            | Withdraw, request-changes                                         |
| `close-pr`                     | Close a PR                                           | Branch cleanup                                                    |
| `delete-remote-branch`         | Delete branch from GitHub                            | Branch cleanup                                                    |
| `push-branch`                  | Push branch without PR operations                    | Sync-only pushes                                                  |

The `push-and-create-or-update-pr` action is specifically designed for settings branches, which are updated many times but should maintain a single open PR. It queries GitHub for an existing open PR on the branch before deciding whether to create or update.

### Auth Caching Pattern

Each auth plugin provides a symmetric pair:

- **Token verifier**: Extracts userId from request context (networkless)
- **Cache writer**: Populates JSON files for `FileBasedAuthCache`

| Package                | Token Verifier             | Cache Writer          |
| ---------------------- | -------------------------- | --------------------- |
| `canopycms-auth-clerk` | `createClerkJwtVerifier()` | `refreshClerkCache()` |
| `canopycms-auth-dev`   | `createDevTokenVerifier()` | `refreshDevCache()`   |

`CachingAuthPlugin` wraps a token verifier + `FileBasedAuthCache` into a full `AuthPlugin`.

### GitHub Sync Helper (api/github-sync)

`syncSubmitPr()` and `syncConvertToDraft()` transparently use `githubService` when available or fall back to the task queue. API handlers use these without knowing the deployment topology.

`commitToSettingsBranch` in `services.ts` uses the same dual-path pattern for settings branches: direct `githubService.createOrUpdatePR()` when available, or enqueue `push-and-create-or-update-pr` when not. This means settings and content branches share a consistent approach to GitHub synchronization despite having different PR semantics (settings reuse a single PR; content branches create one per branch).

### Worker CLI

For local development in dev mode:

```bash
pnpm exec canopycms worker run-once  # Refresh cache, process tasks, exit
```

### Testing

Integration tests cover the full lifecycle: submit handler enqueues → worker dequeues → task completes. See `src/worker/integration.test.ts`.

Rebase logic is tested with real git operations in `src/worker/cms-worker-rebase.test.ts`. These tests create local "remote" repos in temp directories to exercise branch skipping (submitted/approved/dirty), clean rebase, and conflict detection with ContentId extraction. See [Testing with Real Git Operations](#testing-with-real-git-operations) for the pattern.

### CLI (`canopycms init`)

The `canopycms init` CLI scaffolds a new CanopyCMS project. It lives at `src/cli/init.ts` and uses `tsx` as its runtime so TypeScript works in both source and published dist contexts.

**Key implementation details:**

- **Shebang:** `#!/usr/bin/env tsx` (not `node`). This means `tsx` is a production dependency -- it must be available at runtime for adopters who run `npx canopycms init`.
- **Template files:** The CLI reads `.template` files from `src/cli/template-files/` at runtime using `import.meta.url` to locate the directory relative to the script. The directory was renamed from `templates/` to `template-files/` to avoid an ESM directory import collision with `templates.ts`.
- **postbuild copy:** Since `tsc` only compiles `.ts` files, the template files must be copied to `dist/` separately. The `postbuild` script in `package.json` handles this:

```bash
# In packages/canopycms/package.json scripts:
"postbuild": "cp -r src/cli/template-files dist/cli/template-files"
```

If you add new template files to `src/cli/template-files/`, the postbuild step picks them up automatically. If you rename the directory or change the copy target, update both `templates.ts` (the `TEMPLATES_DIR` constant) and the `postbuild` script.

**CLI integration tests (`init.integration.test.ts`):**

The CLI has integration tests that verify the binary actually runs and produces expected files. These tests exercise both source and dist execution paths:

```typescript
// Source path: runs src/cli/init.ts via tsx
execFileAsync(tsxBin, [SRC_BIN, 'init', '--non-interactive', '--force'], { cwd: tmpDir })

// Dist path: runs dist/cli/init.js via tsx (requires prior build)
execFileAsync(tsxBin, [DIST_BIN, 'init', '--non-interactive', '--force'], { cwd: tmpDir })
```

The dist tests will fail if `pnpm build` has not been run first, since they depend on compiled output in `dist/`. The test `beforeAll` hook checks for `dist/cli/init.js` and throws a clear error if it is missing.

**When to update these tests:** If you change the set of files that `canopycms init` creates, update the `expectedFiles` array in both the dist and source test blocks in `init.integration.test.ts`.

### CLI (`canopycms sync`)

The `canopycms sync` command provides bidirectional content sync between the developer's working tree and CMS branch workspaces in `.canopy-dev/content-branches/`. Implementation is in `src/cli/sync.ts`.

**Why this exists:** In dev mode, the CMS works against branch workspaces (`.canopy-dev/content-branches/`). When a developer edits content files directly in their working tree, the CMS does not see those changes. Conversely, when content is edited through the CMS UI, the developer's working tree is not updated. `canopycms sync` bridges this gap.

**Commands:**

```bash
# 3-way merge: merge working-tree and editor changes, pull result back (default)
npx canopycms sync

# Push working-tree content into a branch workspace (working tree → CMS)
npx canopycms sync --push

# Pull content from a branch workspace (CMS → working tree)
npx canopycms sync --pull

# Abort a failed merge in the branch workspace
npx canopycms sync --abort

# Target a specific branch workspace
npx canopycms sync --push --branch my-feature

# Specify a custom content directory (default: content)
npx canopycms sync --content-root src/content
```

**Push flow:** Copies the working tree's content directory into the branch workspace, replacing it. Uncommitted editor changes in the workspace are auto-committed to git history before overwriting, so nothing is lost. The resulting commit is tagged `canopycms-sync-base` for future 3-way merges. Uses crash-safe directory replacement (backup-rename pattern) so that if interrupted, at least one copy always exists on disk.

**Pull flow:** Copies content from a branch workspace back into the working tree's content directory. Before overwriting, detects both uncommitted changes and untracked files that would be deleted, and warns with a confirmation prompt. If multiple branch workspaces exist and `--branch` is not specified, an interactive prompt lets you choose. After pulling, review the changes with `git diff` and commit when ready.

**Both (3-way merge) flow:** The default when running `canopycms sync` without flags. Uses a `canopycms-sync-base` git tag as the merge base to perform a proper 3-way merge between working-tree changes and editor changes in the workspace. If the merge produces conflicts, the workspace is left in a merge state with instructions to resolve manually, then run `canopycms sync --pull` or `canopycms sync --abort`.

**Abort flow:** Runs `git merge --abort` in the branch workspace to cancel a failed merge and restore the workspace to its pre-merge state.

**Security: path traversal guards.** The `--branch` and `--content-root` flags are validated with `assertWithinDir()` to prevent path traversal attacks (e.g., `--branch ../../etc`). Every resolved path is checked to ensure it stays within its expected parent directory before any file operations.

**Typical workflow:**

```bash
# 1. Edit content files directly
vim content/posts/new-post.mdx

# 2. Push changes so the CMS can see them
npx canopycms sync --push

# 3. Open the CMS UI, refine content, publish

# 4. Pull the published changes back to your working tree
npx canopycms sync --pull

# 5. Review and commit
git diff
git add content/
git commit -m "Update posts"

# Or use 3-way merge to handle both directions at once
npx canopycms sync
```

## Quality Checks

Before handoff, run typecheck and tests:

```bash
pnpm typecheck
pnpm test
```

### Storybook

Update stories when UI changes. Run Storybook to verify:

```bash
pnpm --filter canopycms storybook
```

### Test Coverage

Add tests alongside new logic. Integration tests cover end-to-end behavior.

### Async Changes Quick Reference

**Function signatures that changed to async:**

| Function                                             | Location                                         | Reason                               |
| ---------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| `createCanopyServices(config, entrySchemaRegistry?)` | `packages/canopycms/src/services.ts`             | Loads `.collection.json` meta files  |
| `createNextCanopyContext(options)`                   | `packages/canopycms-next/src/context-wrapper.ts` | Calls async `createCanopyServices()` |

**What to update in your code:**

```typescript
// BEFORE: Synchronous service creation
const services = createCanopyServices(config)

// AFTER: Async service creation
const services = await createCanopyServices(config)

// BEFORE: Synchronous Next.js context
const { getCanopy } = createNextCanopyContext({ config, authPlugin })

// AFTER: Async Next.js context
const { getCanopy } = await createNextCanopyContext({
  config,
  authPlugin,
  entrySchemaRegistry,
})
```

**New required properties in mock services:**

```typescript
// Always include entrySchemaRegistry when creating mock services
const services = createMockServices({
  entrySchemaRegistry: {}, // Required even if empty
})
```

**Test setup pattern:**

```typescript
// Tests must use async functions for setup
it('does something', async () => {
  const services = await createCanopyServices(config)
  // ... rest of test
})

// Or use beforeEach for shared setup
let services: CanopyServices
beforeEach(async () => {
  services = await createCanopyServices(config)
})
```

**Common errors and fixes:**

| Error                                              | Cause                       | Fix                                         |
| -------------------------------------------------- | --------------------------- | ------------------------------------------- |
| `Property 'entrySchemaRegistry' is missing`        | Using old mock structure    | Add `entrySchemaRegistry: {}` to mock       |
| `Cannot read property 'then' of undefined`         | Forgot to await             | Add `await` before `createCanopyServices()` |
| `Type 'Promise<CanopyServices>' is not assignable` | Not awaiting async function | Add `await` or use `async` function         |

### Claude Subagents

For automated quality checks, see:

- `.claude/agents/test.md` - Test runner
- `.claude/agents/typecheck.md` - Type checker
- `.claude/agents/review.md` - Code review
