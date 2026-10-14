---
priority: P3
adopters: NEITHER
summary: >-
  The reference app's post preview crashes on a new post with no tags (`liveData.tags.map` on undefined in `apps/example1/app/components/PostView.tsx`), and it renders a `published` boolean as "Published"/"Draft", which teaches the per-entry draft flag ARCHITECTURE.md rules out
---
# example1's post preview: missing tags crash, and a "Draft" label

## Priority: P3 [NEITHER]

## Problem

- `apps/example1/app/components/PostView.tsx` maps `liveData.tags` without a guard, so the live
  preview of every newly created post (no tags yet) throws "Application error".
- The same view shows `liveData.published ? 'Published' : 'Draft'` from the example schema's
  `published` boolean. Publish state is branch-only (ARCHITECTURE.md, "Publish State Is
  Branch-Only"), and the reference app is what adopters copy, so it should not model a draft
  flag.

## Fix

Default `tags` to an empty list in the view, and drop the `published` field and its label from
the example schema, its content and the view (a `stampOnPublish` `publishedAt` is the field to
show instead, if the example wants a date).

## Trigger

The next change to example1's post schema or preview.
