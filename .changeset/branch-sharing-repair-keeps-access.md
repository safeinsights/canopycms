---
'canopycms': patch
---

### Branch sharing: repairing a branch's metadata keeps who can open it — **security fix, behaviour change**

<!-- migration
area: Branches
action: None
row: Metadata repair keeps branch access
-->

**What changed.** System health's "Repair" used to reset a corrupt branch's access, opening a private branch to everyone where `defaultBranchAccess` is `'allow'` and letting removed people back in. Repair now rebuilds the file field by field, keeping every field that still reads, the status, pull request, creator and the markers that hold a delete or a push included. An unreadable field takes its most restrictive value where it holds something back, and is otherwise dropped: an unreadable or missing status becomes `submitted`, which Withdraw undoes; the merge and GitHub markers hold the delete and the push; an archive time becomes the repair time; an unreadable or missing creator becomes unknown, which grants nothing. Unknown fields carry over. Nothing that decides who can open, edit or delete the branch widens; review and merge rights can, in four cases, and the worker's GitHub sync loses any record it can't read. When the access can't be read, or the file isn't JSON, only admins and reviewers can open the branch, keeping readable removals and any lockdown, and unreadable removals leave re-adding to admins. The base branch, which takes no list, and in development the active branch while its creator reads stay open unless the file may have limited them, which locks them. The response to `POST /admin/branch-dirs/:dirName/repair-metadata` reports what it kept and reset, answers 409 when another write created the metadata mid-repair, and restores the corrupt file when its own write fails to land; System health says what an admin must check.
