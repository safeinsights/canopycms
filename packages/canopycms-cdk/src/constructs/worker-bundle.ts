import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// This package is `"type": "module"`, so `__dirname` is not a global in its
// compiled output. Vitest shims it, so this file's tests would not notice.
// Same fix as ./asset-support.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The worker bundle: the single file esbuild writes (`pnpm run build:worker`),
 * shipped to the instance as-is so its sha256 is known at synth. A directory
 * asset would be zipped by cdk-assets at publish time, after synth.
 */
export const WORKER_BUNDLE_PATH = path.join(__dirname, '../../worker/dist/index.js')

/** Where user data downloads the bundle to and checks it, before installing it. */
export const WORKER_BUNDLE_DOWNLOAD_PATH = '/tmp/canopy-worker.js'

export function sha256OfFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
