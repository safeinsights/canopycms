---
'canopycms': patch
---

### Approve and Request changes pin the commit the reviewer saw — **behaviour change**

<!-- migration
area: Branches
action: None
row: A review is refused once the branch moved
-->

**What changed.** Approve and Request changes now send the commit the reviewer's page showed, and
the API refuses either one when the branch has moved since: "This branch changed since you opened
it. Review the latest changes." The editor then reloads the branch, keeping a Request changes
note for the next try. An approval records its commit, and the worker sends an approved branch
back to review when commits come in that are more than that commit with the base merged in. An editor tab opened before this
release is refused the same way until the page is reloaded.
