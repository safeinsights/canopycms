# [P3] Re-check Next's libvips tracing on each Next upgrade, and remove `withCanopy`'s include once upstream fixes it

Filed 2026-09-12 by PR 3 of the CMS editor image epic ([cms-image-build-epic.md](cms-image-build-epic.md)),
which added `packages/canopycms-next/src/sharp-tracing.ts`.

## Why the include exists

- **The library is never imported.** sharp loads libvips with `dlopen`, through the native binding's
  rpath. A tracer that follows imports never sees it.
- **Next only special-cases sharp's old layout.** The JS tracer's sharp handler
  (`next/dist/compiled/@vercel/nft`) fires only on a path ending in `sharp/lib/index.js`. That is
  sharp 0.34's entry point; sharp 0.35 ships `dist/index.{cjs,mjs}`.
- **Measured failure.** A Next 16.1.7 Turbopack `output: 'standalone'` build traced libvips's
  `package.json`, `versions.json`, `lib/index.js` and the binding's rpath symlink, but not
  `lib/libvips-cpp.so.8.18.3`. The server then failed every load of sharp with `ERR_DLOPEN_FAILED`.
- **Upstream.** [vercel/next.js#97973](https://github.com/vercel/next.js/issues/97973) was open on
  2026-09-12. Related on sharp's side: [lovell/sharp#4567](https://github.com/lovell/sharp/issues/4567)
  and [lovell/sharp#4543](https://github.com/lovell/sharp/issues/4543).
- **What `withCanopy` does about it.** For every build that is not a static export, it adds each
  installed libvips package's real `lib/` directory to `outputFileTracingIncludes['/**']`. Before
  Next 15 it writes the key under `experimental`.

## What to check on each Next upgrade, and on each sharp minor

1. **Is vercel/next.js#97973 closed, and in which release?** Note that release here either way.
2. **Does Next now trace the library without the include?** Build a standalone image with
   `sharpTracingConfig` in `with-canopy.ts` returning `{}`. Use the image smoke test fixture if it
   exists ([deploy-image-build-smoke-test.md](deploy-image-build-smoke-test.md)), or any Turbopack
   standalone app that installs the packed packages. Then check two things:
   - the builder's `.next/server/app/_not-found/page.js.nft.json` lists `libvips-cpp`;
   - inside the image, `require()` of every `/app/.next/node_modules/sharp-*` directory can build a
     PNG.
3. **If it does, remove the workaround.** Delete `sharp-tracing.ts`, its test file, and the
   `sharpTracingConfig` call and helpers in `with-canopy.ts`. Also remove the manual snippet in
   `docs/deploying-to-aws.md` and the `withCanopy` bullets in README.md, ARCHITECTURE.md and
   CODEBASE_GUIDE.md. Keep the image smoke test.

## Dependencies the include does not control

Re-check these if a standalone image fails to load sharp even though the include is present.

- **The rpath symlink.** The include ships the real library only. Under pnpm the binding reaches it
  through `.pnpm/@img+sharp-<platform>@<version>/node_modules/@img/sharp-libvips-<platform>`, a
  symlink Next 16.1.7's Turbopack traced on its own. If a Next release stops tracing that symlink,
  the library is present but unreachable.
- **How Turbopack matches includes.** Checked at v16.1.7 in `crates/next-api/src/nft_json.rs`:
  - the route key is matched in "contains" mode against `"/" + page name`, so `'/**'` matches every
    route;
  - include globs are relative to the project directory;
  - a glob that climbs above the tracing root with `../` fails the whole build;
  - symlinks found by the glob are emitted, and directories are skipped.
- **Build cost.** Contains-mode matching walks every directory under `node_modules`, following
  symlinks, once per build, whatever the glob names. That is upstream behaviour for any include.
  One consequence: a symlink loop anywhere under `node_modules` would fail the build once an include
  exists.
