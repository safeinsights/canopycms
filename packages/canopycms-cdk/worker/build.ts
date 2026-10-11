// Bundles worker/index.ts into worker/dist/index.js, or the path given as the one argument (a
// test's reproducibility check). The banner's first line is the worker
// contract the bundle needs (WORKER_CONTRACT_BANNER_PREFIX), which user-data reads to choose the
// units it writes; the second gives the ESM bundle a `require` for the CommonJS it inlines.
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WORKER_CONTRACT_BANNER_PREFIX,
  WORKER_CONTRACT_VERSION,
} from '../src/constructs/worker-lifecycle'

const here = path.dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [path.join(here, 'index.ts')],
  outfile: process.argv[2] ?? path.join(here, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js:
      `${WORKER_CONTRACT_BANNER_PREFIX}${WORKER_CONTRACT_VERSION}\n` +
      "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
})
