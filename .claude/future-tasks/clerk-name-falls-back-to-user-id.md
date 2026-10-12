---
priority: P2
adopters: BOTH
summary: >-
  The Clerk auth plugin names a user with no full name and no username by their Clerk id (`name: fullName ?? full_name ?? username ?? id` in clerk-plugin.ts and cache-writer.ts). That id flows through the user lookups into comment and branch `users`, and UserBadge shows it as a real name to every editor, against docs/ux-guidelines.md's People rule.
---

# The Clerk plugin uses a user id as their name

`packages/canopycms-auth-clerk/src/clerk-plugin.ts` (`mapClerkUserData`) and
`packages/canopycms-auth-clerk/src/cache-writer.ts` both fall back to the Clerk user id for
`name`. An email-only sign-up therefore reads as `user_2ab…` on the owner line, as a comment
author and on branch cards, in the same style as a real name. `UserBadge` shows its
"Name unavailable" fallback only when there is no record at all.

Found by the round-2 review of PR 532 (the People-rule conformance work).

## Fix

Leave `name` empty (or omit it) when Clerk has none, and have `UserBadge` treat an empty name as
unresolved, so it shows the fallback; or drop profiles whose name equals their id in
`lookupUserProfiles` (`packages/canopycms/src/auth/user-metadata-lookup.ts`). `UserSearchResult`'s
`name` is typed `string`, so check every consumer of an empty one (search results, the
`Remove <name>` label).

## Done when

A Clerk user with no name shows "Name unavailable" everywhere, and no surface shows a Clerk id as
visible person text.
