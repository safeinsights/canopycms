# BranchStatus 'locked' is a dead state — implement or remove

## RESOLVED (2026-08-12) — deleted the literal

Decided delete rather than implement. `'submitted'` already means "locked while a
reviewer looks at the PR", and that lock is now genuinely enforced (see
[[submitted-branch-edit-locking]]), so a second status carrying the same meaning
bought nothing. `'locked'` had zero writers, no endpoint and no UI affordance
that could set it — the guard branch and three badge-colour maps were its only
readers.

Removing it also removes the worker incoherence this file flagged: there is no
longer a status that `rebaseActiveBranches` would rebase but `pollMergeState`
would never poll.

The folded-in FIXES.md question ("lock editing after submit?") is answered yes,
via status rather than via a distinct `'locked'` state.

If an admin-freeze feature is wanted later, reintroduce a status *with* its
semantics in the same change: worker skip list, a set/unset endpoint, write
guard, and UI.

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
