# Baseline quality: comment volume, encapsulation, doc volume

**Status:** Active. Integration branch `int-202609-baseline-quality` (base `int-202609-a`);
every PR below targets it, and Phase E opens the one epic PR from it.
**Created:** 2026-09-13, from an approved plan. A manager session runs the work as chips and
reads their reports; machine gates are the gates, nobody human-reviews the inner PRs.

## Why

Measured 2026-09-13 at `c25035d2`, the tip of `int-202609-a`. Non-test TypeScript in
`packages/canopycms/src`, comment lines over code lines:

| Snapshot   | files | code   | comment | ratio |
| ---------- | ----- | ------ | ------- | ----- |
| 2026-02-15 | 189   | 22,311 | 6,121   | 0.27  |
| 2026-06-19 | 240   | 29,778 | 8,633   | 0.29  |
| 2026-08-15 | 299   | 40,588 | 18,134  | 0.45  |
| 2026-09-13 | 315   | 43,792 | 23,054  | 0.53  |

- Since June the package added more comment lines than code lines. 59 comment runs exceed
  30 lines (longest 91); 151 comment lines carry history markers (dates, PR numbers,
  "used to", review references). `canopycms-cdk` sits at 1.58, `canopycms-next` at 0.93.
  Roughly 35% of comment lines can go with no rule lost: re-explained shared mechanisms,
  bug archaeology, essays where two lines fit, and transcribed code.
- Encapsulation: no true layering inversion. The queue contract (`worker/task-queue.ts`,
  `task-queue-config.ts`, `worker-status.ts`) is misfiled under `worker/`;
  `cli/init-github-app.ts` has 37 exports, 21 test-only; `editor/hooks/index.ts` re-exports
  21 names for 2 importers; `.dependency-cruiser.mjs` has no module-boundary rule and
  nothing checks for unused exports. The flat `src/` namespace is a recorded decision and
  stays.
- Docs: the four root docs total about 128k words (ARCHITECTURE 46.6k, DEVELOPING 28.2k,
  README 27.6k, CODEBASE_GUIDE 25.8k) plus 38k in `docs/`; every doc-agent run is net
  additive because the charters measured lines, and the files grow inside bullets and
  cells.

## Work units

| PR  | Chip | Scope                                                                                                                           | Status      |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | G    | Guards and rules: `pnpm lint:comments`, `scripts/diff-comments-only.mjs`, doc word budgets in `check-docs.mjs`, the style rule in `AGENTS.md`, review briefs, charters | in progress |
| 2   | A1   | Comment compression, Opus tier: `worker/`, `utils/`, `paths/`, `operating-mode/`, `http/`, `auth/`, flat `src/*.ts`, plus `worker/AGENTS.md` and `utils/AGENTS.md` dedupe | planned     |
| 3   | A2   | Comment compression, Sonnet tier: `authorization/`, `schema/`, `config/`, `static/`, `build/`, `validation/`, `task-queue/`, `api/`, `cli/`, `assets/`, `ai/`, `editor/` | planned     |
| 4   | A3   | Comment compression, other packages: `canopycms-cdk` (Opus), `canopycms-next`, both auth packages, root `scripts/`              | planned     |
| 5   | D    | Docs consolidation: ARCHITECTURE to 25k words, DEVELOPING to 18k, README to 20k, CODEBASE_GUIDE to 10k as a map; `docs/adopter-migration.md` audited | planned     |
| 6   | B    | Encapsulation: `api/routes.ts` aggregator, queue contract moved to `task-queue/`, `cli/init-github-app.ts` split, dependency-cruiser boundary rules, knip as `pnpm lint:exports` | planned     |
| 7   | E    | Manager bookkeeping: ratchet both budget files, `docs/reviews/2026-09-baseline-quality.md`, Fable review of the whole diff, the epic PR | planned     |

Sequence: G, then A1/A2/A3 and D in parallel (disjoint files), then B, then E.

## Rules that outlive the epic

- The comment and doc style rule in `AGENTS.md`: present-tense rule at the point it
  applies plus the one non-obvious fact; history goes in commit messages or here.
- `pnpm lint:comments` ratchets history markers (to zero), run length (cap 30) and
  comment/code ratio per directory from `scripts/comment-budget.json`; `pnpm lint:docs`
  ratchets per-file and per-section word counts from `scripts/docs-budgets.json`.
- Reviewers do not request comments; a wrong claim is fixed by a shorter correct claim.
- Doc charters report word deltas, place facts in code comments and module `AGENTS.md`
  before root docs, and turn prose tables into lists.

## Success criteria (hard gates, not aspirations)

- Every PR passes `pnpm lint`, `lint:comments`, `lint:docs`, `lint:tasks` and
  `typecheck`. Phase A PRs paste a `diff-comments-only` PASS and a keyword ledger for every
  deleted or changed line matching the invariant keywords. Phase B adds `lint:bundle`,
  `lint:cycles`, `lint:exports`, `CI=1 pnpm test` and the example app build.
- After Phase A, expected and verified rather than targeted: core comment lines near 16k
  (ratio about 0.37), cdk under 1.0, no directory above 1.0, no run over 30, zero history
  markers in source.
- Leave-alone ranges unchanged: `utils/occ-json-write.ts` body, `worker/github-auth.ts`
  outside lines 548-567, the bodies of `utils/url-prefix.ts` and `utils/sanitize-href.ts`,
  inline comments in `authorization/protected-branch.ts` lines 147-155.
- After Chip D: ARCHITECTURE at most 25k words, DEVELOPING 18k, README 20k,
  CODEBASE_GUIDE 10k; budgets lowered to actual plus 3%.
- Guards prove themselves red on a scratch branch before anyone trusts them.
- Phase E: a Fable review of `git diff int-202609-a...int-202609-baseline-quality` with
  the keyword ledgers spot-checked against surviving text; the review record under 120
  lines.

## Deferred from this epic

- [worker-test-seams-dependency-injection.md](worker-test-seams-dependency-injection.md)
