import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { atomicWriteFile } from './atomic-write'

describe('atomicWriteFile', () => {
  let dir: string | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes the content in place of the old file', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-atomic-'))
    const file = path.join(dir, 'entry.json')
    await fs.writeFile(file, 'old', 'utf8')

    await atomicWriteFile(file, 'new')

    expect(await fs.readFile(file, 'utf8')).toBe('new')
    expect(await fs.readdir(dir)).toEqual(['entry.json'])
  })

  it('leaves no temp file behind when the write itself fails part-way', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-atomic-'))
    const file = path.join(dir, 'entry.json')
    await fs.writeFile(file, 'old', 'utf8')
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (target, _content, options) => {
      await realWriteFile(target, 'par', options)
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })

    await expect(atomicWriteFile(file, 'new')).rejects.toThrow('ENOSPC')

    expect(await fs.readdir(dir)).toEqual(['entry.json'])
    expect(await fs.readFile(file, 'utf8')).toBe('old')
  })
})
