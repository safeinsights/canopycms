import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { editorLayoutStorageKey } from './hooks/useEditorLayout'
import { CANOPY_PREVIEW_MESSAGE, CANOPY_PREVIEW_READY } from './preview-bridge'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../paths/test-utils'
import { mockConsole } from '../test-utils/console-spy'

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
const readPath = (entry: EditorEntry, branch = 'main') =>
  `/api/canopycms/${branch}/content/${entry.path}`
const helloSrc = '/preview/posts/hello?branch=main'
const worldSrc = '/preview/posts/world?branch=main'

/** The API, with each entry's reads held until the test releases it, and answered at once after. */
const stubApi = () => {
  const held: Record<string, ((response: Response) => void)[]> = {}
  const settled: Record<string, () => Response> = {}
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
        if (url in settled) return Promise.resolve(settled[url]())
        return new Promise<Response>((resolve) => {
          ;(held[url] ??= []).push(resolve)
        })
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    }),
  )
  const settle = async (url: string, response: () => Response) => {
    await waitFor(() => expect(held[url]).toBeDefined())
    settled[url] = response
    for (const resolve of held[url]) resolve(response())
  }
  return {
    release: (entry: EditorEntry, title: string, onBranch = 'main') =>
      settle(readPath(entry, onBranch), () =>
        okJson({ ok: true, status: 200, data: { title, version: 1 } }),
      ),
    fail: (entry: EditorEntry) =>
      settle(readPath(entry), () => okJson({ ok: false, status: 500 }, 500)),
  }
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
const draftsTo = (frame: HTMLIFrameElement, spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .map(([message]) => message as { type?: string; path?: string; data?: unknown })
    .filter((message) => message.type === CANOPY_PREVIEW_MESSAGE)
    .map((message) => ({ frame: frame.getAttribute('src'), ...message }))

describe('the preview across an entry switch', () => {
  it("keeps the toolbar and the last page until the next entry's data arrives", async () => {
    const api = stubApi()
    renderEditor()
    await api.release(hello, 'Hello title')
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
    const first = iframe() as HTMLIFrameElement
    const firstPost = vi.spyOn(first.contentWindow as Window, 'postMessage')
    sayReady()
    const toolbar = screen.getByTestId('preview-toolbar')
    // Sampled on every DOM change, so a toolbar unmounted and remounted between two checks is
    // still seen.
    let toolbarGone = false
    const observer = new MutationObserver(() => {
      if (!toolbar.isConnected) toolbarGone = true
    })
    observer.observe(document.body, { childList: true, subtree: true })

    fireEvent.click(screen.getByTestId('content-panel-toggle'))
    fireEvent.click(await screen.findByTestId('entry-nav-item-world'))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy path /posts/world' })).toBeTruthy(),
    )
    expect(iframe()).toBe(first)
    expect(first.hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('progressbar', { name: 'Loading the entry' })).toBeTruthy()

    await api.release(world, 'World title')
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(worldSrc))
    const next = iframe() as HTMLIFrameElement
    const nextPost = vi.spyOn(next.contentWindow as Window, 'postMessage')
    sayReady()
    observer.disconnect()

    expect(toolbarGone).toBe(false)
    expect(screen.getByTestId('preview-toolbar')).toBe(toolbar)
    expect(draftsTo(next, nextPost)).toEqual([
      expect.objectContaining({
        frame: worldSrc,
        path: worldSrc,
        data: expect.objectContaining({ title: 'World title' }),
      }),
    ])
    expect(draftsTo(first, firstPost).every((message) => message.path === helloSrc)).toBe(true)
    expect(JSON.stringify(firstPost.mock.calls)).not.toContain('World title')
  })
})

describe('the preview when the next entry does not arrive as asked', () => {
  const switchToWorld = async () => {
    fireEvent.click(screen.getByTestId('content-panel-toggle'))
    fireEvent.click(await screen.findByTestId('entry-nav-item-world'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy path /posts/world' })).toBeTruthy(),
    )
  }

  it("gives way to the form's load failure when the next entry can't be read", async () => {
    const consoleSpy = mockConsole()
    const api = stubApi()
    renderEditor()
    await api.release(hello, 'Hello title')
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
    await switchToWorld()

    await api.fail(world)
    await waitFor(() => expect(screen.getByTestId('entry-load-failed')).toBeTruthy())
    expect(iframe()).toBeNull()
    expect(screen.queryByTestId('preview-toolbar')).toBeNull()
    consoleSpy.restore()
  })

  // A branch switch reloads the entry list, so the pane starts over rather than holding a page
  // read from the other branch.
  it('frames the open entry on the new branch after a branch switch mid-load', async () => {
    const api = stubApi()
    renderEditor()
    await api.release(hello, 'Hello title')
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
    const first = iframe() as HTMLIFrameElement
    const firstPost = vi.spyOn(first.contentWindow as Window, 'postMessage')
    await switchToWorld()

    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))
    fireEvent.click(await screen.findByTestId('switch-to-branch-button-feature'))
    await waitFor(() => expect(screen.getByTestId('preview-loading-skeleton')).toBeTruthy())
    expect(first.isConnected).toBe(false)
    expect(screen.getByTestId('preview-toolbar')).toBeTruthy()

    // The editor reopens its first entry with a page on the new branch.
    await api.release(hello, 'Feature title', 'feature')
    const featureSrc = '/preview/posts/hello?branch=feature'
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(featureSrc))
    const next = iframe() as HTMLIFrameElement
    const nextPost = vi.spyOn(next.contentWindow as Window, 'postMessage')
    sayReady()
    expect(draftsTo(next, nextPost)).toEqual([
      expect.objectContaining({
        path: featureSrc,
        data: expect.objectContaining({ title: 'Feature title' }),
      }),
    ])
    expect(JSON.stringify(firstPost.mock.calls)).not.toContain('Feature title')
  })
})

describe('the site header and footer toggle', () => {
  it('frames the page with chrome=1 while on, and remembers the choice', async () => {
    const key = editorLayoutStorageKey()
    window.localStorage.setItem(key, JSON.stringify({ siteChrome: true }))
    const api = stubApi()
    renderEditor()
    await api.release(hello, 'Hello title')
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(`${helloSrc}&chrome=1`))
    // On, so it shows before the page connects, and can always be turned off.
    expect(screen.getByRole('button', { name: 'Show site header and footer' })).toBeTruthy()

    sayReady({ siteChrome: true })
    const toggle = screen.getByRole('button', { name: 'Show site header and footer' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(toggle)
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
    expect(JSON.parse(window.localStorage.getItem(key) ?? '{}').siteChrome).toBe(false)
    // The toggle stays while the page without them connects.
    expect(
      screen
        .getByRole('button', { name: 'Show site header and footer' })
        .getAttribute('aria-pressed'),
    ).toBe('false')
  })
})
