---
'canopycms': patch
'canopycms-auth-clerk': patch
'canopycms-auth-dev': patch
---

### Find people to share a branch with, by name or exact email address — **security fix**

<!-- migration
area: Branches
action: Optional
row: Finding people to share with; searchable, addableByEmail
-->

**What changed.** The API can now find people to share a branch with, for the share dialog to come:

- **Who has access.** `GET /:branch/access` names everyone on a branch's list. Admins and reviewers see full email addresses; everyone else sees masked ones (`b•••@example.org`), and only for people who work in this CMS.
- **Finding people.** A name matches from the start of the name or of a word in it; an email address finds only an exact match. `POST /:branch/access/find` and, for a branch not yet created, `POST /branches/access/find` take the query in the body. Each person gets 20 email lookups per 10 minutes on each server, and each lookup is logged without the address.
- **Adding by email.** `PATCH /:branch/access` and a branch create accept `add.emails`, which, under the default `addableByEmail`, can add someone who has never opened the editor.
- **Who counts as working in this CMS** now includes anyone who opened the editor while in a non-reserved internal group, or a provider group a path permission names. An admin can remove that record with `DELETE /admin/people/:userId/seen`.
- **Creating branches** follows the path permissions (read from the settings branch) and `defaultPathAccess`: admins, reviewers, anyone the edit default allows, and anyone some rule's edit target admits. A site with no rules whose edit default is `'deny'` now leaves it to admins and reviewers; before, anyone signed in could create branches there, and wherever the base branch held no permissions file.
- **Auth plugins** may implement `findUserByEmail`; the Clerk and dev plugins do.

**To adopt.** Nothing is required. `branchSharing.searchable` (default `'cms-users'`) and `branchSharing.addableByEmail` (default `'all-users'`; `'cms-users'` is stricter) choose whom people can find; see [the configuration reference](../README.md#configuration-reference).
