# [P2] Dev content watcher is silently off for a relative `sourceRoot`

**Priority:** P2 — a dev-only warning never fires for monorepo adopters; no data risk
**Found:** 2026-09-12, by the adversarial design review for
[cms-image-build-epic.md](resolved/cms-image-build-epic.md) PR 1. Verified by reading the code; not yet
reproduced against a running dev server.

## Problem

`config.sourceRoot` is **git-root-relative**. `GitManager`'s remote resolution documents it as
"relative to git root" and applies it as `path.resolve(gitRoot, sourceRoot)`
(`packages/canopycms/src/git-manager.ts`, `resolveRemoteUrl`). `apps/example1` sets
`sourceRoot: 'apps/example1'`, and its `next dev` runs with the app directory as cwd.

`startDevContentWatcher` (`packages/canopycms/src/dev-content-watcher.ts`) instead passes it
verbatim to `DevStrategy.getContentRoot(contentRoot, sourceRoot)`
(`operating-mode/client-unsafe-strategy.ts`: `path.resolve(sourceRoot ?? process.cwd(), contentRoot)`),
which resolves a relative path against **cwd**:

- cwd `<repo>/apps/example1`, `sourceRoot: 'apps/example1'`, `contentRoot: 'content'`
  → `<repo>/apps/example1/apps/example1/content`
- `existsSync` is false, so the watcher returns its no-op disposer without logging anything.

The branch side mis-joins the same way: `getContentBranchRoot(branch, sourceRoot)` resolves
`.canopy-dev/content-branches/<branch>` from that same cwd-relative `sourceRoot`, while the dev
server provisions clones through `ensureBranchRoot`, which `openOrCreateBranch` calls without a
`sourceRoot` at all.

So the divergence warning that the default `dev.contentSync: 'warn'` promises never fires for an
adopter whose `sourceRoot` is relative, which is every monorepo adopter.
`dev-content-watcher.test.ts` passes an absolute `sourceRoot: root`, so it cannot see this.

The same `path.resolve(process.cwd(), sourceRoot)` shape appears in `branch-workspace.ts`
(`resolveBaseBranch`'s `detectFrom`) and `git-manager.ts` (`initializeWorkspace`). There it is
masked rather than harmless: HEAD detection on a missing directory falls back to the default
base branch, which `createCanopyServices` has usually already baked into config. Check both in
the same pass.

## Suggested fix

Resolve `sourceRoot` against the git root in one shared helper, the way `resolveRemoteUrl`
already does, and use it for both of the watcher's joins and for the two masked call sites. Add
a watcher test with a relative `sourceRoot` and a cwd that is not the git root, and confirm it
fails before the fix.

## Verify

Run example1's `next dev`, edit a file under `apps/example1/content/` without syncing, and make a
content request: today no divergence warning appears; after the fix one does.
