# Source-code and doc comments outside `.claude/future-tasks/` still link to the pre-`resolved/` path for several tasks that have since been resolved and moved

**Status:** Open. **Priority: P2.** Found 2026-08-22 during a sweep for stale in-tree claims on
`epic/adopter-request-intake` (prompted by two similar fixes in `url-collision.ts` and
`apps/example1/app/lib/canopy.ts`, done in that same session). Not previously filed.

## The defect

`pnpm lint:tasks` (`scripts/check-future-tasks.mjs`) validates links **between** files under
`.claude/future-tasks/`, catching a row still listed as open whose file moved to `resolved/`. It
does **not** scan the rest of the repository, so a source-code comment or a doc file that cites a
`.claude/future-tasks/<name>.md` path has no guard at all if that file is later resolved and moved.

A repo-wide sweep found this has already happened in several places:

- **`assets-media-system.md`** moved to `resolved/` (resolved 2026-07-22, epic PR #126) but is
  still referenced without the `resolved/` prefix in at least: `ARCHITECTURE.md:2048`,
  `ARCHITECTURE.md:2434`, `CODEBASE_GUIDE.md:513`, `packages/canopycms-cdk/canary/bin/canary.ts:5,63`,
  `packages/canopycms-cdk/lambda/asset-transform/handler.ts:35`,
  `packages/canopycms-cdk/src/constructs/asset-support.ts:234,242,452`,
  `packages/canopycms/src/config/schemas/media.ts:19`,
  `packages/canopycms/src/api/assets.ts:95,256,277`,
  `packages/canopycms/src/assets/svg-sanitizer.ts:4`, `packages/canopycms/src/assets/keys.ts:6`,
  `packages/canopycms/src/assets/factory.ts:5`,
  `packages/canopycms/src/editor/media/MediaLibrary.tsx:26` — 17 references across CDK, the assets
  pipeline, and the editor.
- Three smaller, already-fixed-in-passing instances (see the same session's commits on this
  branch): `docs/deploying-to-aws.md`, `packages/canopycms/src/editor/Editor.tsx`, and
  `apps/test-app/e2e/E2E-FAILURE-ANALYSIS.md` each cited a future-tasks path that had moved to
  `resolved/`; two of the three also carried a stale factual claim alongside the stale path (e.g.
  "the worker doesn't emit its own [timestamps] yet", no longer true) — the path going stale is
  often a signal that the surrounding prose is stale too, not just cosmetic.

Not fixed here: the 17 `assets-media-system.md` references above are spread across enough
unrelated subsystems (CDK canary script, Lambda handler, asset-support construct, media schema,
API routes, SVG sanitizer, editor media library) that fixing all of them properly means reading
each call site's surrounding context individually rather than a blind find-and-replace, which is
more than a drive-by sweep should take on alongside unrelated work.

## Suggested fix

Two independent options, not mutually exclusive:

1. **Fix the 17 `assets-media-system.md` references** (and re-sweep for any others this list
   missed) — mechanical but needs a per-site read, since some of these comments may have other
   content worth updating alongside the path (as happened with the three already-fixed instances
   above).
2. **Extend the tooling.** Either broaden `scripts/check-future-tasks.mjs` to also grep the whole
   repository (not just `.claude/future-tasks/`) for `.claude/future-tasks/<name>.md` references
   and flag any whose target now only exists under `resolved/<name>.md`, or add this as a second,
   separate check. This would have caught every instance above automatically, and — unlike the
   `pathFor`/CI-job style of stale claim, which needs judgment to detect — this specific class
   (file moved, old path still referenced) is fully mechanical to check.
