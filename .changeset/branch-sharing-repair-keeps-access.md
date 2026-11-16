---
'canopycms': patch
---

### Branch sharing: repairing a branch's metadata keeps who can open it — **security fix, behaviour change**

<!-- migration
area: Branches
action: None
row: Metadata repair keeps branch access
-->

**What changed.** System health's "Repair" on a branch with corrupt metadata used to reset its access, which opened a private branch to everyone on sites where `defaultBranchAccess` is `'allow'`, and let removed people back in. Repair now keeps the branch's access list, removals and creator when the damaged file still holds them readably. When the access can't be read, only admins and reviewers can open the branch until an admin shares it again, and removals and a lockdown that still read carry over. The base branch, which takes no list, keeps only those, as does the active branch in development. A creator that can't be read is recorded as unknown, and a recorded base branch is kept. The status still goes back to editing. The response to `POST /admin/branch-dirs/:dirName/repair-metadata` now lists only the fields it reset under `reset`, the ones it kept under `kept`, and whether the branch is `restricted` and `openToEveryone`, and it answers 409 when another write recreated the metadata mid-repair, and puts the corrupt file back when its own write fails; System health says who can open the repaired branch.
