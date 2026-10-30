/**
 * The editor opened on a namespace branch by its short name (`?branch=spring`), the form pull
 * request links carry: it opens that branch unlocked under its listed name, so its drafts,
 * comments and Save all guard are the ones the full name reaches, and actions on it reach it.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { MantineProvider } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { RESERVED_GROUPS } from '../authorization/helpers'
import { mockConsole } from '../test-utils/console-spy'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../paths/test-utils'
import { exactBranchSegment } from '../paths/validation'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn(), update: vi.fn() } }
})

afterEach(() => {
  cleanup()
  // clearAllMocks keeps an implementation, so one test's autoConfirm would answer the next's.
  vi.mocked(modals.openConfirmModal).mockReset()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

const SPRING = 'canopycms/local/spring'

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const hello: EditorEntry = {
  path: unsafeAsLogicalPath('content/posts/hello'),
  contentId: unsafeAsContentId('def456ABC123'),
  label: 'Hello',
  status: 'entry',
  schema: [{ name: 'title', type: 'string' }],
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug: 'hello',
  format: 'json',
  type: 'entry',
}

const listed = (name: string, status: string) => ({
  name,
  shortName: name === SPRING ? 'spring' : name.replace('canopycms/local/', ''),
  status,
  access: {},
  createdBy: 'author-1',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  isProtected: name === 'main',
  readOnly: false,
  writeBlocked: status !== 'editing',
  submitBlocked: status !== 'editing',
})

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

/** The API path a listed branch's requests take: the exact form of its full name. */
const wire = (name: string) => `/api/canopycms/${encodeURIComponent(exactBranchSegment(name))}`

const changesNote = {
  id: 'note-1',
  comments: [
    {
      id: 'c1',
      threadId: 'note-1',
      userId: 'reviewer-1',
      timestamp: '2024-01-02T00:00:00.000Z',
      text: 'Please tighten the intro.',
    },
  ],
  resolved: false,
  createdAt: '2024-01-02T00:00:00.000Z',
  type: 'branch',
  authorId: 'reviewer-1',
}

const OUTSIDE = 'feature/x'

const stubApi = (options: {
  status: string
  userId: string
  holdSaves?: Promise<void>
  holdListing?: Promise<void>
  listingFails?: boolean
}) => {
  let changesRequested = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/whoami')) {
      return okJson({ userId: options.userId, groups: [RESERVED_GROUPS.REVIEWERS] })
    }
    if (url.endsWith('/comments')) {
      return okJson({ threads: changesRequested ? [changesNote] : [], users: [] })
    }
    if (url.endsWith('/api/canopycms/branches') && method === 'POST') {
      return okJson({
        branch: { ...listed('canopycms/local/summer', 'editing'), shortName: 'summer' },
      })
    }
    if (url.endsWith('/api/canopycms/branches')) {
      await options.holdListing
      if (options.listingFails) {
        return new Response(JSON.stringify({ ok: false, status: 500, error: 'Listing failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return okJson({
        branches: [
          listed('main', 'editing'),
          listed(SPRING, options.status),
          listed(OUTSIDE, 'editing'),
        ],
        defaultBranch: 'main',
        users: [],
      })
    }
    if (url.includes('/schema') && !url.includes('/schema/')) {
      return okJson({
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
        entrySchemas: { postSchema: hello.schema },
      })
    }
    if (url.includes('/entries')) {
      return okJson({
        collections: [
          {
            logicalPath: 'content/posts',
            contentId: 'abc123XYZ789',
            name: 'posts',
            type: 'collection',
            format: 'json',
            schema: hello.schema,
            order: [],
          },
        ],
        entries: [
          {
            logicalPath: hello.path,
            contentId: hello.contentId,
            collectionPath: hello.collectionPath,
            collectionName: hello.collectionName,
            slug: hello.slug,
            format: hello.format,
            entryType: 'post',
            physicalPath: `/content/posts.abc123XYZ789/post.hello.${hello.contentId}.json`,
            exists: true,
          },
        ],
        pagination: { hasMore: false, limit: 50 },
      })
    }
    if (url.includes('/content/content/posts/hello')) {
      if (method === 'PUT') {
        await options.holdSaves
        return okJson({ title: 'saved', version: 2 })
      }
      return okJson({ title: 'hello title', version: 1 })
    }
    if (url.endsWith('/request-changes') && method === 'POST') {
      changesRequested = true
      return okJson({ branch: { ...listed(SPRING, 'editing') } })
    }
    return okJson({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderEditor = (branchName: string) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[hello]}
          title="Test Editor"
          branchName={branchName}
          operatingMode="dev"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const urlBranch = () => new URLSearchParams(window.location.search).get('branch')
const titleBox = async () =>
  (await screen.findByRole('textbox', { name: /^Title/ })) as HTMLInputElement
const openBranchesDrawer = async () => {
  fireEvent.click(screen.getByTestId('branch-dropdown-button'))
  fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))
}
const autoConfirm = () =>
  vi.mocked(modals.openConfirmModal).mockImplementation((options) => {
    void options.onConfirm?.()
    return 'confirm'
  })

describe('the editor on a namespace branch named by its short name', () => {
  it('keeps the short name in the URL, writing nothing', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')

    expect((await titleBox()).value).toBe('hello title')
    expect(urlBranch()).toBe('spring')
    expect(pushState).not.toHaveBeenCalled()
    expect(
      replaceState.mock.calls.filter(([, , url]) => String(url).includes('canopycms')),
    ).toEqual([])
  })

  it('stores no drafts under the short name it was opened by', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    expect((await titleBox()).value).toBe('hello title')
    await waitFor(() =>
      expect(within(screen.getByTestId('branch-dropdown-button')).getByText('spring')).toBeTruthy(),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(setItem.mock.calls.map(([key]) => key)).not.toContain('canopycms:drafts:spring')
  })

  it('rewrites a link carrying the full name to the short name, replacing the entry', async () => {
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(SPRING)}`)
    const pushState = vi.spyOn(window.history, 'pushState')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor(SPRING)

    await waitFor(() => expect(urlBranch()).toBe('spring'))
    expect((await titleBox()).value).toBe('hello title')
    expect(pushState).not.toHaveBeenCalled()
  })

  it('rewrites a history entry left on the full name to the short name when Back reaches it', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    expect((await titleBox()).value).toBe('hello title')
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('entry')).toBe(hello.path),
    )
    const pushState = vi.spyOn(window.history, 'pushState')
    // What an entry opened before the listing arrived keeps: the name the link gave.
    window.history.replaceState(
      window.history.state,
      '',
      `/?branch=${encodeURIComponent(SPRING)}&entry=${encodeURIComponent(hello.path)}`,
    )

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() => expect(urlBranch()).toBe('spring'))
    expect(new URLSearchParams(window.location.search).get('entry')).toBe(hello.path)
    expect(pushState).not.toHaveBeenCalled()
  })

  it('frames the preview under the short name', async () => {
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(SPRING)}`)
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor(SPRING)
    expect((await titleBox()).value).toBe('hello title')

    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
        '/posts/hello?branch=spring',
      ),
    )
  })

  it('keeps the preview frame on the short name across a refetch of entries that came before the listing', async () => {
    let release!: () => void
    const holdListing = new Promise<void>((resolve) => (release = resolve))
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(SPRING)}`)
    const fetchMock = stubApi({ status: 'editing', userId: 'author-1', holdListing })
    renderEditor(SPRING)
    expect((await titleBox()).value).toBe('hello title')
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
        `/posts/hello?branch=${encodeURIComponent(SPRING)}`,
      ),
    )

    await act(async () => release())
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
        '/posts/hello?branch=spring',
      ),
    )
    const frame = document.querySelector('iframe')
    const entriesReads = () =>
      fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('/entries')).length
    const readsBefore = entriesReads()
    fireEvent.change(await titleBox(), { target: { value: 'Edited' } })
    const save = await screen.findByTestId('save-button')
    await waitFor(() => expect(save.getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(save)
    await waitFor(() => expect(entriesReads()).toBeGreaterThan(readsBefore))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(document.querySelector('iframe')).toBe(frame)
    expect(frame?.getAttribute('src')).toBe('/posts/hello?branch=spring')
  })

  it('sends its requests to the listed branch exactly, and shows and links it by its short name', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    const fetchMock = stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    expect((await titleBox()).value).toBe('hello title')
    await waitFor(() =>
      expect(within(screen.getByTestId('branch-dropdown-button')).getByText('spring')).toBeTruthy(),
    )
    fireEvent.change(await titleBox(), { target: { value: 'Edited' } })
    const save = await screen.findByTestId('save-button')
    await waitFor(() => expect(save.getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(save)

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(new URL(urlOf(put![0]), 'http://x').pathname).toBe(
        `${wire(SPRING)}/content/content/posts/hello`,
      )
    })
    const paths = fetchMock.mock.calls.map(([input]) => new URL(urlOf(input), 'http://x').pathname)
    expect(paths).toContain(`${wire(SPRING)}/entries`)
    expect(urlBranch()).toBe('spring')
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('/posts/hello?branch=spring')
    await openBranchesDrawer()
    const card = await screen.findByTestId(`branch-list-item-${SPRING}`)
    expect(within(card).getByText('spring')).toBeTruthy()
    expect(screen.queryByText(SPRING)).toBeNull()
    expect(screen.queryByText(exactBranchSegment(SPRING))).toBeNull()
  })

  it('sends a branch outside the namespace exactly, under its full name', async () => {
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(OUTSIDE)}`)
    const fetchMock = stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor(OUTSIDE)
    expect((await titleBox()).value).toBe('hello title')

    const paths = fetchMock.mock.calls.map(([input]) => new URL(urlOf(input), 'http://x').pathname)
    expect(paths).toContain(`${wire(OUTSIDE)}/entries`)
    expect(paths).not.toContain('/api/canopycms/x/entries')
    expect(urlBranch()).toBe(OUTSIDE)
  })

  it('sends a namespace branch the server lists by its full name exactly', async () => {
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(SPRING)}`)
    const inner = stubApi({ status: 'editing', userId: 'author-1' })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input).endsWith('/api/canopycms/branches') && (init?.method ?? 'GET') === 'GET'
        ? okJson({
            // `shortNameOf` lists a namespace branch named after the active branch by its full name.
            branches: [
              listed('main', 'editing'),
              { ...listed(SPRING, 'editing'), shortName: SPRING },
              listed('spring', 'editing'),
            ],
            defaultBranch: 'spring',
            users: [],
          })
        : inner(input, init),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderEditor(SPRING)
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    fireEvent.change(await titleBox(), { target: { value: 'Edited' } })

    const saveAll = await screen.findByTestId('save-all-button')
    await waitFor(() => expect(saveAll.getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(saveAll)

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
    )
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(new URL(urlOf(put![0]), 'http://x').pathname).toBe(
      `${wire(SPRING)}/content/content/posts/hello`,
    )
    expect(urlBranch()).toBe(SPRING)
  })

  it('shows the short name on the pill and the drawer card, and the full name of an outside branch', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    expect((await titleBox()).value).toBe('hello title')

    await waitFor(() =>
      expect(within(screen.getByTestId('branch-dropdown-button')).getByText('spring')).toBeTruthy(),
    )
    await openBranchesDrawer()
    const card = await screen.findByTestId(`branch-list-item-${SPRING}`)
    expect(within(card).getByText('spring')).toBeTruthy()
    expect(screen.getByTestId(`branch-list-item-${OUTSIDE}`).textContent).toContain(OUTSIDE)
    expect(screen.queryByText(SPRING)).toBeNull()
  })

  it('names the branch by its short name in the comments panel', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    expect((await titleBox()).value).toBe('hello title')
    await waitFor(() =>
      expect(within(screen.getByTestId('branch-dropdown-button')).getByText('spring')).toBeTruthy(),
    )

    fireEvent.click(screen.getByTestId('comments-button'))

    const note = await screen.findByText(/Posts a branch-level comment on/)
    expect(note.textContent).toContain('on "spring".')
  })

  it('names the new branch by its short name in the toast that says it was created', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    const fetchMock = stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    expect((await titleBox()).value).toBe('hello title')
    const pushState = vi.spyOn(window.history, 'pushState')
    await openBranchesDrawer()
    fireEvent.click(await screen.findByTestId('create-branch-button'))
    fireEvent.change(await screen.findByTestId('branch-name-input'), {
      target: { value: 'summer' },
    })

    fireEvent.click(screen.getByTestId('create-branch-submit'))

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({
        message: 'Branch “summer” created',
        color: 'green',
      }),
    )
    await waitFor(() => expect(urlBranch()).toBe('summer'))
    // The listing may not hold it yet, so the push itself carries the short name.
    expect(
      pushState.mock.calls.map(([, , url]) => new URL(String(url)).searchParams.get('branch')),
    ).toEqual(['summer'])
    expect(
      fetchMock.mock.calls.some(([input]) =>
        urlOf(input).endsWith(`${wire('canopycms/local/summer')}/schema`),
      ),
    ).toBe(true)
  })

  it('says where unsaved drafts stay by the short name', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    fireEvent.change(await titleBox(), { target: { value: 'Edited' } })
    await openBranchesDrawer()

    fireEvent.click(await screen.findByTestId('switch-to-branch-button-main'))

    await waitFor(() => expect(modals.openConfirmModal).toHaveBeenCalled())
    const options = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)?.[0]
    const shown = render(<MantineProvider>{options?.children}</MantineProvider>)
    expect(shown.container.textContent).toContain('Your drafts stay on “spring” and')
  })

  it('says a Back onto a branch that is gone leaves it on the short name', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    expect((await titleBox()).value).toBe('hello title')
    await waitFor(() =>
      expect(within(screen.getByTestId('branch-dropdown-button')).getByText('spring')).toBeTruthy(),
    )

    window.history.replaceState({}, '', `/?branch=${encodeURIComponent('canopycms/local/gone')}`)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'Branch “canopycms/local/gone” no longer exists or you can no longer open it, ' +
            "so you're still on “spring”.",
        }),
      ),
    )
  })

  it('keeps a draft made on the short name for the branch reopened from the drawer', async () => {
    autoConfirm()
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))

    fireEvent.change(await titleBox(), { target: { value: 'Drafted on spring' } })
    await waitFor(() =>
      expect(window.localStorage.getItem(`canopycms:drafts:${SPRING}`)).toContain(
        'Drafted on spring',
      ),
    )

    await openBranchesDrawer()
    fireEvent.click(await screen.findByTestId('switch-to-branch-button-main'))
    await waitFor(() => expect(urlBranch()).toBe('main'))
    await openBranchesDrawer()
    fireEvent.click(await screen.findByTestId(`switch-to-branch-button-${SPRING}`))

    await waitFor(() => expect(urlBranch()).toBe('spring'))
    await waitFor(async () => expect((await titleBox()).value).toBe('Drafted on spring'))
  })

  it('goes Back onto the short name under the full name, touching no other drafts key', async () => {
    autoConfirm()
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    fireEvent.change(await titleBox(), { target: { value: 'Drafted on spring' } })
    await waitFor(() =>
      expect(window.localStorage.getItem(`canopycms:drafts:${SPRING}`)).toContain(
        'Drafted on spring',
      ),
    )
    await openBranchesDrawer()
    fireEvent.click(await screen.findByTestId('switch-to-branch-button-main'))
    await waitFor(() => expect(urlBranch()).toBe('main'))
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    window.history.replaceState(
      window.history.state,
      '',
      `/?branch=spring&entry=${encodeURIComponent(hello.path)}`,
    )
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(async () => expect((await titleBox()).value).toBe('Drafted on spring'))
    expect(urlBranch()).toBe('spring')
    expect(getItem.mock.calls.map(([key]) => key)).not.toContain('canopycms:drafts:spring')
    const emptied = setItem.mock.calls.filter(
      ([key, value]) =>
        key === `canopycms:drafts:${SPRING}` &&
        Object.keys((JSON.parse(value) as { drafts: object }).drafts).length === 0,
    )
    expect(emptied).toEqual([])
  })

  it('drops a confirmed switch from a Back that a later Back onto the open branch overtook', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    fireEvent.change(await titleBox(), { target: { value: 'Drafted on spring' } })
    await waitFor(() =>
      expect(window.localStorage.getItem(`canopycms:drafts:${SPRING}`)).toContain(
        'Drafted on spring',
      ),
    )

    window.history.replaceState(window.history.state, '', '/?branch=main')
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(modals.openConfirmModal).toHaveBeenCalled())
    const confirm = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)?.[0]
    const entryOnSpring = `/?branch=spring&entry=${encodeURIComponent(hello.path)}`
    window.history.replaceState(window.history.state, '', entryOnSpring)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await act(async () => {
      confirm?.onConfirm?.()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(`${window.location.pathname}${window.location.search}`).toBe(entryOnSpring)
    expect(within(screen.getByTestId('branch-dropdown-button')).getByText('spring')).toBeTruthy()
    expect((await titleBox()).value).toBe('Drafted on spring')
  })

  it('stays on its branch when a Back comes while it has no listing', async () => {
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    window.history.replaceState({}, '', '/?branch=main')
    stubApi({ status: 'editing', userId: 'author-1', listingFails: true })
    renderEditor('main')
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()

    window.history.replaceState(window.history.state, '', '/?branch=spring')
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(setItem.mock.calls.map(([key]) => key)).not.toContain('canopycms:drafts:spring')
    expect(urlBranch()).toBe('main')
    expect(fetchMock.mock.calls.some(([input]) => urlOf(input).includes('/spring/'))).toBe(false)
    expect(consoleSpy).toHaveErrored(/Listing failed/)
  })

  it('holds a Submit from the branches drawer while Save all runs', async () => {
    autoConfirm()
    let release!: () => void
    const holdSaves = new Promise<void>((resolve) => (release = resolve))
    window.history.replaceState({}, '', '/?branch=spring')
    const fetchMock = stubApi({ status: 'editing', userId: 'author-1', holdSaves })
    renderEditor('spring')
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    fireEvent.change(await titleBox(), { target: { value: 'Edited' } })

    const saveAll = await screen.findByTestId('save-all-button')
    await waitFor(() => expect(saveAll.getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(saveAll)
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
    )
    await openBranchesDrawer()
    fireEvent.click(await screen.findByTestId(`submit-branch-button-${SPRING}`))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(fetchMock.mock.calls.some(([input]) => urlOf(input).endsWith('/submit'))).toBe(false)
    await act(async () => release())
  })

  it('offers its review actions, and shows the note a request for changes leaves', async () => {
    autoConfirm()
    window.history.replaceState({}, '', '/?branch=spring')
    const fetchMock = stubApi({ status: 'approved', userId: 'reviewer-1' })
    renderEditor('spring')
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    const requestChanges = await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Request changes' })
      expect(button.getAttribute('aria-disabled')).toBeNull()
      expect(button.hasAttribute('disabled')).toBe(false)
      return button
    })

    fireEvent.click(requestChanges)

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          urlOf(input).endsWith(`${wire(SPRING)}/request-changes`),
        ),
      ).toBe(true),
    )
    await openBranchesDrawer()
    expect(await screen.findByText('Please tighten the intro.')).toBeTruthy()
  })
})

describe('the editor beside a branch outside the namespace that its short name takes', () => {
  const EXACT = '~spring'
  const both = () => [
    listed('main', 'editing'),
    listed(SPRING, 'editing'),
    listed('spring', 'editing'),
  ]
  const stubListing = (listing: () => ReturnType<typeof listed>[]) => {
    const inner = stubApi({ status: 'editing', userId: 'author-1' })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input).endsWith('/api/canopycms/branches') && (init?.method ?? 'GET') === 'GET'
        ? okJson({ branches: listing(), defaultBranch: 'main', users: [] })
        : inner(input, init),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const entriesReads = (fetchMock: ReturnType<typeof stubListing>) =>
    fetchMock.mock.calls
      .map(([input]) => new URL(urlOf(input), 'http://x').pathname)
      .filter((path) => path.endsWith('/entries'))

  it('reopens the outside branch when Back reaches an entry naming it exactly', async () => {
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(SPRING)}`)
    const fetchMock = stubListing(both)
    renderEditor(SPRING)
    expect((await titleBox()).value).toBe('hello title')
    await waitFor(() => expect(entriesReads(fetchMock)).toContain(`${wire(SPRING)}/entries`))
    fetchMock.mockClear()

    window.history.replaceState(window.history.state, '', `/?branch=${encodeURIComponent(EXACT)}`)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(entriesReads(fetchMock)).toContain(
        `/api/canopycms/${encodeURIComponent(EXACT)}/entries`,
      ),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(urlBranch()).toBe(EXACT)
    expect(entriesReads(fetchMock)).not.toContain(`${wire(SPRING)}/entries`)
  })

  it('sends a review action from the header to the open outside branch, and shows its note', async () => {
    autoConfirm()
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(EXACT)}`)
    const inner = stubApi({ status: 'editing', userId: 'reviewer-1' })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input).endsWith('/api/canopycms/branches') && (init?.method ?? 'GET') === 'GET'
        ? okJson({
            branches: [
              listed('main', 'editing'),
              listed(SPRING, 'editing'),
              listed('spring', 'approved'),
            ],
            defaultBranch: 'main',
            users: [],
          })
        : inner(input, init),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderEditor(EXACT)
    await waitFor(async () => expect((await titleBox()).value).toBe('hello title'))
    const requestChanges = await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Request changes' })
      expect(button.getAttribute('aria-disabled')).toBeNull()
      return button
    })

    fireEvent.click(requestChanges)

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          urlOf(input).endsWith(`/api/canopycms/${encodeURIComponent(EXACT)}/request-changes`),
        ),
      ).toBe(true),
    )
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          urlOf(input).endsWith('/api/canopycms/spring/request-changes') ||
          urlOf(input).endsWith(`${wire(SPRING)}/request-changes`),
      ),
    ).toBe(false)
    await openBranchesDrawer()
    expect(await screen.findByText('Please tighten the intro.')).toBeTruthy()
  })

  it('keeps asking for the open outside branch exactly once the listing drops it', async () => {
    let listing = both
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(EXACT)}`)
    const fetchMock = stubListing(() => listing())
    renderEditor(EXACT)
    expect((await titleBox()).value).toBe('hello title')
    listing = () => [listed('main', 'editing'), listed(SPRING, 'editing')]
    const refresh = async () => {
      fireEvent.click(screen.getByTestId('branch-dropdown-button'))
      fireEvent.click(await screen.findByTestId('refresh-branch-menu-item'))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
    }
    await refresh()
    fetchMock.mockClear()

    await refresh()

    expect(entriesReads(fetchMock)).toEqual([`/api/canopycms/${encodeURIComponent(EXACT)}/entries`])
  })
})

describe('the request paths the editor builds', () => {
  it.each([
    ['a namespace branch opened by its short name', 'spring', SPRING],
    ['a branch outside the namespace whose name holds a "/"', OUTSIDE, OUTSIDE],
    ['an outside branch a namespace branch shadows', '~spring', 'spring'],
    ['the base branch', 'main', 'main'],
  ])(
    'carry no encoded "/" for %s, before the listing, after it and in a save',
    async (_l, opened, full) => {
      let releaseListing = () => {}
      const holdListing = new Promise<void>((resolve) => {
        releaseListing = resolve
      })
      window.history.replaceState({}, '', `/?branch=${encodeURIComponent(opened)}`)
      const inner = stubApi({ status: 'editing', userId: 'author-1' })
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          !urlOf(input).endsWith('/api/canopycms/branches') ||
          (init?.method ?? 'GET') !== 'GET'
        ) {
          return inner(input, init)
        }
        await holdListing
        return okJson({
          branches: [
            listed('main', 'editing'),
            listed(SPRING, 'editing'),
            listed(OUTSIDE, 'editing'),
            listed('spring', 'editing'),
          ],
          defaultBranch: 'main',
          users: [],
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      const paths = () =>
        fetchMock.mock.calls.map(([input]) => new URL(urlOf(input), 'http://x').pathname)
      renderEditor(opened)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      const beforeListing = paths().filter((p) => p !== '/api/canopycms/branches')

      releaseListing()
      expect((await titleBox()).value).toBe('hello title')
      fireEvent.change(await titleBox(), { target: { value: 'Edited' } })
      const save = await screen.findByTestId('save-button')
      await waitFor(() => expect(save.getAttribute('aria-disabled')).toBeNull())
      fireEvent.click(save)
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
      )

      expect(paths()).toContain(`${wire(full)}/content/content/posts/hello`)
      expect(paths().filter((p) => /%2f/i.test(p))).toEqual([])
      expect(beforeListing.filter((p) => /%2f/i.test(p))).toEqual([])
    },
  )
})
