# [P3] Comment-budget guard: scope gaps and counting-rule edges

**Status:** Open. Filed 2026-09-13 from the manager's review of the guard PR in
[baseline-quality-202609.md](resolved/baseline-quality-202609.md); none of these changes what the
ratchet measures today, so they wait for a maintenance pass.

## Scope gaps in `scripts/check-comment-budget.mjs`

- `apps/` is outside the comment budget entirely.
- Root-level config sources are outside it too, and already carry what the style rule forbids:
  `lint-staged.config.mjs` lines 2-4 are a dated history comment ("missing here until
  2026-08-22"), and `vitest.shared.ts` lines 23-30 narrate a past CI incident. Found by the
  `docs-developing` run in the bookkeeping PR.
- `PACKAGE_ROOTS` is hardcoded, so a new `packages/<x>/src` is silently unbudgeted. Contrast
  the "add it" guard, which fails loudly for a new directory inside a known package. Derive
  the roots from `packages/*/package.json` lint globs, or fail when a package directory has
  no entry.
- Test scaffolding is still budgeted as source: `editor/test-setup.ts`,
  `editor/setup-test-dom.ts`, `operating-mode/deployment-name-fixtures.ts`,
  `url-exclusivity-fixtures.ts`. Decide on a basename or directory convention and exclude it.

## Counting-rule edges

- A multi-line block directive (`/* eslint-disable ...` spanning lines) counts every line
  after the first as code, since only the opening line matches the directive pattern.
- A block comment opened after code on the same line never sets the in-block state, so its
  continuation lines count as code.
- A template literal containing lines that start with `//` counts those lines as comments.

## `scripts/check-docs.mjs`

- "stale doc budget" only checks that the path exists, not that it is still in scope.
- `findLongListItems` ends an item at a blank line, so a list item continued after a blank
  line is measured as two items.
- `--list-long-items` is not mentioned in the warning line it extends.
- A budget entry with a MISSING key is silently unchecked: the marker check guards on
  `historyMarkers !== null`, so deleting `words` or `historyMarkers` from an entry drops
  that check with no complaint. Require `words` and `maxSectionWords` to be numbers and
  `historyMarkers` a number or null, and fail otherwise.
- The 25-word cap sees only list items and table cells; `packages/canopycms/src/AGENTS.md`'s
  Overview is an 800-word single paragraph it never observes.
