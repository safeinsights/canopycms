---
priority: P3
adopters: BOTH
summary: >-
  The media library's delete-failure alert has only Dismiss: no Retry button, and for admins the raw diagnostic replaces the next step instead of sitting on its own dimmed line as the load-error alert does. Neither the delete-failure states nor QuickOpenPalette's returnFocusTo have a story.
---

# Media delete-failure alert: Retry, diagnostic line, stories

## What is known

- `editor/media/MediaLibraryBody.tsx` renders the delete failure (`actionError`) as one string
  in an Alert with Dismiss. The load-error Alert in the same file has a plain sentence, an
  admin-only dimmed `xs` diagnostic line, and a Retry button. docs/ux-guidelines.md States asks
  for Retry on a failure the user can retry.
- A 403 (not the uploader) is permanent and has its own sentence; Retry would only suit the
  other failures.
- `MediaLibrary.stories.tsx` has no delete-failure story (admin or not), and
  `QuickOpenPalette.stories.tsx` has none that passes `returnFocusTo`.

## Done when

The delete-failure alert matches the load-error alert's shape, with Retry for retryable failures,
and both states have stories.
