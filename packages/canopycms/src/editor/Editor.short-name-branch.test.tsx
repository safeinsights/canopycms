/**
 * The editor opened on a namespace branch by its short name (`?branch=spring`), the form pull
 * request links carry: it opens that branch unlocked under its listed name, so its drafts,
 * comments and Save all guard are the ones the full name reaches, and actions on it reach it.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { modals } from '@mantine/modals'

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
const SPRING_SEGMENT = encodeURIComponent(SPRING)

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
  shortName: name === SPRING ? 'spring' : name,
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
    if (url.endsWith('/api/canopycms/branches')) {
      return okJson({
        branches: [listed('main', 'editing'), listed(SPRING, options.status)],
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
  it('takes the listed name into the URL, replacing the entry it opened on', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    const pushState = vi.spyOn(window.history, 'pushState')
    stubApi({ status: 'editing', userId: 'author-1' })
    renderEditor('spring')

    await waitFor(() => expect(urlBranch()).toBe(SPRING))
    expect((await titleBox()).value).toBe('hello title')
    expect(pushState).not.toHaveBeenCalled()
  })

  it('keeps a draft made there for the branch reopened by its full name', async () => {
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

    await waitFor(() => expect(urlBranch()).toBe(SPRING))
    await waitFor(async () => expect((await titleBox()).value).toBe('Drafted on spring'))
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
          urlOf(input).endsWith(`/${SPRING_SEGMENT}/request-changes`),
        ),
      ).toBe(true),
    )
    await openBranchesDrawer()
    expect(await screen.findByText('Please tighten the intro.')).toBeTruthy()
  })
})
