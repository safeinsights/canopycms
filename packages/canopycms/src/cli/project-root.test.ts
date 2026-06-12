import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { findProjectRoot, PROJECT_MARKER } from './project-root'

describe('findProjectRoot', () => {
  let sandbox: string

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-project-root-'))
  })

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  it('returns the start directory when the config lives there', async () => {
    await fs.writeFile(path.join(sandbox, PROJECT_MARKER), 'export default {}\n')
    expect(await findProjectRoot(sandbox)).toBe(sandbox)
  })

  it('walks up to the nearest ancestor containing the config', async () => {
    await fs.writeFile(path.join(sandbox, PROJECT_MARKER), 'export default {}\n')
    const nested = path.join(sandbox, 'out', '_next', 'static', 'chunks')
    await fs.mkdir(nested, { recursive: true })
    expect(await findProjectRoot(nested)).toBe(sandbox)
  })

  it('prefers the closest config when projects are nested', async () => {
    await fs.writeFile(path.join(sandbox, PROJECT_MARKER), 'export default {}\n')
    const inner = path.join(sandbox, 'examples', 'site')
    await fs.mkdir(inner, { recursive: true })
    await fs.writeFile(path.join(inner, PROJECT_MARKER), 'export default {}\n')
    expect(await findProjectRoot(path.join(inner))).toBe(inner)
  })

  it('returns null when no config exists up to the filesystem root', async () => {
    const nested = path.join(sandbox, 'a', 'b')
    await fs.mkdir(nested, { recursive: true })
    // The sandbox lives under os.tmpdir(), which has no canopycms.config.ts above it
    expect(await findProjectRoot(nested)).toBeNull()
  })
})
