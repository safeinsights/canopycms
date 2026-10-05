/**
 * [SYNC-C1] Schema mutations rewrite `.collection.json` files and, for
 * `deleteCollection`, whole directory trees in the branch working tree the
 * worker rebases, so they must hold the branch's content-write lock. These
 * drive each mutator with the lock held elsewhere and assert a retriable
 * `SchemaStoreBusyError` with the tree untouched, then the same mutation once
 * the lock is free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { SchemaOps, SchemaStoreBusyError } from './schema-store'
import { BranchSchemaCache, SCHEMA_GENERATION_RESOURCE } from '../branch-schema-cache'
import type { FieldConfig } from '../config'
import { unsafeAsLogicalPath } from '../paths/test-utils'
import { resourceGenerationPath } from '../resource-generation'
import { createMockServices } from '../test-utils'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'

/**
 * Lets a test lose the lock mid-hold: `withContentWriteLock` reports a
 * compromise by throwing after `fn` has completed, which is what this does.
 * Every other call delegates to the real implementation.
 */
const compromiseHook = vi.hoisted(() => ({ next: false }))

vi.mock('../utils/content-write-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/content-write-lock')>()
  return {
    ...actual,
    withContentWriteLock: async (
      branchRoot: string,
      fn: () => Promise<unknown>,
      waitMs?: number,
    ): Promise<unknown> => {
      if (!compromiseHook.next) return actual.withContentWriteLock(branchRoot, fn, waitMs)
      compromiseHook.next = false
      await actual.withContentWriteLock(branchRoot, fn, waitMs)
      throw new actual.ContentWriteLockBusyError('may or may not have been recorded', 'unknown')
    },
  }
})

const POSTS = unsafeAsLogicalPath('posts')

/** Every file under `dir` with its bytes, so "untouched" covers renames and deletes too. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out[`${rel}/`] = ''
        await walk(path.join(d, entry.name), rel)
      } else {
        out[rel] = await fs.readFile(path.join(d, entry.name), 'utf-8')
      }
    }
  }
  await walk(dir, '')
  return out
}

describe('SchemaOps under the content-write lock [SYNC-C1]', () => {
  let tempDir: string
  let contentRoot: string
  const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
    postSchema: [{ name: 'title', type: 'string', required: true }],
  }

  const makeOps = () =>
    new SchemaOps(contentRoot, entrySchemaRegistry, undefined, tempDir, {
      contentWriteLockWaitMs: 100,
    })

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-schema-content-lock-'))
    contentRoot = path.join(tempDir, 'content')
    await fs.mkdir(contentRoot, { recursive: true })
    const ops = makeOps()
    await ops.createCollection({
      name: 'posts',
      entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
    })
    await ops.createCollection({
      name: 'drafts',
      entries: [{ name: 'draft', format: 'json', schema: 'postSchema' }],
    })
  })

  afterEach(async () => {
    compromiseHook.next = false
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  const mutations: Array<[string, (ops: SchemaOps) => Promise<unknown>]> = [
    [
      'createCollection',
      (ops) =>
        ops.createCollection({
          name: 'news',
          entries: [{ name: 'item', format: 'json', schema: 'postSchema' }],
        }),
    ],
    ['updateCollection', (ops) => ops.updateCollection(POSTS, { label: 'Renamed' })],
    ['deleteCollection', (ops) => ops.deleteCollection(unsafeAsLogicalPath('drafts'))],
    [
      'addEntryType',
      (ops) => ops.addEntryType(POSTS, { name: 'extra', format: 'json', schema: 'postSchema' }),
    ],
    ['updateEntryType', (ops) => ops.updateEntryType(POSTS, 'post', { label: 'Post!' })],
    ['removeEntryType', (ops) => ops.removeEntryType(POSTS, 'post')],
    ['updateOrder', (ops) => ops.updateOrder(POSTS, ['abc123def456'])],
  ]

  it.each(mutations)(
    '%s fails retriably with the tree untouched while the lock is held, and lands once it is free',
    async (name, mutate) => {
      const ops = makeOps()
      // A collection keeps at least one entry type, so removal needs a spare.
      if (name === 'removeEntryType') {
        await ops.addEntryType(POSTS, { name: 'spare', format: 'json', schema: 'postSchema' })
      }
      const before = await snapshotTree(contentRoot)

      const release = await tryAcquireContentWriteLock(tempDir)
      try {
        await expect(mutate(ops)).rejects.toBeInstanceOf(SchemaStoreBusyError)
        expect(await snapshotTree(contentRoot)).toEqual(before)
      } finally {
        await release()
      }

      await mutate(ops)
      expect(await snapshotTree(contentRoot)).not.toEqual(before)
    },
  )

  it('holds the content-write lock across the whole critical section', async () => {
    // A mutation parked mid read-modify-write holds the lock: the worker's
    // zero-retry acquisition is refused, so no rebase can start under it.
    const ops = makeOps()
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let parked!: () => void
    const isParked = new Promise<void>((resolve) => {
      parked = resolve
    })
    const spy = vi.spyOn(ops, 'readCollectionMeta').mockImplementationOnce(async (p) => {
      parked()
      await gate
      spy.mockRestore()
      return ops.readCollectionMeta(p)
    })

    const inFlight = ops.updateCollection(POSTS, { label: 'Held' })
    await isParked
    await expect(tryAcquireContentWriteLock(tempDir)).rejects.toMatchObject({ code: 'ELOCKED' })
    releaseGate()
    await inFlight

    // Released afterwards.
    const release = await tryAcquireContentWriteLock(tempDir)
    await release()
  })

  it('still invalidates the schema cache when the lock is lost after the mutation landed', async () => {
    const branchSchemaCache = new BranchSchemaCache('dev')
    const services = createMockServices({ branchSchemaCache })
    const ops = new SchemaOps(contentRoot, entrySchemaRegistry, services, tempDir, {
      contentWriteLockWaitMs: 100,
    })
    const markerPath = resourceGenerationPath(tempDir, SCHEMA_GENERATION_RESOURCE)
    const tokenBefore = await fs.readFile(markerPath, 'utf-8').catch(() => '')

    compromiseHook.next = true
    const err = await ops.updateCollection(POSTS, { label: 'Landed' }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(SchemaStoreBusyError)
    expect((err as Error).message).toMatch(/may or may not/)
    // The mutation is on disk, so readers must be told the schema changed.
    const meta = await ops.readCollectionMeta(POSTS)
    expect(meta?.label).toBe('Landed')
    const tokenAfter = await fs.readFile(markerPath, 'utf-8')
    expect(tokenAfter).not.toBe(tokenBefore)
  })
})
