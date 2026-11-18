// Bundles worker/index.ts into worker/dist/index.js, or the path given as the one argument (a
// test's reproducibility check), and writes worker/dist/instance-files.sh beside it: the units and
// scripts user data installs (src/constructs/worker-units.ts). The banner's first line is the worker
// contract the bundle needs (WORKER_CONTRACT_BANNER_PREFIX), which user data reads to choose the
// units it installs; the second gives the ESM bundle a `require` for the CommonJS it inlines.
import { build, type Plugin } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WORKER_CONTRACT_BANNER_PREFIX,
  WORKER_CONTRACT_VERSION,
} from '../src/constructs/worker-lifecycle'
import { instanceFilesScript } from '../src/constructs/worker-units'

const here = path.dirname(fileURLToPath(import.meta.url))

// Packages whose `main` is a UMD wrapper that loads its own sibling files through a `require`
// esbuild cannot follow, so the bundle would look for them beside itself at run time and the
// process would die at load. Their `module` entry is plain ESM, which esbuild inlines. Only these
// packages are redirected: making `module` win everywhere (`mainFields`) also swaps @octokit/core,
// @octokit/rest and universal-github-app-jwt, among others, to their `dist-web` browser builds.
// src/constructs/bundles-load.test.ts scans the built bundle for relative requires and loads it
// away from any node_modules, which is what catches the next package of this shape.
const ESM_ENTRY_PACKAGES = ['jsonc-parser']

const esmEntry: Plugin = {
  name: 'esm-entry',
  setup(pluginBuild) {
    const filter = new RegExp(`^(${ESM_ENTRY_PACKAGES.join('|')})$`)
    pluginBuild.onResolve({ filter }, async ({ path: name, resolveDir, kind }) => {
      const manifest = await pluginBuild.resolve(`${name}/package.json`, { resolveDir, kind })
      if (manifest.errors.length > 0) return { errors: manifest.errors }
      const { module } = JSON.parse(readFileSync(manifest.path, 'utf-8')) as { module?: string }
      if (module === undefined) {
        return { errors: [{ text: `${name} has no "module" entry to bundle in place of its UMD` }] }
      }
      return { path: path.join(path.dirname(manifest.path), module) }
    })
  },
}

await build({
  entryPoints: [path.join(here, 'index.ts')],
  outfile: process.argv[2] ?? path.join(here, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  plugins: [esmEntry],
  banner: {
    js:
      `${WORKER_CONTRACT_BANNER_PREFIX}${WORKER_CONTRACT_VERSION}\n` +
      "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
})

if (process.argv[2] === undefined) {
  writeFileSync(path.join(here, 'dist', 'instance-files.sh'), instanceFilesScript())
}
