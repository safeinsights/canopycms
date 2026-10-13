---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13, from PR 547. A branch's ACL ids now go only to admins and reviewers, so a non-privileged creator, who may still PATCH `/:branch/access`, gets back counts only and cannot see whom they shared with. No editor UI calls `updateAccess` today; any future creator-facing ACL UI needs a decision first
---

# A branch creator cannot see their own branch's access list

`toBranchListItem` (`api/branch.ts`) sends a caller without the privileged user lookup only the
ACL entries naming them, plus `withheldAccess` counts (docs/ux-guidelines.md, People). That
includes the response to the creator's own `updateAccess`, which `canModifyBranchAccess` still
allows.

Nothing in the editor edits a branch's ACL as its creator today, so nothing breaks. Before
adding such a UI, decide whether a creator counts as privileged for their own branch's ACL
(they chose those people, but only through ids they could not look up), or whether ACL editing
stays admin-only and `canModifyBranchAccess` drops the creator grant.
