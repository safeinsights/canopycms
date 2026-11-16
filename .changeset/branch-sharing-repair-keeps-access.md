---
'canopycms': patch
---

### Branch sharing: repairing a branch's metadata keeps who can open it — **security fix, behaviour change**

<!-- migration
area: Branches
action: None
row: Metadata repair keeps branch access
-->

**What changed.** System health's "Repair" used to reset a corrupt branch's access, opening a private branch to everyone where `defaultBranchAccess` is `'allow'` and letting removed people back in. Repair now rebuilds the file field by field, keeping every field that still reads: the status, the pull request, the creator, and the markers that hold a delete or a push for an admin. A field present but unreadable takes its most restrictive value where it holds something back (a status becomes `submitted`, which Withdraw undoes; the merge and GitHub markers hold the delete and the push; an archive time becomes the repair time), and is otherwise dropped. A missing status becomes `editing`; an unreadable or missing creator becomes unknown, which grants nothing. A file that isn't JSON comes back `editing`, open only to admins and reviewers, bar the base branch. Unknown fields carry over. Nothing that decides who can open, edit or delete the branch widens; review and merge rights can, in four cases, and the worker's GitHub sync loses any record it can't read. When the access can't be read, only admins and reviewers can open the branch, keeping removals entry by entry and any lockdown; the base branch, and in development the active branch while its creator reads, take no list, so they stay open unless the damaged file may have limited them, which locks them. The response to `POST /admin/branch-dirs/:dirName/repair-metadata` reports what it kept and reset, answers 409 when another write created the metadata mid-repair, and restores the corrupt file when its own write fails to land; System health says what an admin must check.
