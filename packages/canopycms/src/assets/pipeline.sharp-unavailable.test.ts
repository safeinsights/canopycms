/**
 * Isolated from pipeline.test.ts because it needs to mock the 'sharp' module
 * itself (simulating "native binary missing for this platform/architecture")
 * - pipeline.test.ts's own fixtures are generated WITH real sharp, so mocking
 * it there would break every other raster fixture in that file. This file's
 * only job is the fail-OPEN half of `rasterIsDecodable` (pipeline.ts): when
 * sharp cannot be loaded at all, finalize must not fail every raster upload
 * because of an environment problem - it logs and lets the upload through
 * unvalidated, same as pre-fix behavior. The fail-CLOSED half (sharp loads
 * fine but rejects the bytes) is covered in pipeline.test.ts, where sharp is
 * genuinely available.
 */
import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'

import { mockConsole } from '../test-utils/console-spy'

vi.mock('sharp', () => {
  throw new Error('Could not load the "sharp" module using the linux-x64 runtime')
})

// Header-valid (real magic bytes + IHDR) but NOT sharp-decodable - the exact
// shape of fixture this whole environment-fallback path exists to let
// through when there is no decoder available to check it. See pipeline.ts's
// module doc comment for why file-type/image-size only read fixed-offset
// header bytes and would sniff/measure this identically to a real encoder's
// output.
const PNG_3X5_HEADER_ONLY_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAAAAAAAA'

function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

describe('runFinalizePipeline - sharp unavailable', () => {
  it('skips decode validation and still accepts a header-valid raster, logging a warning', async () => {
    const consoleSpy = mockConsole()
    const { runFinalizePipeline } = await import('./pipeline')

    const result = await runFinalizePipeline({
      data: bytesOf(PNG_3X5_HEADER_ONLY_BASE64),
      filename: 'a.png',
    })

    expect(result.ok).toBe(true)
    expect(consoleSpy).toHaveWarned(/sharp could not be loaded/i)
    consoleSpy.restore()
  })
})
