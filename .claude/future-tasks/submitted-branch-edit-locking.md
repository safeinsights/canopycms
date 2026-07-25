# Submitted branches remain fully editable — 'locked' status is never enforced

## Priority: P2

Surfaced during exploration for the protected-base-branch work (2026-07-24). The
branch-status model has a `'locked'` value and the review flow describes a
request-changes unlock, but nothing gates editing on status.

## Problem

`BranchStatus` includes `'locked'` (types.ts) and it has a badge color in the
editor, but no code path ever sets it or enforces it. After "Submit for review",
the branch flips to `'submitted'` — and the Save button, draft manager, and the
content write API all keep working on it. An editor can silently change a branch
while a reviewer is looking at its PR; the PR then updates on the next submit
with changes the reviewer never saw requested. The intended flow (AGENTS.md:
submit → locked for review → request-changes unlocks) is half-built: the
request-changes action exists, but there's nothing to unlock.

## Fix sketch

The protected-base-branch work built the exact machinery this needs:

- Server: extend the `writableBranch` guard (api/guards.ts) — or a sibling
  status check in the same runner — to reject content/entry/schema mutations
  when `branch.status === 'submitted'` (and `'locked'`/`'archived'`), with
  request-changes flipping status back to `'editing'`.
- Wire flags: extend `BranchListItem.readOnly` (api/branch.ts `toListItem`) to
  account for status, so the editor's existing banner/disabled-Save rendering
  works unchanged.
- Decide whether `'locked'` as a distinct status is still needed or whether
  `'submitted'` implies locked (simpler; `'locked'` could then be removed).

## Related

- `authorization/protected-branch.ts` + `api/guards.ts` `writableBranch` — the
  pattern/plumbing to extend
- `api/branch-status.ts` (submit), `api/branch-withdraw.ts` (withdraw →
  `'editing'`), request-changes flow in `useBranchManager.tsx`
