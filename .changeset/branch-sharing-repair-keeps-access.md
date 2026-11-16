---
'canopycms': patch
---

### Branch sharing: repairing a branch's metadata keeps who can open it — **security fix, behaviour change**

<!-- migration
area: Branches
action: None
row: Metadata repair keeps branch access
-->

**What changed.** System health's "Repair" used to reset a corrupt branch's access, opening a private branch to everyone where `defaultBranchAccess` is `'allow'` and letting removed people back in. Repair now rebuilds the file field by field: every field that still reads is kept, including the status, the pull request, the creator and the markers that hold a delete or a push for an admin. A field that can't be read takes its most restrictive value where it holds something back (a status becomes `submitted`, which Withdraw undoes; a creator becomes unknown, which grants nothing; the merge and GitHub markers hold the delete and the push), and is otherwise dropped; an archive time that can't be read becomes the repair time, so deletion by age doesn't count from an older merge. Unknown fields are carried over. Review and merge rights can still widen: unreadable submit, sync or pull-request state is dropped, and reviewers can act on a status read as `submitted`. When the access can't be read, only admins and reviewers can open the branch, keeping removals entry by entry and any lockdown; the base branch, and in development the active branch, take no list, so they stay open unless the damaged file may have limited them, which locks them to admins and reviewers. The response to `POST /admin/branch-dirs/:dirName/repair-metadata` reports what it kept and reset, answers 409 when another write created the metadata mid-repair, and puts the corrupt file back when its own write fails; System health says who can open the repaired branch and what an admin still has to check.
