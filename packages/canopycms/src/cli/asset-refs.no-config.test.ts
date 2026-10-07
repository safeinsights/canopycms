import { describe, expect, it, vi } from 'vitest'

import { mockConsole } from '../test-utils'

// Fails this whole file if anything `asset-refs.ts` imports statically reaches jiti: the config
// loader must stay a dynamic import, off the `--bucket` path.
vi.mock('jiti', () => {
  throw new Error('jiti was imported')
})

describe('materialize-assets --bucket', () => {
  it('runs without loading jiti or the site config', async () => {
    const { materializeAssetsCLI, MATERIALIZE_EXIT_CODES } = await import('./asset-refs')
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-no-config-'))
    const refsPath = path.join(dir, 'canopy-asset-refs.json')
    await fs.writeFile(refsPath, JSON.stringify({ version: 1, transforms: [], statics: [] }))
    const out = mockConsole()
    try {
      const code = await materializeAssetsCLI({
        refsPath,
        bucket: 'b',
        region: 'us-east-2',
        allowFailures: false,
      })
      expect(code).toBe(MATERIALIZE_EXIT_CODES.ok)
    } finally {
      out.restore()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
