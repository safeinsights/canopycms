# Submitted branches remain fully editable — 'locked' status is never enforced

## RESOLVED (2026-08-12)

Landed in two parts.

The enforcement half landed first, in `3f74e7fc`: the `writableBranch` guard
rejects any status other than `'editing'`, covering `content.write`,
`content.renameEntry`, `entries.delete` and all seven `schema.*` mutations; the
editor gained a status-locked banner with Save disabled; e2e `B6/B7` in
`branch-state-badges.spec.ts` covers banner + 403 + withdraw-restores-editing.

This PR finished the remaining wire-flag half. A sibling predicate
`getBranchWriteProtection()` returns `writeBlocked`
(`readOnly || status !== 'editing'`), so the "which statuses lock editing" rule
lives in one place instead of three. `BranchListItem` ships `writeBlocked`, and
`Editor.tsx` / `EditorHeader.tsx` consume it rather than re-deriving the rule.
`readOnly` deliberately keeps its narrow base-branch meaning — it is what picks
which of the two lock banners to show.

**Why two functions rather than one optional argument.** The first cut added an
optional `status` to `getBranchProtection()`, which introduced a fail-OPEN
regression caught by adversarial review: the pre-existing guard read
`status !== 'editing'`, so a runtime-missing status *blocked* the write, whereas
`status !== undefined && status !== 'editing'` *allowed* it. That state is
reachable — `branch.json` is parsed with a bare cast and no schema (see
[[branch-metadata-no-schema-validation]]), and corrupt branch metadata is a
condition this codebase already handles. The fix makes `status` a **required**
parameter of a separate write-oriented predicate, so "the caller didn't ask
about status" and "the file had no status" stay distinguishable — they want
opposite answers, and only the second should block.

Two things this task listed as gaps turned out not to be: asset endpoints are
branch-agnostic by design (documented at `api/assets.ts`), and the draft manager
is `localStorage`-only with no server write path.

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
