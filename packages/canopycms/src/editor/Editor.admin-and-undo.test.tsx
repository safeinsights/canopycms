/**
 * Admin surfaces render only for admins; a form Remove offers Undo, which puts the item back into
 * the draft as it is then; and comment authors resolve to names only where the lookup is allowed.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'
import { MantineProvider } from '@mantine/core'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { RESERVED_GROUPS } from '../authorization'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'
import { mockConsole, type MockConsole } from '../test-utils/console-spy'

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
  {
    name: 'seo',
    type: 'object',
    label: 'SEO',
    fields: [{ name: 'summary', type: 'string', label: 'Summary' }],
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

const stubApi = (
  groups: string[],
  threads: unknown[] = [],
  branchOwner = 'user-1',
  listedName = 'main',
  links = [{ href: '/a' }, { href: '/b' }],
) => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups }))
    if (url.endsWith('/main/comments')) {
      return Promise.resolve(okJson({ threads, users: [{ id: 'author-1', name: 'Ada Lovelace' }] }))
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
              name: listedName,
              status: 'editing',
              access: {},
              createdBy: branchOwner,
              createdAt: '2024-01-01',
              updatedAt: '2024-01-01',
              isProtected: false,
              readOnly: false,
              writeBlocked: false,
              submitBlocked: false,
            },
          ],
          defaultBranch: 'main',
          users: [{ id: 'owner-9', name: 'Olive Owner' }],
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
        okJson({ title: 'Loaded title', links, seo: { summary: 'Saved summary' }, version: 100 }),
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

/** Opens the content panel from the rail, unless it is open already. */
const openNavigator = async () => {
  const toggle = screen.getByTestId('content-panel-toggle')
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  await screen.findByTestId('entry-nav-item-posts')
}

const persistedDraft = (contentId: string): Record<string, unknown> | undefined => {
  const raw = window.localStorage.getItem('canopycms:drafts:main')
  return raw
    ? (JSON.parse(raw) as { drafts: Record<string, Record<string, unknown>> }).drafts[contentId]
    : undefined
}

/**
 * The hrefs of the draft's `links`. Every item carries a `_key` the editor minted, so the items
 * themselves are compared by what a person sees; the keys are checked to be present and distinct.
 */
const persistedHrefs = (contentId: string): string[] | undefined => {
  const links = persistedDraft(contentId)?.links as
    | Array<{ href: string; _key?: string }>
    | undefined
  if (!links) return undefined
  const keys = links.map((link) => link._key)
  expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true)
  expect(new Set(keys).size).toBe(keys.length)
  return links.map((link) => link.href)
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
    await screen.findByTestId('settings-menu-about')
    for (const item of ['permissions', 'groups', 'system-health']) {
      expect(screen.queryByTestId(`settings-menu-${item}`) !== null).toBe(admin)
    }

    await openNavigator()
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    await screen.findByTestId('add-entry-menu-item')
    for (const label of ['Add sub-collection…', 'Edit collection…', 'Delete collection']) {
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

  it('returns focus on close to the rail button that opened it over the overlay', async () => {
    stubApi([])
    renderEditor()
    await loaded()
    await openNavigator()
    const search = screen.getByTestId('rail-search-button')

    act(() => search.focus())
    fireEvent.click(search)
    const input = await screen.findByTestId('quick-open-input')
    await waitFor(() => expect(screen.queryByTestId('entry-nav-filter')).toBeNull())
    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('quick-open-input')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it("returns focus to the overlay's opener when opened from inside the overlay", async () => {
    stubApi([])
    renderEditor()
    await loaded()
    const toggle = screen.getByTestId('content-panel-toggle')
    act(() => toggle.focus())
    await openNavigator()

    fireEvent.keyDown(screen.getByTestId('entry-nav-filter'), { key: 'p', ctrlKey: true })
    const input = await screen.findByTestId('quick-open-input')
    await waitFor(() => expect(screen.queryByTestId('entry-nav-filter')).toBeNull())
    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('quick-open-input')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(toggle))
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

describe('saving collection details', () => {
  // The hook logs each failed write.
  let consoleSpy: MockConsole
  beforeEach(() => {
    consoleSpy = mockConsole()
  })
  afterEach(() => consoleSpy.restore())

  /** Answers every collection PATCH with `response`; everything else as `stubApi` does. */
  const stubCollectionPatch = (response: () => Response) => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return init?.method === 'PATCH' && url.includes('/schema/collection/')
        ? Promise.resolve(response())
        : answerOthers(input, init)
    })
    return fetchMock
  }

  const entryListReads = (fetchMock: ReturnType<typeof stubApi>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/entries')).length

  const saveNewLabel = async () => {
    await openNavigator()
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    fireEvent.click(await screen.findByText('Edit collection…'))
    const dialog = await screen.findByRole('dialog', { name: /^Edit collection:/ })
    fireEvent.change(within(dialog).getByLabelText(/^Label/), { target: { value: 'Articles' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save collection details' }))
  }

  it("closes the dialog and refreshes the content tree when a gateway's 5xx page answers", async () => {
    const fetchMock = stubCollectionPatch(
      () =>
        new Response('<html>Gateway Time-out</html>', {
          status: 504,
          headers: { 'Content-Type': 'text/html' },
        }),
    )
    renderEditor()
    await loaded()
    await openNavigator()
    const readsBefore = entryListReads(fetchMock)

    await saveNewLabel()

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^Edit collection:/ })).toBeNull(),
    )
    await waitFor(() => expect(entryListReads(fetchMock)).toBeGreaterThan(readsBefore))
    expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'canopy-collection-outcome-unknown', color: 'yellow' }),
    )
  })

  it("closes the create dialog and points at the content tree when a gateway's 5xx page answers", async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return init?.method === 'POST' && url.endsWith('/schema/collections')
        ? Promise.resolve(
            new Response('<html>Gateway Time-out</html>', {
              status: 504,
              headers: { 'Content-Type': 'text/html' },
            }),
          )
        : answerOthers(input, init)
    })
    renderEditor()
    await loaded()
    await openNavigator()
    const user = userEvent.setup()
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    fireEvent.click(await screen.findByText('Add sub-collection…'))
    const dialog = await screen.findByRole('dialog', { name: 'Create collection' })
    await user.type(within(dialog).getByLabelText(/^Name/), 'notes')
    await user.click(within(dialog).getByRole('button', { name: 'Add entry type…' }))
    const addDialog = await screen.findByRole('dialog', { name: 'Add entry type' })
    await user.type(within(addDialog).getByLabelText(/^Name/), 'note')
    await user.click(within(addDialog).getByRole('button', { name: 'Add entry type' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add entry type' })).toBeNull())

    await user.click(within(dialog).getByRole('button', { name: 'Create collection' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Create collection' })).toBeNull(),
    )
    expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'canopy-collection-outcome-unknown', color: 'yellow' }),
    )
  })

  it('keeps the dialog open with the error when the API refuses the save', async () => {
    const fetchMock = stubCollectionPatch(
      () =>
        new Response(JSON.stringify({ ok: false, status: 400, error: 'Name already taken' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    renderEditor()
    await loaded()
    await openNavigator()
    const readsBefore = entryListReads(fetchMock)

    await saveNewLabel()

    const dialog = await screen.findByRole('dialog', { name: /^Edit collection:/ })
    expect(await within(dialog).findByText('Name already taken')).toBeTruthy()
    expect(entryListReads(fetchMock)).toBe(readsBefore)
    expect(vi.mocked(notifications.show)).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'canopy-collection-outcome-unknown' }),
    )
  })

  it('counts an unanswered entry type add as landed when the branch lists it', async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    // The add reaches the server and lands, but its answer never comes back.
    let landed = false
    const postType = { name: 'post', format: 'json', schemaRef: 'postSchema', usageCount: 0 }
    fetchMock.mockImplementation((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (init?.method === 'POST' && url.includes('/schema/entry-types/')) {
        landed = true
        return Promise.resolve(
          new Response('<html>Gateway Time-out</html>', {
            status: 504,
            headers: { 'Content-Type': 'text/html' },
          }),
        )
      }
      if (!url.includes('/schema/collection/')) return answerOthers(input, init)
      return Promise.resolve(
        okJson({
          collection: { name: 'posts' },
          entryTypesWithUsage: landed ? [postType, { ...postType, name: 'article' }] : [postType],
        }),
      )
    })
    renderEditor()
    await loaded()
    await openNavigator()
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    fireEvent.click(await screen.findByText('Edit collection…'))
    const dialog = await screen.findByRole('dialog', { name: /^Edit collection:/ })
    const user = userEvent.setup()

    await user.click(within(dialog).getByRole('button', { name: 'Add entry type…' }))
    const addDialog = await screen.findByRole('dialog', { name: 'Add entry type' })
    await user.type(within(addDialog).getByLabelText(/^Name/), 'article')
    await user.click(within(addDialog).getByRole('button', { name: 'Add entry type' }))

    expect(await within(dialog).findByText('Entry type "article" added')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Actions for article' })).toBeTruthy()
    expect(within(dialog).queryByText('No answer from the server')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add entry type' })).toBeNull())
  })
})

/** Opens a row's "..." menu and chooses Remove, as a person does. */
const removeRow = async (rowTitle: string) => {
  fireEvent.click(
    within(screen.getByRole('group', { name: rowTitle })).getByRole('button', {
      name: `Actions for ${rowTitle}`,
    }),
  )
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
}

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

    await removeRow('/b')
    await waitFor(() => expect(persistedHrefs(hello.contentId)).toEqual(['/a']))
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
      expect(persistedHrefs(hello.contentId)).toEqual(['/a', '/b'])
    })
    expect(notifications.hide).toHaveBeenCalledWith(toast.id)
  })

  it('moves focus into the restored row once Undo has put it back', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    await removeRow('/b')
    await waitFor(() => expect(persistedHrefs(hello.contentId)).toEqual(['/a']))
    const message = render(<MantineProvider>{undoToast().message}</MantineProvider>)
    // The toast's Undo button holds focus, as it does when a keyboard user presses it.
    const undo = message.getByRole('button', { name: /^Undo removing / })
    act(() => undo.focus())
    act(() => fireEvent.click(undo))

    const restored = await screen.findByRole('group', { name: '/b' })
    await waitFor(() => expect(restored.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).not.toBe(restored)
  })

  it('closes the content overlay over the form before focusing the restored row', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    await removeRow('/b')
    await waitFor(() => expect(persistedHrefs(hello.contentId)).toEqual(['/a']))
    // jsdom matches no media query, so the panel is an overlay on the form.
    await openNavigator()
    expect(screen.getByTestId('form-pane').hasAttribute('inert')).toBe(true)
    const message = render(<MantineProvider>{undoToast().message}</MantineProvider>)
    act(() => fireEvent.click(message.getByRole('button', { name: /^Undo removing / })))

    await waitFor(() => expect(screen.queryByTestId('content-panel')).toBeNull())
    expect(screen.getByTestId('form-pane').hasAttribute('inert')).toBe(false)
    const restored = await screen.findByRole('group', { name: '/b' })
    await waitFor(() => expect(restored.contains(document.activeElement)).toBe(true))
  })

  it('moves focus to the row that came back, when the list shrank below its old index', async () => {
    stubApi([], [], 'user-1', 'main', [{ href: '/a' }, { href: '/b' }, { href: '/c' }])
    renderEditor()
    await loaded()

    await removeRow('/c')
    await removeRow('/a')
    await waitFor(() => expect(persistedHrefs(hello.contentId)).toEqual(['/b']))
    const message = render(<MantineProvider>{undoToast().message}</MantineProvider>)
    act(() => fireEvent.click(message.getByRole('button', { name: /^Undo removing / })))

    const restored = await screen.findByRole('group', { name: '/c' })
    await waitFor(() => expect(restored.contains(document.activeElement)).toBe(true))
    expect(persistedHrefs(hello.contentId)).toEqual(['/b', '/c'])
  })

  it('keeps focus on the named list after Remove, and holds the toast open only while it has focus', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    const list = screen.getByRole('group', { name: 'Links' })
    await removeRow('/b')
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

    await removeRow('/a')
    const toast = undoToast()
    expect(notifications.hide).not.toHaveBeenCalledWith(toast.id)

    await openNavigator()
    fireEvent.click(await screen.findByTestId('entry-nav-item-other'))

    await waitFor(() => expect(notifications.hide).toHaveBeenCalledWith(toast.id))
  })
})

describe('Clear and its Undo', () => {
  const undoToast = () => {
    const call = vi
      .mocked(notifications.show)
      .mock.calls.find(([options]) => String(options.id ?? '').startsWith('canopy-undo-'))
    expect(call).toBeDefined()
    return call![0]
  }

  it('puts the object back and moves focus into it', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    const seo = screen.getByRole('group', { name: 'SEO' })
    const clear = screen.getByRole('button', { name: 'Clear "SEO"' })
    act(() => clear.focus())
    fireEvent.click(clear)
    await waitFor(() => expect(persistedDraft(hello.contentId)).toBeDefined())
    expect(persistedDraft(hello.contentId)?.seo).toBeUndefined()
    // The button goes with the value, so focus stays on the object rather than the page.
    expect(screen.queryByRole('button', { name: 'Clear "SEO"' })).toBeNull()
    expect(document.activeElement).toBe(seo)

    const message = render(<MantineProvider>{undoToast().message}</MantineProvider>)
    expect(message.getByText('Cleared "SEO"')).toBeTruthy()
    const undo = message.getByRole('button', { name: 'Undo clearing "SEO"' })
    act(() => undo.focus())
    act(() => fireEvent.click(undo))

    await waitFor(() =>
      expect(persistedDraft(hello.contentId)?.seo).toEqual({ summary: 'Saved summary' }),
    )
    const summary = screen.getByRole('textbox', { name: 'Summary' })
    await waitFor(() => expect(document.activeElement).toBe(summary))
    expect((summary as HTMLInputElement).value).toBe('Saved summary')
  })

  it('puts nothing back once the object has been filled in again', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Clear "SEO"' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Typed after' },
    })
    await waitFor(() =>
      expect(persistedDraft(hello.contentId)?.seo).toEqual({ summary: 'Typed after' }),
    )

    const message = render(<MantineProvider>{undoToast().message}</MantineProvider>)
    act(() => fireEvent.click(message.getByRole('button', { name: 'Undo clearing "SEO"' })))

    expect(notifications.show).toHaveBeenLastCalledWith({
      message: `Couldn't undo clearing "SEO": that part of the entry has changed. Fill it in again if you still need it.`,
      color: 'yellow',
    })
    expect(persistedDraft(hello.contentId)?.seo).toEqual({ summary: 'Typed after' })
  })
})

describe('Undo is one-shot and ends with the draft', () => {
  const undoToastOf = () => {
    const call = vi
      .mocked(notifications.show)
      .mock.calls.find(([options]) => String(options.id ?? '').startsWith('canopy-undo-'))
    return call![0]
  }
  const removeSecondLink = () => removeRow('/b')

  it('puts an item back once, however many times Undo is clicked', async () => {
    stubApi([])
    renderEditor()
    await loaded()
    await removeSecondLink()
    await waitFor(() => expect(persistedHrefs(hello.contentId)).toEqual(['/a']))

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
    await removeSecondLink()
    await waitFor(() => expect(persistedHrefs(hello.contentId)).toEqual(['/a']))
    const toast = undoToastOf()

    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByText('Refresh from server'))
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
    await removeSecondLink()
    await waitFor(() => expect(persistedHrefs(hello.contentId)).toEqual(['/a']))
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

describe('comments panel', () => {
  const thread = (id: string, entryPath: string, canopyPath: string, authorId: string) => ({
    id,
    type: 'field',
    entryPath,
    canopyPath,
    authorId,
    createdAt: '2024-01-01T00:00:00.000Z',
    resolved: false,
    comments: [
      {
        id: `${id}-c1`,
        threadId: id,
        userId: authorId,
        timestamp: '2024-01-01T00:00:00.000Z',
        text: `Comment in ${id}`,
      },
    ],
  })
  const threads = [
    thread('theirs', 'content/posts/other', 'title', 'author-1'),
    thread('mine', 'content/posts/hello', 'links[0].href', 'user-1'),
  ]
  const openPanel = async (groups: string[]) => {
    stubApi(groups, threads)
    renderEditor()
    await loaded()
    fireEvent.click(screen.getByTestId('comments-button'))
    await screen.findByText('Comment in theirs')
  }
  const cardOf = (text: string) =>
    screen.getByText(text).closest('[data-testid="comment-thread"]') as HTMLElement

  it('lets an editor resolve only the threads they started', async () => {
    await openPanel([])

    expect(within(cardOf('Comment in theirs')).getByTestId('reply-thread-button')).toBeTruthy()
    expect(within(cardOf('Comment in theirs')).queryByTestId('resolve-thread-button')).toBeNull()
    expect(within(cardOf('Comment in mine')).getByTestId('resolve-thread-button')).toBeTruthy()
  })

  it('lets a reviewer resolve any thread', async () => {
    await openPanel([RESERVED_GROUPS.REVIEWERS])

    expect(within(cardOf('Comment in theirs')).getByTestId('resolve-thread-button')).toBeTruthy()
    expect(within(cardOf('Comment in mine')).getByTestId('resolve-thread-button')).toBeTruthy()
  })

  it('keeps a half-written reply when the panel is closed and opened again', async () => {
    await openPanel([])
    fireEvent.click(within(cardOf('Comment in theirs')).getByTestId('reply-thread-button'))
    fireEvent.change(within(cardOf('Comment in theirs')).getByRole('textbox'), {
      target: { value: 'Not sent yet' },
    })

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('Comment in theirs')).toBeNull())
    fireEvent.click(screen.getByTestId('comments-button'))
    await screen.findByText('Comment in theirs')

    expect(
      (within(cardOf('Comment in theirs')).getByRole('textbox') as HTMLTextAreaElement).value,
    ).toBe('Not sent yet')
  })

  it('names each thread by its entry and field labels, not their paths', async () => {
    await openPanel([])

    const headingOf = (text: string) =>
      within(cardOf(text)).getByTestId('comment-thread-heading').textContent
    expect(headingOf('Comment in theirs')).toBe('Field · Other › Title')
    // The open entry's value names the list item, as its own row does.
    expect(headingOf('Comment in mine')).toBe('Field · Hello › Links › /a › Href')
  })
})

describe('branches drawer', () => {
  it('marks the open branch as current and offers its workflow action rather than Open', async () => {
    stubApi([])
    renderEditor()
    await loaded()

    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))

    expect((await screen.findByTestId('branch-current-badge-main')).textContent).toBe('Current')
    expect(screen.queryByTestId('switch-to-branch-button-main')).toBeNull()
    expect(screen.getByTestId('submit-branch-button-main').textContent).toBe('Submit for review')
  })

  it("names the branch's owner for an editor from the branches response, sending no lookup", async () => {
    const fetchMock = stubApi([], [], 'owner-9')
    renderEditor()
    await loaded()

    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))

    expect(
      await within(await screen.findByTestId('branch-list-item-main')).findByText('Olive Owner'),
    ).toBeTruthy()
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/users/')),
    ).toHaveLength(0)
  })

  it('marks the open branch as current when its name only matches once sanitized', async () => {
    stubApi([], [], 'user-1', 'feature-x')
    renderEditor({ branchName: 'feature/x' })
    await loaded()

    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))

    expect(await screen.findByTestId('branch-current-badge-feature-x')).toBeTruthy()
    expect(screen.queryByTestId('switch-to-branch-button-feature-x')).toBeNull()
  })
})

describe('a collection write with no answer', () => {
  let consoleSpy: MockConsole
  beforeEach(() => {
    consoleSpy = mockConsole()
  })
  afterEach(() => consoleSpy.restore())

  const gatewayPage = () =>
    new Response('<html>Gateway Time-out</html>', {
      status: 504,
      headers: { 'Content-Type': 'text/html' },
    })
  const urlOf = (input: RequestInfo | URL) =>
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

  /**
   * Answers the collection create with a gateway's 5xx page. With `lands`, it reached the server
   * anyway, so the schema lists "notes" under "posts" from then on.
   */
  const stubUnansweredCreate = ({ lands }: { lands: boolean }) => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    let created = false
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input)
      if (init?.method === 'POST' && url.endsWith('/schema/collections')) {
        created = lands
        return gatewayPage()
      }
      const response = await answerOthers(input, init)
      if (!created || !url.includes('/schema') || url.includes('/schema/')) return response
      const body = await response.json()
      body.data.flatSchema.push({
        type: 'collection',
        logicalPath: 'content/posts/notes',
        name: 'notes',
        parentPath: 'content/posts',
        entries: [{ name: 'note', format: 'json', schema }],
      })
      return okJson(body.data)
    })
  }

  const createNotesCollection = async (user: ReturnType<typeof userEvent.setup>) => {
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    fireEvent.click(await screen.findByText('Add sub-collection…'))
    const dialog = await screen.findByRole('dialog', { name: 'Create collection' })
    await user.type(within(dialog).getByLabelText(/^Name/), 'notes')
    await user.click(within(dialog).getByRole('button', { name: 'Add entry type…' }))
    const addDialog = await screen.findByRole('dialog', { name: 'Add entry type' })
    await user.type(within(addDialog).getByLabelText(/^Name/), 'note')
    await user.click(within(addDialog).getByRole('button', { name: 'Add entry type' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add entry type' })).toBeNull())
    await user.click(within(dialog).getByRole('button', { name: 'Create collection' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Create collection' })).toBeNull(),
    )
  }

  const reopenCreate = async () => {
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    fireEvent.click(await screen.findByText('Add sub-collection…'))
    return screen.findByRole('dialog', { name: 'Create collection' })
  }

  it('fills the create dialog in again while the collection is not listed', async () => {
    stubUnansweredCreate({ lands: false })
    renderEditor()
    await loaded()
    await openNavigator()
    const user = userEvent.setup()

    await createNotesCollection(user)
    const dialog = await reopenCreate()

    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('notes')
    expect(within(dialog).getByText('note')).toBeTruthy()
    expect(within(dialog).getByText('Restored what you entered')).toBeTruthy()
  })

  it('says a create went through when reopening finds it listed, and fills nothing in', async () => {
    stubUnansweredCreate({ lands: true })
    renderEditor()
    await loaded()
    await openNavigator()
    const user = userEvent.setup()

    await createNotesCollection(user)
    const dialog = await reopenCreate()

    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('')
    expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Collection "notes" created', color: 'green' }),
    )
    expect(vi.mocked(notifications.hide)).toHaveBeenCalledWith('canopy-collection-outcome-unknown')
  })

  it('does not fill a create in again when the fresh read fails', async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    let created = false
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input)
      if (init?.method === 'POST' && url.endsWith('/schema/collections')) {
        created = true
        return gatewayPage()
      }
      // After the unanswered create, every schema read fails.
      if (created && url.includes('/schema') && !url.includes('/schema/')) return gatewayPage()
      return answerOthers(input, init)
    })
    renderEditor()
    await loaded()
    await openNavigator()
    const user = userEvent.setup()
    await createNotesCollection(user)

    const dialog = await reopenCreate()

    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('')
    expect(within(dialog).queryByText('Restored what you entered')).toBeNull()
  })

  it("keeps a create's draft through another collection write that succeeds", async () => {
    stubUnansweredCreate({ lands: false })
    renderEditor()
    await loaded()
    await openNavigator()
    const user = userEvent.setup()
    await createNotesCollection(user)

    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    fireEvent.click(await screen.findByText('Edit collection…'))
    const edit = await screen.findByRole('dialog', { name: /^Edit collection:/ })
    fireEvent.change(within(edit).getByLabelText(/^Label/), { target: { value: 'Articles' } })
    fireEvent.click(within(edit).getByRole('button', { name: 'Save collection details' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^Edit collection:/ })).toBeNull(),
    )

    const dialog = await reopenCreate()
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('notes')
  })

  // Two full create round trips on a loaded tree, near 2s alone; vitest's 5s default fails a busy CI shard.
  it(
    "keeps a create's draft through a create under another parent that succeeds",
    { timeout: 15000 },
    async () => {
      const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
      const answerOthers = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation(async (input, init) => {
        const url = urlOf(input)
        if (init?.method === 'POST' && url.endsWith('/schema/collections')) {
          const body = JSON.parse(String(init.body)) as { parentPath?: string }
          return body.parentPath === 'content/posts'
            ? gatewayPage()
            : okJson({ collectionPath: 'content/pages/drafts', contentId: 'drf123456789' })
        }
        const response = await answerOthers(input, init)
        if (!url.includes('/schema') || url.includes('/schema/')) return response
        const data = (await response.json()).data
        data.flatSchema.push({
          type: 'collection',
          logicalPath: 'content/pages',
          name: 'pages',
          label: 'Pages',
          entries: [{ name: 'page', format: 'json', schema }],
        })
        return okJson(data)
      })
      renderEditor()
      await loaded()
      await openNavigator()
      const user = userEvent.setup()
      await createNotesCollection(user)

      fireEvent.click(await screen.findByTestId('collection-menu-pages'))
      fireEvent.click(await screen.findByText('Add sub-collection…'))
      const other = await screen.findByRole('dialog', { name: 'Create collection' })
      await user.type(within(other).getByLabelText(/^Name/), 'drafts')
      await user.click(within(other).getByRole('button', { name: 'Add entry type…' }))
      const addDialog = await screen.findByRole('dialog', { name: 'Add entry type' })
      await user.type(within(addDialog).getByLabelText(/^Name/), 'draft')
      await user.click(within(addDialog).getByRole('button', { name: 'Add entry type' }))
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Add entry type' })).toBeNull(),
      )
      await user.click(within(other).getByRole('button', { name: 'Create collection' }))
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Create collection' })).toBeNull(),
      )

      const dialog = await reopenCreate()
      expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('notes')
    },
  )

  // Two full create round trips on a loaded tree, near 2s alone; vitest's 5s default fails a busy CI shard.
  it(
    "keeps a create's draft through another create from a dialog it did not fill",
    { timeout: 15000 },
    async () => {
      const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
      const answerOthers = fetchMock.getMockImplementation()!
      let creates = 0
      let failSchemaReads = false
      fetchMock.mockImplementation(async (input, init) => {
        const url = urlOf(input)
        if (init?.method === 'POST' && url.endsWith('/schema/collections')) {
          creates++
          return creates === 1
            ? gatewayPage()
            : okJson({ collectionPath: 'content/posts/other', contentId: 'oth123456789' })
        }
        if (failSchemaReads && url.includes('/schema') && !url.includes('/schema/')) {
          return gatewayPage()
        }
        return answerOthers(input, init)
      })
      renderEditor()
      await loaded()
      await openNavigator()
      const user = userEvent.setup()
      await createNotesCollection(user)

      // Reopened while the tree can't be read, the dialog is empty; "other" is created from it.
      failSchemaReads = true
      const empty = await reopenCreate()
      failSchemaReads = false
      expect((within(empty).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('')
      await user.type(within(empty).getByLabelText(/^Name/), 'other')
      await user.click(within(empty).getByRole('button', { name: 'Add entry type…' }))
      const addDialog = await screen.findByRole('dialog', { name: 'Add entry type' })
      await user.type(within(addDialog).getByLabelText(/^Name/), 'item')
      await user.click(within(addDialog).getByRole('button', { name: 'Add entry type' }))
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Add entry type' })).toBeNull(),
      )
      await user.click(within(empty).getByRole('button', { name: 'Create collection' }))
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Create collection' })).toBeNull(),
      )

      const dialog = await reopenCreate()
      expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('notes')
    },
  )

  it('fills a details save in again when the collection is reopened', async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input, init) =>
      init?.method === 'PATCH' && urlOf(input).includes('/schema/collection/')
        ? Promise.resolve(gatewayPage())
        : answerOthers(input, init),
    )
    renderEditor()
    await loaded()
    await openNavigator()
    const openEdit = async () => {
      fireEvent.click(screen.getByTestId('collection-menu-posts'))
      fireEvent.click(await screen.findByText('Edit collection…'))
      return screen.findByRole('dialog', { name: /^Edit collection:/ })
    }
    const first = await openEdit()
    fireEvent.change(within(first).getByLabelText(/^Label/), { target: { value: 'Articles' } })
    fireEvent.click(within(first).getByRole('button', { name: 'Save collection details' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^Edit collection:/ })).toBeNull(),
    )

    const dialog = await openEdit()

    expect((within(dialog).getByLabelText(/^Label/) as HTMLInputElement).value).toBe('Articles')
  })

  it("keeps an unanswered create's draft to its branch", async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    const listedBranch = (name: string) => ({
      name,
      status: 'editing',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      isProtected: false,
      readOnly: false,
      writeBlocked: false,
      submitBlocked: false,
    })
    // "feature" already has a collection named "notes" under "posts"; "main" never gets one.
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input)
      if (url.endsWith('/api/canopycms/branches')) {
        return okJson({
          branches: [listedBranch('main'), listedBranch('feature')],
          defaultBranch: 'main',
          users: [],
        })
      }
      if (init?.method === 'POST' && url.endsWith('/schema/collections')) return gatewayPage()
      const response = await answerOthers(input, init)
      if (!url.includes('/feature/schema') || url.includes('/schema/')) return response
      const body = await response.json()
      body.data.flatSchema.push({
        type: 'collection',
        logicalPath: 'content/posts/notes',
        name: 'notes',
        parentPath: 'content/posts',
        entries: [{ name: 'note', format: 'json', schema }],
      })
      return okJson(body.data)
    })
    renderEditor()
    await loaded()
    await openNavigator()
    const user = userEvent.setup()
    await createNotesCollection(user)

    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))
    fireEvent.click(await screen.findByTestId('switch-to-branch-button-feature'))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => urlOf(u).includes('/feature/schema'))).toBe(true),
    )
    await openNavigator()
    await screen.findByTestId('collection-menu-notes')

    expect(vi.mocked(notifications.show)).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Collection "notes" created' }),
    )
    const dialog = await reopenCreate()
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('')
  })

  it('checks a fresh tree before filling a create in again, and says it landed', async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    // The create lands only after the reload its failure triggers has already read the schema.
    let schemaReads = 0
    let createAnswered = false
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input)
      if (init?.method === 'POST' && url.endsWith('/schema/collections')) {
        createAnswered = true
        return gatewayPage()
      }
      const response = await answerOthers(input, init)
      if (!url.includes('/schema') || url.includes('/schema/')) return response
      if (createAnswered) schemaReads++
      if (schemaReads < 2) return response
      const body = await response.json()
      body.data.flatSchema.push({
        type: 'collection',
        logicalPath: 'content/posts/notes',
        name: 'notes',
        parentPath: 'content/posts',
        entries: [{ name: 'note', format: 'json', schema }],
      })
      return okJson(body.data)
    })
    renderEditor()
    await loaded()
    await openNavigator()
    const user = userEvent.setup()
    await createNotesCollection(user)
    await waitFor(() => expect(schemaReads).toBe(1))

    const dialog = await reopenCreate()

    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('')
    expect(within(dialog).queryByText('Restored what you entered')).toBeNull()
    expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Collection "notes" created', color: 'green' }),
    )
  })

  it('keeps nothing to fill in from a details save that sent no value', async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input, init) =>
      init?.method === 'PATCH' && urlOf(input).includes('/schema/collection/')
        ? Promise.resolve(gatewayPage())
        : answerOthers(input, init),
    )
    renderEditor()
    await loaded()
    await openNavigator()
    const openEdit = async () => {
      fireEvent.click(screen.getByTestId('collection-menu-posts'))
      fireEvent.click(await screen.findByText('Edit collection…'))
      return screen.findByRole('dialog', { name: /^Edit collection:/ })
    }
    // Clearing the label sends `label: undefined`, which JSON drops.
    const first = await openEdit()
    fireEvent.change(within(first).getByLabelText(/^Label/), { target: { value: '' } })
    fireEvent.click(within(first).getByRole('button', { name: 'Save collection details' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^Edit collection:/ })).toBeNull(),
    )

    const dialog = await openEdit()

    expect((within(dialog).getByLabelText(/^Label/) as HTMLInputElement).value).toBe('Posts')
    expect(within(dialog).queryByText('Restored what you entered')).toBeNull()
    expect(vi.mocked(notifications.show)).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Collection updated' }),
    )
  })

  it('settles a slug change that landed when the collection is reopened at its new path', async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    let renamed = false
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input)
      if (init?.method === 'PATCH' && url.includes('/schema/collection/')) {
        renamed = true
        return gatewayPage()
      }
      const response = await answerOthers(input, init)
      if (!renamed || !url.includes('/schema') || url.includes('/schema/')) return response
      const data = (await response.json()).data
      data.flatSchema = data.flatSchema.map((item: { logicalPath: string; parentPath?: string }) =>
        JSON.parse(JSON.stringify(item).replaceAll('content/posts', 'content/articles')),
      )
      return okJson(data)
    })
    renderEditor()
    await loaded()
    await openNavigator()
    const openEdit = async () => {
      fireEvent.click(await screen.findByTestId('collection-menu-posts'))
      fireEvent.click(await screen.findByText('Edit collection…'))
      return screen.findByRole('dialog', { name: /^Edit collection:/ })
    }
    const first = await openEdit()
    fireEvent.change(within(first).getByLabelText(/^Slug/), { target: { value: 'articles' } })
    fireEvent.click(within(first).getByRole('button', { name: 'Save collection details' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^Edit collection:/ })).toBeNull(),
    )

    const dialog = await openEdit()

    expect((within(dialog).getByLabelText(/^Slug/) as HTMLInputElement).value).toBe('articles')
    expect(within(dialog).queryByText('Restored what you entered')).toBeNull()
    expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Collection updated', color: 'green' }),
    )
    expect(vi.mocked(notifications.hide)).toHaveBeenCalledWith('canopy-collection-outcome-unknown')
  })

  it('ignores a slow edit opening once another opening has replaced it', async () => {
    const fetchMock = stubApi([RESERVED_GROUPS.ADMINS])
    const answerOthers = fetchMock.getMockImplementation()!
    let answerRead: () => void = () => {}
    fetchMock.mockImplementation((input, init) =>
      (init?.method ?? 'GET') === 'GET' && urlOf(input).includes('/schema/collection/')
        ? new Promise<Response>((resolve) => {
            answerRead = () =>
              resolve(okJson({ collection: { name: 'posts' }, entryTypesWithUsage: [] }))
          })
        : answerOthers(input, init),
    )
    renderEditor()
    await loaded()
    await openNavigator()
    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    fireEvent.click(await screen.findByText('Edit collection…'))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/schema/collection/')),
      ).toBe(true),
    )

    await reopenCreate()
    await act(async () => answerRead())

    expect(screen.getByRole('dialog', { name: 'Create collection' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: /^Edit collection:/ })).toBeNull()
  })
})

describe('adding entries the path permissions allow', () => {
  const urlOf = (input: RequestInfo | URL) =>
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

  /** The listing says whether this editor may add an entry to "posts". */
  const stubAddAccess = (canAddEntry: boolean) => {
    const fetchMock = stubApi(['editors'])
    const answerOthers = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      const response = await answerOthers(input, init)
      if (!urlOf(input).includes('/entries')) return response
      const data = (await response.json()).data
      return okJson({
        ...data,
        collectionAccess: [{ logicalPath: 'content/posts', canAddEntry }],
      })
    })
  }

  it('offers "Add entry…" where the listing allows it', async () => {
    stubAddAccess(true)
    renderEditor()
    await loaded()
    await openNavigator()

    fireEvent.click(await screen.findByTestId('collection-menu-posts'))
    expect(await screen.findByText('Add entry…')).toBeTruthy()
    expect(screen.queryByTestId('add-refused-message')).toBeNull()
  })

  it('offers no "Add entry…" where the listing refuses it', async () => {
    stubAddAccess(false)
    renderEditor()
    await loaded()
    await openNavigator()
    // The navigator has listed the collection's entries.
    expect((await screen.findAllByText('Other')).length).toBeGreaterThan(0)

    // "Add entry…" was the only item a non-admin had, so the collection has no menu, and says why.
    expect(screen.queryByTestId('collection-menu-posts')).toBeNull()
    expect(screen.getByTestId('add-refused-message').textContent).toBe(
      "You can't add entries here.",
    )
  })
})
