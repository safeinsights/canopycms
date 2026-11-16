---
'canopycms': patch
---

### Share the open branch from the top bar, and a new branch as you create it

<!-- migration
area: Editing
action: None
row: Share… in the top bar and the New branch form
-->

**What changed.** The top bar leads its actions with the open branch's sharing control: who has access as avatars (a globe when everyone who can sign in may open it) and "Share…", or "Who has access" for someone who may open the branch but not add people. Below the `md` breakpoint it moves into the branch menu. The New branch form has an optional "Share with" field, and once the branch exists the Branches drawer, or the toast if the drawer has closed, offers "Share…" for it. A create refused because you may not create branches, or because of someone you chose, now says why in the form and keeps what you typed; the refusal carries the new code `BRANCH_CREATE_FORBIDDEN`. Someone found by their full email address who doesn't work in this CMS is now added by that address, which the server accepts, rather than refused as out of scope.
