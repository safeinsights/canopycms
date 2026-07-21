import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  resourceGenerationPath,
  bumpResourceGeneration,
  readResourceGeneration,
  isGenerationCurrent,
} from './resource-generation'

describe('resource-generation', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-generation-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('resourceGenerationPath', () => {
    it('builds the marker path under .canopy-meta', () => {
      expect(resourceGenerationPath(tmpDir, 'widgets')).toBe(
        path.join(path.resolve(tmpDir), '.canopy-meta', 'widgets.generation'),
      )
    })
  })

  describe('bumpResourceGeneration', () => {
    it('writes the marker file and returns the token', async () => {
      const token = await bumpResourceGeneration(tmpDir, 'widgets')
      expect(token).toBeTruthy()
      const onDisk = await fs.readFile(resourceGenerationPath(tmpDir, 'widgets'), 'utf-8')
      expect(onDisk).toBe(token)
    })

    it('returns a distinct token on each bump', async () => {
      const first = await bumpResourceGeneration(tmpDir, 'widgets')
      const second = await bumpResourceGeneration(tmpDir, 'widgets')
      expect(first).not.toBe(second)
    })

    it('rethrows when mustSucceed is true and the write fails', async () => {
      // Make .canopy-meta a FILE so mkdir(recursive) inside atomicWriteFile fails.
      await fs.writeFile(path.join(tmpDir, '.canopy-meta'), 'not a directory')
      await expect(
        bumpResourceGeneration(tmpDir, 'widgets', { mustSucceed: true }),
      ).rejects.toThrow()
    })

    it('swallows the failure and returns null by default', async () => {
      await fs.writeFile(path.join(tmpDir, '.canopy-meta'), 'not a directory')
      const token = await bumpResourceGeneration(tmpDir, 'widgets')
      expect(token).toBeNull()
    })
  })

  describe('readResourceGeneration', () => {
    it('returns ok:true token:null when the marker does not exist', async () => {
      const result = await readResourceGeneration(tmpDir, 'widgets')
      expect(result).toEqual({ ok: true, token: null })
    })

    it('returns the token written by a previous bump', async () => {
      const token = await bumpResourceGeneration(tmpDir, 'widgets')
      const result = await readResourceGeneration(tmpDir, 'widgets')
      expect(result).toEqual({ ok: true, token })
    })

    it('returns ok:false on a non-ENOENT read error', async () => {
      // Make the marker path itself a DIRECTORY so readFile fails with EISDIR.
      await fs.mkdir(resourceGenerationPath(tmpDir, 'widgets'), { recursive: true })
      const result = await readResourceGeneration(tmpDir, 'widgets')
      expect(result).toEqual({ ok: false })
    })
  })

  describe('isGenerationCurrent', () => {
    it('is true when both the snapshot and the read are the never-bumped null state', () => {
      expect(isGenerationCurrent(null, { ok: true, token: null })).toBe(true)
    })

    it('is true when the tokens match', () => {
      expect(isGenerationCurrent('abc', { ok: true, token: 'abc' })).toBe(true)
    })

    it('is false when the tokens mismatch', () => {
      expect(isGenerationCurrent('abc', { ok: true, token: 'def' })).toBe(false)
    })

    it('is false on a failed read, even when the snapshot token is null', () => {
      expect(isGenerationCurrent(null, { ok: false })).toBe(false)
    })
  })
})
