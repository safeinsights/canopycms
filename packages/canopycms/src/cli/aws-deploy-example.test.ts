import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNodeError } from '../utils/error'
import { AWS_DEPLOY_EXAMPLE_DIR, renderAwsDeployExample } from './aws-deploy-example'

/** Null when equal, else the first differing line, 1-based, with both versions of it. */
function firstDifference(expected: string, actual: string): string | null {
  if (expected === actual) return null
  const want = expected.split('\n')
  const got = actual.split('\n')
  const line = want.findIndex((text, i) => text !== got[i])
  // Every expected line matched, so the checked-in file has extra lines after them.
  const at = line === -1 ? want.length : line
  const show = (text: string | undefined) => (text === undefined ? '(end of file)' : `"${text}"`)
  return `line ${at + 1}: template renders ${show(want[at])}, example has ${show(got[at])}`
}

describe('examples/aws-deployment', () => {
  it('matches what `pnpm generate:aws-example` renders from the init-deploy aws templates', async () => {
    const stale: string[] = []
    for (const [relativePath, expected] of await renderAwsDeployExample()) {
      const actual = await fs
        .readFile(path.join(AWS_DEPLOY_EXAMPLE_DIR, relativePath), 'utf-8')
        .catch((error: unknown) => {
          if (isNodeError(error) && error.code === 'ENOENT') return null
          throw error
        })
      const difference = actual === null ? 'missing' : firstDifference(expected, actual)
      if (difference) stale.push(`examples/aws-deployment/${relativePath}, ${difference}`)
    }
    // The commit hook runs prettier over these files, so a template prettier would reformat
    // regenerates into a file that differs again once committed. Format the template instead.
    expect(stale, 'run `pnpm generate:aws-example` and commit the result').toEqual([])
  })
})
