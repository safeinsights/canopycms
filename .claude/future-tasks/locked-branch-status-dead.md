# BranchStatus 'locked' is a dead state — implement or remove

Found by the Fable review of PR #144 (2026-07-24), verified against the code.

## Problem

`BranchStatus` (types.ts:6) includes `'locked'`, but no code anywhere sets or
checks it — it exists only as a type literal. Worse, its interaction with the
worker is incoherent if anything ever DID set it:

- `rebaseActiveBranches()` skips `submitted`/`approved`/`archived` — `'locked'`
  is NOT in the skip list, so a locked branch would be rebased (history
  mutation on a branch someone deliberately locked).
- The merge-poll (`pollMergeState`) only runs for `submitted`/`approved`, so a
  locked branch with an open PR would never be polled for merge/close.

## Decide

- If locking is a wanted feature (admin freezes a branch), define its
  semantics: skip rebase? block writes? block submit? Then wire it into the
  worker skip lists, write guards, and the editor.
- If not, delete the literal from `BranchStatus` and let the compiler flag any
  latent references.

## Related open question: lock editing after submit? (folded in from FIXES.md, 2026-07-24)

The oldest form of this design question, from the original FIXES.md catch-all:
after a branch is submitted/published, the editor still allows Save — should
editing be locked so reviewers see stable content? (Also: a branch cannot
currently be re-published.) If branch locking gets real semantics, "auto-lock on
submit, unlock on request-changes" is the natural first consumer; if the literal
is deleted instead, the submit-time write-guard question still needs an answer
in the protected-branch work.

Note: the "Main branch PR protections" session (2026-07-24, branch
claude/canopy-main-branch-protections-ce63c0) is building a protected-branch
concept (`isProtected`/`submitBlocked`/`readOnly`) keyed off `defaultBaseBranch`
— if that lands, it may subsume everything 'locked' was ever meant to do, making
removal the natural choice. Coordinate before implementing.

Relates to [[post-merge-sync-gaps]] (the review that found it).
