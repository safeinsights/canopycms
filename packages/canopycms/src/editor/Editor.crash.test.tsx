import React from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SWRConfig } from 'swr'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import type { CustomFieldRenderers } from './FormRenderer'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'
import { mockConsole, type MockConsole } from '../test-utils/console-spy'
import { silenceReportedRenderErrors } from '../test-utils/render-errors'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn() } }
})

const entryApiPath = '/api/canopycms/main/content/content/posts/hello'
const schema = [
  { name: 'title', type: 'string' as const, label: 'Title' },
  { name: 'settings', type: 'code' as const, label: 'Settings' },
]
const entry: EditorEntry = {
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

const stubApi = () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/api/canopycms/branches')) {
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
        }),
      )
    }
    if (url.includes('/schema') && !url.includes('/schema/')) {
      return Promise.resolve(
        okJson({
          schema: {},
          flatSchema: [
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
    if (url.includes('/entries')) {
      return Promise.resolve(
        okJson({
          collections: [
            {
              logicalPath: 'content/posts',
              contentId: 'abc123XYZ789',
              name: 'posts',
              type: 'collection',
              format: 'json',
              schema,
              order: [],
            },
          ],
          entries: [
            {
              logicalPath: entry.path,
              contentId: 'def456ABC123',
              collectionPath: entry.collectionPath,
              collectionName: entry.collectionName,
              slug: entry.slug,
              format: entry.format,
              entryType: 'post',
              physicalPath: '/content/posts.abc123XYZ789/post.hello.def456ABC123.json',
              exists: true,
            },
          ],
          pagination: { hasMore: false, limit: 50 },
        }),
      )
    }
    if (url === entryApiPath && (!init?.method || init.method === 'GET')) {
      return Promise.resolve(okJson({ title: 'Loaded title', settings: '{"a":1}', version: 100 }))
    }
    if (url.startsWith(entryApiPath) && init?.method === 'PUT') {
      return Promise.resolve(okJson(JSON.parse(init.body as string).data))
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderEditor = (props: {
  customRenderers?: CustomFieldRenderers
  renderPreview?: () => React.ReactNode
}) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[entry]}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
          {...props}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const titleInput = () =>
  waitFor(() => {
    const el = screen.getByRole<HTMLInputElement>('textbox', { name: /title/i })
    expect(el.value).not.toBe('')
    return el
  })

describe('Editor crash containment', () => {
  let consoleSpy: MockConsole
  let unsilence: () => void

  beforeEach(() => {
    consoleSpy = mockConsole()
    unsilence = silenceReportedRenderErrors()
  })

  afterEach(() => {
    unsilence()
    consoleSpy.restore()
    vi.unstubAllGlobals()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('saves the other fields, and the crashed field unchanged, while one field shows its error', async () => {
    const fetchMock = stubApi()
    renderEditor({
      customRenderers: {
        code: () => {
          throw new Error('settings exploded')
        },
      },
    })

    const input = await titleInput()
    expect(input.value).toBe('Loaded title')
    expect(screen.getByTestId('field-crash-fallback').textContent).toContain('Settings')
    expect(consoleSpy).toHaveErrored('[canopycms] editor error caught (field settings)')

    fireEvent.change(input, { target: { value: 'Modified title' } })
    const save = screen.getByRole('button', { name: /save file/i })
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false))
    fireEvent.click(save)

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
    )
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(put?.[1]?.body as string).data).toMatchObject({
      title: 'Modified title',
      settings: '{"a":1}',
    })
  })

  it('shows the crash screen when the editor itself throws, and a remount offers the earlier draft', async () => {
    stubApi()
    const explode = { now: false }
    const renderPreview = () => {
      if (explode.now) throw new Error('preview exploded')
      return <div>preview</div>
    }
    const first = renderEditor({ renderPreview })

    const input = await titleInput()
    fireEvent.change(input, { target: { value: 'Draft before the crash' } })
    await waitFor(() =>
      expect(window.localStorage.getItem('canopycms:drafts:main')).toContain(
        'Draft before the crash',
      ),
    )

    explode.now = true
    fireEvent.change(input, { target: { value: 'Typed as it crashed' } })

    const crashScreen = await screen.findByTestId('editor-crash-screen')
    expect(crashScreen.textContent).toContain('The editor stopped working')
    for (const name of ['Reload', 'Back to entries', 'Copy error details']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(consoleSpy).toHaveErrored('[canopycms] editor error caught (editor)')

    // What Reload does: the editor mounts again in the same browser.
    first.unmount()
    explode.now = false
    renderEditor({ renderPreview })

    await waitFor(async () => expect((await titleInput()).value).toBe('Draft before the crash'))
  })

  it('opens no entry, with the navigator showing, at the URL Back to entries goes to', async () => {
    const fetchMock = stubApi()
    window.history.replaceState({}, '', '/edit?entry=')
    renderEditor({
      renderPreview: () => {
        throw new Error('every entry crashes the editor')
      },
    })

    await waitFor(() => expect(screen.getAllByText('Hello').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Select an item to start editing.').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('editor-crash-screen')).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url === entryApiPath)).toBe(false)
    expect(new URLSearchParams(window.location.search).get('entry')).toBe('')
  })
})
