# Scaffolded deploy pipelines should export `CANOPY_BUILD_ID`

**Status:** Open. **Priority: P3** (enhancement; the capability works, the default does not use it).

Filed 2026-08-30 while shipping adopter requests #35 and #36 (see
[adopter-request-log-intake.md](adopter-request-log-intake.md)).

## What

`withCanopy(..., { staticBuild: true })` now pins Next's build id to `CANOPY_BUILD_ID`, and
`canopycms generate-ai-content` records the same value as the AI manifest's `buildId`. Both are
no-ops when the variable is unset — which is what every scaffolded pipeline currently does.

So the capability ships, but an adopter only benefits if they discover the variable in the README
and wire it up themselves. That is most of the cost the requesting adopter actually paid: not
writing the one-line pin, but *finding out it was needed*, late, by driving a real promoter.

## Why it is not just "add a line to the template"

The value has to be a **source tree hash**, and the reasons are specific:

- A commit SHA or commit date is NOT a substitute. A rebase or cherry-pick gives an identical tree
  a different commit object and a different date, so an artifact that should be reused is rebuilt
  and re-published under a new id.
- `git rev-parse HEAD^{tree}` is the cheap correct answer, but it hashes the WHOLE tree — including
  files that cannot affect build output (docs, CI config). Narrowing it to build-relevant paths is
  a real design question, and the requesting adopter flagged wanting it to be a config change
  rather than an edit in three repos.

## Shape

Have the `init-deploy` scaffold export `CANOPY_BUILD_ID` in the generated workflow, and decide
whether the tree-hash definition belongs in config (so the narrowing question has one home) or
stays a documented recipe. Worth checking against `cli/init-deploy` and the CI workflow template
before assuming the former.

## Not blocked on anything

The package half is done and released. This is purely about what a new adopter gets by default.
