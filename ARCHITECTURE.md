# CanopyCMS Architecture

This document explains how CanopyCMS works at a systems level, and why it is built this way. For usage instructions, see [README.md](README.md). For contributor workflows, see [DEVELOPING.md](DEVELOPING.md). For which file or symbol does what, see [CODEBASE_GUIDE.md](CODEBASE_GUIDE.md) and each module's own `AGENTS.md`.

## What is CanopyCMS?

CanopyCMS is a schema-driven, branch-aware content management system for git-backed, statically-generated websites. It puts an editing interface on top of a git-backed content store so non-technical users can edit a site without touching git.

Key characteristics:

- **Git as source of truth**: content lives as files in git, so version history, rollback and review are the repository's own.
- **Branch-based editing**: each editing session works on its own branch, which is what makes review workflows possible.
- **Schema-driven**: content structure is declared in a schema and enforced at runtime.
- **File system based**: no external database or cache server — a server (or serverless function) plus an attached filesystem.
- **Framework-agnostic core**: all business logic lives in the core library; adapters are integration layers.

## Package Architecture

- **canopycms** (core): content store, branch management, permissions, editor UI, API handlers, AI content generation, and the asset store plus its image-transform engine. Entrypoints: `canopycms/server` (content reading, API setup), `canopycms/client` (editor components), `canopycms/ai`, `canopycms/build`, and the bare `canopycms` entry (config helpers, plus the isomorphic `assetUrl`/`assetSrcSet` builders host apps use).
- **canopycms-next**: Next.js adapter — user extraction, `React cache()` per-request memoization, and the `withCanopy()` config wrapper (see [Framework Adapters](#framework-adapters)).
- **canopycms-auth-clerk** / **canopycms-auth-dev**: auth plugins. The dev plugin provides a mock flow with configurable test users and is never valid in prod (see [Authentication](#authentication)).
- **canopycms-cdk**: AWS CDK constructs (not imported by the CMS runtime) — the CMS service (Lambda + EFS), the CloudFront distribution, the `AssetSupport` construct, and the `CmsWorker` daemon. Its transform Lambda reuses the core transform engine verbatim, so the deployed CDN and dev mode apply identical transformations.

All business logic stays in core so the core is framework-agnostic and adapters handle only framework-specific concerns. Auth and framework support are separate packages for the same reason: adopters install only what they need, and the core can be tested with neither Next.js nor Clerk installed, so a new framework or provider is additive rather than a core change.

`canopycms/test-utils` is a workspace-internal subpath: it resolves for sibling packages in this monorepo and does not exist for npm consumers, because its sources are coupled to vitest in ways a published package must not be. The comments in `tsconfig.build.json` and in `scripts/check-esm-imports.mjs`, which enforces the pairing, state why.

### ESM Output Must Be Node-Resolvable, Not Just Bundler-Resolvable

Every published package declares `"type": "module"`, so **every relative import in its `dist/` must carry a `.js` extension — in the emitted `.d.ts` as well as the emitted `.js`** — and bare `.`/`..` specifiers must expand to `./index.js`. `tsc` alone does not do this: under `moduleResolution: "Bundler"` it preserves bare specifiers, which bundlers resolve and Node's native ESM resolver rejects. All five published packages therefore run a shared rewrite step in their build. Appending `.js` is correct for a `.d.ts` too: TypeScript maps a `./x.js` specifier to `./x.d.ts`, so declarations must name the runtime extension.

**The `.d.ts` half fails silently, which is the reason this needs a guard rather than a convention.** A missing extension in a `.js` file throws `ERR_MODULE_NOT_FOUND`; the same omission in a `.d.ts` throws nothing — an adopter on `moduleResolution: "node16"`/`"nodenext"` cannot resolve the re-export, and TypeScript's recovery is to type the whole import as `any`, so their build stays green while every type this package exports has quietly degraded, with no diagnostic at all under `skipLibCheck: true` (what most scaffolds, Next.js included, set).

It is also a structural blind spot of pnpm workspaces rather than a missed build step: inside the workspace, one package importing another resolves through the dev `exports` field (raw `.ts` source), never through `publishConfig.exports` — the shape a real consumer gets — so in-repo tests can pass against a broken tarball. `scripts/check-esm-imports.mjs` therefore reconstructs what publish produces and checks it two ways. See [DEVELOPING.md](DEVELOPING.md#published-package-esm-import-check) for how to run it.

Published packages keep `declaration` output but not `sourceMap`/`declarationMap`, since `files: ["dist"]` means the sources those maps reference never ship.

## Dependency Model

**pnpm workspace isolation.** Workspaces are defined in `pnpm-workspace.yaml`. pnpm's content-addressable store and strict resolution mean each package can only import dependencies it declares, so phantom-dependency bugs — importing an undeclared package that a sibling happened to hoist — surface in development rather than after publishing, at a fraction of the disk cost of duplicated `node_modules` trees. Inter-package references use the `workspace:` protocol (`workspace:^` for peers, `workspace:*` for dev dependencies), which pnpm resolves to real version ranges at publish time. That isolation motivates the next two choices.

**Peer dependencies for plugins and adapters.** Auth plugins and framework adapters declare their upstream framework and UI dependencies as `peerDependencies`, so the adopter's project provides the instances and the plugin links against those same ones — React and Mantine crash or isolate context if a bundle holds two copies. For monorepo development the same dependencies are also `devDependencies`; only the `peerDependencies` declaration ships.

**Standard types at package edges.** The `canopycms-next` adapter's public handler signature uses the global `Request`/`Response` types, never `NextRequest`/`NextResponse`, because framework-specific types resolved from two `node_modules` copies are incompatible even when structurally identical. Internally the adapter still uses Next.js APIs. The general principle: a type in a cross-package API must be a standard global or come from a shared package.

**Root package hygiene.** The root `package.json` carries only monorepo tooling (eslint, prettier, typescript, husky, playwright); every library dependency lives in the package that uses it, so each package's declarations stay accurate and root tooling cannot leak into package resolution.

## Module Structure

The core package organizes code into focused modules with single responsibilities, plus a set of flat `src/*.ts` domain modules. **The table in [AGENTS.md](AGENTS.md#code-organization) maps each one to its own `AGENTS.md`, which is where its invariants live, and the code comment at the point of a rule is authoritative over any document.** This section covers only what spans modules.

**Three structural rules hold across the tree.** Client-safe code is separated from server-only code by file (`normalize.ts` versus `normalize-server.ts` in `paths/`, for instance), and `pnpm lint:bundle` fails the build if anything reachable from `canopycms/client` pulls in a node built-in — which is why the URL-prefix join shared by SEO and asset URL building is pure and dependency-free (see [Render-Time URL Prefixes](#render-time-url-prefixes)). Paths are **branded types** (`LogicalPath`, `PhysicalPath`, `CollectionPath`, `SanitizedBranchName`) so the compiler catches a logical path used as a filesystem path, which matters most where such a bug would be a traversal vulnerability (see [Why branded types for paths?](#why-branded-types-for-paths)). And a rule about content structure lives in exactly one place: `validation/field-traversal.ts`'s `traverseFields` is the single encoding of the schema-nesting rules, which the reference, entry-link, unknown-key and deletion checks all build on rather than re-walking the schema themselves.

**Module boundaries are lint-enforced.** The HTTP composition root behind the single catch-all route reaches the API only through one server-only aggregate of every route table. The editor reaches the API only through its client-safe modules, since every other API module pulls in node built-ins. And the API never imports the worker: the queue contract the API enqueues to and the worker consumes — task actions, queue location, the worker's status snapshot — is its own module ([task-queue/](packages/canopycms/src/task-queue/README.md)), so neither side depends on the other. Each rule's `comment` in [.dependency-cruiser.mjs](.dependency-cruiser.mjs) states it, and `pnpm lint:cycles` enforces it.

**The worker is the one module whose internal layering is architectural.** It is a lifecycle shell holding process concerns — start/stop, the cross-host single-worker lock, the poll loops, `remote.git` provisioning, the auth-cache refresh — plus one module per otherwise-disjoint duty cycle (task queue, git sync, the rebase loop beneath it) and a shared history-rewrite kernel all three touch, reached through a context object rather than the daemon instance. Imports run one direction only, and a lint cycle check holds the weaker guarantee that the graph stays acyclic. See [Why is the worker daemon split into free functions over a context?](#why-is-the-worker-daemon-split-into-free-functions-over-a-context).

**The flat `src/*.ts` modules stay flat deliberately**: branch metadata, the registry and workspace provisioning; the content store, reader, listing, tree and ID index; the git manager and GitHub service; the dev sync core and content watcher; services, context and types. Measured against the alternative, those name clusters have several times more inbound traffic from outside than between themselves, so directories would add a hop while encapsulating nothing.

## Service Architecture

CanopyCMS uses dependency injection rather than global singletons: services are created once at initialization and passed down the call stack.

The `CanopyServices` container ([services.ts](packages/canopycms/src/services.ts) holds its shape) carries the validated config, the flattened schema, the three access checkers, the branch registry, the GitHub service when configured, and the git factory/commit/submit helpers. `createCanopyServices()` builds it once and returns it immutable: it validates and flattens the schema, creates the authorization checkers, initializes the branch registry, sets up GitHub integration when configured, and — first — **detects the effective active branch and base branch** (dev-mode git HEAD detection for whichever the adopter left unset, skipped during a build; see [Branch Identity](#branch-identity-defaultbasebranch-vs-defaultactivebranch)) and bakes both into the config, so all downstream code uses consistent values. In dev mode `refreshActiveBranch()` re-detects per request, again only the fields the adopter left unset.

API handlers receive the container on `ApiContext`, content readers take it at creation, framework adapters create it once and inject it, and editor components never touch it at all — they go through the `useApiClient()` hook. Dependencies are therefore explicit and easy to mock, TypeScript enforces that every service is provided, and in a Lambda the container is built once per container lifecycle.

**Global vs scoped.** Config, flattened schema, authorization checkers, branch registry and GitHub service are created once and shared, because they are stateless or hold shared caches. `ContentStore`, `GitManager` and `ReferenceResolver` are created per branch context or per operation, because they are tied to one and must not carry state across.

**Defaults live in the configuration layer.** `getConfigDefaults()` extracts default values from the Zod schemas, so there is one source of truth for them and no hardcoded fallbacks scattered through the codebase.

## Storage Architecture

CanopyCMS is entirely file system based: no external database, no cache server, and no worker process by default. Git already provides versioning and the filesystem provides persistence, so there is no state to synchronize between a database and git, and nothing extra to operate — which suits serverless plus attached storage directly. What gets stored:

- **Content**: MD/MDX/JSON/YAML files under the content directory, committed to git.
- **Branch metadata**: `.canopy-meta/branch.json` per workspace — state, the recorded base branch (the immutable fork point set at creation), PR references, sync status, conflict tracking. Excluded from git via info/exclude.
- **Branch registry**: `branches.json` at the branches root, an inventory of all branches, gitignored.
- **Comments**: `.canopy-meta/comments.json` per branch, not committed, automatically excluded.
- **Settings**: `groups.json` and `permissions.json` on the orphan branch `canopycms-settings-{deploymentName}`, with the workspace under the mode's workspace root.

**Deliberately not on this filesystem:** binary assets. Images and PDFs live in a separate content-addressed object store — S3 in prod, a local directory in dev — and content references them only by immutable key, which keeps git history and per-branch clones lean. See [Asset & Media System](#asset--media-system).

**Concurrent writes.** Branch metadata, comments and the settings files are each mutated by more than one host at a time in practice (several warm Lambda containers plus the worker, all sharing EFS), so all three are protected by a server-enforced cross-host lock in addition to in-process serialization: a lost update across hosts is not an accepted risk for any of them. Settings files also carry a per-write version check, but it is advisory there — they are git-committed and a settings-branch merge can rewrite the version, so the lock is what actually prevents lost updates. Collection metadata (`.collection.json`) gets the same in-process-plus-cross-host locking across its whole read-then-write and deliberately carries no version field, for the same git-rewrite reason. [docs/concurrency.md](docs/concurrency.md) is the full protection model and the required reading before adding any cache, lock, or read-modify-write.

## Content Identification System

Every entry and collection has a stable, globally unique identifier that survives renames and moves, which is what makes reference fields and reliable content linking possible. IDs are 12-character Base58 strings (from `short-uuid`): ~58^12 possible values, URL-safe, and short enough to sit inside a filename.

**IDs live in filenames.** Entries are `type.slug.id.ext` (e.g. `post.hello-world.vh2WdhwAFiSL.json`), directories are `slug.id` (e.g. `posts.916jXZabYCxu`), and metadata files carry no ID. A slug of `index` makes the entry its collection's landing page, answering at the collection's own path — which is why a root `home.index.…` entry answers at `/`. So the slug can change without breaking references, and a filename shows both a human-friendly slug and a unique ID. See [Why filename-embedded content IDs?](#why-filename-embedded-content-ids).

**Bidirectional index.** `ContentIdIndex` scans filenames to maintain ID → {path, type, collection, slug} and path → ID maps, giving O(1) lookups in both directions. It is built lazily on first access (~10-50ms for 1000 entries, which minimizes Lambda cold-start cost, then 0ms while warm).

### Multi-Process Consistency

> Full model: [docs/concurrency.md](docs/concurrency.md).

The index is not thread-safe and each process holds its own copy, with no shared memory or cross-host file watching between processes, so the shared filesystem is the coordination medium:

- **Filenames are the source of truth**, rebuilt by scanning disk; renames are atomic, so every process discovers the same names.
- **On-disk generation marker**: every operation that mutates indexed files under a branch clone rewrites `.canopy-meta/content-index.generation` with a fresh random token, strictly after the mutation. Each store re-reads the marker on a throttled probe (about a second) and rebuilds when the token differs from the one it captured. **A random token, not a counter**: readers only need "did it change since I captured it?", and inequality answers that, while a counter would need a read-modify-write that loses concurrent bumps without a lock.
- **Rebuilds swap, never clear**, so a concurrent reader never observes a half-built index.
- **Suspicious-lookup backstop**: an ID miss, or an index hit pointing at a file that is gone, forces one immediate rebuild (throttled to once per few seconds) before the lookup fails.
- **Write existence guard**: a write targeting an existing ID consults the real directory listing before recreating a missing expected file, and raises a conflict rather than resurrecting an entry another process just renamed. This prevents duplicate-ID files independently of the marker.
- **Duplicate-ID quarantine**: a duplicate embedded ID never fails the build; the scan keeps one deterministic winner, reports the pair for the `repair-content-duplicates` admin action, and a write to an ID on two files is refused with a 409. An index is a hint about where an ID lives, never authority to delete; the rule is in [docs/concurrency.md](docs/concurrency.md).

Residual staleness is bounded rather than open-ended: the probe throttle plus, across hosts on EFS/NFS, attribute caching that can delay marker visibility for roughly 3-60 seconds on default mounts. Per-request store lifetimes and the suspicious-lookup backstop bound it further — acceptable for human-paced editing.

### Case Sensitivity

Content directories and filenames may be mixed-case, but URL-facing paths are lowercased. Reads are **case-insensitive** wherever they go through a directory scan that lowercases before comparing — collection path resolution, entry slug matching, content tree paths, and `readByUrlPath`. A direct `fs.readFile`/`fs.readdir` on a hand-built path string is **case-sensitive** on Linux and EFS, which affects only the `buildPaths` fallback for a collection directory that does not exist yet. macOS is case-insensitive by default, so mixed-case content must be tested on a case-sensitive filesystem — and new content directories should be lowercase.

## Schema-Driven Content Model

Content is modelled as **collections** and **entry types**. Collections are declared in `.collection.json` files alongside the content; entry types inside them reference field definitions in a central schema registry. The root content directory is itself a collection, so every collection behaves identically and no code special-cases the root.

**Entry types** carry a `name`, a `format` (md, mdx, json, yaml), `fields`, an optional `maxItems` cardinality limit (`1` behaves like a singleton), and a `default` flag for the "Add" button. They are schema metadata, not navigable nodes: a collection appears in navigation, its entry types appear in type selectors.

**Field flags and structured values.** `isTitle` marks the field the editor, listings and tree builders display instead of a raw slug. Only one field per entry type may carry it, and it must be a scalar the system can resolve at runtime — so it is rejected on fields nested inside a `list: true` object field, where there is no single element to read. Beyond scalars, a field's value can be an object: the `image` field carries a content-addressed asset reference plus alt text, dimensions and an optional crop rectangle. Structured values are enforced at the server write boundary by the shared isomorphic entry validator (see [Asset & Media System](#asset--media-system)).

**Reserved names and formats.** For md/mdx entry types the field name `body` is reserved, because `body` carries the markdown below the frontmatter, and schema validation rejects a frontmatter field with that name. That is the one place the two format categories differ structurally: **document formats** (md, mdx) separate frontmatter from a body, while **data-only formats** (json, yaml) store every field as structured data and have no body concept.

### Index Entries and the One-URL Invariant

An entry whose slug is `index` represents its collection rather than a child page, the same convention as `index.html`. CanopyCMS collapses index entries consistently across the whole content API: `readByUrlPath('/docs')` resolves the docs collection's index entry, `listEntries()` reports its `urlPath` as `/docs`, `buildContentTree()` generates `/docs` for the node, and the root index entry resolves to `/`. Adopters can therefore use the content APIs' URL paths directly for routing.

**An index entry answers at exactly one URL** — its collapsed collection path. `readByUrlPath('/docs/index')` returns `null` absent a collection or entry type literally named `index`, an index entry does not also answer at `/<collection>/<entryTypeName>`, and no entry answers at `/<collection>/<entryTypeName>/<slug>`. Those candidates all land on a registered entry-TYPE schema item, which `buildPaths` delegates to the parent collection, so the gate sits one layer up: `content-reader.ts`'s `ReadContentInput.urlAddressableOnly` (set by `readByUrlPath` and nothing else) requires each candidate's `entryPath` to be an actual collection and the resolved entry's on-disk type to be one that collection declares — checked with two non-throwing `ContentStore` predicates reading the same `schemaIndex` `buildPaths` reads, so the gate and the resolver cannot disagree. The comparison is case-insensitive through the shared `isIndexSlug`, because this resolver is the one consumer seeing a raw URL segment while everything downstream lowercases, and the index-fallback candidate survives unconditionally, which is what resolves a collection literally _named_ `index`. One qualifier: this covers entries in the typed filename grammar with a declared type, exactly what `listEntries` sees, while a legacy untyped file stays resolvable by URL and invisible to `listEntries` — an open gap.

Each entry gets one `urlPath`, but two _different_ entries can compute the same one — an entry whose slug matches a sibling collection that also has an index entry, or two slugs differing only by case. Only one would then be reachable, so **no two entries may share a `urlPath`**, enforced twice: `assertNoDuplicateUrlPaths` fails a production build naming every contested URL, and `url-collision.ts` is consulted by `ContentStore` on entry create and rename and by the schema store on collection rename. Neither guard subsumes the other — content also arrives by merge, by direct commit, and by adopters retrofitting a repo, none of which pass the write boundary, while the build guard cannot stop an author creating the collision. Both are keyed on the URL and deliberately **not** on the name: an entry beside a same-named sibling collection with no index entry is a legitimate shape (a landing page plus a folder of children), and a name-based rule would forbid it. See [static/AGENTS.md](packages/canopycms/src/static/AGENTS.md) and [src/AGENTS.md](packages/canopycms/src/AGENTS.md) for the two halves.

### Schema Registry and Meta Files

The registry (`createEntrySchemaRegistry` in the adopter's own `app/schemas.ts`) is a central home for field definitions; a collection's `.collection.json` names one by string (`"schema": "postSchema"`), resolved against the registry at initialization, and a collection can declare several entry types each with its own schema. See [README.md](README.md) for the authoring shape.

This keeps field definitions DRY and type-checked in TypeScript, keeps content structure (meta files, co-located with content, visible in the same diffs) separate from field definitions, and lets a collection be added by creating a folder with a `.collection.json`. The limits are the flip side: references are validated at runtime rather than by the compiler, and the registry has to be maintained alongside the meta files.

A meta file declares its collection's name and label, its entry type configurations, and an optional `order` array of content IDs (when omitted or empty, children sort alphabetically). A collection's path comes from the folder structure, never from the meta file, and nesting is detected by scanning subdirectories. The root `content/.collection.json` is optional and takes no `name` or `path`.

### Schema Resolution

Resolution runs during service initialization, in three steps:

1. **Load** (`loadCollectionMetaFiles`): recursively scan for `.collection.json`, parse and validate each with Zod, and extract each collection's ContentId from its directory name.
2. **Resolve** (`resolveCollectionReferences`): replace each string reference with the registry's real field definitions, validate that every referenced schema exists, build the nested hierarchy, and thread each ContentId into the resolved config.
3. **Flatten**: reduce the hierarchy to `Map<path, FlatSchemaItem>` for O(1) lookups. Items are a discriminated union of `collection` and `entry-type`, each carrying its full `logicalPath` as a branded type. The content root is included as a collection with `parentPath: undefined` and root-level collections have `parentPath: 'content'`, which is what eliminates every "is this root-level?" check; the root receives a sentinel `ROOT_COLLECTION_ID`, since its directory has no embedded ID.

Every error is raised at initialization rather than request time: a missing referenced schema names the available registry keys, collection structure is validated during parse, and a content directory with no `.collection.json` at all throws. Resolution is async because it reads from disk, so `createCanopyServices()` is async and framework adapters create the context once at module load and cache the promise (see [Why async service initialization?](#why-async-service-initialization)).

In development `watchCollectionMetaFiles(contentRoot, onChange)` watches `**/.collection.json` through chokidar and fires on add/change/unlink. Auto-reload is not implemented yet: a server restart is still required after a meta file change.

### Schema Cache Invalidation

The resolved schema is cached per branch so ordinary requests don't re-parse every `.collection.json`. Schema edits invalidate that cache the same way branch metadata and the content ID index do — by bumping a cross-process generation marker, never by mutating the cache in place — so every warm host sharing the workspace re-resolves at its next read.

Bulk working-tree operations (a rebase pulling in upstream `.collection.json` changes, a sync, a migration) bump the schema marker too, not just editor-driven schema edits. This is a deliberate backstop: a git operation that changes schema files on disk without passing through the schema API would otherwise leave every process serving a stale schema with no signal to refresh. See [docs/concurrency.md](docs/concurrency.md).

### Content Store and API Surface

`ContentStore` resolves a path by splitting it into segments, looking the collection up in the flat schema map, and deciding whether the path names an entry type (a slug is present) or the collection itself. `read()` and `write()` take a collection path and slug; the entry type configuration determines format, fields and extension; `maxItems` is a schema constraint, never a filename difference. The API is therefore uniform across entry types regardless of cardinality, and the editor navigates the same way — `buildEditorCollections()` returns collections only, entry types appear in "Add" buttons and type selectors, and every entry renders through the same field infrastructure with its entry type deciding which fields appear.

**Structured error codes.** The content store's domain error class carries typed codes (`NOT_FOUND`, `NO_SCHEMA_ITEM`, `FORBIDDEN`, `VALIDATION`) rather than encoding the reason in a message string, so callers branch on `err.code` exhaustively instead of matching regexes. URL resolution depends on it: probing candidate paths requires telling "this path isn't in the schema" from "the entry file is missing on disk" without treating either as fatal.

### Declarative Guard System

API endpoints declare an array of guards that run in order before the handler, short-circuiting with an error response on the first failure and accumulating a typed guard context — so a handler guarded by `branchAccessWithSchema` receives a context in which the branch context and flattened schema are guaranteed non-null, with no defensive checks inside the handler. The available guards cover branch resolution, branch access, schema loading, the role checks, and the two write/submit protections; see [api/AGENTS.md](packages/canopycms/src/api/AGENTS.md) for the list.

Each endpoint's preconditions are therefore visible at a glance in its own definition, and the type guarantee is stronger than an imperative middleware call can give. Guards run inside `defineEndpoint` at handler invocation time: they do not affect HTTP dispatch, routing, or client generation.

## Branch-Based Editing

Content flows in one direction: the git repository is the source of truth, a branch gives an isolated workspace, edits stay in that branch until submitted, and review, merge and deploy all happen outside CanopyCMS — so editors never interact with git or GitHub directly. [Content Workflow](#content-workflow) covers each step.

Opening a branch either resolves its existing workspace or creates a new git clone for it. Each branch has its own working directory, so several users can edit different branches with no interference, and a crash or bad edit on one cannot affect another.

A branch's lifecycle states are **editing** (the only status from which content can be written or the branch submitted), **submitted** (locked for review, awaiting merge), **approved** (ready to merge), and **archived** (merged, preserved for audit). There is deliberately no separate `locked` state: `submitted` already means locked for review.

In dev mode users normally work directly on the base branch — that is the expected local flow and nothing prevents it. In prod the base branch is read-only in the editor (see [Protected Base Branch](#protected-base-branch)); real edits require a separate branch that goes through submit/review/merge.

### Branch Identity: defaultBaseBranch vs defaultActiveBranch

Two branch concepts serve different purposes:

- **`defaultBaseBranch`** is the fork point for CMS content branches: new editing branches fork from it, workspace clones are seeded from it, and rebases target it upstream.
- **`defaultActiveBranch`** is the workspace content is served from by default — the branch the editor opens when none is specified, and the one the content-reading APIs, AI content generation and the content tree builder read.

**Why they are separate:** a developer working on a feature branch wants the CMS to show that branch's content while new editing branches still fork from a stable base. Conflating the two would force a choice between serving stale base content and forking editing branches off an unstable feature branch.

**Detection matrix** (implemented by `resolveBaseBranch()` in `utils/git.ts` plus the active-branch detector in `services.ts`):

|          | `defaultBaseBranch` set                            | `defaultBaseBranch` unset                                                                           |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **dev**  | base = configured value; active follows git HEAD   | base **and** active follow git HEAD (workspaces fork from the branch the developer has checked out) |
| **prod** | base = configured value; active falls back to base | base = `'main'`; active falls back to base                                                          |

- An explicitly configured value, for either field, is always respected and never overridden by detection. Adopters opt out of detection entirely by setting both.
- Static deployments (`deployedAs: 'static'`) skip detection and per-request refresh: a static export serves from the checkout, so there is no git HEAD to track and no git calls are made.
- A build (`isBuildMode()`) skips detection the same way in every mode and deployment type — an unset active branch falls back to `defaultBaseBranch ?? 'main'` and an unset base branch to `'main'` — because a build reads the working tree directly rather than a git-HEAD-selected branch (see [Static Deployment and Build Mode](#static-deployment-and-build-mode)).
- Both resolved values are baked into the config at service creation, and refreshed per request by `refreshActiveBranch()` in dev mode only, outside a build, with a 5-second cache; only fields the adopter left unset are refreshed.
- On detached HEAD, or no git repo, detection falls back to `defaultBaseBranch ?? 'main'`.
- The Zod schema intentionally leaves `defaultBaseBranch` undefined when unset (`.optional()` defeats the `.default('main')`), which is what makes "unset" detectable for HEAD detection.

**The recorded fork point is immutable.** When a branch workspace is created, the resolved base branch is recorded in `.canopy-meta/branch.json` (`branch.baseBranch`) and never changes. Git operations on an existing branch — commits, submit, PR base — prefer that recorded value over the config, so a developer switching git branches mid-session cannot retarget an existing branch's base.

**Per-request branch tracking.** In dev mode every content-serving entry point calls `refreshActiveBranch()`, so switching git branches silently updates the active branch — and, when unset, the base branch used for newly provisioned workspaces — with no server restart, and the new branch's workspace is created lazily on the first content request. This affects only non-editor content serving: the editor is pinned to its own branch through URL params and keeps branch-specific drafts in localStorage. An editor opened with no pinned branch adopts the server's effective default, which the branches-list API reports per request, and an explicitly pinned branch is never overridden.

**Fallback chain.** Content-serving code resolves the active branch as `defaultActiveBranch ?? defaultBaseBranch ?? 'main'`. The HTTP handler provisions the base-branch workspace on the first request, since internal groups load from it; if that provisioning fails outright it fails loudly — logging the cause and returning a 503 naming the branch and the reason — rather than letting every endpoint return confusingly empty results.

**Corrupt base-branch metadata is the one exception to that 503.** If the base branch's `branch.json` exists but fails to parse, the handler serves the request with no internal groups (bootstrap admins keep access through their configured IDs) and logs the condition. A hard 503 here would make the problem unrecoverable through the product itself, because the only fix is the admin branch-health repair action, which is one of those same endpoints. Every other provisioning failure still 503s.

### Protected Base Branch

The resolved base branch is **protected**: it can never be submitted for review — submitting it would commit and push directly to itself, a review bypass, and then ask GitHub for a head==base PR, which 422s — and in prod mode it is **read-only in the editor**, since content there changes only via merged PRs. In dev the base branch stays editable, because the developer lands on it by definition and editing it is the normal local flow, reconciled through `canopycms sync`.

`getBranchProtection(config, branchName, recordedBaseBranch?)` in `authorization/protected-branch.ts` is the single source of truth, keyed off the resolved `config.defaultBaseBranch` (never a hardcoded `'main'`, so `master`/`develop` bases work) with sanitization-aware comparison, since metadata names are sanitized while config holds the raw git name. It returns three flags:

|                 | dev | prod |
| --------------- | --- | ---- |
| `isProtected`   | ✓   | ✓    |
| `submitBlocked` | ✓   | ✓    |
| `readOnly`      | —   | ✓    |

To authorize a content write or render a lock in the editor, use the sibling `getBranchWriteProtection(config, branchName, recordedBaseBranch, status)`, which delegates to it and adds two compound flags:

- `writeBlocked` = `readOnly || status !== 'editing'` — the single expression of "which statuses lock editing", so the API guard, the branches-list wire flag and the editor agree by construction rather than by three parallel derivations. `readOnly` keeps its narrow meaning: which lock applies, and therefore which banner the editor shows.
- `submitBlockedIncludingStatus` = `submitBlocked || status !== 'editing'` — the compound submit rule, consumed as-is by the editor's `canSubmit` rather than re-derived client-side. It is its own deliberately verbose field instead of a widened `submitBlocked`, which `api/guards.ts`'s `submittableBranch` must keep reading as "base branch only". Note the asymmetry: `writeBlocked` builds on the prod-only `readOnly` while this builds on `submitBlocked`, so in dev the base branch is writable but never submittable and the two genuinely disagree.

`status` is a **required** parameter there, deliberately typed to admit `undefined`, so a missing status fails closed. `branch.json` is parsed with a bare cast and no schema validation, so a hand-repaired or partially-written file can yield no status at runtime despite the required type. Making the parameter required is what keeps "the caller didn't ask about status" distinguishable from "the file had no status" — those two cases want opposite answers, and only the second should block. Callers that genuinely don't care (submit, delete, and the ACL rails) call `getBranchProtection` and get no `writeBlocked` at all.

Enforcement is layered:

- **API guards** (`api/guards.ts`): `writableBranch` 403s content, entry and schema mutations when `writeBlocked` (base-branch `readOnly` and status locks share the guard and produce different messages); `submittableBranch` 403s submit when `submitBlocked`. `deleteBranch` and `updateBranchAccess` refuse the base branch in the handler.
- **Workflow authorization** (`authorization/branch.ts`): the system-branch grant in `canPerformWorkflowAction` — the base branch is auto-provisioned with `createdBy: 'canopycms-system'` — is disabled on protected branches, so only admins, review-capable users and explicit-ACL users keep workflow rights there.
- **Backstops**, all refusing a sanitized head==base: `services.submitBranch` throws before any git operation, `syncSubmitPr` returns `sync-failed` without calling GitHub or enqueueing, and the worker's `push-and-create-or-update-pr` task throws a `PermanentTaskError`.
- **Editor UI**: renders purely from the server-computed wire flags on the branches-list response, so it cannot enable a write or submit the API would reject — **provided the client received the flags**. All four are optional on the wire for version skew, so the editor's wire→view mapping (`useBranchManager.tsx`) defaults the three that gate a mutating action to `true` — fail CLOSED — when absent: a branches-list fetch that is loading, has failed, or hit a server that doesn't emit these fields renders the branch locked rather than silently open. `readOnly` alone defaults to `false`, since it only selects which banner to show once something else established the lock. The editor still lands on the protected branch for browsing.

**Withdraw is deliberately not blocked** on protected branches: it is the self-serve recovery path for a base branch wrongly stuck in `submitted`, and the workflow-authorization rule above already restricts it to privileged users there.

### Reserved Branch Names

The API serves branch-specific routes (`/:branch/...`) and a handful of static top-level routes (admin, assets, branches, groups, permissions, users, whoami) from one route table, and a static segment always beats the dynamic `:branch` parameter. A branch named e.g. `admin` would therefore be half-alive rather than cleanly rejected: its bare top-level route still resolves while every nested route 404s or 403s unpredictably.

Branch creation rejects any name colliding with a static top-level namespace, checked against both the requested name and its sanitized git-ref-safe form, matching exactly and case-sensitively so `Admin` and `admin-docs` stay creatable. It is enforced **only on the creation path**, deliberately not as general name validation: a blanket rule would also reject an already-existing colliding branch on every one of its own routes, including its delete route, making it permanently un-removable. This reservation protects the route table; the settings-branch namespace is a separate one, protecting a deployment's settings from collision.

## Operating Modes

The mode is configured in `canopycms.config.ts` via a required `mode` field with **no default**. Omitting it fails Zod validation loudly at startup rather than falling back, because a prod deployment that forgot `mode` would otherwise run with dev's header-trusting auth semantics, trusting whatever identity a caller claims in a request header. After validation `config.mode` is always defined and needs no fallback checks anywhere. An environment variable outranks the config literal so one config file can serve `next dev`, an image build and a deployed prod Lambda; [operating-mode/AGENTS.md](packages/canopycms/src/operating-mode/AGENTS.md) holds the resolution points and [docs/deploying-to-aws.md](docs/deploying-to-aws.md#operating-mode) the deployment recipe.

### dev

Full-featured local development with branching and git operations — a local simulation of production. Per-branch workspaces live in `.canopy-dev/content-branches/` and a local bare git remote at `.canopy-dev/remote.git` stands in for GitHub, so branch creation, workspace cloning, the settings branch and the worker CLI (`npx canopycms worker run-once`, which processes queued tasks and refreshes the auth cache) all work the same way as in prod. Commits go to the local bare remote and no PR is created. `defaultActiveBranch` and `defaultBaseBranch` are auto-detected from git HEAD when unset, and the AI content cache is invalidated on every request so content edits show immediately.

**Dev content sync.** The developer's working tree and the editor's branch workspaces are separate git structures, and they drift: the developer edits content files directly, or an editor publishes changes the developer wants back in their repo. `canopycms sync push`/`pull`/`both`/`abort` moves content across that boundary explicitly (see [cli/AGENTS.md](packages/canopycms/src/cli/AGENTS.md) and [README.md](README.md)). Directory replacements use a backup-rename pattern — rename the old aside, rename the new into place, then delete the backup — so an interruption always leaves one complete copy on disk, and a `--branch` value is validated against path traversal: the resolved path must stay inside the branches directory. Every project-bound command (`sync`, `migrate`, `generate-ai-content`, `worker run-once`) finds its project root by walking up to the nearest `canopycms.config.ts`, the way git finds `.git`, and fails non-zero outside a project rather than guessing.

**Why a separate sync step?** Branch workspaces are the boundary between the developer's git state and the CMS's editing state, and the editor deliberately never writes into the developer's repo — it would create unexpected commits and touch their index. Sync gives the developer explicit control over when content crosses. It also deliberately does not update `remote.git`: the bare remote is kept current by the publish and submit flows, and mixing those responsibilities into sync made the "both" direction's semantics confusing.

**Divergence is surfaced, never auto-resolved.** In dev the editor and dev server read the served branch clone while a build reads the working tree directly, so a working-tree edit made outside the editor leaves the dev server serving stale content until a sync runs. A background watcher compares the two trees by exact file content and, under the dev-only `dev.contentSync` knob, logs a warning naming the diverged files (`'warn'`, the default) or does nothing (`'off'`). There is intentionally **no auto-push mode**: overwriting the branch clone from the working tree would clobber unsubmitted editor saves with no Canopy-level recovery path, so reconciliation goes through the conflict-aware `sync push`. The watcher's own invariants live in [src/AGENTS.md](packages/canopycms/src/AGENTS.md); its logic is all in core, and the Next.js adapter only starts it, reusing the CLI's sync core so there is one implementation of "compare two content trees".

**A "dev reads the working tree directly" mode was deliberately rejected.** The branch-clone model is the foundation of branch isolation, drafts, ACLs and the publish flow, and a dev-only read path around it would diverge dev from prod and undermine the guarantee that every edit happens on a branch.

### prod

Branch workspaces live on persistent storage (EFS on AWS), and GitHub integration handles PR creation and management. Settings live on the orphan branch `canopycms-settings-{deploymentName}` (default `canopycms-settings-prod`), whose name the operating mode strategy computes; changes there open PRs, so permission changes get the same review as content. Settings PR creation follows the same dual path as content branches: directly when `githubService` is available, otherwise a `push-and-create-or-update-pr` task for the worker, which checks for an existing open PR first since the same branch is updated repeatedly.

**Security:** in both modes the system throws if the settings branch cannot be loaded, so permissions are never accidentally read from a content branch. Concurrent admin updates to settings files are guarded by the locking stack in [Storage Architecture](#storage-architecture): a conflicting update is rejected and surfaced to the admin rather than silently overwriting another admin's change.

### Mode Strategy Pattern

Each mode has two strategy implementations: a **ClientSafeStrategy** of UI feature flags and plain configuration (no Node APIs, safe for `'use client'`), and a **ClientUnsafeStrategy** extending it with filesystem and git behavior. Strategies return configuration values and flags, never business logic — git commands belong to `GitManager` and `BranchWorkspaceManager`, which read those flags to decide.

**The workspace root is the single source of truth for where state lives.** `ClientUnsafeStrategy.getWorkspaceRoot()` returns `CANOPYCMS_WORKSPACE_ROOT` (falling back to `/mnt/efs/workspace`) in prod and `{cwd}/.canopy-dev` in dev, and every other path method derives from it internally — so there is exactly one place per mode that decides where the CMS writes, and everything including the auth metadata cache fans out from it with no extra adopter configuration.

## Deployment Architecture

CanopyCMS runs in two shapes: a single server with internet access, or a split Lambda + worker topology chosen for cost and blast radius. [docs/deploying-to-aws.md](docs/deploying-to-aws.md) is the operational guide for the second.

### Single Server (Simplest)

One server with direct internet access: the auth plugin calls the provider API, git operations push and pull to GitHub directly, and PR operations happen synchronously in the request cycle — no worker, no caching, no task queue. This is the default whenever `githubService` is available and the auth plugin can reach the internet.

### Lambda + EFS + EC2 Worker (AWS, Cost-Optimized)

Two components share an EFS filesystem, and the split is driven by one constraint: **the Lambda has no internet access**, because a NAT Gateway costs more per month than the rest of the deployment combined. The Lambda sits in isolated subnets behind a Function URL, fronted by CloudFront for a stable domain and TLS.

**Lambda** runs the CMS app (editor, preview, API). It authenticates with networkless JWT verification plus a file-based metadata cache, performs git operations against a local bare repo on EFS over a `file://` URL — local git is fast, so those run synchronously in the request rather than through a job queue — queues anything needing the internet as a task file on EFS, and reaches S3 for asset presign and finalize through a gateway VPC endpoint. It holds no sensitive secrets: only public keys and configuration.

**EC2 worker** is a tiny daemon on a t4g.nano spot instance (~$1.50/month) with outbound HTTPS. It does everything that needs the internet or a whole-repository view: processing queued tasks (pushing branches to GitHub, creating and updating PRs), syncing `remote.git` with GitHub, pushing this deployment's own settings branch each cycle as a backstop, rebasing active branch workspaces onto the updated base branch, and refreshing the auth metadata cache.

All secrets therefore live on the worker, and a compromised Lambda can read and write content on EFS but cannot reach GitHub, Clerk, or any other external service. The worker is otherwise silent — no HTTP endpoint, no health API — so its stdout and stderr ship to CloudWatch and its status snapshots land on EFS for the admin API below.

### `remote.git` — the Local Bare Repo

Both modes use a local bare git repository as the "remote" for all branch workspace operations; workspaces clone from and push to it over `file://`. In dev it is auto-created at `.canopy-dev/remote.git` from the local checkout; in prod the worker creates it at `{workspaceRoot}/remote.git` and keeps it in step with GitHub. CanopyCMS auto-detects it at the workspace root, so no `CANOPYCMS_REMOTE_URL` is needed when it exists.

When dev-mode site content lives in a subdirectory of the repo, the simulated remote is seeded with a single snapshot commit of that subdirectory's tree at the configured base branch — not whatever branch HEAD is on, and not the subdirectory's full history, since extracting that forks a subprocess per commit and takes minutes on a large repo while editor state is committed on top of the seed anyway. Because branch auto-detection routinely clones from base branches that postdate the remote's creation, a base branch missing from it is pushed from the source repo on demand; branches already present are never refreshed that way, because the CMS pushes editor state into the remote and a refresh would clobber it.

**Prod-mode network-remote guard.** Because the Lambda in this topology has no internet access, `GitManager.resolveRemoteUrl` rejects a resolved NETWORK remote URL (`http(s)://`, `ssh://`, `git://`, or scp-like `user@host:path`) in prod mode, whatever its source — an explicit `remoteUrl` argument, `config.defaultRemoteUrl`, or the `CANOPYCMS_REMOTE_URL` env var — since pointing any of them at GitHub would make the internet-less Lambda hang trying to clone, fetch or push. `file://` URLs and plain filesystem paths are unaffected. A prod host that genuinely has internet access and intentionally runs git against a network remote opts out per deployment with `config.allowNetworkRemoteInProd: true`.

**The bot token never persists on shared storage.** The worker clones `remote.git` from GitHub with the token in the clone URL, and a plain `git clone` records that URL verbatim in the repo's config — which on EFS would leave the token in cleartext, readable by anything that can read the workspace, notably a compromised Lambda with no egress of its own. Nothing needs that stored remote, since every push passes its URL explicitly, so the clone lands under a staging name and is renamed into place only once the scrub is confirmed, and the scrub re-runs on every boot against an existing `remote.git`. See [Security Model](docs/deploying-to-aws.md#security-model) for the residual window and [worker/AGENTS.md](packages/canopycms/src/worker/AGENTS.md) for the fail-closed rule.

### Auth Caching (CachingAuthPlugin)

`CachingAuthPlugin` wraps any auth plugin so that a request costs no network: a `TokenVerifier` verifies the JWT locally, and `FileBasedAuthCache` reads user and group metadata from JSON files on EFS. Each auth plugin package supplies both halves. The worker populates the cache — or `npx canopycms worker run-once` in dev — and the Lambda picks new files up by mtime on the next request; in dev the wrapper takes an optional lazy refresher so the cache auto-populates on first request. Wrapping is transparent: when a plugin implements the optional `verifyTokenOnly(context)` method, `createNextCanopyContext` wraps it in both prod and dev, so adopters wire nothing. The cache directory derives from the strategy's workspace root (`{workspaceRoot}/.cache`) and can be overridden with `CANOPY_AUTH_CACHE_PATH`.

`CachingAuthPlugin` **forwards** the wrapped plugin's `verifiesCredentials` affirmation through a constructor option rather than declaring its own, and the framework adapter asserts trust against the inner plugin before wrapping — so adding a cache in front of an insecure plugin can never launder it into a trusted one (see [Authentication](#authentication)).

### Two Deployments, One Repository

Two independent CanopyCMS stacks can point at the same GitHub repo, and the CDK service construct's `deploymentName` prop (stamped into both the Lambda's and the worker's environment) is what keeps them apart: each stack gets its own `canopycms-settings-{deploymentName}` branch, and each worker pushes only its own — warning about, never touching, a foreign settings branch it finds locally. See [Deployment Name Resolution](#deployment-name-resolution) for why the environment variable, not the shared repo's config, distinguishes the two, and [docs/deploying-to-aws.md](docs/deploying-to-aws.md#two-deployments-one-repository) for the steps. Content branches have no equivalent namespacing — an editor on either stack can create a branch with the same name — so that case surfaces as a real git push rejection rather than silent data loss (see [Push Rejection](#push-rejection)).

## Admin Observability and Recovery API

In the Lambda + worker topology two things fail silently by default: worker and task-queue health, since the worker has no endpoint to ping and operators may have no shell access to the instance; and branch directories left broken by a crash mid-provision or mid-write, since admins have no filesystem access in prod. A namespaced `/admin/*` surface addresses both. Every endpoint carries the same `admin` role check as the rest of the API and is reached through the existing catch-all route — this is recovery tooling, not a new adopter touchpoint — and the editor's System Health panel is its only consumer.

**Worker liveness and the task queue.** Queue stats come from the task directory. Liveness is classified from the mtime of the worker's lock-heartbeat file rather than a live ping, with a deliberately generous staleness threshold that adds a budget on top of the worker's own stale-lock window: a reader on another host can see a heartbeat mtime lagging the true write by the EFS attribute cache's window, and a tight threshold would report a healthy worker as crashed. The worker also writes a status snapshot each cycle — its last git sync and what happened, the last sync error, and the last fatal error including startup failures. Only the lock-holding worker writes that file, and each write is a full-snapshot replace, so a reader never sees a half-written report. Tasks can be listed by status, including files the queue could not parse, then retried or deleted. **A retry requeues under a freshly generated ID**, because the dequeue path dedupes by ID and replaying the same one would be silently absorbed instead of retried. Retry and delete are accepted as safe-to-race with the worker rather than coordinated against it: a task that runs anyway is harmless.

**Branch directory health and recovery.** Every directory under the branches root is classified as healthy, corrupt-metadata (a `branch.json` that exists but won't parse), or orphan (no `branch.json` at all, from a partial delete or interrupted clone). Purge is reversible — the directory is renamed to a trash name with the timestamp **in the name**, not read from mtime, since a rename preserves the original mtime and mtime-based retention would delete a months-stale orphan's trash on the first sweep — and the worker's sync cycle sweeps trash older than 30 days. Repair archives the unparseable file alongside itself for forensics and writes a fresh one with defaults, including for the base branch, which is the case that matters most (see [Branch Identity](#branch-identity-defaultbasebranch-vs-defaultactivebranch)).

## Context Architecture

The context system manages authentication, permissions and content access framework-agnostically.

`createCanopyContext(options)` takes the config plus a framework-specific `getUser` function and returns `getContext()` and the underlying services. It knows nothing about Next.js or any other framework; the adapter supplies `getUser`.

Calling `getContext()` returns a `CanopyContext` carrying the current user (with bootstrap admin groups applied), the services, and four readers:

- **`read()`** — content reader with the user already injected. Always throws on a denied read, for callers that must tell "not found" from "forbidden".
- **`readByUrlPath()`** — resolves exactly the URLs `listEntries()` publishes: direct slug match first, then the index-entry fallback, with the one-URL rule and its `urlAddressableOnly` gate described under [Schema-Driven Content Model](#schema-driven-content-model). A denied read — no access, or an anonymous request against a private path — resolves to `null` rather than throwing, so a page's ordinary `if (!result) return notFound()` renders a privacy-preserving 404 instead of letting an unhandled 500 escape the server component. That is the same choice the JSON API makes by returning 401/403: don't reveal _why_ a path is inaccessible.
- **`buildContentTree()`** and **`listEntries()`** — the two batch readers (see [Content Tree and Entry Listing](#content-tree-and-entry-listing)).

The context also handles user extraction, static-deployment and build-mode detection, permission checks during reading, and **bootstrap admin group application** — config-designated admins get the Admins group regardless of what the auth provider returns, applied here so it happens once, before any read or permission check, rather than in every page.

**Resolved filesystem path on single reads.** `read()` and `readByUrlPath()` return `meta.physicalPath`, the absolute path to the resolved entry file, so server-side and build-time adopters can read artifacts colocated with an entry without re-deriving Canopy's URL-to-filesystem mapping. This is the only absolute path on the public surface and is deliberately confined to these single-result, server-only readers: it is **not** on `ListEntriesItem` or `ContentTreeNode`, because Next.js adopters routinely serialize those as props, RSC payloads or JSON responses, and keeping them free of absolute paths avoids leaking deployment layout (home directory, EFS mount point, branch name) into output. The field is structurally sealed server-side — reachable only through `canopycms/server`, and the implementing modules import `node:fs`/`node:path`, so a browser build would fail.

### Static Deployment and Build Mode

The `deployedAs` config field declares the deployment type: **`'server'`** (default) means a running server with full authentication and authorization; **`'static'`** means a static export with no request context, no users and no auth, where all content is assumed publicly readable. With `'static'` the system uses a synthetic admin (`STATIC_DEPLOY_USER`) and bypasses permission checks for the full lifecycle of that deployment — `next build` and `next dev` alike. `isBuildMode()` covers the remaining case, the build of a _server_ deployment, where there is no request context even though the deployment is not static; it reads `NEXT_PHASE=phase-production-build` (set by `next build` before page-data collection, though not yet when it loads `next.config`) or `CANOPY_BUILD_MODE=true` for other frameworks and scripts run beside a build.

**WHO and WHERE.** `isDeployedStatic(config) || isBuildMode()` answers two questions with one expression. The context factory and content reader use it to decide WHO reads: `STATIC_DEPLOY_USER`, no permission checks. As `readsFromCheckout(config)` it decides WHERE: **every build, in either mode and either deployment type, reads the working tree at `process.cwd()` and never touches git, a branch workspace or `.canopy-dev`**, and a `branch` passed to a read selects nothing. CI therefore builds the checked-out commit and a local build reads what is on disk. Only request-time reads on a server deployment resolve a branch workspace. See [Why does a build read the working tree instead of a branch clone?](#why-does-a-build-read-the-working-tree-instead-of-a-branch-clone).

**Two-deployment model.** One codebase can produce both a static export and a CMS server build, with each build's `deployedAs` selecting the behavior — a public static site alongside a separate CMS editor deployment, both reading the same content repository. At the build-tooling level `withCanopy()`'s `staticBuild` option controls whether CMS-only files (the `.server.ts`/`.server.tsx` convention) are in `pageExtensions`; a content route whose rendering must differ between the two builds also ships a `.static.ts`/`.static.tsx` variant (see [Why split a dual-build content route into static and server page variants?](#why-split-a-dual-build-content-route-into-static-and-server-page-variants)).

### Framework Adapter Pattern

Adapters extract user identity from the framework's request context, apply framework-specific optimizations (`React cache()` for Next.js), and adapt request/response types — nothing else. All business logic, bootstrap admin groups, build-mode detection and access control stay in core. The Next.js adapter is about ten lines of user extraction, and adapters for Express, Fastify or Hono would be similarly minimal.

**Auth plugin is optional only for static deployments.** With `deployedAs: 'static'` the adapter needs no auth plugin, and warns at startup as a safeguard against setting that flag in a server build; the API handler receives a stub plugin that 401s everything, since a static deployment should never serve API requests. With `deployedAs: 'server'` and no auth plugin, `createNextCanopyContext` **throws at startup**, before any traffic is served, rather than allowing a silent misconfiguration.

### Two Contexts, and the Guard Between Them

`createNextCanopyContext` is called once in a central file (typically `app/lib/canopy.ts`) and returns both contexts plus the phase-selecting helpers, the API handler and the services.

- **`getCanopy()`** is request-scoped: it calls `headers()` to authenticate the user and is wrapped in React `cache()` for per-request memoization. Use it in server components and route handlers.
- **`getCanopyForBuild()`** is process-scoped: a synthetic admin with no auth, safe to call from `generateStaticParams`, `generateMetadata` and other non-request contexts where `headers()` is unavailable, and memoized for the process lifetime. **Security note:** it bypasses all branch and path ACLs, so it belongs only in build-time code paths.

That dual pattern replaces environment guessing with an explicit choice per call site. Because the build context bypasses authorization, the adapter wraps it so every operation asserts it is running in a build phase first. The guard is scoped to **production server deployments** — `mode === 'prod'`, `deployedAs === 'server'`, and `isBuildMode()` false — which is exactly where a real authenticated user is on the other end and there is no legitimate use of an admin context; it fails closed, so misuse throws instead of leaking ACL-protected content. It is deliberately prod-only because `next dev` invokes legitimate static-generation hooks with the same not-build-phase signature, with no reliable way to tell those idiomatic calls from the footgun, while on `static` deployments ACLs are skipped everywhere by design and there is nothing to leak.

### Phase-Selecting Read

A page in a `[...slug]`/`[slug]` route must resolve content in two phases: filesystem-direct during the build, branch-aware at request time in dev. Hand-picking a context per call site is error-prone, so the adapter also returns phase-selecting `read()`, `readByUrlPath()` and `listEntries()` that pick it automatically — the build context under `isBuildMode()`, the ACL-enforcing runtime context from `getCanopy()` otherwise. Page code calls one function and is correct in both phases without ever touching the admin build context.

`listEntries()` is the batch counterpart: one filesystem pass returning every entry under `rootPath` with its `urlPath`, `slug`, `entryType`, `data` and `schema`. It exists so adopters stop writing "enumerate the routable paths, then read each one" — an N+1 whose hand-built URLs silently miss on multi-segment slugs — and the `urlPath` it returns round-trips through `readByUrlPath` by construction. It takes no `branch` option, unlike `read`/`readByUrlPath`: it always lists `defaultActiveBranch ?? defaultBaseBranch ?? 'main'`, which in dev tracks git HEAD through `refreshActiveBranch()` and in prod is always the base branch.

### Batch Reads Enforce Path ACLs

`listEntries()` and `buildContentTree()` return **many** entries at once, and on the request-scoped context they enforce path permissions per entry at the same `read` level the single-entry reader checks: entries the user cannot read are omitted from the result and from the `meta.indexEntry` passed to a collection's `extract` callback (which then emits no node), and collections left with no visible children are pruned. On the build context and on `static` deployments nothing is filtered, since both run as the synthetic admin. This matters because `getCanopy()` is the context adopters are told to use for request-time content and is documented as ACL-enforcing; a batch read that took no user could disclose full entry `data` for paths the same user could not fetch through `read()`.

Enforcement reuses `createContentAccessChecker` (`authorization/content.ts`), the same batch primitive the entries API uses, so the per-entry cost is an admin short-circuit or one glob match per configured rule with no extra I/O. The checker is built lazily and skipped entirely at build time, where it would add a `getSettingsBranchRoot()` round trip — EFS, in prod — to every listing for a user who bypasses ACLs anyway.

## The Permission Model

Access control is three layers, all of which must pass, implemented in the unified `authorization/` module. They are defense in depth answering different questions — who can see a branch, what content they can edit within it, and the combined verdict any caller actually asks for — which is what lets a policy grant someone a branch while restricting them to certain paths in it.

### Layer 1: Branch Access

Per-branch ACLs control who can access a branch; it can be restricted to specific users or groups. **Precedence**, highest first: admins and review-capable users → a `managerOrAdminAllowed` lockdown → an explicit user/group ACL → and, only when the branch has no ACL at all, the branch's creator, then `defaultBranchAccess`, then the protected base branch.

**Two grants make a fail-closed `defaultBranchAccess: 'deny'` workable.** Without them `'deny'` is not a strict default but a broken one, because branch access is ANDed into every content check by `createContentAccessChecker` — a denial here makes a branch inert, not merely un-submittable:

- **The creator of an un-ACL'd branch.** The create form sends no ACL, so without this every freshly created branch would be unusable by the person who created it. It also aligns this layer with the three places that already grant on creator-ownership, which would otherwise let a creator delete their branch and rewrite its ACL but not read a file on it.
- **The protected base branch.** It takes no ACL by design (an entry there feeds `allowed_by_acl` and would confer Withdraw rights) and its `createdBy` is the system, so no other grant could reach it — yet it is where every user lands. It applies to anonymous users too, which is what lets a public-read `deployedAs: 'server'` site run `'deny'` with `defaultPathAccess: { read: 'allow' }` instead of opening branch access wholesale.

Both are scoped to branches with **no ACL**, so writing an explicit ACL still restricts the branch — including against its own creator, which is how an admin locks down someone else's branch. The base-branch grant is applied as a fallback where the bare default would otherwise decide, never as a short-circuit ahead of the ACL: short-circuiting would replace `allowed_by_acl` with `base_branch` and silently strip Withdraw rights from ACL-listed users.

Neither grant widens anything separately gated: `canPerformWorkflowAction` disables its system-branch grant on the same `isProtectedBranch` flag, `getBranchWriteProtection().readOnly` still blocks prod writes, path permissions still decide what content is readable, and the HTTP handler 401s anonymous callers before authorization runs at all.

### Layer 2: Path Permissions

Glob patterns (e.g. `content/posts/**`) restrict who can edit which content paths. First matching rule wins, and only admins bypass path rules.

**Level-scoped defaults**: `defaultPathAccess` — the verdict when no rule matches — takes either a single value for every permission level or an object scoped per level, e.g. `{ read: 'allow' }`. That lets a `deployedAs: 'server'` site declare public read while edit and review stay deny-by-default, which is the primary case: a CMS-served site that is also publicly readable without auth. **Any level left unspecified in the object form resolves to `deny`**, so scoping read access can never loosen edit or review by omission.

### Layer 3: Content Access

`checkContentAccess` in `content.ts` combines the branch and path checks into one decision and returns detailed denial reasons. Its batch form, `createContentAccessChecker`, hoists the request-constant work — verifying branch access, resolving the settings-branch root, loading the rules — out of the loop and returns a **synchronous** per-path checker. **Use it, not a loop over `checkContentAccess`, anywhere one request evaluates more than a handful of paths**: an entry-listing endpoint that re-loaded permissions and re-resolved the settings root per entry took tens of seconds on a branch with many collections. Its callers are the entries API, reference resolution, and the request-scoped `listEntries`/`buildContentTree`; the single-call API delegates to the same primitive. It is deliberately **per-request rather than a process-global cache**: a global permissions cache would risk serving stale ACLs after a permissions edit, a security-sensitive failure needing explicit invalidation, while per-request scope sidesteps invalidation entirely and mirrors the prod Lambda model, which has no cross-request state to cache anyway.

**Reserved groups** provide consistent roles: `admins` (full access to all operations) and `reviewers` (review branches, request changes, approve PRs). `isAdmin`, `isReviewer` and `isPrivileged` are the role-check helpers.

**Where permissions live**: on the orphan settings branch in both modes, with the workspace under `{workspaceRoot}/settings/` in prod and `.canopy-dev/settings/` in dev. Branch ACLs live in each branch's own `.canopy-meta/branch.json`, and saves to that file take a server-enforced cross-host lock so an ACL or status update cannot be silently lost when two hosts write at once (see [docs/concurrency.md](docs/concurrency.md)).

## Git Operations Architecture

Git work is layered so that primitives stay testable and handlers stay readable:

1. **GitManager** wraps simple-git with plain primitives and knows nothing about CanopyCMS concepts, so it can be tested and reused independently. It reads configuration values from the operating mode strategy while owning the logic itself, so strategies stay simple value objects.
2. **`CanopyServices` git methods** are context-aware: `commitFiles({ context, files, message })` and `submitBranch({ context, message? })` inject the git author from config automatically and take their paths from the `BranchContext` branch resolution already produced. Centralizing the author is the point — a forgotten `ensureAuthor()` produces a cryptic git error, and the pattern appeared in 18+ handlers.
3. **API handlers** call those service methods and stay focused on workflow: permissions, metadata updates, PR creation.

### Workspace Safety

Canopy's many git clones (one per branch workspace, plus settings workspaces) live as subdirectories of the adopter's project, so if a workspace's `.git` is corrupt or deleted, git traverses upward and silently finds the **host repository's** `.git` — which could mean overwriting the host repo's remote configuration or committing with the bot identity to the wrong repository. Three defenses overlap deliberately, because any one can fail in an edge case (an environment variable not propagated, a race during initialization):

- **Directory ceiling**: every GitManager instance sets `GIT_CEILING_DIRECTORIES` to the parent of its workspace path, so git stops traversing before it could reach a parent repository and fails loudly instead.
- **Managed workspace marker**: before modifying sensitive git configuration (remotes, author identity), GitManager requires a `canopycms.managed` config flag, set when CanopyCMS creates or clones the workspace. Absent marker, the operation throws — catching a git that resolved to an unmanaged repository despite the ceiling.
- **Corrupt workspace recovery**: during initialization a `.git` directory that is not a functional repository is cleaned up so a fresh clone can proceed, rather than leaving the workspace stuck after a crash.

### Task Queue (Async GitHub Operations)

When `githubService` is unavailable because the host has no internet, PR operations are queued as task files on the shared filesystem, which the worker moves through status directories ([task-queue/README.md](packages/canopycms/src/task-queue/README.md) has the layout and crash-safety rules). The shared `github-sync.ts` helpers (`syncSubmitPr()`, `syncConvertToDraft()`) use `githubService` directly when it exists and fall back to the queue when it does not, so API handlers never encode the deployment topology.

Task actions cover pushing a branch to GitHub, pushing plus creating or updating a PR, converting a PR to draft (withdraw), closing a PR, and deleting a remote branch. **`push-and-create-or-update-pr` is the standard path** for both content submits and settings syncs: it pushes, updates any existing open PR for the branch in place, and creates one only if none exists — so either can be retried after a partial failure (the PR created on GitHub but its number never recorded) without hitting GitHub's duplicate-PR error. `createOrUpdatePullRequest` is the one implementation of that idempotency, shared by the worker task and the direct-API path; content submits additionally set `markReadyIfDraft`, which settings syncs omit since they are not review requests.

Branch metadata carries a `syncStatus` (`synced`, `pending-sync`, `sync-failed`) so the editor can show progress, paired with a `syncFailureReason` recording why (see [Push Rejection](#push-rejection)). Settings commits return the same values for the permissions and groups UI.

**Orphaned-task recovery.** A task left in `processing/` — because the worker that dequeued it died before finishing — is moved back to `pending/` once the file's age exceeds a threshold (5 minutes by default). `recoverOrphanedTasks` runs on **every** poll cycle, not only at startup: instance replacement is routine here, a replacement boots well within that threshold, and a boot-only check would see the just-orphaned file as too fresh and never look again. Running every cycle is safe because the per-task execution timeout (60 seconds by default) is far below the threshold, so no task genuinely in flight can age enough to be misclassified.

**Rate limits.** Every Octokit instance goes through one factory attaching `@octokit/plugin-throttling`, so the worker's and `GitHubService`'s clients both honor GitHub's retry-after guidance on primary and secondary limits. The worker keeps a manual classification of HTTP 403 as a safety net for what the plugin does not cover — retries it has exhausted, and errors it never sees — so a rate-limited task fails permanently only when it genuinely should.

### Push Rejection

Two deployments sharing one GitHub repo can independently create a content branch with the same name, since content branches are not namespaced by `deploymentName`. The push then genuinely collides with the other deployment's history — the remote holds commits this side never fetched — so retrying the identical push can never succeed.

A shared classifier recognizes that specific shape (git's `[rejected]` plus its `non-fast-forward`/`fetch first` wording or "Updates were rejected" hint) and deliberately nothing broader, so ordinary transient failures keep retrying with backoff. **Because the classifier depends on git's untranslated English, every git child process CanopyCMS spawns is forced to the `C` locale**, so a host's ambient language settings cannot silently turn it into a permanent no-op.

Both hops of a content branch's push classify it:

- **Lambda → the local `remote.git`** (on submit): a rejection returns 409 rather than the generic 500. This hop targets the deployment's own local origin, which a foreign deployment cannot reach, so the message states only the observable fact — the branch diverged from the copy in this deployment's repository and needs reconciling — and names no cause. It never advises renaming the branch: a branch that reaches this push has usually been submitted before, and a rename can orphan an open PR. As with every error response, only the branch name and static guidance reach the client; full detail, redacted of credentials, goes to the server log.
- **Worker → GitHub**: a rejection is a permanent failure, so the task fails immediately instead of burning its retry budget. This is the hop where a foreign deployment genuinely is a plausible cause, so the message says so; it too stops short of advising a rename.

**A refused lease is a separate shape.** Force pushes of rewritten history use `--force-with-lease`, and git reports a refused lease as `[rejected] … (stale info)`, which shares none of the wording above and has its own predicate. A refusal is usually benign — an earlier attempt already landed, or the branch moved on — and git refuses a stale lease even when the update would be an ordinary fast-forward, so the push retries **plain**: a non-forced push succeeds only if it fast-forwards, so it can never destroy anything, and only a rejection of that retry is real divergence.

The worker's own settings-branch push has no task to fail into, so it logs a warning on any failure, naming the collision when it is one.

### Settings-Specific Git Helpers

Content operations always work on the current branch; settings operations must route to the settings branch, whose name depends on the mode and deployment. `settings-helpers.ts` holds that mode-aware logic in one place so the permissions and groups APIs cannot drift apart. `getSettingsBranchContext()` resolves which branch to use and **throws if the settings branch cannot be loaded**, in both modes, so permissions are never read from a content branch. `commitSettings()` commits and pushes with mode-specific behavior: in dev to the settings branch in the local bare remote with no PR, in prod through `commitToSettingsBranch()` with the dual-path PR creation above, under `autoCreateSettingsPR` (default true).

**Cross-process locking.** Settings workspace initialization takes an in-process lock and then the same server-enforced provisioning lock content clones use, because Lambda containers share EFS but not memory, and two cold starts would otherwise clone into one directory. See [docs/concurrency.md](docs/concurrency.md#settings-workspace-init-and-background).

### Deployment Name Resolution

Every place that computes the settings branch name must agree on `deploymentName`, so one resolver settles it, used by both mode strategies' `getSettingsBranchName`. Without it, three call sites could disagree — the strategy, the settings API helper, and the HTTP context builder — and the branch auto-provisioned on first settings access would not necessarily be the branch every other settings operation read and wrote.

**Precedence: environment variable, then config, then the mode default (`prod` for prod, `local` for dev).** The env var deliberately outranks config, inverting the intuitive order, because it is stamped per-stack by infrastructure and is therefore the value guaranteed to _differ_ between two deployments sharing a repo, while `config.deploymentName` lives in the shared checkout and is guaranteed to be _identical_ in both. If config won, an adopter who had already set `deploymentName` in that shared config would find the infrastructure-level override silently doing nothing — exactly the scenario the feature exists for. When both are set and disagree, a one-time warning names both values.

**Changing the resolved settings branch is refused at boot, loudly.** Initializing an _existing_ settings workspace never re-clones; it checks out the resolved orphan branch. If that name is not already a local branch there, git orphan-checks-out, wipes the working tree and commits empty — and because orphan branches share no history, that permanently destroys `permissions.json`/`groups.json` with nothing to recover from. So initialization checks whether a settings workspace already exists and whether it is already on the newly-resolved branch, and a mismatch throws before any git operation runs, naming both branches so the operator can restore the previous value or deliberately move the workspace aside. No migration is attempted, since there is nothing to migrate from once an orphan checkout has happened. The check runs before the cross-process lock above, so a misconfigured deployment refuses without queuing, and again under it, so a racing host cannot act on a stale sample.

## Content Workflow

### Creating and Editing

A user opens or creates a branch, the system resolves or clones its workspace, each save writes directly to files in that workspace, and live preview reflects them immediately.

### Save-Time Validation

Saves run through server-side validation in the content write handler:

- **Adopter validation hook**: the config can supply `validateEntry`, which runs before the entry file is written and returns issues at two severities. An `error` rejects the save (HTTP 422 carrying the hook's message, nothing written to disk); a `warning` lets it proceed and rides back on the write response, where the editor surfaces it. This gives adopters site-specific rules — cross-field constraints, content conventions, link policies — enforced for every write, not only for well-behaved clients.
- **Entry-link validation**: body content and markdown fields are scanned for `entry:ID` links whose targets no longer exist. These are warnings only; a save is never blocked by a broken inline link (see [Entry Links](#entry-links-inline-content-links)).

**Why a config hook rather than a new integration point?** Adopter touchpoints are deliberately limited to config + Editor + one API route, and `validateEntry` lives inside the existing config touchpoint, so adopters gain a save-time extension point with no new wiring.

### Submitting for Review

Submit commits all changes and pushes to the remote via `submitBranch()`, creates a GitHub PR when GitHub integration is configured, and moves the branch to `submitted`.

**Clicking "Submit" requests publication — it does not publish.** Content goes live only once the PR is merged and the site is rebuilt and deployed, which means CanopyCMS does not control the publication moment: the CI/CD pipeline does. This flow applies to editing branches; the base branch can never be submitted (see [Protected Base Branch](#protected-base-branch)).

### Review Process

A branch can be approved, or have changes requested — which returns it to `editing`.

**Content is read-only while under review.** Once a branch leaves `editing` (`submitted`, `approved` or `archived`), the server write boundary rejects content saves, entry creation and schema mutations with the same kind of 403 used for the protected base branch: a branch mid-review must not have its content shift under the person reviewing it. The editor mirrors this — Save disabled, entry-tree mutations hidden, a banner explaining why. **Comments are exempt by design**, since they are the review mechanism itself and must stay writable while a branch is submitted. Withdrawing or requesting changes returns the branch to `editing` and immediately re-enables writes; request-changes requires `submitted`, while withdraw accepts `submitted` or `approved`, which makes it the general unlock and an approved branch's only non-destructive way back (whether `approved` should exist at all is open — see [approved-status-dead-end.md](.claude/future-tasks/approved-status-dead-end.md)). A branch whose `status` cannot be read is treated as locked, since `branch.json` is parsed without schema validation and the guard must fail closed rather than guess.

**Submitting follows the same rule as writing.** Only an `editing` branch may be submitted, and an unreadable status fails closed exactly as it does for writes — submitting a branch you may not edit is incoherent, since its content cannot have changed since the last submit. It is enforced in the submit handler alongside its three sibling transitions (withdraw, approve, request-changes), each returning a 400 naming the offending status, because the `submittableBranch` route guard answers a different question — whether this is the protected base branch — and reads no status at all. Without the handler check, an `archived` branch could be re-submitted: nothing would be committed, but the branch would be re-stamped `submitted` and the PR sync would either overwrite the merged PR's title and body or, in prod, fail permanently against a PR that can no longer be reopened.

### Merging and Archiving

Merge detection is automatic. Once a branch is `submitted` or `approved` and has a recorded PR, the worker's sync cycle polls GitHub for that PR's resolution on every pass: when the PR is merged, outside CanopyCMS by someone with merge permissions, the worker archives the branch itself — status `archived`, `pullRequestState` stamped `merged`, `mergedAt` recorded — and the site rebuild and deploy happen in other processes, typically CI/CD.

If the PR is **closed without merging**, the worker records `pullRequestState: 'closed'` and leaves the branch's status untouched: a closed PR is not necessarily terminal, since it can be reopened, so an admin decides rather than the worker guessing. The editor shows a red "closed" badge and disables request-changes, which assumes an open, convertible-to-draft PR; withdraw stays available as the path back to `editing`.

A `markAsMerged` endpoint remains as a manual fallback for when the worker isn't running, or an admin wants to force-resolve immediately. It accepts `submitted` or `approved`, matching the automatic path, so it can reach anything a poll could — including a PR merged and then deleted from GitHub before a cycle ran. It verifies the merge through the GitHub API and builds its update through the same shared helper, so both paths produce identical archived metadata.

### Publish State Is Branch-Only

There is **no per-entry draft or published field**, and there will not be one. Publish state is a property of the _branch_:

| State                      | How it is expressed                              | Public?                                                         |
| -------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Not published              | The entry lives on an unmerged branch            | No — not built, no URL                                          |
| Published                  | The entry's branch has merged to the base branch | Yes                                                             |
| Published but unadvertised | Merged, with the SEO `noindex` field set         | Yes — built and linkable, but absent from every listing surface |

Two consequences follow, and both are load-bearing:

- **`noindex` is not a hiding mechanism.** It means "don't index", not "don't exist": the page is built and its URL resolves for anyone holding the link. Content that must not be publicly reachable must not be merged.
- **Enumeration helpers must not invent a publish filter.** `collectStaticPaths` and `collectRoutableEntries` apply no publish filtering at all, not even on `noindex`, because everything they can enumerate is by definition published — it merged. `noindex` exclusion happens only on the surfaces that _advertise_ an entry, namely the sitemap helper, never on enumeration.

**How to unpublish:** delete the entry on a branch and merge that branch. This is recoverable — `git revert` restores the file byte-for-byte including its content ID. Note that `validation/deletion-checker.ts` blocks deleting an entry other entries still reference, so inbound links must be fixed first; that guard is why a soft "archived" state would save no work.

**The corollary:** don't merge unfinished content. Work in progress stays on its branch, which means content branches may legitimately be long-lived — see [content-lifecycle-scenarios.md](.claude/future-tasks/content-lifecycle-scenarios.md) for the staleness guardrails that implies, and [draft-publish-lifecycle.md](.claude/future-tasks/draft-publish-lifecycle.md) for the rejected alternatives.

## Branch Synchronization and Conflict Detection

When the base branch receives new commits from merged PRs, active editing branches fall behind. The worker daemon rebases them periodically and surfaces conflicts to editors through a non-blocking notification system.

### Rebase Behavior

The worker's cycle fetches the latest base branch from GitHub into the local bare repo, **fast-forwards the base branch's own workspace clone explicitly** (`merge --ff-only`, invalidating its content caches when it advances), then iterates over all other active branch workspaces and rebases them. That dedicated step exists because the base clone must stay a linear mirror of the remote while the generic rebase loop's skip paths are silent: here an unprovisioned workspace is a quiet skip, but a dirty working tree or diverged local history is a loud error left untouched, since nothing else would surface a silently wedged base view. (That non-fast-forward condition is about the base clone falling behind `origin/<baseBranch>` when fast-forwarding inward, not the push-outward collision in [Push Rejection](#push-rejection).)

**Branches the rebase loop skips:**

- **The base branch's own workspace**: kept current by the fast-forward step, since routing it through the `--theirs` resolution below could rewrite its history.
- **In review** (`submitted` or `approved`): rebasing would rewrite commit history under a PR someone is actively reading. They are left alone until they return to `editing` — but the same cycle still polls their PR's resolution, since nothing else tells the worker a merge or close happened.
- **Archived**: already merged, with no open PR left to poll.
- **Dirty working tree**: an editor is actively saving, and rebasing would fail or destroy their work. The worker skips and retries next cycle.

When nothing conflicts, the rebase applies cleanly and any previous conflict state is cleared.

**Recovering an interrupted rebase.** One branch's rebase — fetch, replay, any number of conflict-resolution rounds — spans several awaited git subprocesses and holds a cross-host lock against concurrent editor saves the whole time. Instance replacement is routine in this topology, so the worker can be killed mid-rebase and come back to a clone still sitting mid-rebase; before doing anything else with that clone, and still inside the same lock, it detects and aborts a rebase left over from its own abandoned run. **The abort is not lossless**: while the worker was down nothing held the lock, so an editor could have saved into the wedged clone and received a normal success response, and the abort's hard reset discards that save (new files survive; edits to existing ones do not). The worker logs exactly what it discards, by path. Aborting is still correct, because the alternative is a branch permanently wedged serving conflict-marker content. See [docs/concurrency.md](docs/concurrency.md) for the lock's writer-vs-worker asymmetry and why the abort must run inside the same critical section.

### Publishing a Rewritten History

A rebase rewrites commits. If the branch had already been submitted, its pre-rebase history is in `remote.git` and on GitHub, and the rewrite leaves the clone unable to push to either: the editor's next submit no longer contains `remote.git`'s tip and is rejected. This is reachable whenever a submitted branch returns to `editing` — request-changes, withdraw, or admin repair-metadata — and then falls behind base, so it typically strikes a branch with an open PR, which the old advice to rename the branch would have orphaned.

The loop therefore publishes what it rewrites, on both hops, each under a lease keyed to the exact commit the rebase replaced (recorded on the branch as `historyRewrittenFrom`): a force-push into `remote.git`, then a queued `push-branch` task carrying it to GitHub so an open PR's head follows within a cycle. Ordering is **record the marker, push, then queue**, so every crash window leaves the marker set with the work unfinished and a self-heal pass at the top of each branch's turn finishes it without waiting for another base-branch advance. The marker clears only once GitHub is confirmed to hold something other than the commit that was rewritten.

**The arming guard is what makes the force safe, and it is not belt-and-braces.** Branch clones are `--single-branch` and never fetch their own branch, while `reconcileTrackedBranches` fast-forwards `remote.git` to GitHub's tip — so after someone pushes a fixup straight to the PR branch, `remote.git` legitimately holds a commit the clone has never seen. **The loop force-publishes only when `remote.git` holds exactly the commit the clone is about to rebase away.** A lease keyed to "whatever `remote.git` currently holds" would be satisfied in that case and would silently delete the fixup from `remote.git` and then from GitHub. Anything else is left untouched and recorded as a rebase failure the editor can see.

Between the local publish and the GitHub push landing, such a branch reads as diverged from GitHub, so `reconcileTrackedBranches` recognizes the marker and reports these as `rewritten` rather than `diverged`, keeping the cross-deployment collision warning meaning what it says.

### Conflict Resolution Strategy

When a rebase hits a conflicting file, the worker resolves and continues rather than aborting: non-conflicting files take the base branch's changes normally, and **conflicting files keep the editor's version**. For an ordinary conflict — the file exists on both sides with different content — that is `git checkout --theirs` during the rebase, since git reverses its `ours`/`theirs` semantics there: `--theirs` is the branch being replayed (the editor's work) and `--ours` is the rebase target.

A **modify/delete conflict** has no "their version" to check out, so it dispatches on which side deleted, read from git's own conflict-status codes rather than inferred: if the editing branch deleted the file while base modified it, keeping the editor's version means honoring the delete (`git rm`); if base deleted it while the editing branch modified it, it means keeping the file (`git add`). This matters beyond that one file, because `checkout --theirs` **throws** on a modify/delete conflict, and attempting it unconditionally let the throw escape the whole resolution loop and leave the clone wedged mid-rebase instead of being handled as a per-file resolution failure. [worker/AGENTS.md](packages/canopycms/src/worker/AGENTS.md) holds the abort-ownership rules that follow.

After resolving a step's conflicts the worker continues the rebase, skipping a commit whose resolution is empty, with a safety limit on rounds to prevent an infinite loop.

### Conflict Tracking

Conflicting items are recorded in the branch's metadata **by ContentId, not file path**, because ContentIds are stable across slug renames and file moves and therefore survive future rebases. Entry files carry the ID in the filename; a subcollection's `.collection.json` takes it from the parent directory; the root collection uses the `ROOT_COLLECTION_ID` sentinel, which uses underscores and so can never collide with a real Base58 ID; files with no embedded ID anywhere are excluded. The metadata stores `conflictStatus` (`clean` or `conflicts-detected`) and `conflictFiles` (the IDs where the editor's version was kept), cleared automatically by a later clean rebase.

### Rebase Failure Tracking

Conflict resolution above is the expected case. A rebase can also fail outright — an unexpected git error, or exhausting the safety limit on rounds — which means the automatic recovery itself broke down and the branch is stuck behind base until someone intervenes. The worker records that as a distinct, persistent `rebaseFailure` marker (a message plus first-seen and last-seen timestamps), separate from `conflictStatus`/`conflictFiles`, and surfaces it only in the admin System Health panel's branch list: a stuck rebase means the worker needs attention, which is not something an editor can act on.

To avoid write amplification, a branch failing every cycle is re-recorded roughly once an hour: each metadata save eager-regenerates the branch registry, so recording unconditionally would multiply that cost across every stuck branch on every pass. The marker clears when the branch catches up cleanly, **or when its editor submits it** — the rebase loop skips submitted branches, so without an explicit clear on submit a stale failure would persist through the whole review cycle.

### Editor Conflict Notification

Conflicts reach editors at three levels, all driven by matching each item's ContentId against the recorded `conflictFiles`: a non-blocking notice at the top of an affected entry's form, a badge on a collection whose `.collection.json` conflicted (its ordering or entry type configuration may need attention even when its entries are fine), and a conflict count in the branch picker alongside a sync-status badge whose tooltip shows the recorded `syncFailureReason`. Unlike the admin-only panel, the branch badges are visible to anyone who can see the branch — informational summaries of state every editor on it already needs, not a recovery surface.

Conflicts are deliberately **non-blocking**, so editors keep editing and submitting rather than being stuck on a merge conflict they don't understand; the PR diff on GitHub shows both versions, so whoever reviews it — who understands the content — decides how to reconcile; the notices use plain language about recent changes rather than git terminology; and per-item granularity is possible precisely because conflicts are tracked by ContentId.

## Reference System

Content links to other content by stable content ID, which is what makes relationship modelling and referential integrity possible.

### Reference Fields

A reference field must specify at least one scoping constraint, controlling which entries are valid targets:

- **Collection scope** (`collections`) limits references to entries in the named collections **and all their subcollections** — tree traversal, not exact collection matching.
- **Entry type scope** (`entryTypes`) limits references to entries of the named types regardless of collection, which is what you want when the same type appears in several collections.

The two combine: collection scope narrows the search space first, then entry type filtering applies within it. With only `entryTypes`, the search covers every entry in the store through the ID index. A field can hold one reference or an array of them.

**Entry-type scope validation.** The type names in a field's `entryTypes` scope are checked against the entry types the branch's schema actually declares, and a misspelled or nonexistent name fails schema resolution outright with a "did you mean" suggestion, rather than silently resolving to an empty reference picker. This cannot happen when field schemas are first registered, because entry types are declared per-branch in on-disk collection metadata and the valid set does not exist until a branch's schema has been resolved. It therefore runs as part of that resolution, **before the resolved schema is cached**, so a bad scope fails on every load of that branch rather than only when the cache happens to be cold.

### Resolution, Validation and Integrity

`ReferenceResolver` resolves an ID to its display value and loads, searches and batch-resolves a field's options; `ReferenceValidator` checks format, existence and both constraints, on whole entries during saves and on single references for live editor feedback. Before an entry is deleted the system reports every entry referencing it, so deletion is blocked rather than leaving orphaned references. See [validation/AGENTS.md](packages/canopycms/src/validation/AGENTS.md), which also holds the `normalizeReferenceValues` rule that keeps a resolved reference from being persisted as a frozen snapshot of its target.

### Entry Links (Inline Content Links)

Reference fields suit structured data; authors also need to link to other entries from within prose. Entry links extend reference-by-ID to inline markdown links, using the `entry:` protocol with a 12-character content ID and an optional anchor fragment:

```markdown
See the [Getting Started guide](entry:vh2WdhwAFiSL) for setup instructions.
You can also jump to the [API section](entry:a1b2c3d4e5f6#authentication).
```

**Why a custom protocol instead of file paths?** File paths break when content is renamed or reorganized, while content IDs are stable across slug changes, collection moves and restructuring. Reusing them means entry links inherit every rename-safety guarantee the reference system already has, with no parallel identification system.

**Resolution happens at read time**, in `ContentReader.read()`, parallel to reference resolution: the resolver scans body content for `entry:ID`, looks each ID up in the bidirectional index, computes the target's URL path from its place in the content tree, and substitutes it. Adopters therefore receive fully-resolved URLs with **no change to their rendering pipeline** — the zero-adoption-cost property that justified the design. It is on by default and can be disabled per read with `resolveEntryLinks`, and adopters whose URL structure does not match the content tree override the computation with an `entryLinkUrl` config callback.

Around that core: the resolver skips fenced code blocks and inline code spans, so code examples mentioning the syntax are not corrupted; a missing target becomes `#` with a logged warning, so a page still renders with a dead anchor rather than failing; the editor resolves links client-side for the preview iframe from the already-loaded entry list, avoiding API calls during preview updates; saves report broken links as **warnings, never errors**, because inline prose links are less structurally critical than typed reference fields; and the AI content pipeline resolves them to URLs so AI consumers never see internal `entry:` references.

## Comments & Collaboration

Comments support asynchronous review at three attachment levels — **field** comments on a specific form field, **entry** comments on a whole entry, and **branch** comments on the changeset — stored per branch in `.canopy-meta/comments.json`. Thread resolution is controlled by the thread author, users with review access, or admins.

Comments are **not committed to git**, automatically excluded via git info/exclude: they are ephemeral discussion about a change rather than published content. Groups and permissions go the other way, onto a version-controlled settings branch, because who can edit what should be reviewable as a PR and revertible like anything else.

Comment writes are safe under concurrent authors, including two Lambda containers writing at the same moment: an in-process mutex, a server-enforced cross-host lock, and per-write version checks compose so a comment cannot be silently lost to a write on another host (see [docs/concurrency.md](docs/concurrency.md)).

## Editor Architecture

The editor provides schema-driven forms, block-based page building and live preview. [editor/AGENTS.md](packages/canopycms/src/editor/AGENTS.md) maps the subsystem — the largest in the package — and [editor/hooks/README.md](packages/canopycms/src/editor/hooks/README.md) covers the data-loading architecture.

**Bundle separation.** Public sites can be built with no editor code at all: the editor is exported from `canopycms/client` and imported only where needed, so site visitors never download editor JavaScript. At the file level, CMS-only routes use the `.server.ts`/`.server.tsx` convention and `withCanopy()` controls whether Next.js processes them, so a static build excludes them entirely rather than relying on tree-shaking. The editor can be embedded in the same Next.js app or run as a separate application.

**Live preview** is an iframe loading the real site pages, with the editor communicating over postMessage: editing a field updates the preview immediately, and clicking an element in the preview focuses the corresponding form field. When the host app is served under a deployment prefix, the editor's API base URL and the iframe's `src` both have to carry it — and the preview URL must carry it **exactly once**, because the same string is also matched against the browser-reported location path to drive draft sync. See [Preview Path Identity](#preview-path-identity).

### Preview Bridge Trust Model

The preview bridge is a postMessage channel between two windows, and the site side feeds incoming draft data straight into the host site's renderer, often MDX evaluation. An unvalidated listener would therefore let any window holding a handle on a preview page execute arbitrary content in the site's origin. Trust is explicit on both sides:

- **Site-side hooks** (`useCanopyPreview` and the lower-level preview hooks) attach listeners only when the page is actually framed, and accept a message only if it comes from the direct parent frame (`event.source === window.parent`) **and** its origin matches the expected editor origin. That origin defaults to the page's own, so same-origin setups need no configuration; a deployment serving the editor from another origin passes `editorOrigin`.
- **Editor-side listeners**: the preview frame's ready/error handler applies the same source-plus-origin validation (`event.source` must be the iframe's `contentWindow`, the origin must match the one pinned from its `src`). The comment system's preview-focus handler validates origin only — it lives outside `PreviewFrame` with no handle on the iframe, and its message can at most scroll or focus a form field.
- **Every outbound message targets a concrete origin** — derived from the iframe `src` on the editor side, the configured or same origin on the site side — never the `'*'` wildcard, so draft content cannot be delivered to a frame that has navigated elsewhere. Opaque origins (sandboxed embeds, which serialize to the string `'null'`) are never trusted inbound and never posted to.

The bridge also carries a preview-to-editor **error channel**: when a draft fails to compile or render, the preview page calls the `reportError` helper `useCanopyPreview` returns, optionally tagging the offending field, and calls it again with `null` once the draft renders cleanly. The editor shows the report over the preview pane — without it, a render error inside the iframe is invisible and the iframe simply stops updating.

### State and Data Loading

Two React contexts provide dependency injection instead of module-level singletons — the API client and the editor-wide loading/modal/preview state — so components reach shared state without prop drilling and tests wrap them in providers with mocks. Complex logic lives in hooks rather than components, and three of those carry rules worth knowing here.

**Drafts are optimistic-concurrency-checked.** `useDraftManager` persists a draft only where the user actually edited, since `effectiveValue` falls back to `loadedValues`; each branch's drafts live under `canopycms:drafts:<branch>` in a `{ v: 2, drafts, baseVersions }` envelope where `baseVersions[contentId]` is the server OCC version the draft was based on. **A save whose base no longer matches the currently held token surfaces the 409 conflict notification instead of writing**, including a draft restored from the pre-v2 format, which records no base.

**Automatic loads are SWR-backed, imperative reloads are not.** The three fetch-on-load resources (branches list, a branch's entries plus schema, comment threads) go through `swr` with a shared cache whose deduping collapses concurrent requests for one key. An imperative reload instead issues an independent, un-deduped fetch — a caller that just wrote content must see its own change rather than be coalesced with an in-flight automatic load — then writes the result into the cache without revalidating. The commit rules that keep those two paths from showing a stale branch's entries are in [editor/hooks/README.md](packages/canopycms/src/editor/hooks/README.md).

**Preview reference resolution is synchronous**, because fetching a reference's full target asynchronously creates race conditions during state transitions such as discarding all drafts. A `useMemo` computes the resolved value from **form data plus cache** during render, substituting any ID the cache holds and leaving the rest as IDs, while a debounced effect fetches the missing ones. The resolved value is therefore computed, never stored as separate state, so there are no two state trees to synchronize; the cache is branch-scoped, so switching branches cannot show stale cross-branch data.

The editor's admin-only **System Health panel** is a thin view over the [Admin Observability and Recovery API](#admin-observability-and-recovery-api). The editor shell checks admin membership before rendering the button that opens it, but **the real enforcement is server-side** — every endpoint carries the `admin` guard — so the client-side check is a UX convenience, not the security boundary.

## Asset & Media System

CanopyCMS manages binary media (images and PDFs) outside of git. Content references an asset by immutable, content-addressed key; the bytes live in a separate object store; and images are resized and reformatted on demand at delivery time rather than at upload. [assets/AGENTS.md](packages/canopycms/src/assets/AGENTS.md) maps the module, and the design record at `.claude/future-tasks/resolved/assets-media-system.md` holds the rejected upload-time-width-ladder alternative.

### Content-Addressed Storage

Assets live in a single bucket — in prod, new prefixes inside each site's existing content bucket — under a fixed set of prefixes, keyed by a content hash (sha-256 truncated to 128 bits) rather than by a path an editor chooses:

- `asset-originals/` — private, full-fidelity originals, kept forever
- `asset-staging/` — short-lived presigned-upload target, expired by a lifecycle rule
- `asset-meta/` — private per-asset sidecar (original filename, uploader, date, dimensions, mime)
- `assets/` — public static delivery, for sanitized SVGs and PDFs only
- `assets/t/` — transform outputs, where the URL path _is_ the S3 key

Keys are **immutable, content-addressed and unguessable**. Nothing is overwritten or eagerly deleted, and identical bytes deduplicate. That is what gives assets **branch-awareness without git storage**: a draft branch's newly uploaded image is fetchable-but-unguessable immediately, so drafts and PR previews render it before the referencing content is published; publishing needs no asset-promotion step, because the reference already points at the final key; and rollback always resolves, because old keys are never deleted.

**Unlisted is not private.** Key enumeration is an accepted trade-off — the meta listing that powers the media library is open to any authenticated user — so confidential files do not belong in this store. Deleting an asset removes only its meta sidecar; blobs are immortal until a future garbage-collection task.

### Upload and Finalize

Uploads go **directly from the browser to S3** via a presigned POST with a content-length cap and type conditions, so the bytes never traverse the CMS's request path — the serverless function's small request-body limit is irrelevant — and presign generation is local crypto needing no outbound internet.

Once the upload lands in staging, the editor calls a **finalize** step that runs synchronously in the CMS API process. It sniffs the real file type from magic bytes, **sanitizes SVGs** — which cannot be type-sniffed, and are explicitly parsed and stripped of scripts — extracts dimensions honoring EXIF orientation, writes the original and the meta sidecar (plus a public copy for SVG/PDF), deletes the staging object, and returns the structured field value. **The commit-point ordering is deliberate — dedup check, then original, then meta — so a crash never leaves a meta record pointing at bytes that were never written.** Finalize stores no resized variants; its one use of sharp decodes a raster upload into a throwaway resize to catch corrupt pixel data, loaded on first use so a Lambda where it cannot load keeps serving and only skips that check.

### On-Demand Image Transforms

Raster images are **always** served through the transform layer, never as raw originals, which guarantees EXIF stripping and bounds the set of derivatives. A transform URL encodes an imgix-style directive set — allowlisted width, format, quality, and a normalized crop rectangle — as a path segment: `assets/t/{directives}/{hash}/{slug}`. Because the URL path is the S3 key, outputs are cacheable static objects once produced.

Delivery uses a **CloudFront origin group with failover**: the signed S3 origin is tried first; on a 403/404 miss CloudFront fails over to a transform Lambda behind an OAC-locked Function URL, which reads the original, applies the directives, strips EXIF, **writes the canonical output key to S3 first** and then serves the bytes, so the next request for that URL hits the S3 object directly and the Lambda is a fill-on-miss path rather than a per-request resizer. For outputs too large for the Function URL's buffered response cap, and for the transform-failure fallback, it returns a `302` to the now-satisfiable S3 URL with `Cache-Control: no-store` — load-bearing, because caching the redirect instead of the image is a known trap.

**One transform engine, two runtimes.** The directive parser and the sharp-based transform live in the core package; the prod transform Lambda imports that engine verbatim, and dev mode emulates `/assets/t/*` with the same engine on the fly. Identical URLs resolve in every mode, and there is exactly one implementation of what a directive does to an image.

**Bounding the anonymous-reachable path.** `/assets/t/*` needs no authentication — any anonymous viewer reaches it through CloudFront, and the hash in the URL is not a secret, since it appears in every published page's `<img src>`. What that exposes is not access to private content but an _amplifier_: each distinct URL that misses both CloudFront and S3 costs a sharp transform on a large Lambda plus a stored object. The blast radius is capped three ways. Width and quality are **allowlisted**, bounding how many distinct URLs one asset can have. The transform Lambda carries a **reserved concurrency**, capping how much of the account's concurrency pool it can draw and costing nothing when idle. And a request's slug is **validated against the asset's recorded slug**, in both the prod Lambda and the dev emulation, which removes the aliasing multiplier outright: otherwise any `[a-z0-9-]+` string mints a fresh cache key, invocation and stored object for one and the same image. Generated derivatives also carry a lifecycle expiry rather than living forever — they regenerate from the original on the next request, so expiry is self-healing, while unbounded retention lets anything minted this way accumulate permanently.

Cost and unbounded storage are the real exposure here; the reservation is not there to stop the CMS Lambda being starved of concurrency, which has its own reservation and was never at risk. The one unbounded dimension left is the crop rectangle, whose key space no allowlist bounds; capping it needs signed directives and is tracked separately.

The Function URL is locked to CloudFront (OAC / IAM) so the transform Lambda cannot be invoked directly to stuff the cache with arbitrary variants, and both behaviors are attached to the PR-preview distribution as well, so previews of draft branches resolve newly uploaded images.

### Stored vs Rendered Asset URLs

A stored asset reference is **always root-relative** (`/assets/…`), and this is structural rather than conventional: both write paths — finalize and the editor's own field writes — store the raw computed src, and nothing that writes content may bake a prefix into it. The reason is that content moves: the same entry is read from a draft branch workspace, a PR preview, a staging deployment and production, so a stored value naming an origin or a deployment prefix would be correct in exactly one of those and quietly wrong in the rest.

A stored src therefore names only the asset's **position in the `/assets` URL space**. Putting a mount point in front of that space is strictly a **render-time** concern, applied in exactly one place — the `baseUrl` option on `assetUrl`/`assetSrcSet` — and never written back. `media.publicBaseUrl` is one _source_ of that value, the editor's own answer for when it is served from a different origin than the site; it is display configuration, not a property of the asset. See [Routes and Assets Are Two URL Spaces](#routes-and-assets-are-two-url-spaces).

### Structured Image Field

The schema has a first-class `image` field whose value is `{ src, alt, width, height, crop? }` rather than a raw string path, and whose definition can require a fixed aspect ratio (which triggers a crop step in the editor). The stored value is validated at the authoritative server write boundary by the shared isomorphic entry validator — the same one the editor uses — so a malformed image value cannot be saved.

**Crop is a normalized rectangle applied as a URL directive**, never baked into a derived asset, so an image can be re-cropped at any time with no derived-asset bookkeeping and no re-upload. There is deliberately no `variants` array: transform URLs are deterministic functions of the reference plus directives, so host apps build responsive `srcset`s with `assetSrcSet` instead of the CMS tracking a fixed ladder.

### Editor Media UI

One **MediaLibrary** component serves both a manage drawer and a picker modal, as a cursor-paginated grid over the meta prefix. Thumbnail URLs come from a configured public base URL, since the editor may be served from a different origin than the site, and the MDX body editor wires the same dialog into its image plugin so images in prose flow through the same store and transform layer as structured image fields.

**Guards mirror the server exactly**: uploading and listing are open to any authenticated user; deleting is allowed to an admin, or to the asset's recorded uploader, and an asset with no recorded uploader is admin-only. There is no per-asset ACL — assets are branch-agnostic and content-addressed, so the branch and path permission layers do not apply to them.

### Pluggable Store and Delivery Infrastructure

The store contract supports both direct-signed and proxied upload modes and lets a store own its own key and URL resolution. CanopyCMS ships S3 and local-filesystem implementations, and the contract is deliberately broad enough for a git-backed or third-party adapter later **without changing content references**, which stay vendor-neutral: a key plus directives.

The delivery side is packaged as the `AssetSupport` CDK construct, so each site provisions its own asset stack rather than depending on an org-wide shared deployment — the construct is the unit of reuse, so the common case needs no cross-account IAM at all (where a bucket genuinely lives in another account, see [Why do the CMS and transform Lambdas accept a caller-supplied execution role?](#why-do-the-cms-and-transform-lambdas-accept-a-caller-supplied-execution-role)). It supports a standalone or bring-your-own bucket, attaches the two CloudFront behaviors **anchored at the distribution root**, and deploys the transform Lambda bundled with sharp's platform-specific binaries, no Docker required.

## AI Content Generation

CanopyCMS can export its content as clean, AI-consumable markdown with a structured manifest, so AI tools and external indexers can ingest a site without parsing CMS file formats or navigating internal content IDs. [ai/AGENTS.md](packages/canopycms/src/ai/AGENTS.md) maps the module.

Four design goals shape it. It is **read-only and public**, generated from the default branch with no authentication, representing the published state of the site rather than in-progress branch edits. Conversion is **schema-aware** rather than a raw JSON dump, so field labels, descriptions, select option labels, nested objects and block structures all render meaningfully — raw JSON would make consumers understand the CMS data model and would not carry the `description` metadata that gives them semantic context. **No internal identifiers are exposed**: embedded content IDs are stripped and `entry:ID` links resolved to clean URLs. And exclusion is **opt-out**: all content is included by default, and adopters configure exclusions rather than inclusions.

### Transforms

The engine walks the schema tree, reads each entry, and converts it: md/mdx entries render frontmatter as labeled metadata with the body appended verbatim, while json/yaml entries go through schema-driven conversion of every field. Four adopter extension points layer on top. **Field transforms** are per-entry-type, per-field markdown overrides for when the default conversion is insufficient. **Component transforms** rewrite individual MDX components and **body transforms** then operate on the whole body, both for md/mdx only. **Entry transforms** run once per entry and return markdown appended after its body or fields; unlike body transforms they fire for **every** format, including data-only entries, and the appended section is computed once and reused across the per-entry file, the collection rollup and any bundle containing the entry. A throwing entry transform is logged and skipped, and the entry still renders without the section.

An entry transform receives the entry's stable content ID and a `readSibling` reader, which reads a file colocated in the entry's directory **by bare filename — no slashes, no `..`, not absolute** — and returns its contents or `null`, so an adopter can fold a machine-generated artifact named by content ID (invariant under slug edits) into the export. **Canopy performs the IO and the path-safety check internally, and the entry's absolute filesystem path is never exposed to the transform**, so it cannot leak into published output. The transform is deliberately per-entry-isolated: it sees one entry plus its colocated files, never other entries, so cross-entry context must be assembled adopter-side. See [Why is reading sibling artifacts a transform primitive, not a content-model concept?](#why-is-reading-sibling-artifacts-a-transform-primitive-not-a-content-model-concept).

### Output and Delivery

The generator produces per-entry files (one markdown file per entry, with slug, collection and type in frontmatter), per-collection rollups (a collection and its subcollections concatenated, for feeding the lot to an LLM in one request), and bundles — named, filtered subsets defined by the adopter, AND'ing collection, entry type, path glob and predicate filters, which are additive views that remove nothing from the other outputs. A `manifest.json` describes the whole tree so AI tools can discover content without crawling.

The manifest's two build-stamp fields are optional and come from the build environment. **Declaring a build id omits `generated` rather than pinning it**, because under build-once-promote the two are mutually exclusive claims: an artifact built once and promoted months later has a build clock describing the runner, not the content. The environment is read only at the build boundary; the runtime `/ai/*` route shares the generator but keeps a live clock, correct for a response generated on demand. See [build/AGENTS.md](packages/canopycms/src/build/AGENTS.md), which also covers the pruning of files earlier runs produced.

One engine powers two delivery paths, both reading the default branch and sharing configuration and output format:

- **Route handler** (`canopycms/ai`): a Next.js-native catch-all GET handler at its own route, generating lazily on first request and caching in memory — generation walks the whole tree, which is far too expensive per request, while filesystem caching would add directory management, invalidation logic and I/O per request for no gain, and an in-memory cache regenerates on process restart, matching the invalidation cadence of published content. Dev bypasses the cache on every request so content changes show immediately; production sends a short `Cache-Control`. It returns standard `Response` objects and uses neither the `CanopyRequest`/`CanopyResponse` abstraction nor the guard system, because it has no authentication or branch resolution to do.
- **Static build utility** (`canopycms/build`): writes every generated file to disk (e.g. `public/ai/`) during a build or via `npx canopycms generate-ai-content`, for pure static exports with no server at request time. Before writing anything it re-validates every entry against its schema and fails loudly if any are invalid (see [Build-Time Content Validity Guard](#build-time-content-validity-guard)).

Mounting it separately from the editor API is deliberate: that API authenticates every request and resolves a branch, so routing public read-only content through it would mean either bypassing the pipeline or adding a no-auth mode to it, increasing the security surface either way. The caching models are also incompatible, and the AI handler depends only on `ContentStore` and the schema — importing neither the service container, the branch registry, nor the authorization module. Configuration goes through `defineAIContentConfig()` and is shared by both paths.

## Content Tree and Entry Listing

Two batch readers on the context give adopters their whole content set in one call, without knowing about schema flattening, filename conventions, collection directory naming or ordering semantics. The context object is the primary access path, since it handles branch resolution and schema setup.

**`buildContentTree()`** produces a structured tree, for navigation menus, breadcrumbs, sitemaps and search indexes. It takes the already-flattened schema, groups collections by parent and traverses depth-first; for each collection it reads the directory, parses filenames for type, slug and content ID, and reads each entry's data. Child collections and entries are **interleaved** according to the collection's `order` array, with listed items first in their given order and the remainder alphabetical. Each node carries structural facts and leaves display concerns to the adopter.

**`listEntries()`** returns the same content as a flat array, which suits `generateStaticParams`, search indexing, sitemaps and RSS better than a tree does. Each item carries structural metadata (path segments, slug, logical path, content ID, collection path, entry type, format, URL path) plus the entry's data — with index-entry collapsing already applied to the URL path, so adopters use it directly for routing. For md/mdx the data includes frontmatter **and** the markdown body as `data.body`; for data-only formats, all parsed fields. Adopters therefore get full content with no additional reads.

Both take the same shaping options — `extract` for typed custom fields off raw data, then `filter` and `sort`, in that order, so each can use what the previous produced, plus `rootPath` to scope to a subtree — and the tree adds `buildPath` and `maxDepth`. The generic `<T>` flows through so extracted fields stay type-safe. `buildPath`'s default collapses index entries to the parent collection path, matching `readByUrlPath` and `listEntries`.

Both readers and the entries API endpoint need to list a collection's entries, so one shared content-listing module owns filename parsing, entry data reading and order-array ordering — the single source of truth that keeps listing consistent across the editor API, navigation trees and static params. See [Why both a tree and a flat list?](#why-both-a-tree-and-a-flat-list).

### Opt-In Reference Resolution

Both `listEntries()` and `buildContentTree()` accept `resolveReferences`, which expands a reference field's stored ID(s) into the target's `id`/`slug`/`collection`/`urlPath` and, per field via `includeBody`, its body. **It defaults to `false` on both, unlike `read()`'s always-on resolution**: `data` here is the caller's own generic and `extract` takes an untyped record, so flipping the default would silently reshape a reference from a bare ID string into an object under every existing call site with no compile error. Resolution runs **after** the batch ACL filter and **before** `extract`/`filter`, so a filtered-out target cannot leak through a sibling's resolved reference.

Two invariants keep the in-flight resolve cache a pure performance optimization rather than a source of cross-entry bugs: **every occurrence gets its own clone** of a resolved reference, never a shared instance, because an `extract` that mutates one (truncating a body for a search index, say) would otherwise rewrite it for every other entry pointing at the same target; and **the reader that assembles an entry's own data must copy before merging in a body**, never mutate in place, because gray-matter's parse result for md/mdx is cached process-globally and handed to every caller by reference, so an in-place merge corrupts that shared cache for the rest of the process. See [docs/concurrency.md](docs/concurrency.md) for the cache's full contract.

## Static-Export Helpers

Statically generated sites must enumerate every routable content entry to produce route parameters, sitemaps and SEO metadata. The design mirrors the package architecture: a framework-agnostic core plus a thin per-framework adapter.

**The core** exposes `collectStaticPaths()`, which reads routable entries through the build context's `listEntries()` and reduces each to a neutral descriptor: a URL-ready `urlPath` (index entries collapsed, round-tripping with `readByUrlPath`), the URL `segments` array for catch-all routes, the entry `slug` for collection-scoped single-segment routes, and the entry type name. These carry **no framework-specific types** — plain data any adapter can map onto its own static-generation shape — and the helper supports scoping to a subtree and filtering by predicate.

It applies **no publish filtering**, deliberately: publish state is branch-only, so everything a build can enumerate has already merged and is by definition published (see [Publish State Is Branch-Only](#publish-state-is-branch-only)). The one per-entry exclusion any static helper applies is the SEO `noindex` field, and only on surfaces that _advertise_ an entry.

**The adapter** (`canopycms-next`) provides `collectStaticParams()`, mapping those descriptors into what `generateStaticParams` expects for both catch-all routes (the `segments` array) and single-segment routes (the `slug`, paired with a collection scope). Its `basePath` option supports a catch-all nested under a URL prefix (e.g. `app/docs/[[...slug]]`): entries are scoped to that prefix and `segments` made relative to it. **That option is a _route_ prefix inside the app and is not the deployment prefix of the same name** — it filters entries, so handing it a deployment prefix enumerates nothing (see [Render-Time URL Prefixes](#render-time-url-prefixes)).

**The recommended adopter API is the bound method**, `generateContentStaticParams()` on the `createNextCanopyContext` result, which closes over the guarded build context so page modules never import or hold the admin build context just to enumerate paths. That is safe because `generateStaticParams` is build-only. It is also the least-privileged of three distinct capabilities: **enumeration** reads only the set of routable paths, never entry content; **content read** (the phase-selecting `read`/`readByUrlPath`) resolves a single entry and is ACL-correct at request time because it routes through the runtime context; and **`getCanopyForBuild`** is the unrestricted, ACL-bypassing escape hatch, prod-guarded against request-time misuse. Ordinary page code reaches for the first two.

**Sitemap generation and SEO metadata** follow the same core-plus-adapter pattern: the core's `collectRoutableEntries()` — the same enumeration with `data`/`updatedAt` carried through — backs the adapter's `generateContentSitemap()` and `entryToMetadata()`. Both read `noindex` through the same `isNoindexEntry` predicate `extractSeoFields` derives, so a page cannot be suppressed from one advertising surface while still appearing in the other.

`generateContentSitemap`'s `pathFor` override — for advertising an entry at a URL other than its own `urlPath` — is a **seam** in the "no two entries share a URL" invariant, not an exception to it: `assertNoDuplicateUrlPaths` runs inside `collectRoutableEntries` on the raw enumeration, before `pathFor` rewrites anything, so a `pathFor` mapping two entries onto one path is invisible to that guard. The only backstop is `dedupeSitemapItems`'s warn-and-drop-the-rest, a console warning rather than a failed build. Treat a `pathFor` collision as caught by convention, not by the guarantee the base invariant has.

### Build-Time Content Validity Guard

Static builds enumerate and export content without passing through the editor's save-time validation, so a schema-invalid entry on disk — most often an abandoned create-scaffold, the empty entry the create flow writes before the user fills it in — could otherwise ship silently as a page that disappears from route generation or as malformed content in an AI export. Both `collectStaticPaths()` and the AI content build utility **re-validate every entry against its schema before proceeding**, using the same pure validation logic as the editor's save boundary, and fail the build loudly listing **every** offending entry rather than just the first.

The guard is deliberately build-only. `collectStaticPaths()` enforces it only when a build-mode marker is set, because fresh create-scaffolds legitimately exist mid-edit in development and failing the dev server on every unfinished draft would make routine editing unusable; the AI content build utility enforces it unconditionally, since it only ever runs as an explicit build step. Saving stays permissive by design: this runs at the point content is about to be exported for public consumption. [static/AGENTS.md](packages/canopycms/src/static/AGENTS.md) covers all four build guards and the slug-enforcement invariant that pairs with the write boundary.

## Render-Time URL Prefixes

A CanopyCMS site is not always served at an origin's root: it may live under a deployment prefix (per-branch preview builds being the common case), its assets may live on a separate CDN origin, or both. **Everything CanopyCMS stores is written as though the site were at the root; a prefix is applied only at render time.**

### One Prefix Join, Shared

Two surfaces need the identical operation — SEO URL resolution putting a site origin in front of an entry's URL path, and asset URL building putting a mount point in front of a stored `/assets/…` src — and they must share **one** prefix-join primitive, because two implementations drift towards the weaker one: an asset copy that checked neither the absoluteness of the path (so an off-site src became `/prefix/https://cdn.example.com/x.png`) nor the shape of the prefix (so a prefix without a leading slash produced a _document-relative_ URL resolving differently on every page, an intermittent failure much harder to diagnose than the plain 404 it replaced).

The primitive's rules:

- **An already-absolute or protocol-relative path passes through untouched.** That value is a deliberate off-site pointer — a syndicated canonical, a partner-hosted copy, a CDN image — and prefixing it corrupts it.
- **Order matters**: the absoluteness check runs _before_ prefix normalization. The reverse order is what rewrites an off-site canonical into a same-site path.
- **An empty prefix, or one that is nothing but slashes, is a clean no-op**, so the unset case stays root-relative. This also rules out a bare `//` prefix, which browsers read as protocol-relative — a request to a host literally named `assets`.
- **Anything else is normalized** to either a declared off-origin prefix (used as-is) or a leading-slash same-origin path prefix.

The primitive is deliberately pure and dependency-free, because asset URL building is reachable from the editor's client bundle and `pnpm lint:bundle` fails the build if a node built-in creeps into it. Sharing one function is what stops a third caller inheriting the weaker half of the behavior. The scheme rule is deliberately **not** shared — see [utils/AGENTS.md](packages/canopycms/src/utils/AGENTS.md).

### Routes and Assets Are Two URL Spaces

A deployment prefix always moves the **route** space. Whether it also moves the **asset** space is a property of the deployment topology, not of the prefix:

- **On a CloudFront deployment** (the `AssetSupport` construct), the app moves under the prefix but the asset space does **not**: the CDN's `/assets/*` and `/assets/t/*` behaviors are anchored at the distribution root, and the transform function rejects any request outside the transform prefix. Deriving the asset mount point from the deployment prefix here breaks URLs that were working.
- **Where the framework itself serves `/assets`** — the local/LFS store adapter, `next dev`, or S3 with no distribution in front — the `/assets` rewrite belongs to `withCanopy()`, so Next.js auto-prefixes it and the deployment prefix _does_ apply.

Two consequences follow. Adopter guidance is a **mount table keyed on where assets are served**, not a rule keyed on whether a deployment prefix is set. And the asset mount point is a **per-render option rather than a config field**, because the editor and the public site can legitimately have different answers: the editor's is `media.publicBaseUrl`, the public site's comes from the table.

`media.uploadUrl` is **not** a third answer, despite sitting beside `publicBaseUrl` on the same config object: it names the endpoint the browser POSTs a presigned upload to, a transport detail of the write path, and is never joined onto a stored `/assets/…` value, never rendered, and never written into content. The two fields are neighbours, not variants, which is why one is a prefix and the other replaces a URL outright.

### The Deployment Prefix (`basePath`)

The configuration carries a top-level deployment prefix naming where the host app is served (e.g. `/preview-123`). CanopyCMS cannot read the host framework's config at runtime, so this must be stated explicitly. It is threaded through to the client config and drives three things: the editor's API base URL, the preview iframe's `src`, and the preview↔editor path matching below. Unset means the app is served at its origin's root, and every use site runs it through the shared join, so unset is a no-op everywhere.

It is deliberately **not** the asset mount point, for the topology reason above.

It is also deliberately **not** an argument to the static-params helper, even though that helper has an option of the same name. There, `basePath` means "the route prefix of a nested catch-all route" and it _filters_ enumerated entries down to that prefix, so passing a deployment prefix matches no content at all — zero static params, and a build that goes green having shipped an empty site. Because that failure is silent, **the URL builders take no `basePath` argument at all**: there is only the mount point, rather than a same-named option a reader could plausibly reach for.

### Preview Path Identity

The preview URL the editor builds for an entry is used **twice**: as the iframe's `src`, and as the string compared against the browser-reported location path to decide which entry a framed page is showing, which drives draft sync and click-to-focus. Browsers report that path _with_ the deployment prefix included. So an unprefixed value 404s the iframe, and a value prefixed on some code paths but not others breaks draft sync even when the iframe itself resolves.

The builder is therefore split into an unprefixed core plus a thin wrapper applying the prefix **exactly once**, at the end, uniformly across every branch of the builder — including the fully-custom per-entry preview override, whose absolute form passes through untouched by the join's own rule. One prefix, applied in one place, is what keeps the two uses of that string in agreement.

## Extensibility Points

### Authentication

Authentication is provided by separate packages; the core has no built-in provider, so Clerk, Auth0, NextAuth, Supabase Auth or a custom solution all work (`canopycms-auth-clerk` is the reference implementation). Plugins implement the `AuthPlugin` interface — user identity extraction, group membership lookup, session validation — plus one optional method, **`verifyTokenOnly(context)`**: networkless JWT verification returning just a user ID. When it is implemented, framework adapters automatically enable file-based auth caching, which is the path for Lambda deployments with no internet access and makes dev mirror prod.

**Production trust gate — `verifiesCredentials`.** Framework adapters check every configured auth plugin against the operating mode before using it: **if `mode` is `'prod'` and the plugin does not affirm `verifiesCredentials: true`, the adapter throws at handler creation rather than serving traffic.** This is an allowlist, not a denylist — a plugin must actively declare that it performs real cryptographic credential verification to be trusted in production, so one that omits the marker is rejected whether it is the dev plugin (which intentionally trusts request headers for local development) or a third-party plugin that simply forgot. `CachingAuthPlugin` forwards rather than declares it (see [Auth Caching](#auth-caching-cachingauthplugin)), and the static-deployment stub plugin sets it, since an always-deny plugin is trivially safe in any mode.

### Framework Adapters

Adapters handle two concerns: **user extraction** from the framework's request context, and **request/response adaptation** to the core `CanopyRequest`/`CanopyResponse` types. The response type is not limited to JSON — it also carries a binary/stream variant, and requests can expose raw unparsed bodies, both for the asset system, which serves bytes and accepts non-JSON uploads. The adapter's public API accepts standard `Request` and returns standard `Response` (see [Dependency Model](#dependency-model)), while internally still using Next.js APIs. A new adapter means implementing user extraction, wrapping core context creation with any framework-specific optimization, exposing one API that works in pages and route handlers, and optionally wrapping the core API handler for the framework's routing.

**The `withCanopy()` Next.js config wrapper** handles the build-tooling concerns:

- **Module transpilation**: Canopy packages export raw TypeScript, so `withCanopy()` auto-detects which Canopy packages are installed and adds only those to `transpilePackages`, avoiding Next.js build errors from listing uninstalled ones.
- **React deduplication**: with `file:` references or linked packages, the bundler can follow symlinks into a linked package's `node_modules` and resolve a second copy of React, whose dual instances cause "Invalid hook call" crashes. `withCanopy()` resolves React from the consumer's project root through Webpack aliases **scoped to canopycms source files only**, so Next.js internals are untouched, and from npm the aliases are harmless. Turbopack does not support those absolute-path aliases, so `file:`-symlink development needs `next dev --webpack`.
- **Dual-build page extensions**: the `staticBuild` option selects which per-build file variants Next.js includes — `server.ts`/`server.tsx` by default, `static.ts`/`static.tsx` when it is `true`, each build then ignoring the other's variants. The mechanism is **additive**: each build adds different extensions on top of Next's defaults and nothing is removed from a shared list, which is what lets an editor-only `layout.server.tsx` exist. This is how one codebase produces both a public static export and a CMS server build, with a build-time flag rather than runtime checks.
- **Reproducible static exports**: with `staticBuild: true`, Next's build id is pinned to `CANOPY_BUILD_ID`, because Next defaults `generateBuildId` to `nanoid()` and two builds of one source tree would otherwise land under different `out/_next/static/<id>/` directories, breaking any deployment that content-addresses its artifacts. It is deliberately **not** applied to the CMS build: the two flavors have different `pageExtensions` and therefore different chunk sets, and one shared id naming both would leave nothing able to route between them if they share an origin.
- **Standalone tracing of sharp's libvips**: sharp loads libvips through its native binding's rpath, which import-following tracers never see, so outside a static export `withCanopy()` locates each installed libvips package's real `lib/` directory and adds it to `outputFileTracingIncludes` under the key the installed Next reads, merging with the adopter's own includes and refusing directories outside the tracing root. A build that finds nothing warns with a manual config snippet rather than failing. This is temporary, and should go once a Next release traces the library itself; it fixes Turbopack builds and not a pnpm webpack build, which bundles sharp's JavaScript into a server chunk where it cannot reach its binding ([webpack-standalone-sharp-bundled.md](.claude/future-tasks/webpack-standalone-sharp-bundled.md)). [docs/deploying-to-aws.md](docs/deploying-to-aws.md#dual-build-support) has the adopter-facing version.
- **Turbopack default guard**: Next 16 defaults both `next build` and `next dev` to Turbopack and exits if the exported config has a truthy `webpack` with no `turbopack` beside it. The React-dedup aliases above are exactly such a key, and they matter only to `file:` symlink installs, which already need `--webpack` — so on a detected Next 16 or later `withCanopy()` answers the guard with an empty `turbopack: {}`, but only when the adopter supplied neither a `webpack` of their own (where Next's guard is the correct outcome) nor their own `turbopack` (never overridden).

Canopy packages export raw TypeScript rather than pre-compiled output, because a build step would slow the development loop and push debugging through compiled artifacts. **The one exception is the `canopycms-next/config` subpath** `withCanopy()` itself is imported from, which resolves to an esbuild-bundled `dist/config.{cjs,mjs}`. That isn't optional: Next.js loads `next.config.mjs` directly in Node before any bundler initializes, so `transpilePackages` never gets a chance to run against the config file's own imports, and whatever it imports must already be executable JavaScript. Any future subpath a consumer's config file must import faces the same constraint.

### Save-Time Validation Hook

The config accepts a `validateEntry` hook for adopter-defined server-side validation of every editor save (see [Save-Time Validation](#save-time-validation)). Unlike auth plugins and framework adapters it needs no separate package: it is a deliberate config-surface extension that stays inside the existing config touchpoint, preserving the config + Editor + one-API-route contract.

## Key Design Decisions

### Why are binary assets stored in object storage instead of git?

Git history is append-only, so every replaced image version would live forever, and the clone-per-branch-on-EFS model would multiply that weight into every branch provision. Content-addressed keys in a separate store sidestep both and give branch-awareness for free (see [Asset & Media System](#asset--media-system)). References stay vendor-neutral — a key plus directives — so a git-backed adapter remains possible for tiny adopters.

### Why transform images on demand instead of a fixed width ladder at upload?

An upload-time ladder was simpler to build but aged badly: sharp in the CMS request path, per-field width hints for odd sizes, derived assets for cropping, and worker back-fill jobs whenever the ladder or quality changed. On-demand transforms put all of that behind a deterministic URL — any size available, crop a re-editable rectangle, a pipeline change just a cache-key change — for one Lambda per site and a sub-second first hit per variant.

### Why do the CMS and transform Lambdas accept a caller-supplied execution role?

Because a site's asset bucket can live in a different AWS account than its compute, and granting access then requires the _bucket's_ stack to write a resource policy naming the Lambda's principal as a **plain ARN string**. Reading that ARN off a Lambda in another stack looks like it should work, but across an account boundary CDK resolves it only through a CDK-CLI-only mechanism evaluated at deploy time: invisible to CloudFormation, working under `cdk deploy` and nothing else, and — unlike an ordinary circular dependency — not failing at synth. A caller-supplied role lets both stacks compute the ARN from literals instead.

Two consequences. CDK attaches baseline execution policies, and a VPC-attached function's ENI permissions, only to a role it creates itself, so both constructs re-attach them through one shared step when a caller supplies the role; otherwise the CMS Lambda deploys cleanly and never starts. And the prop takes a concrete, mutable role rather than a reference to an existing one, because granting permissions to an externally-referenced role is a silent no-op with nothing in that call path to raise an error. See [docs/deploying-to-aws.md](docs/deploying-to-aws.md#cross-account-asset-bucket).

### Why do settings use a separate branch?

So that permission updates never interfere with content editing and content PRs cannot accidentally carry permission changes. A settings PR must be explicitly merged, which is what prevents accidental permission escalation or lockout, and the branch's history is the audit trail for who changed access and when.

### Why does `canopycms init` scaffold `defaultBranchAccess: 'deny'`?

So that "secure by default" is true of a generated project and not only of the package's own schema default. `'deny'` is usable rather than merely strict because of the two grants under [Layer 1](#layer-1-branch-access) — without them a freshly created branch is inert for its own creator and the protected base branch unreachable for every non-admin — and with them the default means what an adopter would want: "branches you neither created nor were invited to."

The frictionless first run `'allow'` appears to provide does not come from `'allow'`. The template sets no `defaultPathAccess` at all, so a scaffolded project is already fail-closed on the path layer; what makes a fresh project work is `canopycms-auth-dev` auto-setting `CANOPY_BOOTSTRAP_ADMIN_IDS`, and admins bypass both layers. `'allow'` therefore only ever takes effect for non-admin editors — precisely the multi-editor case it should not cover.

### Why is `mode` required, and why an allowlist (not a denylist) for auth plugin trust?

Two rules close one gap: a prod deployment silently running header-trusting auth because of a missing config value.

- **`mode` has no default.** A fallback to `'dev'` would let a prod deploy that omitted the field authenticate every request by trusting whatever identity a caller claims — no error, no warning. Requiring it turns that mistake into a loud validation failure at startup.
- **`verifiesCredentials` is an allowlist.** Asking plugins to opt _out_ of production use fails in the wrong direction: a third-party or hand-rolled plugin that doesn't know about the marker would be trusted by default, which is backwards for a check whose purpose is preventing header-spoofing impersonation. A marker a plugin must affirmatively set makes rejection the safe default.

### Why is the worker daemon split into free functions over a context?

The daemon's one entry point fans out into four call trees sharing almost nothing but the object they hang off, so they wanted splitting — and the conventional answer, collaborator objects each constructed at startup with the dependencies they need, was rejected for a specific reason.

The worker's contract with its own tests is that it is reachable **through the live instance**: tests aim a push at a local fixture repo by replacing the URL builder on a running worker, substitute a mock GitHub client, stub out task execution, and subclass to override protected hooks. A collaborator constructed at startup captures whichever of those it needs and then hands the extracted code the pre-test value — which for the URL builder means a test pushing at GitHub for real. That is a test suite quietly losing its grip on the code, and it fails in the most expensive direction.

So the class stays a thin lifecycle shell with one delegating method per duty cycle, and each duty cycle is a module of free functions taking a context. Two properties of that context are load-bearing rather than stylistic: **every instance-backed member is a function**, and the shell builds a **fresh context per call**. Together they mean a replacement made on the instance after construction is still honored, and the seam is a plain object rather than a mocking framework. The cost is one rule the clusters must follow — always call through the context, never a same-named module function sitting next to the caller.

**The worker's configuration object deliberately stays as it is**, a flat bag mixing credentials, poll intervals, retry policy and a lock TTL: it is public API, constructed by the CDK package and available to adopters, so restructuring it would be a breaking change dressed up as a refactor. Each module narrows the shared context to the subset it uses at the type level instead.

### Why does ClerkAuthPlugin resolve its secret lazily?

So that a zero-editor public build can import the same `canopy.ts` module — configured with `mode: 'prod'` and a real plugin — without the secret in that build's environment: the plugin is instantiated but never authenticates anything there. Only code calling Clerk's backend API needs the secret (the auth-cache refresh, or an unwrapped plugin), and a CMS Lambda needs it for neither, because `CachingAuthPlugin` authenticates through `verifyTokenOnly()` with the JWT key alone. An adopter's `clerkMiddleware` is what would bring the secret back onto the Lambda (see [Security Model](docs/deploying-to-aws.md#security-model)).

### Why one GitHub App per site, not one shared across an organisation?

The worker can authenticate as a registered GitHub App instead of a personal access token, and CanopyCMS registers one App **per site**, against the obvious economy of one App installed everywhere, because of where the key lives: a GitHub App's private key is scoped to the App, not to an installation. Restricting a token to one repository is a choice the key-holder makes when minting it, not a boundary GitHub enforces against whoever holds the key, so anyone holding it can enumerate every installation and mint a token for any of them. Canopy's key cannot be kept in one guarded place — each site's worker reads it at runtime from that site's own secret store — so one App with write access to repository contents would mean compromising one site's secret store grants write access to every other site's repository. The cost is accepted rather than hidden: one more key per site to rotate.

### Why "Publish Branch" doesn't actually publish?

Separation of concerns. CanopyCMS handles content editing and PR creation; merging the PR and deploying the site belong to GitHub and the adopter's CI/CD. That keeps any merge and deploy workflow possible, and means CanopyCMS never needs credentials that could push to production.

### Why is the branch registry a cache, not a source of truth?

`branches.json` is a **read-only cache** for fast branch listing; each branch workspace's own `branch.json` is the source of truth. That eliminates the synchronization bugs a second writable copy invites, and the cache is only ever regenerated, never updated in place, so there are no write conflicts.

A state change bumps a cross-process generation marker and eagerly regenerates the snapshot on the mutating host; each snapshot embeds the token it was built against, and `list()` regenerates only when that token differs from the live marker. So a bump is observed by every process sharing the root, scanning is amortized across reads, and a corrupted or resurrected snapshot is fixed by the next read's comparison. `get()` forces one throttled regeneration when a looked-up branch is missing, bounding the "branch exists but the snapshot predates it" window.

**One bad file must not become an outage**: a branch directory whose `branch.json` is corrupt or unreadable is quarantined out of the scan rather than failing it. The branch stays on disk, invisible to the registry but reported and repairable through the admin branch-health surface.

### Why separate `deployedAs` from build mode detection?

The real question is not "are we building?" but "is this deployed as a static site?" — a static deployment has no users, no request context and no auth, during `next build` and `next dev` alike, and `deployedAs: 'static'` is a config-driven declaration covering that whole lifecycle. Two checks rather than one, because they are different claims: `deployedAs` is static ("this deployment never has users"), while `isBuildMode()` is dynamic ("auth is unavailable right now, though this is normally a server deployment"). Their union covers every case where permissions should be bypassed.

### Why does a build read the working tree instead of a branch clone?

A build ships the checkout it runs in — CI building a commit, or a developer building locally — so that checkout is the only honest source. Resolving a branch clone instead renders whatever the clone holds, seeded from git-committed state, so an uncommitted edit or rename is invisible to a green build; and it makes an image build depend on git state it has no reason to have, failing outright when the builder's synthesized repo lacks the configured base branch. `readsFromCheckout(config)` makes it unconditional (see [Static Deployment and Build Mode](#static-deployment-and-build-mode)).

### Why split a dual-build content route into static and server page variants?

A content route in a dual-build site must behave differently per build: the static export must prerender every known path (`dynamicParams = false`, required by `output: 'export'`), while the CMS server build must render every request live so runtime path ACLs apply and unknown slugs 404 correctly. Two single-page approaches were tried and rejected empirically:

- **A route-segment config value computed from an env var** fails at build time: Next.js statically parses route-segment config and requires literal values, so a computed expression is a hard build error, not a runtime branch.
- **A single page with `dynamicParams = true` plus `generateStaticParams`** builds, but on the CMS server an unknown slug is then served via on-demand static generation rather than an ordinary request, and the request-scoped read's `headers()` call throws `DYNAMIC_SERVER_USAGE` — still a 500. Worse, prerendering on the CMS build serves build-time content to anonymous visitors, bypassing runtime path ACLs entirely.

So each build gets its own thin page file re-exporting a shared implementation: the static variant re-exports `generateStaticParams` and sets `dynamicParams = false`; the server variant sets `dynamic = 'force-dynamic'` with no `generateStaticParams`, so every request renders live and ACL-enforced, unknown slugs reach the page's own `notFound()`, and it **prerenders nothing**. `withCanopy()`'s `staticBuild` option picks up only the matching variant per build, so the page needs no runtime branching.

### Why branded types for paths?

A "logical" content path like `posts/hello` and a physical path like `/var/data/branches/feature-1/content/posts/hello.json` are different kinds of value, so the paths module makes them different **types** the compiler tracks separately, and passing one where another is expected is a compile error. The cost is explicit conversion at boundaries and type guards to maintain; the benefit is that security-sensitive path code is reviewable and hard to misuse, which matters most where a bug would be a traversal vulnerability.

### Why a URL sanitization utility in core?

CMS content is user-authored, so URLs in link fields, CTAs and rich text are untrusted input: a `javascript:` or `data:` URL rendered into an `href` is an XSS vector, and an unchecked redirect URL is a phishing vector. Core therefore ships `sanitizeHref`, which parses with the standard `URL` constructor and **allowlists only `http:` and `https:`** — a closed set, where denylisting known-bad schemes stays fragile against new schemes and parser quirks. It returns a new string derived from the parsed URL object rather than the original input, which breaks static-analysis taint chains and gives adopters one auditable point for URL safety.

### Why filename-embedded content IDs?

A reference system needs identifiers that survive renames and moves, and every alternative costs more: database IDs add an external dependency and a git synchronization problem; a JSON registry needs synchronization logic and introduces write conflicts across processes; git blob hashes are not stable across edits; a symlink directory adds a parallel tree to keep consistent. Filenames need none of that — renames are atomic, IDs survive `git mv` and show up in diffs, and several processes can read the same names with no coordination.

### Why eventual consistency for the index?

The content ID index is per-process rather than globally synchronized, trading a bounded staleness window for robustness: no distributed locking or deadlock risk, no write conflicts, and self-healing on a suspicious lookup. For a system that autoscales to many concurrent requests, process-local indexes coordinated through the shared filesystem are simpler and scale better than a shared synchronized one — and editors work at human speeds, so second-scale windows do not materialize as conflicts. See [Multi-Process Consistency](#multi-process-consistency).

### Why entry types with cardinality instead of a singleton model?

Modelling all content as typed entries inside collections, with `maxItems` as a constraint, eliminates the special cases a separate singleton concept forced: no "is this path root-level?" heuristics, no separate flattening path, no singleton-first fallback in path resolution, and no navigation logic telling singleton nodes from collection nodes. Treating the content root as a normal collection with `parentPath: undefined` is the other half — every collection has identical structure regardless of nesting, and the root is the one without a parent. `FlatSchemaItem` is then a discriminated union on `type`, so the compiler enforces correct field access. What remains is a clean split: collections are structure, entry types are schema, cardinality is a constraint — and entry types stay out of navigation, because the tree shows structure rather than schema.

Flattening that model into a `Map` is what makes it cheap: path resolution is a single lookup rather than a tree traversal, full paths are computed once at initialization rather than re-joined per request, and invalid structure is caught at startup. The memory cost is a few KB per collection, shared across all requests.

### Why use the entry type name for `maxItems: 1` filenames?

A singleton's file is stored at the collection root as `{collectionPath}/{entryTypeName}.{id}.{ext}`, so its location is predictable and it carries the same ID-in-filename pattern, rename handling and `read(path, slug)` API as any other entry, with no collisions in a collection that mixes cardinality-constrained and unlimited types.

**Open footgun in the same corner:** `read({ entryPath })` with no `slug` falls back to the entry TYPE's name as the effective slug, for every entry type, not only `maxItems: 1` ones — it happens to resolve for a singleton only because that entry's on-disk slug was itself set to the type name. Rename that slug, which is exactly what modelling a singleton as a collection's landing page requires, and the read silently stops resolving it: no thrown error, no type error, and a static build can still go green having prerendered a 404. See [entrypath-read-resolves-by-entry-type-name.md](.claude/future-tasks/entrypath-read-resolves-by-entry-type-name.md).

### Why async service initialization?

Loading `.collection.json` files is file I/O and services need a fully resolved schema before they can operate, so initialization is async and its promise is created once at module load and cached: file scanning happens once per process or container lifecycle, every request awaits the same promise and gets the same services instance with its schema cache, and an initialization error is thrown once rather than per request. The alternatives are worse — synchronous initialization with lazy loading blocks a request on first access and needs locking to survive concurrent triggers, and per-request meta loading trades the cache for file I/O on the hot path.

### Why is reading sibling artifacts a transform primitive, not a content-model concept?

The page-render path already lets adopters read a colocated artifact through a build context's `meta.physicalPath`, and `readSibling` gives the AI exporter the same capability with the smallest possible primitive. Modelling sibling artifacts in the content model itself was deliberately deferred: it is premature for a single adopter and raises unresolved questions about how such artifacts interact with the editor UI, schema validation and the branch workflow, which a transform primitive answers by committing to none of them.

### Why both a tree and a flat list?

Content is inherently hierarchical, and the tree preserves that for navigation, breadcrumbs and sitemaps — but many common uses (static params, search indexes, RSS) naturally want a flat array, and making adopters flatten a tree themselves is both awkward and slower than a purpose-built listing. Both are separate from the AI content generator, which serves a different audience in a different format though all three walk the schema and filesystem.
