# Baseline quality review, 2026-09

Dated snapshot. Before: 2026-09-13 at `c25035d2` (tip of `int-202609-a`). After: 2026-09-14 at the tip of `int-202609-baseline-quality`, measured with this epic's guard scripts.

## What was measured and why

Three suspicions, each tested:

- **Comments bloated: confirmed, severe, recent.** Since June the core package added more comment lines than code lines; 59 runs over 30 lines (longest 91); 151 history-marker lines (scout counter); cdk worst.
- **Encapsulation eroded: real but localized.** No true layering inversion; the queue contract sat under `worker/`, `cli/init-github-app.ts` held 37 exports (21 test-only), and nothing checked module boundaries or unused exports. The flat `src/` namespace is a recorded decision and stays.
- **Doc agents not doing their job: they ran on every merge, and every run was net additive**, because the charters measured lines while files grew inside bullets and table cells.

| Core package, non-test TS (scout counter) | files | code   | comment | ratio |
| ----------------------------------------- | ----- | ------ | ------- | ----- |
| 2026-02-15                                | 189   | 22,311 | 6,121   | 0.27  |
| 2026-06-19                                | 240   | 29,778 | 8,633   | 0.29  |
| 2026-08-15                                | 299   | 40,588 | 18,134  | 0.45  |
| 2026-09-13                                | 315   | 43,792 | 23,054  | 0.53  |

| Encapsulation metric (non-test, core package) | 2026-06-19 | 2026-09-13 |
| --------------------------------------------- | ---------- | ---------- |
| exported symbols                              | 878        | 1,340      |
| exports imported only by tests (raw)          | 47         | 110        |
| exports with no importer, used in-file only   | 164        | 233        |
| cross-module imports bypassing an `index.ts`  | 45%        | 54%        |

| Doc words (scout counter) | 2026-06-19 | 2026-09-13 |
| ------------------------- | ---------- | ---------- |
| ARCHITECTURE.md           | 26,164     | 46,610     |
| DEVELOPING.md             | 12,959     | 28,150     |
| README.md                 | 12,859     | 27,561     |
| CODEBASE_GUIDE.md         | 9,465      | 25,778     |
| docs/adopter-migration.md |            | 21,077     |
| docs/deploying-to-aws.md  |            | 10,529     |
| docs/concurrency.md       |            | 6,268      |

## After: comments

`node scripts/check-comment-budget.mjs --report` on a plain `c25035d2` tree and at the integration tip, the same counter both sides. History markers: the plan's scout counter (case-sensitive, bare `reviewer`/`finding`) counted 151 at `c25035d2`, this guard counter counts 147, after 0. The `scripts` code rise (+945) is the two guard scripts this epic added (`check-comment-budget.mjs` 410, `diff-comments-only.mjs` 189) plus the budget extension of `check-docs.mjs` (157 → 503). Max run 43 (`utils/`) is a leave-alone range.

| package              | code            | comment         | ratio         | max run | markers |
| -------------------- | --------------- | --------------- | ------------- | ------- | ------- |
| canopycms            | 43,135 → 43,041 | 22,550 → 16,150 | 0.523 → 0.375 | 91 → 43 | 118 → 0 |
| canopycms-cdk        | 2,179 → 2,179   | 3,368 → 2,786   | 1.546 → 1.279 | 84 → 30 | 13 → 0  |
| canopycms-next       | 1,094 → 1,094   | 1,014 → 876     | 0.927 → 0.801 | 55 → 30 | 2 → 0   |
| canopycms-auth-clerk | 446 → 446       | 129 → 96        | 0.289 → 0.215 | 16 → 15 | 1 → 0   |
| canopycms-auth-dev   | 392 → 392       | 114 → 91        | 0.291 → 0.232 | 16 → 16 | 0 → 0   |
| scripts              | 2,793 → 3,738   | 1,060 → 993     | 0.380 → 0.266 | 49 → 28 | 13 → 0  |
| **total**            | 50,039 → 50,890 | 28,235 → 20,992 | 0.564 → 0.412 | 91 → 43 | 147 → 0 |

| core directory | ratio         | core directory | ratio         |
| -------------- | ------------- | -------------- | ------------- |
| flat `src/`    | 0.823 → 0.578 | http           | 0.667 → 0.404 |
| ai             | 0.574 → 0.456 | operating-mode | 1.035 → 0.531 |
| api            | 0.384 → 0.288 | paths          | 1.021 → 0.454 |
| assets         | 0.502 → 0.450 | schema         | 0.688 → 0.405 |
| auth           | 0.556 → 0.325 | static         | 1.212 → 1.091 |
| authorization  | 0.915 → 0.498 | task-queue     | 0.305 → 0.300 |
| build          | 0.758 → 0.677 | utils          | 1.351 → 1.012 |
| cli            | 0.466 → 0.315 | validation     | 0.427 → 0.276 |
| config         | 0.640 → 0.565 | worker         | 1.167 → 0.976 |
| editor         | 0.229 → 0.153 |                |               |

## After: exports and docs

- knip (`--production --tags=-internal`): 182 unused exports + 90 unused types → 0 / 0. The sweep removed `export` from 125 in-file-only symbols, tagged 95 test seams and 13 no-importer symbols `@internal`, and removed 22 unused default exports and 15 dead re-exports.

`node scripts/check-docs.mjs --report` (words outside code spans and fences), `c25035d2` → after:

| doc                                   | words            | markers  |
| ------------------------------------- | ---------------- | -------- |
| ARCHITECTURE.md                       | 42,331 → 23,242  | 16 → 0   |
| DEVELOPING.md                         | 18,524 → 12,607  | 20 → 0   |
| README.md                             | 18,294 → 14,556  | 6 → 0    |
| CODEBASE_GUIDE.md                     | 19,421 → 3,994   | 16 → 0   |
| AGENTS.md                             | 1,256 → 1,279    | 1 → 0    |
| docs/adopter-migration.md (unchecked) | 18,068 → 13,033  | 36 → 13  |
| docs/deploying-to-aws.md              | 8,702 → 8,718    | 2 → 0    |
| docs/concurrency.md                   | 5,554 → 5,315    | 7 → 0    |
| module AGENTS.md and READMEs (15)     | 6,772 → 5,445    | 19 → 0   |
| .claude/agents (11)                   | 3,883 → 3,716    | 4 → 0    |
| **total (34 budgeted docs)**          | 142,805 → 91,905 | 127 → 13 |

Every doc budget sits at or below actual + 3%, rounded up; README, CODEBASE_GUIDE's largest section and `docs/adopter-migration.md` keep earlier, tighter ceilings because those docs grew.

## The six PRs

- #344 (G) guards: `lint:comments`, doc word budgets and markers, `diff-comments-only.mjs`, the comment/doc style rule in `AGENTS.md`, review briefs, word-measuring doc charters.
- #347 (A1) comments in `worker/`, `utils/`, `paths/`, `operating-mode/`, `http/`, `auth/`, flat `src/`: 10,925 → 7,733 comment lines in scope, 66 → 0 markers.
- #345 (A3) comments in canopycms-cdk (1.546 → 1.28), canopycms-next, both auth packages, root `scripts/`.
- #346 (A2) comments in the other twelve core modules, including the generated API client templates.
- #348 (D) docs consolidation: cross-doc duplicates removed, CODEBASE_GUIDE's 514 table rows turned into lists, the deployment runbook merged into `docs/deploying-to-aws.md`.
- #349 (B) encapsulation: `api/routes.ts`, queue contract into `task-queue/`, hooks barrel 21 → 9 names, `init-github-app.ts` split, three boundary rules, knip, marker regex and budgets ratcheted.

## Guards now in CI

- `pnpm lint:comments`: history markers (0), longest comment run per directory (30), comment/code ratio per directory and package, ratcheted in `scripts/comment-budget.json`.
- `pnpm lint:exports`: knip over canopycms and canopycms-next; an unused export or exported type fails unless tagged `@internal`.
- `pnpm lint:docs` budgets: per-file words, max H2-section words, history markers (0 except `docs/adopter-migration.md`), 25 words per item in CODEBASE_GUIDE and module `AGENTS.md`.
- `pnpm lint:cycles` boundary rules: `http-reaches-api-only-via-routes`, `api-never-imports-worker`, `editor-imports-api-only-client-index-constants`.

## Deferred follow-ups

- [cdk-comment-second-pass.md](../../.claude/future-tasks/cdk-comment-second-pass.md): ~380 more cdk comment lines can go with no rule lost; target ratio ~1.1.
- [worker-test-seams-dependency-injection.md](../../.claude/future-tasks/worker-test-seams-dependency-injection.md): inject octokit, URL builder and push function instead of patching `CmsWorker` instances.
- [knip-scope-gaps.md](../../.claude/future-tasks/knip-scope-gaps.md): barrel re-exports, unused files and dependencies are not checked.
- [knip-no-importer-deletion-candidates.md](../../.claude/future-tasks/knip-no-importer-deletion-candidates.md): 13 symbols tagged `@internal` that nothing imports.
- [comment-guard-scope-gaps.md](../../.claude/future-tasks/comment-guard-scope-gaps.md): `apps/`, hardcoded package roots, test scaffolding, multi-line block directives.
- [branch-lockdown-vs-acl-precedence.md](../../.claude/future-tasks/branch-lockdown-vs-acl-precedence.md): comment and code disagree on lockdown vs explicit ACL; an authorization decision.
- [check-docs-heading-anchors.md](../../.claude/future-tasks/check-docs-heading-anchors.md): link `#anchors` are not resolved.
- [readme-ispermissionerror-claims-eperm.md](../../.claude/future-tasks/readme-ispermissionerror-claims-eperm.md): README claims `EPERM` coverage the code lacks.
