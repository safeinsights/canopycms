# AGENTS – CanopyCMS

Purpose: CanopyCMS is a schema-driven, branch-aware CMS for a team of users to edit git-backed, statically-generated sites. It stores edited state in a file system, with permanent state pushed to git. Keep adopter effort minimal: expose config + Editor + one catch-all API route, and move logic into the package whenever possible.

## What we are building

- A TypeScript package called CanopyCMS that can be added to a statically generated website to let a team of users edit the content of that website.
- The content of the host websites is drawn from MD/MDX/JSON files in the website repo. CanopyCMS provides a way to edit those files.
- Within our package, we are building an example app called "one" that shows CanopyCMS in use. Critically, this example app should only have connections to certain public aspects of the CanopyCMS code: the Editor component, a way to set the Canopy config, and one catch-all API route that the Editor calls and which fans out to internal Canopy handlers under the covers. If we need additional touchpoints between the example app and CanopyCMS, you need to get me to approve that before you add them.

## First Supported Deployment

- We will eventually be the first user of the CanopyCMS package for our own websites.
- Production ('prod' operating mode) deployed to AWS: Lambda (no internet, via Function URL) + EC2 worker (t4g.nano spot) + EFS. No NAT Gateway. See [docs/deploying-to-aws.md](docs/deploying-to-aws.md) and [ARCHITECTURE.md](ARCHITECTURE.md#deployment-architecture) for details.

## End Goals / Requirements

- Adopters of CanopyCMS have a single repo website that contains their code + content. Adopters install CanopyCMS in that repo so non-technical users can edit without touching Git.
- Schema-defined content (collections/entry types/blocks/fields) with runtime enforcement to keep data clean; MD/MDX supported (with Mermaid/code fields), plus JSON.
- Two deploy shapes:
  - (a) public build with zero editor code + separate editor-only build; the public build can be built with calls to the editor code if helpful, but after it is built it has no use of the editor code
  - (b) public build that has the editor components included; the a public user hitting the public site doesn't cause interactions with the editor API.
    Both read/write the same repo content. The static public site is rebuilt (fully or partially) on published edit.
- External auth via Clerk (pluggable in code), with roles admin/manager/editor. AuthZ enforces branch ACLs and per-path permissions (users/groups).
- Live editing UX: schema-driven forms, custom field components, block-based page building, live preview via preview bridge (draft updates + click-to-focus/highlight).
- Branch-first workflow: every edit happens on a branch backed by a filesystem clone. Creating/choosing a branch provisions/resolves a clone (prod/dev). Editors see branch-specific content everywhere.
- Git/branch UX: UI for switching/creating branches, setting branch ACLs, saving (writes files, no commit), and submitting for merge. Users do not see raw Git commands.
- Save vs publish: “Save” writes to the branch working tree only. “Publish” commits and pushes the branch via bot, opens/updates a PR, and updates branch status. Review flow supports comments/threads (stored in branch clone), request-changes unlock, and admin visibility of diffs on GitHub. Admins can see all branches; editors only see authorized branches.
- Sync with upstream: when upstream changes (other PRs), branch clones must be updated/rebased; surface conflicts to editors without destroying local edits.
- Path-based access: admins define who can edit specific files/trees; enforced on read/write.
- Assets: pluggable adapter (local for dev; S3 required soon; LFS option). Keep assets out of Git when using cloud storage.

## Operating Modes

See [ARCHITECTURE.md](ARCHITECTURE.md#operating-modes) for detailed mode behavior. Both modes must work:

- `prod`: Branch clones on persistent filesystem (e.g., EFS)
- `dev`: Full-featured local development with branching and git ops, workspaces at `.canopy-dev/content-branches/`

## Development Guidelines

See [DEVELOPING.md](DEVELOPING.md) for detailed development patterns and practices.

## Code Organization

The core package (`packages/canopycms/src/`) is organized into focused modules:

- `authorization/` - Unified access control (branch + path permissions, groups, protected-base-branch policy — `protected-branch.ts`'s `getBranchProtection()` is the single source of truth for whether a branch is the base branch, submit-blocked, and/or read-only; its sibling `getBranchWriteProtection()` adds `writeBlocked` and is what authorizes content writes and renders editor locks — `status` is required there so a missing one fails closed, since `branch.json` is parsed with no schema validation); `settings-file-store.ts` - layered cross-host locking for the settings workspace's mutable JSON files (`mutateSettingsJsonFile` wraps withLock + withOccFileLock + withOccRetry/writeOccJsonFile; permissions/groups loaders expose `mutatePermissionsFile`/`mutateGroupsFile` on top) — see [docs/concurrency.md](docs/concurrency.md)
- `config/` - Configuration types, schemas, validation
- `schema/` - Schema loading and resolution
- `paths/` - Path utilities with branded types (LogicalPath, PhysicalPath); `branch-name.ts` is the dependency-free home of `sanitizeBranchName` — client-reachable code must import it from there, never from `paths/branch.ts` or the `paths` barrel (both pull `node:fs` into the browser bundle; `pnpm lint:bundle` enforces this)
- `editor/` - React editor components and hooks
- `operating-mode/` - Operating mode strategies (prod, dev); `deployment-name.ts`'s `resolveDeploymentName()` is the single resolution point for `deploymentName` (env `CANOPYCMS_DEPLOYMENT_NAME` > `config.deploymentName` > mode default), used by both strategies' `getSettingsBranchName()` so every settings-branch-name computation agrees; `deployment-name-fixtures.ts` is the shared valid/invalid list both this package's suite and `canopycms-cdk`'s assert against, so the construct's duplicated copy of that rule goes red on drift instead of relying on a comment; `mode-env.ts`'s `resolveOperatingMode()` is the single resolution point for `mode` (env > `config.mode`), applied inside `validateCanopyConfig` — server code reads `CANOPY_MODE` at run time (stamped on the Lambda by `CanopyCmsService`) while browser code reads the build-inlined `NEXT_PUBLIC_CANOPY_MODE`, which is what lets one `canopycms.config.ts` say `dev` for `next dev`/`next build` and still deploy a prod-mode Lambda
- `api/` - API handlers (see [api/AGENTS.md](packages/canopycms/src/api/AGENTS.md) for API development guidelines)
- `middleware/` - API middleware patterns (branch access guards); see also `api/guards.ts` for declarative guard system
- `assets/` - Asset store v2 (S3/Local adapters, `factory.ts` consumes `media` config), finalize pipeline (sniff/hash/dims/SVG-sanitize, plus a real sharp decode-and-discard check for raster kinds via `pipeline.ts`'s `rasterIsDecodable` — dynamically `import()`s sharp so a missing native binary fails open (logs, skips validation) rather than throwing at pipeline.ts's own module load), and the on-demand transform engine: `transform-directives.ts` (pure/isomorphic directive parser + canonical `formatDirectives`), `transform.ts` (server-only, sharp-based `applyTransform`), `asset-url.ts` (pure/isomorphic `assetUrl`/`assetSrcSet`, exported off the package's main entry), `asset-prefixes.ts` (dependency-free bucket-prefix constants so isomorphic modules avoid `keys.ts`'s `node:crypto` import). Dev-mode `/assets/t/*` lazy-transform emulation lives in `api/assets.ts`'s raw route; both it and the prod transform Lambda forward `applyTransform`'s real rejection status (400/413/422) rather than flattening it.
- `validation/` - Validation utilities (field traversal, reference validation, entry link validation, pure isomorphic entry schema validation in `entry-validator.ts` shared by the editor and the authoritative server write boundary); `entry-type-reference-validator.ts` checks every reference field's `entryTypes` against the resolved schema's actual entry types (typo detection), wired into `branch-schema-cache.ts` before caching
- `utils/` - Shared utilities (error handling, debug, atomic file writes, title-field: `resolveEntryTitle` — client-safe (type-only dependency), exported from both `canopycms/server` and the root `canopycms` entry — plus `findInvalidTitleFields`, `findTitleFieldsInLists`); `git.ts` - dependency-light git helpers (`isNetworkRemoteUrl`, `detectHeadBranch`/`resolveBaseBranch`, `isNonFastForwardRejection` — the push-rejection classifier shared by api/branch-status.ts's 409 path and worker/cms-worker.ts's fail-fast `PermanentTaskError` path; depends on `git-manager.ts`'s `gitChildEnv` forcing `LC_ALL=C`/`LANG=C` so git's rejection text stays English); `occ-json-write.ts` - shared OCC JSON write helper (`writeOccJsonFile`, `withOccRetry`, `withOccFileLock`) adopted by comment-store.ts and branch-metadata.ts; `content-write-lock.ts` - [SYNC-C1] cross-host exclusion between content writes and the worker's rebase loop, anchored on `{branchRoot}/.canopy-meta` (deliberately a different proper-lockfile target from the provisioning lock, which keys its in-process registry by target path, not lock name). Used ASYMMETRICALLY: `ContentStore.write`/`delete`/`renameEntry` wait briefly then throw `BranchSyncingError` (a `ContentConflictError` subclass → existing 409 mapping), `rebaseActiveBranches` acquires with zero retries and skips the branch (`skippedLocked`) because it retries every cycle. Reads must never take it — see [docs/concurrency.md](docs/concurrency.md)
- `worker/` - CmsWorker daemon, task queue, deployment infrastructure; `pushBranchToGitHub` classifies a non-fast-forward push rejection (two CanopyCMS deployments colliding on one branch name) and fails fast via `PermanentTaskError` instead of burning the retry budget, recording the reason as `syncFailureReason` on branch metadata (`updateBranchMetadataOnFailure`/cleared by `updateBranchMetadata` on the next success); `pushSettingsBranches` gives the same rejection a specific warning naming the collision; `log.ts` - `workerLog`/`workerLogWarn`/`workerLogError`, which prefix every line with an ISO-8601 UTC timestamp and a level tag (stdout and stderr share one file on the prod instance, so severity is otherwise unrecoverable). INVARIANT: all worker code must log through these — the CloudWatch agent keys `multi_line_start_pattern` on that prefix, so an unprefixed line is folded into the PREVIOUS event instead of starting its own. Re-exported from `cms-worker.ts` for `canopycms-cdk/worker/index.ts` rather than adding a package entrypoint
- `ai/` - AI-ready content generation (markdown converter, engine, route handler); transforms (field/component/body) + entry transforms with traversal-guarded `readSibling` for folding in colocated sibling artifacts; `to-plain-text.ts`'s `toPlainText` (exported from `canopycms/ai`) is a _different_ transform from `strip-mdx.ts`'s `stripMdxImports` (which it uses internally as one pipeline step) — it strips ALL markup down to prose for a search index, rather than preserving JSX for AI/RAG consumption, and specifically keeps a paired custom component's inner text while dropping only its tags
- `build/` - Static build utilities (write AI content files to disk)
- `static/` - Framework-agnostic static-generation helpers (collectStaticPaths; sitemap/SEO deferred)
- `cli/` - CLI commands (`init`, `init-deploy`, `worker run-once`, `generate-ai-content`, `sync`, `migrate`); project-root discovery (`project-root.ts`); `project-detect.ts` - best-effort adopter-project detection (package manager, default branch, GitHub owner/repo, missing CDK deps) consumed by `init-deploy aws`, which now also scaffolds a full CDK app (`cdk.json`, `infrastructure/bin/app.ts`, `infrastructure/lib/cms-stack.ts`) via `templates.ts`

Top-level files (intentionally flat for discoverability): services.ts, build-canopy.ts (`createBuildCanopy`, exported from `canopycms/server` — a one-call factory mirroring `createNextCanopyContext(...)`'s own `getCanopyForBuild()` boot sequence, minus the Next.js pieces, for standalone scripts that run outside a Next.js request/build phase; build/admin only, bypasses all ACLs), content-store.ts (mutator lock keys are namespaced content-ID keys from a directory-scan pre-pass; `ContentStoreOptions.contentRootName` — default `'content'` — is the ID-index scan root and MUST be passed `config.contentRoot`; it was hardcoded, so any non-default content root built the index from a nonexistent directory and every ID-based lookup silently missed while path-based reads kept working), content-listing.ts, content-tree.ts, entry-link-resolver.ts, git-manager.ts, branch-registry.ts, branch-health.ts (admin-facing scan classifying every dir under a branches root as healthy/corrupt-metadata/orphan, incl. provisioning-lock freshness — mirrors branch-registry's own scan/skip rules so classifications never disagree; consumed by api/admin-branch-health.ts's purge/repair recovery endpoints), sync-core.ts (prompt-free content sync core), dev-content-watcher.ts (dev working-tree↔branch-clone divergence detection), resource-generation.ts (generalized on-disk generation-marker primitive: per-resource marker under `.canopy-meta/`, bump/read/isGenerationCurrent), content-index-generation.ts (thin wrapper over resource-generation.ts for the ContentId index; `invalidateContentIndexesDurable` is the entry point for content-only mutation sites, `invalidateBranchContentCaches` for bulk working-tree mutations that also bump the schema marker), etc.

See [ARCHITECTURE.md](ARCHITECTURE.md#module-structure) for detailed module documentation.

## Subdirectory Guidelines

- [packages/canopycms/src/api/AGENTS.md](packages/canopycms/src/api/AGENTS.md) - API endpoint development, client generation, middleware patterns
- [apps/example1/AGENTS.md](apps/example1/AGENTS.md) - Example app integration guidelines

## Working Agreements

- Use TypeScript/React; keep code ASCII. Avoid destructive git commands.
- Prefer using popular, maintained libraries over bespoke code.
- Primary target is Next.js websites, but will expand to others.
- Keep the styling of the host app separate from that of the CanopyCMS editing interface. CanopyCMS uses Mantine, but host apps/examples can use whatever they want.
- Keep docs current: update `BACKLOG.md`, `README.md`, and AGENTS when behavior or workflows change.
- Always honor branch modes (prod/dev) and path traversal guards. Branch metadata/registry live under `.canopy-dev/` (dev) or the configured workspace root (prod).
- Concurrency: before adding any cache, mutable JSON file, or read-modify-write against the workspace, read [docs/concurrency.md](docs/concurrency.md) (locking layers, generation markers, EFS/NFS rules, recipes) — and keep it updated when you change that behavior.
- Expose client-only React via `canopycms/client` with `use client`; keep server-only deps out of browser bundles.

## Quality Checks

See [DEVELOPING.md](DEVELOPING.md#quality-checks) for testing and typecheck requirements. `pnpm lint:bundle` (dependency-cruiser) fails when anything reachable from `canopycms/client` reaches a node built-in — see [Client-Bundle Boundary Check](DEVELOPING.md#client-bundle-boundary-check). `pnpm lint:tasks` enforces the backlog rule below — dead links between task files, rows still listed open whose file moved to `resolved/`, and orphans in both directions — see [Future-Tasks Backlog Check](DEVELOPING.md#future-tasks-backlog-check). Claude subagents are available:

- `.claude/agents/test.md` - Run tests and fix failures
- `.claude/agents/typecheck.md` - Type checking
- `.claude/agents/review.md` - Code review checklist
- `.claude/agents/debug.md` - Debugging and issue investigation
- `.claude/agents/codebase-guide.md` - Codebase navigation and understanding

## Documentation Maintenance

After making significant changes, use these agents proactively to keep docs in sync:

- `.claude/agents/docs-architecture.md` - Update ARCHITECTURE.md after architectural changes, new packages, or design decisions
- `.claude/agents/docs-developing.md` - Update DEVELOPING.md after new dev patterns, test utilities, or contributor workflows
- `.claude/agents/docs-readme.md` - Update README.md after feature changes affecting adopters
- `.claude/agents/update-codebase-guide.md` - Update codebase-guide.md after new modules, APIs, or major refactors

## Adopter Integration Constraints

Keep adopter effort minimal: only expose config + Editor + one catch-all API route. See [README.md](README.md#adopter-touchpoints-summary) for practical integration steps.
