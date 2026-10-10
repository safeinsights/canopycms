// Writes worker/dist/index.js.sha256 next to the bundle, in `sha256sum -c`
// format. It ships in the npm package so an adopter's CI can upload the
// bundle under its hash for `workerCode: { source: 'parameter' }`.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const sha = createHash('sha256')
  .update(readFileSync(path.join(dist, 'index.js')))
  .digest('hex')
writeFileSync(path.join(dist, 'index.js.sha256'), `${sha}  index.js\n`)
