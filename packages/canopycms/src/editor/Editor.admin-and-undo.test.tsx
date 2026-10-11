/**
 * Admin surfaces render only for admins; a form Remove offers Undo, which puts the item back into
 * the draft as it is then; and comment authors resolve to names only where the lookup is allowed.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'
import { MantineProvider } from '@mantine/core'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { RESERVED_GROUPS } from '../authorization'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn() } }
})

// Records the resolver the editor hands the form.
const formProps = vi.hoisted(() => ({ onGetUserMetadata: [] as unknown[] }))
vi.mock('./FormRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./FormRenderer')>()
  const { createElement } = await import('react')
  const FormRenderer: typeof actual.FormRenderer = (props) => {
    formProps.onGetUserMetadata.push(props.onGetUserMetadata)
    return createElement(actual.FormRenderer, props)
  }
  return { ...actual, FormRenderer }
})

afterEach(() => {
  formProps.onGetUserMetadata.length = 0
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const schema: EntrySchema = [
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'links',
    type: 'object',
    label: 'Links',
    list: true,
    fields: [{ name: 'href', type: 'string', label: 'Href' }],
  },
]
const entryOf = (slug: string, contentId: string): EditorEntry => ({
  path: unsafeAsLogicalPath(`content/posts/${slug}`),
  contentId: unsafeAsContentId(contentId),
  label: slug === 'hello' ? 'Hello' : 'Other',
  status: 'entry',
  schema,
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug,
  format: 'json',
  type: 'entry',
})
const hello = entryOf('hello', 'def456ABC123')
const other = entryOf('other', 'ghi789DEF456')

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const stubApi = (groups: string[]) => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups }))
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
          entries: [hello, other].map((e) => ({
            logicalPath: e.path,
            contentId: e.contentId,
            collectionPath: e.collectionPath,
            collectionName: e.collectionName,
            slug: e.slug,
            title: e.label,
            format: e.format,
            entryType: 'post',
            physicalPath: `/content/posts.abc123XYZ789/post.${e.slug}.${e.contentId}.json`,
            exists: true,
          })),
          pagination: { hasMore: false, limit: 50 },
        }),
      )
    }
    if (url.includes('/content/content/posts/') && (!init?.method || init.method === 'GET')) {
      return Promise.resolve(
        okJson({ title: 'Loaded title', links: [{ href: '/a' }, { href: '/b' }], version: 100 }),
      )
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderEditor = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[hello, other]}
          initialSelectedId={hello.path}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const loaded = async () => {
  await waitFor(() => {
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(
      'Loaded title',
    )
  })
}

const openNavigator = async () => {
  fireEvent.click(screen.getByTestId('file-dropdown-button'))
  fireEvent.click(await screen.findByTestId('all-files-menu-item'))
  await screen.findByTestId('entry-nav-item-posts')
}

const persistedDraft = (contentId: string): Record<string, unknown> | undefined => {
  const raw = window.localStorage.getItem('canopycms:drafts:main')
  return raw
    ? (JSON.parse(raw) as { drafts: Record<string, Record<string, unknown>> }).drafts[contentId]
    : undefined
}

describe('admin surfaces', () => {
  it.each([
    ['an editor', [] as string[], false],
    ['an admin', [RESERVED_GROUPS.ADMINS], true],
  ])('are offered to %s only where the API would accept them', async (_who, groups, admin) => {
    stubApi(groups)
    renderEditor()
    await loaded()

    fireEvent.click(screen.getByTestId('settings-button'))
    await screen.findByTestId('settings-menu-media-library')
    for (const item of ['permissions', 'groups', 'system-health']) {
      expect(screen.queryByTestId(`settings-menu-${item}`) !== null).toBe(admin)
    }

    await openNavigator()
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    await screen.findByTestId('add-entry-menu-item')
    for (const label of ['Add Sub-Collection', 'Edit Collection', 'Delete Collection']) {
      expect(screen.queryByText(label) !== null).toBe(admin)
    }
  })
})

describe('Undo after Remove', () => {
  const undoToast = () => {
    const call = vi
      .mocked(notifications.show)
      .mock.calls.find(([options]) => String(options.id ?? '').startsWith('canopy-undo-'))
    expect(call).toBeDefined()
    return call![0]
  }

  it('puts the item back into the draft as it is then, keeping an edit made in between', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    const second = screen.getByRole('group', { name: 'Links #2' })
    fireEvent.click(within(second).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(persistedDraft(hello.contentId)?.links).toEqual([{ href: '/a' }]))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Edited after the removal' },
    })

    const toast = undoToast()
    const message = render(<MantineProvider>{toast.message}</MantineProvider>)
    expect(message.getByText('Removed "Links #2"')).toBeTruthy()
    act(() => fireEvent.click(message.getByRole('button', { name: 'Undo' })))

    await waitFor(() => {
      const draft = persistedDraft(hello.contentId)
      expect(draft?.title).toBe('Edited after the removal')
      expect(draft?.links).toEqual([{ href: '/a' }, { href: '/b' }])
    })
    expect(notifications.hide).toHaveBeenCalledWith(toast.id)
  })

  it('closes its toast when another entry opens, so it can never act on that entry', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Links #1' })).getByRole('button', {
        name: 'Remove',
      }),
    )
    const toast = undoToast()
    expect(notifications.hide).not.toHaveBeenCalledWith(toast.id)

    await openNavigator()
    fireEvent.click(await screen.findByTestId('entry-nav-item-other'))

    await waitFor(() => expect(notifications.hide).toHaveBeenCalledWith(toast.id))
  })
})

describe('comment author names', () => {
  it.each([
    ['an editor', [] as string[], false],
    ['a reviewer', [RESERVED_GROUPS.REVIEWERS], true],
  ])('are looked up for %s only where the lookup is allowed', async (_who, groups, resolves) => {
    stubApi(groups)
    renderEditor()
    await loaded()
    await waitFor(() =>
      expect(typeof formProps.onGetUserMetadata.at(-1) === 'function').toBe(resolves),
    )
  })
})
