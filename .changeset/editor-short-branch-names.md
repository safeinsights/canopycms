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
panel and the toasts. The editor's `?branch=` carries the short name too, as do the preview and its
page link; an old link with the full name still opens the branch, and the editor rewrites it to the
short name. A branch outside the namespace is shown and linked by its full name, except that one
named like a namespace branch's short name is linked as `~<name>` (`%7E<name>` once
percent-encoded), its exact form, which only those links show; System health keeps the full ref and
workspace directory. The editor's API requests name a listed branch by its exact form, an internal
detail: `~` and the full name with each `/` as `~` (`/~canopycms~prod~spring/entries`). Git allows
no `~` in a branch name, so the form reaches the branch shown even when another branch answers to
its short name. Drafts saved in a browser stay with the branch, whichever name opened it.

The New branch field says "Will be named …" only when sanitizing changed what was typed, and shows
why a name is refused under the field, where it used to toast. A name with no letter
(a–z) or digit, such as `_`, is now refused. The "still being set up" answer a create or
open can get names the branch by its short name, not its workspace directory.

**To adopt.** Nothing. A script that reads the editor's `?branch=` gets the short name; the API
accepts it and the full name alike.
