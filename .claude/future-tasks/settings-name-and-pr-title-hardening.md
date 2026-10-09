---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-05, from the int-202610-a combined review. `?branch=` reads refuse the settings prefix rather than the configured settings-branch name (safe today only by directory layout), and the GitHub PR title skips `cleanText`. Both reasoned, neither reachable as a bug today
---
# Two small hardening gaps found by the int-202610-a combined review

## Priority: P3 [BOTH]

Found 2026-10-05 by the final cross-PR review of `int-202610-a`. Neither is reachable as a bug today.

## 1. `?branch=` refuses the settings prefix, not the configured settings-branch name (reasoned)

`context.ts` request-scoped reads resolve `?branch=` through `loadExistingBranch` → `paths/branch.ts`,
which refuses only the reserved settings prefix. `http/handler.ts` and `openOrCreateBranch` refuse the
configured `settingsBranch` name itself. The invariant "the settings branch is never a content workspace"
therefore holds at the third site only because the settings workspace lives under `<root>/settings`, not
`content-branches/`. Fix: pass the operating strategy's settings-branch name into `loadExistingBranch`
and refuse it there too, with a test using a custom `settingsBranch` name.

## 2. The branch title sent to GitHub skips `cleanText` (reasoned, pre-existing)

`api/github-sync.ts` sends the editor-written branch title to GitHub as the PR title without the
`cleanText` sanitizer `submit-attribution` applies to names (bidi and zero-width characters survive). A
title is not rendered as Markdown, so this is display spoofing only. Fix: run the title through the same
sanitizer, with a test.

## 3. Branch deletion can fail `ENOTEMPTY` while a schema operation contends (reasoned)

On int, a `schema-store` test flaked: removing a branch root while a queued `addEntryType` was retrying
failed `ENOTEMPTY`, because each retry recreates lock directories under `.canopy-meta` (#385 added the
content-write lock there). The test now retries the removal. The production analogue is a branch delete or
purge racing a schema edit. Check whether `deleteBranch`/purge removes the workspace with retries, or
fails and leaves a half-deleted tree.

The third finding of that review, `hasUnpushedCommits` still resolving bare ref names, is part of
[settings-branch-name-tag-collision.md](settings-branch-name-tag-collision.md).
