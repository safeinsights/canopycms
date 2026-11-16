---
'canopycms': patch
---

### Branch sharing: coded refusals everywhere, and fixes from its final review — **behaviour change**

<!-- migration
area: Branches
action: None
row: Branch refusals carry codes; sharing fixes
-->

**What changed.**

- **Codes for API callers.** Content and entry routes (read, save, validate references, rename, list, delete, restore, resolve a conflict), and Withdraw, Submit, Get latest changes and Delete, now refuse someone the branch's access check turns away with `code: 'BRANCH_ACCESS_DENIED'`, or `'BRANCH_LOCKED_DOWN'` for someone a lockdown alone keeps out, still as a 403. The content and entry routes check branch access first, so such a caller gets that 403 even for a path they couldn't otherwise use.
- **`'all-users'` search.** Where `branchSharing.searchable` is `'all-users'`, non-admins can add by name anyone the search finds, as they share or create a branch.
- **Rules.** An admin's removal of someone the owner already removed makes it an admin's, which only an admin can lift. People on a list can remove the people they added while only the owner may add.
- **Find and change agree.** Both take addresses with non-ASCII letters, and refuse an archived or base branch with the same code.
- **The Share dialog.** Opening a branch to everyone says that the people removed from it stay out. The warning about limiting a branch names, from `GET /:branch/access`'s new `losingAccess`, only people who would really lose access. "Who has access" lists an unlisted branch's owner on closed sites and keeps Esc working after Tab. Refusals, lookups and warnings reach screen readers.
- **`canopycms init`.** The config template says an admin must add an edit rule before editors can create branches.
