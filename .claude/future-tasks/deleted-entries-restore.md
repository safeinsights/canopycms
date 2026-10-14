---
priority: P3
adopters: BOTH
summary: >-
  Unpublishing is deleting the entry on a branch and merging it; bringing it back takes a developer running `git revert`. Proposed: a "Deleted entries" list built from the branch's git history, and a restore action that runs the normal write pipeline
---
# Restore deleted entries from the editor

## Priority: P3 [BOTH]

## Problem

Publish state is branch-only (ARCHITECTURE.md, "Publish State Is Branch-Only"), so unpublishing is
a delete on a branch. Delete is a working-tree unlink (`content-store.ts` `delete`), and nothing in
the editor can bring an entry back: a developer restores it with `git revert`, on a branch created
after the deletion merged.

## Proposed design

- `GET /:branch/deleted-entries`: `git log --no-renames --diff-filter=D` over the content root in
  the branch clone (clones keep full history; partial clones are refused). `--no-renames` matters:
  rename detection pairs a deletion with a similar new entry and hides it. Exclude IDs present in
  the tree, filter by read ACL, read each title from the blob at `<commit>^`, paginate, and cache
  by HEAD, since the branch's own commits add deletions. Uncommitted deletes are not listed.
- `POST /:branch/restore-entry { contentId, commit }` through a `ContentStore.restoreRaw` that runs
  what a create runs: edit permission on the target, `validateEntry`, the markdown-safety policy,
  the create and duplicate-ID guards, and editor recording. Resolve the parent collection by its ID
  through the ID index, because the deleted path embeds collection directory IDs that may have been
  renamed. Refuse clearly when the collection is gone or the slug is taken.
- The delete dialog says the entry leaves the live site when the branch is published and can be
  restored from Deleted entries.
- A one-click "unpublish and keep a draft branch" cannot happen at delete time: the draft branch
  must be created after the deletion merges, or its rebase drops the entry.

## Trigger

A non-developer editor asks to bring an unpublished entry back, or the second such request.

## Related

- [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md)
- [draft-publish-lifecycle.md](draft-publish-lifecycle.md)
