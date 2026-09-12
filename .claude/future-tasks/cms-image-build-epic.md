# CMS editor image: base branch, sharp tracing, image architecture

**Status:** Active
**Created:** 2026-09-12
**Integration branch:** `int-202609-cms-image` (base `int-202609-a`)

| PR  | Branch                              | Status      | PR link |
| --- | ------------------------------------ | ----------- | ------- |
| 1   | `fix/build-reads-working-tree`       | Not started |         |
| 2   | `fix/sharp-lazy-load`                | Not started |         |
| 3   | `fix/sharp-standalone-tracing`       | Not started |         |
| 4   | `fix/cms-service-architecture`       | Not started |         |
| 5   | `ci/standalone-image-smoke`          | Not started |         |
| 6   | `docs/cms-image-adopter-answers`     | Not started |         |

## Context

An adopter — the first to build the CMS editor image (canopycms `0.0.67-int.88`; Next 16.1.7
Turbopack; pnpm 11) — built it from
`packages/canopycms/src/cli/template-files/Dockerfile.cms.template` for the first time. It hit a
build failure, a runtime failure and two open questions. This plan settles what is really
happening inside CanopyCMS and what CanopyCMS changes to fix it.

Everything below was checked in four places: canopycms source at the `int-202609-a` tip
(`a3fa411b`), the built editor image, the adopter's local Turbopack build output, and Next
16.1.7's own code (JS dist plus the `nft_json.rs` source at tag v16.1.7).

## What is actually happening

### 1. Build failure: base branch missing from the snapshot repo. Real, and CanopyCMS's bug

- **Not a static build.** The editor image builds with `CANOPY_BUILD=cms`, which means
  `deployedAs: 'server'` in dev mode.
- **Only static builds skip git.** `isBuildMode()` changes WHO reads (the static-deploy user, no
  ACLs) but not WHERE. Build-time reads go through `loadOrCreateBranchContext`
  (`branch-workspace.ts:173-212`), which skips git only when `isDeployedStatic` is true. Every other
  read goes on to `openOrCreateBranch` → `initializeWorkspace` → `resolveRemoteUrl` →
  `ensureLocalSimulatedRemote`. That last step throws unless the base branch exists as a local
  branch (`git-manager.ts:460-467`).
- **Why `main` doesn't work.** An explicit `defaultBaseBranch` always wins (`utils/git.ts:242-253`),
  and the template hardcodes `git init -q -b main` (`:41`).
  - `canopy-deploy-test` escaped only because it sets no `defaultBaseBranch`.
  - An adopter with `defaultBaseBranch: 'release-base'` would hit it too.
- **Same root cause as the open P1** `dev-mode-build-reads-branch-clone-not-working-tree.md`: a local
  `next build` silently reads committed state from `.canopy-dev`.
- **Docs vs code.** `README.md` and `context-wrapper.ts:199-205` already promise working-tree
  reads; only `DEVELOPING.md:1626` tells the truth.
- **`CANOPYCMS_BASE_BRANCH` isn't read by the package.** Only the worker's `.env` gets it
  (`cms-service.ts:915`). The adopter's workaround works only because its own config reads it.

### 2. Runtime 500s: sharp's libvips `.so` missing from the standalone output. Real, and CanopyCMS's to own

Two defects compound. Neither depends on architecture.

- **The tracer misses the `.so`.**
  - **Why.** Both of Next's tracers only special-case sharp's 0.34 layout. The JS nft (webpack
    builds) keys on `sharp/lib/index.js`; Turbopack has a Rust copy of the same case. sharp 0.35
    ships `dist/`, so neither case fires. The `.so`/`.dylib` is loaded through rpath and never
    `require`d, so ordinary tracing never sees it.
  - **Seen in the image.** `_not-found/page.js.nft.json` has libvips 1.3.2's `lib/index.js`,
    `package.json`, `versions.json` and the rpath symlink, but no `libvips-cpp.so.8.18.3`. Next's own
    0.34.5 → libvips 1.2.4 `.so` is present. The adopter's darwin build shows the same gap.
  - **Upstream.** vercel/next.js#97973 is still open (Next 16.2.11); see also lovell/sharp#4567 and
    #4543.
- **Every route loads sharp.**
  - **The import chain.** `assets/transform.ts:32` imports sharp statically. It's reached through
    `server.ts:259` and through `api/assets.ts:13` → `http/router.ts:10` → `canopycms/http` → the
    `canopycms-next` root.
  - **Load on import.** Turbopack emits a top-level `await` of the external, so importing that graph
    dlopens libvips.
  - **Why 404s fail.** The adopter's root layout imports `lib/canopy`, so 404s and `/favicon.ico`
    return 500 as well.
  - **Fail-open is defeated.** The static import breaks `pipeline.ts:237`'s deliberate fail-open
    import, so `DEVELOPING.md:1372` is false today.
- **Nothing guards against it.** `withCanopy` configures no tracing, no CI job builds or boots the
  image, and the repo's apps pin Next 15.5.21.

### 3. Image platform vs Lambda architecture. Explained, and a small CanopyCMS fix

- **What decides the image's architecture.** The target platform of the docker build. Everything
  native inside comes from the install inside the build container: the Node binary, git, and sharp
  with libvips.
- **CDK already derives the platform from the architecture.** `DockerImageCode.fromImageAsset(...)`
  binds its platform when the function passes one (`_bind(architecture)`).
  - `CanopyCmsService` passes `props.architecture` (`cms-service.ts:727`), which is `undefined` by
    default (documented as X86_64).
  - So no platform is set, and Docker builds for whatever machine runs the build: an M-series Mac
    gives arm64, `ubuntu-latest` gives amd64.
  - A mismatch fails only at invoke, after a green deploy.
- **Inconsistent defaults.** The worker (t4g), the transform Lambda and `cms-stack.ts.template` are
  arm64. The template sets `platform` explicitly.
- **Unproven CI claim.** `deploy-cms.yml.template:101` builds arm64 on x86 `ubuntu-latest` with no
  QEMU step, so "works on an x86 CI runner" is unproven.

### Smaller items

- **Runtime Clerk publishable key.**
  - **Provider side is proven.** `apps/dual-build-fixture/app/edit/layout.server.tsx:23` reads the key
    at runtime.
  - **The only recorded blocker doesn't apply to the adopter.** It's `clerkMiddleware`, whose
    `secretKey` assertion is recorded in `clerk-middleware-runtime-key-unverified.md` and
    `deploying-to-aws.md:119`. The adopter doesn't adopt it, and `CachingAuthPlugin` verifies with
    `jwtKey` alone.
  - **Verdict.** A shape to support explicitly, under that condition. A live deploy by the first
    adopter is the proof.
- **`NEXT_PUBLIC_CANOPY_MODE`.**
  - **Browser mode comes from one variable.** The browser takes mode only from it
    (`mode-env.ts:67-74`).
  - **The adopter's two renders disagree.** Its browser-side mode is always `dev`, while the server
    render of the same `'use client'` page resolves `prod`.
  - **Where the client uses mode.**
    - It selects auth in the scaffold's edit page (`edit-page.tsx.template:14-17`).
    - The editor's capability checks are identical in both modes.
    - "PR UI hidden in dev" (`deploying-to-aws.md:218-219`) has no client-side check, so that doc
      claim is wrong.

### Corrections to the adopter's report

- **pnpm isn't the cause** of the missing `.so`; the tracers' 0.34-only special case is. The guess
  that Next handles its own sharp specially was right.
- **Where build content comes from.** The adopter's Dockerfile comment says the build prerenders
  "from that working tree / the synthesized git snapshot". Today it's a `.canopy-dev` branch clone
  seeded from the snapshot commit.

## Decisions

**JP, 2026-09-12:**

1. **`next build` reads the working tree** for every build-time read, in every mode, as the static
   path already does.
   - **CI:** builds exactly the checked-out commit.
   - **Local:** builds what is on disk, including uncommitted files, but not unsynced local editor
     saves (those stay in `.canopy-dev` until `sync pull`).
2. **The construct pairs platform with architecture.**
   - **Refined: no new API needed.** `CanopyCmsService` always passes a resolved architecture,
     defaulting to `ARM_64`, so CDK sets the image platform itself.
   - **Remaining risk.** An adopter who passes an explicit `platform` still overrides it, so docs and
     the template say to omit it. Nothing can validate that at synth, because CDK keeps the props
     private.
3. **CI image-build coverage is included.**

**Where a deploy can build an arm64 image:**

| Where `cdk deploy` builds | Result for an arm64 target |
| --- | --- |
| Apple Silicon Mac | Native, fast |
| GitHub `ubuntu-24.04-arm` | Native. Standard runner in private repos since 2026-01-29, with 2 vCPU |
| GitHub `ubuntu-latest` (x86) | Needs QEMU (`docker/setup-qemu-action`). Emulated `next build` is slow, with segfault reports on 24.04 |

The asset hash covers the build inputs, including the platform, not the machine building. The same
inputs give the same image identity whether built on a Mac or in CI.

**Defaults I picked. Say if you disagree:**

- **An explicit `branch` option at build is ignored**, matching the static path.
- **Keep the "don't set `CANOPY_MODE=prod` for `next build`" guidance**; correct only its reason.
- **Remove example1's CI `git checkout -B main` step** (`ci.yml:566-587`). A green build on a
  detached HEAD then proves the fix.
- **The template's builder stage sets `ENV CANOPY_BUILD_MODE=true`.**
  - **Why.** Any content-reading script run outside `next build` in `{{DOCKER_BUILD}}` then also
    reads the working tree now that the snapshot repo is gone.
  - **Scope.** Builder only; it widens build mode (no ACLs) to those scripts.
  - **Alternative.** Leave it out, and such scripts fail loudly with "not a git repository".
- **`deploy-cms.yml.template` runs on `ubuntu-24.04-arm`**, not QEMU.
- **The sharp tracing include covers every route (`'/**'`) and every non-export build.** Next ≥15
  only, matching `canopycms-next`'s peer range; confirm the range in PR 3.
- **No libvips check in the Dockerfile template.** The CI smoke test and a `withCanopy` warning
  cover it instead.
- **An `imageProcessing` availability field in admin status becomes a future task.** For now, the
  loud signal is a one-time error log.

## CanopyCMS work: PRs into a new integration branch

**Branches.**
- **A new integration branch.** `int-202609-cms-image`, cut from `origin/int-202609-a`, so this work
  doesn't collide with the other PR series landing on `int-202609-a`.
- **PR targets.** Every PR below targets that branch, never `int-202609-a` or `main`.
- **PR branches.** Each is cut explicitly from `origin/int-202609-cms-image`, because a fresh worktree
  can start from `main`. No "claude" in any branch name.
- **The way back.** When all six PRs have merged, one integration PR goes from
  `int-202609-cms-image` back to `int-202609-a` (see Execution).

### PR 1: build-time reads come from the working tree (`fix/build-reads-working-tree`)

**Code**

- **`build-mode.ts`: add a predicate.**
  `readsFromCheckout(config) = isDeployedStatic(config) || isBuildMode()`. Its JSDoc says this
  predicate decides WHERE content is read; the existing checks decide WHO.
- **Where to use it.**
  - The functional fix is at `branch-workspace.ts:182`, which covers `context.ts:348`,
    `content-reader.ts:154` and `ai/resolve-branch.ts:37`.
  - Hygiene, same predicate:
    - `content-reader.ts:136`
    - `ai/resolve-branch.ts:24`
    - `services.ts:61`, `:242`, `:540` (no `detectHeadBranch` at build)
- **Why `isBuildMode()` is reliable.** It's true only under `NEXT_PHASE=phase-production-build`,
  which Next sets before both page-data collection and prerender workers. Nothing else sets it.
  Re-check on any Next major.

**Tests**

- `branch-workspace.test.ts`: a build-mode twin of the static test, run in both dev and prod with
  `deployedAs: 'server'`.
- **Regression test for this bug:**
  - Repo created with `git init -b main`, config `defaultBaseBranch: 'release-base'`.
  - Without the build env it rejects with the adopter's message. Under the build env it returns the
    cwd context and creates no `.canopy-dev`.
- **New `build-mode-reads.integration.test.ts`:**
  - A non-git temp project, with `simple-git` wrapped in a call counter.
  - `listEntries`, `buildContentTree`, `read` and `readByUrlPath` (including `{ branch }`) all return
    working-tree content, with zero git calls.
- `services.test.ts`: build-mode twins asserting no `detectHeadBranch` call.
- `ai/__tests__/resolve-branch.test.ts`: fix its `build-mode` mock.
- `apps/example1/build-verify.test.ts`: if `.canopy-dev` was absent before the build, it stays
  absent.

**Template**

- Delete the snapshot step (`:34-44`) and the builder's git install.
- Rewrite `:22-33`.
- Add `ENV CANOPY_BUILD_MODE=true`.
- Keep git and `safe.directory` in the runner stage.
- Update `cli/init.test.ts:486-498` and `:520-528`.

**CI and docs**

- Remove example1's HEAD-attach step.
- **Code comments:**
  - `context.ts:10-16`
  - `context-wrapper.ts:356-361`
  - `api/branch.ts:223-224`
  - `mode-env.ts:6-13` and `:30-31`
  - the provisioning-lock comments that cite "parallel build workers": reword them, keep the lock
- **Docs:**
  - `DEVELOPING.md:1624-1628`
  - `ARCHITECTURE.md:1306-1323`
  - `README.md:1655`
  - `deploying-to-aws.md:186-196`
  - `operating-mode/AGENTS.md:17`
  - `docs/concurrency.md:191`

**Backlog**

- Resolve `dev-mode-build-reads-branch-clone-not-working-tree.md`.
- File `build-canopy-scripts-outside-next-build.md`: `createBuildCanopy` and the
  `generate-ai-content` CLI still read the clone in `deployedAs: 'server'`.
- File the suspected `dev-content-watcher.ts:164-170` `sourceRoot` double-join (verify it first).

### PR 2: sharp loads lazily (`fix/sharp-lazy-load`)

**New `assets/sharp-loader.ts`.**
- `loadSharp()` memoizes `import('sharp')`, including a rejection: a failed dlopen can't recover
  in-process.
- On failure it logs one error through the repo logger with `getErrorMessage`.

**`transform.ts`.**
- **Imports.** Keep only `import type`. The helper types become `ReturnType<Sharp>`.
- **In `applyTransform`.** The unsupported-extension 400 check comes first. Then `await loadSharp()`
  runs outside the `try`, so a load failure is a 500 and never the 422 that means undecodable input.

**`pipeline.ts:235-243`** uses `loadSharp()`.

**Lint guard.** `no-restricted-imports` blocks any static import of `sharp` in `packages/canopycms/src`
outside tests, with `allowTypeImports: true`.

**Tests**

- New `transform.sharp-unavailable.test.ts`, with sharp mocked to throw:
  - importing the module resolves;
  - the 400 path still works;
  - a raster transform rejects;
  - exactly one error is logged across two calls.
- New `server.sharp-unavailable.test.ts`: `await import('./server')` resolves. This is the test that
  would have caught the adopter's bug.
- Existing `pipeline.sharp-unavailable.test.ts` and `transform.test.ts` stay green.

**Docs.**
- Update `DEVELOPING.md:1372`, `assets/AGENTS.md:11`, `pipeline.ts:9-11`, the `transform.ts` header
  and `CODEBASE_GUIDE.md`.
- File `admin-status-image-processing-availability.md`.

### PR 3: `withCanopy` traces libvips into standalone output (`fix/sharp-standalone-tracing`)

**New `canopycms-next/src/sharp-tracing.ts`** (bundled into `dist/config.*`). It finds the libvips
directory by resolving packages, never by globbing a package manager's layout.

1. **Resolve sharp.** From `projectDir`, resolve `canopycms`, then its `sharp`, following realpaths.
   Walk up to sharp's `package.json`, since sharp exports no `./package.json`.
2. **Resolve libvips.** For each `@img/sharp-libvips-*` optional dependency, resolve
   `<name>/package` from sharp's directory, follow its realpath, and use its `lib/` directory. Skip
   packages that aren't installed.
3. **Stay inside the tracing root.**
   - The root is `outputFileTracingRoot`, else `turbopack.root`, else the directory of the outermost
     lockfile (mirroring Next's `find-root`).
   - Refuse directories outside it: Turbopack fails the build on a `../` past the root.
   - Refuse paths containing glob metacharacters, commas included.
4. **Emit.** A project-relative `<rel>/**/*` for each directory found.

**In `withCanopy`.**
- **When.** Skip when `output === 'export'` or `staticBuild` is set.
- **Merge.** Add the includes to `outputFileTracingIncludes['/**']` with dedupe, never mutating the
  adopter's config.
- **Found nothing?** With `output === 'standalone'`, warn once per process with the manual snippet.
- **Comment.** Link vercel/next.js#97973 and sharp's `lib/` → `dist/` move.

**Tests.**
- `sharp-tracing.test.ts` over real temp-dir fixtures with symlinks: pnpm, npm hoisted, npm
  nested, monorepo root, outside the root, not installed, metacharacters.
- Merge semantics in `with-canopy.test.ts`.

**Docs.**
- `deploying-to-aws.md` gets the manual snippet for adopters not using `withCanopy`.
- File a P3 `upstream-next-sharp-tracing-recheck.md` to re-check on each Next upgrade.

**PR 3 merges after PR 2.** It verifies the "PR 3 only" image on its own. Once PR 2 has merged, it
rebases onto the integration branch and verifies the "both" image before merging.

### PR 4: always pass the resolved architecture, arm64 by default (`fix/cms-service-architecture`)

- **`cms-service.ts`.**
  - `const architecture = props.architecture ?? lambda.Architecture.ARM_64`, always passed to the
    function.
  - Rewrite the doc at `:236-243`: "omit `platform` on `fromImageAsset`; a `fromEcr` image must
    match".
- **Tests.**
  - Update `cms-deploy.test.ts:1088-1113`.
  - Add asset-manifest tests: `fromImageAsset` without `platform` gives `linux/arm64` by default and
    `linux/amd64` with `X86_64`.
- **`cms-stack.ts.template` and `examples/aws-deployment/.../cms-stack.ts`.**
  - Drop `platform` and its import; keep `architecture` as the single source.
  - The example also gains its missing `NEXT_PUBLIC_CANOPY_MODE: 'prod'` build argument.
- **`deploy-cms.yml.template` and `examples/aws-deployment`'s workflow** run on `ubuntu-24.04-arm`.
  Confirm Docker is present on that image.
- **`deploying-to-aws.md`: a short "Where the image is built" section** covering the table above and
  what the target vs the build machine decides. Also fix `:10` and `:378-383`.

### PR 5: CI image smoke test (`ci/standalone-image-smoke`)

Implements `deploy-image-build-smoke-test.md`. Its chip is spawned only after PRs 1–4 have merged.

- **The job.** `standalone-image` in `ci.yml`, gated with `dorny/paths-filter` like the dual-build
  job. It runs when the template files, `with-canopy`/`sharp-tracing`, `assets/**`,
  `branch-workspace`/`build-mode`, the package manifests, the lockfile or `ci.yml` change.
- **Matrix.** `pm: [npm, pnpm]` × Next `16.1.x` on `ubuntu-latest` (amd64; both defects are
  architecture-independent). Optionally add a Next `15.5.21` webpack leg and an `ubuntu-24.04-arm`
  leg.
- **Steps.**
  1. `pnpm pack` the packages.
  2. Scaffold a temp app outside the workspace with `canopycms init` + `init-deploy aws`. Give it a
     non-`main` `defaultBaseBranch` (e.g. `release-base`), a dynamic route and local-store `media`
     config.
  3. `docker build`, then run the container.
- **Assertions.**
  - `libvips-cpp.*` is present under `/app`.
  - sharp loads through `.next/node_modules/sharp-*`.
  - An on-demand 404 path, `/favicon.ico` and `/api/canopycms/whoami/` all return non-500.
  - Upload, finalize and a transform request succeed.
  - `ERR_DLOPEN_FAILED` appears in the logs zero times.
- **Red before green.** Show the job fails against (a) the old template and (b) PR 3's include
  removed. Restore by copying from the scratchpad, not with `git checkout --`.
- **Expected surprise.** The pnpm fixture probably needs `allowBuilds` in `pnpm-workspace.yaml`,
  which pnpm 11 hard-errors without. If the template's pnpm path needs it too, fix the template in
  this PR.
- **Backlog.** Resolve the task and move its index rows. The Yarn decision stays in its own task.

### PR 6: adopter-answer docs (`docs/cms-image-adopter-answers`)

- **Runtime publishable key as a supported shape.** `deploying-to-aws.md:119`: `<ClerkProvider
  publishableKey>` from a runtime env var, one image for every tier, supported provided
  `clerkMiddleware` is not adopted.
  - The comment in `middleware-clerk.ts.template` says the middleware is optional and costs a secret
    key on the Lambda.
  - Update `clerk-middleware-runtime-key-unverified.md`.
- **What an adopter needs for mode.**
  - `NEXT_PUBLIC_CANOPY_MODE=prod` is a constant build value, safe for one image, and never read by
    server-side build reads.
  - Never derive the config literal from it.
  - Remove the false "PR UI hidden in dev" claim.
- **Backlog.** Update `pr229-review-followups.md` §1.

## Execution

**Manager session**

The manager session keeps its context for coordination: sequencing the chips, reading their
reports, and raising the calls that need a decision from you. Hands-on work goes to subagents
(Sonnet for mechanical steps, Opus 5 where judgment is needed), and the manager reads only their
conclusions.

Chips receive the manager session's ID in their prompt, and report back to it with `send_message`
when they open their PR, when they hit a decision that needs a call, and when they merge.

1. **Set up (one Sonnet subagent).**
   - Create `int-202609-cms-image` from `origin/int-202609-a`.
   - Commit this plan to it as `.claude/future-tasks/cms-image-build-epic.md`, with an index row, so
     every chip reads the same spec from its own worktree.
   - Push.
2. **Spawn the chips.**
   - PRs 1, 2, 3, 4 and 6 at once. PR 5 once PRs 1–4 have reported merged.
   - You decide when to start each; PR 1 and PR 3 are the heaviest.
3. **Integration PR, once all six have merged.**
   - Open a PR from `int-202609-cms-image` to `int-202609-a`.
   - Run `/review-rounds`, then `/claim-check` on it. Subagents do the reading and the fixing; the
     manager reads the verdicts.
   - Wait for checks. That PR is yours to merge.
4. **After it merges (subagents).** Confirm the prerelease, run the end-to-end check, then write the
   adopter hand-off from what actually shipped.

**Each chip (one per PR)**

- **Model.** Runs on Opus 5; the prompt says so, in case the chip doesn't start on Opus 5 by default.
  It may delegate well-specified subwork (test scaffolding, doc agents, mechanical edits) to Sonnet
  subagents. The heavy-worker cap applies within the chip.
- **Prompt.** Self-contained: its PR section inline, the findings it depends on, its branch and base,
  a pointer to `cms-image-build-epic.md`, and the manager session's ID.
- **Worktree.** Its own, on its PR branch cut from `origin/int-202609-cms-image`.
- **Design review first (PR 1 and PR 3 only).** Before implementing, a read-only Fable adversarial
  review of that PR's design section, with findings folded in.
- **While implementing.**
  - Tests, plus the CLAUDE.md finish steps: prettier; `pnpm lint`, and `lint:bundle` when it touches
    `src/`; doc agents; net doc line deltas.
  - Any out-of-scope finding is filed as a future-task file with an index row.
  - Docker and Next builds run with the sandbox disabled.
- **When the chip thinks it is done.**
  1. Open the PR against `int-202609-cms-image`.
  2. Run `/review-rounds`, then `/claim-check`, and fix what they find.
  3. Rebase onto the integration branch. The chip that merges later resolves doc conflicts in
     `DEVELOPING.md` or `deploying-to-aws.md`.
  4. Wait with `wait-for-pr-checks`, then self-merge into the integration branch.
  5. Report to the manager (`send_message` to the session ID) with the merge SHA and anything left
     open.

**Dependencies**

- PR 3 merges after PR 2.
- PR 5's chip starts after PRs 1–4 have merged.
- PRs 1, 4 and 6 are independent.

## Verification

- **PR 1:**
  - The unit and integration tests, and `pnpm test` in `packages/canopycms`.
  - Example1 CI green on a detached HEAD.
  - A local image build of a Next 16 pnpm scaffold with `defaultBaseBranch: 'release-base'` and no
    git in the builder.
- **PRs 2 and 3 together**, as four local `linux/arm64` images of a scratch `git clone --local` of
  an adopter's repo, with patched `pnpm pack` tarballs in `vendor/`: {baseline, PR 3 only, PR 2
  only, both}.

  | Image | Routes | sharp load through `.next/node_modules/sharp-*` | Asset operations |
  | --- | --- | --- | --- |
  | Baseline | 500 | fails | — |
  | PR 3 only | 200/404 | passes | — |
  | PR 2 only | 200/404 | fails | transforms 500; the upload skips validation and logs one error |
  | Both | 200/404 | passes | an upload, finalize and transform succeed (in the PR 5 fixture, which has `media` config) |

  Also check for `libvips-cpp.so.8.18.3` in the builder's nft and under `/app`, and that
  `ERR_DLOPEN_FAILED` appears zero times.
- **PR 4:** asset-manifest synth tests, and a scaffold `cdk synth` showing `linux/arm64`.
- **PR 5:** green on its PR, and demonstrably red against each reverted fix.
- **Integration PR to `int-202609-a`:** `/review-rounds`, then `/claim-check`, and all checks green.
- **End to end, before the adopter hand-off:** after the prerelease, rebuild the adopter's image
  flow in the scratch clone from the published tarballs. `/`, a 404 and `/api/canopycms/whoami/`
  must return non-500.
