import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { MantineProvider } from '@mantine/core'
import { notifications } from '@mantine/notifications'

import { CANOPY_PREVIEW_NAVIGATE, CANOPY_PREVIEW_READY } from './preview-bridge'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../paths/test-utils'

const renderWithProviders = (ui: React.ReactElement) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>{ui}</ApiClientProvider>
    </SWRConfig>,
  )

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn() } }
})

const originalMatchMedia = window.matchMedia
const originalResizeObserver = window.ResizeObserver

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }
  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver as typeof ResizeObserver
  }
})

afterAll(() => {
  if (originalMatchMedia) window.matchMedia = originalMatchMedia
  if (originalResizeObserver) window.ResizeObserver = originalResizeObserver
})

beforeEach(() => {
  vi.mocked(notifications.show).mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  // The editor names the open entry in the URL, which the next test would otherwise open.
  window.history.replaceState(null, '', '/')
})

const okJson = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

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
const world: EditorEntry = {
  ...hello,
  path: unsafeAsLogicalPath('content/posts/world'),
  contentId: unsafeAsContentId('ghi789DEF456'),
  label: 'World',
  slug: 'world',
}
const helloSrc = '/preview/posts/hello?branch=main'
const worldSrc = '/preview/posts/world?branch=main'

/** The API, answering every read at once. */
const stubApi = () => {
  const branch = (name: string) => ({
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
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
              branches: [branch('main'), branch('feature')],
              defaultBranch: 'main',
            },
          }),
        )
      }
      if (url.includes('/schema') && !url.includes('/schema/')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
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
              entrySchemas: { postSchema: [{ name: 'title', type: 'string' }] },
            },
          }),
        )
      }
      if (url.includes('/entries')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
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
              entries: [hello, world].map((e) => ({
                logicalPath: e.path,
                contentId: e.contentId,
                collectionPath: e.collectionPath,
                collectionName: e.collectionName,
                slug: e.slug,
                format: e.format,
                entryType: 'post',
                physicalPath: `/content/posts.abc123XYZ789/post.${e.slug}.${e.contentId}.json`,
                exists: true,
              })),
              pagination: { hasMore: false, limit: 50 },
            },
          }),
        )
      }
      if (url.includes('/content/content/posts/') && (init?.method ?? 'GET') === 'GET') {
        const slug = url.slice(url.lastIndexOf('/') + 1)
        return Promise.resolve(
          okJson({ ok: true, status: 200, data: { title: `${slug} title`, version: 1 } }),
        )
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    }),
  )
}

const renderEditor = () =>
  renderWithProviders(
    <Editor
      entries={[hello, world]}
      initialSelectedId={hello.path}
      title="Test Editor"
      branchName="main"
      operatingMode="dev"
      themeOptions={{}}
      previewPrefix="/preview"
    />,
  )

const iframe = () => document.querySelector('iframe')
const sayReady = (extra: Record<string, unknown> = {}) => {
  const frame = iframe() as HTMLIFrameElement
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_READY, path: frame.getAttribute('src'), ...extra },
        origin: window.location.origin,
        source: frame.contentWindow,
      }),
    )
  })
}
const origin = window.location.origin
const navigate = (href: unknown, from = origin, source?: Window | null) => {
  const frame = iframe() as HTMLIFrameElement
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_NAVIGATE, href },
        origin: from,
        source: source === undefined ? frame.contentWindow : source,
      }),
    )
  })
}
const openHello = async () => {
  stubApi()
  renderEditor()
  await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
  sayReady()
}
const worldOpen = () => screen.queryByRole('button', { name: 'Copy path /posts/world' })

describe('a link clicked in the preview', () => {
  it.each([
    ['its public URL', `${origin}/posts/world`],
    ['its URL under the preview prefix, slashed', `${origin}/preview/posts/world/`],
  ])("opens the entry the link goes to, by %s, and frames that entry's page", async (_, href) => {
    await openHello()
    const open = vi.spyOn(window, 'open')

    navigate(href)

    await waitFor(() => expect(worldOpen()).toBeTruthy())
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(worldSrc))
    expect(open).not.toHaveBeenCalled()
    expect(notifications.show).not.toHaveBeenCalled()
  })

  it('moves focus into the next page once it loads, as following a link does', async () => {
    await openHello()

    navigate(`${origin}/posts/world`)

    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(worldSrc))
    expect(document.activeElement).not.toBe(iframe())
    fireEvent.load(iframe() as HTMLIFrameElement)
    expect(document.activeElement).toBe(iframe())
  })

  it.each([
    ['before the next page is framed', true],
    ['after it is framed, before it loads', false],
  ])('leaves focus where the user puts it %s', async (_, early) => {
    await openHello()
    const field = () => screen.getAllByRole('textbox')[0]

    navigate(`${origin}/posts/world`)
    if (early) act(() => field().focus())
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(worldSrc))
    if (!early) act(() => field().focus())
    fireEvent.load(iframe() as HTMLIFrameElement)

    expect(document.activeElement).toBe(field())
  })

  it('leaves focus alone when the next page comes from anywhere but a followed link', async () => {
    await openHello()
    fireEvent.click(screen.getByTestId('content-panel-toggle'))
    fireEvent.click(await screen.findByTestId('entry-nav-item-world'))

    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(worldSrc))
    fireEvent.load(iframe() as HTMLIFrameElement)
    expect(document.activeElement).not.toBe(iframe())
  })

  it('opens a page no entry has in a new tab, cut off from the editor, and says so', async () => {
    await openHello()
    const tab = { opener: window } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(tab)

    navigate(`${origin}/posts?page=2#top`)

    expect(open).toHaveBeenCalledWith(`${origin}/posts?page=2#top`, '_blank')
    expect(tab.opener).toBeNull()
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({
        color: 'blue',
        message: '/posts?page=2 has no entry here, so it opened in a new tab.',
      }),
    )
    expect(iframe()?.getAttribute('src')).toBe(helloSrc)
  })

  it('says so only once the editor is in view again, since the new tab takes the window', async () => {
    await openHello()
    vi.spyOn(window, 'open').mockReturnValue({ opener: null } as unknown as Window)
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)

    navigate(`${origin}/posts`)
    visibility = 'hidden'
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(notifications.show).not.toHaveBeenCalled()

    visibility = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(notifications.show).toHaveBeenCalledTimes(1)
  })

  it('says so until dismissed, with a link to the page, when the browser blocks the new tab', async () => {
    await openHello()
    vi.spyOn(window, 'open').mockReturnValue(null)

    navigate(`${origin}/posts`)

    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', autoClose: false }),
    )
    const [[toast]] = vi.mocked(notifications.show).mock.calls
    render(<MantineProvider>{toast.message}</MantineProvider>)
    expect(
      screen.getByText('/posts has no entry here, and your browser blocked the new tab.', {
        exact: false,
      }),
    ).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Open /posts' })
    expect(link.getAttribute('href')).toBe(`${origin}/posts`)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it.each([
    ['from another origin', `${origin}/posts/world`, 'https://evil.example', undefined],
    ['from another window', `${origin}/posts/world`, origin, window],
    ['with an href on another origin', 'https://evil.example/posts/world', origin, undefined],
    ['with an href that is not a string', 42, origin, undefined],
  ])('ignores a message %s', async (_, href, from, source) => {
    await openHello()
    const open = vi.spyOn(window, 'open')

    navigate(href, from, source)
    // Longer than the toast's wait for the editor to be in view.
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(worldOpen()).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(notifications.show).not.toHaveBeenCalled()
  })
})
