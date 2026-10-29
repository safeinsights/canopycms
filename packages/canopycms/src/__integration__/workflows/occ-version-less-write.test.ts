/**
 * The content write API never lets an update skip conflict detection: a write
 * to an entry that already exists must carry the `expectedVersion` its writer
 * read. Exercised through the HTTP API with two editors on one branch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { ContentReadResponse, ContentWriteResponse } from '../../api/content'

const BRANCH = 'feature-occ'
const POST_URL = `/api/canopycms/${BRANCH}/content/posts/shared`

const postBody = (author: string, body: string) => ({
  format: 'mdx' as const,
  data: { title: 'Shared', author },
  body,
})

describe('content write OCC: version-less writes', () => {
  let workspace: TestWorkspace
  let editor1: Awaited<ReturnType<typeof createApiClient>>
  let editor2: Awaited<ReturnType<typeof createApiClient>>

  const readPost = async (client: typeof editor1) => {
    const res = await client.get(POST_URL)
    expect(res.status).toBe(200)
    const json = res.body as ContentReadResponse
    if (!json.ok || !json.data) throw new Error(`read failed: ${json.ok ? 'no data' : json.error}`)
    return json.data
  }

  beforeEach(async () => {
    workspace = await createTestWorkspace({ schema: BLOG_SCHEMA })
    editor1 = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
      schema: BLOG_SCHEMA,
    })
    editor2 = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: BLOG_SCHEMA,
    })
    const branch = await editor1.post('/api/canopycms/branches', {
      branch: BRANCH,
      title: 'OCC',
    })
    expect(branch.status).toBe(200)
    const created = await editor1.put(POST_URL, postBody('editor 1', 'original'))
    expect(created.status).toBe(200)
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('refuses a version-less write after the entry was deleted and recreated, keeping the recreated content', async () => {
    // Editor 1 opens the entry.
    const opened = await readPost(editor1)
    expect(opened.body).toContain('original')

    // Editor 2 deletes the path and recreates it, so it carries a new contentId, then saves.
    const deleted = await editor2.delete(`/api/canopycms/${BRANCH}/entries/content/posts/shared`)
    expect(deleted.status).toBe(200)
    const recreated = await editor2.put(POST_URL, {
      ...postBody('editor 2', 'recreated'),
      expectedVersion: null,
    })
    expect(recreated.status).toBe(200)
    const editor2Version = (recreated.body as ContentWriteResponse).data?.version
    expect(typeof editor2Version).toBe('number')
    const saved = await editor2.put(POST_URL, {
      ...postBody('editor 2', 'editor 2 work'),
      expectedVersion: editor2Version,
    })
    expect(saved.status).toBe(200)

    // Editor 1's refreshed entry list now names the new contentId, under which it holds no
    // token, so its save goes out with no expectedVersion at all.
    const blind = await editor1.put(POST_URL, postBody('editor 1', 'editor 1 work'))

    expect(blind.status).toBe(409)
    expect((blind.body as ContentWriteResponse).error).toMatch(/already exists/)
    const after = await readPost(editor2)
    expect(after.body).toContain('editor 2 work')
    expect(after.body).not.toContain('editor 1 work')
  })

  it('refuses a version-less write to an existing entry', async () => {
    const res = await editor1.put(POST_URL, postBody('editor 1', 'overwrite'))

    expect(res.status).toBe(409)
    expect((await readPost(editor1)).body).toContain('original')
  })

  it('refuses a stale version after a delete and recreate', async () => {
    const opened = await readPost(editor1)
    await editor2.delete(`/api/canopycms/${BRANCH}/entries/content/posts/shared`)
    const recreated = await editor2.put(POST_URL, {
      ...postBody('editor 2', 'recreated'),
      expectedVersion: null,
    })
    expect(recreated.status).toBe(200)

    const stale = await editor1.put(POST_URL, {
      ...postBody('editor 1', 'stale'),
      expectedVersion: opened.version,
    })

    expect(stale.status).toBe(409)
    expect((await readPost(editor2)).body).toContain('recreated')
  })

  it('accepts an update carrying the version it read', async () => {
    const opened = await readPost(editor1)

    const res = await editor1.put(POST_URL, {
      ...postBody('editor 1', 'updated'),
      expectedVersion: opened.version,
    })

    expect(res.status).toBe(200)
    expect((await readPost(editor2)).body).toContain('updated')
  })

  it('accepts a version-less write that creates a new entry', async () => {
    const res = await editor1.put(
      `/api/canopycms/${BRANCH}/content/posts/brand-new`,
      postBody('editor 1', 'fresh'),
    )

    expect(res.status).toBe(200)
  })
})
