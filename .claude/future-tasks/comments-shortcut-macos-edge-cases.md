---
priority: P3
adopters: BOTH
summary: >-
  The Mod+Alt+M comments shortcut has two macOS gaps. In Firefox, ⌘⌥M also toggles Responsive Design Mode whenever the handler returns before `preventDefault` (no form on screen, or focus in another overlay). On AZERTY, matching by physical key means the key labelled M does nothing while the tooltip says ⌘⌥M.
---

# Comments shortcut: macOS edge cases

`packages/canopycms/src/editor/comments/form-comments.tsx` binds Mod+Alt+M through
`useHotkeys` with `preventDefault: false`; `onShortcut` calls `preventDefault()` only once it
knows it will act.

## Firefox's ⌘⌥M

Firefox on macOS binds ⌘⌥M to Responsive Design Mode. When `onShortcut` returns early (no
`[data-form-renderer]` around the trigger, or focus inside another overlay), the browser
default runs and the page reflows into the device toolbar. Options: always `preventDefault`
on macOS while the editor is mounted, or choose a different chord for macOS.

## AZERTY and the physical-key match

On macOS the binding matches `KeyM` by position (`usePhysicalKeys: true`), because ⌥ turns M
into another character. On a French AZERTY layout the key labelled M sits at the `Semicolon`
position, so it does nothing, while the key at `KeyM` (labelled ",") opens comments. The
tooltip and `aria-keyshortcuts` still say ⌘⌥M. Options: also match `event.key` against the
layout's unmodified M via `navigator.keyboard.getLayoutMap()` where available, or label the
tooltip from that layout map.

## Done when

Neither gap reproduces in Firefox on macOS or with an AZERTY layout, and the tooltip names the
key that works.
