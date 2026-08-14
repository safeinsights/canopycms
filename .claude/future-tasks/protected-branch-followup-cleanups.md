# Protected-branch small cleanups: delete status code + wire-flag optionality

## Priority: P3

Surfaced by the protected-base-branch code review (2026-07-24), findings #9 and
#10. Two small, independent cleanups deferred from the fix pass.

## Problem A — inconsistent status code (finding #9)

Re-verified still open 2026-08-13 (`api/branch.ts:609` returns 400, `:617`
returns 403, in the same handler).

`deleteBranchHandler` (`api/branch.ts:~609`) returns HTTP 400 for its
protected-base-branch refusal, while the `writableBranch` and `submittableBranch`
guards return 403 for the semantically identical "this is the protected base
branch" refusal. Within `deleteBranchHandler` the protected check (400) also
precedes the `canDeleteBranch` permission check (403), so one handler yields
either code for what a caller reads as the same category of failure. Align delete
to 403 (or deliberately document why delete differs).

## Problem B — speculative wire-flag optionality (finding #10)

**Re-verified 2026-08-13: the risk this finding named is now mitigated, but its
structural fix is still undone.** Read the two halves separately.

*Mitigated.* The finding's actual danger — "a future caller can omit the flags and
silently get 'not protected'" — no longer holds. `useBranchManager.tsx:308-317`
normalizes every gating flag **fail-closed**: `isProtected ?? true`,
`writeBlocked ?? true`, `submitBlocked ?? true`, so missing data degrades to fully
locked (read-only, Submit hidden, "could not be loaded" banner) rather than to
"not protected". `readOnly ?? false` is deliberately *not* flipped, with an
in-code rationale: it only selects which lock banner to show once something is
already known to be locked, so defaulting it true would mislabel a status lock,
not under-lock anything.

*Still undone.* The fields remain optional (`api/branch.ts:42-43`) and the two
same-named `BranchSummary` interfaces still diverge (`BranchManager.tsx` optional
vs `useBranchManager.tsx` required).

*Stale premise.* The finding's justification for acting — that the doc comment
cited "older clients/servers stay compatible" in violation of the CLAUDE.md
no-legacy-compat rule — no longer describes the code. The comment at
`api/branch.ts:30-40` now gives a deliberate wire-versioning argument: the
optionality is asymmetric on purpose, because a new client against an old server
degrades to locked, and "wire compatibility here means 'doesn't break', not
'behaves the same'". That is a real design position, not legacy-compat cruft.

Remaining fix (now purely a tidiness call, no live risk): make the flags required
`boolean`, align the two `BranchSummary` interfaces, and drop the normalization —
**or** close this half as won't-fix and keep the fail-closed defaults, which are
arguably the more robust arrangement. Decide rather than implement by default.

## Related

- `api/branch.ts` (`deleteBranchHandler`, `BranchListItem`, `toListItem`)
- `editor/BranchManager.tsx` and `editor/hooks/useBranchManager.tsx` (`BranchSummary`)
