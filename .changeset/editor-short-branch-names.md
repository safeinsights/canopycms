---
'canopycms': minor
---

### The editor shows a branch by its short name

<!-- migration
area: Branches
action: None
row: The editor shows and links branches by short name
-->

**What changed.** For a branch in the [branch namespace](./branches-created-in-namespace.md), the
editor shows `spring` where it showed `canopycms/prod/spring`: on the branch pill, the Branches
drawer, the Submit for review, Withdraw, Approve, Request changes and Delete dialogs, the comments
panel and the toasts. The editor's `?branch=` carries the short name too, and its API requests go to
`/spring/entries` rather than `/canopycms%2Fprod%2Fspring/entries`; an old link with the full name
still opens the branch, and the editor rewrites it to the short name. A branch outside the
namespace keeps its full name everywhere, as do System health and pull request links to GitHub.
Drafts saved in a browser stay with the branch, whichever name opened it.

The New branch field says "Will be named …" only when sanitizing changed what was typed, and shows
the server's refusal of a name under the field, where it used to toast. A name with no letter or
digit (`_`) is now refused, as its message always said. The "still being set up" answer a create or
open can get names the branch by its short name, not its workspace directory.

**To adopt.** Nothing. A script that reads the editor's `?branch=` gets the short name; the API
accepts it and the full name alike.
