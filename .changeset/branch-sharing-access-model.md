---
'canopycms': patch
---

### Branch creators and the people they share with manage a branch's access list — **security fix, behaviour change**

<!-- migration
area: Branches
action: Optional
row: Branch access lists: sharing rules, branchSharing config
-->

**What changed.** A branch's access list now follows one set of sharing rules, enforced by the server:

- **Who changes it.** The branch's creator manages the list while they still have access. People on the list can add others but remove only the people they added. Admins can do everything, and can leave a list to admins alone.
- **Removals stick.** A person the creator or an admin removes can't open the branch, even through a group, and only the creator, or an admin when an admin removed them, can let them back. A removed group can't be added back by the people on the list. A creator an admin locked out or left off the list can no longer change it, add themselves back, or delete the branch.
- **Lists never reopen.** A shared branch stays restricted to its list even when the list is emptied.
- **Who can be added.** Non-admins can add only people who already work in this CMS, and only groups they belong to.
- **Who sees the list.** Anyone who may open a branch now sees its whole list.
- **Errors.** A refused change, or a refused branch request, carries a `code` such as `BRANCH_ACCESS_DENIED` or `USER_EXCLUDED`.
- **Request shape.** `PATCH /:branch/access` takes the change (people to add and remove) instead of the whole list, and so does the `access` field of a branch create.

**To adopt.** Nothing is required. To let only a branch's creator add people, set `branchSharing: { whoCanAdd: 'owner' }`; see [the configuration reference](../README.md#configuration-reference).
