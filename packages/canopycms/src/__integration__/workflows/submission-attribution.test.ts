/**
 * Who a submit credits: every user who saved on the branch, not only the submitter.
 * Goes through the HTTP API, and reads the pushed commits from the deployment's remote.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { simpleGit } from 'simple-git'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin, TEST_INTERNAL_GROUPS } from '../test-utils/multi-user'
import { createApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'

const BRANCH = 'feature-shared-edit'

function post(slug: string, body: string) {
  return {
    collection: 'content/posts',
    slug,
    format: 'mdx',
    data: { title: slug, author: 'Someone', date: '2024-01-01', tags: ['test'] },
    body,
  }
}

describe('Submission attribution', () => {
  let workspace: TestWorkspace
  let editorClient: Awaited<ReturnType<typeof createApiClient>>
  let adminClient: Awaited<ReturnType<typeof createApiClient>>

  beforeEach(async () => {
    workspace = await createTestWorkspace(
      { schema: BLOG_SCHEMA },
      { internalGroups: TEST_INTERNAL_GROUPS },
    )
    editorClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
      schema: BLOG_SCHEMA,
    })
    adminClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: BLOG_SCHEMA,
    })
    const created = await editorClient.post('/api/canopycms/branches', { branch: BRANCH })
    expect(created.status).toBe(200)
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  async function pushedTrailers(): Promise<string> {
    const remote = simpleGit({ baseDir: workspace.remotePath })
    return (await remote.raw(['log', '-1', '--format=%(trailers:only,unfold)', BRANCH])).trim()
  }

  async function save(client: typeof editorClient, slug: string, body: string): Promise<void> {
    const res = await client.put(`/api/canopycms/${BRANCH}/content/posts/${slug}`, post(slug, body))
    expect(res.status).toBe(200)
  }

  it('names every user who saved, and only the users who saved since the last submit', async () => {
    await save(editorClient, 'from-editor', 'Written by the editor')
    await save(adminClient, 'from-admin', 'Written by the admin')

    const submitted = await editorClient.post(`/api/canopycms/${BRANCH}/submit`, {})
    expect(submitted.status).toBe(200)

    expect(await pushedTrailers()).toBe(
      'Edited-by: Editor User (test-editor)\nEdited-by: Admin User (test-admin)',
    )

    const withdrawn = await editorClient.post(`/api/canopycms/${BRANCH}/withdraw`, {})
    expect(withdrawn.status).toBe(200)
    await save(editorClient, 'editor-again', 'A second editor edit')

    const resubmitted = await editorClient.post(`/api/canopycms/${BRANCH}/submit`, {})
    expect(resubmitted.status).toBe(200)

    // The admin saved nothing since the first submit, so this commit does not name them.
    expect(await pushedTrailers()).toBe('Edited-by: Editor User (test-editor)')
    const branches = await adminClient.get('/api/canopycms/branches')
    const listed = (
      branches.body as {
        data?: {
          branches: Array<{ name: string; editors?: string[]; uncommittedEditors?: string[] }>
        }
      }
    ).data?.branches.find((b) => b.name === BRANCH)
    expect(listed?.editors).toEqual(['test-editor', 'test-admin'])
    expect(listed?.uncommittedEditors).toBeUndefined()
  })

  it('credits a save but not a refused one', async () => {
    await save(editorClient, 'from-editor', 'Written by the editor')
    // A create over an existing entry is refused with 409, so the admin edited nothing.
    const refused = await adminClient.put(
      `/api/canopycms/${BRANCH}/content/posts/from-editor`,
      post('from-editor', 'An overwrite attempt'),
    )
    expect(refused.status).toBe(409)

    const submitted = await editorClient.post(`/api/canopycms/${BRANCH}/submit`, {})
    expect(submitted.status).toBe(200)

    expect(await pushedTrailers()).toBe('Edited-by: Editor User (test-editor)')
  })
})
