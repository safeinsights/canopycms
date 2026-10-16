import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The instance files as the package ships them (`worker/dist/instance-files.sh`, written by
 * `build:worker`): what user data downloads, checks and installs, so a test of "the deployed
 * unit" reads these. worker-units.test.ts ties them to user data's sha256 line.
 */
export const SHIPPED_INSTANCE_FILES = path.join(__dirname, '../worker/dist/instance-files.sh')

/** Each file the shipped script writes, by name, as lines. */
export function shippedInstanceFiles(): Map<string, string[]> {
  const lines = readFileSync(SHIPPED_INSTANCE_FILES, 'utf-8').split('\n')
  const files = new Map<string, string[]>()
  for (let i = 0; i < lines.length; i++) {
    const open = /^cat > (\S+) << '(\w+)'$/.exec(lines[i])
    if (!open) continue
    const end = lines.indexOf(open[2], i + 1)
    if (end < 0) throw new Error(`no end to ${open[1]} in ${SHIPPED_INSTANCE_FILES}`)
    files.set(open[1], lines.slice(i + 1, end))
    i = end
  }
  return files
}

/** One shipped file's lines; throws when the script does not write it. */
export function shippedInstanceFile(name: string): string[] {
  const file = shippedInstanceFiles().get(name)
  if (!file) throw new Error(`${SHIPPED_INSTANCE_FILES} writes no ${name}`)
  return file
}

/** The worker units user data can install: the split one and the single-process one. */
export function shippedWorkerUnits(): Array<[string, string[]]> {
  return [
    ['split', shippedInstanceFile('canopy-worker.service')],
    ['single-process', shippedInstanceFile('canopy-worker-single-process.service')],
  ]
}

export function shippedInstanceFilesSha256(): string {
  return createHash('sha256').update(readFileSync(SHIPPED_INSTANCE_FILES)).digest('hex')
}
