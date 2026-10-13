---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-12. The Clerk plugin leaves a nameless user's name empty instead of using their Clerk id (live lookups and the worker-written cache share clerk-user.ts); personName() makes lookupUsersMetadata (and so lookupUserProfiles, /users/:userId and /users/batch), authResultToCanopyUser, CachingAuthPlugin.authenticate, describeEditors and UserBadge/UserSelector/MemberList treat a blank or id-equal name as no name, so the editor shows "Name unavailable".
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
