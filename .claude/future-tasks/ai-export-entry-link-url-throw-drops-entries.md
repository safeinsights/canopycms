---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-14. The AI export drops every entry whose body links a target that `entryLinkUrl` throws for. The first-pass body resolution in `collectEntries` runs even when no `exclude.where` is set, and it runs inside the per-entry catch. The render-loop resolution sits outside `renderAll`'s try, so a resolver that throws only on a second call would reject the whole run
---

# AI export: a throwing `entryLinkUrl` drops body-linking entries before rendering

**Status:** Open. **Priority: P3.** Filed 2026-10-14 from review round 3 of PR #553 (the AI
export's `referenceLink` hook). The behaviour predates that PR; the PR leaves it as it is.

## State

`collectEntries` in `packages/canopycms/src/ai/generate.ts` resolves each MD/MDX body's
`entry:` links with the site's `entryLinkUrl` so that `exclude.where` sees them resolved. It
does this for every entry, even when `exclude.where` is unset, and it does it inside the
per-entry `try`. When `entryLinkUrl` throws for one target, every entry whose body links that
target is logged as "skipping entry" and left out of the export, its `all.md` and its bundles.

A reference field to the same target fails later, in `renderAll`, which also skips the
entry, so both paths drop it. But a body link takes the entry out of the export set, while a
reference keeps it in that set until its render fails.

The resolution inside the render rounds (`resolveEntryLinksInText(pending.body, ...)` in the
`for (;;)` loop) runs outside `renderAll`'s `try`. A resolver that succeeded in the first pass
and throws on a later call would reject the whole `generateAIContent` call, not one entry.

## Fix sketch

- Resolve body links in the first pass only when `config.exclude.where` is set.
- Move the render-round resolution inside the per-entry `try`, so a throw skips that entry
  the way a render throw does.
- Decide whether a throwing `entryLinkUrl` should drop the entry at all, or render that link
  as `#` with a warning. Today the answer differs only by where the link sits.
