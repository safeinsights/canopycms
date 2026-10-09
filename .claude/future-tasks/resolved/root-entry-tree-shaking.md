# Importing `assetUrl` from the package root pulls zod into client bundles

**Status: RESOLVED 2026-10-08**, branch `fix/root-tree-shaking`, base `int-202610-b`. Adopter
request #88.

## Problem

`assetUrl` and `assetSrcSet` are exported only from the package root, and the root barrel
re-exports the zod config schemas. The package declared no `sideEffects`, so a bundler had to keep
every module the barrel reaches. One `import { assetUrl } from 'canopycms'` in a `'use client'`
component put a shared chunk of about 227 KB raw (65 KB gzipped) on every public page of the
reporting site, and the adopter had moved srcSet computation server-side to avoid it.

## Fix

`packages/canopycms/package.json` declares `sideEffects` as an array naming the modules whose
evaluation does something another module depends on: `editor/theme.tsx` (stylesheet imports),
`cli/cli.ts` (the bin's top-level run), and the two test-utils modules that register with vitest
at import. Each shipped one is listed under both `./src/` and `./dist/`. No import-chain change was
needed: `assets/asset-url.ts` never reached config. The rationale, and what was deliberately left
off (`defineEndpoint`'s `ROUTE_REGISTRY` push, which only the unbundled client codegen reads),
lives in `src/package-side-effects.test.ts`.

The test bundles `import { assetUrl } from 'canopycms'` with esbuild through the workspace
package and fails if zod or any `src/config/` module contributes bytes. It also checks that every
declared entry exists and that each shipped one has its dist twin. Finally it parses every module
`tsconfig.build.json` compiles and requires the modules with a top-level statement that runs code
(an expression, `if`/`try`, a bare `import './x'`, a class static block) to be exactly the listed
ones, so a new registration or polyfill fails until its module is declared.

## Measured

The bundle of `import { assetUrl } from 'canopycms'` against the packed tarball:

| Bundler                                     | Before                           | After                       |
| ------------------------------------------- | -------------------------------- | --------------------------- |
| esbuild, minified                           | 71.3 KB / 18.4 KB gzip, zod in   | 4.6 KB / 2.0 KB gzip, no zod |
| webpack (Next's bundled copy), production   | 78.9 KB / 21.1 KB gzip, zod in   | 6.4 KB / 2.7 KB gzip, no zod |
