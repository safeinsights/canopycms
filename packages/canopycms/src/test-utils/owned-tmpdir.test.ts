import fs from 'node:fs'
import os from 'node:os'

import { describe, expect, it } from 'vitest'

describe('the run owns its temp directory', () => {
  // Every `mkdtemp(os.tmpdir(), ...)` in this suite relies on this: the files
  // that never remove their directory are cleaned up only because the whole
  // root is. Without the globalSetup in vitest.config.ts each run strands
  // hundreds of directories in the machine's shared temp directory.
  it('os.tmpdir() is the per-run root vitest.tmpdir.ts created', () => {
    const root = process.env.CANOPY_TEST_RUN_TMPDIR
    expect(root).toBeTruthy()
    expect(os.tmpdir()).toBe(root)
    expect(fs.statSync(os.tmpdir()).isDirectory()).toBe(true)
  })
})
