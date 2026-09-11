# [P3] The generated stack derives one base branch, but a multi-mode adopter has two

Raised 2026-09-09 by the website adopter, declining to adopt a migration step
with a good reason. Not a defect in what shipped — a shape it does not cover.

## What shipped

`cms-stack.ts.template` imports the adopter's own `canopycms.config.ts` and
derives `baseBranch: config.defaultBaseBranch` / `settingsBranch:
config.settingsBranch`, so the worker's `.env` and the Lambda's request-time
config cannot disagree. Correct for a single-deployment adopter, which is the
shape the scaffold targets.

## The shape it does not cover

That adopter deploys **one repository in two modes** — a testing base branch
now, a production one at a later phase, both synthesizable from one tree. Their
`canopycms.config.ts` reads `CANOPYCMS_BASE_BRANCH` with a literal fallback, so
deriving the CDK prop FROM the config inverts badly: at synth time the env var
is unset, the literal fallback wins, and the production mode would silently
resolve the testing branch. Their fix is a per-mode key in `cdk.json` as the
source of truth, plus a synth-time test holding the two together.

So for them the derivation is not merely unnecessary, it is **wrong** — and
wrong in the silent direction, which is the same failure class the derivation
was added to prevent.

## Why this is P3 rather than a fix

The generated scaffold is explicitly a single-deployment starting point, and a
multi-mode adopter has already left it (they hand-maintain the stack). Nothing
is broken today. What is missing is a documented seam: the template does not
say "if your config resolves the base branch dynamically, pass the prop
explicitly instead", so the next multi-mode adopter re-derives the trap.

## Fix direction, cheapest first

1. **A comment in the template**, next to the derivation, naming the condition
   under which deriving is wrong (a config that resolves the branch from the
   environment) and saying to pass the prop explicitly then. Costs nothing and
   closes the discoverability half.
2. A short subsection in `docs/deploying-to-aws.md`'s base-branch section on
   the multi-mode shape, pointing at the synth-time-cross-check pattern rather
   than the derivation.
3. Only if a second multi-mode adopter appears: consider whether
   `CanopyCmsService` should accept a resolver rather than a string, so the
   per-mode choice is expressible in the construct. Do not build this
   speculatively — the current props already express it, just without
   guidance.

Do (1) next time this file is touched; it is a two-line comment.
