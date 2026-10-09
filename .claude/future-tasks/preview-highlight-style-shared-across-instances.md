---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-09. `usePreviewHighlight` injects one shared `<style id="canopycms-preview-highlight-style">` and each instance removes it whenever its own `enabled` is false, so a second instance that mounts while highlighting is on (a view mounted later, or a page calling `useCanopyPreview` twice) removes the outline for the whole page until the next toggle. Reference-count the style, or move it to one owner
---
# One preview hook instance can remove another's highlight style

**Status:** Open. **Priority: P3.** Filed 2026-10-09 from review round 2 of
`fix/preview-highlight-focus-regression`; the behaviour predates that branch.

## What happens

`usePreviewHighlight` (`packages/canopycms/src/editor/preview-bridge.tsx`) keeps `enabled` in
per-instance state, starting `false`, and its style effect removes the document-wide
`canopycms-preview-highlight-style` element whenever `enabled` is false. A second instance
mounting after the editor turned highlighting on starts at `false` and removes the style the
first instance injected, so the outlines vanish although the toggle reads on. The editor only
re-sends the highlight state on load and on the ready handshake, so it is not restored until
the next toggle.

## Fix

Count the instances that want the style (inject on the first, remove on the last), or have the
style follow a module-level enabled flag set by the message handler.
