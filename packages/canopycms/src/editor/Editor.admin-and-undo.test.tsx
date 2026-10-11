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
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn(), update: vi.fn() } }
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
  // The editor keeps the open entry in the URL, which jsdom carries into the next test.
  window.history.replaceState({}, '', '/')
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
    if (url.endsWith('/main/comments')) {
      return Promise.resolve(
        okJson({ threads: [], users: [{ id: 'author-1', name: 'Ada Lovelace' }] }),
      )
    }
    if (url.endsWith('/users/batch')) {
      return Promise.resolve(
        okJson({ users: [{ id: 'author-1', name: 'Ada Lovelace', email: 'ada@example.test' }] }),
      )
    }
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

const renderEditor = (props: Partial<React.ComponentProps<typeof Editor>> = {}) =>
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
          {...props}
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
    for (const label of ['Add sub-collection…', 'Edit collection…', 'Delete collection…']) {
      expect(screen.queryByText(label) !== null).toBe(admin)
    }
  })
})

describe('quick open', () => {
  it('opens from inside the navigator drawer and closes the drawer', async () => {
    stubApi([])
    renderEditor()
    await loaded()
    await openNavigator()

    fireEvent.keyDown(screen.getByTestId('entry-nav-filter'), { key: 'p', ctrlKey: true })

    expect(await screen.findByTestId('quick-open-input')).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('entry-nav-filter')).toBeNull())
  })

  it('does not let the closing drawer hand focus back while the palette opens', async () => {
    stubApi([])
    renderEditor()
    await loaded()
    await openNavigator()

    // Which wins, the drawer's focus return or the palette's autofocus, is a race in a browser
    // (a 10ms timer against an animation frame), so watch for the return itself: nothing but the
    // palette's field may be focused.
    const focused: Element[] = []
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
    ) {
      focused.push(this)
    })
    fireEvent.keyDown(screen.getByTestId('entry-nav-filter'), { key: 'p', ctrlKey: true })
    await screen.findByTestId('quick-open-input')
    await new Promise((resolve) => setTimeout(resolve, 300))
    focus.mockRestore()

    const paletteInput = screen.getByTestId('quick-open-input')
    expect(focused).toContain(paletteInput)
    expect(focused.filter((element) => element !== paletteInput)).toEqual([])
  })
})

describe('dialogs opened from the navigator', () => {
  const openAddEntry = async () => {
    await openNavigator()
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    fireEvent.click(await screen.findByTestId('add-entry-menu-item'))
    return screen.findByTestId('create-entry-modal')
  }

  it('shows the page route under the slug, without the preview prefix', async () => {
    stubApi([])
    renderEditor({ previewPrefix: '/edit/preview' })
    await loaded()

    const modal = await openAddEntry()

    expect(within(modal).getByText('URL path: /posts/your-slug')).toBeTruthy()
  })

  it('closes only the dialog on Escape, leaving the drawer open', async () => {
    stubApi([])
    renderEditor()
    await loaded()
    const modal = await openAddEntry()

    fireEvent.keyDown(within(modal).getByTestId('entry-slug-input'), { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('create-entry-modal')).toBeNull())
    // A closing drawer stays mounted through its exit transition, so look after it would be gone.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(screen.getByTestId('entry-nav-filter')).toBeTruthy()
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

    const second = screen.getByRole('group', { name: '/b' })
    fireEvent.click(within(second).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(persistedDraft(hello.contentId)?.links).toEqual([{ href: '/a' }]))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Edited after the removal' },
    })

    const toast = undoToast()
    const message = render(<MantineProvider>{toast.message}</MantineProvider>)
    expect(message.getByText('Removed "/b" from Links')).toBeTruthy()
    act(() => fireEvent.click(message.getByRole('button', { name: /^Undo removing / })))

    await waitFor(() => {
      const draft = persistedDraft(hello.contentId)
      expect(draft?.title).toBe('Edited after the removal')
      expect(draft?.links).toEqual([{ href: '/a' }, { href: '/b' }])
    })
    expect(notifications.hide).toHaveBeenCalledWith(toast.id)
  })

  it('keeps focus on the named list after Remove, and holds the toast open only while it has focus', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    const list = screen.getByRole('group', { name: 'Links' })
    fireEvent.click(
      within(screen.getByRole('group', { name: '/b' })).getByRole('button', {
        name: 'Remove',
      }),
    )
    expect(document.activeElement).toBe(list)

    const toast = undoToast()
    const message = render(<MantineProvider>{toast.message}</MantineProvider>)
    act(() => message.getByRole('button', { name: 'Undo removing "/b" from Links' }).focus())
    expect(notifications.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: toast.id, autoClose: false }),
    )
    // Focus leaving the toast lets its timer run again.
    act(() => (document.activeElement as HTMLElement).blur())
    expect(notifications.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: toast.id, autoClose: toast.autoClose }),
    )
  })

  it('closes its toast when another entry opens, so it can never act on that entry', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    fireEvent.click(
      within(screen.getByRole('group', { name: '/a' })).getByRole('button', {
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

describe('Undo is one-shot and ends with the draft', () => {
  const undoToastOf = () => {
    const call = vi
      .mocked(notifications.show)
      .mock.calls.find(([options]) => String(options.id ?? '').startsWith('canopy-undo-'))
    return call![0]
  }
  const removeSecondLink = () =>
    fireEvent.click(
      within(screen.getByRole('group', { name: '/b' })).getByRole('button', {
        name: 'Remove',
      }),
    )

  it('puts an item back once, however many times Undo is clicked', async () => {
    stubApi([])
    renderEditor()
    await loaded()
    removeSecondLink()
    await waitFor(() => expect(persistedDraft(hello.contentId)?.links).toEqual([{ href: '/a' }]))

    const message = render(<MantineProvider>{undoToastOf().message}</MantineProvider>)
    const undo = message.getByRole('button', { name: /^Undo removing / })
    act(() => fireEvent.click(undo))
    await waitFor(() => expect(screen.getByRole('group', { name: '/b' })).toBeTruthy())
    // The second click of a double-click, landing after the first has rendered.
    act(() => fireEvent.click(undo))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(screen.getAllByRole('group', { name: '/b' })).toHaveLength(1)
    expect(
      vi.mocked(notifications.show).mock.calls.some(([options]) => options.color === 'yellow'),
    ).toBe(false)
  })

  it('does nothing for an Undo clicked as its toast closes after Reload', async () => {
    const { modals } = await import('@mantine/modals')
    vi.mocked(modals.openConfirmModal).mockImplementation((options) => {
      options.onConfirm?.()
      return 'mock-modal-id'
    })
    stubApi([])
    renderEditor()
    await loaded()
    removeSecondLink()
    await waitFor(() => expect(persistedDraft(hello.contentId)?.links).toEqual([{ href: '/a' }]))
    const toast = undoToastOf()

    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByText('Reload File'))
    await waitFor(() => expect(notifications.hide).toHaveBeenCalledWith(toast.id))
    await waitFor(() => expect(screen.getByRole('group', { name: '/b' })).toBeTruthy())

    // The click lands on the closing toast; it adds nothing and says why.
    const message = render(<MantineProvider>{toast.message}</MantineProvider>)
    act(() => fireEvent.click(message.getByRole('button', { name: /^Undo removing / })))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(screen.getAllByRole('group', { name: '/b' })).toHaveLength(1)
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Too late to undo removing "/b" from Links.' }),
    )
  })

  it('closes the Undo toast when the draft is discarded, and an Undo clicked anyway adds nothing', async () => {
    const { modals } = await import('@mantine/modals')
    vi.mocked(modals.openConfirmModal).mockImplementation((options) => {
      options.onConfirm?.()
      return 'mock-modal-id'
    })
    stubApi([])
    renderEditor()
    await loaded()
    removeSecondLink()
    await waitFor(() => expect(persistedDraft(hello.contentId)?.links).toEqual([{ href: '/a' }]))
    const toast = undoToastOf()

    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('discard-file-draft-menu-item'))
    await waitFor(() => expect(notifications.hide).toHaveBeenCalledWith(toast.id))
    await waitFor(() => expect(screen.getByRole('group', { name: '/b' })).toBeTruthy())

    const message = render(<MantineProvider>{toast.message}</MantineProvider>)
    act(() => fireEvent.click(message.getByRole('button', { name: /^Undo removing / })))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(screen.getAllByRole('group', { name: '/b' })).toHaveLength(1)
  })
})

describe('comment author names', () => {
  type Resolver = (userId: string) => Promise<unknown>
  const lastResolver = (): Resolver => {
    const resolver = formProps.onGetUserMetadata.at(-1)
    if (typeof resolver !== 'function') throw new Error('no resolver passed to the form')
    return resolver as Resolver
  }
  const lookupRequests = (fetchMock: ReturnType<typeof stubApi>) =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes('/users/'))

  it('names authors for an editor from the comments response, sending no lookup', async () => {
    const fetchMock = stubApi([])
    renderEditor()
    await loaded()

    await waitFor(async () =>
      expect(await lastResolver()('author-1')).toEqual({
        id: 'author-1',
        name: 'Ada Lovelace',
        email: '',
      }),
    )
    expect(lookupRequests(fetchMock)).toHaveLength(0)
  })

  it('looks authors up for a reviewer, which brings the email', async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.REVIEWERS])
    renderEditor()
    await loaded()

    await waitFor(async () =>
      expect(await lastResolver()('author-1')).toEqual({
        id: 'author-1',
        name: 'Ada Lovelace',
        email: 'ada@example.test',
      }),
    )
    expect(lookupRequests(fetchMock).length).toBeGreaterThan(0)
  })
})
