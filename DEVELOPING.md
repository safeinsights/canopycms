# Developing CanopyCMS

Development guidelines and patterns for contributors to CanopyCMS.

## Code Patterns

### Error Handling

Catch as `unknown` and narrow with the utilities in `src/utils/error.ts`. `unknown` is safer than `any` for a caught value, and these give type-safe access to error properties without a cast:

```typescript
import { getErrorMessage, isNotFoundError, isNodeError } from './utils/error'

try {
  await riskyOperation()
} catch (err: unknown) {
  if (isNotFoundError(err)) return null
  if (isNodeError(err) && err.code === 'EACCES') {
    throw new Error(`Permission denied: ${getErrorMessage(err)}`)
  }
  throw new Error(`Operation failed: ${getErrorMessage(err)}`)
}
```

| Function                 | Purpose                                 |
| ------------------------ | --------------------------------------- |
| `getErrorMessage(err)`   | Message string from an `unknown` error  |
| `isNodeError(err)`       | Type guard for a Node error with `code` |
| `isNotFoundError(err)`   | `ENOENT`                                |
| `isPermissionError(err)` | `EACCES`                                |

### Path Handling with Branded Types

`src/paths/` carries two branded path types, and mixing them up is a class of bug the types exist to stop:

| Type             | What it is                                         | Example                       |
| ---------------- | -------------------------------------------------- | ----------------------------- |
| `LogicalPath`    | Schema-defined, user-facing; no IDs                | `content/docs/api`            |
| `PhysicalPath`   | Filesystem path with embedded content IDs          | `content/docs.xyz/api.def456` |
| `CollectionPath` | Collection identifier; superseded by `LogicalPath` | `blog/posts`                  |

ContentStore methods take `LogicalPath`; the ID index stores `PhysicalPath`. Convert with `resolveLogicalPath(physicalPath, schemaItems)` before calling into ContentStore — see `packages/canopycms/src/paths/resolve.ts`, whose comments state the segment-matching rule. `createLogicalPath()` throws on traversal sequences; `normalizeCollectionId('content/posts')` strips the content root.

```typescript
// Client code: import directly, to stay clear of server-only modules
import { createLogicalPath, normalizeCollectionId } from './paths/normalize'

// Server code: the barrel is fine
import { resolveLogicalPath, type LogicalPath, type PhysicalPath } from './paths'
```

Client code must import from `./paths/normalize` (and `./paths/branch-name`) rather than the `paths` barrel, which pulls node built-ins into the browser bundle. Enforced by `pnpm lint:bundle` — see [Client-Bundle Boundary Check](#client-bundle-boundary-check).

### Field Traversal

`validation/field-traversal` walks schema-aware data — objects, arrays, and blocks with their `_type` discriminator — so reference validation, reference resolution and data transformation share one traversal:

```typescript
import { traverseFields, findFieldsByType } from './validation/field-traversal'

const refs = findFieldsByType(schema.fields, data, 'reference')
// [{ field, value, path }, ...]
```

### Authorization

`src/authorization/` is the single entry point for access checks. `checkContentAccess()` combines the branch and path layers and is what you normally want; `isAdmin`/`isReviewer`/`isPrivileged` from `helpers.ts` are the quick role checks.

```typescript
import { checkContentAccess, isAdmin } from './authorization'

const result = await checkContentAccess(
  deps,
  ctx,
  branchRoot,
  'content/posts/post.mdx',
  user,
  'edit',
)
if (!result.allowed) {
  // result.reason explains the denial
}
```

See [authorization/AGENTS.md](packages/canopycms/src/authorization/AGENTS.md) for the module's invariants and [ARCHITECTURE.md](ARCHITECTURE.md#the-permission-model) for the layering.

### State Management (Editor Components)

Editor components take their dependencies from React context, which keeps tests free of global mutable state: `ApiClientProvider`/`useApiClient` (`context/ApiClientContext`) for the API client, and `EditorStateProvider`/`useEditorState`/`useEditorModals` (`context/EditorStateContext`) for loading, modal and preview state. Wrap the tree in the provider and inject a mock client.

### Module Organization

Group a module into a directory once it has several related files (types, helpers, tests); keep single-file modules flat for discoverability. [AGENTS.md](AGENTS.md#code-organization) maps every module to its own `AGENTS.md`.

## Architecture Patterns

### Framework-Agnostic Core

`canopycms` holds all business logic and takes its framework-specific pieces by dependency injection; it never imports Next.js, Express, or any other framework. Adapter packages (`canopycms-next`) stay thin — extract the user and request from the framework's APIs, add framework-specific caching, and expose one unified API.

Core declares the seam — `CanopyContextOptions` in `packages/canopycms/src/context.ts` takes pre-created `services` plus an `extractUser: () => Promise<CanopyUser>` the adapter supplies. `packages/canopycms-next/src/context-wrapper.ts` fills it from Next's `headers()` via `authPlugin.authenticate()`, then `resolveCanopyUser()` to apply bootstrap admin groups.

### Context Factory Pattern

`createCanopyContext()` returns a `getContext()` called per request: it refreshes the active branch, resolves the user (short-circuiting to `STATIC_DEPLOY_USER` for a static deployment or a build), and builds the content reader. `createNextCanopyContext()` wraps it, adding React `cache()` for per-request memoization plus the catch-all handler:

```typescript
// app/posts/[slug]/page.tsx
const { getCanopy } = await createNextCanopyContext({ config, authPlugin, entrySchemaRegistry })
const canopy = await getCanopy()
const { data } = await canopy.read({ entryPath: 'content/posts', slug: params.slug })
```

### Static Deployment Detection

CanopyCMS has two deployment shapes: **server** (editor and API answering requests) and **static** (pre-built, no request context, no auth). Detection lives in `packages/canopycms/src/build-mode.ts`:

- `isDeployedStatic(config)` is the primary, config-driven check — it reads `deployedAs`, which defaults to `'server'`. Adopters set it from an env var in `canopycms.config.ts`.
- `isBuildMode()` is the env-var safety net (`NEXT_PHASE=phase-production-build`, `CANOPY_BUILD_MODE=true`), covering a `server` deployment whose `getCanopy()` runs from `generateStaticParams` with no request context.
- `STATIC_DEPLOY_USER` is the frozen synthetic admin used when auth is bypassed.

Anywhere auth may be skipped, use the combined check:

```typescript
if (isDeployedStatic(services.config) || isBuildMode()) {
  // skip auth / use STATIC_DEPLOY_USER
}
```

`authPlugin` is optional when `deployedAs: 'static'` — a stub is used internally for the API handler.

**Testing it:** prefer `deployedAs: 'static'` in the test config over env-var manipulation, and assert `canopy.user` is `STATIC_DEPLOY_USER` while the injected `extractUser` is never called. If you must exercise the `isBuildMode()` path, set `CANOPY_BUILD_MODE` and `delete` it in a `finally`.

### Static-Export Helpers (`generateStaticParams`)

Prefer the framework helper over a hand-rolled `generateStaticParams`. `generateContentStaticParams(opts)` is a bound method on the `createNextCanopyContext()` result: it closes over the guarded build context, so page modules enumerate routable content without importing the admin `getCanopyForBuild`. Wire it through `lib/canopy` and call it from each page — [README.md](README.md#static-export-with-generatestaticparams) has the adopter recipe and the option list.

Under the hood the bound method calls the framework-agnostic `collectStaticParams(buildCtx, opts)` (`canopycms-next`), which maps the neutral `StaticPathEntry[]` descriptors returned by core `collectStaticPaths(ctx, opts)` (`canopycms/server`). Reach for those free helpers only when building a non-Next adapter or a sitemap.

`apps/example1/app/posts/[slug]/page.tsx` (single-segment) and `apps/example1/app/docs/[[...slug]]/page.tsx` (nested catch-all with `basePath`) are the worked examples.

### Build-Time Single-Entry Reads

There are three ways to read a single entry, and the wrong one at build time returns `null` silently — the "builds fine, dev blank" trap:

| Source                                         | Phase                | ACLs / branch                              | Use for                     |
| ---------------------------------------------- | -------------------- | ------------------------------------------ | --------------------------- |
| `createNextCanopyContext().read/readByUrlPath` | Either, auto-selects | Build context at build, runtime at request | Recommended page surface    |
| `getCanopy().read/readByUrlPath`               | Request only         | Branch-aware, enforces ACLs                | Server-component rendering  |
| `getCanopyForBuild().read/readByUrlPath`       | Build only           | Synthetic admin, no ACLs                   | Escape hatch: build scripts |

**Never call the runtime `getCanopy().readByUrlPath()` at build time** — with no request context it returns `null` and the generated pages come up blank. The phase-selecting `read`/`readByUrlPath` plus the bound `contentStaticParams` are correct in both phases by construction, which is why page code should not hand-pick the admin context. On a production `server` deployment (`mode: 'prod' && deployedAs: 'server' && !isBuildMode()`), `getCanopyForBuild()` methods **throw** when invoked at request time, so an ACL-bypassing read cannot leak into a request path. The guard fires only in prod because dev legitimately drives `generateStaticParams`/`generateMetadata` through the build context, which has the same not-build signature as the request-time footgun.

### Branch Identity

`defaultBaseBranch` (fork point) and `defaultActiveBranch` (which workspace serves content) are resolved once at service creation and baked into config, then refreshed per request in dev. The detection matrix, the fallback chain, and the recorded-fork-point rule live in [ARCHITECTURE.md](ARCHITECTURE.md#branch-based-editing); `_createCanopyServicesInternal` in `services.ts` carries the same note at the point of the code.

**In tests:** `createTestCanopyServices` pins both fields (`defaultBaseBranch ?? 'main'`, `defaultActiveBranch ?? defaultBaseBranch ?? 'main'`) so a suite never shells out to git for HEAD detection, which would vary with the developer's working branch. Mock services skip detection entirely. A test constructing `BranchWorkspaceManager` directly should still set `defaultBaseBranch` explicitly (see `branch-workspace.test.ts`). To pin a specific active branch:

```typescript
const services = createMockServices({
  config: { defaultBaseBranch: 'main', defaultActiveBranch: 'my-feature' },
  entrySchemaRegistry: {},
})
```

### Adding a New Framework Adapter

1. Write an `extractUser` function that turns the framework's request into a `CanopyUser` — authenticate through the plugin, then `resolveCanopyUser()` (`resolve-canopy-user.ts`), which applies bootstrap admin groups via `authResultToCanopyUser`.
2. Wrap `createCanopyContext()`, passing pre-created services plus that extractor, and add any framework-specific middleware or caching.
3. Keep the adapter thin (10-20 lines for user extraction), export one unified API, and hide framework details from adopters.

## Operating Mode Strategies

Mode-specific behavior is encapsulated in two strategy layers:

- `operating-mode/client-safe-strategy.ts` — no node imports, so it can be bundled for the client. Configuration values and flags only: `supportsBranching()`, `shouldCommit()`, `getPermissionsFileName()`.
- `operating-mode/client-unsafe-strategy.ts` — extends the above with server-side resolution: `getBaseRoot()`, `getPermissionsFilePath()`, `getRemoteUrlConfig()`.

**Strategies return values, not logic.** A strategy method answers a question (`shouldAutoInitLocal(): boolean`); git operations belong in `GitManager`, file I/O in services and utilities, and domain rules in domain code. Add a method to `operating-mode/types.ts` and implement it in each strategy class when different modes need different file names, paths or feature flags. See [operating-mode/AGENTS.md](packages/canopycms/src/operating-mode/AGENTS.md) for the single resolution points for `mode` and `deploymentName`.

```typescript
import { operatingStrategy } from './operating-mode'

it('returns correct config for each mode', () => {
  expect(operatingStrategy('prod').shouldAutoInitLocal()).toBe(false)
  expect(operatingStrategy('dev').shouldAutoInitLocal()).toBe(true)
})
```

### Git Test Repositories

`GitManager.ensureAuthor()` refuses to touch a repository not marked CanopyCMS-managed (`git config canopycms.managed true`), so it cannot pollute an unrelated repo. `initTestRepo()` from `src/test-utils` adds that marker plus a test identity:

```typescript
import { initTestRepo } from './test-utils'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-'))
const git = await initTestRepo(tmpDir)
```

## Schema Architecture

The schema model is collections and entry types; there is no separate singleton concept — a "singleton" is an entry type with `maxItems: 1`. A `RootCollectionConfig` holds root-level `entries`, nested `collections`, and an `order` array of content IDs. `CollectionConfig` and `EntryTypeConfig` are declared in `packages/canopycms/src/config/types.ts`; the adopter-facing shape of a `.collection.json` file is in [README.md](README.md#schema-registry-and-references). On disk each collection directory carries a `.collection.json` whose fields reference named schemas from the registry rather than inlining field definitions.

### Flattening Schema for Runtime

`flattenSchema(schema, 'content')` produces `FlatSchemaItem[]` for O(1) path lookups. It is a discriminated union on `type`, `'collection'` or `'entry-type'` (never `'singleton'`); see `config/types.ts` for the members. Two things the type alone does not say: `logicalPath` is the branded `LogicalPath`, and `parentPath` is always present on an entry type but absent on a root-level collection.

```typescript
import { flattenSchema } from './config'

const schemaIndex = new Map(flattenSchema(schema, 'content').map((i) => [i.logicalPath, i]))
const item = schemaIndex.get('content/posts')
```

### Working with ContentStore

`ContentStore` resolves a path by treating the last segment as a slug and looking up the rest as a collection path — `resolvePath(['content','posts','hello'])` returns `{ schemaItem, slug }`. There is no separate singleton resolution: an entry-type item is reached through its parent collection, by passing an empty slug.

```typescript
const doc = await store.read('content/posts', 'hello-world')
const home = await store.read('content/home', '') // maxItems: 1 entry type

await store.write('content/posts', 'hello-world', {
  format: 'md',
  data: { title: 'Hello World' },
  body: 'Content goes here',
})
```

On read, an `entry-type` item uses its own `format`/`fields`; a `collection` uses the default entry type's, via `getDefaultEntryType()`. Files on disk are named `{type}.{slug}.{id}.{ext}` (`post.hello-world.a1b2c3d4e5f6.md`), where `type` is the entry type name.

### API Response Format

`CollectionItem` (one entry) and `EntryCollectionSummary` (a collection in the tree) are declared in the API types. Two things to know beyond the declarations: there is no `itemType` field — use `entryType` on `CollectionItem` — and `CollectionKind` (`'collection' | 'entry'`) on a summary says container-or-leaf, not "singleton". A `maxItems: 1` entry type is an ordinary entry with a cardinality constraint the UI enforces; the API does not distinguish it.

### Testing with Schema

Use `defineCanopyTestConfig()` / `createTestServices()` (`src/config-test.ts`) rather than hand-rolling a config. `mode` has no default in the real schema (`defineCanopyConfig`) — a prod deploy that omits it must fail validation loudly instead of silently running header-trusting dev auth semantics — but `defineCanopyTestConfig()` defaults it to `'dev'` for you. Pass `mode: 'prod'` explicitly when a test needs it.

```typescript
import { defineCanopyTestConfig } from './config-test'

const config = defineCanopyTestConfig({
  schema: {
    entries: [
      { name: 'home', format: 'json', fields: [{ name: 'hero', type: 'string' }], maxItems: 1 },
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

Assert flattening by filtering on `item.type`, and path resolution on the `{ schemaItem, slug }` pair `resolvePath` returns.

### Page Blocks (Flexible Content)

A `block` field holds an ordered, repeatable list of heterogeneous section templates, each discriminated by a `template` literal, and `TypeFromEntrySchema` derives a discriminated union so each variant carries only its own template's fields. `defineBlockTemplate()` (exported from `canopycms`) is an identity function that preserves those literal types, so one template const can be dropped into several schemas' `templates` arrays instead of being copy-pasted (and drifting). Narrow one variant with `Extract<Block, { template: 'hero' }>`.

The adopter-facing recipe is in [README.md](README.md#page-blocks-flexible-content). `apps/example1/app/schemas.ts` reuses `heroBlock`/`ctaBlock` in `postSchema`, and `packages/canopycms/src/entry-schema.test.ts` holds the type-level tests for block narrowing.

## Working with Content IDs

Entries are identified by stable 12-character short UUIDs embedded in their filenames (`hello.a1b2c3d4e5f6.json`) and indexed by `ContentIdIndex`, which scans filenames.

Always reach the index through the async `idIndex()` getter, never the private `_idIndex`: the getter loads lazily on first access and is safe to call repeatedly, returning the already-loaded index.

```typescript
const idIndex = await store.idIndex()

const location = idIndex.findById('abc123def456')
const id = idIndex.findByPath('content/posts/hello-world.md')
const newId = await idIndex.add({
  type: 'entry',
  relativePath: 'content/pages/about.json',
  collection: 'pages',
  slug: 'about',
})
await idIndex.remove(newId)
```

## Reference Field Configuration

A reference field scopes what it can point at with `collections` (at least one required) and optionally names the field to show as a label with `displayField`; `list: true` allows several. `options` remains accepted as a static fallback the UI can use alongside `collections`. The schema is `referenceFieldSchema` in the config module; [README.md](README.md#reference-fields) is the adopter-facing version.

```typescript
{ type: 'reference', name: 'author', collections: ['authors'], displayField: 'name' }
```

`ReferenceValidator` enforces four things: the ID format is valid, the referenced entry exists, it is in an allowed collection, and it is not itself a collection.

### Live Reference Resolution in the Editor

The editor's live preview must show full referenced content, not IDs, while rendering synchronously. `FormRenderer.tsx` does this with a render-time `useMemo` over a `useRef` cache plus a debounced background fetch:

1. **Cache** — a `Map` keyed `"<branch>:<id>"`, scoped by branch so a branch switch cannot show stale cross-branch data, cleared when the branch changes, and persisted across form edits for instant re-renders.
2. **Synchronous transform** — `useMemo` builds the resolved value during render, using the cache where present and keeping the raw ID otherwise. It always returns complete, valid data, never an empty object, so there is no async gap to race.
3. **Background resolution** — a `useEffect` fetches only uncached IDs through `apiClient.content.resolveReferences`, debounced 300ms, then bumps a `resolutionTrigger` state to re-run the memo.
4. **Parent notification** — compare a serialized copy against a ref before calling `onResolvedValueChange`, or the notification loops.

**Never pass an empty object as the form value.** The parent must render conditionally (`{effectiveValue && <FormRenderer value={effectiveValue} />}`) rather than `value={effectiveValue ?? {}}`, which errors during transitions.

`POST /:branch/resolve-references` takes `{ ids: [...] }` and returns `{ ok, data: { resolved: { [id]: entry } } }`. See `FormRenderer.test.tsx`.

## Working with Assets

The asset system (upload, storage, on-demand transforms) lives under `src/assets/`; see [assets/AGENTS.md](packages/canopycms/src/assets/AGENTS.md) for its invariants and [ARCHITECTURE.md](ARCHITECTURE.md#asset--media-system) for the design. It brings dependencies you will meet here and nowhere else: `sharp` (transforms), `file-type` + `image-size` (finalize sniffing), `sanitize-html` (SVG), `content-disposition`, the S3 SDK plus `@aws-sdk/s3-presigned-post`, and on the editor side `@mantine/dropzone` (pinned to the Mantine core version in use) and `react-easy-crop`.

### Transform Engine: Shared Between Dev and Prod

The on-demand transform pipeline (`/assets/t/{directives}/{hash32}/{slug}.{ext}`) is split in two so dev emulation and the prod Lambda reuse it unchanged:

- `assets/transform-directives.ts` — pure, dependency-free parser/formatter for the directive syntax (`w=`, `f=`, `q=`, `c=`). It imports nothing at all, not even a sibling, so it is safe for client bundles.
- `assets/transform.ts` — the sharp-based `applyTransform` pipeline. Server-only.

Both the dev `/assets/t/*` route (`serveLazyTransform` in `packages/canopycms/src/api/assets.ts`) and the prod Lambda (`packages/canopycms-cdk/lambda/asset-transform/handler.ts`, importing through the `canopycms/server` re-exports) call into those two files. **Never reimplement directive parsing or the sharp pipeline in one place only** — change it in these files and both paths pick it up.

Both paths surface a `TransformRejection` carrying a real HTTP status (`400` unsupported input, `413` output too large, `422` decode failure). **Forward `transformed.status` verbatim** rather than flattening every rejection to one code: reporting a client-input error as a server error, or the reverse, is a bug, and `handler.test.ts` plus `assets.test.ts` both assert the pass-through.

### Finalize Decode Validation: Open on No Decoder, Closed on a Real Rejection

`runFinalizePipeline` (`pipeline.ts`) forces a real pixel decode for `kind === 'raster'` uploads (`rasterIsDecodable`), not just the header-only sniff `file-type`/`image-size` perform. That closes the "accepted at upload, unrenderable forever" gap: a PNG with a valid IHDR and a corrupt IDAT passes every header-only check and only fails later at render time.

Two things to know before touching it:

- **It `.resize()`s to a tiny throwaway output rather than calling `.metadata()`.** `metadata()` reads header fields — exactly the check that misses a corrupt IDAT. Only a real decode exercises libvips.
- **`sharp` is loaded through `loadSharp()` (`assets/sharp-loader.ts`); no non-test module imports it statically.** A static import fails whatever imports that module graph when the native binary cannot load (wrong platform/arch, a missing libvips `.so` in a standalone image) — and because `transform.ts` sits under `canopycms/http`, under Turbopack that meant every route of an adopter's editor. `loadSharp()` instead rejects on first use and logs once per process, which lets `pipeline.ts` catch that specific failure and **fail open** (warn, skip validation, let the upload through) for "no decoder available" only. If sharp loads and its decoder rejects the bytes, that is a real fact about the file and the pipeline **fails closed** (422, a generic user-facing message, never the raw libvips string). `transform.ts` lets the same rejection propagate, so a transform failure there is a 500, never a 422. Keep those two branches distinct. `@typescript-eslint/no-restricted-imports` in `eslint.config.mjs` rejects a static value import of `sharp` under `packages/canopycms/src` outside tests.

Fixtures here must be genuinely sharp-decodable: build them with `sharp({ create: {...} })` (see `makePng` in `transform.test.ts`), because a header-only fixture is now correctly rejected by `rasterIsDecodable` and can no longer stand in for a valid raster. `pipeline.test.ts` keeps exactly one deliberately-corrupt fixture (`makeCorruptPng`, bytes flipped well past the fixed-offset header fields) for the rejection test; the fail-open path is covered separately in `pipeline.sharp-unavailable.test.ts`, which mocks the `sharp` module — kept out of `pipeline.test.ts` because that file's fixtures need the real thing.

### Client-Bundle Safety for Assets

Editor/client code may import **only** the dependency-free isomorphic modules — `assets/transform-directives` and `assets/asset-url` — or `import type` from `assets/types`. It must never import the stores (`store-local.ts`, `store-s3.ts`), the upload pipeline (`pipeline.ts`, `finalize.ts`), or `transform.ts`: all of those pull in `sharp`, `node:crypto` or the S3 SDK, which must never ship to a browser.

```typescript
// OK in editor/client code (see packages/canopycms/src/editor/fields/ImageField.tsx)
import { assetUrl } from '../../assets/asset-url'
import type { CropRect } from '../../assets/transform-directives'
```

`pnpm lint:bundle` catches node built-ins reachable from `canopycms/client` but does not follow into `node_modules`, so pulling `sharp` or the S3 SDK in from client code is still yours to avoid — check which file you are importing from before assuming a path is browser-safe.

### Dev Gotcha: Adopter Apps Run Against Built `dist/`

`apps/example1` (and any adopter app) consumes `canopycms` and `canopycms-next` from built `dist/` output, not from `src/`. Rebuild after changing package source, or you will debug stale compiled output — a missing `/assets/*` rewrite from `withCanopy()`, say, that is actually present in source:

```bash
pnpm --filter canopycms build
pnpm --filter canopycms-next build
```

## Testing Content IDs

Create files whose names carry the embedded ID, then build the index by scanning:

```typescript
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
await fs.mkdir(path.join(tempDir, 'content'), { recursive: true })
const index = new ContentIdIndex(tempDir)

const testId = 'a1b2c3d4e5f6' // 12 characters
await fs.writeFile(path.join(tempDir, `content/test.${testId}.json`), '{"title": "Test"}')
await index.buildFromFilenames('content')

expect(index.findById(testId)?.relativePath).toBe(`content/test.${testId}.json`)
expect(index.findByPath(`content/test.${testId}.json`)).toBe(testId)
```

Clean the temp directory up in `afterEach` (`fs.rm(tempDir, { recursive: true, force: true })`).

## Development Workflow

### Settings Management (Permissions and Groups)

Permissions and groups live in `permissions.json` and `groups.json` on an orphan branch named `canopycms-settings-{deploymentName}` — no shared history with content branches — in both modes. Dev clones that branch into `.canopy-dev/settings/`; prod additionally pushes it to GitHub with a PR.

| Mode   | Where settings live                                  | Git behavior                             |
| ------ | ---------------------------------------------------- | ---------------------------------------- |
| `dev`  | Orphan branch, cloned into gitignored `.canopy-dev/` | Commits to the settings branch only      |
| `prod` | Orphan branch on the configured workspace root       | Commits, then pushes to GitHub with a PR |

In dev this lets you log in as different test users, put them in groups through the UI, and exercise permission scenarios without polluting git history or colliding with other developers. All of `.canopy-dev/` is gitignored via the `.canopy*` pattern (added by `npx canopycms init`), settings stay in the local bare remote, and changes survive a CMS restart. Verify with `git status` — `.canopy-dev/` should not appear; `git reset HEAD .canopy-dev/` if it ever gets staged.

In prod:

- Each deployment environment has its own independent settings branch, named from `deploymentName`.
- `commitToSettingsBranch` in `services.ts` uses the same dual path as content branches (`api/github-sync.ts`): call `githubService.createOrUpdatePR()` directly when there is internet, otherwise enqueue a `push-and-create-or-update-pr` task for the worker. Settings PRs are idempotent — the action looks for an existing open PR first.
- Changes take effect in the CMS immediately, read from the settings branch workspace. The PR is for persistence, not for gating.
- **Writes go through a mutate callback, not a `save*()` function.** `mutatePermissionsFile`/`mutateGroupsFile` (`authorization/`), built on `settings-file-store.ts`'s `mutateSettingsJsonFile`, run load → mutate → write inside the cross-host layered lock, which closes the load-compare-write TOCTOU window. The OCC `version` field is the single counter. **Your callback must be safe to call more than once** — it re-runs against freshly reloaded state on every OCC retry. Throw `SettingsVersionConflictError` from inside it when an app-level `expectedContentVersion` mismatches; the API turns that into a 409. See [docs/concurrency.md](docs/concurrency.md).
- **Workspace provisioning has its own two locks**, separate from the per-file write lock above: an in-memory Promise lock against redundant calls inside one process, and a file-based `wx` lock (`O_CREAT|O_EXCL`) for atomic cross-process exclusion on EFS, with stale locks over 30s cleaned up.

```typescript
// Mutate under the lock, commit outside it -- git I/O is comparatively slow.
await mutatePermissionsFile(settingsRoot, mode, (currentFile, version) => {
  if (expectedContentVersion !== undefined && expectedContentVersion !== version) {
    throw new SettingsVersionConflictError()
  }
  return { updatedAt: new Date().toISOString(), updatedBy: userId, pathPermissions: permissions }
})

const result = await services.commitToSettingsBranch({
  branchRoot: settingsRoot,
  files: 'permissions.json', // at the root of the orphan branch
  message: 'Update permissions',
  createPR: true,
})
// result.syncStatus: 'synced' | 'pending-sync' | 'sync-failed'
```

### Schema Mutations (`SchemaOps`)

`SchemaOps` (`schema/schema-store.ts`) is the CRUD layer behind the schema-editing API (`api/schema.ts`). Every public mutator runs under one **non-reentrant, coarse per-branch lock** (`withSchemaLock`, keyed on `{branchRoot}/.canopy-meta/schema`). [docs/concurrency.md](docs/concurrency.md) explains why `.collection.json` deliberately carries no OCC `version` or lockfile of its own.

**Because the lock is non-reentrant, a public mutator must never call another public mutator from inside its critical section** — that deadlocks on a lock it already holds. Each public mutator has a private `*Inner` counterpart that does the work without acquiring the lock; call that instead:

```typescript
// Inside SchemaOps, already holding the lock via the public entrypoint:
await this.updateCollectionInner(collectionPath, { order }) // safe
// await this.updateCollection(collectionPath, { order })   // deadlocks
```

A new mutator follows the same shape: a thin public method wrapping the real logic in `withSchemaLock`, cache invalidation afterwards and outside the lock (per `withSchemaLock`'s doc comment), plus a private `*Inner` other mutators can call.

### Dev Content Sync (`dev.contentSync`)

In dev, the editor and dev server read a branch clone under `.canopy-dev/content-branches/<branch>/`, seeded from **git-committed** state. `next build` does not: every build-time read comes from the working tree, uncommitted files included, never touching git or `.canopy-dev` (`readsFromCheckout` in `build-mode.ts`). So an edit made outside the editor reaches the next build at once but leaves the editor on a stale clone, and an editor save reaches a build only after `canopycms sync pull`.

`dev.contentSync` (`DevContentSyncMode`, dev-mode only, ignored when `mode !== 'dev'`) chooses what happens: `'warn'` (the default) watches `content/**` and logs a warning naming the diverged files at startup and on change; `'off'` installs no watcher. Choose `'off'` for unit-test configs, or when you only ever edit through the editor. The warning tells you to run `npx canopycms sync push`.

**There is intentionally no auto-push mode**, because it would clobber unsubmitted editor saves ([ARCHITECTURE.md](ARCHITECTURE.md#operating-modes)); reconcile with `canopycms sync push`.

All the logic is in the core watcher `src/dev-content-watcher.ts` (`startDevContentWatcher()`); adapters call it once at dev startup (see `packages/canopycms-next/src/context-wrapper.ts`). It no-ops outside dev mode, under `'off'`, and when the working-tree content directory is absent. Each check re-resolves the active branch, so it follows git HEAD switches, and it dedupes across HMR reloads so a dev restart does not double-warn.

### Committing and Pushing: Toolchain Gotchas

Two things bite in a scratch worktree or any non-interactive shell, where `pnpm` resolves only through a `corepack` shim rather than being on the ambient `PATH`:

- **The husky `pre-push` hook shells out to a bare `pnpm`, so `git push` fails with `pre-push script failed (code 127)`** — a `pnpm: command not found` inside the hook, not a push or auth error. Hooks see neither aliases nor shell functions, so the shim directory has to be exported on `PATH` in the _same_ command as the push. Same for `lint-staged` on `pre-commit`.
- **`prettier --write` silently skips `.claude/future-tasks/*.md`** — they are prettier-ignored. Prettier reports only the files it formatted, so passing a task file and seeing no mention of it is a skip, not a no-op-because-clean. Match the surrounding style by hand.

## Testing

| Test type   | Location                               | Purpose                                 |
| ----------- | -------------------------------------- | --------------------------------------- |
| Unit        | `src/**/__tests__/*.test.ts`           | Individual functions and modules        |
| Component   | `src/editor/**/*.test.tsx`             | React components under jsdom            |
| Integration | `src/__integration__/**/*.test.ts`     | Complete workflows                      |
| Type-level  | `src/**/*.test.ts` with `expectTypeOf` | Type inference, checked at compile time |

### Running Tests

```bash
pnpm test                                                     # everything
pnpm --filter canopycms test                                  # one package
pnpm --filter canopycms exec vitest run src/github-service.test.ts
pnpm --filter canopycms exec vitest run --coverage
pnpm --filter canopycms exec vitest                           # watch mode
```

`packages/canopycms/vitest.config.ts` defines two projects: `node` (everything outside `src/editor/**`) and `editor` (jsdom, for React components). Git-heavy suites spawn a real `git` per test, which is slow on macOS, so the `node` project raises `testTimeout` to 30s; the `editor` project keeps the default 5s deliberately, since jsdom tests do not shell out and a longer timeout there would mask a real hang. CI runs on ubuntu and does not need the headroom — and CI remains the source of truth for anything timing-sensitive, so never tune an assertion to make a slow local run pass when CI is already green.

The `editor` project loads `src/editor/test-setup.ts` first, which shims the browser APIs jsdom lacks but Mantine expects: `matchMedia`, `ResizeObserver`, and `Element.prototype.scrollIntoView`. Add a shim there when a component reaches for another one. `scrollIntoView` is worth knowing about for _how_ it fails: Mantine's Combobox calls it from a timer that fires after the test which opened the dropdown has finished, so a missing shim surfaces as a Vitest "Unhandled Error" blamed on whichever test ran next. **An unhandled error attributed to a test that plainly cannot have caused it is usually a missing jsdom shim in the test before it.**

`test-setup.ts` also registers React Testing Library's `cleanup()` in an `afterEach`, and that registration has to be explicit: RTL auto-installs cleanup only when it finds a **global** `afterEach`, and this package runs vitest with `globals: false`, so its auto-registration silently no-ops. Importing `afterEach` from `vitest` in the setup file is what makes it real. Two consequences:

- **Every test starts without the previous test's rendered trees.** `cleanup()` unmounts what RTL mounted; nodes a test appended to `document.body` by hand are its own to remove. Never depend on a tree an earlier test in the file rendered.
- **A new jsdom project, or a second editor setup file, must register `cleanup()` too.** Nothing else will.

This is not tidiness. Without the unmount, components stay mounted for the whole file and their timers outlive the test: Mantine's `useTransition` cancels its pending `setTimeout(setState)` from an unmount effect, so an un-unmounted transition can fire after the jsdom environment is torn down and blow up inside React with `ReferenceError: window is not defined` — landing as exactly the kind of misattributed unhandled error described above, a run that exits non-zero while every test passes.

**Treat "unhandled error, zero test failures" as a genuine leak and investigate it.** Two separate real bugs presented that way: the mount leak above, and a provisioning-lock race (see [docs/concurrency.md](docs/concurrency.md)) that aliased every branch under one shared `proper-lockfile` registry entry, so releasing one branch's lock tore down another's refresh timer and crashed the process with an uncaught `ECOMPROMISED` from inside it. Both have regression coverage (`provisioning-lock.test.ts`, and the `cleanup()` registration) and both had a real bug behind them, not a test artifact.

### Diagnosing a Test Failure

**Attribute the failure to the base before blaming your diff** — run the suite at the merge-base first. One failure is expected-red locally: `src/cli/init.integration.test.ts` fails 7 tests with `listen EPERM … tsx-501/*.pipe`, because the sandbox blocks tsx's IPC socket. It is environmental, and **avoidable**: only the tsx _CLI_ binds that socket, so a TS subprocess spawned as `node --import tsx <file>` runs fine sandboxed where `node_modules/.bin/tsx <file>` dies. **Any new test that spawns a TypeScript subprocess should use the loader form** rather than joining this expected-red set.

A `CannotFindAsset` in `canopycms-cdk` is a real failure. Its `test` script chains `build:test-fixtures` (`build:worker` plus a `--skip-native` lambda build), so a fresh worktree synthesizes fine; if you see one anyway, either the fixture build broke or `vitest` was invoked directly instead of through `pnpm test`, which skips that step. (The root `build` is `tsc` only; the full bundles build under `prepack`.)

**Two known intermittents**, both in `canopycms`, which pnpm runs first in dependency topology — so a flake there delays every other package:

- `MarkdownField.test.tsx` (MDXEditor mount). Triage shortcut: `pnpm --filter canopycms exec vitest run --project editor` is reliably green for it, so a failure in a full run **is** the known flake unless the editor-only project fails too. A `scrollIntoView` shim is a ruled-out cause.
- `git-manager.test.ts` — `ENOTEMPTY: … rmdir '.git/info'` in `afterEach`. `fs.rm`'s `force: true` suppresses ENOENT but not ENOTEMPTY, so it signals a concurrent writer, likely a detached `git gc --auto` still running after simple-git resolved.

**Three ways a run reports success while failing.** All three fail in the dangerous direction, so check for them explicitly:

- **An exit code read through a pipe is the pipe's.** `pnpm test 2>&1 | tail` reports `tail`'s 0 even when the suite failed, or when `pnpm` was never found. Capture `${PIPESTATUS[0]}`, or run `echo $?` on its own line. The agent-facing form is worse: run that same piped command as a background task and the harness reports _"completed (exit code 0)"_ — a system message, not something you wrote — while the suite actually died with `ERR_PNPM_RECURSIVE_FAIL`, or `pnpm install` died on an EPERM leaving no `node_modules`. A piped background command's notification tells you nothing about the command; read the captured output.
- **A backgrounded shell does not inherit the interactive profile**, so `pnpm install` can no-op with "command not found" and still look like it worked. Verify `node_modules` exists afterwards.
- **When a probe's two arms agree, check they agree for the reason you think.** A scratch workspace with no `packageManager` field makes corepack fetch pnpm over the network; behind a sandbox both arms of a comparison can fail identically for that reason and produce a clean, wrong answer.

**Reading CI logs.** `gh run view --log` truncates the vitest step to nothing, on green and red runs alike. The real output is only in the downloadable archive:

```bash
gh api repos/OWNER/REPO/actions/runs/RUN_ID/logs > logs.zip
# then read: "Validate, Typecheck & Test/13_Run tests.txt"
```

For the state of a PR's checks, run the watcher rather than reading `gh pr checks` yourself — it distinguishes conflicts, stale green and a never-registered workflow from "still pending". See [Waiting on PR Checks](#waiting-on-pr-checks).

### End-to-End Tests (Playwright)

**Always run the e2e suite single-worker.** Use the root script, which pins it:

```bash
pnpm test:e2e                                             # playwright test --workers=1
pnpm exec playwright test branch-workflow --workers=1     # single spec: pass the flag yourself
```

The whole suite shares **one** `.canopy-dev` workspace and **one** dev server port, so two workers fight over the same git working tree. What comes back is not a recognizable contention error but dozens of failures reading `Failed to ensure main branch`, `spawn git ENOENT`, `TypeError: fetch failed` — noise that impersonates the subsystem under test. **If you are touching `git-manager.ts`, `branch-workspace.ts` or branch metadata and the suite suddenly reports broad git breakage, check your worker count before debugging the code.**

The same constraint holds across processes: **only one Playwright run per machine at a time.** Parallel agent sessions or a second terminal must serialise, or both runs corrupt each other's workspace and both report phantom failures. CI is unaffected — it shards across separate runners, each with its own workspace.

**Browser build.** Playwright pins an exact browser revision per release, and having _some_ chromium in `~/Library/Caches/ms-playwright/` is not enough. A machine carrying only a newer build from another project fails before any spec runs. Install the right one (~91 MB) after a fresh clone or a Playwright bump:

```bash
pnpm exec playwright install chromium
```

Read the required revision from `revision` for `chromium` in `node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/browsers.json` rather than inferring it from the `package.json` range — the range floats, the resolved version pins the build.

Specs live in `apps/test-app/e2e/tests/`, with fixtures alongside and a capability map in `apps/test-app/e2e/COVERAGE-MATRIX.md`.

### Integration Test Structure

```
src/__integration__/
  fixtures/          # schemas.ts (shared test schemas), content-seeds.ts
  test-utils/        # test-workspace.ts, api-client.ts, multi-user.ts
  errors/ permissions/ validation/ workflows/
```

`createTestWorkspace()` builds an isolated workspace and hands back `{ root, config, cleanup }`:

```typescript
import { createTestWorkspace } from '../__integration__/test-utils/test-workspace'

beforeEach(async () => {
  workspace = await createTestWorkspace({ schema: BLOG_SCHEMA, mode: 'dev' })
})
afterEach(async () => {
  await workspace.cleanup()
})
```

### Testing Authorization Defaults (`defaultBranchAccess` / `defaultPathAccess`)

`createTestWorkspace()` defaults to a permissive `defaultBranchAccess: 'allow'` / `defaultPathAccess: 'allow'` workspace, so most of the integration suite never exercises the fail-closed defaults `canopycms init` actually scaffolds — a regression in the `'deny'` path could ship with every other suite green. Override them when a test needs to cover it:

```typescript
workspace = await createTestWorkspace(
  { schema: BLOG_SCHEMA, defaultBranchAccess: 'deny', defaultPathAccess: 'allow' },
  { internalGroups: TEST_INTERNAL_GROUPS },
)
```

`__integration__/permissions/default-deny-branch-access.test.ts` has the full pattern, including why `internalGroups` must be seeded: an auth provider's external groups get reserved IDs like `Admins` stripped for security, so the `admin`/`reviewer` personas need that membership granted internally.

- **Admins bypass BOTH the branch and path layers.** `isAdmin(user)` short-circuits in `authorization/branch.ts` and `authorization/path.ts`, so an authorization test written against the `admin` persona proves nothing about `'deny'` defaults — it passes identically either way. Use the `editor` persona from `__integration__/test-utils/multi-user.ts` (`createMockAuthPlugin('editor')`). The same trap applies outside tests: `canopycms-auth-dev` auto-sets `CANOPY_BOOTSTRAP_ADMIN_IDS`, so the default dev user is an admin and clicking around a local dev site surfaces no access-rule regression either.
- **Assert exact status codes, not `.not.toBe(403)`.** A loose exclusion passes on a 404 from a wrong route as readily as on a correct 200 or 403. One test here posted to `/:branch/status` instead of `/:branch/submit`, 404'd, and passed both with and without the fix it covered. Assert `expect(res.status).toBe(200)`.
- **When adding an authorization grant, verify the negative:** temporarily remove the grant, confirm the new test fails, then restore. Restore from a scratchpad copy (`cp /path/to/scratchpad-copy.ts src/path/to/file.ts`), **never `git checkout -- <file>`**, which discards any other uncommitted work in that file.

### Working with Async Services

`createCanopyServices` is async because it loads `.collection.json` meta files from the filesystem, and those files reference schemas from a registry (`"fields": "postSchema"`) that must be resolved at initialization. `createNextCanopyContext()` is async for the same reason. Always `await` both:

```typescript
const services = await createCanopyServices(config)
const reader = createContentReader({ services, basePathOverride: root })
```

In a Next app, create the context once at module initialization and export thin async accessors from `app/lib/canopy.ts` — [README.md](README.md#connecting-the-schema-registry) has the adopter-facing file.

### Creating Mock Services for Tests

```typescript
import { createMockServices, createMockApiContext } from '../test-utils/api-test-helpers'

const services = createMockServices({ config: { mode: 'dev' }, entrySchemaRegistry: {} })
const context = createMockApiContext({ services }) // includes entrySchemaRegistry by default
```

**Mock services must include `entrySchemaRegistry`.** It is part of the `CanopyServices` interface and is what resolves field references like `"fields": "postSchema"`; include `{}` even when the test uses no schemas, or the type will not satisfy the interface. Tests that bypass async service creation have to provide it by hand.

| Approach                       | Use for                      | Trade-off                                      |
| ------------------------------ | ---------------------------- | ---------------------------------------------- |
| `createMockServices()`         | Unit tests, simple scenarios | Fast, no filesystem; set `entrySchemaRegistry` |
| `await createCanopyServices()` | Integration, schema behavior | Real behavior, loads meta files; slower        |

### Testing Settings Mutation Handlers (`createMockSettingsMutation`)

The permissions/groups handlers (`api/permissions.ts`, `api/groups.ts`) call `mutatePermissionsFile`/`mutateGroupsFile`, a mutate-callback contract rather than a `save*()` function. `createMockSettingsMutation()` (`test-utils/api-test-helpers.ts`) mirrors that contract for handler-level tests: it invokes your real mutator callback against a configured `currentFile`/version, captures the payload the callback returns, and lets anything it throws propagate untouched, exactly like the real implementation.

```typescript
const settingsMutation = createMockSettingsMutation({ currentFile: null })
vi.mocked(permissionsLoader.mutatePermissionsFile).mockImplementation(
  settingsMutation.impl as typeof permissionsLoader.mutatePermissionsFile,
)

const result = await updatePermissions(mockContext, req, { permissions: newPermissions })
expect(settingsMutation.getPayload()).toMatchObject({
  updatedBy: 'admin-1',
  pathPermissions: newPermissions,
})
```

**It does not model lock contention.** For a "settings are busy" case, reject directly instead: `vi.mocked(permissionsLoader.mutatePermissionsFile).mockRejectedValueOnce(new SettingsFileConflictError())`. See `api/permissions.test.ts` and `api/groups.test.ts`.

### Testing with Schema Meta Files

A collection can be defined by a `.collection.json` file in the content directory instead of, or alongside, the config; its `"fields"` value is a key into the entry schema registry. To exercise that path, write the meta file into the workspace and pass the registry to `createCanopyServices`:

```typescript
const workspace = await createTestWorkspace({ schema: BLOG_SCHEMA, mode: 'dev' })
const postsDir = path.join(workspace.root, 'content/posts')
await fs.mkdir(postsDir, { recursive: true })
await fs.writeFile(
  path.join(postsDir, '.collection.json'),
  JSON.stringify({ name: 'posts', entries: { format: 'json', fields: 'postSchema' } }),
)

const services = await createCanopyServices(workspace.config, {
  postSchema: [{ name: 'title', type: 'string' }],
})
expect(services.flatSchema).toContainEqual(
  expect.objectContaining({ type: 'collection', name: 'posts' }),
)
```

### Mocking Git Operations

Mock the high-level git service methods, not low-level git operations: tests then assert what the API does rather than how git works, and survive a change of git implementation. `createMockGitServices()` (`test-utils/mock-git-services`) creates both mocks at once for the `ApiContext`:

```typescript
const mockGitServices = createMockGitServices()

const mockContext: ApiContext = {
  services: {
    config: testConfig,
    flatSchema: [],
    commitFiles: mockGitServices.commitFiles,
    submitBranch: mockGitServices.submitBranch,
  },
  getBranchContext: vi.fn().mockResolvedValue({
    baseRoot: '/test/repo',
    branchRoot: '/test/repo',
    branch: { name: 'main', status: 'editing' },
  }),
}

// after calling the handler:
expect(mockContext.services.commitFiles).toHaveBeenCalledWith({
  context: branchContext,
  files: 'permissions.json', // at the root of the settings branch workspace
  message: 'Update permissions',
})
```

Use `commitFiles` for operations that modify content or metadata files, and `submitBranch` for workflow transitions (submit for review, approve merge). See `packages/canopycms/src/api/permissions.test.ts` and `packages/canopycms/src/api/groups.test.ts`.

### Testing Editor Hooks (SWR Cache Isolation, Strict Mode, Direct-Import Mocks)

`createApiClientWrapper(mockClient)` (`src/editor/hooks/__test__/test-utils.tsx`) wraps the tree in `ApiClientProvider` plus an `SWRConfig` with an isolated cache (`provider: () => new Map()`, `dedupingInterval: 2000` to match production). It is transparent to existing call sites. It matters because SWR-backed hooks (`useBranchManager`, `useEntryManager`, `useCommentSystem` and the `use*Data` hooks under them) key cache entries by resource and branch (`"canopy:entries:main"`): without a fresh `Map` per wrapper, tests in one file would share SWR's real global cache and one test could see another's mocked response.

**For dedup and Strict Mode regressions**, use `createStrictModeApiClientWrapper(mockClient)`, which additionally wraps the tree in `<React.StrictMode>` (mount, cleanup, remount, doubling effects). Without SWR's request coalescing each manager hook's fetch-on-load effect fires twice:

```typescript
renderHook(() => useEntryManager(/* ... */), {
  wrapper: createStrictModeApiClientWrapper(mockClient),
})
await waitFor(() => expect(mockClient.entries.list).toHaveBeenCalledTimes(1))
```

**Mocking `createApiClient()` for direct-call code:** most hooks and components get the client from `useApiClient()` context, so mocking the `'../api'` barrel is enough. Code that calls `createApiClient()` directly — `useReferenceResolution.ts` through `client-reference-resolver.ts`, and `ReferenceField.tsx` — must mock the exact module it imports from, using the relative specifier from the test file's own location:

```typescript
vi.mock('../api/client', () => ({ createApiClient: vi.fn() }))
```

Mocking `'../api'` will not intercept it. See `useReferenceResolution.test.ts`, `ReferenceField.test.tsx`, `client-reference-resolver.test.ts`.

### Testing with Real Git Operations

Rebase behavior — conflict resolution, upstream tracking, dirty-tree detection — is too nuanced to mock reliably, and real repos in temp directories are fast, so the worker's rebase logic is tested against actual git. `initTestRepo()` (`src/test-utils/git-helpers.ts`) sets `canopycms.managed=true` plus a test identity so the repo works with `GitManager.ensureAuthor()`.

**Local remote pattern** (from `cms-worker-rebase.test.ts`): build a local "remote" repo, then clone it into a branch workspace layout.

```typescript
const remotePath = path.join(tmpDir, 'remote')
await fs.mkdir(remotePath)
const remoteGit = await initTestRepo(remotePath)
await remoteGit.raw(['branch', '-M', 'main'])
await fs.writeFile(path.join(remotePath, '.gitkeep'), '')
await remoteGit.add(['.'])
await remoteGit.commit('initial commit')

const branchPath = path.join(tmpDir, 'content-branches', 'my-feature')
await simpleGit().clone(remotePath, branchPath)
const branchGit = simpleGit({ baseDir: branchPath })
await branchGit.addConfig('user.name', 'Test Bot')
await branchGit.addConfig('user.email', 'test@canopycms.test')
await branchGit.addConfig('core.editor', 'true') // no interactive editor on rebase --continue

// exclude .canopy-meta/ from git, matching production ensureGitExclude
const excludeFile = path.join(branchPath, '.git', 'info', 'exclude')
await fs.mkdir(path.dirname(excludeFile), { recursive: true })
await fs.appendFile(excludeFile, '\n.canopy-meta/\n')
```

**Testing a private method** by casting through `unknown` is preferable to widening its visibility, but use it sparingly — only where the private method holds logic worth driving directly:

```typescript
const runRebase = (worker: CmsWorker): Promise<void> =>
  (worker as unknown as { rebaseActiveBranches(): Promise<void> }).rebaseActiveBranches()
```

Tests also _assign_ through the same cast, over an instance member, which constrains any later refactor of the class — see [Extracting from a Class Whose Tests Reach Through the Instance](#extracting-from-a-class-whose-tests-reach-through-the-instance).

**`--ours` and `--theirs` are reversed during a rebase**, which is why the rebase conflict resolution keeps the editor's version with `git checkout --theirs <file>`: during a rebase the editor's branch commits are "theirs". A test caught this — a good argument for real git here.

| Context      | `--ours`                                 | `--theirs`                            |
| ------------ | ---------------------------------------- | ------------------------------------- |
| `git merge`  | Current branch (your work)               | The branch being merged in            |
| `git rebase` | The upstream commits being replayed onto | The branch being replayed (your work) |

**Assert working-tree state by porcelain status column.** `git status --porcelain` (what simple-git's `status()` parses) reports **two independent columns per file** — index and working tree — and conflating them produces a false data-loss report. `cms-worker-rebase-wedge.test.ts` classifies files around a `rebase --abort` keyed on the working-tree column only:

| Status | Columns               | What it means here                                                         |
| ------ | --------------------- | -------------------------------------------------------------------------- |
| `UU`   | both conflicted       | A file the rebase stopped on; a known gap, not silently handled            |
| `M `   | index `M`, tree `' '` | The rebase's own cleanly-replayed change; committed history, survives      |
| ` M`   | index `' '`, tree `M` | An unstaged modification, e.g. an editor save; this is what abort discards |
| `??`   | untracked             | A file created during the wedge; the abort leaves it alone                 |

Filter on `file.working_dir` (simple-git's name for the working-tree column), **never on `file.index` or on the pair together** — keying on the wrong column reports committed, safe history as data loss. Read both columns' meanings before writing a filter that asserts "what changed and how" rather than just "is the tree clean".

### Extracting from a Class Whose Tests Reach Through the Instance

When you split a large class into module-level functions taking a context object, and its suite drives the class by **mutating the instance**, the context has two hard requirements:

1. **Every instance-backed member is a function**, resolved by calling back onto the live instance at call time — not a field copied when the context was built.
2. **The context is built fresh per call**, so no long-lived object can hide a stale reference.

A field copied at construction (`octokit: this.octokit`) captures the pre-test value, so the extracted code runs against the real dependency while the test's mock sits unused on the instance. Plain functions rather than getters are deliberate: `ctx.octokit()` makes the late binding visible at every call site.

**Pre-flight check before extracting:** grep for `as unknown as { ... }` casts and enumerate them **for assignment, not just for calls** — across the whole repo, not only the class's test files. `apps/test-app/app/api/e2e-test/rebase/route.ts` reaches into `CmsWorker` this way from an e2e fixture route, so a sweep scoped to `*.test.ts` would report that method as unused. Anything the tests _assign to_ has to stay reachable through the seam; the [call form](#testing-with-real-git-operations) is the easy half.

**The failure mode:** an extracted module calling the module-level `executeTask` directly — legal, since it is defined in the same file — bypasses the instance-level stub and turns 8 tests red. Route the call through the context, and never edit the test to accommodate the extraction: a test that stubs a method is asserting the seam exists, so making it call the real thing deletes the assertion instead of fixing it.

```typescript
await ctx.executeTask(task, signal) // late-bound, honors the test's stub
await executeTask(ctx, task, signal) // WRONG: bypasses it silently
```

`packages/canopycms/src/worker/worker-context.ts` documents which members are safe to copy and which must dispatch live, and [worker/AGENTS.md](packages/canopycms/src/worker/AGENTS.md) maps the modules on the other side of that seam, including the full assigned-to surface.

### Testing UI Conflict Indicators

Conflict detection happens server-side — the worker's rebase writes `conflictFiles` to branch metadata, the editor reads it and passes `conflictNotice` to the form — so the flow needs coverage on both sides: real git tests for the detection, a component test for the display. Render `FormRenderer` inside `CanopyCMSProvider` with and without the `conflictNotice` prop and assert on the notice text (`/Someone else has recently changed this page/`) with `getByText` and `queryByText` respectively.

### Asset Store Parity Testing

`LocalAssetStore` and `S3AssetStore` must behave identically for everything in the `AssetStore` contract (staging, originals, meta sidecars, public objects, paginated listing). Adapter-specific test files only prove each adapter is self-consistent; they cannot catch the two drifting apart on error shapes, precondition semantics or metadata field names. So `packages/canopycms/src/assets/store-parity.test.ts` defines **one shared behavior suite** and runs it against both — local against a real `fs.mkdtemp` directory, S3 against [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock) plus a small in-memory fake (`installS3Fake()`) that stores real bytes in a `Map`, so a round-trip read returns real data rather than a canned value.

```typescript
runParitySuite('LocalAssetStore', async () => ({
  store: new LocalAssetStore({ root: await fs.mkdtemp(prefix) }),
  assertsNewestFirst: true,
}))
runParitySuite('S3AssetStore', () => ({
  store: new S3AssetStore({ bucket: 'test-bucket', region: 'us-east-1' }),
  assertsNewestFirst: false,
}))
```

The `Harness`'s `assertsNewestFirst` flag exists because `LocalAssetStore` guarantees `listMeta` ordering and S3's `ListObjectsV2`-backed listing does not, so an order-dependent shared test skips for the adapter that makes no such promise instead of being split into an adapter-specific file.

**When you touch the `AssetStore` contract** — add a method, change an error case, change what a read returns — add the assertion to the shared suite, not to one adapter's file.

### Guarding Every Call Site of X (Behavioural, Not Source-Grep)

A guard meant to catch every call site of some API ("every Octokit call", "every raw `fetch`", "every direct `console.*`") is easy to draft as a source-text regex and easy to get wrong the same way: call sites end up spelled several ways (`octokit.pulls.list`, `this.octokit.git.deleteRef`, `ctx.octokit().pulls.create`), and one may span lines, which no single-line regex matches at all. Three spellings is the point at which the instrument is wrong rather than merely incomplete.

Prefer a **behavioural** guard: wrap the real dependency in a recording `Proxy` that records every `namespace.method` invoked, drive every real caller against it (every enum value through its dispatcher, every method on a class, every branch of a multi-path function), and compare the observed operation set against a checked-in map **in both directions** — an operation observed but unlisted means something new landed uncovered; an operation listed but never observed means either a stale entry or, the case that matters most, that the harness stopped reaching it and the guard is now watching nothing.

- **Assert coverage per driver, not on the union.** If two drivers invoke the same operation, a unioned set cannot see one of them go dark.
- **Keep a source-level backstop for what the harness cannot reach**, and pin its regex with a test asserting both what it should and should not match — a regex that quietly stops matching turns "files with calls" into a vacuous, green "no files have calls".

Worked example: `packages/canopycms/src/cli/github-app-permission-drift.test.ts` (Octokit calls vs. the declared GitHub App permissions).

### Testing postMessage Listeners (Framed-Window Simulation)

The preview-bridge listeners validate both `event.origin` and `event.source === window.parent`, so a jsdom test cannot dispatch a bare `MessageEvent`: the source check needs a genuine `WindowProxy` distinct from the test window, and a plain object fails the identity check. `window.parent` is read-only in jsdom, so it has to be redefined and restored. Use `simulateFramed()` from `src/editor/preview-bridge.test.tsx`:

```typescript
const simulateFramed = () => {
  const host = document.createElement('iframe') // real iframe -> real WindowProxy
  document.body.appendChild(host)
  const parentWin = host.contentWindow as Window
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parentWin })
  vi.spyOn(parentWin, 'postMessage').mockImplementation(() => {})
  return parentWin
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'parent', { configurable: true, get: () => window })
  document.querySelectorAll('iframe').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

// Dispatch with explicit origin AND source -- both are validated
new MessageEvent('message', {
  data: { type: CANOPY_PREVIEW_UPDATE },
  origin: window.location.origin,
  source: parentWin,
})
```

A test that omits `source`, or passes the wrong window, doubles as a negative test for the trust check.

### Expecting Console Messages

**Swallowing expected console output is mandatory, and only CI enforces it — in every package.** The `onConsoleLog` hook in [vitest.shared.ts](vitest.shared.ts), which each package's `vitest.config.ts` spreads in, **throws on any console output Vitest intercepts** — `log` and `info` as much as `warn` and `error` — but only under `CI=true`. Locally the same test prints the output and reports green, so a stray `console.log` left over from debugging fails CI exactly as hard as an unasserted error.

The failure is easy to misread: the throw surfaces as an _unhandled rejection_, not a failed test, so the summary can still say "passed" above `Errors 1 error`. The error names the culprit (`<file> > <test> wrote to stderr under CI`). Reproduce it before pushing any test that triggers an error handler:

```bash
CI=true pnpm exec vitest run          # from any package directory
```

Capture and assert with `mockConsole()` rather than merely silencing — a test that swallows the error it provoked has traded a visible failure for an invisible one:

```typescript
import { mockConsole } from './test-utils/console-spy.js'

it('logs error when something fails', () => {
  const consoleSpy = mockConsole()
  doSomethingThatLogs()
  expect(consoleSpy).toHaveErrored('Failed to do something')
  consoleSpy.restore() // always restore
})
```

`toHaveErrored`, `toHaveWarned` and `toHaveLogged` match `console.error`/`warn`/`log`, taking a substring or a RegExp; `consoleSpy.all()` dumps everything captured, by method, when an assertion is not matching. Other packages import `mockConsole()` from `canopycms/test-utils`; a plain `vi.spyOn(console, 'warn').mockImplementation(() => {})`, asserted and `mockRestore()`d in a `finally`, works too.

**Keep the reporter "all dots".** The `dot` reporter prints a `stdout | <file> > <test>` block for any test that writes to the console, which buries real problems; GitHub Actions sets `CI=true`, so the existing `pnpm test` step enforces the guard with no extra workflow step. `vitest.shared.ts` names the reporter explicitly; its comment says why an unnamed reporter blinds the guard under an AI coding agent. When CI fails with this error, swallow and assert the output, or remove the stray log; do **not** silence the guard.

**`canopycms-cdk` also sets `JSII_DEPRECATED=fail`**, so calling a deprecated aws-cdk-lib API throws a `DeprecationError` at the call site — locally too, and inside `scaffold-synth.test.ts`'s subprocess synth, whose stderr the console guard never sees. Migrate the call; do not relax the setting.

### Testing GC-Dependent Code Deterministically (`WeakRef`/`FinalizationRegistry`)

Code that prunes dead `WeakRef`s or registers a `FinalizationRegistry` callback cannot be exercised by waiting for real garbage collection, since GC timing is non-deterministic. `src/content-index-registry.test.ts` stubs the globals so the pruning logic runs on command. The two globals need different treatment:

**`WeakRef` — stub the global.** Production code calls `new WeakRef(target)` through a bare global reference resolved at call time, so stubbing before the call is enough, with no module reload. A `FakeWeakRef` whose `deref()` consults a static `deadTargets` set lets a test mark one target dead; `afterEach(() => vi.unstubAllGlobals())`.

**`FinalizationRegistry` — stub the global AND force a fresh module instance.** When the production module captures the constructor at module-load time (`const finalization = new FinalizationRegistry(cb)`), stubbing the global afterwards does nothing to the existing instance, and the test would pass for the wrong reason or never exercise the finalizer at all. Combine `vi.stubGlobal()` with `vi.resetModules()` and a dynamic re-import:

```typescript
vi.stubGlobal('FinalizationRegistry', FakeFinalizationRegistry) // captures cb and heldValue
vi.resetModules()
try {
  const fresh = await import('./content-index-registry')
  fresh.registerContentIndexForInvalidation(root, target)
  capturedCallback?.(capturedHeldValue) // simulate the engine collecting `target`
} finally {
  vi.resetModules() // restore the real module for later tests
}
```

### Type-Level Testing with `expectTypeOf`

Vitest's `expectTypeOf` asserts types at compile time without executing runtime code. Use it for generic utility types (`TypeFromEntrySchema`), discriminated-union narrowing (block templates, field types), inference regressions when a schema changes, and resolved references carrying a type through generics.

```typescript
import { describe, it, expectTypeOf } from 'vitest'

it('produces a discriminated union for block fields', () => {
  type Block = TypeFromEntrySchema<typeof schema>['blocks'][number]
  type HeroBlock = Extract<Block, { template: 'hero' }>

  expectTypeOf<HeroBlock['value']>().toEqualTypeOf<{ headline: string }>()
  expectTypeOf<HeroBlock['template']>().toEqualTypeOf<'hero'>()

  void schema // prevents the unused-variable lint error
})
```

| Matcher                           | Purpose                                     |
| --------------------------------- | ------------------------------------------- |
| `.toEqualTypeOf<T>()`             | Exact match (strictest)                     |
| `.toMatchTypeOf<T>()`             | Assignable to expected; extra props allowed |
| `.toBeString()` / `.toBeNumber()` | Primitive checks                            |
| `.toBeNullable()`                 | Includes `null` or `undefined`              |

Under a plain `vitest run` these calls execute as runtime no-ops — the type checking happens in `tsc --noEmit`, which includes test files; `vitest --typecheck` runs the checker itself. See `packages/canopycms/src/entry-schema.test.ts`.

### Testing Context and Auth

Drive the context factory with an injected `extractUser` and assert on the resolved `canopy.user`:

```typescript
const context = createCanopyContext({ services, extractUser: async () => mockUser })
const canopy = await context.getContext()
expect(canopy.user.groups).toContain('Admins') // bootstrapAdminIds applied
```

The cases worth covering: a bootstrap admin gains the `Admins` group even with no groups of its own; a static deployment returns `STATIC_DEPLOY_USER` without calling the injected extractor; an anonymous user resolves to `type: 'anonymous'` with no groups; and a user with no groups gets `rejects.toThrow('Permission denied')` from `canopy.read()` on restricted content.

### API Client Generation

The TypeScript API client is generated from the route registry, which keeps endpoint definitions next to their implementations and out of a regex parser. To add an endpoint:

1. **Declare it** with `defineEndpoint({ namespace, name, method, path, paramsSchema, responseTypeName, defaultMockData })` in your API module.
2. **Import that module** in `packages/canopycms/scripts/generate-client.ts`, so it populates `ROUTE_REGISTRY`.
3. **Map the namespace** in `namespaceToModule()` if the namespace does not match the filename.
4. **Generate:** `pnpm run generate:client`, which writes typed methods into `src/api/client.ts` and mock helpers into `src/api/__test__/mock-client.ts`.

### Integration Testing with Framework Adapters

Mock `next/headers` to return the headers the adapter should read, then assert on the extracted user. For per-request caching, wrap `coreContext.getContext` in React's `cache()`, call it twice, and assert the injected `extractUser` spy ran once.

### Shelling Out to Real Builds (CI Fixture Pattern)

`apps/dual-build-fixture/dual-build.test.ts` verifies the two deploy shapes ([README.md](README.md#dual-build-sites-static-export--cms-server)) by running `next build` twice, once per `CANOPY_BUILD` flavor, against a minimal fixture app, then asserting on the real build output rather than exit codes. It is its own CI job (`dual-build` in `.github/workflows/ci.yml`), gated on a paths filter so the two expensive builds run only when something able to break the split changed.

```bash
pnpm --filter canopycms-dual-build-fixture run verify:dual-build
```

Read the file in full before extending it, or before writing another "shell out to a real build, inspect output" test — it packs five rules worth reusing:

- **Run the expensive step once, assert many times.** Both `next build` invocations run in `beforeAll`; every `it()` only inspects the resulting file trees. Never re-run a build per assertion.
- **Relocate output when two flavors share one `.next/`.** `moveNextOutputAside()` moves the static build's non-cache output to `.next-static/` before the cms build starts, leaving both inspectable, and `cleanNextOutputKeepCache()` clears everything under `.next/` except `cache/` before each build. `next build` is not guaranteed to prune stale output for routes or `pageExtensions` that no longer apply, so without the clean step a leftover `.next/server/app/edit` could make an assertion pass for the wrong reason — while nuking the cache too would defeat CI's build-cache restore.
- **Use a dynamically-allocated port for live-server checks, never a hardcoded one.** A smoke test spawns `next start` and fetches routes to verify runtime behavior, not just artifacts. `getFreePort()` binds port 0 and reads back what the OS picked. A hardcoded port caused a real false pass: a stale `next start` from an earlier manual run kept answering, so the freshly-spawned (deliberately broken) server was never exercised. A fresh port makes that contamination impossible instead of relying on cleanup discipline.
- **Fail fast on child-process exit instead of polling out the timeout.** `waitForServer()` listens for the child's `exit` event and throws immediately, surfacing the captured server log, rather than polling a server that is already gone.
- **Exclude dev-mode workspace clones from test discovery.** `vitest.config.ts` excludes `.canopy-dev/**`: the dev branch-workspace machinery clones the whole app directory — the test file included — into `.canopy-dev/content-branches/<branch>/` on the first request-time read, and Vitest would pick that clone up as a second, broken test file with no `node_modules` of its own.

**Local-run gotcha:** the live-server test's request-time read resolves against the last git commit, not uncommitted working-tree edits. Running it locally against WIP changes can make the cms server's `/` return a non-200 until you commit (or `canopycms sync push`) — expected dev-mode behavior, not a build-shape regression. The assertion message says so inline; read it before assuming a regression.

### `apps/example1` Build Verification (`example1-build` CI Gate)

`apps/example1` is the reference app most doc snippets and e2e expectations are written against, and `validate` only type-checks and lints it while `dual-build` builds a different app. The path-gated `example1-build` job runs the app's own `verify:build` script (`apps/example1/build-verify.test.ts`):

```bash
pnpm --filter canopycms-example-one run verify:build
```

(`--filter example1` matches nothing — `example1` is the directory name, the package is `canopycms-example-one`.)

- **It asserts on the build's OUTPUT, not its exit code.** Re-modelling the `home` entry as a root `index` entry changed its on-disk slug while `app/page.tsx` still read the old one, so `readByUrlPath('/')` resolved nothing and Next prerendered the not-found boundary **at `/`** while the exit code stayed 0, with `sitemap.xml` still advertising the stale `/home`. "The build passed" was evidence of nothing. So the test greps the emitted `.next/server/app/index.html` for the home entry's actual hero title (read from its content file, not hardcoded) and checks `sitemap.xml.body` for `/` while asserting `/home` is absent, plus a floor against a near-empty sitemap. Duplicate-URL collisions are not re-checked here: `assertNoDuplicateUrlPaths` already runs during a normal `next build` via the sitemap and static-params calls, so a real collision fails the build outright.
- **The CI job builds on the detached HEAD `actions/checkout` leaves, with no git setup.** A build reads the working tree, never a branch clone, so it reads exactly the PR's content and a green run is the live proof; `build-verify.test.ts` also asserts the build creates no `.canopy-dev`. `dual-build` still attaches HEAD, for its request-time reads.

### Scaffold-and-Synth Verification (`canopycms-cdk/src/scaffold-synth.test.ts`)

`scaffold-synth.test.ts` verifies `canopycms init-deploy aws` end to end: it runs the real CLI into a scratch project, executes the generated `cdk.json`'s own `app` command, and requires a CloudFormation template to come out. The bug it fixes — a generated GitHub Actions workflow deploying against a `cdk.json` nothing had created — was invisible to `init.test.ts`'s template-string assertions, which passed throughout. **For generated output, assert on what it _does_ (does it synth?), not on what it _contains_.**

```bash
pnpm --filter canopycms-cdk run build:test-fixtures   # stages worker/dist first
pnpm --filter canopycms-cdk exec vitest run src/scaffold-synth.test.ts
```

- **Why it lives in `canopycms-cdk`, not next to the CLI it exercises.** The synth needs `aws-cdk-lib`, `constructs` and a resolvable `canopycms-cdk`, and this is the one package where all three are guaranteed present. Scratch projects are created under `packages/canopycms-cdk/.scaffold-synth/` (gitignored) with **no `package.json` of their own**, and that omission is load-bearing: it is what lets Node's self-reference resolution find `canopycms-cdk` from the generated stack by walking up to this package's manifest via its `exports` field. Adding one would break that resolution. The scratch directory sits at the package root, never under `src/`, so a crashed run that skips cleanup cannot start failing `pnpm lint`/`pnpm typecheck` — both globs cover `src/`.
- **`CDK_OUTDIR` + `CDK_CONTEXT_JSON` are how the CDK CLI drives an app.** The first triggers auto-synth, the second delivers `cdk.json`'s `context` block. A test that runs the generated `app` command without the context cannot catch a bad context value — a CDKv1-only feature flag CDKv2 rejects at synth (`UnsupportedFeatureFlag`), say — because a context-free run never reaches that code path.
- **It fails loudly, never skips, when `packages/canopycms-cdk/worker/dist` is missing.** A skip would restore exactly the going-green-without-checking property the test exists to remove.
- **A synth proves nothing about types.** `cdk.json` runs the app through tsx, which strips types, so the file also runs the generated workflow's `npx tsc --noEmit -p infrastructure` — read out of the workflow the same way `appCommand` is read out of `cdk.json` — and expects it to fail on a misspelled `CanopyCmsService` prop. That check resolves `canopycms` and `canopycms-cdk` to their workspace `src/`, not the published `.d.ts`.

### Test-Owned CDK Synth Output (`newTestApp()`)

A CDK `App` with no `outdir` synthesizes into a `mkdtemp('cdk.out')` under `os.tmpdir()`. CDK cleans those up from a `process.on('exit')` handler, but **a vitest worker is torn down without firing exit handlers**, so under vitest each synth strands an assembly of 0.6-3.2 MB. Enough of them accumulate to exhaust free disk, and the symptom — a full temp filesystem breaking unrelated tooling — surfaces nowhere near its cause.

**Rule: in `packages/canopycms-cdk` tests, never call `new App()` directly — always use `newTestApp()`** from `test-support/test-synth.ts`:

```typescript
import { newTestApp } from '../../test-support/test-synth'

const app = newTestApp()
const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } })
app.synth()
```

`newTestApp(props?)` forwards `props` to `App` but applies `outdir` afterwards, pinned to a fresh `mkdtemp` subdirectory of a per-run root, and is not overridable: `props` is typed `Omit<AppProps, 'outdir'>`, so passing one is a compile error rather than an argument silently dropped. The root is created once by vitest's `globalSetup` and `rm -rf`'d when the run ends — in the main process rather than a per-file `afterAll`, so teardown still runs when an individual test file fails.

Two layers enforce this mechanically, and the distinction matters:

- **The guarantee is behavioral.** `test-support/synth-leak-guard.ts` is a `setupFiles` hook, so it wraps every test file: it snapshots `os.tmpdir()`'s `cdk.out*` entries in `beforeAll` and fails the file on any addition. That catches a leak by whatever route — a namespace-qualified `App`, a scope-less `Stack` (whose constructor builds its own `outdir`-less App), a `Stack` subclass, an innocuous `makeStack(app?: App)` called with nothing.
- **A textual scan checks the convention.** One test in `test-support/test-synth.test.ts` walks the package's TypeScript files and fails on a direct `App` construction or a scope-less `Stack`, outside an allowlist of the two files entitled to one (this helper, and `canary/bin/canary.ts`, a real deployable app). It has textual blind spots by construction — do not widen its patterns to chase subclasses, that is the hook's job — but it catches a direct construction in a file whose leak would only manifest conditionally.

`test-synth.test.ts` also asserts the tmpdir property directly around one synth of its own, with its non-vacuity checks ordered deliberately _after_ the leak assertion: placed first they fire first under the outdir-removal mutation and mask the assertion they exist to support.

Interrupting a run needs no cleanup from you: Ctrl-C makes vitest exit without running globalSetup teardown, so the root survives, and the root's name carries the owning pid so the next run's `setup` removes any root whose process is gone. Only `ESRCH` licenses that delete, so a live run's root — including a concurrent one — is never touched.

`test-support/` is treated like `lambda/`, `canary/` and `worker/`: a non-shipped directory with its own `tsconfig.json`, appended to the package's `typecheck` and `lint` scripts. That config also includes `../src/**/*.test.ts`, which nothing else typechecks — the package `tsconfig.json` is its build config and excludes test files — and it sets no `rootDir`, which is what lets those suites' deliberate cross-package imports resolve.

### Testing a Docker Image Asset's Build (Without Docker)

`DockerImageCode.fromEcr(...)`, which every other synth in `cms-deploy.test.ts` uses, has no build step, so it cannot exercise build-time behavior like the `--platform` CDK picks. For that, use `fromImageAsset(...)` pointed at the Dockerfile-only fixture `test-support/fixtures/docker-image-asset/`: `cdk synth` stages and fingerprints it as an image asset without invoking `docker build`. The platform lands in the synthesized **asset manifest**, not the CloudFormation template — read it via `app.synth().artifacts.filter(AssetManifestArtifact.isAssetManifestArtifact)` (`aws-cdk-lib/cx-api`) then `Manifest.loadAssetManifest(artifact.file).dockerImages[*].source.platform` (`aws-cdk-lib/cloud-assembly-schema`). See `synthWithImageAsset` in `cms-deploy.test.ts`.

### Diffing Synthesized Output Across a Construct Refactor

Moving a builder out of a construct can pass every existing test while changing the emitted template — and in CDK a renamed logical ID replaces live resources on the next deploy, so a passing suite is not the relevant proof. Assertions on individual `Template.fromStack()` matchers can all stay green while the underlying JSON shifts underneath them.

The check that does prove it: synth the same stack against both versions of the file, dump `Template.fromStack(stack).toJSON()` each time (a throwaway script is fine — see `newTestApp()` above for synthesizing without leaking a `cdk.out`), and diff the two. An identical diff is the proof that the refactor preserves behavior. Reach for this on any extraction out of a construct. Restore the pre-refactor file from a scratchpad copy afterwards, not `git checkout --` (see [Testing Authorization Defaults](#testing-authorization-defaults-defaultbranchaccess--defaultpathaccess)).

**A mutation only counts once you have confirmed it changed the source.** A mutation that edits something irrelevant to the behavior it claims to break (adding `customHeaders: {}` to an origin does not turn on origin access control), or a patch that shell quoting mangled, looks like a weak test and is neither. Before trusting a green or red result, check the intended edit is present in the file.

### Testing a Repo Script as a Subprocess (`scripts/bump-version.mjs`)

`packages/canopycms/src/cli/bump-version.test.ts` tests a plain `scripts/*.mjs` release script as a subprocess rather than importing it, because the script does its work at module scope against a directory tree (reads and writes `package.json` files, logs, exits) — there is no function to call. The fixture is copied in rather than run in place, since the script resolves its target paths from its own location. Reach for this shape for any `scripts/*.mjs` that does real work at import time.

```typescript
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-bump-version-'))
  await fs.mkdir(path.join(tmpDir, 'scripts'), { recursive: true })
  await fs.copyFile(SCRIPT, path.join(tmpDir, 'scripts', 'bump-version.mjs'))
})

const run = (args: string[]) =>
  promisify(execFile)(process.execPath, [path.join(tmpDir, 'scripts/bump-version.mjs'), ...args], {
    cwd: tmpDir,
  })
```

**Assert both halves of a rejection.** A script that rewrites files in place has to fail closed, not just fail: `expectRejected` seeds a version, asserts `run(args)` rejects, and then asserts every package's version is untouched. Checking the exit code alone would have missed the defect this suite exists for — an unrecognized flag written verbatim as the version string into six `package.json` files, exit 0.

**Derive test input from the real producer, not a literal.** The prerelease test runs `scripts/prerelease-version.mjs` and feeds its actual stdout into `bump-version.mjs`. A hard-coded `1.2.3` in a test named after the prerelease path stayed green when stricter validation was added and hid a real break of `publish-prerelease.yml`, which passes `prerelease-version.mjs`'s `X.Y.Z-int.N` output straight through. **When a test stands in for a pipeline, derive its input from the upstream stage of that pipeline** — a literal can silently drift from what the real producer emits.

**`--min <version>` is the release train's self-heal, not routine.** `publish.yml` commits the version bump only after all five packages publish, so an interrupted run can leave npm holding a version main does not know about, and every later run re-derives that same already-published version and fails forever. `--min` floors the bump on `max(committed version, --min value)`. If a release wedges that way, `node scripts/bump-version.mjs --min <registry-version>` is how you re-derive a safe next version; normally CI passes it for you.

## Deployment Infrastructure

The design of the prod topology is in [ARCHITECTURE.md](ARCHITECTURE.md#deployment-architecture), the operational procedures in [docs/deploying-to-aws.md](docs/deploying-to-aws.md), the worker's own invariants in [worker/AGENTS.md](packages/canopycms/src/worker/AGENTS.md), and the CLI's in [cli/AGENTS.md](packages/canopycms/src/cli/AGENTS.md). What follows is only how a contributor runs and tests this locally.

### Running the Worker Locally

`CmsWorker` (`canopycms/worker/cms-worker`) handles the internet-requiring work Lambda cannot do: it polls the file-based task queue at `.tasks/pending/`, fetches from GitHub into `remote.git` and rebases active branch workspaces, pushes `canopycms-settings-*` branches, and refreshes the auth cache through a pluggable `refreshAuthCache` callback. It lives in the core package because it has no cloud dependencies.

In dev mode, run one cycle and exit:

```bash
pnpm exec canopycms worker run-once  # refresh cache, process tasks, exit
```

**Worker code must log through `workerLog`/`workerLogWarn`/`workerLogError` (`src/worker/log.ts`), never `console.*` directly** — an eslint `no-restricted-syntax` rule on `**/worker/**` enforces it, and [worker/AGENTS.md](packages/canopycms/src/worker/AGENTS.md) states why. Elsewhere in the codebase the normal `mockConsole()` conventions apply; see [Expecting Console Messages](#expecting-console-messages).

### Testing the Worker

`src/worker/integration.test.ts` covers the full task lifecycle: the submit handler enqueues, the worker dequeues, the task completes.

Rebase logic is tested against real git in `src/worker/cms-worker-rebase.test.ts` — local "remote" repos in temp directories exercising branch skipping (submitted/approved/dirty), a clean rebase, and conflict detection with ContentId extraction. See [Testing with Real Git Operations](#testing-with-real-git-operations) for the pattern, including how the wedge test classifies which files a `rebase --abort` discards.

`src/worker/cms-worker-rebase-wedge.test.ts` covers the two ways a branch clone gets stuck mid-rebase (a modify/delete conflict, and a rebase interrupted by worker termination) plus recovery. To assert on the `workerLogWarn` output the recovery path emits, it spies on `console.warn` directly rather than using `mockConsole()` — the worker log helpers route through `console` — and restores the spy in a `finally` so a failed assertion cannot leave `console.warn` mocked for later tests:

```typescript
const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  warnings.push(args.map(String).join(' '))
})
try {
  await runRebase(makeWorker(tmpDir))
} finally {
  spy.mockRestore()
}
```

### Building the Transform Lambda (No Docker)

The prod transform Lambda needs `sharp`'s native binary for `linux/arm64`, and Docker-based bundling is not available here. `packages/canopycms-cdk/lambda/asset-transform/build.mjs` bundles `handler.ts` with esbuild (leaving `sharp`/`@img/*` and `@aws-sdk/*` external, the latter already in the Node 22.x managed runtime), then runs `npm install sharp@<range> --os=linux --cpu=arm64 --libc=glibc` in the output directory. Since sharp >= 0.33 ships its binary as a platform-specific optional dependency, those npm overrides fetch the linux/arm64 build whatever the host OS is — which is what makes Docker unnecessary, even from macOS.

The `sharp` version is read from `packages/canopycms`'s own `dependencies.sharp`, so the Lambda's binary cannot drift from the version `assets/transform.ts` is written against. **Never hardcode a version in `build.mjs`.**

```bash
pnpm --filter canopycms-cdk run build:lambda
```

Output lands in gitignored `lambda/asset-transform/dist/`, where the construct's `lambda.Code.fromAsset()` points, so `cdk synth`/`deploy` fails with "Cannot find asset" if you skip this.

### CDK Asset Verification: the Canary Stack

`packages/canopycms-cdk/canary/` is a small CDK app (not a separate package — it imports `../../src` directly) that deploys a throwaway `canopy-assets-canary` stack to a sandbox account, bootstrap qualifier `canopy`, to check `AssetSupport`'s CloudFront wiring and the transform Lambda against real infrastructure: origin-group failover, a real bucket, a real Lambda invocation. It is for manual verification by contributors working on the assets deployment path, and is in no CI job or automated suite.

```bash
pnpm --filter canopycms-cdk run build:lambda   # the Lambda asset must exist before synth
cd packages/canopycms-cdk/canary && npx cdk synth
cd packages/canopycms-cdk/canary && npx cdk deploy --profile sandbox-admin
```

The stack sets `RemovalPolicy.DESTROY` and `autoDeleteObjects: true` — deploy it, check it, tear it down.

### Working on the `init` CLI

`canopycms init` lives at `src/cli/init.ts` and runs under `tsx` (`#!/usr/bin/env tsx`, not `node`), so `tsx` is a production dependency: it must be present at runtime for an adopter running `npx canopycms init`.

Templates are `.template` files under `src/cli/template-files/`, located at runtime relative to the script via `import.meta.url`. The directory is named `template-files` rather than `templates` to avoid an ESM directory-import collision with `templates.ts`. Because `tsc` compiles only `.ts`, they are copied separately by the `postbuild` script (`cp -r src/cli/template-files dist/cli/template-files`) — new template files are picked up automatically, but renaming the directory or changing the copy target means updating both `templates.ts`'s `TEMPLATES_DIR` and `postbuild`.

`init.integration.test.ts` runs the binary from both source and `dist/`. The dist block needs `pnpm build` to have run first; its `beforeAll` checks for `dist/cli/init.js` and throws a clear error when it is missing. **When you change the set of files `canopycms init` creates, update the `expectedFiles` array in both the source and dist blocks.**

### Working on the `sync` CLI

`canopycms sync` (`src/cli/sync.ts`) moves content between the developer's working tree and the branch workspaces in `.canopy-dev/content-branches/`. The commands and workflow are adopter-facing — see [README.md](README.md#local-development-sync). Three implementation rules:

- **Throw typed errors; let the entrypoint exit.** Precondition failures throw `SyncError` (`cli/sync.ts`) or `MigrateError` (`cli/migrate.ts`) rather than printing a warning and exiting 0; `main().catch` in `cli/cli.ts` turns any thrown error into `Error: <message>` on stderr plus exit 1. A new CLI precondition throws a typed error with an actionable message — never `console.warn` + `process.exit(0)`.
- **Project root resolution is shared.** Project-bound commands (`sync`, `migrate`, `worker run-once`, `generate-ai-content`) walk up from cwd to the nearest `canopycms.config.ts` via `findProjectRoot()` (`cli/project-root.ts`), so they work from a subdirectory and fail fast outside a project.
- **Both flags are path-traversal guarded.** `--branch` and `--content-root` are validated with `assertWithinDir()`, and every resolved path is checked to stay inside its expected parent before any file operation, so `--branch ../../etc` cannot escape.

Push replaces the workspace's content directory from the working tree, auto-committing any uncommitted editor changes there first so nothing is lost, tagging the result `canopycms-sync-base` for later 3-way merges, and using a backup-rename replacement so an interruption always leaves one complete copy on disk. Pull copies back the other way, detecting uncommitted changes and untracked files that would be deleted and prompting first. `both` uses the `canopycms-sync-base` tag as the merge base, leaving the workspace in a merge state with instructions on conflict; `abort` runs `git merge --abort` there.

## Dependency Overrides (`pnpm.overrides`)

Root `package.json` pins several transitive dependencies to force in a security fix ahead of whatever the dependency tree would otherwise resolve. JSON carries no comments, so the rationale for each pin lives here — check this list before removing or loosening one, and re-check that `pnpm why <pkg>` still resolves to a non-vulnerable version if you do.

- `ws@^8.20.1` — GHSA-58qx-3vcg-4xpx (CVE-2026-45736): uninitialized memory disclosure before 8.20.1.
- `uuid@^11.1.1` — GHSA-w5hq-g745-h8pq (CVE-2026-41907): missing buffer bounds check in v3/v5/v6 when a `buf` is supplied; fixed in 11.1.1.
- `js-cookie@^3.0.7` — GHSA-qjx8-664m-686j (CVE-2026-46625): per-instance prototype hijack in `assign()` enables cookie-attribute injection in <= 3.0.5.
- `fast-xml-parser@^5.7.0` — GHSA-gh4j-gqv2-49f6 (CVE-2026-41650): XMLBuilder comment/CDATA injection via unescaped delimiters; fixed in 5.7.0.
- `brace-expansion@^2.0.3` — GHSA-v6h2-p8h4-qcjw (CVE-2025-5889): ReDoS in `expand()`; keeps the 2.x line above the vulnerable <= 2.0.1 range.
- `picomatch@^4.0.4` — GHSA-c2c7-rcm5-vvqj (CVE-2026-33671) and GHSA-3v7f-55p6-f55p (CVE-2026-33672): extglob ReDoS and a POSIX-class method-injection bug, both fixed in 4.0.4.
- `postcss@^8.5.10` — GHSA-qx2v-qp2m-jg93 (CVE-2026-41305): XSS via unescaped `</style>` in stringify output; fixed in 8.5.10.
- `yaml@1@^1.10.3` — GHSA-48c2-rrv3-qjmp (CVE-2026-33532): stack overflow on deeply nested collections; pins the legacy 1.x line (still pulled in transitively) above the vulnerable < 1.10.3 range.

## Quality Checks

Before handoff, run typecheck and tests:

```bash
pnpm typecheck
pnpm test
```

### Unused-Exports Check

`pnpm lint:exports` runs [knip](https://knip.dev) in production mode over `canopycms` and
`canopycms-next` (`knip.json`; the other workspaces are ignored). An export nothing in
production code imports fails the check. An export a test needs carries a one-line
`/** @internal Exported for tests. */` tag, which the `--tags=-internal` flag excludes; an
export nothing imports at all carries `@internal No importer; deletion candidate in <task file>.`
and a `.claude/future-tasks/` entry that owns its deletion. The guard covers declaration sites
only: barrel `index.ts` files and the two editor re-export shims are excluded from the report,
so a dead re-export line in a barrel is not detected
([knip-scope-gaps.md](.claude/future-tasks/knip-scope-gaps.md)). Package `exports` maps, `bin`,
stories, `.storybook/`, the config barrel and the groups barrel are the entries.

### Client-Bundle Boundary Check

The editor reaches browsers through `canopycms/client` and `canopycms-next/client`. Anything reachable from those entries, at any depth, must stay free of node built-ins, or an adopter's production `next build` dies with `Module not found: Can't resolve 'fs'`. `next dev` tolerates the violation, so without this check the mistake only surfaces in a production build.

```bash
pnpm lint:bundle
```

It runs in CI and in the pre-commit hook whenever a commit touches either package's `src/`. The header of [.dependency-cruiser.mjs](.dependency-cruiser.mjs) states the scope, including why `import type` edges stay legal and why `node_modules` is not followed. A violation prints the whole chain from the entry to the built-in:

```
error client-bundle-no-node-builtins: packages/canopycms/src/client.ts → fs/promises
    packages/canopycms/src/editor/CanopyEditor.tsx →
    ...
    packages/canopycms/src/paths/branch.ts →
    fs/promises
```

Import the dependency-free sibling the rule's `comment` names, or make the import `import type`. When client-reachable code needs browser-safe logic that sits in a node-importing file, extract it into its own dependency-free module rather than widening the rule.

### Import-Cycle and Module-Boundary Check

```bash
pnpm lint:cycles
```

Runs every rule in [.dependency-cruiser.mjs](.dependency-cruiser.mjs) over both packages' `src/`: `no-circular`, plus the module-boundary rules `http-reaches-api-only-via-routes`, `api-never-imports-worker`, `editor-imports-api-only-client-index-constants` and `core-no-github-app-auth`. Each rule's `comment` states the rule and its fix. CI and the pre-commit hook run it alongside `lint:bundle`.

Both packages are at **zero cycles**, so any violation is one you just introduced. Cycles bite hardest when splitting a class whose methods called each other: hoist the shared piece into a third module (`worker/history-rewrite.ts`) or pass the collaborator in through a context object (`worker/worker-context.ts`).

### Comment and Doc Budgets

Both budgets run in CI and in the pre-commit hook. Each script's header comment carries its rules.

- `pnpm lint:comments` — [scripts/check-comment-budget.mjs](scripts/check-comment-budget.mjs) against `scripts/comment-budget.json`: history markers in source comments, comment run length and comment/code ratio. `--report` prints per-file, per-directory and per-package tables; `--markers` lists marker lines.
- `pnpm lint:docs` — [scripts/check-docs.mjs](scripts/check-docs.mjs) against `scripts/docs-budgets.json`: paths, links and package imports must resolve, plus word ceilings per file and per H2 section, history markers, and list-item and table-cell length in `CODEBASE_GUIDE.md` and module `AGENTS.md`. `--report`, `--report --sections <file>` and `--list-long-items` print the numbers.
- `--write-baseline` on either script rewrites its budget file from actuals, `--margin=<pct>` adds headroom, and a rewrite that would raise any number is refused without `--allow-raise`: a raise is a reviewed decision stated in the commit message.
- For a comment-only change, `node scripts/diff-comments-only.mjs <git-range>` proves nothing but TypeScript comments changed by comparing parser token streams on both sides; its header lists what else must match.

### Published-Package ESM Import Check

```bash
pnpm check:esm
```

`tsc` with `moduleResolution: "Bundler"` emits extensionless relative specifiers (`from './adapter'`), which `tsc` and bundlers tolerate but Node's native ESM resolver rejects outright (`ERR_MODULE_NOT_FOUND`). [ARCHITECTURE.md](ARCHITECTURE.md#esm-output-must-be-node-resolvable-not-just-bundler-resolvable) states why nothing else in this repo can see that class of defect, and what the guard therefore has to do.

[scripts/check-esm-imports.mjs](scripts/check-esm-imports.mjs) **requires a build first** — it resolves each published package's entry points against real built `dist/` output, not `src/`. It builds a sandbox `node_modules`, merging each package's `publishConfig` over its `package.json` (the same merge `npm publish`/`pnpm pack` perform), points the result at the real `dist/`, and then:

- **imports every entry point as ESM** in a real Node subprocess;
- **requires every entry point from CommonJS.** When a `package.json` has an `exports` map Node ignores `main` entirely, and a `require()` resolves the conditions `["node", "require", "default"]` — so a map offering only `{ types, import }` matches nothing and dies with `ERR_PACKAGE_PATH_NOT_EXPORTED` before the module loads. All five packages therefore declare `engines: node >=22.12.0` (the release that unflagged `require(esm)`) and list conditions `types` first, then `import`, then `require`. **Position matters:** resolvers take the first matching key, and some ignore a `types` entry that sits after `import`.
- **statically checks every published subpath:** it must carry a `require` (or `default`) condition, list `types` first at every nesting level, and name targets that are valid per Node (`./`-prefixed, no `..`), exist on disk, and are covered by `files`. That static half is the only thing standing behind the `skip` subpaths, which no probe can execute.
- **typechecks a generated consumer** against the same sandbox with `module`/`moduleResolution: nodenext` and `skipLibCheck` deliberately **off**, which is the only way to see a missing extension inside a `.d.ts` (the ARCHITECTURE section above says why that failure is otherwise silent). Two classes of diagnostic fail it: anything attributed to the generated `consumer.ts` (it imports nothing but our own packages, so every diagnostic there is ours), and `TS2834`/`TS2835`/`TS2307`/`TS7016` whose path points into one of our own `dist/` directories. Diagnostics on third-party paths are ignored, because the probe sets `types: []` and dependency declarations then emit unrelated noise. This pass covers **every** published subpath, not just the runtime-testable ones: each `skip` is a runtime limitation and none of them apply to `import type`.
- **compiles a consumer under six real adopter tsconfig shapes**, with value imports rather than `import type` (a type-only import is erased and never produces the interop diagnostic that is the point):

| Consumer | `module` / `moduleResolution`             | Result                                      |
| -------- | ----------------------------------------- | ------------------------------------------- |
| ESM      | `nodenext`                                | compiles                                    |
| ESM      | `esnext` / `bundler`                      | compiles — what `create-next-app` gives you |
| CommonJS | `commonjs` / `node10`, **root specifier** | compiles, via `main`/`types`                |
| CommonJS | `commonjs` / `node10`, **subpath**        | **`TS2307` — pinned limitation**            |
| CommonJS | `nodenext`                                | compiles                                    |
| CommonJS | `node16`                                  | **`TS1479` — pinned limitation**            |

The two pinned rows are **not** tolerated failures: a row flipping in _either_ direction fails the check, because either way the adopter-facing story moved and the docs describing it are wrong. Neither is caused by the `exports` map. `node16` is pinned to Node 16 semantics, where `require(esm)` does not exist, so TypeScript refuses any value import of an ESM-only package from a CommonJS file; the cause is the package being ESM-only, and an adopter's fix is `nodenext` or a dynamic `import()`. `node10` predates `exports` and ignores it, looking for a physical `node_modules/canopycms/server.js` while our files live under `dist/`; supporting it would mean stub directories or `typesVersions`, legacy compat this project does not carry.

**It also enforces publish-status coverage.** Every `exports` subpath of every published package must be declared in the `PACKAGES` list as exactly one of `test` (imported live under Node), `skip: <reason>` (published but not exercisable this way, e.g. a client entry that pulls in CSS), or `devOnly: <reason>` (in the dev `exports` map so sibling workspace packages can import it, deliberately absent from `publishConfig.exports`). `checkCoverage()` enforces both directions: a `devOnly` subpath reappearing in `publishConfig.exports` fails, and so does a `publishConfig.exports` subpath declared nowhere. A subpath advertised in `publishConfig.exports` but excluded from the build resolves in-repo through the dev map and fails for every external consumer; this is the gap the coverage check closes. **A new workspace-internal-only subpath must be declared `devOnly` here.** See [ARCHITECTURE.md](ARCHITECTURE.md#package-architecture) for why `test-utils` stays unpublished.

**Fixing a hit:** run [scripts/add-js-extensions.mjs](scripts/add-js-extensions.mjs), the shared post-build step that rewrites extensionless relative specifiers to explicit `.js` (or `/index.js` for directory and bare `.`/`..` specifiers). It is wired into all five published packages' `build` scripts — `packages/canopycms` through its own `packages/canopycms/scripts/postbuild.mjs`, the other four inline as `tsc ... && node ../../scripts/add-js-extensions.mjs dist`. **Wire a new published package's `build` script the same way**; `check:esm` fails on the omission. It rewrites `.d.ts` alongside `.js`, appending the **runtime** extension (`./x.js`, never `./x.d.ts`), which is what TypeScript expects in a declaration file.

Each package's `build` script runs `rm -rf dist` before `tsc`, because bare `tsc` never removes output it no longer emits: narrowing a `tsconfig.build.json` `exclude` list, or deleting a source file, otherwise leaves the stale compiled file behind on top of a fresh build. An "undeclared runtime dependency" report for something like `vitest` that nothing in current `src/` imports is almost always a stale `dist/` from a `tsc` invocation that bypassed the package's `build` script — delete `dist/` by hand and rebuild before trusting the output.

The rewrite pattern is the most fragile part and fails silently in both directions: too narrow and a relative specifier ships unrewritten (a bare `.` did exactly that), too wide and a bare package name gets a spurious `.js` welded on. `node scripts/add-js-extensions.mjs --self-test` asserts the classification table plus an end-to-end rewrite (directory expansion, bare dot, already-suffixed specifiers, `.d.ts` alongside `.js`, idempotence), and `pnpm check:esm` runs it first so it executes in CI.

**When you change either the rewrite or the guard, verify the guard still fails.** Strip a `.js` off one relative specifier in a built `dist/**/*.d.ts` and re-run `pnpm check:esm`: the runtime probe should stay green and the type pass go red. Deleting a built `.d.ts` outright should also go red. Appending `await Promise.resolve()` to a built `dist/index.js` should turn the CJS probe red while ESM stays green, because `require(esm)` refuses async graphs (`ERR_REQUIRE_ASYNC_MODULE`). If any of those stays green the guard is not testing what it claims — and confirm the mutation actually landed before trusting the result (see [Diffing Synthesized Output Across a Construct Refactor](#diffing-synthesized-output-across-a-construct-refactor)).

### Standalone CMS Image Smoke Test (`standalone-image` CI job)

`scripts/smoke/standalone-image.mjs` builds the CMS editor image `canopycms init-deploy aws` generates (`Dockerfile.cms.template`), boots it, and sends it real requests. **Its header comment is authoritative on the why — read it before changing the script.** In short:

- **The app is scaffolded OUTSIDE this workspace.** A Next 16.1.7 app installs `pnpm pack` tarballs of `canopycms`, `canopycms-next` and `canopycms-auth-dev` (`npm pack` will not do — only pnpm applies `publishConfig` and rewrites `workspace:` ranges). In this workspace those packages are workspace links compiled through `transpilePackages`, which is not what an adopter installs. The registry-shaped install, built with Next 16's default Turbopack, externalizes sharp as `.next/node_modules/sharp-<hash>`, the shape the libvips defect shows in. A webpack build under pnpm bundles sharp instead (see [webpack-standalone-sharp-bundled.md](.claude/future-tasks/webpack-standalone-sharp-bundled.md)).
- **It runs in dev mode**, with a git checkout of the scaffold's `content/` on a non-`main` `release-base` branch copied in before boot. The page's title in the working tree, which `next build` reads, differs from its title in the `release-base` commit, which requests read, so a check can tell which copy served a response.
- **14 checks (`assertContainer`)**: `whoami` answers 200; `/hello` renders the `release-base` title (a request-time read of the branch clone), not the working-tree one; `/sitemap.xml` lists the page's URL — its slug is identical in both copies, so this check cannot yet tell a build-time read from a request-time one ([cms-image-pr5-review-followups.md](.claude/future-tasks/cms-image-pr5-review-followups.md), item 5); `/no-such-page` is a 404 carrying the `release-base` title (the root layout's request-time read) while `/no/such/route` is a 404 carrying the working-tree title (Next serves the not-found page `next build` prerendered); `/favicon.ico` is not a 5xx; an asset round trip (presign, proxied upload/finalize, the `orig` identity transform through sharp as a PNG, a WebP resize); sharp externalized as `.next/node_modules/sharp-*` aliases, each with the libvips-cpp its own sharp declares, each loading and encoding; and zero `ERR_DLOPEN_FAILED` in the container logs.

Run it locally (needs Docker running, Node >= 22.2, pnpm, and corepack for `--pm pnpm`):

```bash
node scripts/smoke/standalone-image.mjs --pm pnpm
node scripts/smoke/standalone-image.mjs --pm npm
```

Flags: `--pm pnpm|npm`, `--next <version>` (default 16.1.7), `--pnpm-version` (default 11.27.0, written as the scaffold's `packageManager`), `--tarballs <dir>` (reuse pre-packed tarballs, exactly one per package), `--work-dir <dir>` (must be outside the repo — checked as given and through the real path of its nearest existing ancestor before it is created), and `--keep` (keep the container, image and scaffold).

**When it fails.** Once the container exists the script writes its whole log to `<work-dir>/container.log` on every exit path, and prints the last 200 lines when a check failed or the run stopped before the checks. Without `--work-dir` the work dir is a temp directory, deleted only after a fully green run without `--keep`. In CI a failed leg uploads `container.log` as an artifact.

**Red-before-green:** `pnpm pack --pack-destination <dir>` from `packages/<name>` against a deliberately broken copy of that package, copy the other two tarballs into the same directory, then run with `--tarballs <dir>`. Restore the source from a scratch copy afterward — never `git checkout --`.

**Pitfall:** a fixture that bundles sharp instead of externalizing it fails the "externalized" check on purpose. That is the guard working, not a fixture bug.

CI runs it as `standalone-image`, matrixed over pnpm and npm on `ubuntu-latest` and pnpm on `ubuntu-24.04-arm` (the Lambda's default architecture). It is gated by `dorny/paths-filter` like `dual-build` — the job always reports, only the expensive build and boot steps are skipped — on every source and packaging input of the three packages, the lockfile, the root `package.json`, `.nvmrc`, and the script and workflow themselves. `ci.yml` carries the list and why it is that wide.

### Future-Tasks Backlog Check

`.claude/future-tasks/` is the durable backlog, and AGENTS.md requires every deferred issue to exist as a task file **plus** an `index.md` row.

```bash
pnpm lint:tasks
```

It runs in CI right after `lint:bundle`, and in the pre-commit hook whenever a commit touches `.claude/future-tasks/`. The script is [scripts/check-future-tasks.mjs](scripts/check-future-tasks.mjs) — plain node, no dependencies. It enforces four things:

- **Dead links** — every `.md` link target must resolve **relative to the linking file's own directory**. Task files cross-link with relative paths, so moving a file into `resolved/` breaks inbound links in files that did not change, and a repo-root-relative check would call those clean.
- **Stale open rows** — a row in an open priority table whose file already lives in `resolved/`. The open tables claim to list open work only, and program sequencing reads them.
- **Orphans, both directions** — a task file no `index.md` row points at, and a row pointing at a file that does not exist.
- **`[[wikilinks]]`** — they render as literal `[[text]]` on GitHub and are invisible to the dead-link check, so they rot silently. Kebab-case slugs only, so `[[...slug]]` (Next.js catch-all routes) and `[[:space:]]` (POSIX class) stay legal in prose.

Only `.md` targets are checked. Task files also cite source files as prose written relative to the repo root rather than as navigable links; checking those would be pure false positives.

When you retire a task, do all three things together or the check will name the one you missed: `git mv` the file into `resolved/`, move its `index.md` row to the Resolved section, and fix any inbound links. One deliberate exception is documented in the backlog itself — `program-b-final-review-followups.md` strikes items ~~in place~~ rather than moving them, because the file still holds open work.

**Use `--fix` for the mechanical half.** Moving a file into `resolved/` invalidates relative paths in two directions at once — links _inside_ the moved file (siblings are now one level up, repo-root docs one further) and links _pointing at_ it (now behind `resolved/`) — and the checker already knows where the target went:

```bash
pnpm lint:tasks --fix
```

It repairs only paths whose target exists somewhere unambiguous, refuses when a basename is ambiguous across directories, and rewrites the `](target)` form specifically, so a path that also appears as prose is left alone. Two things it deliberately will **not** fix, because both need judgment: a **stale open row** (moving it to the Resolved section usually means rewriting the summary too) and an **orphan file** (its row has to be written by whoever knows what the task is).

### Trojan Source (Bidirectional Unicode) Check

CI scans tracked files for bidirectional unicode control characters (U+202A-202E, U+2066-2069) before `pnpm install` runs, catching CVE-2021-42574 in seconds. It checks file _contents_ and file _names_ separately: `git grep` reads contents only, so a file merely named with an override (`report<U+202E>gnp.ts`, which renders as `report st.png`) needs its own pass over `git ls-files -z`. Content matching uses `git grep -P -I`, so a file git treats as binary (a NUL byte, or a `.gitattributes` `binary`/`-diff` marking) is skipped — a deliberate trade, since without `-I` a future binary fixture would false-positive on any stray `E2 80 AA`-`AE` byte run.

It pins `LC_ALL=C.UTF-8`: `git grep -P` compiles `\x{...}` escapes above 0xFF only in PCRE2 UTF mode, which git enables only under a UTF-8 locale — under `LC_ALL=C` the command dies with exit 128 instead of matching nothing. The **content** half therefore branches on exit status with `case` rather than `if`: 0 (matches) fails, 1 (clean) passes, and anything else — including that 128 — fails loudly rather than reading as clean.

The **filename** half is built differently, deliberately. It uses perl rather than `grep -P`, so it runs on macOS too (BSD grep has no `-P`), and it matches the raw UTF-8 **bytes** rather than decoding with `-CSD`. Decoding would make a path whose bytes are an invalid multi-byte sequence — a bad or missing continuation after a start byte such as `E2`, though not a stray `\xff`, which never reaches the decoder — a _fatal_ match error, aborting the scan partway and leaving every later path unexamined. That is a way to mask a bidi filename, since invalid-UTF-8 paths are creatable on the runner's ext4 (not on macOS/APFS). Detection there is signalled by output rather than exit status, because an `END` block runs on death too and would launder a fatal into a status the caller reads as clean; `set -o pipefail` covers the matching case where `git ls-files` itself fails.

A wrong byte range would fail open, so the step self-tests the pattern against all nine codepoints before trusting a clean result, and both halves splice one shared definition so the self-test cannot drift from the scan. Those nine are the embeddings, overrides and isolates only — not the marks U+061C/U+200E/U+200F, which reorder just adjacent neutral runs and appear legitimately in the RTL content this CMS edits. ESLint's `security/detect-bidi-characters` overlaps but is JS/TS-only and only a warning, so it does not gate CI.

### Dependency License Scan (Trivy)

CI runs a Trivy `fs` scan (`scanners: license`, `severity: HIGH,CRITICAL`, `exit-code: 1`) **after** `pnpm install`, deliberately: Trivy reads `pnpm-lock.yaml` but collects license metadata from the installed tree, so against a bare checkout it reports the lockfile as "Not scanned" and exits 0 without having inspected anything.

A new HIGH/CRITICAL (LGPL/GPL-class) license anywhere in the production dependency graph fails the build. Either remove the dependency or add a documented exemption to [.trivy-ignore-policy.rego](.trivy-ignore-policy.rego), passed via the action's `ignore-policy:` input. The existing exemption covers libvips (`LGPL-3.0-or-later`), pulled in by `sharp`, and is scoped by package-name prefix because the flagged package differs between a dev machine (`@img/sharp-libvips-darwin-arm64`) and CI (`@img/sharp-libvips-linux-x64`, `-linuxmusl-x64`).

**It has to be a rego policy, not the simpler `.trivyignore.yaml`.** A YAML `licenses:` rule matches the license expression _alone_ and cannot be narrowed to a package: every license report here carries `FilePath: "pnpm-lock.yaml"`, so `paths:` only ever matches the lockfile, and `purls:` is not applied to license results at all. A YAML rule would therefore suppress _every_ `LGPL-3.0-or-later` dependency, present and future — silently passing exactly what the scan exists to catch. Rego receives `PkgName`, so it exempts the packages we mean and nothing else.

### Waiting on PR Checks

```bash
node scripts/wait-for-pr-checks.mjs 272
```

Use the watcher rather than watching a PR by hand or with an inline bash loop, which cannot distinguish a conflicted PR, a stale green, a never-registered workflow or a `gh` failure from "still pending". [scripts/wait-for-pr-checks.mjs](scripts/wait-for-pr-checks.mjs) and its skill own that behaviour. It polls until the situation is decided, then prints exactly one verdict, which is also its exit code: `0 PASSED` (annotated `STALE WARNING` when the base has advanced past the PR head), `1 FAILED` (naming the checks and linking the jobs), `2 BLOCKED` (merge conflicts), `3 NO_CHECKS`, `4 TIMED_OUT`, `5 ERROR`. Omit the PR number to watch the current branch's PR; `--interval`, `--timeout`, `--grace`, `--repo`, `--required`, `--fail-fast` and `--verbose` adjust the defaults (30s poll, 25 minute budget, 120s grace for checks to appear). It emits one line per **state change** rather than per poll, so it is quiet enough to sit behind a `Monitor` command. A merged or closed PR is evaluated once rather than polled, so it also answers "what did CI say about that PR" after the fact.

### Public re-exports: attach JSDoc at the entrypoint

When you add a new top-level public symbol re-exported from `packages/canopycms/src/server.ts` (or `index.ts`) via a named `export { X } from './module'`, **attach JSDoc above the re-export site too**, even when the source file already documents the original declaration. TypeScript's JSDoc propagation through a named re-export is inconsistent across LSP versions and module-resolution modes, so an adopter hovering over `import { X } from 'canopycms/server'` can lose the documentation if it lives only on the original. Wildcard `export *` re-exports propagate reliably and need no duplication.

### CI Workflow Conventions

When adding a step to `.github/workflows/*.yml`, or to the generated adopter deploy workflow template:

- **Pin third-party actions to a full commit SHA, with the version tag as a trailing comment** — `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, not `@v7`. A movable tag can be repointed (the `tj-actions/changed-files` supply-chain incident is the canonical example); a pinned SHA cannot run different code without the diff showing up in this repo's history. This applies to every workflow and matters most in `publish.yml`, which mints a token that can bypass branch protection and holds `id-token: write` for npm provenance across five public packages. Nothing refreshes these pins for you: `.github/dependabot.yml` raises security updates only and scans only `.github/workflows/`, so it never touches the adopter template or the example, and a stale pin shows up as a warning annotation on every job rather than as a PR.
- **Give every job an explicit, minimal `permissions:` block** rather than relying on the repo-level default. `ci.yml`'s job needs nothing but `contents: read` (plus `pull-requests: read`, for `dorny/paths-filter`) even though it runs `pnpm install`, which executes untrusted dependency lifecycle scripts alongside whatever credentials `actions/checkout` persisted on disk — an explicit read-only block means that scope cannot silently widen if the repo-level default ever does. Jobs that need to write (`publish.yml`'s `contents: write`/`id-token: write`) scope permissions per job, not workflow-wide, so an unrelated job in the same file does not inherit write access it never needed.

### Storybook

Update stories when UI changes, and run Storybook to verify:

```bash
pnpm --filter canopycms storybook
```

### Claude Subagents

- `.claude/agents/test.md` — test runner
- `.claude/agents/typecheck.md` — type checker
- `.claude/agents/review.md` — code review
