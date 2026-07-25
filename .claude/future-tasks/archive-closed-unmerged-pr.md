# Truthful archive path for branches whose PR closed without merging

Deferred from the git-admin-observability epic (adversarial finding M7,
2026-07-24).

## Problem

`pollMergeState` records `pullRequestState: 'closed'` but deliberately never
auto-transitions the workflow status (user decision from the post-merge-sync
work). The admin's manual options for a closed-unmerged PR are all lies or
dead ends: mark-merged fabricates `mergedAt`/`pullRequestState:'merged'` (and
on prod Lambda the PR-merged verification is skipped, so nothing stops it),
withdraw returns the branch to editing (fine when work continues, wrong when
it's abandoned), delete destroys it. There is no "archive as
closed-without-merge".

## Fix

Small admin action (likely `POST /:branch/archive`, admin guard) that sets
`status: 'archived'` WITHOUT stamping `mergedAt`/`pullRequestState:'merged'` —
the Merged badge in BranchManager already distinguishes archived+mergedAt from
plain archived, so the UI is nearly free. Surface it in the System health
Branches tab (and/or BranchManager) for branches with
`pullRequestState === 'closed'`.

## Files

- `packages/canopycms/src/api/` (new small endpoint beside branch-merge.ts)
- `packages/canopycms/src/editor/admin/SystemHealthPanel.tsx`
