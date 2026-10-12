---
priority: P3
adopters: NEITHER
summary: >-
  `useCommentSystem`'s `canResolveComments` option (`editor/hooks/useCommentSystem.ts`) is accepted but never read. Editor.tsx passes it `canResolveAnyComment`; the real gate is the `canResolve` prop each comment surface receives. Remove the option, or use it, so the hook's signature says what it does.
---

# `useCommentSystem` takes a `canResolveComments` it never reads

## What is known

- Who may resolve is decided in `Editor.tsx` (`canResolveAnyComment`: reviewers and admins, plus
  a thread's own author in `comments/ThreadReplyControls.tsx`) and passed to each surface as
  `canResolve`.
- The hook's option is a leftover with no reader.

## Done when

The option is gone from `UseCommentSystemOptions` and its callers, or something reads it.
