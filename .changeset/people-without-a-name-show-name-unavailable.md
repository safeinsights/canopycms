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

**What changed.** The Clerk plugin no longer uses the Clerk user id as a user's name: a user with no full name or username has an empty name, and the editor shows "Name unavailable" wherever that person appears. Core and the editor also treat any auth plugin's name that equals the user id as no name. The users snapshot the worker writes follows the same rule.
