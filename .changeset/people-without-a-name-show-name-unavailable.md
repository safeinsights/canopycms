---
'canopycms-auth-clerk': patch
'canopycms': patch
---

### People without a name show "Name unavailable"

<!-- migration
area: Auth
action: None
row: Clerk users without a name no longer show their id
-->

**What changed.** The Clerk plugin no longer uses the Clerk user id as a user's name: a user with no full name or username has an empty name, and the editor shows "Name unavailable" wherever that person appears. Core and the editor also treat a blank name, or one equal to the user id, as no name: `/users/:userId`, `/users/batch` and the `users` lists on comments and branches return an empty `name` for that person. The users snapshot the worker writes follows the same rule.
