import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  mutateSettingsJsonFile,
  SettingsFileConflictError,
  SettingsVersionConflictError,
} from '../settings-file-store'
import { writeOccJsonFile } from '../../utils/occ-json-write'

/** Minimal settings-shaped file used across these tests: an array field to mutate plus the OCC version/writeId pair. */
interface TestFile {
  version?: number
  writeId?: string
  items: string[]
}

const parse = (raw: string): TestFile => JSON.parse(raw) as TestFile

describe('mutateSettingsJsonFile', () => {
  let tmpDir: string
  let filePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-settings-file-store-test-'))
    filePath = path.join(tmpDir, 'settings.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates the file on first mutate against a missing file', async () => {
    const result = await mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: (current, version) => {
        expect(current).toBeNull()
        expect(version).toBe(0)
        return { items: ['first'] }
      },
      settleMs: 0,
    })

    expect(result?.version).toBe(1)
    expect(result?.writeId).toEqual(expect.any(String))

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    expect(onDisk.items).toEqual(['first'])
    expect(onDisk.version).toBe(1)
    expect(onDisk.writeId).toBe(result?.writeId)
  })

  it('increments version 1 -> 2 -> 3 across sequential mutates, with no trailing newline', async () => {
    const r1 = await mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: (current) => ({ items: [...(current?.items ?? []), 'a'] }),
      settleMs: 0,
    })
    const r2 = await mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: (current) => ({ items: [...(current?.items ?? []), 'b'] }),
      settleMs: 0,
    })
    const r3 = await mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: (current) => ({ items: [...(current?.items ?? []), 'c'] }),
      settleMs: 0,
    })

    expect([r1?.version, r2?.version, r3?.version]).toEqual([1, 2, 3])

    const raw = await fs.readFile(filePath, 'utf-8')
    expect(raw.endsWith('\n')).toBe(false)
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(JSON.parse(raw).items).toEqual(['a', 'b', 'c'])
  })

  it('handles 5-way concurrency: every writer lands its item, final version reflects all writes', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        mutateSettingsJsonFile<TestFile>({
          filePath,
          parse,
          mutate: (current) => ({ items: [...(current?.items ?? []), `item-${i}`] }),
          settleMs: 0,
        }),
      ),
    )

    expect(results.every((r) => r !== null)).toBe(true)

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8')) as TestFile
    expect(onDisk.version).toBe(5)
    expect(onDisk.items.length).toBe(5)
    expect(new Set(onDisk.items)).toEqual(
      new Set(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']),
    )
  })

  it('recovers from a foreign-host write landing between reload and write (foreign-host simulation)', async () => {
    // Foreign-host simulation per docs/concurrency.md's testing conventions:
    // overwriting the file directly IS what another host's write looks like
    // locally.
    await writeOccJsonFile(filePath, { items: ['seed'] }, { expectedVersion: null, settleMs: 0 })

    let mutateCallCount = 0
    const result = await mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: async (current) => {
        mutateCallCount += 1
        if (mutateCallCount === 1) {
          // A foreign writer's update lands after this mutate call's reload,
          // but before writeOccJsonFile's precheck+write for THIS attempt.
          await fs.writeFile(
            filePath,
            JSON.stringify({ items: ['seed', 'foreign'], version: 5, writeId: 'foreign-writer' }),
          )
        }
        return { items: [...(current?.items ?? []), 'mine'] }
      },
      settleMs: 0,
    })

    // First attempt's write loses the precheck race (foreign write bumped
    // the version underneath it); the retry reloads fresh state and wins.
    expect(mutateCallCount).toBe(2)
    expect(result?.version).toBe(6)

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8')) as TestFile
    expect(onDisk.items).toEqual(['seed', 'foreign', 'mine'])
  })

  it('rejects with SettingsFileConflictError (not the raw OccWriteConflictError) once retries are exhausted', async () => {
    await writeOccJsonFile(filePath, { items: [] }, { expectedVersion: null, settleMs: 0 })

    let mutateCallCount = 0
    const attempt = mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: async (current) => {
        mutateCallCount += 1
        // Clobber the file on every attempt so the precheck inside
        // writeOccJsonFile always disagrees with what this call read.
        await fs.writeFile(
          filePath,
          JSON.stringify({
            items: current?.items ?? [],
            version: (current?.version ?? 0) + 10,
            writeId: `clobber-${mutateCallCount}`,
          }),
        )
        return { items: [...(current?.items ?? []), 'mine'] }
      },
      settleMs: 0,
      maxAttempts: 2,
    })

    await expect(attempt).rejects.toThrow(SettingsFileConflictError)
    expect(mutateCallCount).toBe(2)
  })

  it('propagates SettingsVersionConflictError from the mutator without retrying', async () => {
    await writeOccJsonFile(filePath, { items: [] }, { expectedVersion: null, settleMs: 0 })

    let mutateCallCount = 0
    const attempt = mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: () => {
        mutateCallCount += 1
        throw new SettingsVersionConflictError('stale client version')
      },
      settleMs: 0,
    })

    await expect(attempt).rejects.toThrow(SettingsVersionConflictError)
    await expect(attempt).rejects.toThrow('stale client version')
    expect(mutateCallCount).toBe(1)
  })

  it('is a no-op when mutate returns null, leaving the file byte-identical', async () => {
    await writeOccJsonFile(filePath, { items: ['a'] }, { expectedVersion: null, settleMs: 0 })
    const before = await fs.readFile(filePath, 'utf-8')

    const result = await mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: () => null,
      settleMs: 0,
    })

    expect(result).toBeNull()
    const after = await fs.readFile(filePath, 'utf-8')
    expect(after).toBe(before)
  })

  it('leaves no lock/tmp artifacts after a success cycle or a failure cycle', async () => {
    await mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: (current) => ({ items: [...(current?.items ?? []), 'a'] }),
      settleMs: 0,
    })

    await expect(
      mutateSettingsJsonFile<TestFile>({
        filePath,
        parse,
        mutate: () => {
          throw new SettingsVersionConflictError()
        },
        settleMs: 0,
      }),
    ).rejects.toThrow(SettingsVersionConflictError)

    const entries = await fs.readdir(tmpDir)
    const artifacts = entries.filter((name) => name.includes('.lock') || name.includes('.tmp'))
    expect(artifacts).toEqual([])
  })

  it('treats a hand-written file with no version field as version 0, never as ENOENT (pins the ENOENT-only-null rule)', async () => {
    await fs.writeFile(filePath, JSON.stringify({ items: ['hand-written'] }))

    const result = await mutateSettingsJsonFile<TestFile>({
      filePath,
      parse,
      mutate: (current) => ({ items: [...(current?.items ?? []), 'mine'] }),
      settleMs: 0,
    })

    expect(result?.version).toBe(1)
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8')) as TestFile
    expect(onDisk.items).toEqual(['hand-written', 'mine'])
    expect(onDisk.version).toBe(1)
  })
})
