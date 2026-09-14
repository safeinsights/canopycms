# [P2] A webpack-built CMS image bundles sharp, so image transforms fail

**Priority:** P2. It was seen on a Next 15.5.21 (webpack) build with pnpm, and probably affects any
webpack build of the CMS image; other Next 15 versions, npm, and Next 16 with
`next build --webpack` are not yet verified. Routes keep serving, and only image work fails. The
first adopter builds with Next 16's default Turbopack and is not affected.
**Found:** 2026-09-12, by a Next 15.5.21 probe of the `standalone-image` smoke test, while PR 5 of
[cms-image-build-epic.md](cms-image-build-epic.md) weighed adding a webpack leg.

## What was observed

The run was `node scripts/smoke/standalone-image.mjs --pm pnpm --next 15.5.21` on local arm64
Docker, with tarballs from `ci/standalone-image-smoke`. 9 of 14 checks passed. These failed:

- `GET` of an uploaded PNG's `orig` URL, and of a `w=160` WebP transform: both 500;
- the three sharp-alias checks, because a webpack build emits no
  `/app/.next/node_modules/sharp-*` alias.

Inside the running image:

- The container log has `[canopycms] sharp failed to load - image transforms and upload decode
  validation are unavailable in this process: Could not load the "sharp" module using the
  linux-arm64 runtime`, and an unhandled API error with the same message on each transform
  request. There is no `ERR_DLOPEN_FAILED`.
- `/app/.next/server/chunks/4945.js` contains sharp's own loader code, including its
  `Could not load the "sharp" module using the ${…} runtime` message. So sharp's JavaScript was
  bundled into a server chunk.
- `require.resolve('sharp')` from `/app/.next/server/chunks` fails with `MODULE_NOT_FOUND`. The
  only sharp package in the image is Next's own `sharp@0.34.5`.
- Both libvips libraries are present under `/app`: `libvips-cpp.so.8.18.6` (1.3.3) and
  `libvips-cpp.so.8.17.3` (1.2.4). So this is not the missing-libvips defect PR 3 fixed. The
  bundled copy of sharp cannot reach its native binding.

The check results and the log lines above are in the probe's saved output. The chunk's contents,
the `require.resolve` result and the two libvips files are not; the `serverExternalPackages` run
below saved its own `require.resolve` failure and the sharp packages in its image. To re-check
them, re-run the probe with `--keep` and inspect the container.

## Root cause (verified 2026-09-13)

**Not a regression from the epic.** Host webpack builds (Next 15.5.21, pnpm, `CANOPY_BUILD=cms
next build`, a minimal app scaffolded outside the monorepo from `pnpm pack` tarballs) bundle sharp
at the pre-epic base `8b854c18`, at `93e20fd0` (before PR #324), and at `d49bf279` (#324 merged).
In all three: sharp's loader is bundled (inline in the route chunk before #324, in a separate
server chunk after — #324's dynamic import only moved it), no external `require`/`import("sharp")`
remains, no sharp 0.35 package is traced into `.next/standalone` (only Next's own `sharp@0.34.5`),
and `require('sharp')` from the server chunks fails with `MODULE_NOT_FOUND`.

**Cause: Next's webpack externals resolution, combined with pnpm's strict layout.** In Next
15.5.21's `dist/build/handle-externals.js`:

- `resolveExternal` (~lines 85-107) resolves the request both from the importing file and from the
  project root; if the results differ it sets `res = null` ("if the package, when required from
  the root, would be different … we cannot externalize it"). From canopycms's directory, `sharp`
  resolves to canopycms's sharp 0.35; from the app root it throws `MODULE_NOT_FOUND`, because pnpm
  links only an app's direct dependencies at its root, and sharp is canopycms's dependency, not the
  app's.
- `if (!res) return;` (~line 206) then bundles it — before the server-externals regex is consulted
  (~line 209; the regex built in `webpack-config.js` (~:677) already includes sharp, via Next's own
  `dist/lib/server-external-packages.json`). That is why `serverExternalPackages: ['sharp']` in the
  adopter's config, tried below, has no effect: the request never reaches that regex.
- Not the cause: `transpilePackages` (`isResourceInPackages` compares sharp's resolved path against
  canopycms's directory and is never reached for sharp), and not the import form — a static and a
  dynamic `import('sharp')` both arrive at this code as `dependencyType === 'esm'`.
- Once sharp's JS is inlined, nothing `require`s the package at runtime, so Next's file tracing
  never copies it into `.next/standalone`.

**Diagnostic confirming the mechanism (not a proposed fix):** adding `sharp@0.35.x` as a direct
dependency of the app flips the result — the built `route.js` keeps an external `import("sharp")`,
sharp 0.35 is traced into `.next/standalone`, and it resolves from the chunks.

**Turbopack is unaffected** (Next 16's default): it externalizes sharp through a
`.next/node_modules/sharp-<hash>` alias, which the `standalone-image` smoke test's alias checks
exercise.

## Not yet verified

- Whether an npm install behaves the same way. The mechanism above predicts bundling whenever the
  app root resolves a different sharp than canopycms does (for example, npm hoisting Next's
  0.34.5 to the top level) — not built.
- Whether Next 16 with `next build --webpack` behaves the same way — not checked.
- Whether a webpack build can be made to produce working transforms end to end. The
  direct-dependency diagnostic above was a bundling/tracing check only; no image with a working
  transform request was built under webpack.

## Tried

- **`serverExternalPackages: ['sharp']` in the app's `next.config.ts`, on the same probe: no
  change.** The same 5 checks failed. The log had the same "Could not load" error 4 times,
  `require.resolve('sharp')` from the server chunks still failed, and still no sharp 0.35 package
  was in the image. So a fix is more than naming sharp as a server external in the adopter's
  config — see "Root cause" above for what actually bundles it and why that config option never
  gets consulted.

## Candidate fix directions (unverified)

For whoever picks this up. Each needs an image-level proof; none has been built end to end.

1. Tell webpack-build adopters to add `sharp` (matching canopycms's range) as a direct dependency
   — a docs-only workaround; must be proven end to end, and combined with `withCanopy`'s libvips
   tracing includes.
2. Make `sharp` a peer dependency of canopycms, so the adopter's install places it at the app root
   — changes every adopter's install; weigh against Turbopack adopters who don't need it.
3. Have `withCanopy`'s webpack hook externalize canopycms's sharp explicitly and ensure the
   resolved package is traced — must survive Next's standalone layout, where the chunk resolves
   from `/app/node_modules`.

Whichever direction is chosen, the smoke test's webpack leg (see "Also needed for a webpack CI
leg" below) is the natural proof.

## Also needed for a webpack CI leg

The smoke test's three sharp-alias checks assume Turbopack's `.next/node_modules/sharp-<hash>`
shape. A webpack leg needs checks for webpack's shape instead: sharp resolving from the server
chunks to a traced package, with that package's own libvips. Add the leg to the
`standalone-image` matrix once this is fixed.
