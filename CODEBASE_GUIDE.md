<!-- This file is maintained by the update-codebase-guide agent (.claude/agents/update-codebase-guide.md). -->
<!-- Do not edit manually — changes will be overwritten. -->

A map: which file does what, one line each. Why a thing is designed that way lives in
[ARCHITECTURE.md](ARCHITECTURE.md); a module's invariants live in that module's own `AGENTS.md`; and
the code comment at the point of a rule is authoritative over all of them.

## Package Structure

Published packages, under `packages/`:

- `packages/canopycms/` — core CMS library
- `packages/canopycms-next/` — Next.js adapter: config wrapper, catch-all handler, context, client components
- `packages/canopycms-auth-clerk/` — Clerk auth plugin
- `packages/canopycms-auth-dev/` — dev auth plugin, cache writer, dev JWT verifier
- `packages/canopycms-cdk/` — AWS CDK constructs: VPC, EFS, Lambda, EC2 worker

Apps, under `apps/`, never published:

- `apps/example1/` — reference Next.js app showing the adopter integration
- `apps/test-app/` — Playwright end-to-end target
- `apps/dual-build-fixture/` — CI-only fixture running real `next build`s for both deploy shapes; see [Test Organization](#test-organization)

Repo-level tooling, under `scripts/`:

- `scripts/add-js-extensions.mjs` — rewrites a built `dist/`'s extensionless relative imports to explicit `.js`, for Node's ESM resolver
- `scripts/check-esm-imports.mjs` — imports every published `exports` subpath under plain Node ESM; see [DEVELOPING.md](DEVELOPING.md#published-package-esm-import-check)
- `scripts/bump-version.mjs` — sets the version across all five publishable packages in lockstep
- `scripts/prerelease-version.mjs` — computes an integration publish's `X.Y.Z-int.N` version
- `scripts/check-docs.mjs` — doc word budgets, list-item length, backticked-path and link resolution
- `scripts/check-comment-budget.mjs` — source-comment volume ratchet, budgets in `scripts/comment-budget.json`
- `scripts/check-future-tasks.mjs` — backlog index and task-file link integrity; see [DEVELOPING.md](DEVELOPING.md#future-tasks-backlog-check)
- `scripts/check-action-pins.mjs` — fails when a third-party GitHub Action is referenced by a mutable tag
- `scripts/diff-comments-only.mjs` — proves a git range changed only comments in TypeScript files
- `scripts/wait-for-pr-checks.mjs` — polls a PR's checks to a definite verdict; see [DEVELOPING.md](DEVELOPING.md#waiting-on-pr-checks)
- `scripts/docs-budgets.json` — the per-doc ceilings `check-docs.mjs` enforces
- `scripts/smoke/standalone-image.mjs` — builds and boots the generated CMS image against packed tarballs; see [DEVELOPING.md](DEVELOPING.md#standalone-cms-image-smoke-test-standalone-image-ci-job)

## Source Code Organization

Core modules, each with its own `AGENTS.md` where one exists — the invariants are there, not here:

- `packages/canopycms/src/api/` — API handlers, route builder, declarative guards — [AGENTS.md](packages/canopycms/src/api/AGENTS.md)
- `packages/canopycms/src/ai/` — AI-ready content generation and serving — [AGENTS.md](packages/canopycms/src/ai/AGENTS.md)
- `packages/canopycms/src/assets/` — asset store, finalize pipeline, image-transform engine — [AGENTS.md](packages/canopycms/src/assets/AGENTS.md)
- `packages/canopycms/src/auth/` — authentication plugin interface and cache system
- `packages/canopycms/src/authorization/` — branch and path access control, groups — [AGENTS.md](packages/canopycms/src/authorization/AGENTS.md)
- `packages/canopycms/src/build/` — static build output and pruning of prior runs — [AGENTS.md](packages/canopycms/src/build/AGENTS.md)
- `packages/canopycms/src/cli/` — CLI commands and scaffolding templates — [AGENTS.md](packages/canopycms/src/cli/AGENTS.md)
- `packages/canopycms/src/config/` — configuration types, Zod schemas, validation
- `packages/canopycms/src/editor/` — React editor UI — [AGENTS.md](packages/canopycms/src/editor/AGENTS.md)
- `packages/canopycms/src/http/` — framework-neutral request router and handler factory
- `packages/canopycms/src/operating-mode/` — prod and dev strategies — [AGENTS.md](packages/canopycms/src/operating-mode/AGENTS.md)
- `packages/canopycms/src/paths/` — path utilities with branded types
- `packages/canopycms/src/schema/` — schema loading, resolution, and CRUD
- `packages/canopycms/src/static/` — framework-agnostic static-generation helpers and build guards — [AGENTS.md](packages/canopycms/src/static/AGENTS.md)
- `packages/canopycms/src/task-queue/` — file-based task queue, plus the CMS queue contract
- `packages/canopycms/src/test-utils/` — shared test utilities, workspace-internal
- `packages/canopycms/src/utils/` — shared cross-cutting helpers — [AGENTS.md](packages/canopycms/src/utils/AGENTS.md)
- `packages/canopycms/src/validation/` — field traversal, entry and reference validation — [AGENTS.md](packages/canopycms/src/validation/AGENTS.md)
- `packages/canopycms/src/worker/` — CmsWorker daemon, git sync, rebase loop — [AGENTS.md](packages/canopycms/src/worker/AGENTS.md)

Flat `src/*.ts` modules, kept flat deliberately — [AGENTS.md](packages/canopycms/src/AGENTS.md).
Content, git and branch files have their own sections below; the rest:

- `index.ts` — package main entry, client-safe exports only
- `client.ts` — `use client` editor exports for `canopycms/client`
- `server.ts` — server entry point exports
- `config.ts` — re-export shim over the `config/` module
- `types.ts` — core types: `BranchContext`, `BranchMetadata`, `SyncStatus`, `PullRequestState`, `WorkerStatusReport`
- `services.ts` — `CanopyServices` factory; resolves and bakes both branch-identity fields, see [ARCHITECTURE.md](ARCHITECTURE.md#branch-identity-defaultbasebranch-vs-defaultactivebranch)
- `context.ts` — `CanopyContext` / `CanopyBuildContext` creation; see [ARCHITECTURE.md](ARCHITECTURE.md#context-architecture)
- `build-canopy.ts` — `createBuildCanopy`, one-call build/admin context for standalone scripts; bypasses ACLs
- `build-mode.ts` — `isDeployedStatic` / `isBuildMode` / `readsFromCheckout`; see [ARCHITECTURE.md](ARCHITECTURE.md#static-deployment-and-build-mode)
- `config-test.ts` — test-only config helpers, `defineCanopyTestConfig` and `createTestServices`
- `id.ts` — `generateId`, 12-character Base58 content IDs
- `user.ts` — user utilities
- `resolve-canopy-user.ts` — shared authenticate-then-merge-internal-groups pipeline for both request entry points
- `comment-store.ts` — field, entry and branch comment persistence under layered concurrency; see [ARCHITECTURE.md](ARCHITECTURE.md#comments--collaboration)
- `entry-schema.ts` — `defineEntrySchema`, `TypeFromEntrySchema`, block templates, `buildResolvedReference`
- `entry-schema-registry.ts` — registry for reusable field definitions; validates `isTitle` and `isBody`
- `reference-resolver.ts` — `loadReferenceOptions`, scoped by collections and entry types
- `entry-link-resolver.ts` — resolves `entry:ID` patterns in markdown; see [Entry Links](#entry-links)
- `resource-generation.ts` — the on-disk generation-marker primitive behind durable cache invalidation
- `dev-content-watcher.ts` — dev-mode working-tree vs branch-clone divergence warning
- `sync-core.ts` — prompt-free core of working-tree to branch-clone content sync
- `url-exclusivity-fixtures.ts` — vitest-free enumerate-then-probe check for the one-URL invariant

### Static-Export Helpers

**Location**: `packages/canopycms/src/static/` —
[AGENTS.md](packages/canopycms/src/static/AGENTS.md), which holds all four build guards and the
one-URL invariant.

- `index.ts` — `collectStaticPaths`, `collectRoutableEntries`, and the four build-time guards over a raw listing
- `seo.ts` — `extractSeoFields`, `isNoindexEntry`, `resolveSeoUrl`, `withTrailingSlash`, `DEFAULT_SEO_FIELD_NAMES`

Which guards run, in what order, and what each one catches are in
[ARCHITECTURE.md](ARCHITECTURE.md#build-time-content-validity-guard); the Next adapter over them is
`canopycms-next/src/static.ts`.

## API Layer

**Location**: `packages/canopycms/src/api/` — [AGENTS.md](packages/canopycms/src/api/AGENTS.md)

Route handlers, one file per endpoint namespace:

- `branch.ts` — `/branches`: create, list, delete; each `BranchListItem` carries server-computed `isProtected` / `readOnly`
- `branch-status.ts` — `/branch-status`: status and submit
- `branch-withdraw.ts` — `/branch-withdraw`: withdraw a PR
- `branch-review.ts` — `/branch-review`: request changes
- `branch-merge.ts` — `/branch-merge`: merge and clean up
- `content.ts` — `/content`: read and write; runs entry-link and adopter `validateEntry` validation on write
- `entries.ts` — `/entries`: entry management; cursor-paginated listing
- `assets.ts` — `/assets`: presign, finalize, upload, list, delete, plus the raw-object route
- `comments.ts` — `/comments`: comment CRUD
- `groups.ts` — `/groups`: internal group management
- `permissions.ts` — `/permissions`: path permissions, and the merged internal-plus-external group list
- `reference-options.ts` — `/reference-options`: reference field option lookup
- `resolve-references.ts` — `/resolve-references`: resolves reference IDs for the editor's live preview
- `user.ts` — `/user`: current user info
- `schema.ts` — `/schema`: collection, entry-type and ordering CRUD, admin only
- `admin.ts` — admin status and task-queue endpoints, and the single `ADMIN_ROUTES` export
- `admin-branch-health.ts` — admin branch-health scan, purge and repair-metadata endpoints; see [ARCHITECTURE.md](ARCHITECTURE.md#admin-observability-and-recovery-api)
- `github-sync.ts` — `syncSubmitPr` / `syncConvertToDraft`: direct GitHub call or queued task; see [GitHub Sync](#github-sync-direct-vs-async)

Support files:

- `routes.ts` — `buildCanopyRoutes()`, every route table plus `assetRawRoute`; the only `api/` module `http/` value-imports
- `route-builder.ts` — declarative route builder with Zod validation, guards, and codegen metadata
- `guards.ts` — the declarative guard system; see [ARCHITECTURE.md](ARCHITECTURE.md#declarative-guard-system)
- `validators.ts` — Zod schemas for branded types at API boundaries; see [Zod Validators](#zod-validators-for-api-boundaries)
- `settings-helpers.ts` — settings-branch context resolution and commit helpers
- `entries-constants.ts` — entries pagination caps, dependency-free so the editor bundle can import them
- `request-body-hash.ts` — computes the `x-amz-content-sha256` CloudFront OAC requires on a body-carrying request
- `types.ts` — `ApiContext`, `ApiRequest`, `ApiResponse`
- `index.ts` — response-type re-exports
- `client.ts` — generated API client

Handlers reach git through [service methods](#git-operations-service-methods) and paths through
`context.branchRoot` / `context.baseRoot`. Module boundaries, held by dependency-cruiser rules in
`.dependency-cruiser.mjs` under `pnpm lint:cycles`: `http/` value-imports `api/` only via
`routes.ts`; `api/` never imports `worker/`; `editor/` imports only `client.ts`, `index.ts`,
`entries-constants.ts`.

## Authentication & Permissions

### Auth Module

**Location**: `packages/canopycms/src/auth/`

- `plugin.ts` — `AuthPlugin` interface, `verifiesCredentials` marker, `assertAuthPluginAllowedForMode`
- `types.ts` — `CanopyUser`, `AuthPluginConfig`, `AuthenticationResult`, `GroupMetadata`, `PermissionGroupOption`
- `context-helpers.ts` — auth context helpers, `extractHeaders` and `isCanopyRequest`
- `caching-auth-plugin.ts` — `CachingAuthPlugin`, `AuthCacheProvider`, `TokenVerifier`: local token verify plus cached metadata
- `file-based-auth-cache.ts` — `FileBasedAuthCache` reads the EFS JSON cache; `writeAuthCacheSnapshot` writes it atomically
- `cache.ts` — server-only re-exports for the `canopycms/auth/cache` import path
- `index.ts` — public exports; cache implementations come from `canopycms/auth/cache`

A plugin must set `verifiesCredentials: true` to be usable under `mode: 'prod'`, and is asserted
before any wrapping. See
[ARCHITECTURE.md](ARCHITECTURE.md#why-is-mode-required-and-why-an-allowlist-not-a-denylist-for-auth-plugin-trust)
and [Auth Caching](ARCHITECTURE.md#auth-caching-cachingauthplugin).

### Authorization Module

**Location**: `packages/canopycms/src/authorization/` —
[AGENTS.md](packages/canopycms/src/authorization/AGENTS.md)

- `content.ts` — `checkContentAccess` and `createContentAccessChecker`, combined branch plus path access
- `branch.ts` — branch-level access: `checkBranchAccessWithDefault`, `createCheckBranchAccess`, `canPerformWorkflowAction`
- `path.ts` — path-level permissions: `checkPathAccess`, `resolveDefaultPathAccess`
- `protected-branch.ts` — `getBranchProtection`, the single source of truth for protected-base-branch policy
- `helpers.ts` — `isAdmin`, `isReviewer`, `isPrivileged`
- `types.ts` — `BranchAccessResult`, `ContentAccessResult`, `PermissionPath`
- `validation.ts` — permission-path validation against traversal
- `settings-file-store.ts` — `mutateSettingsJsonFile`, the shared cross-host layered-lock mutation helper
- `permissions/` — permissions file schema and loader, `loadPathPermissions` and `mutatePermissionsFile`
- `groups/` — groups file schema and loader, `loadInternalGroups`, `deriveInternalGroups`, `mutateGroupsFile`
- `test-utils.ts` — `unsafeAsPermissionPath` and `createTestContentAccess`

The three access layers, reserved groups, and bootstrap admins are described in
[ARCHITECTURE.md](ARCHITECTURE.md#the-permission-model).

### canopycms-auth-dev Package

**Location**: `packages/canopycms-auth-dev/src/`

- `dev-plugin.ts` — `DevAuthPlugin` with mock users and groups; never sets `verifiesCredentials`
- `dev-defaults.ts` — client-safe dev user and group defaults, no server-only imports
- `cookie-utils.ts` — dev user cookie extraction
- `jwt-verifier.ts` — `createDevTokenVerifier`, reads a user id from headers or cookies
- `cache-writer.ts` — `refreshDevCache` writes dev users and groups into the EFS-style cache
- `UserSwitcherModal.tsx` / `UserSwitcherButton.tsx` — dev user switcher UI
- `client.ts` — client component exports
- `index.ts` — public exports

### canopycms-auth-clerk Package

**Location**: `packages/canopycms-auth-clerk/src/`

- `clerk-plugin.ts` — `ClerkAuthPlugin`, real JWT verification; resolves its secret lazily on first authenticated call
- `jwt-verifier.ts` — `createClerkJwtVerifier`, networkless JWT-only verifier, deprecated in favour of `verifyTokenOnly()`
- `cache-writer.ts` — `refreshClerkCache` populates the auth cache from the Clerk API
- `client.ts` — `useClerkAuthConfig` wires Clerk's `UserButton` and sign-out into the editor
- `index.ts` — public exports

## Worker Module

**Location**: `packages/canopycms/src/worker/` —
[AGENTS.md](packages/canopycms/src/worker/AGENTS.md), which holds the module map, the one-way import
direction, and every invariant.

- `cms-worker.ts` — the `CmsWorker` class: lifecycle, worker lock, scheduling, `remote.git` provisioning, and one delegating method per cluster
- `worker-context.ts` — `WorkerContext`, the only channel between the class and the extracted clusters
- `task-runner.ts` — the task-queue cluster below `processTaskQueue`, including `PermanentTaskError`
- `git-sync.ts` — the git-sync cluster below `syncGit`: tracking, settings push, base refresh, trash sweep
- `rebase.ts` — the rebase loop, `runRebaseCycle`, and `pollMergeState`
- `history-rewrite.ts` — force-push leasing on a known pre-rebase commit; see [ARCHITECTURE.md](ARCHITECTURE.md#publishing-a-rewritten-history)
- `github-auth.ts` — which GitHub credential the worker uses, and installation-token minting
- `log.ts` — `workerLog` / `workerLogWarn` / `workerLogError`, the timestamp-and-level prefixed replacements for `console.*`

Task actions: `push-branch`, `push-and-create-pr`, `push-and-update-pr`,
`push-and-create-or-update-pr`, `convert-to-draft`, `close-pr`, `delete-remote-branch`. Rebase
behaviour and conflict tracking are in
[ARCHITECTURE.md](ARCHITECTURE.md#branch-synchronization-and-conflict-detection).

## Task Queue Module

**Location**: `packages/canopycms/src/task-queue/` — the generic queue (zero Canopy dependencies, EFS-safe) and the CMS contract on top of it.

- `task-queue.ts` — enqueue, dequeue, complete, fail, retry, recover, cleanup, query, `requeueFailedTask`, `listCorruptTaskFiles`
- `types.ts` — `Task`, `TaskStatus`, `QueueStats`, `TaskQueueLogger`, `CorruptTaskFile`
- `index.ts` — public re-exports
- `cms-task-queue.ts` — the CMS contract: `TaskAction`, `WorkerTask`, `cmsTaskQueueLogger`; the `canopycms/worker/task-queue` entrypoint
- `task-queue-config.ts` — `getTaskQueueDir`, resolves `.tasks/` per operating mode
- `worker-status.ts` — `writeWorkerStatus`, the daemon's single-writer liveness snapshot
- `README.md` — the queue's own directory layout and guarantees

See [ARCHITECTURE.md](ARCHITECTURE.md#task-queue-async-github-operations).

## CLI Module

**Location**: `packages/canopycms/src/cli/` — [AGENTS.md](packages/canopycms/src/cli/AGENTS.md)

- `cli.ts` — entrypoint: arg parsing, command routing, `isKnownAuthMode`, `passthroughArgs`
- `init.ts` — `init()`, `initDeployAws()`, `workerRunOnce()` as library functions, no CLI logic
- `templates.ts` — template generators tailored by `authProvider` and `staticBuild`
- `template-files/` — the scaffolded files themselves: config, routes, edit page, middleware, Dockerfile, workflow, CDK app
- `project-detect.ts` — best-effort detection of package manager, default branch, GitHub repo, missing CDK deps
- `project-root.ts` — `findProjectRoot`, walks up to the nearest `canopycms.config.ts`
- `sync.ts` — interactive wrapper over `sync-core.ts` for content sync between working tree and branch workspaces
- `migrate.ts` — converts a plain content tree to CanopyCMS naming conventions, idempotent
- `init-github-app.ts` — registers or verifies the GitHub App the worker authenticates as
- `github-app-manifest.ts` — App naming, `CANOPY_APP_PERMISSIONS`, and the installation read-back verdict
- `prompt.ts` — the stdin prompts, sharing one end-of-input flag
- `generate-ai-content.ts` — the AI static-content generation command

Commands: `init`, `init-deploy aws`, `init-github-app <create|verify>`, `worker run-once`,
`generate-ai-content`, `sync <push|pull|both|abort>`, `migrate`. Flags and prompts are in
[README.md](README.md#quick-start) and [docs/deploying-to-aws.md](docs/deploying-to-aws.md).

## CDK Package (canopycms-cdk)

**Location**: `packages/canopycms-cdk/`

- `src/constructs/cms-service.ts` — `CanopyCmsService`: VPC, EFS, Lambda, EC2 worker ASG, worker log group
- `src/constructs/cms-distribution.ts` — `CanopyCmsDistribution`: CloudFront, ACM certificate, Route53 records
- `src/constructs/asset-support.ts` — `AssetSupport`: asset bucket, transform Lambda, CloudFront behaviors, upload route
- `src/constructs/lambda-execution-role.ts` — `attachLambdaExecutionPolicies`, the single home for re-attaching a caller-supplied role's managed policies
- `src/worker.ts` — re-exports `CmsWorker` from core for convenience
- `src/index.ts` — public package exports, including the `assetUploadBehavior` free function
- `lambda/asset-transform/handler.ts` — the prod on-demand transform Lambda behind `/assets/t/*`
- `lambda/asset-transform/build.mjs` — builds that Lambda's code asset without Docker; see [DEVELOPING.md](DEVELOPING.md#building-the-transform-lambda-no-docker)
- `worker/index.ts` — EC2 worker entrypoint: reads secrets, wires auth-cache refresh, starts `CmsWorker`
- `worker/secrets.ts` — `getSecret`, the repo's only Secrets Manager consumer, with retries and JSON-field extraction
- `worker/credential-refresh.ts` — `createReactiveSecret`, re-reads a secret on failure behind a five-minute floor
- `worker/github-app-auth.ts` — `buildGitHubAppAuth`, the App credential from a key read once at boot
- `worker/clerk-refresh.ts` — `createClerkAuthCacheRefresher`, re-reads the key and retries once on a Clerk 401/403
- `canary/bin/canary.ts` — sandbox proving ground for `AssetSupport`; see [DEVELOPING.md](DEVELOPING.md#cdk-asset-verification-the-canary-stack)
- `test-support/test-synth.ts` — `newTestApp`, test-owned synth output; see [DEVELOPING.md](DEVELOPING.md#test-owned-cdk-synth-output-newtestapp)
- `test-support/synth-leak-guard.ts` — fails a suite that leaves `cdk.out` directories behind in the temp dir

What each construct creates, the `deploymentName` prop, and the operational detail are in
[docs/deploying-to-aws.md](docs/deploying-to-aws.md) and
[ARCHITECTURE.md](ARCHITECTURE.md#deployment-architecture).

## canopycms-next Package

**Location**: `packages/canopycms-next/src/`

- `with-canopy.ts` — `withCanopy()` Next config wrapper: package detection, transpile and alias setup, asset rewrite, dual-build page extensions, sharp tracing
- `sharp-tracing.ts` — locates sharp's libvips directories the way a bundler would, for Next's file tracing
- `adapter.ts` — `createCanopyCatchAllHandler()` and `wrapNextRequest()` for the catch-all API route
- `context-wrapper.ts` — `createNextCanopyContext()`: request-scoped `getCanopy`, `getCanopyForBuild`, phase-selecting reads, bound static helpers, `guardBuildContext`
- `static.ts` — `collectStaticParams`, `generateContentSitemap`, `entryToMetadata`
- `client.tsx` — `NextCanopyEditorPage`, reads URL search params itself
- `config.ts` — CJS-compatible `canopycms-next/config` entry re-exporting `withCanopy`
- `test-utils.ts` — `createMockAuthPlugin` and `createRejectingAuthPlugin`
- `index.ts` — package main exports

Entry points: `canopycms-next` (ESM), `canopycms-next/client` (ESM), `canopycms-next/config` (ESM
and CJS, for `next.config.ts` on Next 13/14).

### Dual-Build Support

CMS-only files use `.server.ts` / `.server.tsx`; static-export-only page variants use `.static.ts` /
`.static.tsx`. `staticBuild: false` (default) adds the `server` extensions to `pageExtensions`;
`staticBuild: true` adds the `static` ones instead, so one repo produces a full CMS build and a
static export with zero editor code.

```typescript
const isCmsBuild = process.env.CANOPY_BUILD === 'cms'
export default withCanopy(
  { output: isCmsBuild ? 'standalone' : 'export' },
  { staticBuild: !isCmsBuild },
)
```

A content route can ship both page variants for one URL. See
[ARCHITECTURE.md](ARCHITECTURE.md#why-split-a-dual-build-content-route-into-static-and-server-page-variants)
for why a single file cannot switch between them, and
[docs/deploying-to-aws.md](docs/deploying-to-aws.md#dual-build-support) for the deploy shapes.

## Assets Module

**Location**: `packages/canopycms/src/assets/` —
[AGENTS.md](packages/canopycms/src/assets/AGENTS.md)

Three files are import-chain-pure so client bundles and static builds can reach them:
`asset-prefixes.ts` and `transform-directives.ts` have zero imports, and `asset-url.ts` imports only
those two plus `utils/url-prefix.ts`. Everything else here is server-only (`node:fs`, `node:crypto`,
`sharp`, the S3 SDK) and must never be imported from client or editor code; client code needing only
types should `import type` from `types.ts`.

- `types.ts` — `AssetStore`, `AssetMeta`, `StagedUploadTarget` contracts; type-only, no runtime imports
- `asset-prefixes.ts` — `ASSET_PREFIXES`, the five bucket-prefix strings
- `keys.ts` — key, hash and slug helpers: `hashBytes`, `slugifyFilename`, `createKeyBuilders`, the per-prefix key builders
- `store-local.ts` — `LocalAssetStore`, filesystem-backed adapter mirroring the S3 prefix layout
- `store-s3.ts` — `S3AssetStore`; `uploadUrl` overrides the presigned-POST target and is not a URL prefix
- `factory.ts` — `createAssetStore`, instantiates the configured store and falls back to a local dev store
- `pipeline.ts` — `runFinalizePipeline`: sniff, hash, dimensions, SVG sanitize, real raster decode check
- `finalize.ts` — `finalizeAsset` / `finalizeStagedUpload`, store orchestration around the pipeline
- `svg-sanitizer.ts` — `sanitizeSvg` via `sanitize-html`
- `asset-src.ts` — `assetSrc(meta)`, the always-root-relative URL that gets stored in content
- `transform-directives.ts` — pure parser and formatter for transform URLs, plus the allowed-width rule
- `sharp-loader.ts` — `loadSharp()`, the package's only runtime load of `sharp`, memoized
- `transform.ts` — `applyTransform`: resize, crop, reformat, EXIF-strip
- `asset-url.ts` — `assetUrl` / `assetSrcSet`, isomorphic; `opts.baseUrl` is applied at render time only
- `index.ts` — internal server-side barrel, not a package entrypoint

Transform URL shape, the stored-versus-rendered split, and which `baseUrl` is correct per topology
are in [ARCHITECTURE.md](ARCHITECTURE.md#asset--media-system), specifically [On-Demand Image
Transforms](ARCHITECTURE.md#on-demand-image-transforms) and [Stored vs Rendered Asset
URLs](ARCHITECTURE.md#stored-vs-rendered-asset-urls). Adopter configuration is in
[README.md](README.md#media-configuration).

`assetUrl`, `assetSrcSet` and the transform types are re-exported from the package's main entry.

## Content Store

**Location**: `packages/canopycms/src/`

- `content-store.ts` — content persistence: `read`, `write`, `delete`, `renameEntry`, `resolveReferences`, the typed `ContentStoreError` codes, and the conflict errors
- `content-reader.ts` — content reading; resolves `entry:ID` body links at read time, opt-out via `resolveEntryLinks: false`
- `content-id-index.ts` — ContentId indexing, tree and global lookups, and the duplicate-ID quarantine
- `content-index-registry.ts` — in-process registry connecting branch-mutating operations to the stores they make stale
- `content-index-generation.ts` — `invalidateContentIndexesDurable` and `invalidateBranchContentCaches`, the two mutation-site entry points
- `url-path-resolver.ts` — `resolveUrlPathCandidates`, the reverse URL-to-entry rule; pure and schema-free by design
- `url-collision.ts` — `findUrlPathClaimant`, the write-boundary half of the one-URL invariant

Mutator locking, index freshness and the cross-process consistency model are in
[docs/concurrency.md](docs/concurrency.md) and
[ARCHITECTURE.md](ARCHITECTURE.md#multi-process-consistency).

Content model: collections contain entries; entry types define structure (`maxItems: 1` for
singletons); fields are text, select, reference, object, code, block, markdown and group. `group`
fields are visual-only and store their children flat. `isTitle` and `isBody` are per-schema field
flags validated at registry load. Formats are MD, MDX, JSON and YAML, the last two data-only. See
[README.md](README.md#field-types) and
[ARCHITECTURE.md](ARCHITECTURE.md#schema-driven-content-model).

## Content Tree

**Location**: `packages/canopycms/src/content-tree.ts`

Builds a tree of content nodes from schema plus filesystem, for navigation, sitemaps, breadcrumbs
and search indexes.

- `content-tree.ts` — `buildContentTree()`, `ContentTreeNode`, `defaultBuildPath`, the options and extract-meta types

`BuildContentTreeOptions` takes `rootPath`, `extract`, `filter`, `buildPath`, `sort`, `maxDepth` and
`resolveReferences` (default `false`). Without `sort`, children follow the collection's `order`
array then alphabetical; with it, the comparator fully replaces that, and runs after `extract` and
`filter`.

`ContentTreeExtractMeta` is `extract`'s second argument, carrying `kind`, `logicalPath`,
`entryType`, `format` and a collection's `indexEntry`. Supplying the optional `TEntryTypes` type
parameter discriminates `entryType` and `indexEntry` on the entry-type literal union. Entries are
fetched before `extract` runs, so `meta.indexEntry` is populated for filters that depend on index
data. The full option and type reference, with worked examples, is in
[README.md](README.md#content-tree-builder).

## Content Listing (Batch)

**Location**: `packages/canopycms/src/content-listing.ts`

- `content-listing.ts` — `listEntries()`, `listCollectionEntries()`, `sortByOrder()`

`ListEntriesItem` carries `pathSegments`, `urlPath` (index entries collapsed, round-trip safe),
`slug`, `entryPath`, `entryId`, `collectionId`, `updatedAt`, `data` and an optional `schema`.
`ListEntriesOptions` takes `extract`, `filter`, `rootPath`, `sort` and `resolveReferences` (default
`false`, unlike `read()`'s `true`). Resolution costs one index build plus one read per distinct
referenced entry per call, and does not apply path ACLs to the resolved targets. Available as a
standalone function from `canopycms/server` and as a method on `CanopyContext`; see
[README.md](README.md#listing-entries) and
[ARCHITECTURE.md](ARCHITECTURE.md#opt-in-reference-resolution).

## Configuration Module

**Location**: `packages/canopycms/src/config/`

- `types.ts` — every config type, including `ReferenceFieldConfig`, `InlineGroupFieldConfig`, `DevConfig`, `ValidateEntryHook`, `DefaultPathAccess` and `basePath`
- `schemas/config.ts` — the Zod schema for `CanopyConfig`; `mode` has no default, so omitting it fails validation
- `schemas/field.ts` — Zod schemas for field types
- `schemas/collection.ts` — Zod schemas for collections and entry types
- `schemas/permissions.ts` — Zod schemas for permissions
- `schemas/media.ts` — Zod schema for media config; each branch is `.strict()`, since the outer `.strict()` does not recurse
- `schemas/url.ts` — `uploadTargetUrlSchema` and `assetMountUrlSchema` over `isHttpUrlOrSameOriginPath`
- `flatten.ts` — schema flattening for O(1) lookups
- `validation.ts` — `ensureReferenceFieldsHaveScope`, `ensureNoGroupsInsideComplexFields`, `forEachReferenceField`
- `helpers.ts` — `defineCanopyConfig`, `composeCanopyConfig`, and the `.client()` projection
- `index.ts` — the config barrel

Every key, its default and its adopter-facing meaning are in
[README.md](README.md#definecanopyconfig-options); `deployedAs` and build mode in
[ARCHITECTURE.md](ARCHITECTURE.md#static-deployment-and-build-mode); `dev.contentSync` in
[README.md](README.md#local-development-sync); `basePath` in
[ARCHITECTURE.md](ARCHITECTURE.md#the-deployment-prefix-basepath).

## Schema Module

**Location**: `packages/canopycms/src/schema/`

- `meta-loader.ts` — loads `.collection.json` files, extracts ContentIds from directory names, rejects a `body` field name
- `resolver.ts` — `resolveSchema`, the high-level resolution API
- `schema-store.ts` — `SchemaOps`: collection, entry-type and ordering CRUD, every mutator under `withSchemaLock`
- `schema-store-types.ts` — types for schema store operations
- `types.ts` — `EntrySchemaRegistry` and `SchemaResolutionResult`
- `index.ts` — module exports

Structure comes from `.collection.json` files as the single source of truth; field schemas come from
the entry schema registry. See [ARCHITECTURE.md](ARCHITECTURE.md#schema-registry-and-meta-files) and
[README.md](README.md#schema-registry-and-references).

## Editor UI

**Location**: `packages/canopycms/src/editor/` —
[AGENTS.md](packages/canopycms/src/editor/AGENTS.md), which holds the layout, the client-bundle
boundary and the known state.

Top-level components and helpers:

- `CanopyEditor.tsx` — the provider wrapper adopters mount
- `CanopyEditorPage.tsx` — page-level shell resolving branch and entry from the URL
- `Editor.tsx` — the composition root
- `EditorPanes.tsx` — pane layout
- `EntryNavigator.tsx` — collection and entry tree, with per-collection conflict badges
- `FormRenderer.tsx` — schema-driven form dispatch, including the `group` and string-list special cases
- `BranchManager.tsx` — branch list, badges and workflow buttons; `getBranchPermissions` folds in `isProtected`
- `CommentsPanel.tsx` — comment panel
- `GroupManager.tsx` / `PermissionManager.tsx` — admin group and permission modals
- `preview-bridge.tsx` — editor-to-preview `postMessage` bridge; see [Preview Bridge](#preview-bridge)
- `editor-config.ts` — builds `EditorCollection` / `EditorEntryType` from the flat schema
- `editor-utils.ts` — `buildPreviewSrc`; see [Preview URL Construction](#preview-url-construction)
- `canopy-path.ts` — canonical `canopyPath` string form for a list of path segments
- `client-reference-resolver.ts` — resolves reference display values through the context API client
- `relative-time.ts` — `formatRelativeTime`, shared by the branch, comment and thread views
- `theme.tsx` — Mantine theme helpers
- `utils/env.ts` — `getNotificationDuration`, longer under test
- `test-setup.ts` / `setup-test-dom.ts` — vitest DOM setup for editor suites

Context providers, in `editor/context/`:

- `SWRProvider.tsx` — `SWRConfig` wrapper for the data hooks, also mounted in Storybook's preview
- `ApiClientProvider` (`ApiClientContext.tsx`) — injects the API client, built with `basePath`-prefixed `baseUrl`
- `EditorStateContext.tsx` — loading, modal and preview state
- `AssetContext.tsx` — asset base URL for rendered asset URLs
- `index.ts` — context exports

Editor code takes the API client from `useOptionalApiClient()`, never `createApiClient()`, or it
silently bypasses the provider's prefixed base.

Manager hooks, in `editor/hooks/` — see
[hooks/README.md](packages/canopycms/src/editor/hooks/README.md) for which are SWR-backed:

- `useBranchManager.tsx` — branch switching and creation; adopts the server's `defaultBranch` when nothing is pinned
- `useBranchActions.tsx` — create, submit, withdraw, merge; adopts the server-sanitized branch name after create
- `useEntryManager.ts` — entry loading and saving, and `listAllEntries` cursor following
- `useDraftManager.ts` — `localStorage` draft overlay, discard confirmation, per-entry field errors
- `useSchemaManager.ts` — schema mutations, returning result objects rather than booleans
- `useCommentSystem.ts` — comment CRUD
- `useGroupManager.ts` / `usePermissionManager.ts` — group and permission operations
- `useEditorLayout.ts` — panel layout state
- `useUserContext.tsx` / `useUserMetadata.ts` — current user and user metadata
- `useReferenceResolution.ts` — resolves reference IDs to display values
- `useEntryLinkResolution.ts` — resolves `entry:ID` patterns in preview data before `PreviewFrame`
- `useBranchesData.ts` — SWR hook, key `canopy:branches`, `GET /branches`, not branch-keyed
- `useEntriesData.ts` — SWR hook, key `canopy:entries:${branch}`, schema plus paginated entries combined
- `useCommentsData.ts` — SWR hook, key `canopy:comments:${branch}`, `GET /:branch/comments`
- `index.ts` — only the nine hooks `Editor.tsx` and `media/MediaLibraryBody.tsx` import; the rest are deep-imported

Field components, in `editor/fields/`:

- `TextField.tsx`, `NumberField.tsx`, `ToggleField.tsx`, `DateTimeField.tsx`, `SelectField.tsx` — scalar inputs
- `StringListField.tsx` / `NumberListField.tsx` — list inputs; the string one uses `TagsInput` with no comma splitting
- `MarkdownField.tsx` — MDXEditor-backed markdown and MDX editing
- `CodeField.tsx` — code and Mermaid field
- `ObjectField.tsx` — nested object field, with a Clear control for an optional filled field
- `InlineGroupField.tsx` — renders `type: 'group'` as a bordered container, transparent to the data path
- `BlockField.tsx` — block-based page building
- `ReferenceField.tsx` — reference picker
- `ImageField.tsx` — structured image field, storing the raw `AssetRecord.src`
- `MdxImageDialog.tsx` — image insert dialog for markdown bodies
- `entry-link/EntryLinkContext.tsx` — React context supplying `EntryLinkOption[]` to toolbar components
- `entry-link/InsertEntryLink.tsx` — toolbar button plus searchable entry picker, inserting `[Title](entry:ID)`
- `entry-link/index.ts` — barrel exports

Components, in `editor/components/`:

- `EditorHeader.tsx` — save, submit and the read-only protected-branch banner
- `EditorFooter.tsx` / `EditorSidebar.tsx` — chrome
- `EntryCreateModal.tsx` / `RenameEntryModal.tsx` / `ConfirmDeleteModal.tsx` — entry lifecycle dialogs
- `UserBadge.tsx` — user avatar and name
- `index.ts` — component exports

Comments UI, in `editor/comments/`:

- `BranchComments.tsx` / `EntryComments.tsx` — branch-level and entry-level threads
- `InlineCommentThread.tsx` / `ThreadCarousel.tsx` — thread rendering and navigation
- `FieldWrapper.tsx` — wraps a field so it can carry comments

Media UI, in `editor/media/`:

- `MediaLibrary.tsx` / `MediaLibraryBody.tsx` — asset browser and dropzone
- `AssetCard.tsx` — one asset's tile
- `CropStep.tsx` — crop UI over `react-easy-crop`
- `crop-math.ts` — pure conversion between the crop library's `Area` and the normalized `CropRect`
- `upload-asset.ts` — the shared presign, transport, finalize state machine every upload entry point uses
- `useAssetUpload.ts` — the React hook wrapping that state machine for a component's upload UI
- `xhr-upload.ts` — raw XHR POST for presigned uploads, the only browser API exposing upload progress
- `upload-constants.ts` — client-side upload UX caps, deliberately duplicated from the server-only pipeline

Schema editor, in `editor/schema-editor/`: `CollectionEditor.tsx`, `EntryTypeEditor.tsx`,
`index.ts`.

Permission manager, in `editor/permission-manager/`:

- `PermissionTree.tsx` / `PermissionEditor.tsx` / `PermissionLevelBadge.tsx` — the path-permission tree UI
- `GroupSelector.tsx` — group search and select, tagging each option Internal or External
- `UserSelector.tsx` — user search and select
- `hooks/usePermissionTree.ts` / `hooks/useGroupsAndUsers.ts` — tree state and group/user data
- `types.ts` / `utils.ts` / `constants.tsx` / `index.tsx` — types, helpers and entry point

Group manager, in `editor/group-manager/`:

- `InternalGroupsTab.tsx` / `ExternalGroupsTab.tsx` — the two group sources
- `GroupCard.tsx` / `GroupForm.tsx` / `MemberList.tsx` — group display and editing
- `hooks/useGroupState.ts` / `hooks/useUserSearch.ts` / `hooks/useExternalGroupSearch.ts` — state and search
- `types.ts` / `index.tsx` — types and entry point

Admin UI, in `editor/admin/` — admin-gated, and visibility is the caller's responsibility:
`Editor.tsx` renders it only for an admin, and the component does not re-check.

- `SystemHealthPanel.tsx` — Overview, Tasks and Branches tabs over the admin endpoints
- `useSystemHealth.tsx` — loads status, tasks and branch health on open, polls every 30 seconds, exposes the action helpers

Conflict indicators appear per entry (`FormRenderer`'s `conflictNotice` prop) and per collection
(`EntryNavCollection.conflictNotice`, rendered as a badge), both computed in `Editor.tsx` by
matching a `contentId` against `currentBranch.conflictFiles`.

Patterns: Mantine theme helpers from `theme.tsx`; `'use client'` on browser components; client
exports through `canopycms/client`; drafts in `localStorage` per branch and entry; no `'main'`
branch fallback. See [ARCHITECTURE.md](ARCHITECTURE.md#editor-architecture).

### Preview URL Construction

**Location**: `packages/canopycms/src/editor/editor-utils.ts`

`buildPreviewSrc(entry, context)` builds the preview iframe `src` in two parts: a module-local
`buildRawPreviewSrc` produces the unprefixed URL (a `previewSrc` override, then
`previewBaseByCollection`, then collection path plus encoded slug, plus `?branch=`), and the
exported `buildPreviewSrc` applies `joinUrlPrefix(context.basePath, …)` once at the end. See
[ARCHITECTURE.md](ARCHITECTURE.md#preview-path-identity) for why the prefix has to be applied
exactly once, uniformly.

### Preview Bridge

**Location**: `packages/canopycms/src/editor/preview-bridge.tsx` (`'use client'`, exported via
`canopycms/client`)

Message types: `canopycms:draft:update`, `canopycms:preview:focus`, `canopycms:preview:highlight`,
`canopycms:preview:ready`, `canopycms:preview:error`.

- `PreviewFrame` — editor-side iframe wrapper: pins the preview origin, posts drafts and highlights, validates inbound messages
- `useCanopyPreview` — site-side hook: draft `data`, `highlightEnabled`, `fieldProps()`, `reportError()`
- `usePreviewData` / `usePreviewHighlight` / `usePreviewFocusEmitter` — the site-side primitives it wraps
- `isTrustedEditorMessage` / `resolveMessageOrigin` — origin resolution and the inbound trust check

All site-side hooks accept an optional `{ editorOrigin }`. The trust model — listeners attach only
when framed, messages must come from the direct parent with a matching origin, and outbound posts
always target a concrete origin — is in
[ARCHITECTURE.md](ARCHITECTURE.md#preview-bridge-trust-model).

## Git & Branch Management

**Location**: `packages/canopycms/src/`

- `git-manager.ts` — the `simple-git` wrapper; also `ensureGitExcludePattern`, `GitManager.repoExistsAt` and `gitChildEnv`
- `branch-registry.ts` — branch tracking and listing over a generation-token snapshot cache; quarantines a dir whose metadata will not load
- `branch-metadata.ts` — `branch.json` persistence under layered concurrency; `baseBranch` immutable after creation; `buildMergedBranchUpdate`
- `branch-metadata-file.ts` — reading `branch.json`'s file format and nothing else; a deliberate leaf module
- `branch-workspace.ts` — `BranchWorkspaceManager`: provisions and resolves a branch's clone
- `branch-health.ts` — admin scan classifying every dir under a branches root healthy, corrupt-metadata or orphan
- `branch-schema-cache.ts` — per-branch schema caching, always file-based; exports `SCHEMA_GENERATION_RESOURCE`
- `settings-workspace.ts` — the settings branch workspace, with a rename guard before workspace initialization
- `settings-branch-utils.ts` — settings branch helpers
- `github-service.ts` — GitHub API integration: `createOrUpdatePullRequest`, `createCanopyOctokit`, the rate-limit retry predicates

Key types: `BranchContext` (branch state plus `branchRoot` / `baseRoot`), `BranchMetadata`,
`BranchPaths`, `SyncStatus` (`synced`, `pending-sync`, `sync-failed`).

Branch storage: `.canopy-meta/branch.json` (per-branch metadata) and
`.canopy-meta/comments.json` (comment threads, never committed) inside each branch root, and
`branches.json` (the registry snapshot) at the branches root. The lifecycle, the branch-identity
fields and the protected-base-branch policy are in
[ARCHITECTURE.md](ARCHITECTURE.md#branch-based-editing).

### Protected Base Branch

Enforced at five layers, all keyed off `getBranchProtection` (`authorization/protected-branch.ts`):

- API guards — `writableBranch` / `submittableBranch` return 403 before the handler runs
- Workflow permission — `canPerformWorkflowAction` drops the system-branch grant on the base branch
- Branch delete — `deleteBranchHandler` rejects deleting it, since it is the prod serving clone
- Branch listing — `BranchListItem` carries `isProtected` / `readOnly`, computed server-side per request
- Editor UI — `BranchManager.tsx` hides Submit and badges the branch; `EditorHeader.tsx` disables Save and Submit

Why it is read-only in prod but editable in dev is in
[ARCHITECTURE.md](ARCHITECTURE.md#protected-base-branch).

### Operating Mode Module

**Location**: `packages/canopycms/src/operating-mode/` —
[AGENTS.md](packages/canopycms/src/operating-mode/AGENTS.md)

- `index.ts` — public API: `OperatingMode`, the strategy factories, and `resolveDeploymentName`
- `client-safe-strategy.ts` — `ProdClientSafeStrategy` and `DevClientSafeStrategy`, no Node imports
- `client-unsafe-strategy.ts` — `ProdStrategy` and `DevStrategy`, the full server-side strategies
- `client.ts` — the client-bundle entry point, client-safe exports only
- `deployment-name.ts` — `resolveDeploymentName`, the single resolution point for `deploymentName`
- `deployment-name-fixtures.ts` — the shared fixture pinning the runtime and synth-time validity rules together
- `mode-env.ts` — the single resolution point for the operating `mode`
- `types.ts` — `ClientSafeStrategy`, `ClientUnsafeStrategy`, `RemoteUrlConfig`

What each mode does, and the `deploymentName` precedence that namespaces the settings branch, are in
[ARCHITECTURE.md](ARCHITECTURE.md#operating-modes) and [Deployment Name
Resolution](ARCHITECTURE.md#deployment-name-resolution).

### GitHub Sync (Direct vs. Async)

**Location**: `packages/canopycms/src/api/github-sync.ts`

`syncSubmitPr()` and `syncConvertToDraft()` pick the path: with a `githubService` they call GitHub
immediately; without one they enqueue a task for the EC2 worker and the branch gets `syncStatus:
'pending-sync'`. See [ARCHITECTURE.md](ARCHITECTURE.md#task-queue-async-github-operations).

### Git Operations (Service Methods)

**Location**: `packages/canopycms/src/services.ts`

- `commitFiles()` — commit specific files, for admin changes to permissions and groups
- `submitBranch()` — the full submit workflow: checkout, status, commit all, push
- `commitToSettingsBranch()` — commit to the settings branch, with an optional PR
- `getSettingsBranchRoot()` — resolve the settings workspace root, ensuring it exists

Both git-operating methods call `git.ensureAuthor()` from the configured bot name and email, and
prefer the branch's recorded `context.branch.baseBranch` over the config value. Handlers pass
`context` and read paths off it directly; `GitManager.add()` accepts `string | string[]`.

## Path Utilities Module

**Location**: `packages/canopycms/src/paths/`

- `types.ts` — the branded types plus the `ROOT_COLLECTION_ID` sentinel
- `normalize.ts` — client-safe normalization: `createLogicalPath`, `createPhysicalPath`, the `unsafeAs*` casts
- `normalize-server.ts` — the server-only normalization needing `node:path`
- `validation.ts` — security validation: `parseLogicalPath`, `parsePhysicalPath`, `parseBranchName`, `parseContentId`, `parseSlug`
- `resolve.ts` — `resolveLogicalPath`
- `branch.ts` — branch workspace path resolution; imports `node:fs` and the mode strategies, so server-only
- `branch-name.ts` — the dependency-free home of `sanitizeBranchName`, `RESERVED_SETTINGS_BRANCH_PREFIX` and `RESERVED_ROUTE_BRANCH_NAMES`
- `index.ts` — the barrel, which re-exports `branch.ts` and so is not client-safe
- `test-utils.ts` — test-only casts `unsafeAsBranchName` and `unsafeAsSlug`, not exported from the barrel

**Client-bundle boundary**: import `sanitizeBranchName` from `branch-name.ts`, never the barrel or
`branch.ts`; `pnpm lint:bundle` enforces it — see
[DEVELOPING.md](DEVELOPING.md#client-bundle-boundary-check). Which branch names are reserved, and
why the list is hand-maintained rather than derived, is in
[ARCHITECTURE.md](ARCHITECTURE.md#reserved-branch-names).

The branded types: `LogicalPath` (content-relative, no embedded IDs, used for every collection
path), `PhysicalPath` (filesystem paths that may carry embedded IDs), `BranchName`,
`SanitizedBranchName`, `ContentId` (12-character Base58), `Slug` (one lowercase path segment), and
`ROOT_COLLECTION_ID` (`'__rootcoll__'`, for the root content directory, which has no embedded ID).
See [ARCHITECTURE.md](ARCHITECTURE.md#why-branded-types-for-paths) and
[DEVELOPING.md](DEVELOPING.md#path-handling-with-branded-types) for the
parse-versus-create-versus-cast conventions.

### Zod Validators for API Boundaries

**Location**: `packages/canopycms/src/api/validators.ts`

- `branchNameSchema` → `BranchName`, git naming rules
- `logicalPathSchema` → `LogicalPath`, no traversal, not a physical path
- `contentIdSchema` → `ContentId`, 12-character Base58
- `slugSchema` → `Slug`, lowercase and hyphens, 64 characters maximum
- `permissionPathSchema` → `PermissionPath`, no traversal, from the authorization module
- `queryBooleanSchema` — boolean GET query params, accepting `'true'` / `'false'` strings

`PermissionPath` is branded in `authorization/types.ts`, not in `paths/`. In production use
`permissionPathSchema` or `parsePermissionPath`; in tests use `unsafeAsPermissionPath` from
`authorization/test-utils.ts`.

## Validation Module

**Location**: `packages/canopycms/src/validation/` —
[AGENTS.md](packages/canopycms/src/validation/AGENTS.md)

- `field-traversal.ts` — schema-aware traversal of nested data: `traverseFields`, `findFieldsByType`, the `onContainer` hook
- `entry-validator.ts` — `validateEntryData`, `findUnknownKeys` and `normalizeReferenceValues`, shared by the editor and the write boundary
- `reference-validator.ts` — reference field validation: ID format, existence, collection and entry-type constraints
- `entry-type-reference-validator.ts` — `validateReferenceEntryTypes`, checks a reference's `entryTypes` against the resolved schema
- `entry-link-validator.ts` — `validateEntryLinks`, warns on broken `entry:ID` links at save time
- `deletion-checker.ts` — referential-integrity checking before a delete
- `block-structural-keys.ts` — which keys of a block item are structure rather than content

## Entry Links

Cross-cutting feature linking between entries with `entry:CONTENT_ID` in markdown bodies —
`[Link text](entry:vh2WdhwAFiSL)`, optionally with a `#section-heading` fragment.

- `src/entry-link-resolver.ts` — core: `resolveEntryUrl()`, `resolveEntryLinksInText()`, `extractEntryLinkIds()`
- `src/validation/entry-link-validator.ts` — `validateEntryLinks()`, warnings only, never blocks a save
- `src/config/types.ts` — the `entryLinkUrl?: EntryLinkUrlResolver` callback for custom URL mapping
- `src/content-reader.ts` — resolves links in the body at read time, default on
- `src/api/content.ts` — validates on write, folding broken-link warnings into `validationWarnings`
- `src/ai/generate.ts` — resolves links before AI content generation
- `src/editor/hooks/useEntryLinkResolution.ts` — client-side resolution for preview data
- `src/editor/fields/entry-link/` — the MDXEditor toolbar button, picker modal and context

Server exports: `resolveEntryUrl`, `resolveEntryLinksInText`, `extractEntryLinkIds`,
`EntryLinkUrlResolver`. Client exports: `EntryLinkContext`, `useEntryLinkContext`,
`EntryLinkOption`, `EntryLinkContextValue`. Missing IDs become `#` dead links, anchors are
preserved, and code blocks are skipped. See
[ARCHITECTURE.md](ARCHITECTURE.md#entry-links-inline-content-links).

## Utility Module

**Location**: `packages/canopycms/src/utils/` — [AGENTS.md](packages/canopycms/src/utils/AGENTS.md)

`error.ts` is also a package subpath, `canopycms/utils/error`, for adopter and satellite use.

- `error.ts` — `getErrorMessage`, `isNodeError`, `isNotFoundError`, `isFileExistsError`, plus `sanitizeErrorMessage` and `redactCredentials`
- `debug.ts` — `createDebugLogger`
- `logger.ts` — process-scoped logger indirection for modules running in both the worker and the Lambda
- `format.ts` — content format helpers: `getFormatExtension`, `isDataOnlyFormat`
- `atomic-write.ts` — atomic writes via temp file plus rename, for NFS and EFS
- `content-serialize.ts` — `serializeYaml` / `serializeFrontmatter`, the comment-preserving content write path
- `body-field.ts` — `isBody` flag validation, including `findReservedBodyFieldName`
- `title-field.ts` — `isTitle` flag utilities: `resolveEntryTitle`, `findInvalidTitleFields`, `findTitleFieldsInLists`
- `entry-url.ts` — `computeEntryUrl`, the forward collection-plus-slug to URL rule, and the shared `isIndexSlug`
- `typed-filename.ts` — `parseTypedFilename`, the `{type}.{slug}.{id}.{ext}` grammar
- `flatten-group-fields.ts` — `flattenGroupFields`, flattens inline groups for data-layer iteration
- `git.ts` — `detectHeadBranch`, `resolveBaseBranch`, `isNonFastForwardRejection`, `isRebaseInProgress`
- `fs.ts` — `filePathExists`
- `sanitize-href.ts` — `sanitizeHref` for content, `isHttpUrlOrSameOriginPath` for config, `neutralizeImplicitOffOrigin`
- `url-prefix.ts` — `joinUrlPrefix`, the single render-time prefix join, plus `isAbsoluteUrl` and `stripTrailingSlashes`
- `async-mutex.ts` — `withLock` / `withLocks`, the FIFO per-key in-process mutex
- `occ-json-write.ts` — `writeOccJsonFile`, `withOccRetry`, `withOccFileLock`, the shared OCC JSON write layer
- `provisioning-lock.ts` — `acquireProvisioningLock` (patient) and `tryAcquireProvisioningLock` (zero-retry)
- `content-write-lock.ts` — cross-host exclusion between content writes and the worker's rebase loop

The lock layers, the OCC guarantee boundary and the per-call resolve cache are in
[docs/concurrency.md](docs/concurrency.md). The one-prefix-join rule is in
[ARCHITECTURE.md](ARCHITECTURE.md#one-prefix-join-shared); the error-handling and atomic-write
patterns are in [DEVELOPING.md](DEVELOPING.md#error-handling).

## AI Module

**Location**: `packages/canopycms/src/ai/` — [AGENTS.md](packages/canopycms/src/ai/AGENTS.md).
Read-only content serving; needs neither auth nor the editor API.

- `handler.ts` — `createAIContentHandler()`, the GET handler for AI-ready content
- `generate.ts` — `generateAIContent()` and the traversal-guarded `ctx.readSibling`
- `json-to-markdown.ts` — schema-driven entry-to-markdown conversion, Prettier-stable output
- `transform-components.ts` — `applyComponentTransforms` / `parseComponentProps`, JSX to clean markdown
- `to-plain-text.ts` — `toPlainText`, markup-free prose for a search index; keeps a paired component's children
- `strip-mdx.ts` — `stripMdxImports`, removes import and export statements from MDX bodies
- `resolve-branch.ts` — `resolveBranchRoot()`, the AI handler's branch root
- `types.ts` — `AIContentConfig`, `AIEntryMeta`, the transform hook types, and the manifest types
- `index.ts` — module exports

Transform hooks on `AIContentConfig`, all keyed by entry type: `fieldTransforms`,
`componentTransforms`, `bodyTransforms` (MD and MDX only), and `entryTransforms`, which runs once
per entry for every format and appends its returned markdown after the body and fields. Caching: the
process lifetime in prod, cleared per request in dev; `Cache-Control` is `no-cache` outside prod and
`public, max-age=60` in prod. Adopter configuration is in
[README.md](README.md#ai-content-configuration); design detail in
[ARCHITECTURE.md](ARCHITECTURE.md#ai-content-generation).

Static generation lives in `packages/canopycms/src/build/` —
[AGENTS.md](packages/canopycms/src/build/AGENTS.md):

- `generate-ai-content.ts` — `generateAIContentFiles()`, writes AI content to disk and prunes what a previous run produced
- `index.ts` — module exports

## HTTP Module

**Location**: `packages/canopycms/src/http/`

- `types.ts` — `CanopyRequest` and `CanopyResponse`
- `router.ts` — route matching and dispatch over `buildCanopyRoutes()`
- `handler.ts` — the request handler factory; rejects anonymous callers 401 before base-branch provisioning
- `index.ts` — module exports

## Test Utilities

**Location**: `packages/canopycms/src/test-utils/`

`canopycms/test-utils` is a workspace-internal subpath: present in the dev `exports` map so
satellite packages can import it, and deliberately absent from `publishConfig.exports`, since the
sources import `vitest` at module scope. See
[ARCHITECTURE.md](ARCHITECTURE.md#package-architecture); `scripts/check-esm-imports.mjs` enforces
the split.

- `api-test-helpers.ts` — mock factories: `createMockBranchContext`, `createMockUser`, `createMockServices`, `createMockApiContext`, `createMockSettingsMutation`
- `console-spy.ts` — `mockConsole()` plus the `toHaveLogged` / `toHaveWarned` / `toHaveErrored` matchers
- `git-helpers.ts` — `initTestRepo()`, a git repo with the CanopyCMS marker and user config
- `index.ts` — exports

## Example App

**Location**: `apps/example1/`

Adopter touchpoints, kept minimal:

1. `canopycms.config.ts` — configuration and content root
2. `app/api/canopycms/[...canopycms]/route.ts` — the catch-all API handler
3. `app/edit/page.tsx` — the editor component embedding
4. `app/lib/canopy.ts` — context setup: `getCanopy`, phase-selecting `readByUrlPath` / `read`, `contentStaticParams`, `getHandler`
5. `app/schemas.ts` — entry schema definitions
6. `app/ai/config.ts` and `app/ai/[...path]/route.ts` — AI content config and endpoint
7. `middleware.ts` — auth route protection
8. `next.config.mjs` — `withCanopy` from `canopycms-next/config`

Content lives under `apps/example1/content/`. `pnpm reset-sim` removes `.canopy-dev/`, the local dev
workspaces and simulated remote. See [apps/example1/AGENTS.md](apps/example1/AGENTS.md) and
[README.md](README.md#adopter-touchpoints-summary).

## Test Organization

- Unit tests — co-located in `__tests__/` (or `__test__/`) beside each module
- Integration tests — `packages/canopycms/src/__integration__/`
- Test utilities — `packages/canopycms/src/test-utils/`
- End-to-end tests — Playwright against `apps/test-app/`
- `apps/dual-build-fixture/dual-build.test.ts` — two real `next build`s plus a `next start` smoke check
- `packages/canopycms/src/build-mode-reads.integration.test.ts` — asserts zero `simple-git` calls at build time
- `packages/canopycms/src/cli/bump-version.test.ts` — drives `scripts/bump-version.mjs` as a subprocess
- `packages/canopycms/src/cli/github-app-permission-drift.test.ts` — compares observed GitHub calls against `CANOPY_APP_PERMISSIONS`, both directions
- `packages/canopycms-cdk/src/scaffold-synth.test.ts` — runs the real scaffold generator, then synthesizes and type-checks its output

Every one of these patterns, and how to run them, is in [DEVELOPING.md](DEVELOPING.md#testing).
