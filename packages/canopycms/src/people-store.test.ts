import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const locks = vi.hoisted(() => ({ withLock: 0, withOccFileLock: 0 }))
vi.mock('./utils/async-mutex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/async-mutex')>()
  return {
    ...actual,
    withLock: <T>(key: string, fn: () => Promise<T>) => {
      locks.withLock++
      return actual.withLock(key, fn)
    },
  }
})
vi.mock('./utils/occ-json-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/occ-json-write')>()
  return {
    ...actual,
    withOccFileLock: <T>(
      file: string,
      fn: () => Promise<T>,
      options?: Parameters<typeof actual.withOccFileLock>[2],
    ) => {
      locks.withOccFileLock++
      return actual.withOccFileLock(file, fn, options)
    },
  }
})

import { PeopleStore } from './people-store'
import { mockConsole } from './test-utils/console-spy'

let root: string
const sha = (id: string) => createHash('sha256').update(id).digest('hex')
const store = () => new PeopleStore(root, { settleMs: 0 })
const sharesFile = (sharer: string) => path.join(root, 'shares', `${sha(sharer)}.json`)

beforeEach(async () => {
  locks.withLock = 0
  locks.withOccFileLock = 0
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-people-')), '.people')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

const b64 = (id: string) => Buffer.from(id).toString('base64url')
const seenDir = () => path.join(root, 'seen')

describe('seen markers', () => {
  it('writes one marker however many first visits race, without taking a lock', async () => {
    // Separate stores, as on separate servers: none can skip the write on its in-process set.
    await Promise.all(Array.from({ length: 12 }, () => store().recordSeen('ana')))

    expect(await fs.readdir(seenDir())).toEqual([b64('ana')])
    expect(locks).toEqual({ withLock: 0, withOccFileLock: 0 })
  })

  it('skips the write for someone this process already recorded', async () => {
    const people = store()
    await people.recordSeen('ana')
    const link = vi.spyOn(fs, 'link')

    await people.recordSeen('ana')

    expect(people.hasRecordedSeen('ana')).toBe(true)
    expect(link).not.toHaveBeenCalled()
  })

  it('lists the ids from the folder alone, reading no marker, and skips stray files', async () => {
    expect(await store().listSeen()).toEqual(new Set())
    await store().recordSeen('user_2abc/../x')
    await store().recordSeen('ben@example.org')
    await fs.writeFile(path.join(seenDir(), 'notes.txt'), '')
    await fs.writeFile(path.join(seenDir(), `${b64('cy')}=`), '')
    // Decodes to 'cy', but is not how this store spells it.
    await fs.writeFile(path.join(seenDir(), 'Y3l'), '')
    await fs.writeFile(path.join(seenDir(), `.${b64('dee')}.abc.tmp`), '')
    const read = vi.spyOn(fs, 'readFile')

    expect(await store().listSeen()).toEqual(new Set(['user_2abc/../x', 'ben@example.org']))
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects when the folder cannot be read, rather than listing nobody', async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(seenDir(), 'not a folder')

    await expect(store().listSeen()).rejects.toThrow()
  })

  it('records no id too long for a marker name, logging it once', async () => {
    const long = 'x'.repeat(151)
    const console = mockConsole()
    try {
      await store().recordSeen(long)
      await store().recordSeen(long)
      expect(console.all().warn).toHaveLength(1)
    } finally {
      console.restore()
    }

    expect(await store().listSeen()).toEqual(new Set())
    expect(await store().removeSeen(long)).toBe(false)
    await store().recordSeen('x'.repeat(150))
    expect(await store().listSeen()).toEqual(new Set(['x'.repeat(150)]))
  })

  it('leaves no temp file behind when writing it fails', async () => {
    const writeFile = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (file) => {
      await writeFile(file, 'partial')
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    })

    await expect(store().recordSeen('ana')).rejects.toThrow('no space')
    expect(await fs.readdir(seenDir())).toEqual([])
  })

  it('removes a marker, and records the person again on their next visit', async () => {
    const people = store()
    await people.recordSeen('ana')

    expect(await people.removeSeen('ana')).toBe(true)
    expect(await people.removeSeen('ana')).toBe(false)
    expect(await people.listSeen()).toEqual(new Set())
    expect(people.hasRecordedSeen('ana')).toBe(false)

    await people.recordSeen('ana')
    expect(await people.listSeen()).toEqual(new Set(['ana']))
  })
})

describe('recent shares', () => {
  const now = new Date('2026-11-15T12:00:00.000Z')

  it('keeps a write that lands from another host between this one reading and writing', async () => {
    await store().recordShares('ana', ['ben'], now)
    // What a writer on another host looks like from here: the file moves on after our read.
    const readFile = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async (file, options) => {
      const ours = await readFile(file, options)
      await fs.writeFile(
        sharesFile('ana'),
        JSON.stringify({
          v: 1,
          sharedWith: { ben: now.toISOString(), cy: now.toISOString() },
          version: 2,
          writeId: 'foreign',
        }),
      )
      return ours
    })

    await store().recordShares('ana', ['dee'], new Date(now.getTime() + 1000))

    expect((await store().recentShares('ana', now)).map((share) => share.userId).sort()).toEqual([
      'ben',
      'cy',
      'dee',
    ])
  })

  it('records nothing, at once, while another process holds the file lock', async () => {
    await store().recordShares('ana', ['ben'], now)
    // A holder that is alive, or crashed and not yet stale: its lock folder is fresh.
    await fs.mkdir(`${sharesFile('ana')}.lock`)
    const started = Date.now()

    await expect(store().recordShares('ana', ['cy'], now)).rejects.toThrow()

    expect(Date.now() - started).toBeLessThan(2000)
    expect((await store().recentShares('ana', now)).map((share) => share.userId)).toEqual(['ben'])
  })

  it('keeps both of two concurrent writes by one sharer, under the file locks', async () => {
    await Promise.all([
      store().recordShares('ana', ['ben'], now),
      store().recordShares('ana', ['cy'], new Date(now.getTime() + 1000)),
    ])

    expect((await store().recentShares('ana', now)).map((share) => share.userId)).toEqual([
      'cy',
      'ben',
    ])
    expect(locks).toEqual({ withLock: 2, withOccFileLock: 2 })
  })

  it('lists the newest first, and keeps each sharer to their own file', async () => {
    await store().recordShares('ana', ['ben'], new Date('2026-10-01T00:00:00.000Z'))
    await store().recordShares('ana', ['cy'], new Date('2026-11-01T00:00:00.000Z'))
    await store().recordShares('ana', ['ben'], new Date('2026-11-10T00:00:00.000Z'))
    await store().recordShares('dee', ['eve'], now)

    expect(await store().recentShares('ana', now)).toEqual([
      { userId: 'ben', at: '2026-11-10T00:00:00.000Z' },
      { userId: 'cy', at: '2026-11-01T00:00:00.000Z' },
    ])
    expect(await store().recentShares('nobody', now)).toEqual([])
  })

  it('ignores shares older than 12 months on read, and drops them on the next write', async () => {
    await store().recordShares('ana', ['old'], new Date('2025-11-14T12:00:00.000Z'))
    await store().recordShares('ana', ['kept'], new Date('2025-11-15T12:00:00.000Z'))

    expect((await store().recentShares('ana', now)).map((share) => share.userId)).toEqual(['kept'])

    await store().recordShares('ana', ['ben'], now)
    const onDisk = JSON.parse(await fs.readFile(sharesFile('ana'), 'utf8')) as {
      sharedWith: Record<string, string>
    }
    expect(Object.keys(onDisk.sharedWith).sort()).toEqual(['ben', 'kept'])
  })

  it('reads a file that does not parse as empty, logs it once, and replaces it on the next write', async () => {
    await fs.mkdir(path.dirname(sharesFile('ana')), { recursive: true })
    await fs.writeFile(sharesFile('ana'), '{"v": 1, "sharedWith": {')
    const console = mockConsole()
    try {
      expect(await store().recentShares('ana', now)).toEqual([])
      expect(await store().recentShares('ana', now)).toEqual([])
      expect(console.all().warn).toHaveLength(1)
    } finally {
      console.restore()
    }

    await store().recordShares('ana', ['ben'], now)

    expect(await store().recentShares('ana', now)).toEqual([
      { userId: 'ben', at: now.toISOString() },
    ])
  })
})
