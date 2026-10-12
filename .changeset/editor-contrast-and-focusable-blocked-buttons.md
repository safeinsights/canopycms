---
'canopycms': minor
---

### Editor contrast, and blocked buttons stay focusable

<!-- migration
area: Editing
action: Browser tests
row: Editor contrast; blocked buttons stay focusable
-->

**What changed.** Dimmed editor text is `gray.7`, or `dark.1` in dark mode. Filled red buttons
are `red.8`; filled orange, `orange.6` with black text. A blocked Save, Submit, Withdraw, Purge or
menu item is `aria-disabled`, not `disabled`, so its reason shows on focus. The header's entry
menu says "Reload entry" and "Discard changes".

**To adopt.** A `themeOverride` setting `components.Button.vars` replaces the editor's filled red
and orange Button resolver, and one setting `components.Alert.vars` replaces the resolver that
gives a light yellow Alert's title, icon and close button the text colour.
Browser tests check `aria-disabled`; Playwright's `toBeDisabled` reads it. Tests that click the
old "Reload File" or "Discard File Draft" use the new labels.

**Now deletable.** Local overrides that darkened the same text or buttons.
