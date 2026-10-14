---
priority: P3
adopters: NEITHER
summary: >-
  The busy-lock 409s still show red: the schema editor's (all `SchemaStoreBusyError`), the groups and permissions managers' "Settings are busy", and the admin branch-health repairs. They are not edit conflicts, which docs/ux-guidelines.md rules yellow, so they need a look of their own decided first
---

# Busy-lock 409s: which colour

[Colour and contrast](../../docs/ux-guidelines.md#colour-and-contrast) rules a 409 conflict
yellow, since nothing is lost yet. The group and permission managers now show their version
conflict yellow (code `SETTINGS_CHANGED`) and leave "Settings are busy" red. A busy lock is a
retry, not a conflict: the schema editor's 409s (`SchemaStoreBusyError`), the settings busy
409 and the admin branch-health repairs' 409s all show red, and the guidelines don't yet say what
a busy refusal looks like. Done when the rule exists and these follow it.
