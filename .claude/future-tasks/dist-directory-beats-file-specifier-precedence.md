# `add-js-extensions.mjs` resolves a directory before a same-named file

Found 2026-08-20 in an adversarial review of
[dts-extensionless-imports-break-nodenext.md](resolved/dts-extensionless-imports-break-nodenext.md).
Pre-existing for `.js`; that fix doubled the exposed surface by extending the rewrite to
`.d.ts`, which is why it is worth writing down now rather than later.

## What's wrong

`scripts/add-js-extensions.mjs` expands an extensionless specifier by checking for a
directory FIRST:

```js
if (existsSync(base) && statSync(base).isDirectory()) {
  return `${prefix}${withoutTrailingSlash}/index.js${quote}`
}
// Otherwise append .js
```

TypeScript's own `moduleResolution: "Bundler"` does the opposite — a file wins over a
same-named directory. So when both exist, the rewrite binds the published output to a
**different module than the one tsc typechecked**.

That collision exists today: `packages/canopycms/dist/config.js` (file) and
`packages/canopycms/dist/config/` (directory) both exist, and imports of `./config` were
rewritten to `./config/index.js`.

## Why it is currently harmless

`packages/canopycms/src/config.ts` is a pure re-export shim (`export * from './config/index'`),
so the file and the directory index resolve to the same shape. The two only diverge if that
shim ever grows an export of its own — at which point published consumers silently get the
directory's exports while every in-repo typecheck saw the file's.

## Fix direction

Two options, and the choice is about which resolver to mirror:

1. **Match tsc: check for `${base}.js` before checking `isDirectory()`.** Correct-by-
   construction, but it changes existing published output for any current collision — verify
   `dist/config.js` vs `dist/config/index.js` really are interchangeable before flipping it.
2. **Ban the collision instead.** Add an assertion (natural home: the script's `--self-test`,
   or `scripts/check-esm-imports.mjs`) that fails the build when a built tree contains both
   `x.js` and `x/` for the same `x`. Blunter, but it removes the ambiguity rather than picking
   a winner, and the repo has exactly one such pair to clean up.

Option 2 is probably the better first move: the collision is the actual problem, and there is
only one instance of it.
