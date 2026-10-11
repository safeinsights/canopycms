---
name: ux-review
description: Review a CanopyCMS PR or branch's editor UI changes against docs/ux-guidelines.md — guideline read-through, Storybook screenshots and a hands-on walk of the flow in apps/example1. Use on any change touching packages/canopycms/src/editor/, as a /review-rounds pass, or when asked to "UX review" a branch.
---

# UX review of an editor change

1. **Find the base.** For a PR, its base branch (`gh pr view --json baseRefName`); otherwise
   the branch point, found as `branch-review` does. If
   `git diff <base>...HEAD --quiet -- packages/canopycms/src/editor` exits 0, nothing in the
   editor changed: say so and stop.
2. **Spawn the `ux-review` agent** (`.claude/agents/ux-review.md`, Opus) with the base ref and,
   for a PR, its number. In a `/review-rounds` run, alternate it with Fable between rounds, and
   point a later round at the previous round's fixes. Pass through anything the user named:
   flows, users, breakpoints.
3. **Relay its report** unchanged in shape: severity-ordered findings, each with a
   recommendation and screenshot, then the consolidated fix set and any guideline gaps. Attach
   the screenshots with `SendUserFile`.
4. **Guideline gaps are not fixes.** A gap means `docs/ux-guidelines.md` is silent or wrong;
   propose the wording change separately, since the doc is word-budgeted (`pnpm lint:docs`).

The agent only reads and runs dev servers; fixing is a follow-on, as with `branch-review`.
