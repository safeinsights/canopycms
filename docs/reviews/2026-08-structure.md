# CanopyCMS Structural Review — August 2026

**Reviewed:** `int-202608-b` @ `64d804f5`, all 5 packages + 3 apps. ~178k LOC TS/TSX,
1,108 commits, first commit 2025-12-16.

**Lens:** encapsulation, module boundaries, pattern consistency, and how well the codebase
supports being maintained by an AI agent over many sessions.

**Why a separate report.** The two existing baseline reviews ([2026-07](2026-07.md),
[2026-08](2026-08.md)) are bug-and-security reviews — the skill that produced them says
explicitly _"Do NOT nitpick style, formatting, or missing comments."_ The structural
question had therefore never been the primary lens. This report fills that gap and does
not re-litigate their findings.

**Method:** three parallel read-only surveys along orthogonal axes (module boundaries;
pattern consistency and duplication; AI-maintainability), plus first-hand verification by
the lead reviewer of every claim that entered this report. Counts here were measured
against the tree, not inherited from the surveys — three numbers in an early draft came
from a survey rather than the tree and were wrong.

---

## Executive summary

**The code is in better structural shape than the concern that prompted this review
assumed. The knowledge layer around it was not.**

Measured, not impressions:

|                                              |                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `../../..` imports in the whole core package | **4**                                                              |
| `api/` → `editor/` edges                     | **0**                                                              |
| Runtime import cycles                        | **1** (now 0, and checked)                                         |
| Public mutable class fields                  | **1**                                                              |
| Real `any` usages in 73,842 LOC              | **3**, all forced by TS overload resolution, all disable-commented |
| Endpoints validating input declaratively     | **53 / 53**                                                        |
| Endpoints using the declarative guard system | 43 / 53, and 8 of the 10 exceptions are correct by design          |
| Comment density, non-test core               | **30%** (41–52% in the hotspots)                                   |

Two hypotheses that motivated the review were tested and are **false**:

1. _"Invariants live only in AGENTS.md, so an agent editing a file with fresh context
   would break them silently."_ Of 39 sampled invariant-bearing symbols, **zero** were
   AGENTS.md-only; 90% were also stated in a comment at the point of the rule, usually
   naming the bug that motivated it. Nine specific invariants were checked against source;
   all nine warn a future editor, in the file, at the rule.
2. _"The 38 flat top-level modules want directories."_ Measured intra-cluster vs inbound
   edges: `content-*` has 8 internal against 51 external, `url-*` has **zero** internal —
   the shared prefix there is lexical coincidence. Boxing these into directories would add
   a hop to ~50 call sites while encapsulating nothing.

What was real is narrower, and was mostly **one problem with one mechanism**.

---

## The core finding: a documentation ratchet

`AGENTS.md` is the only file `CLAUDE.md` @-imports, so it entered every agent's context on
every task. Its Code Organization section had become a write-only log:

> **Line count frozen at 106 since 2026-07-22, while word count went 1,298 → 5,007.**

Every edit was an insertion _inside an existing bullet_, because that was the only cheap
edit the structure allowed. The section was ~80% of the file. Depth had become **inversely
proportional to subsystem size**:

| Module    | LOC    | words | words / 1k LOC |
| --------- | ------ | ----- | -------------- |
| `static/` | 841    | 976   | **1011**       |
| `utils/`  | 2,642  | 601   | 227            |
| `worker/` | 3,170  | 287   | 91             |
| `api/`    | 9,573  | 13    | 1.4            |
| `editor/` | 20,855 | **5** | **0.2**        |

It recorded where bugs had hurt, not where code lives. `static/` grew another 126 words
_during this review_.

**The mechanism was identifiable and fixable.** `CLAUDE.md` steps 3–6 run four
doc-maintainer agents after every task. Three of the four had **no removal instruction of
any kind**, and `docs-architecture.md` ended on _"Add new sections if needed as the
architecture evolves."_ Result: the four root docs grew **2,154 lines** between 2026-07-21
and 2026-08-22 and **not one ever shrank**.

---

## What was fixed, and what was left

This review landed as PRs
[#281](https://github.com/safeinsights/canopycms/pull/281)–[#285](https://github.com/safeinsights/canopycms/pull/285)
on `int-202608-b`. The scope was deliberately bounded: fix the knowledge layer, convert a
few load-bearing invariants into checks, and **assess the large modules without
restructuring them**, since that work would collide with the ranked production-readiness
backlog for two live adopter sites.

### Fixed

- **Factual drift.** A `src/middleware/` module documented in AGENTS.md that never
  existed; a `canopycms/config` entrypoint advertised twice in ARCHITECTURE.md _and_
  shipped as a copy-pasteable code fence, in no exports map; six of nine "directories to
  monitor" in `update-codebase-guide.md` that did not exist; `cli/templates/` vs the real
  `cli/template-files/`; a `PROMPT.md` that never existed; DEVELOPING.md's claim that the
  static build reads the working tree (verified false, and its task file records that
  _"three previous agents already lost time to it"_); CONTRIBUTING.md's claim that e2e is
  disabled in CI, a month stale.
- **A skill that destroyed its own history.** `baseline-review/SKILL.md` instructed its
  final phase to write `REVIEW-REPORT.md` — the July baseline, cited by
  `.claude/future-tasks/` as a historical record. A literal run would have overwritten it.
  Reports now live under `docs/reviews/<YYYY-MM>.md`.
- **The ratchet.** AGENTS.md 5,007 → 1,478 words, with the detail moved to twelve
  per-directory `AGENTS.md` files (verified lossless: all 354 backticked symbols
  preserved) and a new `editor/AGENTS.md` written from scratch. All four doc agents now
  require finding what an addition supersedes and reporting a net line delta. `CLAUDE.md`
  gained a "which doc do I read for X" routing table — nothing anywhere stated one, and
  README listed 2 of the 11 docs.
- **Three prose-only invariants became checks**, all break-and-rerun verified: a
  `no-circular` rule (found and broke the one real cycle,
  `branch-metadata ↔ branch-registry`); a lint rule requiring `ContentStore` be told its
  content root; and one requiring `matter(raw, {})` or a justification.
- **New `lint:docs`**, which found a broken import in a _published package's README_
  (`canopycms-auth-clerk` told adopters to import `createCanopyHandler` from
  `canopycms/next` — neither the symbol nor the entrypoint exists) and two dead links.
- **CI lint coverage.** `pnpm lint` reached 6 workspace projects while `typecheck` reached
  8; `apps/test-app` and `apps/dual-build-fixture` had no `lint` script, leaving 53 files
  including all 20 Playwright specs unlinted. Fixing that exposed that flat-config
  `ignores` are config-relative, so `.next/**` had only ever matched the repo root.
- **Grep tags that resolved to nothing.** 22 occurrences of `[HIGH-n]`/`[MEDIUM-n]`/
  `[LOW-n]`/`[NIT-n]`/`[H2]`, IDs from a review pass whose findings list was never
  committed. Not deleted wholesale: 13 of them were one real cross-file invariant (error
  text reaching a browser must be redacted), now `[REDACT]` and anchored. Every tag in
  source now resolves to a definition.

### Assessed, deliberately not changed

See [`.claude/future-tasks/split-large-files.md`](../../.claude/future-tasks/split-large-files.md)
for the actionable form.

- **`worker/cms-worker.ts` (2,949 lines) — genuinely tangled, and the seam is proven.**
  Four disjoint call trees under `start()` (lifecycle/lock, task queue, git sync, auth
  cache) sharing six helper methods. `rebaseActiveBranches` is **667 lines in one method**.
  The decisive evidence: the **test suite has already been carved into seven files along
  exactly those lines**, for a production file that was never carved.
- **`content-store.ts` (2,177) — cohesive core, two detachable clusters.** `buildPaths`
  alone has ~25 call sites, so the CRUD/path/lock core is genuinely interwoven. But
  reference resolution and ID-index coherency detach cleanly, and the latter already has
  three partner modules.
- **`git-manager.ts` (1,467) — two modules sharing a class name.** Everything down to
  `initializeWorkspace` is `static` workspace provisioning sharing no instance state;
  everything from `status()` on is per-repo instance operations.
- **`api/branch.ts` (965) — a branch service wearing route-handler clothes.** 7 of its 14
  exports have exactly one consumer: its own test. It is the only one of 19 endpoint
  modules that exports its handlers, and it calls `GitManager` and `fs.rm` directly where
  siblings delegate to a store.
- **`schema/schema-store.ts` (1,208) — large but disciplined. Leave it.** Every public op
  is `foo()` → `withSchemaLock` → `fooInner()`; largest method 145 lines.
- **`editor/Editor.tsx` (1,512) — the hard work is already done.** 12 hooks extracted into
  17 well-tested files. What remains is 26 `useState` calls and a ~490-line JSX return.

Churn confirms where the pain is: over the last 400 commits the most-changed files are
`content-store.ts` (46), `cms-worker.ts` (39), `git-manager.ts` (32), `Editor.tsx` (29) —
the biggest files are also the hottest.

---

## Systemic observation: fixes land at the site, not the abstraction

The August bug review put this well, and it still holds:

> When this codebase finds a bug class, the fix tends to land at the site rather than at
> the abstraction.

Re-verified at this HEAD, with the count now **five**, not four: the "does this user match
`allowedUsers`/`allowedGroups`" logic exists at `authorization/path.ts`,
`authorization/branch.ts`, `api/branch.ts` (twice) and `editor/components/EditorHeader.tsx`.
They **already disagree** — the branch-listing filter grants a creator visibility
unconditionally, while `authorization/branch.ts` deliberately denies a creator whom an
explicit allowlist omits, with a long comment explaining why that denial is correct.

The same shape recurs elsewhere: `atomicWriteFile` exists and three modules reimplement it
(one of the three omits cleanup on failed rename and leaks `.tmp`); `permissionPathSchema`
is defined twice, byte-identical; the permissions and groups settings loaders are
copy-paste twins that have already drifted on error behavior for the same failure class.

`validation/field-traversal.ts`'s `traverseFields` is documented as _"THE single encoding
of the schema-nesting rules — add to it rather than writing another walker."_ It has three
consumers, all inside `validation/`, while eight other modules walk the same structure
themselves.

**This is the highest-leverage remaining theme**, and it is already well captured: the ACL
consolidation is filed with acceptance criteria at
[`authorization-enforcement-consolidation.md`](../../.claude/future-tasks/authorization-enforcement-consolidation.md).

---

## The backlog is the healthiest part of this codebase

Worth stating plainly, because it inverts the usual finding. `.claude/future-tasks/` holds
135 open + 90 resolved items and is **better curated than most human-run backlogs**:

- **Zero orphans in either direction**, CI-enforced by `scripts/check-future-tasks.mjs` —
  a 309-line script that enumerates the four ways a backlog rots and explains each.
- An 18-file sample across the alphabet found **zero already-fixed items** and **zero
  duplicates**. Files carry status, discovery date, discovering PR, and _self-corrections_
  (one marks its own item "STALE, verified 2026-08-13"; another is "SUPERSEDED IN PART"
  with a pointer to the live successor).
- `index.md` opens with a statement of _who the backlog is serving right now_ and a ranked
  "do next" list with per-row reasoning.

**The diagnosis pipeline is excellent; consolidation into code is the bottleneck.** Intake
in August alone (114 items) exceeded the entire resolved corpus (90). The one health
concern is the Jan–Apr cohort of 16 aging items, which are feature-shaped and are neither
being pruned nor re-scoped.

---

## What this codebase does well

Not filler — these are above the norm and worth protecting.

1. **In-code documentation is close to best-in-class for AI maintenance.** 30% comment
   density; the module headers on `paths/branch-name.ts`, `worker/log.ts`,
   `utils/url-prefix.ts`, `utils/provisioning-lock.ts` and `validation/block-structural-keys.ts`
   each state the invariant, the bug that motivated it, and what breaks if you undo it.
2. **`docs/concurrency.md` is an unusually good design document** — layered headings, a
   "who uses what" table, recipes, testing patterns, history. It is the model the rest of
   the prose should follow, and it had **zero** broken file references.
3. **Deliberate dependency-free siblings**, consistently applied and documented at the top
   of each file: `paths/branch-name.ts` vs `paths/branch.ts`, `assets/asset-prefixes.ts`
   vs `assets/keys.ts`, `assets/transform-directives.ts` vs `assets/transform.ts`.
4. **Drift-tested duplication.** `operating-mode/deployment-name-fixtures.ts` is shared
   with `canopycms-cdk`'s tests so the construct's duplicated validator goes red on drift,
   rather than relying on a comment. This is the right way to duplicate.
5. **Mechanical enforcement is unusually rich** and each config explains its own rationale
   — `.dependency-cruiser.mjs` is the best-reasoned lint config in the repo, and pairs its
   main rule with an unresolvable-import rule so a broken specifier cannot silently blind
   the guard.
6. **Cross-package direction is clean.** Core never imports a sibling package; siblings
   use only exports-map specifiers; the auth plugins do not know about each other.
7. **The generated API client really is generated**, with CI failing on drift.
8. **Dead code is a non-issue** — independent sweeps of ~1,100 exported symbols found 3
   genuinely dead exports. Do not spend effort here.

---

## Recommended next steps

Ordered by leverage per unit of risk. All are filed in `.claude/future-tasks/`; none
should preempt the ranked production-readiness list without a deliberate decision.

| #   | Item                                                                                                                                                                                        | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | [`get-error-message-fallback-overload.md`](../../.claude/future-tasks/get-error-message-fallback-overload.md) — one-line signature change takes a stated rule from 73% to ~99%              | XS   |
| 2   | [`authorization-enforcement-consolidation.md`](../../.claude/future-tasks/authorization-enforcement-consolidation.md) — five diverging ACL matchers, already filed with acceptance criteria | M    |
| 3   | [`duplicated-helpers-consolidation.md`](../../.claude/future-tasks/duplicated-helpers-consolidation.md) — atomic writes, permission-path schema, settings loaders, slugify                  | S–M  |
| 4   | [`api-response-constructors.md`](../../.claude/future-tasks/api-response-constructors.md) — 230 hand-written response literals with no constructor                                          | M    |
| 5   | [`route-registry-parity-test.md`](../../.claude/future-tasks/route-registry-parity-test.md) — ~20 lines preventing a silent-404 class                                                       | XS   |
| 6   | [`config-type-zod-parity.md`](../../.claude/future-tasks/config-type-zod-parity.md) — make three hand-synced definitions fail loudly instead of silently                                    | S    |
| 7   | [`logging-consistency-sweep.md`](../../.claude/future-tasks/logging-consistency-sweep.md) — derive the ban list from the import graph instead of curating it by hand                        | S–M  |
| 8   | [`test-layout-convergence.md`](../../.claude/future-tasks/test-layout-convergence.md) — start with the `paths/` same-filename collision                                                     | S–M  |
| 9   | [`split-large-files.md`](../../.claude/future-tasks/split-large-files.md) — the god-file assessment above, in actionable form                                                               | L    |

**Two things not to do.** Do not hunt dead code — the prior sweep settled it. Do not
restructure the flat top-level modules into directories — it was measured and the cohesion
is not there.
