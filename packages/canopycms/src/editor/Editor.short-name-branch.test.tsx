/**
 * The editor opened on a namespace branch by its short name (`?branch=spring`), the form pull
 * request links carry: it opens that branch unlocked under its listed name, so its drafts,
 * comments and Save all guard are the ones the full name reaches, and actions on it reach it.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { MantineProvider } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { RESERVED_GROUPS } from '../authorization/helpers'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../paths/test-utils'

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

const stubApi = (options: { status: string; userId: string; holdSaves?: Promise<void> }) => {
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

  it('rewrites a link carrying the full name to the short name, replacing the entry', async () => {
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(SPRING)}`)
    const pushState = vi.spyOn(window.history, 'pushState')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor(SPRING)

    await waitFor(() => expect(urlBranch()).toBe('spring'))
    expect((await titleBox()).value).toBe('hello title')
    expect(pushState).not.toHaveBeenCalled()
  })

  it('sends its requests under the short name, with no %2F in a path', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    const fetchMock = stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')
    expect((await titleBox()).value).toBe('hello title')

    const paths = fetchMock.mock.calls.map(([input]) => new URL(urlOf(input), 'http://x').pathname)
    expect(paths).toContain('/api/canopycms/spring/entries')
    expect(paths).toContain('/api/canopycms/spring/schema')
    expect(paths.filter((path) => path.includes('%2F'))).toEqual([])
  })

  it('sends a branch outside the namespace under its full name', async () => {
    window.history.replaceState({}, '', `/?branch=${encodeURIComponent(OUTSIDE)}`)
    const fetchMock = stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor(OUTSIDE)
    expect((await titleBox()).value).toBe('hello title')

    const paths = fetchMock.mock.calls.map(([input]) => new URL(urlOf(input), 'http://x').pathname)
    expect(paths).toContain('/api/canopycms/feature%2Fx/entries')
    expect(paths).not.toContain('/api/canopycms/x/entries')
    expect(urlBranch()).toBe(OUTSIDE)
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
    await openBranchesDrawer()
    fireEvent.click(await screen.findByTestId('create-branch-button'))
    fireEvent.change(await screen.findByTestId('branch-name-input'), {
      target: { value: 'summer' },
    })

    fireEvent.click(screen.getByTestId('create-branch-submit'))

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({
        message: 'Branch "summer" created',
        color: 'green',
      }),
    )
    await waitFor(() => expect(urlBranch()).toBe('summer'))
    expect(
      fetchMock.mock.calls.some(([input]) => urlOf(input).endsWith('/api/canopycms/summer/schema')),
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

    window.history.replaceState({}, '', '/?branch=gone')
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("so you're still on “spring”."),
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
          urlOf(input).endsWith('/api/canopycms/spring/request-changes'),
        ),
      ).toBe(true),
    )
    await openBranchesDrawer()
    expect(await screen.findByText('Please tighten the intro.')).toBeTruthy()
  })
})
