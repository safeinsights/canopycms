---
'canopycms': minor
'canopycms-auth-clerk': minor
'canopycms-auth-dev': minor
---

### Find people to share a branch with, by name or exact email address — **security fix**

<!-- migration
area: Branches
action: Some sites add edit rules
row: Finding people to share with; branch creation follows edit rules
-->

**What changed.** The API can now find people to share a branch with, for the share dialog to come:

- **Who has access.** `GET /:branch/access` names everyone on a branch's list. Admins and reviewers see full email addresses; everyone else sees masked ones (`b•••@example.org`), and only for people who work in this CMS.
- **Finding people.** Names match from the start of a word; an email address needs an exact match. `POST /:branch/access/find` and, for a branch not yet created, `POST /branches/access/find` take the query in the body. Each person gets 20 email lookups per 10 minutes on each server, and each lookup is logged without the address.
- **Adding by email.** `PATCH /:branch/access` and a branch create accept `add.emails`, which, under the default `addableByEmail`, can add someone who has never opened the editor.
- **Who counts as working in this CMS** now includes anyone who opened the editor while in a non-reserved internal group, or a provider group a path permission names. An admin can remove that record with `DELETE /admin/people/:userId/seen`.
- **Creating branches** follows the path permissions (read from the settings branch) and `defaultPathAccess`: admins, reviewers, anyone the edit default allows, and anyone some rule's edit target admits. Before, anyone signed in could create branches wherever the base branch held no permissions file.
- **Auth plugins** may implement `findUserByEmail`; the Clerk and dev plugins do.

**To adopt.** If your site has no `edit` rule and its edit default isn't `'allow'` (for example `defaultPathAccess: { read: 'allow' }`), only admins and reviewers can now create branches: as an admin, add an `edit` rule for your editors in the Permission Manager. Other sites need nothing. `branchSharing.searchable` (default `'cms-users'`) and `branchSharing.addableByEmail` (default `'all-users'`; `'cms-users'` is stricter) choose whom people can find; see [the configuration reference](../README.md#configuration-reference).
