---
'canopycms': minor
---

### Comments and branches name their people for every editor — **behaviour change on two APIs**

<!-- migration
area: Editing
action: Direct API callers
row: Comments and branches name their people
-->

**What changed.** `GET /:branch/comments` adds `users`: the id, name and avatar URL, never the
email, of everyone who wrote or resolved a thread the requester may read. `GET /branches` adds the
same for each listed branch's creator, but not its access list. Every editor now sees those names.
Your auth plugin answers through the `/users/batch` cache; a failed lookup leaves the names out.

**To adopt.** Nothing, unless you call either API yourself: read `data.users`.
