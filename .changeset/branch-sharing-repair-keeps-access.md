---
'canopycms': patch
---

### Branch sharing: repairing a branch's metadata keeps who can open it — **security fix, behaviour change**

<!-- migration
area: Branches
action: None
row: Metadata repair keeps branch access
-->

**What changed.** System health's "Repair" on a branch with corrupt metadata used to reset its access, which opened a private branch to everyone on sites where `defaultBranchAccess` is `'allow'`, and let removed people back in. Repair now rebuilds the file field by field and never widens access: a field that still reads is kept, one that doesn't takes its most restrictive value. A readable access list, creator, base branch and `archived` status are kept. When the access can't be read, only admins and reviewers can open the branch, keeping removals entry by entry (a malformed one as an admin's) and any lockdown; the base branch, and in development the active branch, take no list, so they stay open unless the damaged file may have limited them, which locks them to admins and reviewers. A creator that can't be read is recorded as unknown, and an id of `unknown` grants no creator rights. The response to `POST /admin/branch-dirs/:dirName/repair-metadata` lists the fields it reset under `reset` and the ones it kept under `kept`, says whether the branch is `restricted` and `openToEveryone`, answers 409 when another write recreated the metadata mid-repair, and puts the corrupt file back when its own write fails; System health says who can open the repaired branch.
