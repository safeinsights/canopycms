---
'canopycms': minor
---

### The editor's top bar, with Save all — **behaviour change**

<!-- migration
area: Editing
action: Editor UI tests
row: Top bar redesigned; Save all; reload items renamed
-->

**What changed.** The editor's header is a 48px top bar. Its breadcrumb's crumbs navigate: "All
content" opens the content panel, and a collection crumb opens it on that collection. The open
entry's crumb holds the entry menu, whose "Reload entry" is now "Refresh from server". A
"Read-only" chip says why the entry or branch takes no edits. The branch pill shows the branch,
its status and how many entries are unsaved, and its menu lists them; its "Reload all entries" is
now "Refresh branch" and re-reads the entry list too. Beside Save, a caret offers "Save all", which
saves every unsaved entry on the branch and names any it could not save, with the reason, keeping
their changes. The site title and `editor.subtitle` no longer appear in the header; the rail's
monogram carries the site title. Below 62em the breadcrumb takes its own row and the actions wrap, so no control is clipped. A content save refused because the
branch is mid-rebase now carries `code: 'BRANCH_SYNCING'`.

**To adopt.** Nothing, unless your browser tests find the header by its old text: "Reload entry",
"Reload all entries", "Recently modified", "No entry selected", or the file menu's "All content"
item, which the breadcrumb's "All content" replaces.
