# Future Tasks Index

Priority levels:

- **P0** — Blocks production launch; data loss, security, or crash
- **P1** — Significant correctness issue under normal use; important quality debt
- **P2** — Useful enhancement, moderate quality improvement, or feature work
- **P3** — Nice-to-have; low-impact

---

## P0 — Must fix before multi-editor prod launch

None currently open.

---

## P1 — High-impact correctness or quality

| File                                                                         | Summary                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [editor-async-patterns.md](editor-async-patterns.md)                         | `ReferenceField` refetches on every render; `useReferenceResolution` and `loadEntry` have no cancellation for stale responses |
| [stale-draft-prevents-content-load.md](stale-draft-prevents-content-load.md) | Stale localStorage draft silently shadows fresh server content (discard affordances exist now, but no staleness detection/warning — verified 2026-07-24) |
| [swr.md](swr.md)                                                             | Multiple independent `useEffect` hooks fire duplicate API calls on initial editor load; SWR would deduplicate                 |
| [editor-state-context-migration.md](editor-state-context-migration.md)       | Complete migration of `Editor.tsx` inline state to `EditorStateContext` (context exists; Editor.tsx still holds 26 inline `useState` — verified 2026-07-24) |
| [post-merge-sync-gaps.md](post-merge-sync-gaps.md)                           | Live-deploy finding: after a content PR merges, the branch stays "submitted" (no auto merge-detection) and the editor's base-branch (main) workspace clone is stale, so editors see old content and fork new branches from stale main |
| [worker-cloudwatch-logs.md](worker-cloudwatch-logs.md)                       | Worker CloudWatch log shipping — flagged REQUIRED by the deployment-test epic: the CmsWorker EC2 box is unobservable (no SSM for the SSO role, no shipped logs), blocking prod debuggability |

---

## P2 — Enhancements and feature work

| File                                                                               | Summary                                                                                                                    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [canopycms-pack-needs-prepack.md](canopycms-pack-needs-prepack.md)                 | `canopycms` and sibling packages need a `prepack` build guard (like canopycms-cdk PR #128) so `pnpm pack` never ships a stale `dist/` |
| [finalize-transform-decoder-mismatch.md](finalize-transform-decoder-mismatch.md)   | Upload `finalize` (lightweight sniffer, no sharp) accepts raster images the transform Lambda's libvips later rejects (422) → asset uploads OK but renders broken everywhere with no user feedback |
| [asset-review-followups.md](asset-review-followups.md)                             | Deferred non-blocking items from PR #126 review: upload abort/AbortController, post-delete blob GC, altOptional-omitted edge, + nits (finalize byte-cap verified done 2026-07-24) |
| [docs-site-assets-wiring.md](docs-site-assets-wiring.md)                           | DEFERRED until docs-site prod deploy lands: wire assets into docs-site-proto (AssetSupport BYO-bucket, behaviors, media config) + the update-distribution.ts stamps-every-OriginPath fix that MUST ride along |
| [adopter-image-field-migration.md](adopter-image-field-migration.md)               | READY (own prompt): migrate ../website + ../docs-site-proto string image paths to the structured image field + optimize the website's 1.5-3.3MB offenders |
| [schema-store-rmw-protection.md](schema-store-rmw-protection.md)                   | `.collection.json` mutations in schema/schema-store.ts are read-modify-write with `withLock` covering only the final write; no OCC/lockfile — concurrent admin schema edits can lose updates cross-process |
| [settings-file-occ-cross-host.md](settings-file-occ-cross-host.md)                 | CONFIRMED (2026-07-24 audit): permissions.json/groups.json `contentVersion` CAS has a cross-process TOCTOU window (unlocked load→compare→atomicWriteFile); apply the layered lock pattern (`writeOccJsonFile`) |
| [validate-entry-type-names.md](validate-entry-type-names.md)                       | Reference fields can specify non-existent `entryType` names; add config-time validation                                    |
| [rename-collection-name-to-key.md](rename-collection-name-to-key.md)               | Rename `collection.name` → `collection.key` to clarify its machine-readable role                                           |
| [user-metadata-optimization.md](user-metadata-optimization.md)                     | Batch user metadata endpoint + possible API namespace reorganization                                                       |
| [user-metadata-caching.md](user-metadata-caching.md)                               | Client/server caching with TTL for user metadata to reduce redundant API calls                                             |
| [readbyurlpath-entry-type.md](readbyurlpath-entry-type.md)                         | Return `entryType` from `readByUrlPath` to enable content-type-based routing                                               |
| [readbyurlpath-collection-url-support.md](readbyurlpath-collection-url-support.md) | Add `urlPath` field to `listEntries` and root path handling in `readByUrlPath`                                             |
| [link-by-entry.md](link-by-entry.md)                                               | Stable entry-ID links that resolve to current URL paths at build time                                                      |
| [url-mapping-system.md](url-mapping-system.md)                                     | Flexible URL-to-content mapping: date-based URLs, custom slug transforms, multiple patterns per collection                 |
| [isurlpath-field-marker.md](isurlpath-field-marker.md)                             | SHELVED: per-entry `isUrlPath` marker to route entries by a field value (vanity / multi-segment / decoupled URLs). Not needed yet — root-collection restructure covers single-segment slug URLs. Full design captured. |
| [list-permission-level.md](list-permission-level.md)                               | New "list" permission level: see content exists without read/edit access                                                   |
| [dev-settings-per-branch.md](dev-settings-per-branch.md)                           | Dev-mode settings (groups, permissions) isolated per git branch                                                            |
| [partner-data-in-subcollections.md](partner-data-in-subcollections.md)             | Move partner YAML into partner sub-collection directories                                                                  |
| [split-large-files.md](split-large-files.md)                                       | Extract wire-format conversion, reference resolution, and index logic into focused modules                                 |
| [deletion-checker-refactor.md](deletion-checker-refactor.md)                       | Refactor `DeletionChecker` to use `traverseFields` — the duplicated block-shape logic bit again (fixed a third time in PR #88); the duplication itself remains |
| [dual-build-ci.md](dual-build-ci.md)                                               | CI fixture running both deploy shapes (`CANOPY_BUILD` static + editor builds) — withCanopy/deployedAs regressions currently uncaught |
| [test-gap-backfill.md](test-gap-backfill.md)                                       | Targeted tests for top-risk untested modules (route-builder, meta-loader, operating-mode strategies, authz loaders, settings-workspace, …) |
| [adopt-changesets.md](adopt-changesets.md)                                         | Replace auto-patch publishing with changesets for deliberate semantic versioning                                           |
| [audit-logging.md](audit-logging.md)                                               | Audit trail for permission/group changes with query API and notifications                                                  |
| [init-respects-adopter-conventions.md](init-respects-adopter-conventions.md)       | `canopycms init` should detect adopter's Prettier config + package manager and match them in generated files + next-steps |
| [static-export-sitemap.md](static-export-sitemap.md)                               | Static-export sitemap helper: enumerate published entries + singletons → `sitemap.xml` (framework-agnostic core + Next adapter) |
| [static-export-seo-metadata.md](static-export-seo-metadata.md)                     | Static-export SEO metadata helper + recommended SEO field group → Next `Metadata`                                          |
| [entry-navigator-scalability.md](entry-navigator-scalability.md)                   | Editor navigator loads all entries up front (the hard 10,000 ceiling is gone — verified 2026-07-24); move to collection-scoped/lazy loading (+ keyset cursor) |

---

## P1 — High-impact correctness or quality (adopter-side)

| File                                                                                   | Summary                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [next-16.2-postcss-fork-bomb.md](next-16.2-postcss-fork-bomb.md)                       | Next 16.2.x + Turbopack + PostCSS = fork bomb on adopter `pnpm dev`. Workaround: pin `next` to `~16.1.6`. Document in README; consider pinning in examples. |

---

## P3 — Nice-to-have

| File                                             | Summary                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| [ai-content-v2.md](ai-content-v2.md)             | `llms.txt` metadata, HTTP caching headers, selective rebuild for AI content  |
| [transform-lambda-bundle-bloat.md](transform-lambda-bundle-bloat.md) | Transform Lambda's `handler.js` bundles unrelated octokit/simple-git/proper-lockfile code via the broad `canopycms/server` barrel (~1 MB dead weight); needs an approved narrow `canopycms` entrypoint to fix |
| [schema-faq-glossary.md](schema-faq-glossary.md) | Dedicated FAQ and glossary schema collections for reuse across pages         |
| [content-root-name-hardcoded.md](content-root-name-hardcoded.md) | `api/schema.ts`'s `getSchemaOps` and `api/entries.ts`'s `deleteEntry` hardcode `'content'` instead of honoring `config.contentRoot` like every other content-facing code path |
| [init-mode-prompt-stale-doc.md](init-mode-prompt-stale-doc.md)   | README's Quick Start claims `canopycms init` interactively prompts for "Operating mode" (dev/prod), but `cli.ts` hardcodes `mode = 'dev'` with no prompt and `InitOptions.mode` is typed as the literal `'dev'` only — needs a decision (drop the doc claim, or add real prod-mode scaffolding) |
| [readme-ispermissionerror-doc-bug.md](readme-ispermissionerror-doc-bug.md) | README's Error Handling Utilities example recommends `isPermissionError(err)` to detect a `canopy.read()` permission denial, but it checks Node `EACCES`/`EPERM`, not `ContentStoreError`'s `FORBIDDEN` code — the example never fires |
| [FIXES.md](FIXES.md)                             | Older catch-all list; mostly superseded — review and migrate to proper files |

---

## Deferred from 2026-04 baseline review (minor)

Small findings not worth dedicated task files; fix opportunistically:

- `MediaConfig.publicBaseUrl` accepts any string in TS but Zod enforces URL format — `config/types.ts:152-154` (still open at 2026-07 re-review)
- `listAssets` endpoint has no auth guard beyond the handler-level authn check — decide whether asset key enumeration is acceptable for all authenticated users (still open at 2026-07 re-review)
- Container-only collections (no `entries`) are create-then-uneditable via direct API: first write falls back to filename type `entry`, subsequent writes resolve that on-disk type and `store.write` 400s (`api/content.ts` existing-type resolution + `content-store.ts` buildPaths fallback). Editor never hits it; fold into assets/media or content-store work. (2026-07 second-round review, LOW)
- `assets.upload` can never validate: server schema requires a `Buffer`/`Uint8Array` instance but the client JSON-stringifies bodies, so the parsed value is a plain object → always 400. Dead path today; rework with the assets/media system (base64 string data, or raw `ArrayBuffer` bodies + `computeContentSha256HexFromBytes`). (2026-07 second-round review, LOW)

Fixed on the 2026-07 review branch: `CanopyConfigSchema` schema-field drift, `relativePathSchema` per-segment traversal check, `composeCanopyConfig` dead spread (superseded by the full-fragment merge in PR #90). The getErrorMessage sweep (G1) replaced the exact-semantic `String(err)` occurrences; sites with custom fallback strings or raw-object console logging were deliberately retained (getErrorMessage has no fallback parameter — widening it is an optional follow-up noted in the G1 PR).

---

## Resolved

Completed tasks live in [resolved/](resolved/) — kept because several double as
design/analysis references (residual-window analyses, implementation summaries).
The tables above list OPEN work only.

| File | Summary |
| ---- | ------- |
| [index-staleness-multiprocess.md](resolved/index-staleness-multiprocess.md) | RESOLVED — in-process invalidation (PR #91) + cross-process on-disk generation marker, suspicious-lookup backstop, and write existence guard (PR fix/content-index-cross-process). Residual NFS-caching windows documented in the file. |
| [preview-bridge-security.md](resolved/preview-bridge-security.md) | RESOLVED — source + origin checks landed in preview-bridge.tsx (verified at 2026-07 baseline re-review) |
| [efs-cross-process-concurrency.md](resolved/efs-cross-process-concurrency.md) | RESOLVED — epic PRs #111–#116: shared generation-marker + OCC/lockfile primitives applied to branch-registry, schema-cache, comment-store, branch-metadata, content-store lock keys; concurrency model documented in docs/concurrency.md |
| [e2e-reset-race-condition.md](resolved/e2e-reset-race-condition.md) | RESOLVED — 404-on-ENOENT in api/content.ts + reset polling gates (verified at 2026-07 baseline re-review) |
| [flaky-comment-store-tests.md](resolved/flaky-comment-store-tests.md) | RESOLVED — layered locking in epic PR #114; {retry:1} workarounds removed, 20/20 clean runs |
| [content-store-validation.md](resolved/content-store-validation.md) | RESOLVED — authoritative write-boundary validation + client pre-save errors via shared entry-validator (PR #93) |
| [content-store-lock-key.md](resolved/content-store-lock-key.md) | RESOLVED — epic PR #116: readdir-derived namespaced content-ID lock keys, buildPaths inside the lock, create-slug keys |
| [pr106-review-followups.md](resolved/pr106-review-followups.md) | RESOLVED — all deferred items from the PR #106 integration review (mode-default, abandoned-scaffold guard, worker PR-logic dedup, Octokit throttling, editor lows, idIndex-in-lock) fixed on `fix/pr106-review-followups` (2026-07-20); test-coverage gaps closed |
| [cms-service-deployment-test.md](resolved/cms-service-deployment-test.md) | RESOLVED — first full prod-mode AWS deploy (epic/deployment-test, 2026-07-24): entire stack deployed to sandbox + all 9 verification rows exercised on the live editor. 13 PRs (#128–#140) fixed deploy blockers found by design review, dogfooding, template review, and the live deploy. Open follow-ups spun out (post-merge-sync-gaps P1, worker-cloudwatch-logs P1, slug/anon 500s, pack prepack). Reusable harness kept. |
| [assets-media-system.md](resolved/assets-media-system.md) | RESOLVED — assets/media system shipped as epic PR #126 (S3 content-addressed storage, presigned upload, on-demand transform Lambda, image field + MediaLibrary) + CDK/deploy hardening in PRs #128–#140. File kept as the design record. Remainders: asset-review-followups, docs-site-assets-wiring, adopter-image-field-migration, finalize-transform-decoder-mismatch. |
| [dual-react-problem.md](resolved/dual-react-problem.md) | RESOLVED (verified 2026-07-24) — `withCanopy()` adds React aliases to the consumer's copy, `react`/`react-dom` are peerDependencies, README documents the `file:`-reference failure mode. Reopen only if a Turbopack-alias crash recurs. |
| [server-mode-anonymous-read-500.md](resolved/server-mode-anonymous-read-500.md) | RESOLVED (2026-07-24) — level-scoped `defaultPathAccess` (`{ read: 'allow' }`) for public read + `readByUrlPath` now renders a FORBIDDEN denial as `null` (404 via `notFound()`) instead of throwing a 500; documented in README's Permission Model section. Strict `read()` still throws. |
| [slug-route-nofallback-500.md](resolved/slug-route-nofallback-500.md) | RESOLVED (2026-07-24) — `withCanopy(..., { staticBuild })` adds `static.ts`/`static.tsx` (vs. `server.ts`/`server.tsx`) to `pageExtensions`, enabling the documented split-page convention (`page.static.tsx` prerenders with `dynamicParams=false`; `page.server.tsx` is `force-dynamic` with no `generateStaticParams`) so CMS-build requests render at request time, ACL-enforced, and unknown slugs 404 instead of throwing NoFallbackError. Two dead ends verified and recorded in the file: conditional `dynamicParams` (Next statically parses segment config) and `dynamicParams=true` with prerender (on-demand SSG throws DYNAMIC_SERVER_USAGE; prerender bypasses ACLs). |
