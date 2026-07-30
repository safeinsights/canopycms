# Future Tasks Index

Priority levels:

- **P0** — Blocks production launch; data loss, security, or crash
- **P1** — Significant correctness issue under normal use; important quality debt
- **P2** — Useful enhancement, moderate quality improvement, or feature work
- **P3** — Nice-to-have; low-impact

---

## Active program

Coordinated multi-workstream effort. The hub document carries status and
decisions; the log carries learnings. Individual workstream files are listed here
rather than in the priority tables, because their sequencing is driven by the
program rather than by priority alone.

| File                                                                             | Summary                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [production-readiness-program.md](production-readiness-program.md)               | **Hub** — CanopyCMS to production for docs-site-proto (and website v2): workstreams, sequencing, decisions, protection rules for the teams' live docs site |
| [program-log.md](program-log.md)                                                 | **Append-only log** — findings, disproven assumptions, deploy-proven facts, decisions and their reasoning         |
| [program-a-release-path.md](program-a-release-path.md)                           | A (S) — prerelease dist-tag channel from integration branches + standing draft PR to main; unblocks adopters consuming unreleased work |
| [program-b-canopy-hardening.md](program-b-canopy-hardening.md)                   | B (L) — multi-deployment safety, worker/log ops gaps, day-one editor correctness, dual-build CI. Gates D          |
| [program-c-e2e-coverage.md](program-c-e2e-coverage.md)                           | C (L) — e2e coverage sweep from 2026-04-12 forward (51→52 test cases in 3.5 months while ~60 editor/api commits landed) |
| [program-d-stack-rebuild.md](program-d-stack-rebuild.md)                         | D (M) — tear down + rebuild the deploy-test stack from scratch; build the reusable deployed-stack verification suite |
| [program-e-docs-site-cms.md](program-e-docs-site-cms.md)                         | E (L) — first real CMS deployment for docs-site-proto without disturbing the teams' live site                    |
| [program-f-production.md](program-f-production.md)                               | F (L) — multi-account `official` mode + shared static-site CDK so website v2 doesn't fork a second copy           |
| [program-g-operational-readiness.md](program-g-operational-readiness.md)         | G (M) — runbooks, standing smoke test, ownership boundaries, release-channel wind-down                            |

---

## P0 — Must fix before multi-editor prod launch

None currently open.

---

## P1 — High-impact correctness or quality

| File                                                                         | Summary                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [worker-asg-rolling-update.md](worker-asg-rolling-update.md)                 | Worker ASG has no updatePolicy: `cdk deploy` changes to user-data or the worker code bundle never reach the running instance (only spot churn or manual terminate does) — "deploy deploys everything except the worker". Promoted P2→P1 2026-07-24: operations trap for the prod stack; cheap fix (rollingUpdate + optional cfn-signal) |
| [swr.md](swr.md)                                                             | Multiple independent `useEffect` hooks fire duplicate API calls on initial editor load; SWR would deduplicate. **One combined work item with editor-async-patterns** (SWR = dedup/cancel layer; counters cover the rest) |
| [editor-async-patterns.md](editor-async-patterns.md)                         | `ReferenceField` refetches on every render; `useReferenceResolution` and `loadEntry` have no cancellation for stale responses. **One combined work item with swr.md** |
| [dual-build-ci.md](dual-build-ci.md)                                         | CI fixture running both deploy shapes (`CANOPY_BUILD` static + editor builds) — withCanopy/deployedAs/split-page (`page.static`/`page.server`, PR #146) regressions currently uncaught. Promoted P2→P1 2026-07-24: both shapes are now core to the prod story |
| [next-16.2-postcss-fork-bomb.md](next-16.2-postcss-fork-bomb.md)             | (adopter-side) Next 16.2.x + Turbopack + PostCSS = fork bomb on adopter `pnpm dev`. Workaround: pin `next` to `~16.1.6`. Quick win: document known-good versions in README (~30 min); upstream chase is the larger piece |

---

## P2 — Enhancements and feature work

| File                                                                               | Summary                                                                                                                    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [submitted-branch-edit-locking.md](submitted-branch-edit-locking.md)               | Submitted branches remain fully editable ('locked' status exists but is never set/enforced); extend the protected-branch `writableBranch` guard + `readOnly` wire flag to status-based locking |
| [protected-branch-guard-double-load.md](protected-branch-guard-double-load.md)     | The 7 schema-mutation endpoints resolve branch context twice per request (writableBranch guard + getSchemaOps) — two branch.json reads (EFS round-trips) where there was one; thread the guard-resolved context into getSchemaOps. From protected-branch review finding #6 |
| [rescue-stranded-base-edits.md](rescue-stranded-base-edits.md)                     | Admin capability (CLI/API) to move stranded uncommitted edits from a protected branch clone onto a new editing branch; replaces the manual EFS runbook in deploying-to-aws.md |
| [sanitized-branch-name-git-mismatch.md](sanitized-branch-name-git-mismatch.md)     | VERIFY FIRST: slashed branch names (`feature/foo`) are sanitized (`feature-foo`) before git workspace init — dev HEAD workspaces and slashed `defaultBaseBranch` values may not round-trip through git ops |
| [lambda-log-retention.md](lambda-log-retention.md)                                 | The CMS Lambda and transform Lambda still rely on auto-created, infinite-retention CloudWatch log groups; add explicit LogGroups/retention as a sibling of the worker's (now 90 days by default) |
| [worker-log-timestamps.md](worker-log-timestamps.md)                               | Worker console.log lines carry no timestamps (journald used to add them); CloudWatch now shows only ingestion timestamps and multi-line stack traces land as separate events — a timestamp-prefixing log helper would fix both |
| [withdraw-stale-pr-state-detection.md](withdraw-stale-pr-state-detection.md)       | Withdraw detects a closed PR from metadata that can be up to `gitSyncInterval` stale — in the lag window it enqueues a convert-to-draft task that 422s and trips `sync-failed` on a successful withdraw; fix by making the worker treat "PR already closed" as a benign no-op. Promoted P3→P2 2026-07-24: user-visible false failure in normal use, small fix |
| [finalize-transform-decoder-mismatch.md](finalize-transform-decoder-mismatch.md)   | Upload `finalize` (lightweight sniffer, no sharp) accepts raster images the transform Lambda's libvips later rejects (422) → asset uploads OK but renders broken everywhere with no user feedback |
| [asset-review-followups.md](asset-review-followups.md)                             | Deferred non-blocking items from PR #126 review: upload abort/AbortController, post-delete blob GC, altOptional-omitted edge, + nits (finalize byte-cap verified done 2026-07-24) |
| [docs-site-assets-wiring.md](docs-site-assets-wiring.md)                           | DEFERRED until docs-site prod deploy lands: wire assets into docs-site-proto (AssetSupport BYO-bucket, behaviors, media config) + the update-distribution.ts stamps-every-OriginPath fix that MUST ride along |
| [adopter-image-field-migration.md](adopter-image-field-migration.md)               | READY (own prompt): migrate ../website + ../docs-site-proto string image paths to the structured image field + optimize the website's 1.5-3.3MB offenders |
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
| [editor-state-context-migration.md](editor-state-context-migration.md)             | Complete migration of `Editor.tsx` inline state to `EditorStateContext` (context exists; Editor.tsx still holds 26 inline `useState` — verified 2026-07-24). Demoted P1→P2 2026-07-24: refactoring debt/enabler, not user-facing correctness |
| [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md)                   | Planning task (folded out of the dissolved FIXES.md): design the editorial+development workflow scenarios — dev/staging/prod flow, schema changes vs in-flight content branches, long- vs short-lived branches, upstream-conflict UX, PR-workflow checks |
| [split-large-files.md](split-large-files.md)                                       | Extract wire-format conversion, reference resolution, and index logic into focused modules                                 |
| [deletion-checker-refactor.md](deletion-checker-refactor.md)                       | Refactor `DeletionChecker` to use `traverseFields` — the duplicated block-shape logic bit again (fixed a third time in PR #88); the duplication itself remains |
| [test-gap-backfill.md](test-gap-backfill.md)                                       | Targeted tests for top-risk untested modules (route-builder, meta-loader, operating-mode strategies, authz loaders, settings-workspace, …) |
| [adopt-changesets.md](adopt-changesets.md)                                         | Replace auto-patch publishing with changesets for deliberate semantic versioning                                           |
| [audit-logging.md](audit-logging.md)                                               | Audit trail for permission/group changes with query API and notifications                                                  |
| [remote-git-self-heal.md](remote-git-self-heal.md)                                 | Worker-side self-heal for a poisoned pre-existing remote.git: auto-re-clone when no unpushed refs exist, keep refusing (with the ref list) when they do — the System health panel now surfaces the state but recovery still needs an operator (git-admin-observability epic deferral) |
| [archive-closed-unmerged-pr.md](archive-closed-unmerged-pr.md)                     | Truthful archive path for closed-without-merge PRs: small admin archive action that does NOT stamp mergedAt/'merged' — today's options fabricate history (mark-merged, unverifiable on Lambda) or dead-end (git-admin-observability M7 deferral) |
| [admin-only-acl-unenforced.md](admin-only-acl-unenforced.md)                       | `BranchAccessControl.adminOnly` is declared but enforced nowhere — enforce in authorization/branch.ts or delete the field; pair with locked-branch-status-dead.md's decide-or-delete pass |
| [init-respects-adopter-conventions.md](init-respects-adopter-conventions.md)       | `canopycms init` should detect adopter's Prettier config + package manager and match them in generated files + next-steps |
| [static-export-sitemap.md](static-export-sitemap.md)                               | Static-export sitemap helper: enumerate published entries + singletons → `sitemap.xml` (framework-agnostic core + Next adapter) |
| [static-export-seo-metadata.md](static-export-seo-metadata.md)                     | Static-export SEO metadata helper + recommended SEO field group → Next `Metadata`                                          |
| [entry-navigator-scalability.md](entry-navigator-scalability.md)                   | Editor navigator loads all entries up front (the hard 10,000 ceiling is gone — verified 2026-07-24); move to collection-scoped/lazy loading (+ keyset cursor) |

---

## P3 — Nice-to-have

| File                                             | Summary                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| [prod-remote-default-branch-detection.md](prod-remote-default-branch-detection.md) | Prod falls back to `'main'` when `defaultBaseBranch` is unset; detect the remote's real default branch (origin/HEAD) at service creation instead |
| [markdownfield-mdxeditor-mount-flake.md](markdownfield-mdxeditor-mount-flake.md) | MarkdownField MDXEditor-mount unit test races the async mount under full-suite load (fails ~rarely, isolation always green); needs waitFor around the mount assertion (2026-07-24) |
| [base-branch-acl-tightening.md](base-branch-acl-tightening.md) | `branches.updateAccess` can still edit the protected base branch's ACL (feeds the `allowed_by_acl` workflow grant); tighten alongside submitted-branch locking |
| [protected-branch-comparison-helper.md](protected-branch-comparison-helper.md) | Extract a shared `isSameBranch`/`effectiveBaseBranch` helper — the sanitized head==base compare is hand-rolled in 4 places (services/github-sync/cms-worker + the predicate). From protected-branch review finding #7 |
| [worker-base-branch-env-divergence.md](worker-base-branch-env-divergence.md) | Worker head==base backstop keys off the CANOPYCMS_BASE_BRANCH env var, which can drift from config.defaultBaseBranch (defense-in-depth only); wire/document it. From protected-branch review finding #8 |
| [protected-branch-followup-cleanups.md](protected-branch-followup-cleanups.md) | Two small cleanups: deleteBranch returns 400 where the guards use 403 for the same protected refusal; BranchListItem's isProtected/readOnly are optional citing legacy compat (banned rule) and the two BranchSummary types diverge. From protected-branch review findings #9/#10 |
| [ai-content-v2.md](ai-content-v2.md)             | `llms.txt` metadata, HTTP caching headers, selective rebuild for AI content  |
| [comment-thread-unresolve.md](comment-thread-unresolve.md) | Resolved comment threads are terminal — add unresolve primitive (store + API + UI); deferred from ux-review-fixes to avoid new API surface there |
| [transform-lambda-bundle-bloat.md](transform-lambda-bundle-bloat.md) | Transform Lambda's `handler.js` bundles unrelated octokit/simple-git/proper-lockfile code via the broad `canopycms/server` barrel (~1 MB dead weight); needs an approved narrow `canopycms` entrypoint to fix |
| [schema-faq-glossary.md](schema-faq-glossary.md) | Dedicated FAQ and glossary schema collections for reuse across pages         |
| [reserved-branch-route-names.md](reserved-branch-route-names.md) | Branches named `admin`/`assets` have their /:branch routes shadowed by the static namespaces — reject reserved names in branch-name validation |
| [admin-panel-client-gating.md](admin-panel-client-gating.md) | Permissions/Groups/Schema panels render for all users and rely on API 403s — gate menu items/mounts on isAdmin like the new System health item (PR-U1 pattern) |
| [settings-conflict-resolution-ux.md](settings-conflict-resolution-ux.md) | Richer editor UX for settings 409 conflicts (reload-latest action, diff view) on top of the wired version-conflict flow |
| [settings-git-ops-cross-host.md](settings-git-ops-cross-host.md) | Settings-branch pull→commit→push runs outside the cross-host lock on the shared EFS clone; a lost push race surfaces as `pushed: false` — extend a `.git-ops.lock` around the sequence or formally accept with editor surfacing (found by PR #149 human review, LOW; boundary already documented in docs/concurrency.md) |
| [settings-file-store-e2e-validation-test.md](settings-file-store-e2e-validation-test.md) | `mutateGroupsFile`/`mutatePermissionsFile`'s real-Zod-schema parse path has no end-to-end test (store tests use a synthetic schema; handler tests mock the mutators) — add round-trip + rejection integration tests (found by PR #149 human review, NIT) |
| [locked-branch-status-dead.md](locked-branch-status-dead.md) | `BranchStatus` `'locked'` is never set or checked anywhere (and the worker would rebase-but-never-poll a locked branch); implement real semantics or delete the literal — coordinate with the main-branch-protections work (found by PR #144 review). Now also carries the folded-in FIXES.md question: lock editing after submit? |
| [s3-media-listing-order.md](s3-media-listing-order.md) | MediaLibrary listing is newest-first in dev but hash-ordered in prod (`S3AssetStore.listMeta` returns S3 key order); revisit when "find my recent upload after reload" becomes a real complaint (assets epic final review finding #4 — index row added 2026-07-24, was an orphaned file) |
| [content-root-name-hardcoded.md](content-root-name-hardcoded.md) | `api/schema.ts`'s `getSchemaOps` and `api/entries.ts`'s `deleteEntry` hardcode `'content'` instead of honoring `config.contentRoot` like every other content-facing code path |
| [init-mode-prompt-stale-doc.md](init-mode-prompt-stale-doc.md)   | README's Quick Start claims `canopycms init` interactively prompts for "Operating mode" (dev/prod), but `cli.ts` hardcodes `mode = 'dev'` with no prompt and `InitOptions.mode` is typed as the literal `'dev'` only — needs a decision (drop the doc claim, or add real prod-mode scaffolding) |
| [efs-tls-in-transit.md](efs-tls-in-transit.md)   | EFS worker mount doesn't pass the `tls` option (efs-utils stunnel) — NFS traffic is unencrypted in transit (intra-VPC only; at-rest encryption is on). Needs its own verification deploy. From PR #141 review (LOW) |
| [worker-push-end-of-options.md](worker-push-end-of-options.md) | Worker's `git.push(this.buildGitHubUrl(), branch)` has no `--end-of-options` separator before the task-payload branch name — argument-injectable in principle, low exposure since branch names originate from the CMS's own branch workflow. Pre-existing, flagged by PR #141 review (LOW) |
| [network-escape-hatch-git-env.md](network-escape-hatch-git-env.md) | Under `allowNetworkRemoteInProd`, `GitManager`'s remote fetch/push run with the restricted `gitChildEnv` allowlist (drops `HTTPS_PROXY`/`GIT_SSL_*`/`GIT_SSH_COMMAND`) — would fail behind a proxy while the worker's full-env pushes succeed. From PR #141 review (LOW) |

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
| [ux-review-deploy-test-findings.md](resolved/ux-review-deploy-test-findings.md) | RESOLVED — 2026-07-24 deployed-editor UX review; all code findings fixed on claude/ux-review-fixes (branch-name unification, draft lifecycle, submitted-branch lock, menus/timestamps/media/alt/comments); fix map + deliberate non-fixes inside |
| [stale-draft-prevents-content-load.md](resolved/stale-draft-prevents-content-load.md) | RESOLVED — entry load no longer skipped when a draft exists (always fetch + overlay), draft cleared on save, discards confirmed (claude/ux-review-fixes, e43b7a6); optional "viewing a draft" visual indicator not implemented |
| [index-staleness-multiprocess.md](resolved/index-staleness-multiprocess.md) | RESOLVED — in-process invalidation (PR #91) + cross-process on-disk generation marker, suspicious-lookup backstop, and write existence guard (PR fix/content-index-cross-process). Residual NFS-caching windows documented in the file. |
| [preview-bridge-security.md](resolved/preview-bridge-security.md) | RESOLVED — source + origin checks landed in preview-bridge.tsx (verified at 2026-07 baseline re-review) |
| [efs-cross-process-concurrency.md](resolved/efs-cross-process-concurrency.md) | RESOLVED — epic PRs #111–#116: shared generation-marker + OCC/lockfile primitives applied to branch-registry, schema-cache, comment-store, branch-metadata, content-store lock keys; concurrency model documented in docs/concurrency.md |
| [e2e-reset-race-condition.md](resolved/e2e-reset-race-condition.md) | RESOLVED — 404-on-ENOENT in api/content.ts + reset polling gates (verified at 2026-07 baseline re-review) |
| [flaky-comment-store-tests.md](resolved/flaky-comment-store-tests.md) | RESOLVED — layered locking in epic PR #114; {retry:1} workarounds removed, 20/20 clean runs |
| [content-store-validation.md](resolved/content-store-validation.md) | RESOLVED — authoritative write-boundary validation + client pre-save errors via shared entry-validator (PR #93) |
| [content-store-lock-key.md](resolved/content-store-lock-key.md) | RESOLVED — epic PR #116: readdir-derived namespaced content-ID lock keys, buildPaths inside the lock, create-slug keys |
| [pr106-review-followups.md](resolved/pr106-review-followups.md) | RESOLVED — all deferred items from the PR #106 integration review (mode-default, abandoned-scaffold guard, worker PR-logic dedup, Octokit throttling, editor lows, idIndex-in-lock) fixed on `fix/pr106-review-followups` (2026-07-20); test-coverage gaps closed |
| [settings-file-occ-cross-host.md](resolved/settings-file-occ-cross-host.md) | RESOLVED — permissions/groups writes now run the full layered stack via `authorization/settings-file-store.ts`; contentVersion unified into the OCC `version` (advisory — lockfile is the cross-host guarantee); GET+editor wired for `expectedContentVersion` (2026-07-24) |
| [schema-store-rmw-protection.md](resolved/schema-store-rmw-protection.md) | RESOLVED — every SchemaOps mutator holds `withLock`+`withOccFileLock` on the `.canopy-meta/schema` surrogate across its full RMW; no OCC fields in the git-committed `.collection.json` (approved deviation); busy → 409; migrate takes the lock in branch clones (2026-07-24) |
| [cms-service-deployment-test.md](resolved/cms-service-deployment-test.md) | RESOLVED — first full prod-mode AWS deploy (epic/deployment-test, 2026-07-24): entire stack deployed to sandbox + all 9 verification rows exercised on the live editor. 13 PRs (#128–#140) fixed deploy blockers found by design review, dogfooding, template review, and the live deploy. Open follow-ups spun out (post-merge-sync-gaps P1, worker-cloudwatch-logs P1 (now resolved — see below), slug/anon 500s, pack prepack). Reusable harness kept. |
| [worker-cloudwatch-logs.md](resolved/worker-cloudwatch-logs.md) | RESOLVED (2026-07-24, PR #145) — EC2 worker stdout/stderr ships to a dedicated CloudWatch log group by default via the amazon-cloudwatch-agent (journald is agent-unreadable, so the systemd unit moved to file output); predictable log group name + 90-day default retention (both overridable), IAM grant scoped to CreateLogStream/PutLogEvents on that one group, on-instance logrotate, and failure-isolation ordering (agent setup can't block the worker). Spun out lambda-log-retention.md and worker-log-timestamps.md as follow-ups. |
| [assets-media-system.md](resolved/assets-media-system.md) | RESOLVED — assets/media system shipped as epic PR #126 (S3 content-addressed storage, presigned upload, on-demand transform Lambda, image field + MediaLibrary) + CDK/deploy hardening in PRs #128–#140. File kept as the design record. Remainders: asset-review-followups, docs-site-assets-wiring, adopter-image-field-migration, finalize-transform-decoder-mismatch. |
| [dual-react-problem.md](resolved/dual-react-problem.md) | RESOLVED (verified 2026-07-24) — `withCanopy()` adds React aliases to the consumer's copy, `react`/`react-dom` are peerDependencies, README documents the `file:`-reference failure mode. Reopen only if a Turbopack-alias crash recurs. |
| [server-mode-anonymous-read-500.md](resolved/server-mode-anonymous-read-500.md) | RESOLVED (2026-07-24) — level-scoped `defaultPathAccess` (`{ read: 'allow' }`) for public read + `readByUrlPath` now renders a FORBIDDEN denial as `null` (404 via `notFound()`) instead of throwing a 500; documented in README's Permission Model section. Strict `read()` still throws. |
| [slug-route-nofallback-500.md](resolved/slug-route-nofallback-500.md) | RESOLVED (2026-07-24) — `withCanopy(..., { staticBuild })` adds `static.ts`/`static.tsx` (vs. `server.ts`/`server.tsx`) to `pageExtensions`, enabling the documented split-page convention (`page.static.tsx` prerenders with `dynamicParams=false`; `page.server.tsx` is `force-dynamic` with no `generateStaticParams`) so CMS-build requests render at request time, ACL-enforced, and unknown slugs 404 instead of throwing NoFallbackError. Two dead ends verified and recorded in the file: conditional `dynamicParams` (Next statically parses segment config) and `dynamicParams=true` with prerender (on-demand SSG throws DYNAMIC_SERVER_USAGE; prerender bypasses ACLs). |
| [post-merge-sync-gaps.md](resolved/post-merge-sync-gaps.md) | RESOLVED (2026-07-24, fix/post-merge-sync-gaps) — worker's `rebaseActiveBranches()` now polls GitHub for submitted/approved branches' PR state (auto-archives on merge via new shared `buildMergedBranchUpdate()`) and a new `refreshBaseBranchWorkspace()` fast-forwards `content-branches/<base>` every sync cycle so editors see current base content (the original "new branches fork from stale main" claim was disproven — forks clone fresh from `remote.git`). |
| [canopycms-pack-needs-prepack.md](resolved/canopycms-pack-needs-prepack.md) | RESOLVED — `"prepack": "pnpm run build"` added to canopycms, canopycms-next, canopycms-auth-clerk, canopycms-auth-dev (PR #143, 2026-07-24), mirroring canopycms-cdk's PR #128 guard. Verified prepack fires under both `pnpm pack` and `npm pack` with `dist/` deleted; CI publish workflow unchanged (its explicit build now double-builds harmlessly, same as cdk). |
| [branch-metadata-updatedat-frozen.md](resolved/branch-metadata-updatedat-frozen.md) | RESOLVED (2026-07-24, PR #149) — `save()` stamps `updatedAt: now` after the merge spreads (was frozen at creation by spread order); strictly-greater regression test added. Taken on the PR #149 human review's recommendation. |
| [readme-ispermissionerror-doc-bug.md](resolved/readme-ispermissionerror-doc-bug.md) | RESOLVED (2026-07-24, PR #149) — README's Error Handling Utilities example now branches on `ContentStoreError`'s `code` field (both the `isPermissionError` and `isNotFoundError` branches were dead — they check Node `EACCES`/`ENOENT`); section clarifies CMS reads never throw Node fs errors and points URL pages at null-safe `readByUrlPath()`. Optional first-class helpers (export `ContentStoreError`) not pursued. |
| [lint-guard-client-bundle-node-imports.md](resolved/lint-guard-client-bundle-node-imports.md) | RESOLVED (2026-07-25) — `pnpm lint:bundle` (dependency-cruiser reachability rule from `src/client.ts` to any node built-in) in CI + pre-commit; replaces the proposed ESLint zones because reachability also covers the transitive `api/guards.ts → authorization/protected-branch.ts → paths/branch.ts` shape a directory-scoped import rule would have missed. Verified against both historical regressions; e2e prod build stays the backstop for server-only npm packages. |
| FIXES.md (deleted) | DISSOLVED (2026-07-24) — the old catch-all list's last live items were folded into proper task files: the lock-editing-after-submit question into [locked-branch-status-dead.md](locked-branch-status-dead.md), the scenario-planning item into [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md); everything else was done or superseded (services singleton done; assets → resolved epic; SEO → static-export tasks; PR-workflow checks → content-lifecycle-scenarios) |
