import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { notifications } from '@mantine/notifications'

import {
  CANOPY_PREVIEW_NAVIGATE,
  CANOPY_PREVIEW_READY,
  CANOPY_PREVIEW_REVEAL,
} from './preview-bridge'
import { PREVIEW_FOLLOW_DELAY_MS } from './hooks/usePreviewFollow'
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

const stubApi = ({
  helloEditable = true,
  worldContent,
}: { helloEditable?: boolean; worldContent?: Promise<void> } = {}) => {
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
                ...(e === hello && !helloEditable ? { canEdit: false } : {}),
              })),
              pagination: { hasMore: false, limit: 50 },
            },
          }),
        )
      }
      if (url.includes('/content/content/posts/') && (init?.method ?? 'GET') === 'GET') {
        const slug = url.slice(url.lastIndexOf('/') + 1)
        const answer = () =>
          okJson({ ok: true, status: 200, data: { title: `${slug} title`, version: 1 } })
        if (slug === 'world' && worldContent) return worldContent.then(answer)
        return Promise.resolve(answer())
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
const openHello = async () => {
  stubApi()
  renderEditor()
  await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
  sayReady()
}

const FOLLOW_LABEL = "Scroll the preview to the field you're on"

const revealsSent = (post: { mock: { calls: unknown[][] } }) =>
  post.mock.calls.filter(([msg]) => (msg as { type?: string }).type === CANOPY_PREVIEW_REVEAL)

const watchPreview = () =>
  vi
    .spyOn((iframe() as HTMLIFrameElement).contentWindow as Window, 'postMessage')
    .mockImplementation(() => {})

const titleInput = async () => {
  await waitFor(() =>
    expect(document.querySelector('[data-canopy-field="title"] input')).not.toBeNull(),
  )
  return document.querySelector('[data-canopy-field="title"] input') as HTMLInputElement
}

const settle = () => new Promise((resolve) => setTimeout(resolve, PREVIEW_FOLLOW_DELAY_MS + 150))

describe('the preview follows the form', () => {
  it('asks the preview, once, for the field the form rests on', async () => {
    await openHello()
    const post = watchPreview()
    const input = await titleInput()
    act(() => input.focus())
    await waitFor(() => expect(revealsSent(post)).toHaveLength(1))
    await settle()
    expect(revealsSent(post)).toEqual([[{ type: CANOPY_PREVIEW_REVEAL, path: 'title' }, origin]])
  })

  it('is on by default, and its toolbar toggle turns it off for this browser', async () => {
    await openHello()
    const toggle = await screen.findByRole('button', { name: FOLLOW_LABEL })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    const stored = Object.keys(window.localStorage)
      .filter((key) => key.startsWith('canopycms:editor-layout:'))
      .map((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'))
    expect(stored).toEqual([expect.objectContaining({ previewFollowsForm: false })])

    const post = watchPreview()
    const input = await titleInput()
    act(() => input.focus())
    await settle()
    expect(revealsSent(post)).toEqual([])
  })

  it('offers no toggle beside an entry with no form to follow', async () => {
    stubApi({ helloEditable: false })
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
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
    await screen.findByRole('button', { name: 'Highlight fields in the preview' })
    await screen.findByText(/permission/i)
    expect(screen.queryByRole('button', { name: FOLLOW_LABEL })).toBeNull()
  })

  it('keeps its toggle in the toolbar while the next entry loads', async () => {
    let release = () => {}
    stubApi({ worldContent: new Promise<void>((resolve) => (release = resolve)) })
    renderEditor()
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(helloSrc))
    sayReady()
    await screen.findByRole('button', { name: FOLLOW_LABEL })
    const frame = iframe() as HTMLIFrameElement
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: CANOPY_PREVIEW_NAVIGATE, href: `${origin}/posts/world` },
          origin,
          source: frame.contentWindow,
        }),
      )
    })
    await screen.findByRole('progressbar', { name: 'Loading the entry' })
    expect(screen.getByRole('button', { name: FOLLOW_LABEL })).toBeTruthy()
    await act(async () => release())
    await waitFor(() =>
      expect(screen.queryByRole('progressbar', { name: 'Loading the entry' })).toBeNull(),
    )
    expect(screen.getByRole('button', { name: FOLLOW_LABEL })).toBeTruthy()
  })
})
