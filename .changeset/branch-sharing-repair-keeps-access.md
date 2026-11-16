---
'canopycms': patch
---

### Branch sharing: repairing a branch's metadata keeps who can open it — **security fix, behaviour change**

<!-- migration
area: Branches
action: None
row: Metadata repair keeps branch access
-->

**What changed.** System health's "Repair" on a branch with corrupt metadata used to reset its access, which opened a private branch to everyone on sites where `defaultBranchAccess` is `'allow'`, and let removed people back in. Repair now keeps the branch's access list, removals and creator when the damaged file still holds them readably. When the access can't be read, only admins, reviewers and at most the branch's creator can open it until it is shared again: a creator the damaged file shows was removed, locked out or left off the list stays out, and removals and a lockdown that still read carry over. The base branch, which takes no list, is unchanged, and its recorded base branch is kept. The status still goes back to editing. The response to `POST /admin/branch-dirs/:dirName/repair-metadata` now lists only the fields it reset under `reset`, the ones it kept under `kept`, and whether the branch is `restricted` and `openToEveryone`, and it answers 409 when another write recreated the metadata mid-repair; System health says who can open the repaired branch.
