#!/usr/bin/env node
// Rewrites extensionless relative imports in a built ESM dist directory to
// include explicit .js extensions (or expand directory specifiers to
// /index.js). tsc with moduleResolution:"Bundler" preserves bare relative
// specifiers verbatim (e.g. `from './adapter'`), which Node's native ESM
// resolver rejects with ERR_MODULE_NOT_FOUND.
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

const RELATIVE_IMPORT_RE = /(from\s+['"]|import\s*\(\s*['"]|import\s+['"])(\.\.?\/[^'"]+)(['"])/g

export async function addJsExtensions(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const filePath = join(entry.parentPath ?? entry.path, entry.name)
    const original = await readFile(filePath, 'utf8')

    const rewritten = original.replace(RELATIVE_IMPORT_RE, (match, prefix, specifier, quote) => {
      // Already has a file extension — leave it alone
      if (/\.[cm]?[jt]sx?$/.test(specifier)) return match

      const base = resolve(dirname(filePath), specifier)

      // If specifier points to a directory with an index.js, expand it
      if (existsSync(base) && statSync(base).isDirectory()) {
        return `${prefix}${specifier}/index.js${quote}`
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
