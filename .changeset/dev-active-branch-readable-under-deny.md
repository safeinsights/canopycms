---
'canopycms': patch
---

### Dev pages load for non-admin users under `defaultBranchAccess: 'deny'`

<!-- migration
area: Branches
action: None
row: Dev active branch readable by every dev user
-->

**What changed.** In `dev` mode with `defaultBaseBranch` set, a page rendered on a git branch other than the base failed with `Forbidden: branch access denied (no_acl)` for any user outside `admins` and `reviewers`, because CanopyCMS provisions that branch's workspace itself and so nobody counted as its creator. The active branch the dev server provisions now passes branch access the way the base branch does: readable and, subject to path permissions, editable, but not submittable by a user who has no other grant. Prod and branches people create are unchanged.
