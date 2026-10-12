---
priority: P3
adopters: BOTH
summary: >-
  The Mod+P quick-open palette never announces its armed option (`aria-activedescendant` is set
  only by the arrow keys, not by the `selectFirstOption` the palette calls as you type), and on
  non-Latin keyboard layouts Mod+P never matches (Mantine compares `event.key`), so the browser's
  print dialog opens instead
---
# Quick-open palette: announced option and non-Latin layouts

`packages/canopycms/src/editor/components/QuickOpenPalette.tsx`.

## Armed option is not announced

The palette arms the first option with `combobox.selectFirstOption()` whenever the query
changes, so Enter opens the best match. Mantine's combobox target only updates its
`selectedOptionId` state, which drives `aria-activedescendant`
(`use-combobox-target-props.mjs`), from its own ArrowUp and ArrowDown handlers. So:

- On open, a screen reader announces no option, although one is visibly armed.
- After ArrowDown and then typing, `aria-activedescendant` points at an option id that was
  re-armed away or removed.

Fix: set `aria-activedescendant` from the store's selected index yourself (read the armed
option's id after `selectFirstOption`), or drive selection through the store API that updates
the target. Verify with a screen reader, not only jsdom.

## Non-Latin layouts

`useHotkeys` matches `event.key`. On a Russian layout the key labelled P reports `з`, so
Mod+P does not match and the browser prints. `usePhysicalKeys: true` matches `event.code`
(`KeyP`) instead, at the cost of binding a physical key position on layouts such as AZERTY or
Dvorak. Decide which matters more, ideally alongside WS8's other shortcuts (Mod+S and the
rest), so every editor shortcut behaves the same way.
