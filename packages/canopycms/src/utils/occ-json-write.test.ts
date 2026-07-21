import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  writeOccJsonFile,
  withOccRetry,
  withOccFileLock,
  OccWriteConflictError,
} from './occ-json-write'

describe('occ-json-write', () => {
  let tmpDir: string
  let filePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'occ-json-write-test-'))
    filePath = path.join(tmpDir, 'data.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('writeOccJsonFile', () => {
    it('creates a new file at version 1 with a writeId', async () => {
      const result = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )
      expect(result.version).toBe(1)
      expect(result.writeId).toBeTruthy()

      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(onDisk.name).toBe('first')
      expect(onDisk.version).toBe(1)
      expect(onDisk.writeId).toBe(result.writeId)
    })

    it('throws OccWriteConflictError creating a new file when one already exists', async () => {
      await writeOccJsonFile(filePath, { name: 'first' }, { expectedVersion: null, settleMs: 0 })
      await expect(
        writeOccJsonFile(filePath, { name: 'second' }, { expectedVersion: null, settleMs: 0 }),
      ).rejects.toThrow(OccWriteConflictError)
    })

    it('increments the version on update with the correct expectedVersion', async () => {
      const created = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )
      const updated = await writeOccJsonFile(
        filePath,
        { name: 'second' },
        { expectedVersion: created.version, settleMs: 0 },
      )
      expect(updated.version).toBe(2)

      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(onDisk.name).toBe('second')
      expect(onDisk.version).toBe(2)
    })

    it('throws OccWriteConflictError on update with a stale expectedVersion', async () => {
      await writeOccJsonFile(filePath, { name: 'first' }, { expectedVersion: null, settleMs: 0 })
      await expect(
        writeOccJsonFile(filePath, { name: 'second' }, { expectedVersion: 0, settleMs: 0 }),
      ).rejects.toThrow(OccWriteConflictError)
    })

    it('throws OccWriteConflictError when another write lands mid-settle', async () => {
      const created = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )

      const writePromise = writeOccJsonFile(
        filePath,
        { name: 'second' },
        { expectedVersion: created.version, settleMs: 150 },
      )

      // Land squarely inside the 150ms settle window, after the rename has
      // already happened (rename + precheck complete in low single-digit ms
      // on a local/tmp filesystem).
      await new Promise((resolve) => setTimeout(resolve, 50))
      await fs.writeFile(
        filePath,
        JSON.stringify({ name: 'interloper', version: 2, writeId: 'someone-else' }),
      )

      await expect(writePromise).rejects.toThrow(OccWriteConflictError)
    })

    it('works with settleMs 0', async () => {
      const result = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )
      expect(result.version).toBe(1)
    })

    it('appends a trailing newline when requested', async () => {
      await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0, trailingNewline: true },
      )
      const raw = await fs.readFile(filePath, 'utf-8')
      expect(raw.endsWith('\n')).toBe(true)
    })

    it('cleans up temp files, leaving only the target in the directory', async () => {
      const created = await writeOccJsonFile(
        filePath,
        { name: 'first' },
        { expectedVersion: null, settleMs: 0 },
      )
      await writeOccJsonFile(
        filePath,
        { name: 'second' },
        { expectedVersion: created.version, settleMs: 0 },
      )

      const entries = await fs.readdir(tmpDir)
      expect(entries).toEqual(['data.json'])
    })
  })

  describe('withOccRetry', () => {
    it('retries on OccWriteConflictError and eventually succeeds', async () => {
      let attempts = 0
      const result = await withOccRetry(
        async () => {
          attempts += 1
          if (attempts < 3) throw new OccWriteConflictError()
          return 'done'
        },
        { maxAttempts: 5 },
      )
      expect(result).toBe('done')
      expect(attempts).toBe(3)
    })

    it('gives up after maxAttempts and rethrows', async () => {
      let attempts = 0
      await expect(
        withOccRetry(
          async () => {
            attempts += 1
            throw new OccWriteConflictError()
          },
          { maxAttempts: 3 },
        ),
      ).rejects.toThrow(OccWriteConflictError)
      expect(attempts).toBe(3)
    })

    it('retries errors matched by isRetryable in addition to OccWriteConflictError', async () => {
      let attempts = 0
      const result = await withOccRetry(
        async () => {
          attempts += 1
          if (attempts < 2) throw new Error('transient')
          return 'done'
        },
        { maxAttempts: 3, isRetryable: (err) => err instanceof Error },
      )
      expect(result).toBe('done')
      expect(attempts).toBe(2)
    })

    it('does not retry non-retryable errors', async () => {
      let attempts = 0
      await expect(
        withOccRetry(async () => {
          attempts += 1
          throw new Error('fatal')
        }),
      ).rejects.toThrow('fatal')
      expect(attempts).toBe(1)
    })
  })

  describe('withOccFileLock', () => {
    it('serializes concurrent critical sections on the same file', async () => {
      let active = 0
      let sawOverlap = false

      const enterSection = async () => {
        await withOccFileLock(filePath, async () => {
          active += 1
          if (active > 1) sawOverlap = true
          await new Promise((resolve) => setTimeout(resolve, 20))
          active -= 1
        })
      }

      await Promise.all([enterSection(), enterSection(), enterSection()])

      expect(sawOverlap).toBe(false)
    })

    it('releases the lock when fn throws, so a later call can still acquire it', async () => {
      await expect(
        withOccFileLock(filePath, async () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')

      let ran = false
      await withOccFileLock(filePath, async () => {
        ran = true
      })
      expect(ran).toBe(true)
    })
  })
})
