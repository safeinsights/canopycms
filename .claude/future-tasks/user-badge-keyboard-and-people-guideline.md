---
priority: P3
adopters: BOTH
summary: >-
  UserBadge keeps a person's email (for admins) and "Name unavailable" only in a hover tooltip that keyboard and screen-reader users cannot reach. docs/ux-guidelines.md has no rule on how a person is shown, decorative images, or tooltip-only information. The editor could also name the signed-in user from whoami with no lookup
---
# UserBadge keyboard access, and a "People" rule for the UX guidelines

Found by the UX review of the comment-author-names work (`feat/comment-author-names`), which
made names on comment surfaces visible to every editor.

## Findings

1. **Tooltip-only details.** `editor/components/UserBadge.tsx` wraps the badge in a Mantine
   `Tooltip` on a plain, unfocusable element. An admin's email and the fallback's
   "Name unavailable" / "Couldn't load this name" reach mouse users only. Fix: put the detail in
   visually hidden text tied to the badge (`aria-describedby`), or make a badge that carries a
   tooltip focusable.
2. **The signed-in user's own name.** A comment by the signed-in user still needs the comments
   response (or a privileged lookup) to be named. When that response's lookup failed, a user
   sees their own comment as an id. `useUserContext` knows the current user; seeding their
   profile into the `canopy:user:` cache (`seedUserProfiles`) would name them with no request,
   if whoami returns a name.

## Guideline gaps

`docs/ux-guidelines.md` doesn't cover these:

- how a person is shown, and what to show when a name cannot be resolved;
- whether a raw user id counts as an internal name;
- alt text for decorative images such as avatars;
- information that lives only in a tooltip on an element keyboard users cannot focus.

A short "People" section would settle these, and the deliberate split where a branch's access
users stay ids for editors while its owner is named
([branch-owner-names-for-editors.md](resolved/branch-owner-names-for-editors.md)).
