/**
 * [SYNC-C1] A content-write lock lost mid-write reaches the API as a `BranchSyncingError` whose
 * `outcome` is `'unknown'`: the write ran, so the editor must re-read rather than retry. The
 * contention half (`'not-run'`) is in content-store.test.ts.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from './config-test'
import { flattenSchema } from './config'
import { BranchSyncingError, ContentStore } from './content-store'
import { unsafeAsLogicalPath, unsafeAsSlug } from './paths/test-utils'

/** Reports a compromise the way `withContentWriteLock` does: by throwing after `fn` completed. */
vi.mock('./utils/content-write-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/content-write-lock')>()
  return {
    ...actual,
    withContentWriteLock: async (
      branchRoot: string,
      fn: () => Promise<unknown>,
      waitMs?: number,
    ): Promise<unknown> => {
      await actual.withContentWriteLock(branchRoot, fn, waitMs)
      throw new actual.ContentWriteLockBusyError('may have been recorded', 'unknown')
    },
  }
})

describe('ContentStore when the content-write lock is lost mid-write', () => {
  const schema = {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: [{ name: 'post', format: 'json' as const, schema: [] }],
      },
    ],
  } as const
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-lost-lock-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it("throws a BranchSyncingError with outcome 'unknown', and the write is on disk", async () => {
    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))
    const posts = unsafeAsLogicalPath('content/posts')

    const err = await store
      .write(posts, unsafeAsSlug('hello'), { format: 'json', data: { title: 'v1' } })
      .then(
        () => null,
        (e: unknown) => e,
      )

    expect(err).toBeInstanceOf(BranchSyncingError)
    expect((err as BranchSyncingError).outcome).toBe('unknown')
    expect((err as Error).message).toBe('may have been recorded')
    const doc = await store.read(posts, unsafeAsSlug('hello'))
    expect(doc.data.title).toBe('v1')
  })
})
