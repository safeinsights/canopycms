---
priority: P3
adopters: BOTH
summary: >-
  Code only: docs/ux-guidelines.md now has a People section. UserBadge keeps an admin's email and "Name unavailable" in a hover-only tooltip, shows the raw id as a fallback name, and the batcher's `null` on failure drops good cached names; the editor could also name the signed-in user from whoami.
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
3. **Batcher answers failure with `null`.** `editor/hooks/user-metadata-batcher.ts` resolves every
   id to `null` when `/users/batch` fails, so SWR replaces a good cached record with `null` and
   the badge drops to an id. Rejecting instead would keep the last good record.
4. **The fallback shows the raw id.** When a name can't be resolved, `UserBadge` renders the
   `userId` as the visible text, with "Name unavailable" or "Couldn't load this name" only in the tooltip. The People rule
   in [docs/ux-guidelines.md](../../docs/ux-guidelines.md#people) counts an id as an internal
   name: show the fallback text instead.
