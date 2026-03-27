import { rm, cp, rename, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// Copy template files — rm first to prevent nested dirs on repeated builds
await rm(resolve(root, 'dist/cli/template-files'), { recursive: true, force: true })
await cp(resolve(root, 'src/cli/template-files'), resolve(root, 'dist/cli/template-files'), {
  recursive: true,
})

// Strip the tsx shebang that tsc preserves from the source — esbuild will add the node shebang.
const initSrc = resolve(root, 'dist/cli/init.js')
const initCode = await readFile(initSrc, 'utf8')
await writeFile(initSrc, initCode.replace(/^#!.*\n/, ''))

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
