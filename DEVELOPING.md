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

### Static-Export Helpers (`generateStaticParams`)

Prefer the framework helper over hand-rolled `generateStaticParams`. `generateContentStaticParams(opts)` is a **bound method on the `createNextCanopyContext()` result** — it closes over the (guarded) build context, so your page modules enumerate routable content without ever importing the admin `getCanopyForBuild`. Wire it through `lib/canopy` alongside the phase-selecting reads, then call `context.generateContentStaticParams(opts)`:

```typescript
// app/lib/canopy.ts
const canopyContextPromise = createNextCanopyContext({ config, authPlugin, entrySchemaRegistry })

export const contentStaticParams = async (options?: GenerateContentStaticParamsOptions) => {
  const context = await canopyContextPromise
  return context.generateContentStaticParams(options)
}
```

Pages import the bound helper from `lib/canopy` — never `getCanopyForBuild`.

**Single-segment `[slug]` route** — scope to one collection with `rootPath` + `shape: 'single'`:

```typescript
// app/posts/[slug]/page.tsx
import { contentStaticParams } from '../../lib/canopy'

export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/posts', shape: 'single' })
```

**Catch-all `[...slug]` / `[[...slug]]` route** — the default `shape: 'catch-all'` emits the URL `segments` array across all content:

```typescript
// app/[...slug]/page.tsx
export const generateStaticParams = () => contentStaticParams()
```

**Options** (`GenerateContentStaticParamsOptions`):

| Option      | Purpose                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootPath`  | Scope to a collection logical path (e.g. `content/posts`); defaults to the whole content root                                                                               |
| `shape`     | `'catch-all'` (default, emits `segments`) or `'single'` (emits the entry `slug`)                                                                                            |
| `basePath`  | For a catch-all nested under a URL prefix (e.g. `app/docs/[[...slug]]`), the route base (e.g. `'/docs'`); scopes entries to that prefix and makes `segments` relative to it |
| `paramName` | Route param name; defaults to `'slug'`                                                                                                                                      |
| `filter`    | Predicate to drop entries (e.g. exclude the root index: `(e) => e.segments.length > 0`)                                                                                     |

**`basePath` for nested catch-all routes:** a catch-all under a URL prefix needs its params relative to that prefix, or the route generates doubled paths like `/docs/docs/...`. Pass `basePath` so the segments are stripped of the prefix:

```typescript
// app/docs/[[...slug]]/page.tsx
export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/docs', basePath: '/docs' })
```

**Gotcha:** a root index (`/`) yields empty `segments` — keep it only for an optional catch-all `[[...slug]]`, otherwise exclude it with `filter`.

Under the hood the bound method calls the framework-agnostic free helper `collectStaticParams(buildCtx, opts)` (from `canopycms-next`), which maps the neutral `StaticPathEntry[]` descriptors (each carrying a collapsed `segments` array, the entry `slug`, and `urlPath`) returned by core `collectStaticPaths(ctx, opts)` (from `canopycms/server`). Reach for those free helpers directly only when building a non-Next adapter or a sitemap.

See `apps/example1/app/posts/[slug]/page.tsx` (single-segment) and `apps/example1/app/docs/[[...slug]]/page.tsx` (nested catch-all with `basePath`) — both use the bound helper plus phase-selecting reads.

### Build-Time Single-Entry Reads

There are three ways to read a single entry, and using the wrong one at build time silently returns `null` (the "build fine, dev blank" trap):

| Source                                         | Phase                       | ACLs / branch                                    | Use for                                                                            |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `createNextCanopyContext().read/readByUrlPath` | **Either** (auto-selecting) | Picks build context at build, runtime at request | **Recommended** page surface for `[...slug]` / `[slug]` resolution                 |
| `getCanopy().read/readByUrlPath`               | Request only                | Branch-aware, enforces ACLs                      | Server-component rendering at request time                                         |
| `getCanopyForBuild().read/readByUrlPath`       | Build only                  | Synthetic admin, no ACLs, working tree           | Advanced escape hatch: `generateMetadata`, build-time render that needs raw access |

**Never call the runtime `getCanopy().readByUrlPath()` at build time** — there is no request context, so it returns `null` and your statically generated pages come up blank. `getCanopyForBuild()` is an advanced escape hatch (synthetic admin, bypasses all ACLs); the recommended page surface is the phase-selecting `read`/`readByUrlPath` plus the bound `contentStaticParams`, which never hand the admin context to your page modules. On a **production `server` deployment** (`mode: 'prod' && deployedAs: 'server' && !isBuildMode()`), `getCanopyForBuild()` methods _throw_ if invoked at request time, so they can't accidentally leak protected content into a request path. The guard only fires in prod because dev legitimately uses the build context for `generateStaticParams`/`generateMetadata` (same not-build signature as the request-time footgun, with no reliable way to tell them apart), whereas in prod that ambiguity is gone.

**Recommended: the phase-selecting `read`/`readByUrlPath` from `createNextCanopyContext()`.** They are correct in both phases by construction — filesystem-direct working tree at build, branch-aware ACL-enforced runtime at request — so page code never has to hand-pick the admin build context:

```typescript
// app/lib/canopy.ts
const ctx = await createNextCanopyContext({ config, authPlugin, entrySchemaRegistry })
export const readByUrlPath = ctx.readByUrlPath // auto-selects build vs runtime
```

`apps/example1` follows this: `app/lib/canopy.ts` exports the phase-selecting `read`/`readByUrlPath` and the bound `contentStaticParams`, and the pages call those — `app/posts/[slug]/page.tsx` (single-segment) and `app/docs/[[...slug]]/page.tsx` (nested catch-all with `basePath`), both resolving via `readByUrlPath` + `notFound()`. Neither page imports `getCanopyForBuild`.

### Branch Config: defaultBaseBranch vs defaultActiveBranch

CanopyCMS distinguishes between two branch config fields:

- **`defaultBaseBranch`** -- The fork point for new CMS branches. When the editor creates a branch, it forks from this branch. When unset in dev mode, it is auto-detected from the current git HEAD (same as the active branch). The canonical resolver is `resolveBaseBranch()` in `utils/git.ts`: explicit config wins → dev-mode git HEAD → `'main'`. Used by `GitManager`, `BranchWorkspace`, and `GitHubService` for rebase targets and PR base branches. The fork point used to create a workspace is recorded immutably in branch metadata (`branch.baseBranch` in `.canopy-meta/branch.json`); git operations on existing branches (`commitFiles`/`submitBranch` in `services.ts`, the PR base in `api/github-sync.ts`) prefer the recorded value over config, so a branch stays pinned to its original base even if the config value changes later.

- **`defaultActiveBranch`** -- Which workspace to serve content from by default. This is the branch the dev server, editor UI, content reader, and AI content resolver use when no branch is explicitly requested.

**Auto-detection in dev mode:**

Both branch identity fields are resolved once at service creation and baked into config: `defaultActiveBranch` is auto-detected from the current git HEAD (`createActiveBranchDetector()` in `services.ts`), and `defaultBaseBranch` follows the same dev-mode HEAD detection when unset (matching `resolveBaseBranch()`). `refreshActiveBranch()` then re-detects **both** per-request (with a 5-second cache) — each field only when not explicitly configured; explicit config values are never overridden. Both the HTTP API handler and `getCanopy()`/`getContext()` perform this refresh (previously only the HTTP handler did), so server-component reads follow branch switches too. This means if you switch from `main` to `my-feature` while the dev server is running, the CMS silently starts serving content from the `my-feature` workspace — no restart needed. The workspace is lazily created on the first content request if it doesn't exist. On a detached HEAD or outside a git repo, detection falls back to `defaultBaseBranch ?? 'main'` (the active-branch detector passes the base branch as the `detectHeadBranch` fallback). Static deployments (`deployedAs: 'static'`) never shell out to git for branch detection — they fall back to `defaultBaseBranch ?? 'main'`.

This only affects non-editor content serving (public site, `getCanopy()`, AI content). The editor is pinned to its own branch via URL params and stores drafts per-branch in localStorage.

**The resolved base branch is protected** (see [ARCHITECTURE.md](ARCHITECTURE.md#protected-base-branch)): it can never be submitted for review in either mode, and in prod it is read-only in the editor. In dev the base branch — which is your detected HEAD branch when `defaultBaseBranch` is unset — **stays editable** (editing it is the normal local flow, reconciled via `canopycms sync`), but the Submit button is hidden on it: a branch can't PR against itself. Create a CMS editing branch when you want to exercise the submit/review flow locally.

The detection priority for `defaultActiveBranch` is:

1. Explicit `defaultActiveBranch` in config (both modes)
2. Current git HEAD branch (dev mode only)
3. `defaultBaseBranch` from config
4. `'main'` as final fallback

For `defaultBaseBranch` (via `resolveBaseBranch()` in `utils/git.ts`):

1. Explicit `defaultBaseBranch` in config (both modes)
2. Current git HEAD branch (dev mode only)
3. `'main'` as final fallback

**Where `defaultActiveBranch` is consumed:**

Content-serving code uses the pattern `config.defaultActiveBranch ?? config.defaultBaseBranch ?? 'main'`:

- `context.ts` -- determines the branch for `getContext()`
- `http/handler.ts` -- determines the branch for API requests without an explicit branch parameter
- `CanopyEditorPage.tsx` -- determines the initial branch for the editor UI
- `ai/resolve-branch.ts` -- determines the branch for AI content generation
- `content-reader.ts` -- determines the branch for `createContentReader()`

**Impact on sync CLI:**

The `canopycms sync` command defaults to the current git branch (via `detectCurrentBranch()`) and auto-creates workspaces on push with `selectBranch({ autoCreate: true })`. This means `sync push` on a new branch will create a workspace automatically, matching the `defaultActiveBranch` auto-detection behavior. Note that content validation runs before the auto-create — a precondition failure throws a typed `SyncError` (stderr + exit 1) without creating the workspace.

**In tests:**

`createTestCanopyServices` (in `services.ts`) pins both branch identity fields — `defaultBaseBranch ?? 'main'` and `defaultActiveBranch ?? defaultBaseBranch ?? 'main'` — so tests never shell out to git for HEAD detection (which would vary with the developer's working branch). Mock services skip detection entirely since it only runs in real service creation. Tests that construct `BranchWorkspaceManager` directly should still set `defaultBaseBranch` explicitly to avoid HEAD detection during workspace creation (see `branch-workspace.test.ts`, which sets `'main'`). If your test needs a specific active branch, set it explicitly:

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

**`mode` is required by the real config schema, but not in test fixtures:** production config (`defineCanopyConfig`) has no default for `mode` -- a prod deploy that omits it must fail validation loudly rather than silently running header-trusting dev auth semantics. `defineCanopyTestConfig()` (in `src/config-test.ts`) defaults `mode` to `'dev'` for you, so existing test configs don't all need `mode: 'dev'` added. Use `defineCanopyTestConfig()`/`createTestServices()` rather than hand-rolling `mode` into every test config; if you need a `'prod'`-mode test config, pass it explicitly (`defineCanopyTestConfig({ ..., mode: 'prod' })`).

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

### Page Blocks (Flexible Content)

The `block` field type holds an **ordered, repeatable list of heterogeneous section templates** — the "flexible content" / page-builder pattern. Each item in the list is one of the field's `templates`, discriminated by a `template` literal. `TypeFromEntrySchema` derives a discriminated union so each variant only carries its own template's fields.

```typescript
const pageSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  {
    name: 'sections',
    type: 'block',
    templates: [
      { name: 'hero', label: 'Hero', fields: [{ name: 'headline', type: 'string' }] },
      { name: 'cta', label: 'CTA', fields: [{ name: 'ctaText', type: 'string' }] },
    ],
  },
])

type Page = TypeFromEntrySchema<typeof pageSchema>
// Page['sections'] is:
//   Array<{ template: 'hero'; value: { headline: string } }
//        | { template: 'cta';  value: { ctaText: string } }>
```

**Reusing templates across schemas with `defineBlockTemplate()`**

`defineBlockTemplate()` (exported from `canopycms`) lets you define a block template **once** and drop the same const into multiple schemas' `templates` arrays, while still deriving precise per-variant types. It is an identity function whose only job is to preserve the literal types (`const` inference) so `TypeFromEntrySchema` can narrow each variant.

```typescript
import { defineBlockTemplate, defineEntrySchema } from 'canopycms'

const heroBlock = defineBlockTemplate({
  name: 'hero',
  label: 'Hero',
  fields: [
    { name: 'headline', type: 'string' },
    { name: 'body', type: 'markdown' },
  ],
})

const ctaBlock = defineBlockTemplate({
  name: 'cta',
  label: 'CTA',
  fields: [
    { name: 'title', type: 'string' },
    { name: 'ctaText', type: 'string' },
  ],
})

// Reuse the same consts in any schema's `block` field:
const postSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  { name: 'blocks', type: 'block', templates: [heroBlock, ctaBlock] },
])
```

**Why:** defining templates inline works, but `defineBlockTemplate()` avoids copy-pasting the same section shape into every schema (and the type drift that causes). Narrow a single variant with `Extract`:

```typescript
type Block = TypeFromEntrySchema<typeof postSchema>['blocks'][number]
type HeroBlock = Extract<Block, { template: 'hero' }>
// HeroBlock['value'] is { headline: string; body: string }
```

See `apps/example1/app/schemas.ts` for the `heroBlock`/`ctaBlock` consts reused in `postSchema`'s `blocks` field, and `packages/canopycms/src/entry-schema.test.ts` for type-level tests of block narrowing.

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

## Working with Assets

CanopyCMS's asset system (image/file upload, storage, and on-demand transforms) lives under `src/assets/`. Contributors touching this area will encounter several new dependencies: `sharp` (image transforms), `file-type` + `image-size` (sniffing/dimensions during finalize), `sanitize-html` (SVG sanitization), `content-disposition` (download headers), `@aws-sdk/client-s3` + `@aws-sdk/s3-presigned-post` (S3 store + presigned uploads), and on the editor side `@mantine/dropzone` (pinned to the exact Mantine core version already in use) plus `react-easy-crop` (crop UI).

### Transform Engine: Shared Between Dev and Prod

The on-demand image transform pipeline (`/assets/t/{directives}/{hash32}/{slug}.{ext}`) is deliberately split into two files so the same logic can be reused unchanged between dev-mode emulation and the prod CDK Lambda:

| File                             | What it is                                                                                                                                                                 | Who imports it                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `assets/transform-directives.ts` | Pure, dependency-free parser/formatter for the directive syntax (`w=`, `f=`, `q=`, `c=`). No imports at all, not even other files in `assets/` -- safe for client bundles. | Editor/client code, `assets/asset-url.ts`, `assets/transform.ts`, the transform Lambda |
| `assets/transform.ts`            | The actual sharp-based pipeline (`applyTransform`). Server-only.                                                                                                           | `api/assets.ts`'s dev-mode lazy-transform route, the transform Lambda                  |

Both the dev-mode `/assets/t/*` route (`serveLazyTransform` in `packages/canopycms/src/api/assets.ts`) and the prod CDK transform Lambda (`packages/canopycms-cdk/lambda/asset-transform/handler.ts`, which imports `parseTransformPath`/`formatDirectives`/`applyTransform` via the `canopycms/server` re-exports) call into these same two files for the actual parsing and pixel work. **Never reimplement directive parsing or the sharp pipeline in just one place** -- change behavior in `transform-directives.ts`/`transform.ts` and both dev and prod pick it up automatically.

Both of these paths surface a `TransformRejection` with a real HTTP status (`400` unsupported input, `413` output too large, `422` decode failure) -- always forward `transformed.status` verbatim rather than flattening every rejection to one code (e.g. a blanket 422 or 502). A client-input error reported as a server error, or vice versa, is a bug: `handler.test.ts` and `assets.test.ts` both assert 400/413/422 pass-through for exactly this reason.

### Finalize Decode Validation: Fail Open on No Decoder, Fail Closed on a Real Rejection

`pipeline.ts`'s `runFinalizePipeline` forces a real pixel decode for `kind === 'raster'` uploads (`rasterIsDecodable`), not just the header-only sniff `file-type`/`image-size` already do. This closes the "accepted at upload, unrenderable forever" gap: a PNG with a valid IHDR but a corrupt IDAT used to sail through finalize (header-only checks can't see it) and only fail later at `applyTransform`/render time, by which point it already looked like a successful upload.

Two things about this check are worth knowing before touching it:

- **A `.resize()` to a tiny throwaway output, not `.metadata()`.** `metadata()` only reads header fields -- the exact class of check that misses a corrupt IDAT. Forcing a real (if tiny) decode is what actually exercises libvips's decoder.
- **`sharp` is loaded with a dynamic `await import('sharp')`, not `transform.ts`'s static `import sharp from 'sharp'`.** This is deliberate: if the native binary can't load in some environment (wrong platform/arch), a static import would throw at module load and take down finalize entirely. The dynamic import lets `pipeline.ts` catch that specific failure and **fail open** (log a warning, skip validation, let the upload through -- same as pre-fix behavior) -- but only for "no decoder available." If sharp loads fine and its decoder rejects the bytes, that's a real fact about the file, and the pipeline **fails closed** (422, generic user-facing message, never the raw libvips string). Keep that split explicit if you touch this function -- don't let "sharp failed to import" and "sharp decoded and said no" collapse into the same branch.

Test fixtures for this area must be genuinely sharp-decodable, not the hand-built header-only base64 constants that used to live in `pipeline.test.ts`. Build fixtures with `sharp({ create: {...} })` (see `transform.test.ts`'s `makePng` or `pipeline.test.ts`'s local copy) rather than hand-crafted bytes -- a header-only fixture will now be correctly rejected by `rasterIsDecodable`, so it can no longer stand in for "a valid raster." `pipeline.test.ts` keeps exactly one deliberately-corrupt fixture (`makeCorruptPng`, built by flipping bytes well past the fixed-offset header fields) for the rejection test itself; the fail-open path (sharp unavailable) is covered separately in `pipeline.sharp-unavailable.test.ts`, which mocks the `sharp` module -- kept out of `pipeline.test.ts` because that file's own fixtures need the real thing.

### Client-Bundle Safety for Assets

Editor/client code may import **only** the dependency-free isomorphic modules -- `assets/transform-directives` and `assets/asset-url` -- or `import type` from `assets/types`. It must never import the stores (`store-local.ts`, `store-s3.ts`), the upload/finalize pipeline (`pipeline.ts`, `finalize.ts`), or `transform.ts` -- all of those pull in server-only dependencies (`sharp`, `node:crypto`, the S3 SDK) that must never ship to a browser bundle.

```typescript
// OK in editor/client code (see packages/canopycms/src/editor/fields/ImageField.tsx)
import { assetUrl } from '../../assets/asset-url'
import type { CropRect } from '../../assets/transform-directives'

// NOT OK from client code -- pulls in sharp / node:crypto / the S3 SDK
// import { applyTransform } from '../../assets/transform'
// import { LocalAssetStore } from '../../assets/store-local'
```

Imports of node built-ins reachable from `canopycms/client` are caught by `pnpm lint:bundle` (see [Client-Bundle Boundary Check](#client-bundle-boundary-check)). That check does not follow into `node_modules`, so pulling in `sharp` or the S3 SDK from client code is still on you to avoid -- when adding a new client-facing asset feature, double-check which file you're importing from before assuming it's safe for the browser bundle.

### Dev Gotcha: Adopter Apps Run Against Built `dist/`

`apps/example1` (and any adopter app) consumes `canopycms` and `canopycms-next` from their built `dist/` output, not from `src/`. After changing package source under `packages/canopycms/src/` or `packages/canopycms-next/src/`, rebuild before the adopter dev server will pick up the change:

```bash
pnpm --filter canopycms build
pnpm --filter canopycms-next build
```

Skipping this is a common way to end up debugging behavior that looks broken but is actually just stale compiled output -- for example, a missing `/assets/*` rewrite (added by `withCanopy()` in `canopycms-next/src/with-canopy.ts`) that silently doesn't show up because the adopter app is still running against the previously-built `dist/`.

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

5. **Concurrency-Safe Writes:** Permissions and groups files are written through a **mutate-callback** contract -- `mutatePermissionsFile`/`mutateGroupsFile` (`authorization/`), built on `authorization/settings-file-store.ts`'s `mutateSettingsJsonFile` -- rather than a plain `save*()` function. This closes the load -> compare -> write TOCTOU window under the layered lock + OCC stack described in [docs/concurrency.md](docs/concurrency.md). The old hand-rolled `contentVersion` field is gone; the OCC `version` field is now the single counter. Your `mutate` callback receives the freshly-loaded file and its current `version`, and **must be safe to call more than once** -- it re-runs against freshly reloaded state on every OCC retry attempt. Throw `SettingsVersionConflictError` from inside the callback when an app-level `expectedContentVersion` doesn't match; the API translates that to a 409.

6. **Cross-Process Workspace Locking:** Separately from the per-file write locking in item 5, `SettingsWorkspaceManager` uses two layers of locking for safe concurrent _workspace provisioning_ on shared filesystems like EFS:
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

// 1. Get settings branch name from deploymentName config
const settingsBranchName = `canopycms-settings-${config.deploymentName}`
const settingsRoot = getBranchRoot(settingsBranchName)

// 2. mutatePermissionsFile runs load -> mutate -> write atomically under the
// cross-host layered lock (see docs/concurrency.md) -- no separate pre-read,
// so there's no TOCTOU window between the version check and the write. The
// callback must be safe to call more than once (re-run on every OCC retry).
await mutatePermissionsFile(settingsRoot, mode, (currentFile, version) => {
  if (expectedContentVersion !== undefined && expectedContentVersion !== version) {
    throw new SettingsVersionConflictError()
  }

  return {
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
    pathPermissions: permissions,
  }
})

// 3. commitToSettingsBranch handles commit + push + PR (dual-path), OUTSIDE
// the write lock -- git I/O is comparatively slow, see settings-file-store.ts
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

### Schema Mutations (`SchemaOps`)

`SchemaOps` (`schema/schema-store.ts`) is the CRUD layer behind the schema-editing API (`api/schema.ts`): create/update/delete collections, add/update/remove entry types, reorder. All of its public mutators run under a single **non-reentrant, coarse per-branch lock** (`withSchemaLock`, keyed on `{branchRoot}/.canopy-meta/schema`). See [docs/concurrency.md](docs/concurrency.md) for why `.collection.json` deliberately carries no OCC `version`/lockfile of its own (it's an adopter-visible, git-committed file that rebases rewrite wholesale).

**Gotcha:** because the lock is non-reentrant, a public mutator must never call _another_ public mutator from inside its own `withSchemaLock` critical section -- that deadlocks waiting on a lock it already holds. Each public mutator (`createCollection`, `updateCollection`, `deleteCollection`, `addEntryType`, ...) has a private `*Inner` counterpart (`createCollectionInner`, `updateCollectionInner`, ...) that does the real work _without_ acquiring the lock. When one mutation needs another's logic, call the `*Inner` method directly:

```typescript
// Inside SchemaOps -- already holding the lock via the public entrypoint.
// updateOrderInner reuses updateCollectionInner for non-root collections:
private async updateOrderInner(collectionPath: LogicalPath, order: string[]): Promise<void> {
  // ...
  await this.updateCollectionInner(collectionPath, { order }) // safe: no lock acquisition

  // NEVER do this instead -- re-enters withSchemaLock and deadlocks:
  // await this.updateCollection(collectionPath, { order })
}
```

When adding a new mutator, follow the existing pattern: a thin public method that wraps the real logic in `withSchemaLock` and invalidates the schema cache afterward (outside the lock, per `withSchemaLock`'s doc comment), plus a private `*Inner` method other mutators can call directly.

### Dev Content Sync (`dev.contentSync`)

In dev mode, the editor and dev server read content from a branch clone under `.canopy-dev/content-branches/<branch>/`, while the static build reads the working tree directly. When you edit working-tree `content/**` outside the editor, the dev server keeps serving the stale clone — the long-standing **"build fine, dev blank"** staleness trap.

The `dev.contentSync` config field (in `CanopyConfig`, `DevContentSyncMode`) controls how this divergence is handled. It is dev-mode only (ignored when `mode !== 'dev'`):

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  mode: 'dev',
  dev: {
    contentSync: 'warn', // 'off' | 'warn'  (default: 'warn')
  },
})
```

| Mode               | Behavior                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `'warn'` (default) | On startup and on `content/**` changes, logs a warning naming the diverged files so the staleness is visible |
| `'off'`            | No watcher, no warnings                                                                                      |

The warning tells you to run `npx canopycms sync push` to update the clone (see [CLI (`canopycms sync`)](#cli-canopycms-sync)). Choose `'off'` for unit-test configs or when you only ever edit through the editor.

**There is intentionally no auto-push mode.** Auto-overwriting the branch clone from the working tree would silently clobber uncommitted editor "Save" state in the clone, with no Canopy-level recovery path for the editor. Reconcile divergence explicitly via `canopycms sync push` (which has interactive conflict handling) rather than letting a watcher do it for you.

**Implementation:** all logic lives in the core watcher `src/dev-content-watcher.ts` (`startDevContentWatcher()`); framework adapters just call it once at dev startup (see the Next wiring in `packages/canopycms-next/src/context-wrapper.ts`). The watcher is a no-op when not in dev mode, when mode is `'off'`, or when the working-tree content directory does not exist. On each check it re-resolves the active branch (so it follows git-HEAD branch switches) and dedupes across HMR reloads so dev restarts don't double-warn.

### Committing and Pushing: Toolchain Gotchas

Two things that bite in a scratch worktree or any non-interactive shell, where `pnpm`
resolves only through a `corepack` shim rather than being on the ambient `PATH`:

- **The husky `pre-push` hook shells out to a bare `pnpm`, so `git push` fails with
  `pre-push script failed (code 127)`** — not a push or auth error, a
  `pnpm: command not found` inside the hook. Hooks do not see aliases or shell
  functions; the shim directory has to be exported on `PATH` in the _same_ command as
  the push. The same applies to `lint-staged` on `pre-commit`.
- **`prettier --write` silently skips `.claude/future-tasks/*.md`** — they are
  prettier-ignored. Prettier reports only the files it actually formatted, so passing a
  task file and seeing no mention of it is a skip, not a no-op-because-clean. The
  "run prettier on touched files" step therefore never covers task-file formatting;
  match the surrounding style by hand.

## Testing

### Test Coverage

The codebase maintains high test coverage (1260+ tests, 98%+ coverage):

| Test Type         | Location                                 | Purpose                                          |
| ----------------- | ---------------------------------------- | ------------------------------------------------ |
| Unit tests        | `src/**/__tests__/*.test.ts`             | Test individual functions/modules                |
| Component tests   | `src/editor/**/*.test.tsx`               | Test React components with jsdom                 |
| Integration tests | `src/__integration__/**/*.test.ts`       | Test complete workflows                          |
| Type-level tests  | `src/**/*.test.ts` (with `expectTypeOf`) | Verify TypeScript type inference at compile time |

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

`packages/canopycms/vitest.config.ts` defines two vitest projects: `node` (everything
outside `src/editor/**`, run under the `node` environment) and `editor` (jsdom, for
React component tests). Git-heavy integration suites (`git-manager.test.ts`,
`branch-workspace`-style tests, `role-permissions.test.ts`, and similar) spawn real
`git` subprocesses per test, which is slow on macOS (process-spawn overhead is much
higher there than on Linux). The `node` project's `testTimeout` is raised to 30s to
absorb that on slower/loaded local machines; the `editor` project intentionally keeps
the default 5s timeout since jsdom component tests don't shell out to git and a longer
timeout there would just mask real hangs. CI runs on ubuntu and is fast enough that this
headroom isn't needed there, but CI remains the source of truth for any timing-sensitive
test behavior -- don't tune assertions to make a slow local run pass if CI already
passes.

The `editor` project loads `src/editor/test-setup.ts` first, which shims the browser
APIs jsdom lacks but Mantine expects: `matchMedia`, `ResizeObserver`, and
`Element.prototype.scrollIntoView`. Add a shim there when a Mantine component reaches
for another one. The `scrollIntoView` case is worth knowing about because of how it
fails: Mantine's Combobox (`Select`, `Autocomplete`, ...) calls it from a timer that
fires _after_ the test which opened the dropdown has finished, so a missing shim
surfaces as a Vitest "Unhandled Error" attributed to whichever test happened to run
next -- and Vitest warns that such errors can cause false positives elsewhere in the
run. If you see an unhandled error blamed on a test that plainly can't have caused it,
suspect a missing jsdom shim in the test that ran before it.

`test-setup.ts` also registers React Testing Library's `cleanup()` in an `afterEach`,
and that registration has to be explicit here. RTL normally installs its own automatic
cleanup, but only when it finds a **global** `afterEach` -- and this package runs vitest
with `globals: false`, so that global does not exist and RTL's auto-registration
silently no-ops. Importing `afterEach` from `vitest` in the setup file is what makes it
real. Two things follow for contributors:

- **Every test starts without the previous test's rendered trees.** `cleanup()` unmounts
  the containers RTL itself mounted; nodes a test appended to `document.body` by hand
  are its own to remove. Don't write a test that depends on a tree an earlier test in
  the same file rendered; render what you need.
- **A new jsdom vitest project, or a second editor setup file, must register `cleanup()`
  too.** Nothing else will do it for you.

This is not just tidiness. Without the unmount, components stay mounted for the whole
file and their timers outlive the test: Mantine's `useTransition` cancels its pending
`setTimeout(setState)` from an unmount effect, so an un-unmounted transition can fire
after the jsdom environment is torn down and blow up inside React with
`ReferenceError: window is not defined`. That lands as exactly the kind of
misattributed "Unhandled Error" described above -- a run that exits non-zero while every
single test passes. Before this was fixed, 17 of the 53 editor test files ended with
components still mounted (252 trees in total).

### Diagnosing a Test Failure

**Attribute the failure to the base before blaming your diff.** Run the suite at the
merge-base first. One failure is expected-red locally and is not a defect:

- `src/cli/init.integration.test.ts` — 7 tests fail with `listen EPERM … tsx-501/*.pipe`.
  The sandbox blocks tsx's IPC socket. Environmental, not a repo defect — and
  **avoidable**: only the tsx _CLI_ binds that socket. The loader form runs fine
  sandboxed, so a TS subprocess spawned as `node --import tsx <file>` works where
  `node_modules/.bin/tsx <file>` dies. Verified both ways on the same file: the CLI form
  exits 1 on the EPERM, the loader form exits 0. **Any new test that spawns a TypeScript
  subprocess should use the loader form** rather than joining this expected-red set;
  converting the existing seven is a live option, not just an explanation to live with.

`canopycms-cdk` used to belong on that list and **no longer does** — treat a
`CannotFindAsset` there as a real failure. Its `test` script chains
`build:test-fixtures` (`build:worker` plus a `--skip-native` lambda build), so a fresh
worktree synthesizes fine. If you see `CannotFindAsset` anyway, the fixture build itself
broke, or `vitest` was invoked directly instead of through `pnpm test`, which skips that
step. (The root `build` is `tsc` only; the full bundles still build under `prepack`.)

**Two known intermittents**, both in `canopycms`, which pnpm runs first in dependency
topology — so a flake there delays every other package's suite:

- `MarkdownField.test.tsx` (MDXEditor mount). Triage shortcut:
  `pnpm --filter canopycms exec vitest run --project editor` is reliably green for it,
  so a MarkdownField failure in a full run **is** the known flake unless the
  editor-only project also fails. A `scrollIntoView` shim is a ruled-out cause.
- `git-manager.test.ts` — `ENOTEMPTY: … rmdir '.git/info'` in `afterEach`. `fs.rm`'s
  `force: true` suppresses ENOENT but _not_ ENOTEMPTY, so it signals a concurrent
  writer (likely a detached `git gc --auto` still running after simple-git resolved).

**Three ways a run reports success while failing.** All three fail in the dangerous
direction, so check for them explicitly:

- **An exit code read through a pipe is the pipe's.** `pnpm test 2>&1 | tail` reports
  `tail`'s 0 even when the suite failed — or when `pnpm` was never found. Capture
  `${PIPESTATUS[0]}`, or run `echo $?` on its own line.
  - **The agent-facing form is worse: the false green launders into a completion
    notification that reads as authoritative.** Run that same piped command as a
    background task and the harness reports _"completed (exit code 0)"_ — a system
    message, not something you wrote — while the suite actually died with
    `ERR_PNPM_RECURSIVE_FAIL`, or `pnpm install` died on an EPERM leaving no
    `node_modules`. Seen both ways. A piped background command's notification tells you
    nothing about the command; read the captured output before believing it.
- **A backgrounded shell does not inherit the interactive profile**, so `pnpm install`
  can no-op with "command not found" and still look like it worked. Verify
  `node_modules` actually exists afterwards.
- **When a probe's two arms agree, check they agree for the reason you think.** A
  scratch workspace missing a `packageManager` field makes corepack fetch pnpm over the
  network; behind a sandbox both arms of a comparison can fail identically for that
  reason and produce a clean, wrong answer.

**Reading CI logs.** `gh run view --log` truncates the vitest step to nothing, on green
_and_ red runs alike. The real output is only in the downloadable archive:

```bash
gh api repos/OWNER/REPO/actions/runs/RUN_ID/logs > logs.zip
# then read: "Validate, Typecheck & Test/13_Run tests.txt"
```

**"No checks reported" usually means conflicts, not an Actions outage.** `pull_request`
runs are built from the merge commit, so a conflicted PR triggers _nothing_ — no run,
no failure. Check `gh pr view <n> --json mergeable` (`CONFLICTING`/`DIRTY`) before
suspecting CI.

**...but a fresh `CONFLICTING` reading is often just stale.** The inverse trap: right
after pushing a merge, `gh pr view --json mergeable` can still report
`CONFLICTING`/`DIRTY` because GitHub has not recomputed mergeability yet — query again a
moment later and it returns `MERGEABLE`. Before acting on a `CONFLICTING` reading (least
of all re-resolving conflicts that are already resolved), confirm against local git:

```bash
git merge-base --is-ancestor origin/<base> HEAD && echo "base is merged in"
```

If that succeeds and GitHub still says `CONFLICTING`, believe git and re-query.

### End-to-End Tests (Playwright)

**Always run the e2e suite single-worker.** Use the root script, which pins it:

```bash
pnpm test:e2e                                   # playwright test --workers=1
pnpm exec playwright test branch-workflow --workers=1   # single spec: pass the flag yourself
```

The reason to be careful here is that the failure mode when you don't is actively
misleading. The whole suite shares **one** `.canopy-dev` workspace and **one** dev
server port, so two workers (or two concurrent Playwright runs on the same machine)
fight over the same git working tree. What you get back is not a recognizable
contention error -- it's dozens of failures reading:

```
Error: Failed to ensure main branch
Error: spawn git ENOENT
TypeError: fetch failed
```

Those read exactly like genuine regressions in branch provisioning or git plumbing,
which is the trap: the noise impersonates the subsystem under test. A run at
`--workers=2` produced ~135 such failures with no real defect behind any of them.
If you are touching `git-manager.ts`, `branch-workspace.ts`, or branch metadata and
the suite suddenly reports broad git breakage, **check your worker count before you
start debugging the code**.

The same constraint applies across processes, not just within one run: only one
Playwright run per machine at a time. Parallel agent sessions or a second terminal
must serialise their e2e runs, or both runs corrupt each other's workspace and both
report phantom failures. CI is unaffected -- it shards across separate runners, each
with its own workspace.

**Browser build.** Playwright pins an exact browser build per release, and having
_some_ chromium in `~/Library/Caches/ms-playwright/` is not enough -- it must be the
revision this repo's Playwright version asks for. A machine carrying only a newer
build from another project will fail before any spec runs. Install the right one
(~91 MB) after a fresh clone or a Playwright bump:

```bash
pnpm exec playwright install chromium
```

To see which revision is actually required, read `revision` for `chromium` in
`node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/browsers.json`
rather than inferring it from the `package.json` range -- the range floats, the
resolved version is what pins the build.

Specs live in `apps/test-app/e2e/tests/`, with fixtures alongside and a written
capability map in `apps/test-app/e2e/COVERAGE-MATRIX.md`.

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

### Testing Authorization Defaults (`defaultBranchAccess` / `defaultPathAccess`)

`createTestWorkspace()` defaults to a permissive `defaultBranchAccess: 'allow'` /
`defaultPathAccess: 'allow'` workspace (see `test-workspace.ts`'s
`defineCanopyTestConfig` call). That means most of the integration suite never
exercises the fail-closed defaults that `canopycms init` actually scaffolds --
a regression in the `'deny'` path could ship with every other suite green. Override
the defaults via `createTestWorkspace`'s config overrides when a test needs to
cover them:

```typescript
workspace = await createTestWorkspace(
  { schema: BLOG_SCHEMA, defaultBranchAccess: 'deny', defaultPathAccess: 'allow' },
  { internalGroups: TEST_INTERNAL_GROUPS },
)
```

See `__integration__/permissions/default-deny-branch-access.test.ts` for the full
pattern, including seeding `internalGroups` so the `admin`/`reviewer` personas hold
their reserved-group membership (an auth provider's external groups get reserved
IDs like `Admins` stripped for security, so those personas need it granted
internally).

**Gotcha: admins bypass BOTH the branch and path layers.** `isAdmin(user)`
short-circuits in `authorization/branch.ts` and `authorization/path.ts`, so an
authorization test written against the `admin` persona proves nothing about
`'deny'` defaults -- it passes identically whether the defaults are `'allow'` or
`'deny'`. Use the `editor` persona from `__integration__/test-utils/multi-user.ts`
(`createMockAuthPlugin('editor')`) instead. The same trap applies outside tests:
`canopycms-auth-dev` auto-sets `CANOPY_BOOTSTRAP_ADMIN_IDS`, so the default dev user
is an admin and manually clicking around a local dev site won't surface an
access-rule regression either.

**Gotcha: assert exact status codes, not `.not.toBe(403)`.** A loose exclusion like
that passes on a 404 from a wrong route just as readily as on a correct 200/403. A
test in `default-deny-branch-access.test.ts` did exactly this -- it posted to
`/:branch/status` instead of `/:branch/submit`, 404'd, and passed both with and
without the fix it was meant to cover. Assert the specific status you expect
(`expect(res.status).toBe(200)`).

**When adding an authorization grant, verify the negative:** temporarily remove the
grant and confirm the new test actually fails before restoring it. Restore from a
scratchpad copy of the file (`cp /path/to/scratchpad-copy.ts src/path/to/file.ts`),
never `git checkout -- <file>` -- that discards any other uncommitted work in the
file, not just your temporary edit.

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

### Testing Settings Mutation Handlers (`createMockSettingsMutation`)

Handlers for the permissions/groups APIs (`api/permissions.ts`, `api/groups.ts`) call `mutatePermissionsFile`/`mutateGroupsFile` -- a mutate-callback contract on top of `authorization/settings-file-store.ts`'s `mutateSettingsJsonFile` (see [docs/concurrency.md](docs/concurrency.md)) -- rather than a plain `save*()` function. `createMockSettingsMutation()` from `test-utils/api-test-helpers.ts` mirrors that contract closely enough for handler-level tests: it invokes your real mutator callback against a configured `currentFile`/version, captures whatever payload the callback returns, and lets anything the callback throws (`SettingsVersionConflictError`, a groups validation error, ...) propagate untouched -- exactly like the real implementation.

```typescript
import { createMockSettingsMutation } from '../test-utils/api-test-helpers'
import * as permissionsLoader from '../authorization'

const settingsMutation = createMockSettingsMutation({ currentFile: null })
vi.mocked(permissionsLoader.mutatePermissionsFile).mockImplementation(
  settingsMutation.impl as typeof permissionsLoader.mutatePermissionsFile,
)

const result = await updatePermissions(mockContext, req, { permissions: newPermissions })

expect(result.ok).toBe(true)
expect(settingsMutation.getPayload()).toMatchObject({
  updatedBy: 'admin-1',
  pathPermissions: newPermissions,
})
```

**Does NOT model lock contention.** For a "settings are busy" (`SettingsFileConflictError`) test case, mock the rejection directly instead of going through the mutation helper:

```typescript
vi.mocked(permissionsLoader.mutatePermissionsFile).mockRejectedValueOnce(
  new SettingsFileConflictError(),
)
```

See `api/permissions.test.ts` and `api/groups.test.ts` for further examples.

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

### Testing Editor Hooks (SWR Cache Isolation, Strict Mode, Direct-Import Mocks)

`createApiClientWrapper(mockClient)` (from `src/editor/hooks/__test__/test-utils.tsx`) wraps the test tree in both `ApiClientProvider` and an `SWRConfig` with an isolated cache (`provider: () => new Map()`, `dedupingInterval: 2000` to match production). This is transparent to existing call sites -- no changes needed. It matters because hooks that read via SWR (`useBranchManager`, `useEntryManager`, `useCommentSystem`, and the `useBranchesData`/`useEntriesData`/`useCommentsData` hooks underneath them) key their cache entries by resource/branch (e.g. `"canopy:branches"`, `"canopy:entries:main"`). Without a fresh `Map` per wrapper instance, tests in the same file/worker would share SWR's real global cache and one test could see another's mocked response on those keys.

**Testing dedup/Strict Mode regressions:** use `createStrictModeApiClientWrapper(mockClient)`, which additionally wraps the tree in `<React.StrictMode>` (mount -> cleanup -> remount, doubling effects in dev). Without SWR's request coalescing, each manager hook's fetch-on-load effect fired twice under Strict Mode -- this wrapper is how you write a regression test for that:

```typescript
const mockClient = await setupMockApiClient()
const wrapper = createStrictModeApiClientWrapper(mockClient)
renderHook(() => useEntryManager(/* ... */), { wrapper })

await waitFor(() => expect(mockClient.entries.list).toHaveBeenCalledTimes(1))
```

See the "mounting under Strict Mode issues one X request, not two" tests in `useEntryManager.test.ts`, `useBranchManager.test.tsx`, and `useCommentSystem.test.ts`.

**Mocking `createApiClient()` for direct-call code:** most editor hooks/components get their API client via `useApiClient()` context (DI), so mocking the `'../api'` barrel is enough. Code that calls `createApiClient()` directly instead -- bypassing context, e.g. `useReferenceResolution.ts`'s dependency chain through `client-reference-resolver.ts`, and `ReferenceField.tsx` -- must mock the exact module it imports from, not the barrel:

```typescript
vi.mock('../api/client', () => ({
  createApiClient: vi.fn(),
}))
```

Use the relative specifier from the test file's own location (e.g. `'../../api/client'` from a deeper file) -- mocking `'../api'` won't intercept a direct `createApiClient` call. See `useReferenceResolution.test.ts`, `ReferenceField.test.tsx`, and `client-reference-resolver.test.ts` for the pattern.

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

### Asset Store Parity Testing

`LocalAssetStore` and `S3AssetStore` must behave identically for anything that's part of the `AssetStore` contract (staging, originals, meta sidecars, public objects, paginated listing). Rather than writing separate assertions per adapter, `packages/canopycms/src/assets/store-parity.test.ts` defines **one shared behavior suite** and runs it against both:

```typescript
function runParitySuite(label: string, setup: () => Harness | Promise<Harness>) {
  describe(`AssetStore parity: ${label}`, () => {
    // ... shared it() blocks: round-trips staging write/read/delete,
    // putOriginal/readOriginal, putMetaIfAbsent races, listMeta pagination, etc.
  })
}

runParitySuite('LocalAssetStore', async () => ({
  store: new LocalAssetStore({ root: await fs.mkdtemp(...) }),
  assertsNewestFirst: true,
}))

runParitySuite('S3AssetStore', () => ({
  store: new S3AssetStore({ bucket: 'test-bucket', region: 'us-east-1' }),
  assertsNewestFirst: false, // S3's ListObjectsV2-backed listing gives no ordering guarantee
}))
```

**LocalAssetStore** runs against a real temp directory (`fs.mkdtemp`), same as other filesystem-backed tests in this codebase.

**S3AssetStore** runs against [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock) plus a small in-memory fake (`installS3Fake()` in the same file) that actually stores bytes in a `Map`, so round-trip reads return real data instead of a canned mocked value:

```typescript
import { mockClient } from 'aws-sdk-client-mock'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const s3Mock = mockClient(S3Client)
const objects = new Map<string, { body: Uint8Array; contentType?: string }>()

s3Mock.on(PutObjectCommand).callsFake((input) => {
  objects.set(input.Key, { body: toBytes(input.Body), contentType: input.ContentType })
  return {}
})
s3Mock.on(GetObjectCommand).callsFake((input) => {
  const obj = objects.get(input.Key)
  if (!obj) throw makeAwsError('NoSuchKey', 404, 'The specified key does not exist.')
  return {
    Body: sdkStreamMixin(Readable.from(Buffer.from(obj.body))),
    ContentType: obj.contentType,
  }
})
```

A `Harness` carries an `assertsNewestFirst` flag because `LocalAssetStore` guarantees `listMeta` ordering but S3's `ListObjectsV2`-backed implementation does not -- a shared test that depends on ordering is skipped for the adapter that doesn't guarantee it, rather than being split into an adapter-specific test file.

**Why this pattern:** adapter-specific test files only prove each adapter is internally consistent with itself -- they can't catch the two implementations silently drifting apart on edge cases (error shapes, precondition semantics, metadata field names). Running the identical suite against both catches drift immediately. **When you touch the `AssetStore` contract** (add a method, change an error case, change what a read returns), add the assertion to the shared suite in `store-parity.test.ts` rather than to one adapter's test file only.

### Testing postMessage Listeners (Framed-Window Simulation)

The preview-bridge listeners validate both `event.origin` and `event.source === window.parent`, so jsdom tests can't just dispatch a bare `MessageEvent` — the source check needs a genuine `WindowProxy` distinct from the test window. Use the `simulateFramed()` pattern from `src/editor/preview-bridge.test.tsx`:

```typescript
const simulateFramed = () => {
  const host = document.createElement('iframe') // Real iframe → real WindowProxy
  document.body.appendChild(host)
  const parentWin = host.contentWindow as Window
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parentWin })
  vi.spyOn(parentWin, 'postMessage').mockImplementation(() => {})
  return parentWin
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'parent', { configurable: true, get: () => window }) // Restore
  document.querySelectorAll('iframe').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

// Dispatch with explicit origin AND source — both are validated
const event = new MessageEvent('message', {
  data: { type: CANOPY_PREVIEW_UPDATE /* ... */ },
  origin: window.location.origin,
  source: parentWin,
})
```

**Why this pattern:** `window.parent` is read-only in jsdom, so it must be redefined via `Object.defineProperty` (and restored in `afterEach`). Faking the source with a plain object fails the `WindowProxy` identity check; appending a real `<iframe>` and using its `contentWindow` gives the listener an authentic parent window to compare against. Tests that omit `source` (or pass the wrong window) double as negative tests for the trust check.

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

**`mockConsole()` is mandatory, and only CI enforces it.** `vitest.config.ts`'s
`onConsoleLog` **throws on _any_ console output Vitest intercepts** — `log` and `info`
just as much as `warn` and `error`, with no method filter — but the throwing path only
fires under `CI=true`. Locally the same test prints the output as harmless noise and the
suite reports green. So a stray `console.log` left in from debugging fails CI exactly as
hard as an unasserted error. (Vitest's `type` argument is the _stream_, `'stdout'` or
`'stderr'`, not the console method, so the thrown message reads
`A test wrote to console.stdout` — that is this hook firing, not a real `console.stdout`
call.)

The failure mode this produces is nasty: a test that deliberately exercises a logged
error path passes locally, then in CI the throw surfaces as an _unhandled rejection_
that takes the whole test step down with **no vitest output at all** — which reads as
a crashed or OOM-killed process, not a test failure. This cost two people time on
2026-08-12 before the cause was found.

Reproduce it locally before pushing any test that triggers an error handler:

```bash
CI=true pnpm exec vitest run          # from packages/canopycms
```

Assert the captured output rather than merely silencing it — a test that swallows the
error it provoked has traded a visible failure for an invisible one.

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

**Enforced in CI (keep the reporter "all dots"):** the Vitest `dot` reporter
prints an intercepted `stdout | <file> > <test>` / `stderr | ...` block for any
test that writes to the console, which makes it hard to tell expected output
from real problems at a glance. To stop that from creeping back in, an
`onConsoleLog` hook in [`packages/canopycms/vitest.config.ts`](packages/canopycms/vitest.config.ts)
throws when a test logs to the console **while `CI` is set** (GitHub Actions sets
`CI=true`, so the existing `pnpm test` step enforces it — no extra workflow
step). Locally the log passes through unchanged, so ad-hoc `console.log`
debugging still works. When CI fails with this error, wrap the expected output
in `mockConsole()` (swallow + assert) as shown above, or remove the stray log —
do **not** silence the guard.

### Testing GC-Dependent Code Deterministically (`WeakRef`/`FinalizationRegistry`)

Code that prunes dead `WeakRef`s or registers a `FinalizationRegistry` callback can't be exercised by waiting for real garbage collection in a test -- GC timing is non-deterministic. `src/content-index-registry.test.ts` stubs the globals instead, so the pruning logic runs on command:

**`WeakRef`: stub the global, since the module reads it fresh on every call**

```typescript
class FakeWeakRef<T extends object> {
  static deadTargets = new Set<object>()
  constructor(private readonly target: T) {}
  deref(): T | undefined {
    return FakeWeakRef.deadTargets.has(this.target) ? undefined : this.target
  }
}

afterEach(() => vi.unstubAllGlobals())

it('skips a dead ref', () => {
  vi.stubGlobal('WeakRef', FakeWeakRef)
  // ... register targets, then mark one dead via FakeWeakRef.deadTargets.add(target)
})
```

This works because the production code calls `new WeakRef(target)` via a bare global reference resolved at call time -- stubbing before the call is enough, no module reload needed.

**`FinalizationRegistry`: stub the global AND force a fresh module instance**

If the production module captures the constructor at module-load time (`const finalization = new FinalizationRegistry(cb)`), stubbing the global after that module has already loaded has no effect on the existing instance. Combine `vi.stubGlobal()` with `vi.resetModules()` and a dynamic re-import so the fresh module wires up the fake:

```typescript
class FakeFinalizationRegistry<T> {
  constructor(cb: (heldValue: T) => void) {
    capturedCallback = cb
  }
  register(_target: object, heldValue: T): void {
    capturedHeldValue = heldValue
  }
  unregister(): boolean {
    return true
  }
}

vi.stubGlobal('FinalizationRegistry', FakeFinalizationRegistry)
vi.resetModules()

try {
  const fresh = await import('./content-index-registry')
  fresh.registerContentIndexForInvalidation(root, target)
  // capturedCallback/capturedHeldValue now hold what the engine would pass on real GC
  capturedCallback?.(capturedHeldValue) // Simulate the engine deciding to collect `target`
} finally {
  vi.resetModules() // Restore the real module for subsequent tests
}
```

**Why this matters:** without `vi.resetModules()`, the already-loaded module keeps its reference to the _real_ `FinalizationRegistry` constructor, so `vi.stubGlobal()` alone silently does nothing for module-load-time captures -- the test would pass for the wrong reason (or not exercise the finalizer path at all).

### Type-Level Testing with `expectTypeOf`

Vitest includes a built-in `expectTypeOf` utility for compile-time type assertions. Use it to verify that TypeScript infers the correct types from schema definitions, generics, or utility types -- without executing any runtime code.

**Import from vitest:**

```typescript
import { describe, it, expectTypeOf } from 'vitest'
```

**Basic usage:**

```typescript
it('infers the correct content type from a schema', () => {
  const schema = defineEntrySchema([
    { name: 'title', type: 'string' },
    { name: 'body', type: 'markdown' },
  ])

  type Content = TypeFromEntrySchema<typeof schema>

  // Verify exact type shape
  expectTypeOf<Content>().toEqualTypeOf<{ title: string; body: string }>()
})
```

**Testing discriminated unions:**

```typescript
it('produces a discriminated union for block fields', () => {
  const schema = defineEntrySchema([
    {
      name: 'blocks',
      type: 'block',
      templates: [
        { name: 'hero', label: 'Hero', fields: [{ name: 'headline', type: 'string' }] },
        { name: 'cta', label: 'CTA', fields: [{ name: 'ctaText', type: 'string' }] },
      ],
    },
  ])

  type Content = TypeFromEntrySchema<typeof schema>
  type Block = Content['blocks'][number]
  type HeroBlock = Extract<Block, { template: 'hero' }>

  // Each variant only has its own template's fields
  expectTypeOf<HeroBlock['value']>().toEqualTypeOf<{ headline: string }>()

  // Template narrows to a literal, not a union
  expectTypeOf<HeroBlock['template']>().toEqualTypeOf<'hero'>()

  void schema // Prevent unused-variable lint error
})
```

**Key matchers:**

| Matcher                           | Purpose                                               |
| --------------------------------- | ----------------------------------------------------- |
| `.toEqualTypeOf<T>()`             | Exact type match (strictest)                          |
| `.toMatchTypeOf<T>()`             | Target is assignable to expected (allows extra props) |
| `.toBeString()` / `.toBeNumber()` | Primitive type checks                                 |
| `.toBeNullable()`                 | Type includes `null` or `undefined`                   |

**When to use type-level tests:**

- Verifying that generic utility types (like `TypeFromEntrySchema`) produce correct output
- Ensuring discriminated unions narrow properly (block templates, field types)
- Catching regressions in type inference when schema definitions change
- Testing that resolved references carry the correct type through generics

**Important:** During regular `vitest run`, `expectTypeOf` calls execute as runtime no-ops -- the actual type checking happens via `tsc --noEmit` (which includes test files). With `vitest --typecheck`, vitest itself runs the TypeScript checker. The `void schema` pattern prevents TypeScript's unused-variable error for schemas that exist solely to drive type inference.

See `packages/canopycms/src/entry-schema.test.ts` for the complete example.

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

### Shelling Out to Real Builds (CI Fixture Pattern)

`apps/dual-build-fixture/dual-build.test.ts` is a vitest suite that verifies CanopyCMS's two deploy shapes (README.md "Dual-Build Sites") by actually running `next build` twice -- once per `CANOPY_BUILD` flavor (`static`, `cms`) -- against a minimal fixture app, then asserting on the real build output rather than just exit codes. It runs as its own CI job (`dual-build` in `.github/workflows/ci.yml`), gated on a paths-filter so the two (expensive) builds only run when something able to break the split actually changed. Run it locally with:

```bash
pnpm --filter canopycms-dual-build-fixture run verify:dual-build
```

Read the file in full before extending it or writing a similar "shell out to a real build, inspect output" test elsewhere -- it packs several fixed bugs worth reusing rather than reintroducing:

- **Run the expensive step once, assert many times.** Both `next build` invocations run once in `beforeAll` (each takes tens of seconds); every `it()` afterward only inspects the resulting file trees. Never re-run a build per-assertion.
- **Relocate output when two flavors share one `.next/`.** Both flavors write to the same `.next/` directory, so `moveNextOutputAside()` relocates the static build's non-cache output to `.next-static/` before the cms build starts, leaving both inspectable afterward. `.next/cache` (the SWC/webpack compilation cache) is deliberately left in place across both builds and preserved by `cleanNextOutputKeepCache()` -- a "clean everything under `.next/` except `cache/`" helper run before each build. This matters because `next build` isn't guaranteed to prune stale output for routes/`pageExtensions` that no longer apply: without the clean step, a leftover `.next/server/app/edit` from an earlier build could make an assertion pass for the wrong reason, while nuking the cache too would defeat CI's build-cache restore step.
- **Use a dynamically-allocated port for live-server checks, never a hardcoded one.** A live-server smoke test spawns `next start` and fetches routes to verify runtime behavior (not just build artifacts) -- e.g. that the cms build's home route renders the same content as the static build's prerendered HTML. `getFreePort()` binds to port 0 and reads back what the OS picked. A hardcoded port previously caused a real false pass here: a stale `next start` left over from a prior manual test run kept answering on that port, so the freshly-spawned (and, in that run, deliberately broken) server was never actually exercised. A fresh port per run makes that class of contamination impossible instead of relying on cleanup discipline.
- **Fail fast on child-process exit instead of polling out the full timeout.** `waitForServer()` listens for the spawned child's `exit` event and throws immediately -- surfacing the captured server log -- if the process dies before the first successful response, rather than blindly polling for the full timeout against a server that's already gone.
- **Exclude dev-mode workspace clones from test discovery.** `vitest.config.ts` excludes `.canopy-dev/**`. CanopyCMS's dev-mode branch-workspace machinery clones the whole app directory -- including the test file itself -- into `.canopy-dev/content-branches/<branch>/` the first time a request-time content read happens; without the exclude, Vitest picks up that clone as a second, broken test file (no `node_modules` of its own).

**Local-run gotcha:** the live-server test's request-time content read resolves against the last git commit (dev-mode branch-workspace resolution), not uncommitted working-tree edits. Running this test locally against WIP changes (to the fixture app or to `withCanopy()`) can make the cms server's `/` return a non-200 until you commit (or run `canopycms sync push`) -- that's expected dev-mode behavior, not a build-shape regression, and the test's own assertion message explains this inline. Read the failure message before assuming a real regression.

### Scaffold-and-Synth Verification (`canopycms-cdk/src/scaffold-synth.test.ts`)

`scaffold-synth.test.ts` verifies `canopycms init-deploy aws` end to end: it runs the real CLI into a scratch project, then executes the generated `cdk.json`'s own `app` command, and requires a CloudFormation template to come out the other end. It exists because the bug it fixes -- the generated GitHub Actions workflow deployed against a `cdk.json` that nothing had created -- was invisible to `init.test.ts`'s template-string assertions, which passed the whole time. The lesson generalizes past this one test: for generated/scaffolded output, assert on what the output _does_ (does it synth?), not on what it _contains_ (does the string look right?).

Run it locally with:

```bash
pnpm --filter canopycms-cdk run build:test-fixtures   # stages worker/dist first, see below
pnpm --filter canopycms-cdk exec vitest run src/scaffold-synth.test.ts
```

- **Why this test lives in `canopycms-cdk`, not next to the CLI it exercises.** The synth needs `aws-cdk-lib`, `constructs`, and a resolvable `canopycms-cdk` -- this is the one package where all three are guaranteed present. Scratch projects are created under `packages/canopycms-cdk/.scaffold-synth/` (gitignored) with **no `package.json` of their own**, and that omission is load-bearing: it's what lets Node's self-reference resolution find `canopycms-cdk` from the generated stack by walking up to this package's own manifest via its `exports` field. Adding a `package.json` in the scratch project would break that resolution. The scratch directory sits at the package root, never under `src/`, so a crashed run that skips cleanup can't start failing `pnpm lint`/`pnpm typecheck` with generated files -- both globs cover `src/`.
- **`CDK_OUTDIR` + `CDK_CONTEXT_JSON` are how the CDK CLI drives an app.** The first triggers auto-synth; the second delivers `cdk.json`'s `context` block. A test that runs the generated `app` command without passing the context can't catch a bad context value -- e.g. a CDKv1-only feature flag that CDKv2 rejects at synth (`UnsupportedFeatureFlag`) -- because a context-free run never reaches that code path.
- **Fails loudly, never skips, when `packages/canopycms-cdk/worker/dist` is missing.** The package's own `test` script builds it via `build:test-fixtures` first; running this file in isolation (as above) requires that step too. A skip here would restore exactly the going-green-without-checking property the test exists to remove.

## Deployment Infrastructure

### CmsWorker (canopycms/worker/cms-worker)

The `CmsWorker` class handles internet-requiring operations that Lambda cannot perform. It is cloud-agnostic and auth-agnostic:

- **Task queue processing**: Polls `.tasks/pending/` on the workspace filesystem
- **Git sync**: Fetches from GitHub into `remote.git`, rebases active branch workspaces, and pushes `canopycms-settings-*` branches to GitHub (belt-and-suspenders for the task queue -- ensures settings reach GitHub even if a task queue entry is lost)
- **Auth cache refresh**: Calls a pluggable `refreshAuthCache` callback

The worker lives in the core `canopycms` package, not in `canopycms-cdk`, because it has no cloud dependencies.

### Worker Logging: Never Call `console.*` Directly

Code under `packages/canopycms/src/worker/**` and `packages/canopycms-cdk/worker/**` must log via `workerLog` / `workerLogWarn` / `workerLogError` from `src/worker/log.ts` (re-exported from `canopycms/worker/cms-worker`, so no new package entrypoint is needed) -- never call `console.log`/`console.warn`/`console.error` directly. Elsewhere in the codebase, normal console/`mockConsole()` conventions apply unchanged; see [Expecting Console Messages](#expecting-console-messages).

```typescript
import { workerLog, workerLogWarn, workerLogError } from './log'

workerLog('CMS Worker started') // -> 2026-08-12T21:39:45.214Z INFO CMS Worker started
```

**Why it's not optional:** in production, the worker's stdout _and_ stderr both append to one file (`/var/log/canopy-worker/worker.log` on the EC2 instance), tailed by the amazon-cloudwatch-agent. The agent config (written by user-data in `packages/canopycms-cdk/src/constructs/cms-service.ts`) sets `multi_line_start_pattern` keyed on the helpers' ISO-8601 timestamp prefix, so a line missing that prefix doesn't start a new CloudWatch event -- it silently gets appended to the previous one, corrupting event boundaries rather than just looking inconsistent. The level tag (`INFO`/`WARN`/`ERROR`) is also load-bearing: it's the only way to tell the two interleaved streams apart downstream. A stray `console.log` in worker code breaks log shipping without erroring locally.

The helpers pass the timestamp and level as separate `console` arguments rather than concatenating them into the message, so passing an `Error` still prints its stack normally.

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

### Transform Lambda Bundling Without Docker

The prod on-demand transform Lambda needs `sharp`'s native binary for `linux/arm64`, but Docker-based bundling (the usual `aws-cdk-lib/aws-lambda-nodejs` approach) isn't available in this environment. `packages/canopycms-cdk/lambda/asset-transform/build.mjs` works around this:

1. `esbuild` bundles `handler.ts` into a single CJS file, leaving `sharp`/`@img/*` (native bindings) and `@aws-sdk/*` (already present in the Lambda's Node 20.x managed runtime) external.
2. `npm install sharp@<range> --os=linux --cpu=arm64 --libc=glibc` runs directly in the output directory. Since sharp >=0.33 ships its native binary as a platform-specific optional dependency, npm's `--os`/`--cpu`/`--libc` overrides fetch the linux/arm64 binary regardless of the host OS actually running the install -- this is what makes Docker unnecessary, even from a macOS dev machine.

The `sharp` version installed is read from `packages/canopycms`'s own `dependencies.sharp`, so the Lambda's bundled binary never drifts from the version the transform engine (`assets/transform.ts`) is written against -- never hardcode a version in `build.mjs`.

Run it before synth/deploy:

```bash
pnpm --filter canopycms-cdk run build:lambda
```

Output lands in `lambda/asset-transform/dist/` (gitignored); the CDK construct's `lambda.Code.fromAsset()` points there, so `cdk synth`/`deploy` fails with "Cannot find asset" if you skip this step.

### CDK Asset Verification: the Canary Stack

`packages/canopycms-cdk/canary/` is a small CDK app -- not a separate package, it imports `canopycms-cdk`'s own `../../src` directly -- that deploys a throwaway `canopy-assets-canary` stack to a sandbox AWS account (bootstrap qualifier `canopy`) to verify `AssetSupport`'s CloudFront wiring and the transform Lambda against real infrastructure: real CloudFront origin-group failover, a real S3 bucket, a real Lambda invocation. It exists for manual infra verification by contributors working on the assets deployment path -- it is not part of CI or any automated test suite:

```bash
pnpm --filter canopycms-cdk run build:lambda   # Lambda asset must exist before synth
cd packages/canopycms-cdk/canary
npx cdk synth
npx cdk deploy --profile sandbox-admin
```

The stack is created with `RemovalPolicy.DESTROY` and `autoDeleteObjects: true` -- it's meant to be deployed, checked, and torn down, not left running.

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

**Failure idiom: throw typed errors, let the entrypoint exit.** Precondition failures in `sync` and `migrate` throw typed errors (`SyncError` in `cli/sync.ts`, `MigrateError` in `cli/migrate.ts`) rather than printing warnings and exiting 0. The `main().catch` in `cli/cli.ts` converts any thrown error into `Error: <message>` on stderr plus exit code 1. When adding a new CLI precondition, throw a typed error with an actionable message — don't `console.warn` + `process.exit(0)`. **Project root resolution:** project-bound commands (`sync`, `migrate`, `worker run-once`, `generate-ai-content`) resolve the project root by walking up from cwd to the nearest `canopycms.config.ts` (`findProjectRoot()` in `cli/project-root.ts`), so they work from subdirectories and fail fast with a clear error when run outside a project.

**Commands:**

```bash
# Push working-tree content into a branch workspace (working tree → CMS)
npx canopycms sync push

# Pull content from a branch workspace (CMS → working tree)
npx canopycms sync pull

# 3-way merge: merge working-tree and editor changes, pull result back
npx canopycms sync both

# Abort a failed merge in the branch workspace
npx canopycms sync abort

# Target a specific branch workspace
npx canopycms sync push --branch my-feature

# Specify a custom content directory (default: content)
npx canopycms sync push --content-root src/content
```

**Push flow:** Copies the working tree's content directory into the branch workspace, replacing it. Uncommitted editor changes in the workspace are auto-committed to git history before overwriting, so nothing is lost. The resulting commit is tagged `canopycms-sync-base` for future 3-way merges. Uses crash-safe directory replacement (backup-rename pattern) so that if interrupted, at least one copy always exists on disk.

**Pull flow:** Copies content from a branch workspace back into the working tree's content directory. Before overwriting, detects both uncommitted changes and untracked files that would be deleted, and warns with a confirmation prompt. If multiple branch workspaces exist and `--branch` is not specified, an interactive prompt lets you choose. After pulling, review the changes with `git diff` and commit when ready.

**Both (3-way merge) flow:** Invoked via `canopycms sync both`. Uses a `canopycms-sync-base` git tag as the merge base to perform a proper 3-way merge between working-tree changes and editor changes in the workspace. If the merge produces conflicts, the workspace is left in a merge state with instructions to resolve manually, then run `canopycms sync pull` or `canopycms sync abort`.

**Abort flow:** Runs `git merge --abort` in the branch workspace to cancel a failed merge and restore the workspace to its pre-merge state.

**Security: path traversal guards.** The `--branch` and `--content-root` flags are validated with `assertWithinDir()` to prevent path traversal attacks (e.g., `--branch ../../etc`). Every resolved path is checked to ensure it stays within its expected parent directory before any file operations.

**Typical workflow:**

```bash
# 1. Edit content files directly
vim content/posts/new-post.mdx

# 2. Push changes so the CMS can see them
npx canopycms sync push

# 3. Open the CMS UI, refine content, publish

# 4. Pull the published changes back to your working tree
npx canopycms sync pull

# 5. Review and commit
git diff
git add content/
git commit -m "Update posts"

# Or use 3-way merge to handle both directions at once
npx canopycms sync both
```

## Dependency Overrides (`pnpm.overrides`)

Root `package.json` pins several transitive dependencies under `pnpm.overrides` to force in a security fix ahead of whatever version the direct dependency tree would otherwise resolve. JSON can't hold comments, so the rationale for each pin lives here — check this table before removing or loosening any of them, and re-check `pnpm why <pkg>` still resolves to a non-vulnerable version if you do.

| Override                 | Advisory                                                                      | Reason                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws@^8.20.1`             | GHSA-58qx-3vcg-4xpx (CVE-2026-45736)                                          | Uninitialized memory disclosure in `ws` before 8.20.1; pin forces the patched version.                                                                |
| `uuid@^11.1.1`           | GHSA-w5hq-g745-h8pq (CVE-2026-41907)                                          | Missing buffer bounds check in `uuid` v3/v5/v6 when a `buf` is supplied; fixed in 11.1.1.                                                             |
| `js-cookie@^3.0.7`       | GHSA-qjx8-664m-686j (CVE-2026-46625)                                          | Per-instance prototype hijack in `assign()` enables cookie-attribute injection in <=3.0.5.                                                            |
| `fast-xml-parser@^5.7.0` | GHSA-gh4j-gqv2-49f6 (CVE-2026-41650)                                          | XMLBuilder XML comment/CDATA injection via unescaped delimiters, fixed in 5.7.0.                                                                      |
| `brace-expansion@^2.0.3` | GHSA-v6h2-p8h4-qcjw (CVE-2025-5889)                                           | ReDoS in `brace-expansion`'s `expand()`; pin keeps the 2.x line above the vulnerable <=2.0.1 range.                                                   |
| `picomatch@^4.0.4`       | GHSA-c2c7-rcm5-vvqj (CVE-2026-33671) and GHSA-3v7f-55p6-f55p (CVE-2026-33672) | ReDoS via extglob quantifiers and a POSIX-character-class method-injection bug, both fixed in 4.0.4.                                                  |
| `postcss@^8.5.10`        | GHSA-qx2v-qp2m-jg93 (CVE-2026-41305)                                          | XSS via unescaped `</style>` in PostCSS's CSS stringify output, fixed in 8.5.10.                                                                      |
| `yaml@1@^1.10.3`         | GHSA-48c2-rrv3-qjmp (CVE-2026-33532)                                          | Stack overflow via deeply nested YAML collections; pins the legacy `yaml` 1.x line (still pulled in transitively) above the vulnerable <1.10.3 range. |

## Quality Checks

Before handoff, run typecheck and tests:

```bash
pnpm typecheck
pnpm test
```

### Client-Bundle Boundary Check

The editor reaches browsers through `canopycms/client` and `canopycms-next/client`. Anything reachable from those entries -- at any depth -- must stay free of node built-ins, or an adopter's production `next build` dies with `Module not found: Can't resolve 'fs'`. `next dev` tolerates the violation, so this used to surface only in the e2e production build, minutes after the mistake.

`dependency-cruiser` now enforces the reachability directly:

```bash
pnpm lint:bundle
```

It runs in CI right after ESLint, and in the pre-commit hook whenever a commit touches either package's `src/`. Config lives in [.dependency-cruiser.mjs](.dependency-cruiser.mjs). `tsPreCompilationDeps` stays off on purpose, so `import type` edges (erased at compile time) are not followed -- type-only imports of server modules remain legal. A second rule fails on unresolvable relative imports, because an import the resolver can't follow is a subtree the reachability rule can't see.

A violation prints the whole chain from the entry to the built-in, which is usually the fastest way to see where the boundary broke:

```
error client-bundle-no-node-builtins: packages/canopycms/src/client.ts → fs/promises
    packages/canopycms/src/editor/CanopyEditor.tsx →
    ...
    packages/canopycms/src/editor/hooks/useBranchManager.tsx →
    packages/canopycms/src/paths/branch.ts →
    fs/promises
```

The fix is normally to import the dependency-free sibling instead of the node-importing module -- `paths/branch-name` (not `paths/branch` or the `paths` barrel), `assets/asset-prefixes` (not `assets/keys`), `assets/transform-directives` (not `assets/transform`) -- or to make the import `import type`. If a client-reachable module genuinely needs new browser-safe logic that currently lives in a node-importing file, extract that logic into its own dependency-free module rather than widening the rule.

### Published-Package ESM Import Check

`tsc` with `moduleResolution: "Bundler"` emits extensionless relative specifiers (`from './adapter'`), which `tsc` and bundlers both tolerate but Node's native ESM resolver rejects outright (`ERR_MODULE_NOT_FOUND`). Four of five published packages shipped that way, undetected, until a real adopter hit it:

```bash
pnpm check:esm
```

This **requires a build first** -- it resolves each published package's entry points against real built `dist/` output, not `src/`. It runs in CI (`.github/workflows/ci.yml`) right after a step that builds the four non-core published packages (CI previously only built `packages/canopycms`, so nothing ever built `canopycms-next`, `canopycms-auth-clerk`, `canopycms-auth-dev`, or `canopycms-cdk` to check).

**Why it can't just `import('canopycms')` in-repo:** this is a pnpm workspace, so `node_modules/canopycms` is a symlink that resolves through the package's _dev_ `exports` field (raw `.ts`, meant for bundlers/tsx) -- never through `publishConfig.exports`, the field a real npm consumer actually gets. A naive in-repo smoke test would pass while the published tarball was broken. The guard ([scripts/check-esm-imports.mjs](scripts/check-esm-imports.mjs)) instead builds a sandbox `node_modules`, merging each package's `publishConfig` over its `package.json` (the same merge `npm publish`/`pnpm pack` perform) and pointing the result at the real built `dist/`, then imports every entry point from there under a real Node subprocess.

**Fix:** run [scripts/add-js-extensions.mjs](scripts/add-js-extensions.mjs), the shared post-build step that rewrites extensionless relative specifiers to explicit `.js` (or `/index.js` for directory specifiers). It is now wired into all five published packages' `build` scripts (`packages/canopycms` via `scripts/postbuild.mjs`; the other four inline as `tsc ... && node ../../scripts/add-js-extensions.mjs dist`). If you add a new published package, wire its `build` script the same way -- `check:esm` will fail on the omission the next time CI runs.

### Future-Tasks Backlog Check

`.claude/future-tasks/` is the durable backlog, and AGENTS.md requires every deferred issue to exist as a task file **plus** an `index.md` row. Four failure modes kept slipping through review, so they are now enforced:

```bash
pnpm lint:tasks
```

It runs in CI right after `lint:bundle`, and in the pre-commit hook whenever a commit touches `.claude/future-tasks/`. The script is [scripts/check-future-tasks.mjs](scripts/check-future-tasks.mjs) -- plain node, no dependencies. It checks:

- **Dead links** -- every `.md` link target must resolve **relative to the linking file's own directory**. This matters more than it sounds: task files cross-link with relative paths, so moving a file into `resolved/` breaks inbound links in the files that did _not_ change. Both dead links found on 2026-08-13 were relative-path errors (one missing a `../`, one carrying a stale `../`) that a repo-root-relative check would have called clean.
- **Stale open rows** -- a row in an open priority table whose file already lives in `resolved/`. The open tables claim to list open work only, and program sequencing reads them.
- **Orphans, both directions** -- a task file no `index.md` row points at, and a row pointing at a file that does not exist.
- **`[[wikilinks]]`** -- they render as literal `[[text]]` on GitHub and are invisible to the dead-link check, so they rot silently. Of the 41 present on 2026-08-13, 5 were already dead, four of them pointing at a Claude _memory_ filename rather than anything in the repo. All were converted to markdown links; this check keeps them from returning. Kebab-case slugs only, so `[[...slug]]` (Next.js catch-all routes) and `[[:space:]]` (POSIX class) stay legal in prose.

### Resolving a task: use `--fix`

Moving a file into `resolved/` invalidates relative paths in two directions at once -- links _inside_ the moved file (siblings are now one level up, repo-root docs one level further) and links _pointing at_ it (now behind `resolved/`). That churn is mechanical, and the checker already knows where the target went, so let it do the edit:

```bash
pnpm lint:tasks --fix
```

It repairs only paths whose target exists somewhere unambiguous, refuses when a basename is ambiguous across directories, and rewrites the `](target)` form specifically so a path that also appears as prose is left alone. A 2026-08-13 audit moved 9 files and needed 13 hand-edits; `--fix` reproduces all of them byte-for-byte.

Two things it deliberately will **not** fix, because both need judgment: a **stale open row** (moving it to the Resolved section usually means rewriting the summary too) and an **orphan file** (its row has to be written by whoever knows what the task is).

Only `.md` targets are checked. Task files also cite source files (`packages/canopycms/src/config.ts`) as prose written relative to the repo root, not as navigable links; checking those would be pure false positives.

When you retire a task, do all three things together or the check will tell you which you missed: `git mv` the file into `resolved/`, move its `index.md` row to the Resolved section, and fix any inbound links. One deliberate exception is documented in the backlog itself -- `program-b-final-review-followups.md` strikes findings ~~in place~~ rather than moving them, because the file still holds open work.

One limit worth knowing: the check does not follow into `node_modules`, so a server-only npm package (`sharp`, `simple-git`, the S3 SDK) imported from client code slips past it. The e2e production `next build` remains the backstop for that.

### Public re-exports: attach JSDoc at the entrypoint

When you add a new top-level public symbol re-exported from `packages/canopycms/src/server.ts` (or `index.ts`) via a named `export { X } from './module'` statement, **attach JSDoc above the re-export site too**, even if the source file already documents the original declaration. TypeScript's JSDoc propagation through `export { X } from './module'` is inconsistent across LSP versions and module-resolution modes, so adopters hovering over `import { X } from 'canopycms/server'` in VSCode can lose the documentation if it only lives on the original. Duplicating it at the re-export site is the reliable fix and the convention this codebase follows. Wildcard `export *` re-exports propagate more reliably and don't need duplication.

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
