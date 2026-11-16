---
'canopycms': patch
---

### Branch sharing: repairing a branch's metadata keeps who can open it — **security fix, behaviour change**

<!-- migration
area: Branches
action: None
row: Metadata repair keeps branch access
-->

**What changed.** System health's "Repair" on a branch with corrupt metadata used to reset its access, which opened a private branch to everyone on sites where `defaultBranchAccess` is `'allow'`, and let removed people back in. Repair now keeps the branch's access list, removals and creator when the damaged file still holds them readably. When the access can't be read, only the branch's creator, admins and reviewers can open it until it is shared again; the base branch, which takes no list, is unchanged. The status still goes back to editing. The response to `POST /admin/branch-dirs/:dirName/repair-metadata` now lists only the fields it reset under `reset`, the ones it kept under `kept`, and whether the branch is `openToEveryone`; System health says who can open the repaired branch.
