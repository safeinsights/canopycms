---
priority: P3
adopters: NEITHER
summary: >-
  Gaps in the editor UX ratchets (`lint:a11y`, `lint:ux-copy`): suppressions for deleted files
  never fail, a label naming a UI element ("the Tasks tab") is a Title Case false positive, and
  `lint:a11y`'s single-quoted glob breaks under cmd.exe
---
# Editor UX ratchets: known gaps

Found by review of the guardrails PR; none blocks current work.

1. **Stale a11y suppressions for deleted files never fail.** ESLint builds its unused-suppression
   list only from files it linted (`SuppressionsService.applySuppressions` in
   `eslint/lib/services/suppressions-service.js`), so an entry in `scripts/a11y-suppressions.json`
   for a deleted file lingers until someone runs `pnpm lint:a11y --prune-suppressions`. Fix: a
   small check in `lint:a11y` that every key in the file exists on disk.
2. **UI-element names read as Title Case.** `scripts/check-ux-copy.mjs` flags "retry from the
   Tasks tab" (`admin/SystemHealthPanel.tsx`), where "Tasks" is a tab's label. Decide in
   `docs/ux-guidelines.md` how copy refers to a named control (quotes, which the checker already
   exempts, or bold), then apply it and re-record the baseline.
3. **`lint:a11y` on Windows.** The glob in `package.json` is single-quoted, which cmd.exe passes
   to ESLint literally ("No files matching"). Only matters if Windows becomes a dev target; the
   fix is double quotes, escaped in JSON.
