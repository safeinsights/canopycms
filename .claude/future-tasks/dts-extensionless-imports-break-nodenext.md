# Published `.d.ts` files use extensionless relative imports

Found 2026-08-20 while resolving
[canopycms-test-utils-export-unbuilt.md](resolved/canopycms-test-utils-export-unbuilt.md).
Adjacent to — but not covered by — the ESM fix that added
`scripts/add-js-extensions.mjs`.

## What's wrong

`scripts/add-js-extensions.mjs` rewrites extensionless relative imports to carry `.js`, which
is what makes `dist/*.js` loadable under Node's native ESM resolver. But it only processes
`.js` files:

```js
if (!entry.isFile() || !entry.name.endsWith('.js')) continue
```

The emitted `.d.ts` files are left alone, so they still carry extensionless relative
specifiers. From a freshly built `packages/canopycms/dist/server.d.ts`:

```ts
export * from './content-reader'
export * from './services'
export * from './build-mode'
```

TypeScript resolves those fine under `moduleResolution: "Bundler"` (and legacy `"node"`), which
is what this repo and most Next.js adopters use. Under `"moduleResolution": "node16"` or
`"nodenext"` — required for packages that are themselves published as ESM, and increasingly the
default people reach for — relative specifiers must carry an extension, so an adopter on
NodeNext should fail to resolve the package's types even though its runtime JS loads correctly.

This is the exact inverse of the `dist/*.js` problem already fixed: runtime resolution was
repaired, type resolution was not.

## What still needs verifying

The consumer-side breakage is **inferred from the TypeScript resolution rules, not yet
reproduced**. Before fixing, stand up a throwaway consumer with
`"moduleResolution": "nodenext"` against a real `pnpm pack` tarball and confirm the actual
error — the fix is cheap but the priority depends on whether adopters hit it in practice.
Note this affects all five published packages, since they share the rewrite script.

## Fix direction

Extend `scripts/add-js-extensions.mjs` to process `.d.ts` alongside `.js`. The rewrite target
is the same (`'./x'` -> `'./x.js'`; `.d.ts` files reference the `.js` extension, not `.d.ts`).
Watch for `import type` / `export type` forms and for the `.d.ts` files' `declare module`
blocks. `scripts/check-esm-imports.mjs` only exercises runtime `import()`, so it cannot catch
this — a type-level guard (running `tsc` against the packed tarball under NodeNext) would be
the matching regression check.
