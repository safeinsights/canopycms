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
- **What `withCanopy` does about it.** For every build that is not a static export, it adds a real
  `lib/` directory to `outputFileTracingIncludes['/**']`:
  - each installed libvips package's;
  - or, for a Windows binding, the binding's own, since it carries libvips itself.

  The key follows the installed Next version: `experimental` on 13 and 14, and the top level on 15
  and later, unless a legacy `experimental` spelling is already set. `sharpTracingConfig` in
  `packages/canopycms-next/src/with-canopy.ts` holds the full rules.

## What to check on each Next upgrade, and on each sharp minor

1. **Is vercel/next.js#97973 closed, and in which release?** Note that release here either way.
2. **Does Next now trace the library without the include?** Build a standalone image with
   `sharpTracingConfig` in `with-canopy.ts` returning `{}`. The image smoke test does this: pack
   canopycms-next with that change, put the other two packages' tarballs in the same directory,
   and run `scripts/smoke/standalone-image.mjs --tarballs <dir>`
   ([deploy-image-build-smoke-test.md](resolved/deploy-image-build-smoke-test.md)). While the
   include is still needed, 5 of its 14 checks fail: the original-PNG and WebP requests, the
   libvips check, the alias load and the `ERR_DLOPEN_FAILED` count. The "externalized" check still
   passes. Or check by hand:
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
- **Build cost.** Contains-mode matching leaves the glob unanchored, so Turbopack's walk is not
  confined to the directory an include names, and it follows symlinked directories
  (`turbo-tasks-fs/src/globset.rs:104-114` and `read_glob.rs:87-99` at v16.1.7). That is upstream
  behaviour for any include.
  - **Measured:** on one Next 16.1.7 app's standalone build, about 5 s more compile time (12.8 s to
    17.9 s, mean of three runs).
  - **Symlink loops:** one inside the walked tree makes the glob fail with an error
    (`read_glob.rs:112-128`).
