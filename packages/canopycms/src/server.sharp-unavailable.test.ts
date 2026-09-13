/**
 * Importing the package's server-side entry points must not load sharp.
 *
 * This is the test that would have caught an adopter outage: their editor
 * image lacked the libvips `.so`, and because assets/transform.ts statically
 * imported sharp, every route that imported Canopy - 404s and
 * `/favicon.ico` included - returned 500 before any image was involved.
 * `canopycms/http` is the entry `canopycms-next` builds on, so it is the path
 * a host app actually took; `canopycms/server` re-exports `applyTransform`
 * directly.
 *
 * With sharp mocked to throw, any static import of it anywhere in either
 * graph makes the dynamic `import()` below reject.
 */
import { describe, expect, it, vi } from 'vitest'

import { mockConsole } from './test-utils/console-spy'

vi.mock('sharp', () => {
  throw new Error('Could not load the "sharp" module using the linux-arm64 runtime')
})

describe('package entry points - sharp unavailable', () => {
  it('canopycms/server imports without loading sharp', async () => {
    const consoleSpy = mockConsole()
    try {
      const server = await import('./server')

      expect(server.applyTransform).toBeTypeOf('function')
      expect(consoleSpy.all().error).toEqual([])
    } finally {
      consoleSpy.restore()
    }
  })

  it('canopycms/http imports without loading sharp', async () => {
    const consoleSpy = mockConsole()
    try {
      const http = await import('./http')

      expect(http.createCanopyRequestHandler).toBeTypeOf('function')
      expect(consoleSpy.all().error).toEqual([])
    } finally {
      consoleSpy.restore()
    }
  })
})
