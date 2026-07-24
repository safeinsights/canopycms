import { rm, cp, rename, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, statSync } from 'node:fs'
import { build } from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const distDir = resolve(root, 'dist')

// ---------------------------------------------------------------------------
// 1. Rewrite extensionless relative imports in dist to include .js extensions.
//    tsc with moduleResolution:"Bundler" preserves bare specifiers verbatim,
//    which breaks Node's native ESM resolver.
// ---------------------------------------------------------------------------

const RELATIVE_IMPORT_RE = /(from\s+['"]|import\s*\(\s*['"]|import\s+['"])(\.\.?\/[^'"]+)(['"])/g

async function addJsExtensions(dir) {
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

await addJsExtensions(distDir)

// Copy template files — rm first to prevent nested dirs on repeated builds
await rm(resolve(root, 'dist/cli/template-files'), { recursive: true, force: true })
await cp(resolve(root, 'src/cli/template-files'), resolve(root, 'dist/cli/template-files'), {
  recursive: true,
})

// Strip the tsx shebang that tsc preserves from the source — esbuild will add the node shebang.
const initSrc = resolve(root, 'dist/cli/init.js')
const initCode = await readFile(initSrc, 'utf8')
await writeFile(initSrc, initCode.replace(/^#!.*\n/, ''))

// Same for cli.js — the published bin entrypoint. Without this, the tsx
// shebang survives into the package and every adopter's `npx canopycms`
// fails with `env: tsx: No such file or directory`.
const cliSrc = resolve(root, 'dist/cli/cli.js')
const cliCode = await readFile(cliSrc, 'utf8')
await writeFile(cliSrc, cliCode.replace(/^#!.*\n/, ''))

// Bundle CLI entry points with esbuild so all internal imports are resolved.
// This fixes Node 20 ESM errors from bare directory imports emitted by tsc.
const commonOptions = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
}

// Bundle init.js (the main CLI entry point)
const initTmp = resolve(root, 'dist/cli/init.bundled.js')
await build({
  ...commonOptions,
  entryPoints: [initSrc],
  outfile: initTmp,
  banner: { js: '#!/usr/bin/env node' },
})
await rename(initTmp, initSrc)

// Bundle generate-ai-content.js (dynamically imported by init.js)
const genSrc = resolve(root, 'dist/cli/generate-ai-content.js')
const genTmp = resolve(root, 'dist/cli/generate-ai-content.bundled.js')
await build({
  ...commonOptions,
  entryPoints: [genSrc],
  outfile: genTmp,
})
await rename(genTmp, genSrc)

// Bundle cli.js (the published bin entrypoint; dynamic relative imports get inlined)
const cliTmp = resolve(root, 'dist/cli/cli.bundled.js')
await build({
  ...commonOptions,
  entryPoints: [cliSrc],
  outfile: cliTmp,
  banner: { js: '#!/usr/bin/env node' },
})
await rename(cliTmp, cliSrc)

// Guard: no CLI entrypoint may ship a non-node shebang. A tsx shebang here
// means `npx canopycms` breaks for every adopter — fail the build instead.
for (const name of await readdir(resolve(root, 'dist/cli'))) {
  if (!name.endsWith('.js')) continue
  const firstLine = (await readFile(resolve(root, 'dist/cli', name), 'utf8')).split('\n', 1)[0]
  if (firstLine.startsWith('#!') && !firstLine.includes('node')) {
    throw new Error(`dist/cli/${name} has a non-node shebang: ${firstLine}`)
  }
}
