#!/usr/bin/env node
// Rewrites extensionless relative imports in a built ESM dist directory to
// include explicit .js extensions (or expand directory specifiers to
// /index.js). tsc with moduleResolution:"Bundler" preserves bare relative
// specifiers verbatim (e.g. `from './adapter'`), which Node's native ESM
// resolver rejects with ERR_MODULE_NOT_FOUND.
//
// This applies to BOTH the emitted .js and the emitted .d.ts. The .d.ts half is
// easy to overlook because its failure is silent rather than loud: a consumer on
// moduleResolution "node16"/"nodenext" cannot resolve `export * from './x'`
// inside a .d.ts, and TypeScript's recovery is to type the whole import as
// `any` — so the adopter's build stays GREEN while every type this package
// exports quietly degrades to `any`. With skipLibCheck:false they at least see
// TS2834/TS2835 diagnostics pointing into node_modules; with skipLibCheck:true
// (what most scaffolds set, Next.js included) there is no signal at all.
// Verified both ways against a real packed tarball before this was fixed.
//
// Appending `.js` is correct for a .d.ts: TypeScript resolves a `./x.js`
// specifier to `./x.d.ts`, which is why the declaration files must name the
// RUNTIME extension and never `.d.ts`.
//
// Shared by every published package's build so there is ONE implementation.
// Each package invokes this against its own dist/ after tsc emits it, either
// via the CLI form below (`node <path-to-this-file>/add-js-extensions.mjs
// dist`, path resolved relative to the invoking package's cwd) or by
// importing `addJsExtensions` directly.
//
// packages/canopycms has extra postbuild steps that are specific to it (CLI
// template-file copying, tsx-shebang stripping, esbuild bundling of CLI
// entrypoints) — those stay in packages/canopycms/scripts/postbuild.mjs,
// which imports `addJsExtensions` from here instead of duplicating it.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELATIVE_IMPORT_RE =
  /(from\s+['"]|import\s*\(\s*['"]|import\s+['"])(\.\.?(?:\/[^'"]*)?)(['"])/g

export async function addJsExtensions(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue
    // .d.ts as well as .js — see the header note on silent `any` degradation.
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) continue
    const filePath = join(entry.parentPath ?? entry.path, entry.name)
    const original = await readFile(filePath, 'utf8')

    const rewritten = original.replace(RELATIVE_IMPORT_RE, (match, prefix, specifier, quote) => {
      // Already has a file extension — leave it alone
      if (/\.[cm]?[jt]sx?$/.test(specifier)) return match

      const base = resolve(dirname(filePath), specifier)

      // If specifier points to a directory, expand it to its index. Named as
      // index.js in .d.ts files too — tsc maps that to index.d.ts.
      //
      // This covers the bare `.` / `..` forms as well: `from '.'` resolves to
      // the containing directory, so it lands here and becomes './index.js'.
      // Node's ESM resolver and TypeScript's node16/nodenext modes both reject
      // a bare '.' — the one occurrence in this repo (operating-mode/types.ts)
      // was invisible until the .d.ts half of this rewrite started running.
      if (existsSync(base) && statSync(base).isDirectory()) {
        const withoutTrailingSlash = specifier.endsWith('/') ? specifier.slice(0, -1) : specifier
        return `${prefix}${withoutTrailingSlash}/index.js${quote}`
      }

      // Otherwise append .js
      return `${prefix}${specifier}.js${quote}`
    })

    if (rewritten !== original) {
      await writeFile(filePath, rewritten)
    }
  }
}

// Allow direct invocation as a build step:
//   node <this-file> <dist-dir>
// <dist-dir> is resolved relative to the current working directory, i.e. the
// package running its own build script.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  const target = process.argv[2]
  if (!target) {
    console.error('Usage: node add-js-extensions.mjs <dist-dir>')
    process.exit(1)
  }
  await addJsExtensions(resolve(process.cwd(), target))
}
