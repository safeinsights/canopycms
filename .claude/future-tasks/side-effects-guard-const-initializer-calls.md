---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-09. `package-side-effects.test.ts` does not count a call in a `const` initializer, so `const _ = install()` passes it, and bundlers then drop that module's effect. Measure an "unused const with a call" heuristic, or keep the convention
---
# The side-effects guard does not see an import-time call hidden in an unused `const`

**Status:** Open. **Priority: P3.** Filed 2026-10-09 from
[root-entry-tree-shaking.md](resolved/root-entry-tree-shaking.md).

## State

`packages/canopycms/src/package-side-effects.test.ts` requires that the modules with a top-level
statement that runs code equal the `sideEffects` list in `package.json`. It does not count a call
inside a `const` initializer, because such a call usually constructs a value, and a module whose
value is used is kept anyway. Its header tells authors to write an import-time effect as a
statement, never as `const _ = install()`.

That rule is a convention. A module that registers a getter or polyfill through
`const _ = install()`, with `_` never read, passes the test. A bundler then drops the module
whenever nothing imports its exports, and the effect silently never runs.

## Options

- Flag a top-level `const` whose initializer contains a call and whose binding is neither exported
  nor referenced elsewhere in the module. Measure the false positives across `src/` before
  adopting it: zod schemas and loggers built at top level are referenced, so they should not trip
  it.
- Or leave the convention as the guard, and accept the gap.
