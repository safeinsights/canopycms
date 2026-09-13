# [P2] A webpack-built CMS image bundles sharp, so image transforms fail

**Priority:** P2. It affects adopters who build the CMS image with webpack: Next 15.x, or Next 16
with `next build --webpack`. Routes keep serving, and only image work fails. The first adopter
builds with Next 16's default Turbopack and is not affected.
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

## Not yet verified

- Why webpack bundles sharp here. A likely cause is that `withCanopy` puts canopycms in
  `transpilePackages`, so canopycms's `import('sharp')` in `assets/sharp-loader.ts` is compiled
  into the chunk, and sharp is not left as a server external.
- Whether an npm install behaves the same way.
- Whether Next 16 with `--webpack` behaves the same way.

## Tried

- **`serverExternalPackages: ['sharp']` in the app's `next.config.ts`, on the same probe: no
  change.** The same 5 checks failed. The log had the same "Could not load" error 4 times,
  `require.resolve('sharp')` from the server chunks still failed, and still no sharp 0.35 package
  was in the image. So a fix is more than naming sharp as a server external in the adopter's
  config. Start by finding what bundles sharp's code into the chunk, and why nothing traces
  canopycms's sharp into `.next/standalone`.

## Also needed for a webpack CI leg

The smoke test's three sharp-alias checks assume Turbopack's `.next/node_modules/sharp-<hash>`
shape. A webpack leg needs checks for webpack's shape instead: sharp resolving from the server
chunks to a traced package, with that package's own libvips. Add the leg to the
`standalone-image` matrix once this is fixed.
