---
name: epic-workflow
description: Run a multi-PR epic on an integration branch — design + adversarial review up front, stacked small PRs implemented one at a time and merged as they pass, one human-reviewable epic PR at the end
---

Run a multi-fix epic (several related findings that deserve one coordinated design,
not N ad-hoc fixes) using the integration-branch workflow. The invoking prompt or
epic file (usually `.claude/future-tasks/<epic>.md`) defines scope and success
criteria. Rationale for the shape: human review bandwidth is the scarce resource, so
the epic gets exactly ONE human-reviewed PR; everything inside it is machine-reviewed
at each step instead.

## Phase 1 — Design (plan mode, main loop)

1. Read the epic file, every linked analysis/task file, and each implicated module in
   full. Use Explore agents for call-site maps, test inventories, and existing-pattern
   discovery; keep design synthesis in the main loop.
2. Produce ONE coordinated design covering all findings: shared primitives first, then
   per-consumer applications. Name the PR sequence (primitive → one consumer per PR →
   docs/bookkeeping last).
3. **Adversarial review before implementing:** launch a heavy (inherit-model) agent
   with the plan + the key source files, instructed to ATTACK every load-bearing claim
   (enumerate interleavings, probe edge cases, find what the plan misses) and return
   severity-ranked findings with a verdict. Fold amendments into the plan. Wrong
   *claims* must be fixed in the plan, not discovered mid-implementation.
4. Get plan approval (ExitPlanMode).

## Phase 2 — Branch setup

- Confirm the base: the epic file or user names it; check whether prerequisite PRs
  merged (`gh pr view`). Create `epic/<name>` off the base and push it.
- All small PRs branch off and target `epic/<name>`. Stack each next PR branch on the
  previous one so work proceeds without waiting for merges; diffs collapse once
  predecessors merge into the base.

## Phase 3 — Small-PR loop (repeat per PR)

1. `git checkout -b feat/<piece>` (stacked on the previous PR branch).
2. **Implement via ONE foreground agent** with a detailed spec: background + the
   finding, files to READ FIRST, numbered change list, named edge cases from the
   adversarial review, test list, verify commands, and "report deviations". Include
   project rules (pnpm, no `any`, extensionless imports) and known machine quirks.
   One implementation agent at a time — they share the working tree and each builds
   on the last.
   Pick the tier by the work: `model: sonnet` when the change is clear and the spec
   is detailed — that covers most PRs; Opus 5 when there is real design content
   (concurrency, cross-module refactors, anything the adversarial review flagged as
   subtle). The orchestrator decides per PR; neither tier is an automatic default.
3. **Main-loop review of the diff** — this is the quality gate, do not skip or
   delegate it: read the substantive diff, check the spec's subtle points landed,
   hunt for layering/ordering bugs (e.g. error-translation placed inside a retry
   predicate's scope). Fix small issues inline; send the agent back for large ones.
4. Verify yourself: targeted vitest suites + `tsc --noEmit` + `pnpm lint`.
5. Commit (only the epic's files — never unrelated dirty files), push, `gh pr create
   --base epic/<name>` with a body stating the race/bug, the fix, and the test
   evidence.
6. When the PREVIOUS PR's CI is green, merge it into `epic/<name>` (if `gh pr merge`
   is blocked, a plain `git merge --no-ff` + push of the integration branch is the
   same operation). Stash/checkout dance around uncommitted next-PR work.

## Phase 4 — Docs + bookkeeping PR

- Judgment-heavy docs (design references like docs/concurrency.md) are written by the
  main loop; run `update-codebase-guide` and `docs-architecture` agents for the
  mechanical doc sweeps; mark resolved future-task files RESOLVED with implementation
  summaries and update `index.md`.
- If the epic created a durable pattern, give it a durable home (a docs/ reference +
  agent-charter maintenance trigger), not just PR descriptions.

## Phase 5 — Final heavy review + epic PR

1. After all small PRs merge: run a heavy (inherit-model) review agent over the FULL
   epic diff (`git diff <base>...epic/<name>`), instructed like the adversarial
   design review but against real code. Act on findings, push fixes to the epic
   branch directly (or as one more small PR if substantial).
2. Re-check whether the base branch's PR merged meanwhile; if yes, rebase the epic
   branch onto the new target (usually main) before opening.
3. Open the single epic PR: `epic/<name>` → base. Body = coordinated-design summary,
   per-small-PR list with links, success-criteria evidence. This is the one humans
   review.

## Ground rules

- Success criteria from the epic file are hard gates (e.g. "flaky tests pass with
  retries REMOVED"), not aspirations — demonstrate them (repeat-run loops, regression
  tests verified against pre-fix code).
- Execution tiering is the orchestrator's call, made per unit of work. Opus 5
  orchestrates, and implements anything with real design content. Sonnet is the right
  tool whenever the work is clear and the spec is detailed — that covers most
  implementation PRs. Fable is often a good choice for the adversarial design review
  and the final full-diff review, where a genuinely independent perspective catches
  what continuity misses. It is not the automatic answer for hard *implementation*
  work — there it costs more than Opus 5 without always being better. At most one
  heavy agent at a time — unchanged.
- Never let a subagent commit; the main loop owns git state.
