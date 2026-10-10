// Writes the bundle's metadata next to worker/dist/index.js, shipped in the npm
// package for an adopter's CI rolling the worker with
// `workerCode: { source: 'parameter' }`:
//   index.js.sha256    its hash, in `sha256sum -c` format, to upload it under
//   index.js.contract  the worker contract version it needs from the template
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WORKER_CONTRACT_VERSION } from '../src/constructs/worker-lifecycle'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const sha = createHash('sha256')
  .update(readFileSync(path.join(dist, 'index.js')))
  .digest('hex')
writeFileSync(path.join(dist, 'index.js.sha256'), `${sha}  index.js\n`)
writeFileSync(path.join(dist, 'index.js.contract'), `${WORKER_CONTRACT_VERSION}\n`)
