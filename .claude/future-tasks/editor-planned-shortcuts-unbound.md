---
priority: P3
adopters: BOTH
summary: >-
  docs/ux-guidelines.md Keyboard lists Mod+S save, Mod+. content panel and Mod+Shift+L layout as planned for WS8: nothing in the editor binds them; only Mod+P (quick open) and Mod+Alt+M (comments) are bound, both on the document rather than the editor root. They belong to WS8's B12 shortcuts work.
---

# Planned editor shortcuts are not bound yet

Found while blocked Save moved to `aria-disabled` (PR B of the UX-rulings chip): there was no
Save shortcut to keep. `useHotkeys` appears only in `editor/components/QuickOpenPalette.tsx`
(Mod+P) and `editor/comments/form-comments.tsx` (Mod+Alt+M).

The design is B12 in [ui-epic-202610.md](ui-epic-202610.md): `mod+…` through Mantine's
`useHotkeys`, Save with `tagsToIgnore: []` and `triggerOnContentEditable: true`, and a cheat
sheet in the Settings menu. It is scheduled as part of WS8.

## Done when

Mod+S saves (a no-op with its reason when Save is blocked), Mod+. toggles the content panel,
Mod+Shift+L toggles layout, the guideline's Keyboard list moves them from planned to taken, and
every binding, Mod+P and Mod+Alt+M included, listens on the editor root, not the document.
