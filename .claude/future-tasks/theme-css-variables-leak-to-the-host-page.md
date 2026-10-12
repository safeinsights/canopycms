---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from PR 532's UX review. `CanopyCMSProvider`'s `MantineProvider` writes the editor theme's CSS variables, now including `--mantine-color-dimmed`, at `:root`, so on a page that mounts the editor they also restyle host-app Mantine UI. Scope them with `cssVariablesSelector` to the editor root
---
# Editor theme variables leak to the host page

`CanopyCMSProvider` (`packages/canopycms/src/editor/theme.tsx`) renders a `MantineProvider`, which
emits every theme variable at `:root`. The `canopyCssVariablesResolver` added
`--mantine-color-dimmed`, so a host app on the same page that also uses Mantine now gets the
editor's dimmed colour. `CLAUDE.md` says not to mix editor styling into the host app.

Consider `MantineProvider`'s `cssVariablesSelector` (and `getRootElement`) scoped to the editor's
root element, then check that portalled UI (modals, drawers, tooltips, notifications) still
resolves the variables, since portals sit outside the editor root. `withinPortal` targets or a
`portalProps.target` inside the root would be needed.
