/**
 * "Show changes" end to end in the editor: offered on an open entry the branch changed, opening
 * the lazily loaded drawer, and handing focus back to it on Escape.
 */
import React from 'react'

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

const schema: EntrySchema = [{ name: 'title', type: 'string', label: 'Title' }]
const hello: EditorEntry = {
  path: unsafeAsLogicalPath('content/posts/hello'),
  contentId: unsafeAsContentId('def456ABC123'),
  label: 'Hello',
  status: 'entry',
  schema,
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug: 'hello',
  format: 'json',
  type: 'entry',
}

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/** The API for a branch `main` (not protected) whose changes list `changed`. */
const stubApi = (changed: string[]) => {
  const threads: unknown[] = []
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(url, 'http://localhost').pathname
    if (path.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups: [] }))
    if (path.endsWith('/main/comments')) return Promise.resolve(okJson({ threads, users: [] }))
    if (path.endsWith('/main/changes')) {
      return Promise.resolve(
        okJson({
          base: 'main',
          entries: changed.map((logicalPath) => ({
            status: 'modified',
            logicalPath,
            contentId: hello.contentId,
            collectionPath: 'content/posts',
            entryType: 'post',
          })),
          collections: [],
          hiddenChanges: false,
        }),
      )
    }
    if (path.includes('/main/changes/')) {
      return Promise.resolve(
        okJson({
          before: { format: 'json', entryType: 'post', data: { title: 'Old title' } },
          after: { format: 'json', entryType: 'post', data: { title: 'Loaded title' } },
          mergeBaseSha: 'a'.repeat(40),
        }),
      )
    }
    if (path.endsWith('/api/canopycms/branches')) {
      return Promise.resolve(
        okJson({
          branches: [
            {
              name: 'main',
              status: 'editing',
              access: {},
              createdBy: 'user-1',
              createdAt: '2024-01-01',
              updatedAt: '2024-01-01',
              isProtected: false,
              readOnly: false,
              writeBlocked: false,
              submitBlocked: false,
            },
          ],
          defaultBranch: 'main',
          users: [],
        }),
      )
    }
    if (path.endsWith('/schema')) {
      return Promise.resolve(
        okJson({
          schema: {},
          flatSchema: [
            {
              type: 'collection',
              logicalPath: 'content/posts',
              name: 'posts',
              label: 'Posts',
              entries: [{ name: 'post', format: 'json', schema }],
            },
            {
              type: 'entry-type',
              logicalPath: 'content/posts/post',
              name: 'post',
              parentPath: 'content/posts',
              format: 'json',
              schemaRef: 'postSchema',
            },
          ],
          entrySchemas: { postSchema: schema },
        }),
      )
    }
    if (path.includes('/entries')) {
      return Promise.resolve(
        okJson({
          collections: [],
          entries: [
            {
              logicalPath: hello.path,
              contentId: hello.contentId,
              collectionPath: hello.collectionPath,
              collectionName: hello.collectionName,
              slug: hello.slug,
              title: hello.label,
              format: hello.format,
              entryType: 'post',
              physicalPath: `/content/posts.abc123XYZ789/post.hello.${hello.contentId}.json`,
              exists: true,
            },
          ],
          pagination: { hasMore: false, limit: 50 },
        }),
      )
    }
    if (path.includes('/content/content/posts/') && (!init?.method || init.method === 'GET')) {
      return Promise.resolve(okJson({ title: 'Loaded title', version: 100 }))
    }
    if (path.includes('/content/content/posts/') && init?.method === 'PUT') {
      return Promise.resolve(okJson({ format: 'json', data: { title: 'Saved' }, version: 101 }))
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const renderEditor = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[hello]}
          initialSelectedId={hello.path}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const titleInput = () => screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement
const requested = (fetch: ReturnType<typeof stubApi>, fragment: string) =>
  fetch.mock.calls.some(([input]) => String(input).includes(fragment))

describe('Show changes', () => {
  it('opens the changed entry’s comparison and returns focus to its button on Escape', async () => {
    const fetch = stubApi(['content/posts/hello'])
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    const button = await screen.findByTestId('entry-show-changes')
    expect(button.textContent).toBe('Show changes')
    expect(requested(fetch, '/main/changes/')).toBe(false)

    await userEvent.click(button)
    const dialog = await screen.findByRole('dialog', { name: 'Changes to Hello' })
    await waitFor(() =>
      expect(within(dialog).getByTestId('entry-changes-summary').textContent).toBe(
        '1 field changed since main',
      ),
    )
    expect(requested(fetch, `/main/changes/content/posts/hello?id=${hello.contentId}`)).toBe(true)
    expect(within(dialog).queryByTestId('entry-changes-unsaved')).toBeNull()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it('says unsaved edits are left out of the comparison', async () => {
    stubApi(['content/posts/hello'])
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.type(titleInput(), ' edited')
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    const dialog = await screen.findByRole('dialog', { name: 'Changes to Hello' })
    expect((await within(dialog).findByTestId('entry-changes-unsaved')).textContent).toContain(
      'Unsaved edits aren’t included.',
    )
  })

  it('fetches nothing for a closed drawer when a save reloads the branch’s changes', async () => {
    const fetch = stubApi(['content/posts/hello'])
    const calls = (fragment: string) =>
      fetch.mock.calls.filter(([input]) =>
        new URL(String(input), 'http://localhost').pathname.endsWith(fragment),
      ).length
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    const dialog = await screen.findByRole('dialog', { name: 'Changes to Hello' })
    await within(dialog).findByTestId('entry-changes-summary')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const entryReads = calls('/main/changes/content/posts/hello')
    const listReads = calls('/main/changes')

    await userEvent.type(titleInput(), ' edited')
    await userEvent.click(screen.getByTestId('save-button'))
    await waitFor(() => expect(calls('/main/changes')).toBeGreaterThan(listReads))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls('/main/changes/content/posts/hello')).toBe(entryReads)
  })

  it('isn’t offered on an entry the branch hasn’t changed', async () => {
    const fetch = stubApi([])
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await waitFor(() => expect(requested(fetch, '/main/changes')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTestId('entry-show-changes')).toBeNull()
  })
})
