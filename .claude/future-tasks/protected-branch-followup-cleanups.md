# Protected-branch small cleanups: delete status code + wire-flag optionality

## Priority: P3

Surfaced by the protected-base-branch code review (2026-07-24), findings #9 and
#10. Two small, independent cleanups deferred from the fix pass.

## Problem A — inconsistent status code (finding #9)

`deleteBranchHandler` (`api/branch.ts:~312`) returns HTTP 400 for its
protected-base-branch refusal, while the `writableBranch` and `submittableBranch`
guards return 403 for the semantically identical "this is the protected base
branch" refusal. Within `deleteBranchHandler` the protected check (400) also
precedes the `canDeleteBranch` permission check (403), so one handler yields
either code for what a caller reads as the same category of failure. Align delete
to 403 (or deliberately document why delete differs).

## Problem B — speculative wire-flag optionality (finding #10)

`BranchListItem` (`api/branch.ts:~28`) declares `isProtected?`/`readOnly?`
optional with a doc comment justifying it for "older clients/servers stay
compatible", contradicting the repo CLAUDE.md rule "This is new code — no legacy
compat needed, no migrations". The server always emits both (`toListItem`), and
the editor and API ship from one package build in a single Lambda, so there is no
real client/server skew. The optionality also forces `?? false` normalization
(`useBranchManager.tsx:177`) and lets the two same-named `BranchSummary`
interfaces diverge (`BranchManager.tsx` optional vs `useBranchManager.tsx`
required), so a future caller can omit the flags and silently get "not protected".

Fix: make both flags required `boolean` on `BranchListItem`, drop the compat
comment, align the two `BranchSummary` interfaces, and remove the now-unneeded
`?? false`.

## Related

- `api/branch.ts` (`deleteBranchHandler`, `BranchListItem`, `toListItem`)
- `editor/BranchManager.tsx` and `editor/hooks/useBranchManager.tsx` (`BranchSummary`)
