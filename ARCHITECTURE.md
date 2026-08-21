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

- **canopycms** (core): The main library containing content store, branch management, permissions, editor UI, API handlers, AI content generation, and the asset/media store plus its on-demand image-transform engine. This package is framework-agnostic and contains all business logic. It exposes multiple entrypoints: `canopycms/server` (content reading, API setup), `canopycms/client` (editor components), `canopycms/config` (configuration helpers), `canopycms/ai` (AI content route handler and generation), and `canopycms/build` (static file generation utilities). The main `canopycms` entry also exports the isomorphic `assetUrl`/`assetSrcSet` helpers so host apps can build transform URLs (see [Asset & Media System](#asset--media-system)).

- **canopycms-next**: Next.js adapter that provides thin integration (~10 lines of user extraction code). Wraps core context with React cache() for per-request memoization. Also provides a `withCanopy()` Next.js config wrapper that handles module transpilation and React deduplication (see [Framework Adapters](#framework-adapters) below).

- **canopycms-auth-clerk**: Authentication plugin using Clerk.

- **canopycms-auth-dev**: Development authentication plugin that provides a mock auth flow with configurable test users. Used for local development without requiring a real auth provider.

- **canopycms-cdk**: AWS CDK infrastructure package (not imported by the CMS runtime). It ships the constructs adopters use to provision a CanopyCMS deployment — the CMS service (Lambda + EFS), the CloudFront distribution, and the `AssetSupport` construct that wires up the asset bucket, CloudFront behaviors, and the image-transform Lambda — plus the `CmsWorker` daemon. The transform Lambda reuses the core package's transform engine verbatim, so the deployed CDN and dev mode apply identical image transformations. See [Asset & Media System](#asset--media-system) and [Deployment Architecture](#deployment-architecture).

This separation keeps the core framework-agnostic while allowing adapters to be minimal integration layers. All business logic lives in core—adapters only handle framework-specific concerns like extracting user identity from request contexts.

The core package also exposes a `canopycms/test-utils` subpath for shared test utilities (API test helpers, console spies, git test repo initialization), which spares sibling packages fragile cross-package relative imports. **This subpath is workspace-internal by design and is deliberately not published**: it appears in the dev `exports` map, but not in `publishConfig.exports`, so it resolves for other packages in this monorepo and does not exist for npm consumers.

It stays unpublished because its sources are vitest-coupled in ways that do not belong in a published package: they import `vitest` (a devDependency) at module scope, `console-spy.ts` calls `expect.extend()` as an import side effect — so merely importing the module would require a live vitest context, not just vitest installed — and it declares a global `declare module 'vitest'` augmentation that would attach CanopyCMS's custom matchers to every consumer's `Assertion` interface. The mock factories also traffic in internal types (`ApiContext`, `CanopyServices`, `BranchContext`) that are not part of the public contract. `tsconfig.build.json` accordingly excludes `src/test-utils/**` from the build.

The two halves once disagreed — `publishConfig.exports` advertised `./test-utils` while the build never emitted `dist/test-utils/`, so any external `import 'canopycms/test-utils'` failed with `ERR_MODULE_NOT_FOUND` while in-repo consumers resolved through the dev `exports` field and never noticed. That is the blind spot described under [ESM Output Must Be Node-Resolvable](#esm-output-must-be-node-resolvable-not-just-bundler-resolvable). `scripts/check-esm-imports.mjs` now enforces the invariant rather than documenting it: each subpath is declared `test`, `skip`, or `devOnly`, and its `checkCoverage()` fails if a `devOnly` subpath reappears in `publishConfig.exports`, if a published subpath goes missing from it, or if the two maps disagree in either direction.

### ESM Output Must Be Node-Resolvable, Not Just Bundler-Resolvable

Every published package declares `"type": "module"`, so every relative import in its `dist/` must carry a `.js` extension — in the emitted `.d.ts` as well as the emitted `.js`. `tsc` alone doesn't do this: with `moduleResolution: "Bundler"`, it preserves bare specifiers verbatim, which bundlers (Next, Vite) resolve happily but Node's native ESM resolver rejects outright. A build that skips the rewrite step produces a package that works for bundler-based adopters but is broken for anyone importing it directly under Node — `canopycms-cdk` is the sharpest case, since CDK apps run directly under Node with no bundler in front of them. All five published packages now run a shared rewrite step (`scripts/add-js-extensions.mjs`) as part of their build, added after this gap let four of the five packages ship broken for a period while only the core package ran it.

**The `.d.ts` half fails silently, which is why it outlived the `.js` half.** A missing extension in a `.js` file throws `ERR_MODULE_NOT_FOUND` — loud, immediate, and caught by importing the built output. The same omission in a `.d.ts` throws nothing: an adopter on `moduleResolution: "node16"`/`"nodenext"` cannot resolve `export * from './x'`, and TypeScript's recovery is to type the entire import as `any`. Their build stays **green** while every type this package exports quietly degrades to `any`, and with `skipLibCheck: true` — what most scaffolds set, Next.js included — there is not even a diagnostic to notice. Both states were reproduced against a real packed tarball: under `nodenext` a deliberately bogus property on an imported type was accepted, and under `bundler` the same code was correctly rejected. Note that appending `.js` is right for a `.d.ts` too: TypeScript maps a `./x.js` specifier to `./x.d.ts`, so declarations must name the runtime extension and never `.d.ts`.

Bare `.` and `..` specifiers count as relative imports and need the same expansion to `./index.js`. This is easy to miss because such a specifier looks nothing like the `./x` case and slips past a pattern that expects a slash; exactly one existed in the repo (`operating-mode/types.ts`), and it stayed invisible until the `.d.ts` rewrite started running.

`scripts/check-esm-imports.mjs` guards both halves, and needs to, because neither guard sees the other's failure: the runtime probe imports each entry point under real Node ESM, while a second pass typechecks a consumer against the same sandbox under `nodenext` with `skipLibCheck` deliberately **off**. A `.d.ts` regression leaves the runtime probe entirely green, which is precisely the hole the second pass fills.

That second pass fails on two classes of diagnostic, and needs both. Anything attributed to the generated consumer counts unconditionally — it imports nothing but our own packages, so a missing declaration file (`TS7016`) or a `publishConfig` path pointing at output that was never built (`TS2307`) is ours by construction. Restricting the pass to diagnostics whose _path_ pointed into our `dist/` was this guard's own first bug: a deleted `dist/server.d.ts` sailed through it. Separately, `TS2834`/`TS2835`/`TS2307`/`TS7016` inside our own `dist/` catch the extensionless-import case. The pass covers every published subpath rather than only the runtime-testable ones, because each runtime `skip` (a CSS import Node rejects, a `next/server` specifier only a bundler resolves) is irrelevant to `import type` — restricting it to those left the whole `editor/` declaration subtree, reachable only via `./client`, unguarded. See [DEVELOPING.md](DEVELOPING.md#published-package-esm-import-check).

This is a structural blind spot particular to pnpm workspaces, not just a missed build step: inside the workspace, importing one package from another resolves through the package's dev `exports` field (raw `.ts` source), never through `publishConfig.exports` — the shape a real npm/pnpm consumer actually gets. So in-repo tests and dev usage exercise a different resolution path than the published tarball, and can pass while the tarball is broken. Catching this requires reconstructing what publish actually produces — merging each package's `publishConfig` the way `npm publish` does, against the built `dist/` output — rather than just importing the package by name.

Published packages retain `declaration` (`.d.ts` output) but not `sourceMap`/`declarationMap`, since `files: ["dist"]` means the source files those maps reference are never included in the tarball.

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

**Content Serialization** - Comment-preserving writes for YAML and md/mdx frontmatter:

- `utils/content-serialize.ts` re-serialises an entry onto the file's OWN parsed `yaml` document rather than stringifying a fresh plain object, so a node whose value did not change keeps its comments, quoting and block style. Writing a fresh object is why an editor save used to delete every comment in a content file.
- The reconciler is deliberately schema-blind: it makes the document's key set match the write payload exactly, so data authority stays with the payload and comments are the only thing inherited from disk. Whether a surviving key still belongs is answered a layer up, by the unknown-key report below.
- Sequences align by value before position, so reordering a list carries each comment with the content it describes instead of leaving it on whatever moved into that index.
- Every fallback path (new file, unparseable existing bytes, no frontmatter) emits byte-identical output to the pre-fix behaviour, so entry creation is unchanged and a malformed file can still be saved over.
- Because the write now reads the file it is about to replace, the read sits inside the per-entry lock and the [SYNC-C1] content-write lock and after the OCC stat — see [docs/concurrency.md](docs/concurrency.md).

**Unknown-Key Reporting** - Content keys the schema no longer defines:

- `validation/field-traversal.ts`'s `traverseFields` is the single encoding of the schema-nesting rules; its optional `onContainer` hook reports each (data record, governing fields) pair, which is what lets a check inspect the data's own keys rather than only the schema's. An inline group does not fire the hook — it shares its parent's record, so treating it as a container would make every sibling of the group read as unknown.
- `validation/entry-validator.ts`'s `findUnknownKeys` builds on that hook. It is non-blocking by design and feeds two surfaces: `validationWarnings` on the write response (already rendered by the editor) and `static/`'s `warnUnknownEntryKeys` during a production build.
- It runs on the normalized, about-to-be-persisted data, so a resolved reference collapsed back to an id string cannot be misread, and it reports nothing for a container with no fields at all.

**Static-Export Helpers** - Framework-agnostic static-site-generation support:

- Core `collectStaticPaths` (canopycms/server) produces neutral route descriptors (URL path, segments, slug, entry type) from the build context
- The Next.js adapter (canopycms-next) maps those onto `generateStaticParams` via the free `collectStaticParams` helper and the bound `generateContentStaticParams` method, so page modules never hold the admin build context
- See [Static-Export Helpers](#static-export-helpers) for the core-plus-adapter design and the enumeration / content-read / admin capability split

**Assets & Media** - Content-addressed asset storage, upload finalize pipeline, and on-demand image transforms:

- Store contract with S3 and local-filesystem adapters, selected by the `media` config
- Content-addressed key builders (sha-256 hashing, filename slugging) and the fixed set of bucket prefixes
- Finalize pipeline (magic-byte sniffing, SVG sanitization, dimension extraction, dedup ordering)
- Isomorphic transform-directive parser and canonical formatter, a server-only image transform (sharp), and the isomorphic `assetUrl`/`assetSrcSet` URL helpers
- See [Asset & Media System](#asset--media-system) for the full subsystem

**Validation** - Content validation utilities:

- Reference validator for checking content references
- Entry link validator for checking inline entry:ID links in body content
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
- Content index generation (on-disk cross-process generation marker for the ContentId index; complements the in-process index registry)
- Content listing (shared entry-listing utilities: filename parsing, entry data reading, ordering, flat entry listing)
- Content reader (authenticated content access)
- Content store (file-based content persistence)
- Content tree (build-time content tree builder for adopter navigation, sitemaps, etc.)
- Content types (content data structures)
- Entry link resolver (inline entry:ID link resolution for body content)

**Git:**

- Git manager (low-level git operations)
- GitHub service (GitHub API integration)

**Dev Content Sync:**

- Sync core (prompt-free content-tree diffing, copy, and commit primitives shared by the sync CLI and the dev watcher)
- Dev content watcher (dev-only divergence detection between the working tree and the served branch clone; see [Dev Content Divergence Detection](#dev-content-divergence-detection))

**Core:**

- Services (service container and factory)
- Context (request context creation)
- Types (shared type definitions)
- User (user data structures)
- ID generation

**Other:**

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

1. Detects the effective active branch **and** base branch (dev-mode git HEAD detection for whichever the adopter left unset; see [Branch Identity](#branch-identity-defaultbasebranch-vs-defaultactivebranch)) and bakes both into the config so all downstream code uses consistent values. In dev mode, `refreshActiveBranch()` re-detects them per request — again, only the fields the adopter left unset
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

- **Content**: MD/MDX/JSON/YAML files in the content directory (committed to git)
- **Branch metadata**: `.canopy-meta/branch.json` per workspace (state, recorded base branch — the immutable fork point set at creation — PR references, sync status, conflict tracking, automatically excluded via git info/exclude)
- **Branch registry**: `branches.json` at branches root (inventory of all branches, gitignored)
- **Comments**: `.canopy-meta/comments.json` per branch (NOT committed to git, automatically excluded)
- **Settings (prod)**: `groups.json` and `permissions.json` on orphan branch `canopycms-settings-{deploymentName}` (version-controlled, deployment-specific), workspace at `{workspaceRoot}/settings/`
- **Settings (dev)**: Same orphan branch mechanism as prod (`canopycms-settings-{deploymentName}`), workspace at `.canopy-dev/settings/` (gitignored, local development only)

**What is deliberately not on this filesystem:** Binary assets (images, PDFs) are not stored in git or on the CMS workspace filesystem. They live in a separate content-addressed object store — S3 in prod, a local directory in dev — and content only ever references them by immutable key. This keeps git history and per-branch EFS clones lean. See [Asset & Media System](#asset--media-system).

**Concurrent writes**: Branch metadata, comments, and the settings files (permissions/groups) are each mutated by more than one host at a time in practice (several warm Lambda containers plus the worker, all sharing EFS). All three are protected by a server-enforced cross-host lock in addition to in-process serialization, so a lost update across hosts is not an accepted risk for any of them. Settings files additionally carry a per-write version check, but it is advisory there rather than the guarantee: the files are git-committed, and a settings-branch merge can rewrite that version, so the cross-host lock is what actually prevents lost updates. Collection metadata (`.collection.json`) mutations get the same in-process-plus-cross-host-lock treatment across their full read-then-write, but deliberately carry no version field at all, for the same git-rewrite reason. See [docs/concurrency.md](docs/concurrency.md) for the full protection model and why each layer alone isn't sufficient.

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

> The full concurrency model — the four protection layers (in-process mutex, per-file
> OCC, server-enforced lockfile, generation markers), EFS/NFS semantics, the
> per-resource protection table, residual staleness windows, and recipes for new
> caches/stores — lives in [docs/concurrency.md](docs/concurrency.md). This section
> covers only the ContentId index.

The index is NOT thread-safe, and each process holds its own in-memory copy. There is no shared memory or cross-host file watching between processes (several warm Lambda containers plus the worker sharing branch clones on EFS), so the shared filesystem itself is the coordination medium:

- **Filenames are source of truth**: Each process rebuilds its index by scanning filenames on disk
- **Atomic operations**: File renames are atomic; all processes discover the same filenames
- **On-disk generation marker**: Every operation that mutates indexed files under a branch clone rewrites a small per-clone marker file (`.canopy-meta/content-index.generation`) with a fresh random token, strictly after the mutation. Each store re-reads the marker on a throttled probe (default one second) and rebuilds when the token differs from the one it captured before its last scan.
- **Random token, not a counter**: Readers only need to answer "did it change since I captured it?", so inequality suffices. A monotonic counter would require read-modify-write and silently lose concurrent bumps without a lock; a unique token per bump has no lost-update problem and sidesteps NFS mtime granularity and cross-host clock skew.
- **Rebuilds swap, never clear**: A rebuild constructs a fresh index and swaps it in, so concurrent readers never observe a half-built index.
- **Suspicious-lookup backstop**: An ID miss, or an index hit pointing at a file that no longer exists, forces one immediate rebuild (throttled to once per few seconds) before the lookup fails—self-healing for the residual windows below.
- **Write existence guard**: A write targeting an existing ID consults the actual directory listing before recreating a missing expected file, and raises a conflict error instead of resurrecting an entry another process concurrently renamed. This prevents duplicate-ID files independently of the marker.
- **Unique ID generation**: Multiple processes can't create duplicate IDs (globally unique)
- **Duplicate-ID quarantine**: a duplicate embedded ID (rename-crash debris, or a merge landing two files sharing one ID) no longer fails the build — that used to brick every content operation on the branch permanently. The scan keeps one deterministic winner (string-MIN of the relative paths, so every host agrees regardless of `readdir()` order), drops the loser from the index, and reports the pair through `branch-health` for the `repair-content-duplicates` admin action. The dropped file stays on disk **and stays addressable by collection+slug** (slugs resolve by directory scan, which knows nothing about the quarantine), so `ContentStore.write()` refuses a save whose content ID is on two files (`DuplicateContentIdError`, a 409 naming both files and the repair action) instead of mutating an ambiguous target; `delete()`/`renameEntry()` stay allowed because each only touches the file the caller addressed. An index is a hint about where an ID lives, never authority to delete — see [docs/concurrency.md](docs/concurrency.md).

Residual staleness is bounded rather than open-ended: the probe throttle (about a second) plus, across hosts on EFS/NFS, attribute caching that can delay marker visibility for roughly 3-60 seconds on default mounts. These windows are further bounded by per-request store lifetimes and healed by the suspicious-lookup backstop—acceptable for human-paced editing workflows.

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

CanopyCMS uses a schema model based on **collections** and **entry types**. Schemas are defined in `.collection.json` files alongside content, with entry types referencing field definitions in a centralized schema registry.

### Schema Structure

The schema is defined as a `RootCollectionConfig` with two optional properties:

- **entries**: Array of entry type configurations (typed content items)
- **collections**: Nested collection hierarchies

**Entry types** define the types of content allowed in a collection. Each entry type has:

- **name**: The type identifier (e.g., 'post', 'doc', 'settings')
- **format**: Content format (md, mdx, json, yaml)
- **fields**: Field schema definitions
- **maxItems**: Optional cardinality limit (1 = only one instance allowed, like a singleton)
- **default**: Whether this is the default type for "Add" button

**Collections** contain entry types and can nest other collections. The root itself is a collection (the content root), creating a uniform model where every collection behaves identically.

**Field flags**: Individual fields within an entry type can carry behavioral flags:

- **isTitle**: Marks a field as the human-readable title for entries of this type. The editor UI, content listings, and tree builders use this to display meaningful labels instead of raw slugs. Only one field per entry type may be marked `isTitle`. The field must be a scalar (string-like) value that can be resolved at runtime, so `isTitle` is rejected on fields nested inside `list: true` object fields where the system cannot determine which array element to use.

**Structured field types**: Beyond scalar fields, the schema supports structured field types whose value is an object rather than a primitive. The `image` field is one such type — its value carries a content-addressed asset reference plus alt text, dimensions, and an optional crop rectangle, and its definition can require a fixed aspect ratio. Structured values are enforced at the server write boundary by the shared isomorphic entry validator. See [Asset & Media System](#asset--media-system).

**Reserved field names**: For md/mdx entry types, the field name "body" is reserved. The system uses `body` to carry the markdown content itself (everything below the frontmatter). Schema validation rejects md/mdx entry types that define a frontmatter field named "body" to prevent collisions with the content body. Data-only formats (JSON and YAML) have no such restriction since they have no separate body concept.

**Format categories**: Content formats fall into two categories. **Document formats** (md, mdx) use frontmatter/body separation, where structured fields live in YAML frontmatter and the markdown body is a distinct content area. **Data-only formats** (json, yaml) store all fields as structured data with no body concept. This distinction drives how the system reads, writes, and validates entries of each format.

**Key design principle**: Entry types are schema metadata, not navigable tree nodes. A collection with `entries: [{ name: 'post', ... }]` defines that entries of type "post" can be created in that collection. The entry type itself doesn't appear in navigation—only the collection does.

**Index entries**: An entry with the slug "index" represents the collection itself rather than a child page. This is a convention borrowed from filesystem-based routing (like `index.html`). For example, a `docs` collection might have an index entry that serves as the landing page for `/docs`. CanopyCMS collapses index entries in URL paths consistently across the entire content API surface: `readByUrlPath('/docs')` resolves to the index entry in the docs collection, `listEntries()` reports its `urlPath` as `/docs` (not `/docs/index`), and `buildContentTree()` generates a path of `/docs` for the node. The root content directory's index entry resolves to `/`. This collapsing convention means adopters can use URL paths directly from the content APIs for routing and linking without needing to special-case index entries.

The collapse is **exclusive**, not merely consistent: `readByUrlPath('/docs/index')` returns `null`. `resolveUrlPathCandidates` skips its direct-entry candidate when the last URL segment is an index slug, so an index entry cannot also answer at a URL that no forward surface ever emits. The comparison is case-insensitive (via the shared `isIndexSlug`), because this resolver is the one consumer that sees a raw URL segment while everything downstream lowercases — a strict compare closed `/docs/index` and left `/docs/Index` answering. The index-fallback candidate survives unconditionally, which is what resolves a collection literally _named_ `index` — its own index entry, rather than the parent's.

Each entry gets exactly one `urlPath`, but two _different_ entries can still compute the same one — an entry whose slug matches a sibling collection that also has an index entry, or two slugs differing only by case. Only one is then reachable and the other silently has no route, so `assertNoDuplicateUrlPaths` (`static/index.ts`) fails a production build naming every contested URL. An entry beside a sibling collection with **no** index entry is a different, legitimate shape (a landing page plus a folder of children) and is untouched.

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

### Schema Meta Files

Each collection folder can contain a `.collection.json` file that defines:

- Collection name and label
- Entry type configurations (array of typed content definitions)
- Optional child ordering (an `order` array of content IDs; when omitted or empty, children sort alphabetically)

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

**Step 3: Flatten schema**

- Final merged schema is flattened into `Map<path, FlatSchemaItem>` for O(1) lookups
- Each flattened collection item carries its ContentId (used for conflict tracking and ordering)
- The root collection receives a sentinel `ROOT_COLLECTION_ID` since the content root directory has no embedded ID
- All path resolution and validation happens at initialization, not request time

**Error handling:**

- Clear error messages when referenced schemas don't exist
- Lists available schema registry keys in error messages
- Validates collection structure during parse (must have entries or collections)
- Throws if no `.collection.json` files are found in the content directory

### Schema Cache Invalidation

The resolved schema is cached per branch so ordinary requests don't re-scan and re-parse every `.collection.json` file. Schema edits (adding a collection, changing an entry type, reordering) invalidate that cache the same way branch metadata and the content ID index do: by bumping a cross-process generation marker rather than mutating the cache in place. Every warm host sharing the branch workspace (Lambda containers, the worker) notices the bump at its next read and re-resolves.

Bulk working-tree operations — a rebase pulling in upstream `.collection.json` changes, a sync, a migration — also bump the schema marker, not just direct schema edits made through the editor. This was a deliberate backstop: a git operation that changes schema files on disk without going through the schema-editing API would otherwise leave every process serving a stale schema with no signal to refresh. See [docs/concurrency.md](docs/concurrency.md) for the generation-marker protocol and the residual staleness windows it accepts.

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
- `format`: Content format (md, mdx, json, yaml)
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

- **editing**: Active work in progress — the only status from which content can be written or the branch submitted
- **submitted**: Sent for review, awaiting merge
- **approved**: Approved and ready to merge
- **archived**: Merged and preserved for audit

There is deliberately no separate `locked` state: `submitted` already means "locked for review" (see `BranchStatus` in `types.ts`).

In dev mode, users normally work directly on the base branch too—that's the expected local flow, and nothing prevents it. In prod mode, the base branch is read-only in the editor (see [Protected Base Branch](#protected-base-branch) below); real edits require creating a separate branch, which then goes through the submit/review/merge flow. The branch model provides isolation for team collaboration and, in prod, enforces it for the base branch specifically.

### Branch Identity: defaultBaseBranch vs defaultActiveBranch

CanopyCMS distinguishes between two branch concepts that serve different purposes:

- **`defaultBaseBranch`** is the fork point for CMS content branches. When a user creates a new editing branch, it is forked from this branch, and the branch used to seed workspace clones from the (real or simulated) remote. Git operations like rebasing editing branches use this as the upstream target.

- **`defaultActiveBranch`** is the workspace from which content is served by default — the branch the editor opens when no branch is specified, the branch used for content reading APIs, AI content generation, and the content tree builder. It answers the question "which branch should I look at right now?"

**Why they are separate:** In dev mode, a developer is often working on a feature branch (e.g., `redesign-nav`). They want the CMS editor to show content from that branch, not from `main`. Setting `defaultBaseBranch` explicitly lets new CMS editing branches still fork from a stable branch while the served content follows the feature branch. Conflating the two concepts would force developers to either serve stale `main` content or fork editing branches from an unstable feature branch.

**Detection matrix** (the single implementation is `resolveBaseBranch()` in `utils/git.ts` plus the active-branch detector in `services.ts`):

|          | `defaultBaseBranch` set                            | `defaultBaseBranch` unset                                                                           |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **dev**  | base = configured value; active follows git HEAD   | base **and** active follow git HEAD (workspaces fork from the branch the developer has checked out) |
| **prod** | base = configured value; active falls back to base | base = `'main'`; active falls back to base                                                          |

- An explicitly configured value (for either field) is always respected and never overridden by detection
- Static deployments (`deployedAs: 'static'`) skip detection and per-request refresh entirely — a static export serves from the checkout, so there is no git HEAD to track and no git calls are made
- Both resolved values are baked into the config at service creation time, and refreshed per-request via `refreshActiveBranch()` (dev mode only, with a 5-second cache); only fields the adopter left unset are refreshed
- On detached HEAD (or no git repo), detection falls back to `defaultBaseBranch ?? 'main'`
- The Zod schema intentionally leaves `defaultBaseBranch` undefined when unset (`.optional()` defeats the `.default('main')`) — that is what makes "unset" detectable for dev-mode HEAD detection

**Recorded fork point:** When a branch workspace is created, the resolved base branch is recorded in the branch's metadata (`.canopy-meta/branch.json`, `branch.baseBranch`) and is immutable afterwards. Git operations on an existing branch (commits, submit, PR base) prefer the recorded fork point over the config value, so a developer switching git branches mid-session cannot retarget an existing branch's base.

**Decision history** (recorded here because the question "did we decide to auto-detect branches?" has come up repeatedly): branch auto-detection was deliberately introduced twice — PR #26 (dev-mode consolidation; HEAD detection for the fork point when `defaultBaseBranch` is unset) and PR #36 (the `defaultBaseBranch`/`defaultActiveBranch` split with per-request active-branch detection). PR #74 (v0.0.50) hardened the dev simulated remote to serve newly-detected base branches on demand; it changed no detection semantics. There was never a decision _against_ detection; adopters can opt out at any time by setting both fields explicitly.

**Per-request branch tracking:** In dev mode, every content-serving entry point — the API handler and the context factory behind `getCanopy()` — calls `refreshActiveBranch()` on each request. If the developer switches git branches, the active branch (and, when unset, the base branch used for newly provisioned workspaces) silently updates — no server restart needed. The workspace for the new branch is lazily created on the first content request via the handler's auto-create path (`BranchWorkspaceManager.openOrCreateBranch`). This only affects non-editor content serving (the public dev site, `getCanopy()`, AI content); the editor is pinned to its own branch via URL params and has branch-specific drafts in localStorage. An editor opened without a pinned branch (no URL parameter, no client-config value) adopts the server's effective default branch, which the branches-list API reports per request — nothing is hardcoded client-side, and an explicitly pinned branch is never overridden.

**Fallback chain:** Throughout the system, content-serving code resolves the active branch as `defaultActiveBranch ?? defaultBaseBranch ?? 'main'`. The handler auto-creates workspaces for `defaultActiveBranch` on demand, ensuring the active branch is always ready to serve content. The HTTP handler also provisions the base-branch workspace on the first request (it is needed to load internal groups); if that provisioning fails outright, the handler fails loudly — logging the cause and returning a 503 that names the branch and the underlying reason — rather than letting every endpoint return confusing empty results.

**Corrupt base-branch metadata is an exception to that 503:** if the base branch's `branch.json` exists but fails to parse, the handler degrades instead of failing — it serves the request with no internal groups (bootstrap admins retain access via their configured IDs) and logs the condition, rather than 503ing every endpoint. A hard 503 here would make the problem unrecoverable through the product itself: the only fix is the admin branch-health repair action (see [Admin Observability and Recovery API](#admin-observability-and-recovery-api)), which is one of those same endpoints. Every other provisioning failure (disk full, filesystem unavailable, etc.) still 503s as before.

### Protected Base Branch

The resolved base branch is **protected**: it can never be submitted for review (submitting it would commit and push directly to itself — a review bypass — and then ask GitHub for a head==base PR, which 422s), and in prod mode it is **read-only in the editor** (content on the base branch only changes via merged PRs, matching the branch-first workflow). In dev mode the base branch stays editable — the developer always lands on it by definition (it follows git HEAD when unset), and editing it is the normal local flow, reconciled via `canopycms sync`.

The single source of truth is `getBranchProtection(config, branchName, recordedBaseBranch?)` in `authorization/protected-branch.ts`, keyed off the resolved `config.defaultBaseBranch` (never a hard-coded `'main'` — `master`/`develop` bases work) with sanitization-aware comparison (metadata names are sanitized; config holds the raw git name). It returns three flags:

|                 | dev | prod |
| --------------- | --- | ---- |
| `isProtected`   | ✓   | ✓    |
| `submitBlocked` | ✓   | ✓    |
| `readOnly`      | —   | ✓    |

To authorize a content write, or to render a lock in the editor, use the sibling `getBranchWriteProtection(config, branchName, recordedBaseBranch, status)` instead. It delegates to `getBranchProtection` and adds two flags:

- `writeBlocked` = `readOnly || status !== 'editing'` — the single expression of the "which statuses lock editing" rule, so the API guard, the branches-list wire flag, and the editor all agree by construction rather than by three parallel derivations. `readOnly` keeps its narrow meaning: it distinguishes _which_ lock applies, and therefore which banner the editor shows.
- `submitBlockedIncludingStatus` = `submitBlocked || status !== 'editing'` — the compound submit rule, consumed as-is by the editor's `canSubmit` instead of being re-derived client-side from `status`/`isProtected` (the drift hazard a bare, base-only `submitBlocked` flag would not have closed, since the status half would still be re-derived — this is why the wider flag exists as its own, deliberately verbosely-named field rather than overloading `submitBlocked`'s meaning, which `api/guards.ts`'s `submittableBranch` guard must keep reading as "base branch only"). Note the asymmetry with `writeBlocked`: it is built from `readOnly` (prod-only), while this is built from `submitBlocked`/`isProtected` (both modes) — in dev the base branch is writable but never submittable, so the two compounds genuinely disagree there (`writeBlocked: false`, `submitBlockedIncludingStatus: true`), not just two names for the same value.

`status` is a **required** parameter there, deliberately typed to admit `undefined`, so that a missing status fails closed. `branch.json` is parsed with a bare cast and no schema validation, so a hand-repaired or partially-written file can yield no status at runtime despite the required type — and malformed branch metadata is a handled condition here (see the corrupt-metadata quarantine). Making the parameter required is what keeps "the caller didn't ask about status" distinguishable from "the file had no status": those two cases want opposite answers, and only the second should block. Callers that genuinely don't care — the submit, delete, and ACL rails — call `getBranchProtection` and get no `writeBlocked` at all.

Enforcement is layered:

- **API guards** (`api/guards.ts`): `writableBranch` (403 on content/entry/schema mutations when `writeBlocked` — base-branch `readOnly` and status locks share the guard but produce different messages) and `submittableBranch` (403 on submit when `submitBlocked`). `deleteBranch` and `updateBranchAccess` refuse the base branch with handler-level checks.
- **Workflow authorization** (`authorization/branch.ts`): the system-branch grant in `canPerformWorkflowAction` (the base branch is auto-provisioned with `createdBy: 'canopycms-system'`) is disabled on protected branches, so only admins/reviewers/explicit-ACL users retain workflow rights there.
- **Backstops** (defense in depth, all refusing sanitized head==base): `services.submitBranch` throws before any git operation; `syncSubmitPr` returns `sync-failed` without calling GitHub or enqueueing; the worker's `push-and-create-or-update-pr` task throws a `PermanentTaskError` (the same task also throws `PermanentTaskError` for an unrelated reason — a genuine non-fast-forward push rejection between two deployments; see [Push Rejection Classification](#push-rejection-classification)).
- **Editor UI**: renders purely from server-computed wire flags (`isProtected`/`readOnly`/`writeBlocked`/`submitBlocked` on the branches-list response, the last populated from `submitBlockedIncludingStatus`) — Submit is hidden or disabled, Save is disabled, and a banner with a "Create a branch" action appears on a read-only branch. Because `writeBlocked`/`submitBlocked` come from the same predicates the API guards use, the UI cannot enable a write or submit the API would reject — **provided the client actually received the flags**. All four flags are optional on the wire (for compatibility with older/newer servers), and the editor's wire→view mapping (`useBranchManager.tsx`) defaults the three that gate a mutating action (`isProtected`, `writeBlocked`, `submitBlocked`) to `true` — fail CLOSED — when absent, not `false`. A branches-list fetch that is still loading, has failed, or hit a version-skewed server that doesn't emit these fields yet renders the branch locked rather than silently open; `readOnly` alone stays `false` when absent, since it only selects which banner to show once something else has already established that the branch is locked. The editor still lands on the protected branch for browsing.

**Withdraw is deliberately not blocked** on protected branches: it is the self-serve recovery path for a base branch wrongly stuck in `submitted` (the pre-protection failure mode), and the workflow-authorization change above restricts it to privileged users there.

### Reserved Branch Names

The API serves branch-specific routes (`/:branch/...`) and a handful of static top-level routes (admin, assets, branches, groups, permissions, users, whoami) from the same route table, and a static segment always wins over the dynamic `:branch` parameter. A branch literally named e.g. `admin` would therefore have its own routes shadowed by the static `/admin` namespace — not cleanly rejected, just confusingly half-alive: the branch's bare top-level route still resolves, while every nested route on it 404s or 403s unpredictably.

Branch creation rejects any name that collides with a static top-level route namespace (checked against both the requested name and its sanitized, git-ref-safe form; matching is exact and case-sensitive, so `Admin` and `admin-docs` stay creatable). This is enforced only on the creation path, deliberately not as a general branch-name validation rule: a blanket rule would also reject an already-existing branch with a colliding name on every one of its own routes, including its delete route, making it permanently un-removable. This is a separate reservation from the settings-branch namespace (`canopycms-settings-{deploymentName}`, see [Sharing one repository across two deployments](#lambda--efs--ec2-worker-aws-cost-optimized)) — one protects the route table, the other protects a specific deployment's settings from collision.

## Operating Modes

CanopyCMS supports two operating modes to fit different environments. The mode is configured in `canopycms.config.ts` via a required `mode` field with no default. Omitting it fails Zod validation loudly at startup, rather than silently falling back to a mode — a prod deployment that forgot to set `mode` would otherwise run with dev's header-trusting auth semantics, trusting whatever identity a caller claims in a request header. After validation, `config.mode` is always defined and can be used throughout the codebase without fallback checks.

### dev

Full-featured local development with branching and git operations — a local simulation of production behavior. Creates per-branch workspaces in `.canopy-dev/content-branches/` and maintains a local bare git remote at `.canopy-dev/remote.git`. This mode mirrors prod behavior: branch creation, workspace cloning, the settings branch, and the worker CLI all work the same way locally as they do in production.

`defaultActiveBranch` and `defaultBaseBranch` are each auto-detected from the current git HEAD if not explicitly set in the config (see [Branch Identity](#branch-identity-defaultbasebranch-vs-defaultactivebranch)). The detected values are baked into the config object at service creation time so that all downstream code uses the same values without re-detecting (avoids races if HEAD changes mid-request). Settings (groups and permissions) use the same orphan branch mechanism as prod (`canopycms-settings-{deploymentName}`, default: `canopycms-settings-local`), with the workspace at `.canopy-dev/settings/`. Commits go to the local bare remote but no PR is created, keeping the workflow lightweight during development. The AI content cache is invalidated on every request in dev mode so content edits are reflected immediately.

Use `npx canopycms worker run-once` to process queued tasks, refresh the auth cache, and simulate the EC2 worker locally. Use `npx canopycms sync push` / `npx canopycms sync pull` to synchronize content between the developer's working tree and the CMS editor's branch workspaces (see [Content Sync CLI](#content-sync-cli) below). A background watcher (see [Dev Content Divergence Detection](#dev-content-divergence-detection) below) surfaces divergence between the working tree and the served branch clone, so developers do not silently serve stale content when they forget to run sync.

### prod

Full production deployment. Branch workspaces live on persistent storage (e.g., EFS on AWS). Integrates with GitHub for PR creation and management. Designed for team collaboration with proper review workflows.

Settings (groups and permissions) are stored on a separate orphan branch whose name is computed by the operating mode strategy as `canopycms-settings-{deploymentName}` (default: `canopycms-settings-prod`). Changes create PRs for review before merging to main, ensuring permission changes go through the same review process as content changes.

Settings PR creation follows the same dual-path as content branches: when `githubService` is available the PR is created directly; when it is not (e.g., Lambda with no internet), a `push-and-create-or-update-pr` task is queued for the EC2 worker. Because the same settings branch is updated repeatedly, this task checks for an existing open PR before creating a new one.

**Security**: In both prod and dev modes, the system will throw an error if the settings branch cannot be loaded, ensuring permissions are never accidentally read from a content branch. Concurrent admin updates to settings files are guarded by the same locking stack described in [Storage Architecture](#storage-architecture): a conflicting update is rejected rather than silently overwritten, and the editor surfaces the conflict to the admin instead of failing silently or clobbering another admin's change. See [docs/concurrency.md](docs/concurrency.md) for the full model.

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
- Reaches S3 for asset presign/finalize through a gateway VPC endpoint (no NAT needed); see [Asset & Media System](#asset--media-system)
- Holds no sensitive secrets (only public keys and config)

**EC2 Worker (internet access):**

- Tiny daemon (t4g.nano spot instance, ~$1.50/month)
- Processes queued tasks: pushes branches to GitHub, creates/updates PRs
- Syncs `remote.git` with GitHub (fetches upstream changes)
- Pushes this deployment's own settings branch to GitHub on each sync cycle (belt-and-suspenders for the task queue) — never a blanket push of every local `canopycms-settings-*` branch. Once another deployment's settings branch can legitimately show up as a local head (see below), pushing all of them would mean one deployment's worker publishing another deployment's settings; it warns about any such foreign branch instead of touching it
- Rebases active branch workspaces onto updated base branch (with conflict detection and resolution)
- Refreshes auth metadata cache (Clerk users/orgs, or dev test users)
- Ships its own stdout/stderr to a dedicated CloudWatch log group, every line prefixed with an ISO-8601 UTC timestamp and a level tag (INFO/WARN/ERROR)

This architecture eliminates NAT Gateway ($32/month) and keeps all secrets on the worker (not Lambda). The worker's AWS permissions: EFS client access (managed policy), Secrets Manager reads for its specific secrets, SSM core (`AmazonSSMManagedInstanceCore`, the Session Manager observation channel for operators whose roles allow it), read access to the CDK asset bucket (its own code bundle), and write-only access to its one CloudWatch log group — no broader logging or monitoring policy (no `CloudWatchAgentServerPolicy`). Log shipping exists because production operators may not have SSM Session Manager access into the instance (an organization's SSO role can be provisioned without `ssm:StartSession`), leaving the shipped logs as the only window into worker behavior beyond the task queue's own success/failure records. Because the worker is otherwise silent — no HTTP endpoint, no health API — log delivery is treated as best-effort rather than a hard dependency: the worker daemon starts and keeps running even if the log agent fails to install or configure.

The timestamp/level prefix is load-bearing, not cosmetic. The worker's systemd unit sends both stdout and stderr into the same log file, so the level tag is the only thing that lets a downstream reader tell a `console.log` line from a `console.error` line; timestamp and level are passed as separate arguments rather than concatenated into the message so console's native formatting of non-string arguments still applies (an `Error` still prints with its stack). The CloudWatch agent config reads that same prefix twice: as `timestamp_format`/`timezone`, so each CloudWatch event is stamped with when the worker actually emitted the line rather than when the agent ingested it (the two diverge during agent hiccups, buffered bursts, and post-restart backlogs), and as `multi_line_start_pattern`, so a multi-line stack trace stays one CloudWatch event instead of fragmenting into one event per line. Because the multi-line grouping is keyed on that prefix, any line written to the log file without it is folded into the preceding event instead of starting its own — so every writer to the log file goes through the same shared logging helper. The one gap is an uncaught-exception dump Node prints on its own on the way down, which still attaches to the preceding event rather than starting its own — worse than a correctly-tagged line, but still better than the per-line fragmentation this scheme replaces.

The worker's Auto Scaling Group carries a rolling `UpdatePolicy` (`minInstancesInService: 0`, forced by `minCapacity`/`maxCapacity` both being 1), so `cdk deploy` actually terminates and relaunches the instance whenever its launch template changes — most notably a new worker code bundle, which is a CDK S3 asset baked into the launch template's user-data. Without this, CloudFormation updates the template resource and stops there: the running instance keeps its stale user-data (and stale worker bundle) until a spot interruption or manual terminate happens to replace it, so a plain `cdk deploy` would silently update everything except the worker. This makes instance replacement — previously a rare event (spot interruption) — routine (every deploy that touches the worker), which is why orphaned-task recovery now runs on every task-queue cycle rather than only at worker boot; see [Task Queue](#task-queue-async-github-operations) below. The CMS and transform Lambdas each get an analogous dedicated CloudWatch log group (`cmsLogGroup`/`transformLogGroup`), all following the same custom-name/90-day-retention/`RemovalPolicy.DESTROY` convention as the worker's, instead of the CloudFormation-implicit `/aws/lambda/<function-name>` group (which CDK can't manage and which survives `cdk destroy`).

**Sharing one repository across two deployments:** The CDK service construct accepts a `deploymentName` prop (default `prod`), stamped into both the Lambda's and the worker's environment as `CANOPYCMS_DEPLOYMENT_NAME`. This is what lets two independent CanopyCMS stacks — e.g. staging and production — point at the same GitHub repo without colliding on the same settings branch: each stack gets its own `canopycms-settings-{deploymentName}` branch, and the worker above pushes only the one belonging to its own stack. See [Deployment Name Resolution](#deployment-name-resolution) for how this value is resolved end-to-end and why the environment variable — not the adopter's config — is what actually distinguishes the two stacks.

Content branches have no equivalent namespacing — an editor on either stack can independently create a branch with the same name — so that scenario surfaces instead as a real git push rejection rather than silent data loss. See [Push Rejection Classification](#push-rejection-classification) below for how both hops of the push flow detect and report it.

### Key Deployment Components

#### `remote.git` — Local Bare Repo

Both `prod` and `dev` modes use a local bare git repository as the "remote" for all branch workspace operations. Branch workspaces clone from and push to this bare repo using `file://` URLs.

- **dev**: Auto-created at `.canopy-dev/remote.git` from the local checkout. When site content lives in a subdirectory of the repo, the remote is seeded with a single snapshot commit of that subdirectory's tree at the configured base branch — not whatever branch HEAD happens to be on, and not the subdirectory's full history. Extracting that history (`git subtree split`) forks a subprocess per commit and takes minutes on large repos, and the simulated remote never needs it: editor state is committed on top of the seed. Branch auto-detect means workspaces are routinely cloned from base branches that postdate the remote's creation, so a base branch missing from the existing remote is pushed from the source repo on demand. Branches already present in the remote are never updated this way — the CMS pushes editor state into the remote, and a refresh from the source repo would clobber it.
- **prod**: Created by the EC2 worker at `{workspaceRoot}/remote.git`, synced with GitHub

CanopyCMS auto-detects `remote.git` at the workspace root (via `autoDetectRemotePath` in the operating mode strategy). No explicit `CANOPYCMS_REMOTE_URL` env var needed if `remote.git` exists.

**Prod-mode network-remote guard:** because the Lambda in this topology has no internet access, `GitManager.resolveRemoteUrl` rejects a resolved NETWORK remote URL (`http(s)://`, `ssh://`, `git://`, or scp-like `user@host:path`) in `prod` mode, regardless of whether it came from an explicit `remoteUrl` param, `config.defaultRemoteUrl`, or the `CANOPYCMS_REMOTE_URL` env var — pointing any of those at GitHub directly would make the internet-less Lambda hang trying to clone/fetch/push it. `file://` URLs and plain filesystem paths (including the auto-detected `remote.git` above) are local and unaffected. Prod hosts that genuinely have internet access and intentionally run git against a network remote (e.g. a single-VM deployment outside this topology) can opt out per-deployment via `config.allowNetworkRemoteInProd: true`.

#### Auth Caching (CachingAuthPlugin)

`CachingAuthPlugin` wraps any auth plugin's JWT verification with file-based metadata lookups:

1. **Token verification**: A `TokenVerifier` function verifies the JWT locally (no API calls)
2. **Metadata lookup**: `FileBasedAuthCache` reads user/group data from JSON files on EFS

Each auth plugin package provides its own token verifier and cache writer:

- `canopycms-auth-clerk`: `createClerkJwtVerifier()` + `refreshClerkCache()`
- `canopycms-auth-dev`: `createDevTokenVerifier()` + `refreshDevCache()`

The cache is populated by the worker daemon (or `npx canopycms worker run-once` in dev mode). Lambda reads it on every request. Cache invalidation is mtime-based — when the worker writes new cache files, Lambda picks them up on the next request. In dev mode, `CachingAuthPlugin` accepts an optional lazy refresher callback that auto-populates the cache on first request if it does not yet exist, so developers do not need to run the worker manually before their first login.

`CachingAuthPlugin` does not declare its own production trust — it forwards the wrapped plugin's `verifiesCredentials` affirmation through a constructor option (see [Authentication](#authentication) below). This matters because the framework adapter asserts trust against the wrapped (inner) plugin before wrapping it, so `CachingAuthPlugin` can never launder an insecure plugin into a trusted one just by adding a cache in front of it.

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
- `push-and-create-pr` / `push-and-update-pr` -- push then create or update a specific, already-known PR
- `push-and-create-or-update-pr` -- pushes, then looks up any existing open PR for the branch and updates it in place, only creating a new one if none exists. This idempotent create-or-update is the standard path for both content-branch submits and settings-branch syncs, because either can be safely retried after a partial failure (e.g. the PR was created on GitHub but its number was never recorded in branch metadata) without hitting GitHub's duplicate-PR error. Content submits set a `markReadyIfDraft` flag in the task payload so the worker converts a pre-existing draft PR to ready-for-review; settings syncs, which are not review requests, omit the flag. The create-or-update logic itself lives in one shared helper (`createOrUpdatePullRequest` in `github-service.ts`), used by both the worker task and the direct-API path's initial-submit/crash-recovery branch (`GitHubService.createOrUpdatePR`, single-server deployments with internet) when a branch's PR number isn't yet known, so idempotency has a single implementation regardless of deployment topology. The direct-API path's other branch -- updating a PR by an already-known number -- calls `updatePullRequest` directly and performs its own draft-to-ready conversion rather than routing through the shared helper. Draft-conversion is therefore best-effort everywhere (a permissions-limited token can't fail an otherwise-successful submit or update), but has two independent call sites rather than one: the shared helper's `markReadyIfDraft` handling, and this second, separately-wrapped conversion in `api/github-sync.ts`.
- `convert-to-draft` -- converts a PR to draft status (withdraw)
- `close-pr` -- closes a PR
- `delete-remote-branch` -- removes a branch from GitHub

Branch metadata includes a `syncStatus` field (`synced`, `pending-sync`, `sync-failed`) so the editor UI can show sync progress. The settings branch commit operation (`commitToSettingsBranch`) returns the same `syncStatus` values, allowing the permissions and groups UI to surface sync state to admins. A `sync-failed` status is paired with a `syncFailureReason` field recording why (see [Push Rejection Classification](#push-rejection-classification) below), so the editor's sync-failed badge can show the actual cause instead of a generic message.

**Orphaned-task recovery**: a task file left in `processing/` — because the worker process that dequeued it died before completing, failing, or retrying it — is recovered (moved back to `pending/`) once its file's age exceeds a threshold (5 minutes by default). `recoverOrphanedTasks` runs on every task-queue poll cycle (`CmsWorker.processTaskQueue`), not only at worker startup: a boot-only call is insufficient once instance replacement is routine rather than rare (see the ASG rolling-update policy above) — a replacement instance typically boots within the 5-minute threshold, so a single boot-time check would see the just-orphaned file as "too fresh" and skip it, and nothing would ever re-check afterward. Running the check every cycle is safe because the per-task execution timeout (60 seconds by default) is well under the recovery threshold, so no task genuinely still in flight can accumulate enough age in `processing/` to be misclassified as orphaned.

**Rate-limit handling**: Every Octokit instance CanopyCMS creates -- the worker's and `GitHubService`'s -- goes through a shared factory that attaches the `@octokit/plugin-throttling` plugin, so both proactively honor GitHub's retry-after guidance on primary and secondary (abuse-detection) rate limits instead of failing immediately. The worker retains a manual classification of HTTP 403 responses as a safety net for what the throttling plugin doesn't cover -- retries the plugin has already exhausted, and errors it never sees at all (e.g. non-403 network failures) -- so a rate-limited task fails permanently only when it genuinely should.

#### Push Rejection Classification

Two CanopyCMS deployments sharing one GitHub repo (see [Sharing one repository across two deployments](#lambda--efs--ec2-worker-aws-cost-optimized) above) can independently create a content branch with the same name, since content branches — unlike the settings branch — are not namespaced by `deploymentName`. When that happens, a push genuinely collides with the other deployment's history for that branch name, and git reports it as a real non-fast-forward rejection: the remote has commits this side never fetched, so retrying the identical push can never succeed.

A shared classifier recognizes this specific shape (`[rejected]` plus git's `non-fast-forward`/`fetch first` wording, or its "Updates were rejected" hint) and deliberately nothing broader — ordinary transient push failures (network, auth, lock contention) are left alone to keep retrying with backoff as before. Because the classifier depends on git's untranslated English wording, every git child process CanopyCMS spawns is now forced to the `C` locale, so a host's ambient language settings can never silently turn the classifier into a permanent no-op.

This classification applies at both hops of a content branch's push to GitHub:

- **Hop 1 — Lambda's synchronous push to the local `remote.git`** (on submit-for-review): a rejection returns HTTP 409 instead of the generic 500 used for other push failures. This hop targets the deployment's **own** local origin, which a foreign deployment cannot reach, so the message deliberately states only the observable fact — the branch diverged from the copy in this deployment's repository and needs reconciling — and names no cause. It also never advises renaming the branch: a branch that reaches this push has usually been submitted before, so a rename can orphan an open PR. As with all error responses, only the branch name and static guidance text reach the client; full detail (redacted of credentials) goes to server logs only.
- **Hop 2 — the worker's async push from `remote.git` to real GitHub**: a rejection is classified as a permanent failure — the task fails immediately instead of retrying with backoff, since an identical push can never resolve itself. This is a different trigger of the same `PermanentTaskError` used for the head-equals-base backstop (see [Protected Base Branch](#protected-base-branch)); both come from the same task type but for unrelated reasons. This is the hop where a foreign deployment genuinely is a plausible cause, so its message says so; it too stops short of advising a rename.

**Refused leases are a separate shape.** When the worker pushes history it rewrote (see [Publishing a Rewritten History](#publishing-a-rewritten-history)) it uses `--force-with-lease`, and git reports a refused lease as `[rejected] … (stale info)` — which shares none of the wording the classifier above matches, so it has its own predicate. A refused lease is usually benign (the marker is stale because an earlier attempt already landed, or the branch moved on since), and git refuses a stale lease even when the update would be an ordinary fast-forward. The push therefore retries **plain** on a refusal: a non-forced push succeeds only if it fast-forwards, so it can never destroy anything, and only a rejection of that retry is treated as a genuine divergence.

- **The worker's own settings-branch push** (belt-and-suspenders alongside the task queue, described above) has no task to fail into, so it still just logs a warning on any push failure — but now names the collision explicitly when it is one, distinct from the existing warning for a differently-named foreign settings branch found locally.

A permanent push failure is recorded on the branch's metadata as `syncFailureReason`, alongside the existing `syncStatus: 'sync-failed'`, so the editor's sync-failed badge and the admin System Health panel can show why a branch is stuck instead of a generic failure message. It is cleared automatically on the branch's next successful sync, the same pattern used for `rebaseFailure` (see [Rebase Failure Tracking](#rebase-failure-tracking)).

#### Worker CLI

For local development in `dev` mode, the worker can be triggered manually:

```bash
npx canopycms worker run-once
```

This processes pending tasks, refreshes the auth cache, and exits. It simulates what the EC2 worker daemon does continuously in production.

#### Admin Observability and Recovery API

In the Lambda + EC2 worker topology, two things fail silently by default: task-queue/worker health (the worker has no HTTP endpoint, and operators may not have SSM Session Manager access into the instance — see [above](#lambda--efs--ec2-worker-aws-cost-optimized)), and branch directories left in a broken state by a crash mid-provision or mid-write (admins have no direct filesystem access in prod). A namespaced `/admin/*` surface addresses both. Every endpoint is guarded by the same `admin` role check used elsewhere (see [Declarative Guard System](#declarative-guard-system)) and reached through the existing catch-all API route — this is observability and recovery tooling, not a new adopter touchpoint. The Editor's admin-only "System Health" panel is the only consumer (see [Editor Architecture](#editor-architecture)).

**Task queue and worker liveness** (`GET /admin/status`): Task-queue stats (counts per status, oldest pending task's age) are read directly from the task-queue directory. Worker liveness is classified from the mtime of the worker's own lock-heartbeat file rather than a live ping — there is nothing to ping. The staleness threshold is deliberately generous, adding a budget on top of the worker's own stale-lock window to absorb EFS attribute-cache staleness: a reader on a different host than the worker can see a heartbeat mtime that lags the true write by that cache's window, and a tight threshold would misreport a healthy worker as crashed. The worker also self-reports a status snapshot on every sync/task cycle — when its last git sync ran and what happened (branches rebased, skipped as dirty, failed with error), the last sync error, and the last fatal error including startup failures (e.g. an unreachable or corrupted git remote). Only the lock-holding worker ever writes this file, and each write is a full-snapshot replace rather than a partial update, so a reader never observes a half-written report; the endpoint tolerates the file being missing or stale.

**Task recovery** (`GET /admin/tasks/:status`, `POST /admin/tasks/:taskId/retry`, `DELETE /admin/tasks/:status/:fileName`): Lists tasks by status, including a dedicated listing for task files the queue itself could not parse. Retrying a failed task requeues it under a freshly generated ID rather than reusing the original one — the queue's own dequeue path dedupes by ID, so replaying the same ID would be silently absorbed instead of actually retried. Both retry and delete are accepted as safe-to-race with the worker (a task that ends up running anyway is treated as harmless, not prevented) rather than coordinated against it.

**Branch directory health and recovery** (`GET /admin/branch-health`, `POST /admin/branch-dirs/:dirName/purge`, `POST /admin/branch-dirs/:dirName/repair-metadata`): Classifies every directory under the branches root as healthy, corrupt-metadata (a `branch.json` that exists but fails to parse — see [registry quarantine](#why-is-the-branch-registry-a-cache-not-a-source-of-truth)), or orphan (no `branch.json` at all, left behind by a partial delete or an interrupted clone). Purge is reversible: the directory is renamed to a trash name rather than deleted outright, with the trash timestamp embedded in the name itself rather than relied on from the directory's mtime (a rename preserves the original mtime, so mtime-based retention would delete a months-stale orphan's trash on the very first sweep). The worker's sync cycle sweeps trashed directories older than 30 days. Repair-metadata recovers a corrupt-metadata directory by archiving the unparseable `branch.json` alongside itself for forensics and recreating a fresh one with default values — including for the base branch, which is the case that matters most, since a corrupt base branch degrades every request until it's repaired (see [Branch Identity](#branch-identity-defaultbasebranch-vs-defaultactivebranch)).

#### Project-Bound CLI Commands

CLI commands that operate on an existing project (`sync`, `migrate`, `generate-ai-content`, `worker run-once`) resolve the project root by walking up from the current directory to the nearest `canopycms.config.ts` — the same way git discovers `.git`. Running from a subdirectory works, and CMS state (e.g. `.canopy-dev/`) is never scattered into the wrong directory. Running outside a project is a hard failure: the command prints an error and exits non-zero rather than guessing. The same hard-failure stance applies to other CLI preconditions (missing content directory, unknown branch workspace), so scripts and CI can rely on exit codes.

#### Content Sync CLI

In dev mode, the developer's working tree and the CMS editor operate on separate git structures. The developer edits files in their normal repo, while the editor works through branch workspaces cloned from the local bare remote. These two worlds can drift apart: the developer might update content files directly, or an editor might publish changes through the CMS that the developer wants to pull back into their repo.

The `sync` command bridges this gap with bidirectional content synchronization between the developer's working tree and a specific branch workspace. It uses subcommands (`sync push`, `sync pull`, `sync both`, `sync abort`) to make each operation explicit. If no `--branch` flag is provided, sync auto-detects the current git branch from HEAD and targets that workspace. If the workspace does not yet exist for push operations, sync auto-creates it (cloning from the local bare remote), so developers can immediately push content into a new branch without manual workspace setup. Content validation happens before this auto-creation — a push with nothing to push (e.g. a missing or misconfigured content directory) fails fast without leaving a freshly provisioned workspace behind.

- **Push** (`npx canopycms sync push`): Copies the developer's current working-tree content directly into the selected branch workspace and commits it there. This is useful after the developer makes direct content edits outside the CMS. Push does not update the local bare remote; `remote.git` stays current through the normal publish/submit mechanisms.

- **Pull** (`npx canopycms sync pull`): Copies content from a branch workspace back into the developer's working tree. The developer can then review the changes with normal git tools and commit when ready. This closes the loop after content is edited through the CMS.

- **Both** (`npx canopycms sync both`): Performs a proper 3-way git merge between working-tree changes and editor changes. It uses a `canopycms-sync-base` tag (set by each successful sync) as the merge base, creates a temporary branch from that base with the working-tree content, and merges it with the workspace branch. If conflicts arise, the workspace is left in a merge state for manual resolution. On a clean merge, the result is pulled back into the working tree automatically.

- **Abort** (`npx canopycms sync abort`): Cancels a failed merge in a branch workspace by running `git merge --abort`, restoring it to the pre-merge state. This is the recovery path when a "both" sync encounters conflicts the developer does not want to resolve in the workspace.

**Safety guarantees:** Directory replacements during sync use a backup-rename pattern: the old directory is renamed to a timestamped backup, the new directory is renamed into place, and only then is the backup deleted. If the process is interrupted at any point, at least one complete copy of the content always exists on disk. Branch names provided via the `--branch` flag are validated against path traversal (the resolved path must stay within the branches directory), preventing a crafted branch name like `../../etc` from escaping the workspace root.

**Why a separate sync step?** The CMS editor intentionally does not write directly to the developer's repo. Branch workspaces act as a boundary between the developer's git state and the CMS's editing state. This isolation prevents the CMS from creating unexpected commits or modifying the developer's index. The sync command gives the developer explicit control over when content crosses that boundary.

**Why sync does not touch remote.git:** Earlier designs had push update the local bare remote and fan out fetches to all branch workspaces. This was removed because the sync command's purpose is narrow: move content between the developer's working tree and a single branch workspace. The bare remote is kept current by the existing publish and submit flows, and mixing those responsibilities in sync created confusing semantics (especially for the "both" direction).

#### Content Migration CLI

The `migrate` command (`npx canopycms migrate`) converts an existing plain content tree into CanopyCMS conventions: entry files and collection directories are renamed to embed stable content IDs, and `.collection.json` meta files are scaffolded for the root and each collection. Only files of the chosen format are touched — assets and other formats are left alone — and already-conforming names are skipped, so re-running is a no-op. Source-specific ordering conventions (e.g. Nextra's `_meta.json`) are deliberately out of scope: migrated collections fall back to alphabetical ordering, which adopters can refine afterward through the editor. This gives sites with pre-existing content (docs sites, blogs) a one-command on-ramp instead of hand-renaming every file.

### Dev Content Divergence Detection

The content sync CLI closes the gap between the developer's working tree and the editor's branch clones, but only when the developer remembers to run it. In dev mode there are two distinct content readers that can silently disagree:

- The **editor and dev server** read content from the served branch clone under `.canopy-dev/content-branches/<branch>/`.
- The **static build** reads the working-tree `content/**` directly.

When a developer edits working-tree content outside the editor, the dev server keeps serving the stale branch clone until a sync runs. A background watcher surfaces this divergence automatically. Its behavior is controlled by a single dev-only config knob, `dev.contentSync`:

- **`'warn'`** (default): Log a warning that names the diverged files (added, removed, and changed), pointing the developer at `npx canopycms sync push`.
- **`'off'`**: Disable the watcher entirely.

There is intentionally **no auto-push mode**. Auto-overwriting the branch clone from the working tree would silently clobber uncommitted editor "Save" state with no Canopy-level recovery path for the editor. Reconciliation instead goes through the interactive, conflict-aware `canopycms sync push`.

The watcher runs an initial check at dev startup and re-checks whenever a working-tree content file is added, changed, or removed. It re-resolves the served active branch on each check (so it tracks git-HEAD switches the dev server follows) and dedupes across HMR (a restart disposes any prior watcher for the same content directory). It compares the two directories by exact file content (byte comparison, robust to mtime differences), so it only fires on real divergence. It is a no-op outside dev mode, when the working tree has no content directory, or before the branch clone has been created.

**Why this lives in core:** All the divergence-detection logic lives in the core package's watcher. The Next.js adapter merely starts the watcher once at dev startup (a thin, framework-specific trigger), keeping the adapter free of behavior. The watcher extracts and reuses the same non-interactive sync core -- copy, commit, and content-tree diffing -- that backs the interactive sync CLI, so there is a single implementation of "compare two content trees" and "push working-tree content into a branch clone."

**Deliberate non-goal -- no "dev reads working tree directly" mode:** A simpler-seeming alternative would be to have the dev server read the working tree directly, bypassing the branch clone. This was deliberately rejected. The branch-clone model is the foundation of the editing workflow (branch isolation, drafts, ACLs, the publish/submit flow), and a special dev read path that skips it would diverge dev behavior from prod and undermine the guarantee that "every edit happens on a branch." Surfacing divergence (and reconciling it through `canopycms sync push`) preserves the branch-clone model while still giving developers a fast, low-friction loop.

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
- **readByUrlPath()**: URL-path-based content reader that resolves URL paths to entries (tries direct slug match first, then falls back to index entry lookup; root path '/' resolves to the content root's index entry; a path whose last segment is an index slug, in any case, skips the direct-slug attempt, so an index entry is reachable only at its collapsed path). A denied read (no access, or an anonymous request against a private path) resolves to `null` rather than throwing, so a page's ordinary `if (!result) return notFound()` renders a privacy-preserving 404 instead of an unhandled 500 escaping the server component — the same choice (don't reveal _why_ a path is inaccessible) the JSON API already makes by returning 401/403 rather than leaking content. The stricter **read()** always throws on a denied read, for callers that need to distinguish "not found" from "forbidden."
- **buildContentTree()**: Build-time content tree builder (see [Content Tree Builder](#content-tree-builder) below)
- **listEntries()**: Flat content listing for static params, search indexes, sitemaps, etc. (see [Content Entry Listing](#content-entry-listing) below)
- **services**: Access to underlying services if needed
- **user**: Current authenticated user (with bootstrap admin groups applied)

**Resolved filesystem path on single reads:** `read()` and `readByUrlPath()` return a `meta.physicalPath` field — the absolute filesystem path to the resolved entry file. This lets server-side and build-time adopters read artifacts colocated with an entry (e.g. a sibling `profile.json` in the same directory) without re-deriving CanopyCMS's URL-to-filesystem mapping. This is the only place an absolute filesystem path appears on the public-ish surface, and it is deliberately confined to these single-result, server-only readers. It is **not** present on the higher-fanout `listEntries()` (`ListEntriesItem`) or `buildContentTree()` (`ContentTreeNode`) shapes, because Next.js adopters routinely serialize those as component props, RSC payloads, or JSON API responses — keeping them free of absolute paths avoids leaking deployment layout (home directory, EFS mount point, branch name) into output. The field is structurally sealed as server-only: it is reachable only through `canopycms/server`, the bare `canopycms` entrypoint exports types only, the client bundle never imports the context module, and the implementing modules import `node:fs`/`node:path` so a browser build would fail. This complements the server-only, ACL-bypassing nature of `getCanopyForBuild()` and the stripping of internal content IDs from output.

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

**Two-deployment model**: A single codebase can produce both a static export and a CMS server build. The `deployedAs` field in each build's config controls which deployment type is active. This enables patterns like a public-facing static site alongside a separate CMS editor deployment, both reading from the same content repository. At the build-tooling level, the `withCanopy()` Next.js config wrapper supports this via its `staticBuild` option, which controls whether CMS-only files (using the `.server.ts`/`.server.tsx` convention) are included in `pageExtensions`. A content route whose rendering must itself differ between the two builds (prerendered vs. request-time) additionally ships a matching `.static.ts`/`.static.tsx` variant — see [Why split a dual-build content route into static and server page variants?](#why-split-a-dual-build-content-route-into-static-and-server-page-variants). See [Framework Adapters](#framework-adapters) for details.

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
const { getCanopy, getCanopyForBuild, read, readByUrlPath, handler, services } =
  createNextCanopyContext({
    config: canopyConfig,
    authPlugin: clerkAuthPlugin,
  })

export { getCanopy, getCanopyForBuild, read, readByUrlPath, handler, services }
```

The returned `read`/`readByUrlPath` are the phase-selecting helpers (see [Phase-Selecting Read](#phase-selecting-read)); they are the recommended way to resolve a page by path or URL in routes that render in both the build and request phases.

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
- **`getCanopyForBuild()`** is process-scoped. It uses a synthetic admin user with no auth, making it safe to call from `generateStaticParams`, `generateMetadata`, and other non-request-scoped contexts where `headers()` is unavailable. It is memoized for the process lifetime. Beyond `buildContentTree()` and `listEntries()`, it also exposes build-safe `read()` and `readByUrlPath()` so build-time page code can resolve a single entry by path or URL without scanning the whole collection. **Security note:** this context bypasses all branch and path ACLs (synthetic admin, unrestricted filesystem-direct reads) — only use it in build-time code paths that are not exposed to end users at request time. The request-time guard described below enforces this on production server deployments.

This dual-context pattern replaces the need for `isBuildMode()` environment detection in most cases. Instead of the framework guessing whether auth is available, adopters explicitly choose the right context for each call site.

### Build Context Request-Time Guard

Because the build context bypasses all authorization, using it at request time on a deployment that has real users would leak ACL-protected content. The Next.js adapter wraps the build context so that every one of its operations (`read`, `readByUrlPath`, `buildContentTree`, `listEntries`) asserts it is running in a build phase before doing any work.

The guard is scoped to **production server deployments** — it throws only when `mode === 'prod'`, `deployedAs === 'server'`, and the build phase is not active (`isBuildMode()` is false). This is exactly the spot where a real, authenticated user is on the other end and there is no legitimate use of the admin build context: content must instead be read through the request-scoped, ACL-enforcing `getCanopy()` (or the phase-selecting `read`/`readByUrlPath`, which route to it at request time). The guard fails closed, so the misuse surfaces as a thrown error rather than a silent content leak.

The guard is deliberately **prod-only** rather than firing on all server deployments:

- **In dev**, Next invokes legitimate static-generation hooks (`generateStaticParams`, `generateMetadata`) under `next dev` with the same not-build-phase signature as the footgun. There is no reliable way to distinguish those idiomatic calls from an accidental request-time use, so a dev guard would false-positive on correct code. Prod removes that ambiguity (`generateStaticParams` is build-only there), so the guard can be both strict and accurate.
- **On `static` deployments**, ACLs are skipped everywhere by design, so there is nothing to leak and no guard is needed. (`CANOPY_BUILD_MODE=true` marks non-Next static generation as the build phase.)

### Phase-Selecting Read

A page in a `[...slug]`/`[slug]` route needs to resolve content correctly in two different phases: filesystem-direct (working tree) during the build, and branch-aware (the editor's branch-clone preview) at request time in dev. Hand-picking the right context at each call site is error-prone.

To remove that burden, the Next.js adapter also returns phase-selecting `read()`, `readByUrlPath()` and `listEntries()` functions. These pick the context automatically: at build time (`isBuildMode()`) they use the build context; at request time they use the branch-aware, ACL-enforced runtime context from `getCanopy()`. Page code calls one function and is correct in both phases by construction, without ever touching the admin build context directly.

`listEntries()` is the batch counterpart: it returns every entry under `rootPath` in a single filesystem pass, each with its `urlPath`, `slug`, `entryType`, `data` and `schema`. It exists so adopters stop writing "enumerate the routable paths, then read each one" — an N+1 over the content tree whose hand-built URLs are a recurring source of silent misses on multi-segment slugs. The `urlPath` it returns round-trips through `readByUrlPath` by construction.

Note it takes no `branch` option, unlike `read`/`readByUrlPath`: it always lists `defaultActiveBranch ?? defaultBaseBranch ?? 'main'`. In dev that tracks the git HEAD through `refreshActiveBranch()`; in prod that refresh is a no-op, so it always reads the base branch.

### Batch Reads Enforce Path ACLs

`listEntries()` and `buildContentTree()` are the two content reads that return **many** entries at once. On the request-scoped context they enforce path permissions per entry, the same `read` level the single-entry reader checks: entries the current user cannot read are omitted from the result, and — for the tree — from the `meta.indexEntry` passed to a collection's `extract` callback, which emits no node of its own. Collections left with no visible children are pruned. On the build context and on `static` deployments nothing is filtered, since both run as the synthetic admin.

Enforcement reuses `createContentAccessChecker` (`authorization/content.ts`), the same batch primitive the entries API uses: it resolves the request-constant work — branch access, the settings/permissions root, and the rule set — exactly once per request and returns a **synchronous** per-path check, so the per-entry cost is an admin short-circuit or one glob match per configured rule, with no additional I/O. The checker is built lazily and skipped entirely at build time, where it would otherwise add a `getSettingsBranchRoot()` round trip (EFS, in prod) to every listing for a user who bypasses ACLs anyway.

This matters because `getCanopy()` is the context adopters are told to use for request-time content, and it is documented as ACL-enforcing. Before this, its two batch reads took no user at all — so a listing could disclose full entry `data` for paths the same user could not have fetched through `read()`.

## The Permission Model

Access control uses three layers that all must pass. These are implemented in the unified authorization module.

### Layer 1: Branch Access

Per-branch ACLs control who can access a branch. Branches can be restricted to specific users or groups. Admins and reviewers always have access. Implemented in the `branch.ts` submodule.

**Precedence**, highest first: admins/reviewers → a `managerOrAdminAllowed` lockdown → an explicit user/group ACL → and, only when the branch has no ACL at all, the branch's creator, then `defaultBranchAccess`, then the protected base branch.

**Two grants make fail-closed `defaultBranchAccess: 'deny'` workable.** Without them `'deny'` is not a strict default but a broken one, because branch access is ANDed into every content check by `createContentAccessChecker` — so a denial at this layer makes a branch inert, not merely un-submittable:

- **Creator of an un-ACL'd branch.** The create form sends no ACL, so without this every freshly created branch would be unusable by the person who just created it. It also aligns this layer with the three places that already grant on creator-ownership independently (`listBranchesHandler`, `canDeleteBranch`, `canModifyBranchAccess`) — otherwise a creator could delete their branch and rewrite its ACL but not read a file on it.
- **The protected base branch.** It takes no ACL by design (`updateBranchAccessHandler` rejects one, since an entry there feeds `allowed_by_acl` and would confer Withdraw rights), and its `createdBy` is the system, so no other grant could ever reach it — yet it is where every user lands. Applied for anonymous users too, which is what lets a public-read `deployedAs: 'server'` site run `'deny'` with `defaultPathAccess: { read: 'allow' }` instead of opening branch access wholesale.

Both are scoped to branches with **no ACL**, so writing an explicit ACL still restricts the branch — including against its own creator, which is how an admin locks down a branch someone else created. The base-branch grant in particular is applied as a fallback where the bare default would otherwise decide, never as a short-circuit ahead of the ACL: short-circuiting would replace `allowed_by_acl` with `base_branch` and silently strip Withdraw rights from ACL-listed users.

Neither grant widens anything separately gated: `canPerformWorkflowAction` disables its system-branch grant on the same `isProtectedBranch` flag (so the base branch stays unsubmittable), `getBranchWriteProtection().readOnly` still blocks prod writes to it, path permissions still decide what content is readable, and the HTTP handler 401s anonymous callers before authorization runs at all.

### Layer 2: Path Permissions

Glob patterns (e.g., `content/posts/**`) restrict who can edit specific content paths. First matching rule wins. Only admins bypass path rules. Implemented in the `path.ts` submodule.

**Level-scoped defaults**: `defaultPathAccess` (the fallback verdict when no rule matches a path) accepts either a single value applied to every permission level, or an object scoped per level, e.g. `{ read: 'allow' }`. This lets a `deployedAs: 'server'` site declare public read as its default while edit and review stay deny-by-default — the primary use case is a CMS-served site that is also publicly readable without auth. Any level left unspecified in the object form resolves to `deny`, so scoping read access can never accidentally loosen edit or review by omission.

### Layer 3: Content Access

Combines branch and path checks into a single decision. Returns detailed denial reasons for debugging. The `checkContentAccess` function in `content.ts` is the main entry point for most authorization checks.

For listing endpoints that check many paths in one request, `createContentAccessChecker` in the same module is the batch form: it hoists the branch check, the permissions-root resolution and the rule load out of the loop and returns a synchronous per-path checker. Use it — not a loop over `checkContentAccess` — anywhere a single request evaluates more than a handful of paths. Its callers today are the entries API, reference resolution, and the request-scoped `listEntries`/`buildContentTree`.

**Per-request batch checking**: Resolving content access involves request-constant work — verifying branch access, resolving the settings-branch root, and loading the permission rules. When a single request authorizes many paths (for example, listing entries across dozens of collections), repeating that setup per path is wasteful: an entry-listing endpoint that re-loaded permissions and re-resolved the settings root once per entry took tens of seconds for a branch with many collections. The `createContentAccessChecker` factory (exposed on `CanopyServices`) does the request-constant work once and returns a synchronous per-path checker, so each authorization decision is a cheap in-memory rule match. The single-call `checkContentAccess` API is unchanged and now delegates to this batch primitive.

**Why per-request scope rather than a process-global cache?** A global permissions cache would risk serving stale ACLs after a permissions edit — a security-sensitive failure that would require explicit invalidation. Per-request scope sidesteps invalidation entirely and mirrors the prod Lambda model, where there is no cross-request state to cache anyway.

**Reserved groups** provide consistent roles:

- **admins**: Full access to all operations
- **reviewers**: Can review branches, request changes, approve PRs

Helper functions (`isAdmin`, `isReviewer`, `isPrivileged`) provide convenient role checking.

**Where permissions are stored:**

- **Dev mode**: Settings on orphan branch `canopycms-settings-{deploymentName}`, workspace at `.canopy-dev/settings/` (gitignored, local development only)
- **Prod mode**: Settings on orphan branch `canopycms-settings-{deploymentName}`, workspace at `{workspaceRoot}/settings/` (version-controlled, deployment-specific)
- Branch ACLs are stored in each branch's metadata file (`.canopy-meta/branch.json`); saves to this file are protected by a server-enforced cross-host lock, so an ACL or status update can't be silently lost when two hosts write it at once (see [docs/concurrency.md](docs/concurrency.md))

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

This dual-layer approach is necessary because Lambda instances share an EFS filesystem but each instance has its own process memory. The file lock ensures only one instance initializes the workspace at a time, while the in-memory lock avoids redundant concurrent calls within a single instance. This same lock is also what makes the branch-identity guard below race-safe (see [Deployment Name Resolution](#deployment-name-resolution)).

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

### Deployment Name Resolution

Every place that computes the settings branch name (`canopycms-settings-{deploymentName}`) needs to agree on `deploymentName`, and that value can come from three places: an environment variable, the adopter's config, or a mode-specific default. A single resolver settles this once and is used by both mode strategies' `getSettingsBranchName`, so the resolved name is the same everywhere it matters.

**Precedence: environment variable, then config, then mode default (`prod` for prod, `local` for dev).** The environment variable deliberately outranks config, which inverts what might seem like the more intuitive order. The reasoning: the env var is stamped per-stack by infrastructure (the CDK service construct's `deploymentName` prop, surfaced as `CANOPYCMS_DEPLOYMENT_NAME`), so it's the value guaranteed to _differ_ between two deployments that share a repo. `config.deploymentName` lives inside the shared repo checkout itself, so it's guaranteed to be _identical_ across both deployments' running processes. If config took precedence, an adopter who had already set `deploymentName` in their (shared) config would find the infrastructure-level override silently doing nothing — exactly the two-stacks-one-repo scenario this feature exists to solve. When both are set and disagree, a one-time warning names both values so a genuine misconfiguration isn't silent.

**One resolver, everywhere it matters:** settings-branch-name computation used to have three independent call sites that could disagree — the mode strategy, the settings API helper (which forwarded only a hand-picked subset of config to the strategy, silently dropping `deploymentName`), and the HTTP context builder (which used its own hardcoded literal with no deployment suffix at all). All three now route through the same resolver, so the branch CanopyCMS auto-provisions on first settings access is guaranteed to be the same branch every other settings operation reads and writes.

**Refusing to boot on a changed settings branch:** Initializing an _existing_ settings workspace never re-clones — it goes straight to checking out the resolved orphan branch. If that resolved name isn't already a local branch there, git orphan-checks-out, wipes the working tree, and commits empty. Orphan branches share no history with what came before, so this permanently destroys `permissions.json`/`groups.json` with nothing left to recover. To turn a `deploymentName`, `settingsBranch`, or `CANOPYCMS_DEPLOYMENT_NAME` change — on a deployment whose settings workspace already holds real data — into a loud failure instead of silent data loss, workspace initialization now checks whether a settings workspace already exists on disk and, if so, whether it's already checked out on the newly-resolved branch. A mismatch throws before any git operation runs, naming both branches so the operator can restore the previous value (or deliberately move the workspace aside to start fresh). No migration is attempted, since there is nothing to migrate from once an orphan checkout has happened. This check runs inside the same cross-process lock described above, so two hosts racing to initialize the workspace can't each independently decide it's safe and both destroy it.

## Content Workflow

### Creating and Editing

1. User opens or creates a branch
2. System opens existing workspace or creates new clone (in prod modes)
3. User makes edits through the editor UI
4. Each save writes directly to files in the branch workspace
5. Live preview shows changes immediately

### Save-Time Validation

Saves run through server-side validation in the content write handler:

- **Adopter validation hook**: The config can supply a `validateEntry` hook — an adopter-defined function that runs before the entry file is written. The hook returns issues at two severities: `error` issues reject the save (HTTP 422 carrying the hook's message, nothing written to disk), while `warning` issues let the save proceed and ride back on the write response, where the editor surfaces them as notifications. This gives adopters site-specific rules (cross-field constraints, content conventions, link policies) enforced for every write, not just well-behaved clients.
- **Entry-link validation**: Alongside the write, body content and markdown fields are scanned for `entry:ID` links whose targets no longer exist. These produce warnings only — saves are never blocked by a broken inline link (see [Entry Links](#entry-links-inline-content-links)).

**Why a config hook rather than a new integration point?** Adopter touchpoints are deliberately limited to config + Editor + one API route. `validateEntry` lives inside the existing config touchpoint, so adopters gain a save-time extension point without any new wiring between their app and CanopyCMS.

### Submitting for Review

1. User clicks "Submit"
2. Service layer commits all changes and pushes to remote (via `submitBranch()`)
3. GitHub PR is created (if GitHub integration configured)
4. Branch status changes to "submitted"

**Important**: Clicking "Submit" requests publication—it does not actually publish. The content becomes live only after the PR is merged on GitHub and the site is rebuilt/deployed. This separation means CanopyCMS doesn't control the actual publication moment; that's handled by your CI/CD pipeline.

This flow applies to editing branches. The base branch itself can never be submitted—see [Protected Base Branch](#protected-base-branch).

### Review Process

1. Reviewers see submitted branches and can add comments
2. Comments attach to specific fields, entries, or the whole branch
3. Reviewers can approve or request changes
4. Requesting changes returns branch to "editing" status

**Content is read-only while under review.** Once a branch leaves `editing` status (`submitted`, `approved`, or `archived`), the server write boundary rejects content saves, entry creation, and schema mutations with the same kind of 403 used for the protected base branch — a branch mid-review shouldn't have its content shift under the reviewer. The editor mirrors this on the client: Save is disabled, entry-tree mutations are hidden, and a status banner explains why. Comments are exempt from this lock by design, since they're the review mechanism itself and must stay writable while a branch is submitted. Withdrawing or requesting changes returns the branch to `editing` and immediately re-enables writes. Request-changes requires `submitted`; withdraw accepts `submitted` or `approved`, which makes it the general unlock — an approved branch's only non-destructive way back (whether `approved` should exist at all is still open; see [approved-status-dead-end.md](.claude/future-tasks/approved-status-dead-end.md)). A branch whose `status` cannot be read at all is also treated as locked: `branch.json` is parsed without schema validation, so the write guard fails closed rather than guessing.

**Submitting follows the same rule as writing.** Only an `editing` branch may be submitted, and an unreadable status fails closed exactly as it does for writes — submitting a branch you are not allowed to edit is incoherent, since its content cannot have changed since the last submit. This is enforced in the submit handler alongside the three sibling transitions (withdraw, approve, request-changes), each of which returns a 400 naming the offending status. The `submittableBranch` route guard answers a different question — whether this is the protected base branch — and reads no status at all. Without the handler check, a merged (`archived`) branch could be re-submitted: the working tree is clean so nothing would be committed, but the branch would be re-stamped `submitted` and the PR sync would either overwrite the merged PR's title and body or, in prod, fail permanently against a PR that can no longer be reopened.

### Merging and Archiving

Merge detection is automatic. Once a branch is `submitted` or `approved` and has a recorded PR, the worker's sync cycle polls GitHub for that PR's resolution on every pass (see [Branch Synchronization and Conflict Detection](#branch-synchronization-and-conflict-detection)):

1. PR is merged on GitHub (outside CanopyCMS, by someone with merge permissions)
2. On its next sync cycle, the worker detects the merge via the GitHub API and archives the branch itself — status moves to "archived", `pullRequestState` is stamped `merged`, and `mergedAt` records when
3. Site rebuild/deploy happens via other processes (e.g. CI/CD)

If the PR is closed on GitHub **without** merging, the worker records `pullRequestState: 'closed'` but leaves the branch's status untouched — a closed PR isn't necessarily terminal (it can be reopened), so an admin decides the next step rather than the worker guessing. The editor surfaces this as a red "closed" PR badge and disables request-changes (which assumes an open, convertible-to-draft PR); withdraw stays available as the recovery path back to `editing`.

A `markAsMerged` API endpoint still exists, now as a manual/ops fallback rather than the primary path — useful when the worker isn't running or an admin wants to force-resolve a branch immediately instead of waiting for the next poll cycle. It accepts a branch in either `submitted` or `approved` status (matching the automatic path, which archives from either), so the manual fallback can reach anything the worker's poll could reach — including the case where the worker is down, or the PR was merged and then deleted from GitHub before a poll cycle ran. It verifies the merge via the GitHub API and builds its update through the same shared helper as the automatic path, so both produce identical archived-branch metadata.

### Publish State Is Branch-Only

There is **no per-entry draft or published field**, and there will not be one. Publish state is a property of the _branch_, not the entry:

| State                      | How it is expressed                              | Public?                                                                                                                   |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Not published              | The entry lives on an unmerged branch            | No — not built, no URL                                                                                                    |
| Published                  | The entry's branch has merged to the base branch | Yes                                                                                                                       |
| Published but unadvertised | Merged, with the SEO `noindex` field set         | Yes — built and reachable by direct link, but absent from sitemap, RSS and index grids, and served with `robots: noindex` |

Two consequences follow, and both are load-bearing:

- **`noindex` is not a hiding mechanism.** It means "don't index", not "don't exist" — the page is built and its URL resolves for anyone holding the link. If content must not be publicly reachable at all, it must not be merged.
- **Enumeration helpers must not invent a publish filter.** `collectStaticPaths` and `collectRoutableEntries` apply no publish filtering at all — not even on `noindex` — because everything they can enumerate is by definition already published, since it merged (see [Static-Export Helpers](#static-export-helpers) below). `noindex` exclusion happens only on the surfaces that _advertise_ an entry, namely the sitemap helper, not on enumeration itself.

**How to unpublish:** delete the entry on a branch and merge that branch. This is recoverable — `git revert` restores the file byte-for-byte including its content ID. Note that `validation/deletion-checker.ts` blocks deleting an entry that other entries still reference, so inbound links must be fixed first; that guard is the reason a soft "archived" state would save no work.

**The corollary:** don't merge unfinished content. Work in progress stays on its branch, which means content branches may legitimately be long-lived — see [content-lifecycle-scenarios.md](.claude/future-tasks/content-lifecycle-scenarios.md) for the staleness and recovery guardrails that implies.

Decided 2026-08-14; rationale and the rejected alternatives are recorded in [draft-publish-lifecycle.md](.claude/future-tasks/draft-publish-lifecycle.md).

## Branch Synchronization and Conflict Detection

When the base branch (typically `main`) receives new commits from merged PRs, active editing branches can fall behind. The worker daemon periodically rebases these branches to incorporate upstream changes, and surfaces conflicts to editors through a non-blocking notification system.

### Rebase Behavior

The worker's synchronization cycle fetches the latest base branch from GitHub into the local bare repo, fast-forwards the base branch's own workspace clone to match it, then iterates over all other active branch workspaces and rebases them. Previously that base-branch clone was refreshed only incidentally, by the same generic rebase loop that handles other branches: for a clone in `editing` status, rebasing onto `origin/<baseBranch>` degenerates to a fast-forward when the clone IS the base branch. But that loop's skip paths — a dirty tree, a missing `.git` — were silent, the suspected live failure mode behind a wedged base view with no diagnosable signal. A dedicated step now fast-forwards it (`merge --ff-only`) explicitly every cycle and invalidates its content caches when it advances. This clone must stay a linear mirror of the remote: an unprovisioned workspace is a quiet skip, but a dirty working tree or a non-fast-forward (diverged local history) state is a loud error left untouched, since nothing else would surface a silently wedged base view. (This is a different non-fast-forward condition from the cross-deployment push-rejection collision in [Push Rejection Classification](#push-rejection-classification): this one concerns the base-branch clone's own local history falling behind `origin/<baseBranch>` when fast-forwarding inward, not a push outward to GitHub.)

**Branches that are skipped by the rebase loop:**

- **The base branch's own workspace**: Kept current by the fast-forward step above, not this loop — routing it through the `--theirs` conflict-resolution path below could rewrite its history.
- **In review** (`submitted` or `approved` status): Rebasing would rewrite commit history under a PR that reviewers are actively looking at. These branches are left untouched until they return to `editing` status — but the same cycle polls GitHub for their PR's resolution (see [Merging and Archiving](#merging-and-archiving)), since nothing else tells the worker a merge or close happened.
- **Archived**: Already merged branches have no reason to be rebased or polled — there's no open PR left to check.
- **Dirty working tree**: If the branch has uncommitted changes (an editor is actively saving), rebasing would fail or destroy their work. The worker skips the branch and tries again on the next cycle.

**Clean rebases**: When no files conflict, the rebase applies cleanly. The branch gets the base branch's latest changes, and any previous conflict state is cleared.

### Publishing a Rewritten History

A rebase rewrites commits. When the branch had already been submitted, its pre-rebase history is in `remote.git` and on GitHub, and the rewrite leaves the clone unable to push to either: the editor's next submit no longer contains `remote.git`'s tip and is rejected. This is reachable whenever a submitted branch returns to `editing` — request-changes, withdraw, or admin repair-metadata — and then falls behind base, so it typically strikes a branch with an open PR, where the old "rename the branch" advice would have orphaned it.

The loop therefore publishes what it rewrites, on both hops, each under a lease keyed to the exact commit the rebase replaced (recorded on the branch as `historyRewrittenFrom`): a force-push into `remote.git`, then a queued `push-branch` task that carries it to GitHub so an open PR's head follows within a cycle. Ordering is **record the marker, push, then queue** — every crash window then leaves the marker set with the work unfinished, and a self-heal pass at the top of each branch's turn finishes it without waiting for another base-branch advance. The marker is cleared only once GitHub is confirmed to hold something other than the commit that was rewritten.

**The arming guard** is what makes the force safe, and it is not belt-and-braces. Branch clones are `--single-branch` and never fetch their own branch, while `reconcileTrackedBranches` fast-forwards `remote.git` to GitHub's tip — so after a reviewer pushes a fixup straight to the PR branch, `remote.git` legitimately holds a commit the clone has never seen. The loop therefore force-publishes **only when `remote.git` holds exactly the commit the clone is about to rebase away**. A lease keyed to "whatever `remote.git` currently holds" would have been satisfied in the reviewer-fixup case and would have deleted that fixup from `remote.git` and then from GitHub, silently. Anything else is left untouched and recorded as a rebase failure the editor can see.

Between the local publish and the GitHub push landing, such a branch reads as diverged from GitHub. `reconcileTrackedBranches` recognizes the marker and reports these separately (`rewritten` rather than `diverged`) so the cross-deployment collision warning keeps meaning what it says.

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

### Rebase Failure Tracking

Conflict resolution (above) is the expected, handled case: files differ, the editor's version wins, and the branch moves on. A rebase can also fail outright — an unexpected git error, or exhausting the safety limit on conflict-resolution rounds — which means the automatic recovery itself broke down and the branch is stuck behind the base branch until someone intervenes. The worker records this as a distinct, persistent `rebaseFailure` marker in the branch's metadata (a message plus first-seen and last-seen timestamps), separate from `conflictStatus`/`conflictFiles`.

To avoid write amplification, a branch that fails every cycle is only re-recorded roughly once an hour rather than on every cycle — each metadata save eager-regenerates the branch registry, so recording unconditionally would multiply that cost across every stuck branch on every worker pass. The marker is cleared automatically once the branch catches up to the base branch cleanly, or when its editor submits it for review — the rebase loop skips submitted/approved branches, so without an explicit clear on submit a stale failure would otherwise persist through the entire review cycle.

This is an operator-facing signal, not an editor-facing one: a stuck rebase means the worker needs attention, not something an editor can act on. It surfaces only in the admin System Health panel's branch list (see [Admin Observability and Recovery API](#admin-observability-and-recovery-api)), not in the editor's own conflict notices below.

### Editor Conflict Notification

Conflicts are surfaced to editors at three levels in the UI:

- **Entry-level notices**: When an editor opens an entry that has a content conflict, the editor form displays a non-blocking informational notice at the top of the form. The notice tells the editor that someone else recently changed the same content and that a reviewer will reconcile the changes during the review process.
- **Collection-level badges**: When a collection's `.collection.json` conflicted during rebase, the sidebar navigation shows a conflict badge on that collection. This alerts editors that the collection structure (ordering, entry type configuration) may need review, even if individual entries within the collection are unaffected.
- **Branch-list badges**: The branch picker itself shows a conflict-count badge alongside a sync-status badge (`pending-sync` / `sync-failed`, from the same metadata `syncStatus` field described in [Task Queue](#task-queue-async-github-operations)) next to each branch name. Unlike the admin-only System Health panel, these badges are visible to any user who can see the branch — they're informational summaries of state every editor on that branch already needs, not a recovery surface. A `sync-failed` badge's tooltip shows the recorded `syncFailureReason` when one is present (e.g. a push-rejection collision, see [Push Rejection Classification](#push-rejection-classification)), falling back to generic text otherwise.

The entry- and collection-level notices use the same `conflictFiles` array from branch metadata, matching each item's ContentId against the recorded conflict IDs.

**Design decisions behind this approach:**

- **Conflicts are non-blocking**: Editors can continue editing and submitting normally. The conflict is informational, not a gate. This prevents editors from being stuck on merge conflicts they don't understand.
- **Reviewer reconciliation**: The PR on GitHub will show the full diff, including the editor's version of conflicted files. Reviewers (who understand the content) can decide how to reconcile.
- **No editor-facing git concepts**: The notice uses plain language about "recent changes" rather than exposing git terminology like "rebase conflict."
- **Per-item granularity**: Notices appear only on the specific entries or collections that conflicted, not on the entire branch. This is possible because conflicts are tracked by ContentId.

## Reference System

The reference system allows content to link to other content entries using stable content IDs. This enables relationship modeling, cross-references, and maintains data integrity.

### Reference Fields

Reference fields are schema fields that can reference other entries by their content ID. Each reference field must specify at least one scoping constraint to control which entries are valid targets:

- **Collection scope** (`collections`): Limits references to entries within specified collections, including all subcollections. For example, scoping to a "data-catalog" collection also includes entries in "data-catalog/openstax" and any other nested subcollections. This uses tree traversal rather than exact collection matching.

- **Entry type scope** (`entryTypes`): Limits references to entries of specific entry types by name (e.g., only "partner" entries), regardless of which collection they live in. This is useful when the same entry type appears in multiple collections or subcollections and you want to reference all instances.

These two scoping mechanisms can be combined. When both are specified, collection scope narrows the search space first, then entry type filtering is applied within those results. When only `entryTypes` is specified (no collection scope), the system searches all entries across the entire content store via the ID index.

**Entry-type scope validation**: The entry type names listed in a reference field's `entryTypes` scope are checked against the entry types actually declared in the branch's schema — a misspelled or nonexistent name fails schema resolution outright, with a "did you mean" suggestion, rather than silently resolving to an empty reference picker. This check cannot happen when field schemas are first registered: entry types are declared per-branch, in on-disk collection metadata, so the valid set doesn't exist until a branch's schema has actually been resolved. It runs as part of that resolution step, before the resolved schema is cached, so a bad scope fails consistently on every load of that branch rather than only when the cache happens to be cold.

References can:

- **Scope by collection tree**: Constrain references to entries in a collection and all its subcollections
- **Scope by entry type**: Constrain references to entries of a specific type across all collections
- **Combine both scopes**: Use collection and entry type constraints together for precise targeting
- **Support both single and multiple references**: A field can reference one entry or an array of entries
- **Be validated**: The system checks that referenced IDs exist and satisfy both collection and entry type constraints

### Reference Resolution

The `ReferenceResolver` class handles loading and displaying referenced content:

- **Resolve single ID**: Convert a content ID to its display value (e.g., post title)
- **Load reference options**: Dynamically fetch all available options for a reference field (used for dropdown/select UI). Supports collection-scoped queries (with subcollection tree traversal), entry-type-scoped queries, or both combined.
- **Search and filter**: Find reference options by search term, collection constraints, and/or entry type constraints
- **Batch resolution**: Resolve multiple IDs efficiently

### Reference Validation

The `ReferenceValidator` class ensures reference integrity:

- **ID format validation**: Checks that ID strings are valid short UUIDs
- **Existence validation**: Verifies that referenced entries actually exist
- **Collection constraint validation**: Ensures referenced entries belong to allowed collections
- **Entry type constraint validation**: Ensures referenced entries match allowed entry types (checked by extracting the entry type from the filename)
- **Detailed error reporting**: Reports which reference field failed validation and why, including mismatched collection or entry type

Validation can run on entire entries or individual references, supporting both batch checks during content saves and real-time validation in the editor.

### Reference Integrity Checking

Before deleting an entry, the system checks for broken references:

- **Identify all references**: Find which entries reference the entry being deleted
- **Report referrers**: Show users which content would be broken
- **Prevent cascade deletes**: Entries with incoming references can be marked as "deletion blocked"

This prevents orphaned references and keeps the content relationship graph intact.

### API Endpoints

**GET /:branch/reference-options**: Dynamically load reference options

- Query parameters: `collections` (comma-separated, optional), `entryTypes` (comma-separated, optional), `displayField`, `search`. At least one of `collections` or `entryTypes` is required.
- Returns: Array of options with ID, label, and collection
- Used by editor to populate dropdowns with current available entries

**POST /:branch/validate-references/:path\***: Validate references in an entry

- Checks all reference fields in the entry data
- Returns: Validation result with any errors found
- Provides real-time feedback in the editor

### Entry Links (Inline Content Links)

Reference fields work well for structured data (e.g., "this post's author is Alice"), but content authors also need to link to other entries from within prose. Entry links extend the reference-by-ID pattern from structured fields to inline links in markdown body content.

**Syntax**: Entry links use a markdown link with the `entry:` protocol and a 12-character content ID:

```markdown
See the [Getting Started guide](entry:vh2WdhwAFiSL) for setup instructions.
You can also jump to the [API section](entry:a1b2c3d4e5f6#authentication).
```

This reuses the same immutable content IDs already used for reference fields, so entry links survive renames and moves just like reference fields do. The optional anchor fragment (`#section`) is preserved through resolution.

**Why a custom protocol instead of file paths?** File paths break when content is renamed or reorganized. Content IDs are stable identifiers embedded in filenames that persist across slug changes, collection moves, and restructuring. By using the `entry:` protocol, authors get links that never go stale as long as the target entry exists.

**Resolution at read time**: Entry links are resolved in `ContentReader.read()`, parallel to existing reference resolution. The resolver scans body content for `entry:ID` patterns, looks up each ID in the bidirectional content ID index, computes the URL path from the entry's location in the content tree, and replaces the `entry:ID` with the resolved URL. This happens server-side at read time, so adopters receive fully-resolved URLs without any changes to their rendering pipeline. Resolution is enabled by default and can be disabled per-read via the `resolveEntryLinks` option.

**Code-block protection**: The resolver skips fenced code blocks and inline code spans to avoid corrupting code examples that mention the `entry:` syntax.

**Missing targets**: If a referenced entry no longer exists, the link is replaced with `#` (a dead anchor) and a warning is logged. This graceful degradation ensures pages still render even with broken links.

**Custom URL schemes**: Adopters can provide an `entryLinkUrl` callback in the config to override the default URL computation. This supports cases where the site's URL structure doesn't match the content tree layout (e.g., localized paths, custom routing).

**Live preview**: The editor resolves entry links client-side for the live preview iframe. A React hook builds a lookup map from content IDs to URL paths using the editor's loaded entry list, then transforms body content before it reaches the preview frame. This is a lightweight, synchronous resolution that avoids API calls during preview updates.

**Editor UI**: The markdown editor toolbar includes an "Insert Entry Link" button that opens a searchable modal. Entries are grouped by collection and filterable by name, slug, or collection. Selecting an entry inserts `[Entry Title](entry:CONTENT_ID)` into the editor at the cursor position.

**Validation**: On save, the system scans body content and markdown/MDX fields for `entry:ID` patterns and checks that each referenced ID exists. Broken entry links produce warnings, not errors -- saves are never blocked by missing link targets. This parallels reference validation but uses a softer stance because inline links in prose are less structurally critical than typed reference fields.

**AI content pipeline**: The AI content generation engine resolves entry links to URLs in its markdown output, ensuring AI consumers see clean, navigable links rather than internal `entry:` references.

**Design rationale**: Entry links were designed to integrate with the existing content ID infrastructure rather than introducing a parallel identification system. By reusing content IDs, the feature inherits all the stability and rename-safety guarantees already built into the reference system. The read-time resolution approach means zero adoption cost -- no rendering pipeline changes, no new template helpers, no client-side resolution library needed by adopters.

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
- Comment writes are safe under concurrent reviewers, including two different Lambda containers writing at the same moment: an in-process mutex, a server-enforced cross-host lock, and per-write version checks compose so a comment can't be silently lost to a concurrent write on another host (see [docs/concurrency.md](docs/concurrency.md))

## Editor Architecture

The editor provides a rich editing experience with schema-driven forms, block-based page building, and live preview.

**Bundle separation**: Public sites can be built without any editor code. The editor is exported from `canopycms/client` and can be imported only where needed. This means your production site visitors never download editor JavaScript. At the file level, CMS-only routes (API handlers, editor pages) use the `.server.ts`/`.server.tsx` extension convention. The `withCanopy()` config wrapper controls whether Next.js processes these files, so static builds exclude them entirely rather than relying on tree-shaking alone.

**Integration options:**

- Embed editor in the same Next.js app (simpler setup)
- Run editor as a separate application (stricter separation)
- Public sites can optionally import and embed the editor, but they don't have to

**Server imports**: Adopting apps also import from `canopycms/server` for content reading and API setup.

**Live preview**: The editor can show a live preview of content changes. The preview is an iframe that loads your actual site pages, and the editor communicates with it via postMessage. When you edit a field, the preview updates immediately. Clicking on elements in the preview focuses the corresponding form field. This preview bridge enables real-time feedback without page reloads.

### Preview Bridge Trust Model

The preview bridge is a postMessage channel between two windows, and the site side of that channel feeds incoming draft data straight into the host site's renderer (often MDX evaluation). An unvalidated message listener would therefore let any window with a handle on a preview page (e.g. via `window.open`) execute arbitrary content in the site's origin. Trust is explicit on both sides of the bridge:

- **Site-side preview hooks** (`useCanopyPreview` and the lower-level preview hooks) attach message listeners only when the page is actually framed, and accept a message only if it comes from the direct parent frame (`event.source === window.parent`) AND its origin matches the expected editor origin. The expected origin defaults to the page's own origin, so same-origin editor/preview setups need no configuration; deployments that serve the editor from a different origin pass an optional `editorOrigin` to the hooks.
- **Editor-side listeners**: the preview frame's ready/error handler applies the same source-plus-origin validation (`event.source` must be the preview iframe's `contentWindow` and the origin must match the origin pinned from its `src`). The comment system's preview-focus handler validates origin only — it lives outside `PreviewFrame` and has no handle on the iframe, and the message can at most scroll/focus a form field.
- **All outbound bridge messages** target a concrete origin — derived from the iframe `src` on the editor side, and the configured (or same-) editor origin on the site side — never the `'*'` wildcard. Draft content cannot be delivered to a frame that has navigated elsewhere. Opaque origins (sandboxed embeds, which serialize to the string `'null'`) are never trusted inbound and never posted to.

### Preview Error Reporting

The bridge also carries a preview-to-editor error channel. When a draft fails to compile or render (e.g. malformed MDX), the preview page calls the `reportError` helper returned by `useCanopyPreview`, optionally tagging the offending field, and calls it again with `null` once the draft renders cleanly. The editor surfaces the report as an alert over the preview pane, so authors see why the preview is broken instead of a blank or stale frame. Without this channel, a render error inside the iframe is invisible to the editor — the iframe simply stops updating.

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
- **useDraftManager**: Draft state and localStorage persistence. Drafts exist only where the user actually edited — opening an entry seeds nothing, since `effectiveValue` falls back to `loadedValues`. Each draft is persisted under `canopycms:drafts:<branch>` in a `{ v: 2, drafts, baseVersions }` envelope; `baseVersions[contentId]` is the server OCC version the draft was based on (from `useEntryManager.getEntryVersion`), and a save whose base no longer matches the currently held token — including a draft restored from the pre-v2 format, which has no recorded base — surfaces the 409 conflict notification instead of writing. Both destructive actions ("Discard draft" and "Reload File") confirm first when the selected entry is dirty.
- **useCommentSystem**: Comment threading and resolution
- **useGroupManager**: Group administration
- **usePermissionManager**: Permission rule management
- **useReferenceResolution**: Async reference data loading with caching
- **useEntryLinkResolution**: Client-side entry:ID link resolution for live preview

This extraction keeps components focused on rendering while hooks encapsulate business logic and side effects.

### Data Loading: SWR-Backed Fetch Hooks

The editor's three fetch-on-load resources — the branches list, a branch's entries plus schema, and comment threads — each have a dedicated hook built on `swr`, a client-side data-fetching/caching library. Each hook exports a plain async fetcher, a cache-key function, and a thin wrapper around `useSWR(key, fetcher)`; the corresponding manager hook (`useBranchManager`, `useEntryManager`, `useCommentSystem`) mirrors the data hook's reactive `data`/`error`/`isValidating` onto its own state and busy flags.

This replaced three independent `useEffect([branchName])` fetch effects, each of which fired twice under React Strict Mode's mount-cleanup-remount cycle — plus a fourth duplicate schema fetch that the editor shell ran separately on branch change, now eliminated by reading `availableSchemas` off `useEntryManager`'s return value instead of fetching it again. A shared SWR cache (configured with `revalidateOnFocus: false`, `shouldRetryOnError: false`, and a short deduping window) gives every automatic on-mount/on-branch-change fetch built-in request deduping, so concurrent requests to the same cache key collapse into one.

**Automatic load vs. explicit reload**: only the automatic fetch goes through `useSWR`. Each manager hook's imperative reload function (branch reload, comment reload, entry refresh) intentionally does not use SWR's `mutate()` revalidate form — it issues an independent, un-deduped fetch instead, because a caller that just wrote content needs to see its own change reflected immediately rather than coalesced with a still-in-flight automatic load — and then writes the result into the SWR cache with `mutate(key, data, { revalidate: false })`, keeping the bound data hook's reactive state in sync without a second request. The entry-refresh path additionally guards every commit of fetched entries state with a PER-BRANCH "committed sequence" rule — commit anything at least as new as what that branch's view already shows, and never a tag for a branch other than the one currently displayed. Per-branch rather than a single global counter, deliberately: SWR replays a branch's cached (tagged) result when the user switches back to it, and under a global counter any intervening branch's load had already advanced the count, so the replayed cache hit was rejected — and inside the deduping window no revalidation followed, leaving the PREVIOUS branch's entries on screen under the new branch indefinitely. A response older than what its branch already displays is still rejected (and triggers a revalidation of that branch's now-stale cache slot), and a refresh settling after the user switched away commits nothing.

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

### Admin: System Health Panel

The editor has an admin-only "System Health" panel — the first UI surface in the editor gated to a single role rather than to branch/path permissions. It is a thin view over the [Admin Observability and Recovery API](#admin-observability-and-recovery-api): an Overview tab (task-queue stats, worker liveness, the worker's self-reported git-sync summary), a Tasks tab (list/retry/delete task files), and a Branches tab (branch-health classification plus purge/repair-metadata actions, and the manual "mark as merged" fallback).

Visibility is the caller's responsibility, not the panel's own: the editor shell checks the current user's admin membership before rendering the button that opens the panel, the same pattern used for the group and permission managers. The real enforcement is server-side — every endpoint the panel calls carries the same `admin` guard as the rest of the API (see [Declarative Guard System](#declarative-guard-system)) — so the client-side check is purely a UX convenience (no admin-only menu item for a non-admin) rather than the security boundary.

## Asset & Media System

CanopyCMS manages binary media (images and PDFs) outside of git. Content references assets by immutable, content-addressed key; the bytes live in a separate object store, and images are resized/reformatted on demand at delivery time rather than at upload time.

The full design record — including rationale, the AWS deploy mechanics, and the rejected upload-time-width-ladder alternative (Plan A) — lives at `.claude/future-tasks/assets-media-system.md`. This section covers the architecture; that record covers the "why we didn't do it the other way."

### Content-Addressed Storage

Assets are stored in a single bucket (in prod, new prefixes inside each site's existing content bucket) under a fixed set of prefixes, keyed by a content hash (sha-256 truncated to 128 bits) rather than by a path an editor chooses:

- `asset-originals/` — private, full-fidelity originals, kept forever
- `asset-staging/` — short-lived presigned-upload target (expired by a lifecycle rule)
- `asset-meta/` — private per-asset sidecar (original filename, uploader, date, dimensions, mime)
- `assets/` — public static delivery for sanitized SVGs and PDFs only
- `assets/t/` — transform outputs, where the URL path _is_ the S3 key

Keys are **immutable, content-addressed, and unguessable**. Nothing is overwritten or eagerly deleted, and identical bytes deduplicate (the first uploaded filename wins). This is what gives assets **branch-awareness without git storage**:

- A draft branch's newly uploaded image is fetchable-but-unguessable immediately — "unlisted link" semantics — so drafts and PR previews render it before the referencing content is published.
- Publishing needs no asset-promotion step, because the reference already points at the final key.
- Rollback always resolves, because old keys are never deleted.

**Unlisted is not private.** Key enumeration is an accepted trade-off (the meta listing that powers the media library is open to any authenticated user); confidential files do not belong in this store. Deleting an asset removes only its meta sidecar — blobs are immortal until a future garbage-collection task.

### Upload and Finalize

Uploads go **directly from the browser to S3** via a presigned POST (with a content-length cap and type conditions). The bytes never traverse the CMS's request path, so the serverless function's small request-body limit is irrelevant, and presign generation is local crypto that needs no outbound internet.

After the browser upload lands in staging, the editor calls a **finalize** step that runs synchronously in the CMS API process (the CMS Lambda in prod, the dev server in dev). Finalize sniffs the real file type from magic bytes, sanitizes SVGs (which cannot be type-sniffed and are explicitly parsed and stripped of scripts), extracts dimensions (honoring EXIF orientation), writes the original and meta sidecar (and a public copy for SVG/PDF), deletes the staging object, and returns the complete structured field value. The commit-point ordering is deliberate — dedup check, then original, then meta — so a crash never leaves a meta record pointing at bytes that were never written. Finalize is lightweight (milliseconds); the heavyweight image library (sharp) is intentionally **not** in the CMS process.

### On-Demand Image Transforms

Raster images are always served through the transform layer, never as raw originals — this guarantees EXIF stripping and bounds the set of derivatives. A transform URL encodes an imgix-style directive set (allowlisted width, format, quality, and a normalized crop rectangle) as a path segment: `assets/t/{directives}/{hash}/{slug}`. Because the URL path is the S3 key, transform outputs are cacheable static objects once produced.

Delivery uses a **CloudFront origin group with failover**:

1. The signed S3 origin is tried first. On a cache/S3 miss (403 or 404), CloudFront fails over to a transform Lambda behind an OAC-locked Function URL.
2. The Lambda reads the original, applies the directives, strips EXIF, and **writes the canonical output key to S3 first**, then serves the bytes. For outputs too large for the Function URL's buffered response cap (and for the transform-failure fallback), it returns a `302` redirect with `Cache-Control: no-store` to the now-satisfiable S3 URL — the `no-store` is load-bearing, because caching the redirect instead of the image is a known trap.
3. The next request for that URL hits the S3 object directly; the Lambda is a fill-on-miss path, not a per-request resizer.

The Function URL is locked to CloudFront (OAC / IAM) so the transform Lambda cannot be invoked directly to stuff the cache with arbitrary variants, and the directive allowlist bounds the variant space. Both behaviors are attached to the environment distribution and the PR-preview distribution, so previews of draft branches resolve newly uploaded images.

**One transform engine, two runtimes.** The directive parser and the sharp-based transform live in the core package. The prod transform Lambda imports that engine verbatim; dev mode emulates `/assets/t/*` with the same engine on the fly (the dev route serves through the store abstraction, and `withCanopy` rewrites `/assets/*` to the CMS API route). Identical URLs resolve in every mode, and there is exactly one implementation of "what does this directive do to this image." This is a modernized redesign of OpenStax's `image-cdn`: S3-sourced instead of HTTP-pull, and sync-on-miss via origin-group failover instead of an S3-website-redirect + queue dance (which does not work under OAC anyway).

### Structured Image Field

The schema gains a first-class structured `image` field type whose value is `{ src, alt, width, height, crop? }` rather than a raw string path. The field definition can require a fixed aspect ratio (which triggers a crop step in the editor) and can make alt text optional. The stored value is validated at the authoritative server write boundary by the shared isomorphic entry validator, the same validator the editor uses, so a malformed image value cannot be saved.

Crop is stored as a **normalized rectangle and applied as a URL directive**, not baked into a derived asset. An image can be re-cropped at any time by editing the rectangle, with no derived-asset bookkeeping and no re-upload. There is deliberately no `variants` array on the field — transform URLs are deterministic functions of the reference plus directives, so host apps build responsive `srcset`s with the exported `assetSrcSet` helper instead of the CMS tracking a fixed ladder.

### Editor Media UI

The editor adds a **MediaLibrary** that operates in two modes from one component:

- **Manage mode** in a right-hand drawer (mounted from the editor sidebar's settings menu), for browsing, uploading, and deleting.
- **Picker mode** in a modal, opened from the `image` field and from the MDX editor's custom image dialog.

The library is a cursor-paginated grid over the meta prefix with client-side filename filtering, a dropzone upload with XHR progress, and a crop step (react-easy-crop) when the field requires an aspect ratio. Thumbnail URLs are built from a configured public base URL because the editor may be served from a different origin than the site. The MDX body editor wires an upload/pick dialog into its image plugin, so images embedded in prose flow through the same store and transform layer as structured image fields.

**Guards mirror the server exactly**: uploading and listing are open to any authenticated user, and deleting requires admin. There is no finer-grained per-asset ACL — assets are branch-agnostic and content-addressed, so the branch and path permission layers do not apply to them.

### Pluggable Store Contract

The asset store is defined by a contract that supports both direct-signed and proxied upload modes and lets a store own its own key/URL resolution. CanopyCMS ships two implementations — S3 and local filesystem — but the contract is intentionally broad enough that a git-backed or third-party (e.g. Cloudinary/ImageKit) adapter could be added later without changing content references, which stay vendor-neutral. Because references are just keys plus directives, swapping the delivery layer (e.g. putting a third-party image CDN in front of the originals) stays cheap to revisit.

### Delivery Infrastructure

The delivery-side infrastructure is packaged as the `AssetSupport` CDK construct in `canopycms-cdk`, so each site provisions its own asset stack rather than depending on an org-wide shared deployment (the construct is the unit of reuse, avoiding cross-account IAM). It supports both a standalone bucket and a bring-your-own existing content bucket, attaches the `/assets/*` and `/assets/t/*` CloudFront behaviors, and deploys the transform Lambda (bundled with sharp's platform-specific binaries, no Docker required).

Landing this construct also required fixing the CMS service construct: the isolated-VPC CMS Lambda previously had no route to S3 at all. It now reaches S3 through a gateway VPC endpoint (with a corresponding security-group egress rule), which is what makes networkless presign generation and finalize possible without a NAT gateway. See [Deployment Architecture](#deployment-architecture).

## AI Content Generation

CanopyCMS can export its content as clean, AI-consumable markdown with a structured manifest. This enables AI tools, LLMs, and external indexing services to discover and ingest site content without parsing CMS-specific file formats or navigating the internal content ID system.

### Design Goals

- **Read-only, public access**: AI content is generated from the default branch (typically `main`) and requires no authentication. It represents the current published state of the site, not in-progress branch edits.
- **Schema-aware conversion**: The generator uses schema field definitions to produce structured markdown rather than dumping raw JSON. Field labels, descriptions, select option labels, nested objects, and block structures are all rendered meaningfully.
- **No internal identifiers exposed**: Embedded content IDs (the 12-character Base58 identifiers in filenames) are stripped from all output, and `entry:ID` inline links are resolved to clean URLs. AI consumers see clean paths and human-readable references only.
- **Opt-out exclusion model**: All content is included by default. Adopters configure exclusions (by collection, entry type, or custom predicate) rather than inclusions.

### Content Transformation

The generation engine walks the schema tree, reads each entry from the content store, and converts it to markdown:

- **MD/MDX entries**: Frontmatter fields are rendered as labeled metadata, and the markdown body is appended verbatim.
- **JSON/YAML entries**: All fields undergo schema-driven conversion. Each field type (string, boolean, image, code, select, reference, object, block) has a dedicated rendering strategy that produces idiomatic markdown.
- **Field descriptions**: The `description` field on schema configs (collections, entry types, blocks, and fields) is included in the markdown output, giving AI consumers semantic context about each field's purpose.

The engine also exposes several adopter extension points that customize or augment the conversion. They form a layered pipeline:

- **Field transforms**: Per-entry-type, per-field markdown override functions for cases where the default conversion is insufficient (e.g., rendering a complex data structure as a table).
- **Component transforms** and **body transforms**: Applied to MD/MDX bodies only. Component transforms rewrite individual MDX components; body transforms then operate on the whole body after component rewriting.
- **Entry transforms**: A per-entry-type function that runs once per entry and returns markdown to append after the entry's body/fields. Unlike body transforms, entry transforms fire for every format, including data-only JSON/YAML entries. The appended section is computed once and reused across the per-entry file, the collection rollup, and any bundle containing the entry (the same entry object carries the cached result through all three outputs). A throwing entry transform is logged and skipped; the entry still renders without the appended section.

#### Reading Colocated Sibling Artifacts

An entry transform receives a context exposing the entry's stable content ID and a `readSibling` reader. `readSibling` reads a file colocated in the entry's directory by bare filename (no slashes, no `..`, not absolute) and returns its contents or `null` if missing. This lets an adopter fold a machine-generated artifact that lives next to an entry (named by content ID, which is invariant under slug edits) into the exported markdown.

Canopy performs the IO and path-safety check internally; the entry's absolute filesystem path is never exposed to the transform, so it cannot leak into the published `/ai/` output. This makes the AI exporter symmetric with the page-render path, where a build context exposes a colocated artifact's location via `meta.physicalPath`.

The transform is intentionally per-entry-isolated: it sees one entry plus its colocated files, never other entries. Cross-entry context (e.g. an index of all entries) must be assembled adopter-side.

### Output Structure

The generator produces three kinds of files:

- **Per-entry files** (e.g., `posts/hello-world.md`): One markdown file per content entry, with YAML-style frontmatter containing slug, collection, and type metadata.
- **Per-collection rollup files** (e.g., `posts/all.md`): A single markdown file concatenating all entries in a collection (including subcollections), separated by horizontal rules. Useful for feeding an entire collection to an LLM in one request.
- **Bundle files** (e.g., `bundles/research-data.md`): Named, filtered subsets of content defined by the adopter. Bundles can filter by collection, entry type, path glob, or custom predicate. Multiple filters are AND'd together. Bundles are additive views -- they do not remove content from per-entry or per-collection files.

A **manifest** (`manifest.json`) describes the full content tree: collections with their entries and subcollections, root-level entries, and bundles. Each manifest entry includes a file path, entry count, and optional metadata (title, description, label). AI tools can read the manifest to discover available content without crawling the file tree.

### Delivery Mechanisms

The same generation engine powers two delivery paths. Both read from the default branch and share the same configuration and output format.

**Route handler** (`canopycms/ai` entrypoint): A Next.js-native catch-all GET handler mounted at a separate route (e.g., `/ai/[...path]/route.ts`). It generates content lazily on first request and caches the result in memory. In dev mode, the cache is bypassed on every request so content changes are reflected immediately. In production, responses include a short `Cache-Control` header. The route handler returns standard `Response` objects directly -- it does not use the CanopyCMS `CanopyRequest`/`CanopyResponse` abstraction or the editor API's guard system, because it has no authentication or branch resolution requirements.

**Static build utility** (`canopycms/build` entrypoint): Writes all generated files to a directory on disk (e.g., `public/ai/`). Used during the build step (e.g., `pnpm build`) or via the `npx canopycms generate-ai-content` CLI command. This path is appropriate for pure static exports where no Next.js server is running at request time. Before writing any files, it unconditionally re-validates every entry against its schema and fails loudly if any are schema-invalid (see [Build-Time Content Validity Guard](#build-time-content-validity-guard)).

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
- **Transforms**: The layered transform pipeline -- field transforms, component transforms, body transforms, and entry transforms (see [Content Transformation](#content-transformation)).

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
- **buildPath**: A callback that controls URL path generation. The default strips the content root prefix, joins segments with `/`, lowercases the result, and collapses index entries to their parent collection path (matching the index entry convention used by `readByUrlPath` and `listEntries`). Adopters can override this for custom URL structures.
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

The listing function walks the flattened schema to discover all collections, reads entries from each in parallel, and returns a flat array of entry items. Each item includes structural metadata (path segments, slug, logical path, content ID, collection path, entry type, format, URL path) plus the entry's data. The URL path is computed with index entry collapsing applied, so adopters can use it directly for routing and linking.

For md/mdx entries, the raw data includes both frontmatter fields and the markdown body content (as `data.body`). For data-only entries (JSON, YAML), it includes all parsed fields. This means adopters can access the full content of each entry without additional read calls.

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

## Static-Export Helpers

Statically generated sites need to enumerate every routable content entry to produce route parameters (and, eventually, sitemaps and SEO metadata). CanopyCMS provides this through a two-layer design that mirrors the package architecture: a framework-agnostic core and a thin per-framework adapter.

### Framework-Agnostic Core

The core exposes `collectStaticPaths()`, which reads routable entries via the build context's `listEntries()` and reduces each to a neutral path descriptor. Each descriptor carries:

- a URL-ready `urlPath` (index entries collapsed, round-trips with `readByUrlPath`),
- the URL `segments` array (for catch-all `[...slug]` routes),
- the entry `slug` (for collection-scoped single-segment `[slug]` routes), and
- the entry type name.

Crucially, these structures contain **no framework-specific types**. They are plain data that any framework adapter can map onto its own static-generation shape. The helper supports scoping to a collection subtree and filtering by predicate (for example, dropping the root index or keeping only one entry type).

It applies **no publish filtering**, deliberately: publish state is branch-only, so everything a build can enumerate has already merged and is by definition published (see [Publish State Is Branch-Only](#publish-state-is-branch-only)). The one per-entry exclusion any static helper applies is the SEO `noindex` field, and only on surfaces that _advertise_ an entry — the sitemap, not path enumeration.

### Thin Framework Adapter

The `canopycms-next` package provides `collectStaticParams()`, a framework-agnostic free helper built on the core's `collectStaticPaths()`. It maps the neutral descriptors into the array Next.js's `generateStaticParams` expects, supporting both catch-all routes (param value is the `segments` array) and single-segment routes (param value is the entry `slug`, paired with a collection scope). A `basePath` option supports catch-all routes nested under a URL prefix (e.g. `app/docs/[[...slug]]`): entries are scoped to that prefix and `segments` are made relative to it, so the params match the route.

The adapter is deliberately minimal — it only knows the shape Next.js wants. A future `canopycms-<framework>` adapter would reuse the same `collectStaticPaths()` core and provide its own thin mapping, exactly as the auth-plugin and context adapters do.

**Recommended adopter API — the bound method:** Rather than calling `collectStaticParams()` with a build context themselves, adopters use `generateContentStaticParams()`, a method on the `createNextCanopyContext` result that closes over the (guarded) build context. Page modules call it directly, so they never import or hold the admin build context just to enumerate paths. Because `generateStaticParams` is build-only, this is safe.

**Capability split:** The static-export surface separates three distinct capabilities by least privilege:

- **Enumeration** (`generateContentStaticParams` / `collectStaticParams` / `collectStaticPaths`): reads only the set of routable paths, never entry content. Build-only and inherently safe — it cannot serve a user request.
- **Content read** (the phase-selecting `read` / `readByUrlPath`): resolves a single entry's content, ACL-correct at request time because it routes through the runtime context (see [Phase-Selecting Read](#phase-selecting-read)).
- **Advanced admin** (`getCanopyForBuild`): the unrestricted, ACL-bypassing build context. It is the escape hatch, prod-guarded against request-time misuse (see [Build Context Request-Time Guard](#build-context-request-time-guard)).

Ordinary page code reaches for enumeration or phase-selecting reads; only advanced build-time work uses `getCanopyForBuild` directly.

**Deferred work:** Sitemap generation and SEO metadata extraction are intended to follow the same core-plus-adapter pattern but are tracked as separate future tasks. Only static path collection ships today.

### Build-Time Content Validity Guard

Static builds enumerate and export content without going through the editor's save-time validation, so a schema-invalid entry that made it onto disk — most commonly an abandoned create-scaffold (an empty entry the editor's create flow writes before the user fills it in, then never finishes) — could otherwise ship silently into the static output: a page that quietly disappears from route generation, or malformed content in an AI export. Both `collectStaticPaths()` and the AI content build utility (see [AI Content Generation](#ai-content-generation)) re-validate every entry against its schema before proceeding, using the same pure validation logic as the editor's save boundary, and fail the build loudly with a list of every offending entry -- not just the first -- rather than silently dropping or mangling a page.

This guard is deliberately build-only, not runtime:

- **`collectStaticPaths()`** only enforces this when a build-mode environment marker is set (`next build`'s production phase, or the generic `CANOPY_BUILD_MODE` flag for other frameworks). Skipping it in `next dev` matters because fresh create-scaffolds legitimately exist mid-edit during development -- failing the dev server on every unfinished draft would make routine editing unusable.
- **The AI content build utility** enforces it unconditionally, since it is only ever invoked as an explicit build step (the CLI command or a build script), never incidentally by a dev server.

Publishing and saving remain permissive by design -- this guard only runs at the point content is about to be exported for public consumption, not while an editor is still working on a branch.

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

**Production trust gate — `verifiesCredentials`**: The interface also carries an optional `verifiesCredentials` marker. Framework adapters check every configured auth plugin against the operating mode before using it: if `mode` is `'prod'` and the plugin does not affirm `verifiesCredentials: true`, the adapter throws at handler creation rather than serving traffic. This is an allowlist, not a denylist — a plugin must actively declare that it performs real cryptographic credential verification (e.g. Clerk's JWT verification) to be trusted in production. A plugin that omits the marker is rejected in prod, whether that plugin is `canopycms-auth-dev`'s dev plugin (which intentionally trusts request headers/cookies with no verification, for local development) or a third-party plugin that simply forgot to set it. `CachingAuthPlugin` forwards rather than declares this marker (see [Auth Caching](#auth-caching-cachingauthplugin) above), and the static-deployment stub plugin (which unconditionally denies every request) sets it too, since an always-deny plugin is trivially safe in any mode.

### Framework Adapters

Framework adapters provide thin integration between the framework and CanopyCMS core. They handle two main concerns:

1. **User extraction**: Extract user identity from framework-specific request context (Next.js headers, Express req, etc.)
2. **Request/response adaptation**: Convert framework request/response objects to core `CanopyRequest`/`CanopyResponse` types for API handlers. The response type is not limited to JSON — it also carries a binary/stream variant, and requests can expose raw (unparsed) bodies. This was added for the asset system, which serves binary bytes and accepts non-JSON uploads (see [Asset & Media System](#asset--media-system)).

The `canopycms-next` adapter is ~10 lines for user extraction plus the request/response wrapper. All business logic stays in core—adapters are purely integration code.

**Standard type boundaries**: The adapter's public handler API accepts standard `Request` and returns standard `Response` rather than `NextRequest`/`NextResponse`. This avoids type duplication across package boundaries -- pnpm's strict isolation means each package resolves its own copy of framework libraries, and framework-specific types from different copies are incompatible. Standard Web API types are globally shared, so they work correctly across all packages. See [Dependency Model](#dependency-model) for details.

**Next.js Config Wrapper (`withCanopy`)**:

The `canopycms-next` package also provides a `withCanopy()` function that wraps the adopter's Next.js config to handle three build-tooling concerns:

- **Module transpilation**: CanopyCMS packages export raw TypeScript. `withCanopy()` auto-detects which Canopy packages are installed (via `require.resolve`) and adds only those to `transpilePackages`. The core `canopycms` package is always included; optional packages like `canopycms-next`, `canopycms-auth-clerk`, `canopycms-auth-dev`, and `canopycms-cdk` are included only if found in the consumer's `node_modules`. This avoids Next.js build errors from listing uninstalled packages.
- **React deduplication**: When consuming Canopy packages via `file:` references or linked packages during local development, the bundler can follow symlinks into the linked package's `node_modules` and resolve a second copy of React. Dual React instances cause "Invalid hook call" crashes. `withCanopy()` resolves React modules from the consumer's project root via scoped Webpack aliases (applied only to canopycms source files), ensuring a single React instance without interfering with Next.js internals.
- **Dual-build page extensions**: `withCanopy()` supports a `staticBuild` option that controls which per-build file variants Next.js includes. By convention, CMS-only routes (API handlers, editor pages) use `.server.ts`/`.server.tsx` file extensions; a content route that needs to render differently per build additionally ships a `.static.ts`/`.static.tsx` variant (a prerendered `page.static.tsx` alongside a request-time `page.server.tsx`). In dev and CMS builds (default, `staticBuild: false`), `withCanopy()` adds `server.ts`/`server.tsx` to `pageExtensions`, so CMS-only files and `.server.tsx` route variants are processed while `.static.tsx` variants are ignored. When `staticBuild: true` is set, it adds `static.ts`/`static.tsx` instead, so the static-only variants are processed and every `.server.*` file — CMS-only routes and route variants alike — is ignored. This is the build-tooling mechanism that enables the two-deployment model described above -- a single codebase produces both a public static export (no editor code) and a CMS server build (with editor routes), controlled by a build-time flag rather than runtime checks. See [Why split a dual-build content route into static and server page variants?](#why-split-a-dual-build-content-route-into-static-and-server-page-variants) for why a shared page can't switch this behavior on its own.

When installed from npm (not symlinked), the React aliases are harmless -- they resolve to the same React the project already uses. Note that Turbopack does not currently support the absolute-path aliases used for React deduplication, so consumers using `file:` symlinks for local development must use `next dev --webpack`; Turbopack works fine when packages are installed from npm.

**Why the `./config` export ships pre-built:** `withCanopy()` itself is imported from a dedicated `canopycms-next/config` subpath (`import { withCanopy } from 'canopycms-next/config'` in `next.config.mjs`), and that subpath is the one exception to "Canopy packages export raw TypeScript" (see [Why a Next.js config wrapper for React deduplication?](#why-a-nextjs-config-wrapper-for-react-deduplication)): it resolves to an esbuild-bundled `dist/config.{cjs,mjs}`, built ahead of time rather than transpiled by the consumer's Next.js pipeline. This isn't optional — Next.js loads `next.config.mjs` directly in Node before webpack/Turbopack initializes, so `transpilePackages` (a bundler-level mechanism) never gets a chance to run against the config file's own imports; whatever `next.config.mjs` imports must already be plain, executable JavaScript. Any future subpath export that a consumer's config file needs to import — not just `withCanopy()` — will face the same constraint and need the same ahead-of-time build step.

**Creating a new adapter**:

- Implement user extraction (read auth headers/cookies, call auth plugin)
- Wrap core context creation with framework-specific optimizations (like React cache() for Next.js)
- Provide unified API that works in both pages and API routes
- Optionally wrap the core API handler for framework-specific routing

See `canopycms-next` as a reference implementation. Creating adapters for Express, Fastify, Hono, or other frameworks follows the same minimal pattern.

### Save-Time Validation Hook

The configuration accepts a `validateEntry` hook for adopter-defined, server-side validation of every editor save (see [Save-Time Validation](#save-time-validation)). Unlike auth plugins and framework adapters, this extension point requires no separate package: it is a deliberate config-surface extension that stays within the existing config touchpoint, preserving the config + Editor + one-API-route integration contract.

## Key Design Decisions

### Why file system based (no external databases)?

Simplifies deployment and operations. Git already provides versioning, and the file system provides persistence. No need to sync state between a database and git. Works well with serverless + attached storage (Lambda + EFS).

### Why are binary assets stored in object storage instead of git?

Git history is append-only, so every replaced image version would live forever, and Canopy's clone-per-branch-on-EFS model would multiply that repo weight into every branch provision. Content-addressed keys in a separate object store sidestep both problems and give branch-awareness for free: a draft's asset is fetchable-but-unguessable immediately, publish needs no promotion step, and rollback always resolves. Content references stay vendor-neutral (a key plus directives), so a git-backed adapter remains possible later for tiny adopters. See [Asset & Media System](#asset--media-system) and the design record at `.claude/future-tasks/assets-media-system.md`.

### Why transform images on demand instead of a fixed width ladder at upload?

An upload-time width ladder (the rejected Plan A) was simpler to build but aged badly: it needed sharp in the CMS request path, per-field width hints for odd sizes, derived assets for cropping, and worker back-fill jobs whenever the ladder or quality changed. On-demand transforms move all of that behind a deterministic URL: any size is available, crop is a re-editable rectangle rather than a derived asset, and changing the pipeline just changes cache keys. The cost is one Lambda per site and a sub-second first-hit per new variant, both of which the origin-group cache absorbs. Full trade-off table in the design record.

### Why branch-per-workspace?

Each branch gets its own git clone to prevent conflicts. Editors can work simultaneously without stepping on each other. The workspace isolation also means a crash or bad edit on one branch can't affect others.

### Why aren't comments committed to git?

Comments are review artifacts, not content. They're ephemeral discussion about changes, not part of the final published content. Keeping them out of git prevents clutter and keeps the content repository clean.

### Why are groups and permissions committed to git?

Unlike comments, groups and permissions are configuration that should be version-controlled. Changes to who can edit what should be reviewable via PR, and you should be able to roll back permission changes if needed.

### Why do settings use a separate branch?

In both prod and dev modes, permission and group changes are stored on a dedicated orphan settings branch (named `canopycms-settings-{deploymentName}`) rather than on content branches. The branch name is deployment-specific so that multiple deployments sharing the same git repository can maintain independent settings — see [Deployment Name Resolution](#deployment-name-resolution) for how `deploymentName` itself is resolved. In dev mode, this branch lives in the local bare remote (`.canopy-dev/remote.git`) and is never pushed to GitHub. This design provides several benefits:

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

### Why refuse to boot instead of migrating when the resolved settings branch changes?

Because orphan branches share no history, there is no meaningful "migration" from one settings branch to another — the destination starts empty by construction. A deployment whose resolved settings branch changes (a new `deploymentName`, a hand-set `settingsBranch`, or a changed `CANOPYCMS_DEPLOYMENT_NAME`) while its settings workspace already holds real data has only two honest options: destroy the old data, or refuse. CanopyCMS refuses, at boot, before any git operation runs — a thrown error naming both the currently-checked-out and newly-resolved branch is recoverable (fix the config/env and redeploy); a silent orphan-checkout wiping `permissions.json` and `groups.json` is not. See [Deployment Name Resolution](#deployment-name-resolution).

### Why are rebase conflicts non-blocking for editors?

The alternative would be to block editing on conflicted entries until the conflict is resolved, but that would require editors to understand merge conflicts—a git concept that non-technical users shouldn't need to know. Instead, the system keeps the editor's version during rebase and surfaces a gentle notification. The PR diff on GitHub shows both versions, letting reviewers (who understand the content and context) reconcile during review. This keeps the editing experience simple while still surfacing that a conflict exists.

### Why track conflicts by ContentId instead of file path?

File paths can change when entries are renamed (slug changes). ContentIds are immutable identifiers embedded in every content filename and directory name that persist across renames and moves. Using ContentIds ensures that conflict tracking remains accurate even if the editor renames an entry or collection after a conflict is detected. For collection metadata files (`.collection.json`), the ContentId comes from the parent directory rather than the file itself. The root collection uses a sentinel value since the content root directory has no embedded ID.

### Why three permission layers?

Defense in depth. Branch access controls who can see a branch. Path permissions control what content they can edit. Combining them provides flexible policies: you might let someone access a branch but restrict them to certain content paths within it.

### Why scope `defaultPathAccess` by permission level?

Before this, `defaultPathAccess` applied a single verdict to every permission level, so a deployment that wanted public read either had to deny everything by default (forcing an explicit read-only rule for every public path) or allow everything by default (accidentally opening edit and review too). The object form (`{ read: 'allow' }`) lets a `deployedAs: 'server'` site express "public read, everything else still requires a rule" as one config value. Unspecified levels fail closed to `deny` rather than inheriting a specified sibling level, so scoping read access can never accidentally loosen edit or review by omission.

### Why does `canopycms init` scaffold `defaultBranchAccess: 'deny'`?

Because the schema already defaulted to `'deny'` and the template said `'allow'`, so "secure by default" was true of the package and false of every project the CLI generated — the divergence was an accident of the template, not a decision.

The flip was blocked on `'deny'` being unusable rather than merely strict: it made a freshly created branch inert for its own creator, and made the protected base branch — which takes no ACL and has no creator — unreachable for every non-admin, with no way to configure around it. The two grants documented under [Layer 1](#layer-1-branch-access) fix that, and only then does the default mean something an adopter would actually want: "branches you neither created nor were invited to."

The frictionless first run that `'allow'` appeared to provide was never coming from `'allow'`. The template does not set `defaultPathAccess` at all, so scaffolded projects were already fail-closed on the path layer; what makes a fresh `canopycms init` project work is `canopycms-auth-dev` auto-setting `CANOPY_BOOTSTRAP_ADMIN_IDS`, and admins bypass both layers. `'allow'` therefore only ever took effect for non-admin editors — precisely the multi-editor case it should not have covered. The template now states both defaults explicitly rather than leaving the path layer invisible.

### Why is `mode` required, and why an allowlist (not a denylist) for auth plugin trust?

Two related changes close the same gap: a prod deployment silently running insecure, header-trusting auth semantics because of a missing or forgotten config value.

- **`mode` has no default.** Earlier, an unconfigured `mode` fell back to `'dev'`, so a prod deploy that omitted the field by mistake would silently authenticate every request by trusting whatever identity a caller claimed — no error, no warning, just an open door. Making `mode` a required config field turns that mistake into a loud validation failure at startup instead of a silent security hole in production traffic.
- **`verifiesCredentials` is an allowlist, not a denylist.** An earlier version of this guard asked plugins to opt themselves _out_ of production use by setting a marker. The problem with a denylist is the failure direction: a third-party or hand-rolled plugin that simply doesn't know about the marker is trusted by default, which is backwards for a check whose entire purpose is preventing header-spoofing impersonation. Flipping it to `verifiesCredentials: true` — a marker a plugin must affirmatively set to claim real cryptographic verification — makes the safe default rejection: an unrecognized or incomplete plugin fails closed in prod rather than silently granting every caller admin-equivalent access.

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

### Why does ClerkAuthPlugin resolve its secret lazily?

`ClerkAuthPlugin` resolves `CLERK_SECRET_KEY` and constructs the underlying Clerk client on first authenticated use, memoized afterward, rather than at construction time. This supports the two-deployment model (see [Static Deployment and Build Mode](#static-deployment-and-build-mode)): a zero-editor public build can import the same `canopy.ts` module — configured with `mode: 'prod'` and a real `ClerkAuthPlugin` — without the secret needing to be present in that build's environment, because the plugin is instantiated but never actually authenticates anything there. Only a deployment that actually receives authenticated requests needs the secret available at runtime.

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

- When branch state changes, `invalidate()` bumps a cross-process generation marker (see `resource-generation.ts`) under `.canopy-meta/branch-registry.generation`, then eagerly regenerates the snapshot on the mutating host
- Each `branches.json` snapshot embeds the generation token it was built against; `list()` compares that token to the live marker and only regenerates when they differ
- Concurrent regeneration within one process is deduped to a single scan; across processes, regeneration is still safe—all processes produce identical output from the same `branch.json` files
- No write conflicts because the cache is never directly updated, only regenerated
- `get()` forces one throttled fresh regeneration when a looked-up branch is missing from the cached snapshot, bounding staleness for the "branch exists but snapshot predates it" case
- A single branch directory with a corrupt or unreadable `branch.json` is quarantined out of the scan rather than propagated as a scan failure — one bad file must not turn every branch listing into an outage. The branch stays on disk, invisible to the registry but reported (and repairable) through the admin branch-health surface (see [Admin Observability and Recovery API](#admin-observability-and-recovery-api))

**Why this design:**

- **Single source of truth**: Eliminates synchronization bugs between `branch.json` and `branches.json`
- **Cross-process invalidation**: A marker bump is observed by every process sharing the root (warm Lambda containers + the EC2 worker on EFS), not just the process that mutated
- **Lazy regeneration**: Amortizes the cost of directory scanning across reads
- **Self-healing**: If the cache becomes corrupted, stale, or resurrects an old snapshot (see the generation-token protocol in `resource-generation.ts`), the next read's marker comparison fixes it

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

**Why not require pre-compilation?** Pre-compiling Canopy packages would eliminate the `transpilePackages` requirement but would add a build step to the development workflow, slow down iteration, and make debugging harder (source maps through compiled output). Exporting raw TypeScript keeps the development loop fast and debuggable. The one exception is the `canopycms-next/config` subpath that `withCanopy()` itself is imported from — see [Framework Adapters](#framework-adapters) for why that specific export has no choice but to ship pre-built.

### Why split a dual-build content route into static and server page variants?

A content route in a dual-build site (e.g. a catch-all `[slug]` page) needs to behave differently per build: the static export must prerender every known path (`dynamicParams = false`, required by `output: 'export'`), while the CMS server build must render every request live so runtime path ACLs apply and unknown slugs 404 correctly. Two single-page approaches were tried and rejected, empirically, before landing on a per-build file split:

- **A route-segment config value computed from an env var** (e.g. `export const dynamicParams = process.env.CANOPY_BUILD === 'static'`) fails at build time: Next.js statically parses route-segment config and requires literal values, so a computed expression is a hard build error, not a runtime branch.
- **A single page with `dynamicParams = true` plus `generateStaticParams`** builds and avoids the config-parsing error, but on the CMS server an unknown slug is then served via on-demand static generation rather than an ordinary request — and the request-scoped read's `headers()` call throws `DYNAMIC_SERVER_USAGE`, still surfacing as a 500. Worse, prerendering on the CMS build means build-time content gets served to anonymous visitors, bypassing runtime path ACLs entirely.

The shipped design instead gives each build its own thin page file re-exporting a shared implementation: the static variant re-exports `generateStaticParams` and sets `dynamicParams = false` (prerendered, matching `output: 'export'`); the server variant sets `dynamic = 'force-dynamic'` and has no `generateStaticParams` (every request renders live, ACL-enforced, and unknown slugs reach the page's own `notFound()`). The server variant deliberately prerenders nothing, so it can never serve build-time content to a request-time visitor. `withCanopy()`'s `staticBuild` option ensures each build's `pageExtensions` only pick up its own variant (see [Framework Adapters](#framework-adapters)), so no runtime branching is needed in the page code at all.

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

The index is per-process, not globally synchronized. This design choice accepts eventual consistency for robustness, but bounds the staleness window with an on-disk generation marker (see [Multi-Process Consistency](#multi-process-consistency)):

- **No locking**: Avoids distributed lock complexity and deadlock risks—the marker bump is a single atomic write of a random token, never a read-modify-write
- **No write conflicts**: Each process independently rebuilds by scanning filenames; rebuilds swap in a fresh index rather than clearing in place, so readers never see a partial index
- **Bounded staleness**: A completed mutation becomes visible to other stores at their next marker probe—typically within the probe interval (about a second), stretched across hosts by NFS attribute caching (roughly 3-60 seconds on default EFS mounts)
- **Self-healing**: Suspicious lookups (an ID miss, or an index hit whose file is gone) force an immediate rebuild rather than waiting for the next probe
- **Suitable for CMS workflows**: Editors work at human speeds; second-scale staleness windows don't materialize as conflicts in practice

For a system handling hundreds of concurrent API requests (serverless autoscaling), process-local indexes coordinated through the shared filesystem are simpler and more scalable than a shared, synchronized index.

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

### Benefits of the schema meta file pattern

The schema meta file system offers several architectural benefits:

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

- Different teams can manage different parts of the schema

**Registry pattern enables reuse:**

- Field definitions (like `postSchema`) are defined once and referenced multiple times
- If multiple entry types share the same structure, they reference the same schema
- Changing a schema definition updates all entry types that reference it
- Type safety maintained because registry is TypeScript

**Limitations:**

- Requires async initialization (file I/O)
- Schema registry must be maintained separately from meta files
- References are validated at runtime, not TypeScript compile time

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

### Why is reading sibling artifacts a transform primitive, not a content-model concept?

Entry transforms can read files colocated with an entry via a directory-bound `readSibling` reader, rather than CanopyCMS modeling "sibling artifacts" as a first-class part of the content model.

**Parity with the render path, minimally**: The page-render path already lets adopters read a colocated artifact via a build context's `meta.physicalPath`. `readSibling` gives the AI exporter the same capability with the smallest possible primitive -- Canopy owns the IO and path-safety, and the entry's absolute path is never exposed (so it cannot leak into published `/ai/` output).

**Why not a first-class sibling-artifact concept?** Modeling sibling artifacts in the content model itself was considered and deliberately deferred. It is premature for a single adopter and raises unresolved questions about how such artifacts interact with the editor UI, schema validation, and the branch workflow. The transform primitive solves the immediate need without committing the content model to those answers.
