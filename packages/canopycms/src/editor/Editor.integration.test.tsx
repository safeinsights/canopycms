import React from 'react'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SWRConfig } from 'swr'
import type { EditorEntry, EditorCollection } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'
import { RESERVED_GROUPS } from '../authorization'
import { mockConsole } from '../test-utils/console-spy'

// Editor.tsx no longer wraps its own SWR cache (only CanopyEditor.tsx does,
// via SWRProvider) -- these tests render <Editor> directly, so they need
// their own SWRConfig with an isolated `provider: () => new Map()` cache.
// Without it every `it()` in this file would share SWR's true global cache,
// and since they all use branch "main" the same cache keys (e.g.
// "canopy:entries:main") would collide across tests, serving stale data
// from an earlier test instead of hitting each test's own fetch mock.
const renderWithProviders = (ui: React.ReactElement) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>{ui}</ApiClientProvider>
    </SWRConfig>,
  )

// Mock @mantine/modals
vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: {
    openConfirmModal: vi.fn(),
  },
}))

// Mock @mantine/notifications' imperative `notifications` API so the "no
// stale notification" assertion below can check the mock directly, rather
// than depending on Mantine's real notifications portal/animation timing
// rendering into the jsdom tree. Keep the real `Notifications` component
// (via importOriginal) -- CanopyCMSProvider (theme.tsx) renders it
// unconditionally and would crash without it.
vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return {
    ...actual,
    notifications: {
      show: vi.fn(),
      hide: vi.fn(),
    },
  }
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
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia
  }
  if (originalResizeObserver) {
    window.ResizeObserver = originalResizeObserver
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const okJson = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('Editor integration', () => {
  it('loads an entry and persists changes via the content API', async () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/posts/hello'),
      contentId: unsafeAsContentId('def456ABC123'), // 12-char content ID (must match API response)
      label: 'Hello',
      status: 'entry',
      schema: [{ name: 'title', type: 'string' }],
      apiPath: '/api/canopycms/main/content/content/posts/hello',
      collectionPath: unsafeAsLogicalPath('content/posts'),
      collectionName: 'posts',
      slug: 'hello',
      format: 'json',
      type: 'entry',
    }

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        // A real, unlocked branch -- NOT the 404 "no branch endpoint"
        // shorthand this test used before Change 1. `currentBranch` failing
        // to resolve (which a 404 always produces, since branches stays [])
        // now fails CLOSED (locks Save), and this test's point is the plain
        // load/save flow, not branch-lock behavior, so it needs a real,
        // unlocked branch to resolve against.
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
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
                  schema: entry.schema,
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
            },
          }),
        )
      }
      if (url === entry.apiPath && (!init || !init.method || init.method === 'GET')) {
        return Promise.resolve(okJson({ ok: true, status: 200, data: { title: 'Loaded title' } }))
      }
      if (url.startsWith(entry.apiPath) && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string)
        return Promise.resolve(okJson({ ok: true, status: 200, data: body.data }))
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    })

    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(
      <Editor
        entries={[entry]}
        title="Test Editor"
        branchName="main"
        operatingMode="dev"
        themeOptions={{}}
      />,
    )

    // Wait for the entry data to be loaded and form to render with loaded value
    let input: HTMLInputElement
    await waitFor(() => {
      const el = screen.queryByRole('textbox', {
        name: /title/i,
      }) as HTMLInputElement | null
      expect(el).not.toBeNull()
      expect(el?.value).toBe('Loaded title')
      input = el!
    })

    // Verify save button is disabled when there are no unsaved changes
    let saveButton = await screen.findByRole('button', { name: /save file/i })
    expect(saveButton.hasAttribute('disabled')).toBe(true)

    // Make a change to the form
    fireEvent.change(input!, { target: { value: 'Modified title' } })

    // Verify save button becomes enabled after making a change
    await waitFor(() => {
      saveButton = screen.getByRole('button', { name: /save file/i })
      expect(saveButton.hasAttribute('disabled')).toBe(false)
    })

    fireEvent.click(saveButton)

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            (url as string).startsWith(entry.apiPath) &&
            (init as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toBe(true),
    )

    const saveCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        (url as string).startsWith(entry.apiPath) &&
        (init as RequestInit | undefined)?.method === 'PUT',
    )
    expect(saveCall).toBeTruthy()
    const body = JSON.parse((saveCall?.[1] as RequestInit).body as string)
    // With path-based routing, collection and slug are in the URL, not the body
    expect(body).toMatchObject({
      format: 'json',
      data: { title: 'Modified title' },
    })
  })

  it('abandoning an in-flight entry load does not surface a stale failure notification, and the newly selected entry still loads correctly', async () => {
    // Regression test for the entry-load race: navigate A -> B while A is
    // still in flight, then let A settle (with a failure) AFTER B has
    // already started loading. A's stale settle must not show a "Failed to
    // load entry" notification to a user who has already moved on to B, and
    // B's own load must still complete normally afterward.
    //
    // A's rejected loadEntry() still logs via console.error (the staleness
    // guard only suppresses the user-facing notification, not the log) --
    // wrap with mockConsole() so that expected error doesn't fail CI's
    // no-stderr-output check.
    const consoleSpy = mockConsole()
    const entryA: EditorEntry = {
      path: unsafeAsLogicalPath('content/posts/hello'),
      contentId: unsafeAsContentId('def456ABC123'),
      label: 'Hello',
      status: 'entry',
      schema: [{ name: 'title', type: 'string' }],
      apiPath: '/api/canopycms/main/content/content/posts/hello',
      collectionPath: unsafeAsLogicalPath('content/posts'),
      collectionName: 'posts',
      slug: 'hello',
      format: 'json',
      type: 'entry',
    }
    const entryB: EditorEntry = {
      ...entryA,
      path: unsafeAsLogicalPath('content/posts/world'),
      contentId: unsafeAsContentId('ghi789DEF456'),
      label: 'World',
      apiPath: '/api/canopycms/main/content/content/posts/world',
      slug: 'world',
    }

    // Hand-controlled resolvers for each entry's GET, keyed by URL, so the
    // test can settle them in a specific (out-of-order-relative-to-selection) sequence.
    const resolvers: Record<string, (v: Response) => void> = {}
    const pending = (url: string) =>
      new Promise<Response>((resolve) => {
        resolvers[url] = resolve
      })

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        // A real, unlocked branch -- NOT the 404 "no branch endpoint"
        // shorthand this test used before Change 1. `currentBranch` failing
        // to resolve (which a 404 always produces, since branches stays [])
        // now fails CLOSED (locks Save), and this test's point is the plain
        // load/save flow, not branch-lock behavior, so it needs a real,
        // unlocked branch to resolve against.
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
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
                  schema: entryA.schema,
                  order: [],
                },
              ],
              entries: [entryA, entryB].map((e) => ({
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
      if (
        (url === entryA.apiPath || url === entryB.apiPath) &&
        (!init || !init.method || init.method === 'GET')
      ) {
        return pending(url)
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    })

    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(
      <Editor
        entries={[entryA, entryB]}
        title="Test Editor"
        branchName="main"
        operatingMode="dev"
        initialSelectedId={entryA.path}
        themeOptions={{}}
      />,
    )

    // Entry A's load starts (parked, not yet resolved).
    await waitFor(() => expect(resolvers[entryA.apiPath]).toBeDefined())

    // Navigate to entry B via the File menu -> All Files -> entry click,
    // while A is still in flight.
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    await waitFor(() => expect(screen.getByTestId('all-files-menu-item')).toBeDefined())
    fireEvent.click(screen.getByTestId('all-files-menu-item'))
    await waitFor(() => expect(screen.getByTestId('entry-nav-item-world')).toBeDefined())
    fireEvent.click(screen.getByTestId('entry-nav-item-world'))

    // Entry B's load starts too (also parked) -- both now in flight.
    await waitFor(() => expect(resolvers[entryB.apiPath]).toBeDefined())

    // Settle A -- the ABANDONED entry -- with a failure, after B has already
    // started loading.
    resolvers[entryA.apiPath](okJson({ ok: false, status: 500 }, 500))

    // Give the rejected loadEntry() promise a tick to propagate to the
    // effect's .catch() handler.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => u === entryB.apiPath)).toBe(true)
    })

    const { notifications } = await import('@mantine/notifications')
    // A's failure must not have shown the generic failure toast -- the user
    // already moved on to B.
    expect(notifications.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to load entry' }),
    )

    // Now settle B successfully.
    resolvers[entryB.apiPath](okJson({ ok: true, status: 200, data: { title: 'World title' } }))

    // B's field renders with its own loaded value -- the load pipeline
    // recovered correctly and wasn't left in a broken state by A's stale
    // settle.
    await waitFor(() => {
      const el = screen.queryByRole('textbox', { name: /title/i }) as HTMLInputElement | null
      expect(el).not.toBeNull()
      expect(el?.value).toBe('World title')
    })

    // Still no stale notification for A, even after B finished loading.
    expect(notifications.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to load entry' }),
    )

    consoleSpy.restore()
  })

  it('still loads the entry from the server when a localStorage draft already exists for it, and the draft overlays the loaded value', async () => {
    // Regression test for: entry load used to be skipped whenever
    // `drafts[contentId]` was already set (e.g. restored from localStorage on
    // a fresh page load). That left `loadedValues[contentId]` permanently
    // undefined, which made dirty-tracking meaningless (a draft with no
    // loaded value is conservatively treated as dirty everywhere) and meant
    // the entry's real server content was never fetched this session.
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/posts/hello'),
      contentId: unsafeAsContentId('def456ABC123'),
      label: 'Hello',
      status: 'entry',
      schema: [{ name: 'title', type: 'string' }],
      apiPath: '/api/canopycms/main/content/content/posts/hello',
      collectionPath: unsafeAsLogicalPath('content/posts'),
      collectionName: 'posts',
      slug: 'hello',
      format: 'json',
      type: 'entry',
    }

    // Seed a pre-existing draft in localStorage, as if a previous session
    // left unsaved edits behind.
    window.localStorage.setItem(
      'canopycms:drafts:main',
      JSON.stringify({ def456ABC123: { title: 'Draft title from localStorage' } }),
    )

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        // A real, unlocked branch -- NOT the 404 "no branch endpoint"
        // shorthand this test used before Change 1. `currentBranch` failing
        // to resolve (which a 404 always produces, since branches stays [])
        // now fails CLOSED (locks Save), and this test's point is the plain
        // load/save flow, not branch-lock behavior, so it needs a real,
        // unlocked branch to resolve against.
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
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
                  schema: entry.schema,
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
            },
          }),
        )
      }
      if (url === entry.apiPath && (!init || !init.method || init.method === 'GET')) {
        return Promise.resolve(okJson({ ok: true, status: 200, data: { title: 'Loaded title' } }))
      }
      if (url.startsWith(entry.apiPath) && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string)
        return Promise.resolve(okJson({ ok: true, status: 200, data: body.data }))
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    })

    vi.stubGlobal('fetch', fetchMock)

    try {
      renderWithProviders(
        <Editor
          entries={[entry]}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />,
      )

      // The GET for the entry must still fire despite the pre-existing draft.
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              url === entry.apiPath &&
              (!init || !(init as RequestInit).method || (init as RequestInit).method === 'GET'),
          ),
        ).toBe(true)
      })

      // The form shows the draft's value, not the loaded value: the draft
      // survives as an overlay on top of the now-populated loaded value.
      await waitFor(() => {
        const el = screen.queryByRole('textbox', { name: /title/i }) as HTMLInputElement | null
        expect(el).not.toBeNull()
        expect(el?.value).toBe('Draft title from localStorage')
      })

      // Save is enabled: the draft genuinely differs from the (now loaded)
      // server value, so dirty-tracking is truthful rather than a permanent
      // false positive.
      await waitFor(() => {
        const saveButton = screen.getByRole('button', { name: /save file/i })
        expect(saveButton.hasAttribute('disabled')).toBe(false)
      })
    } finally {
      window.localStorage.removeItem('canopycms:drafts:main')
    }
  })

  it('shows the read-only banner, keeps Save disabled despite unsaved changes, and hides Submit on the protected base branch', async () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/posts/hello'),
      contentId: unsafeAsContentId('def456ABC123'),
      label: 'Hello',
      status: 'entry',
      schema: [{ name: 'title', type: 'string' }],
      apiPath: '/api/canopycms/main/content/content/posts/hello',
      collectionPath: unsafeAsLogicalPath('content/posts'),
      collectionName: 'posts',
      slug: 'hello',
      format: 'json',
      type: 'entry',
    }

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
              branches: [
                {
                  name: 'main',
                  status: 'editing',
                  access: {},
                  createdBy: 'canopycms-system',
                  createdAt: '2024-01-01',
                  updatedAt: '2024-01-01',
                  // Server-computed protected-base-branch flags (prod).
                  isProtected: true,
                  readOnly: true,
                  writeBlocked: true,
                },
              ],
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
                // buildEditorCollections (editor-config.ts) only turns 'collection'
                // items into navigable EntryNavigator nodes -- the 'entry-type' item
                // below alone produces no tree node to open/inspect.
                {
                  type: 'collection',
                  logicalPath: 'content/posts',
                  name: 'posts',
                  label: 'Posts',
                  entries: [{ name: 'post', format: 'json', schema: entry.schema }],
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
                  schema: entry.schema,
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
            },
          }),
        )
      }
      if (url === entry.apiPath && (!init || !init.method || init.method === 'GET')) {
        return Promise.resolve(okJson({ ok: true, status: 200, data: { title: 'Loaded title' } }))
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    })

    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(
      <Editor
        entries={[entry]}
        title="Test Editor"
        branchName="main"
        operatingMode="prod"
        themeOptions={{}}
      />,
    )

    // Read-only banner appears with the create-branch CTA.
    await waitFor(() => {
      expect(screen.getByTestId('protected-branch-banner')).toBeDefined()
    })
    expect(screen.getByText(/protected base branch "main"/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /create a branch/i })).toBeDefined()

    // Submit is hidden entirely (not just disabled) on the protected branch.
    expect(screen.queryByTestId('submit-button')).toBeNull()

    // Wait for the entry to load, then dirty it -- Save must stay disabled
    // despite unsaved changes, proving branchReadOnly overrides the normal
    // hasUnsavedChanges enable logic.
    let input: HTMLInputElement
    await waitFor(() => {
      const el = screen.queryByRole('textbox', { name: /title/i }) as HTMLInputElement | null
      expect(el).not.toBeNull()
      input = el!
    })
    fireEvent.change(input!, { target: { value: 'Modified title' } })

    await waitFor(() => {
      const saveButton = screen.getByTestId('save-button')
      expect(saveButton.hasAttribute('disabled')).toBe(true)
    })

    // Open the entry navigator (File dropdown -> All Files) and confirm the
    // read-only branch hides every mutation affordance: the per-collection
    // context menu (EntryNavigator's readOnly gating) and the drawer header's
    // "Content actions" button (Add Entry/Add Collection for the root), which
    // reads navCollections[0].onAdd directly and would otherwise bypass
    // EntryNavigator's gating entirely.
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    await waitFor(() => {
      expect(screen.getByTestId('all-files-menu-item')).toBeDefined()
    })
    fireEvent.click(screen.getByTestId('all-files-menu-item'))

    await waitFor(() => {
      expect(screen.getByTestId('entry-nav-item-posts')).toBeDefined()
    })
    expect(screen.queryByTestId('collection-menu-posts')).toBeNull()
    expect(screen.queryByRole('button', { name: /content actions/i })).toBeNull()
  })

  it('grants an admin who is neither creator nor in ACL an enabled Withdraw button on a protected base branch stuck in "submitted"', async () => {
    // Recovery-flow regression: the base branch's system-branch grant is
    // disabled once protected (see EditorHeader's canPerformAction), so an
    // admin must fall back to the privileged-user grant instead -- otherwise
    // a base branch wrongly stuck in 'submitted' has no self-serve recovery.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
              branches: [
                {
                  name: 'main',
                  status: 'submitted',
                  access: {},
                  createdBy: 'canopycms-system',
                  createdAt: '2024-01-01',
                  updatedAt: '2024-01-01',
                  isProtected: true,
                  readOnly: true,
                  writeBlocked: true,
                },
              ],
              defaultBranch: 'main',
            },
          }),
        )
      }
      if (url.endsWith('/whoami')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: { userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
          }),
        )
      }
      if (url.includes('/schema') && !url.includes('/schema/')) {
        return Promise.resolve(
          okJson({ ok: true, status: 200, data: { schema: {}, flatSchema: [], entrySchemas: {} } }),
        )
      }
      if (url.includes('/entries')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: { collections: [], entries: [], pagination: { hasMore: false, limit: 50 } },
          }),
        )
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    })

    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(
      <Editor
        entries={[]}
        title="Test Editor"
        branchName="main"
        operatingMode="prod"
        themeOptions={{}}
      />,
    )

    await waitFor(() => {
      const withdrawButton = screen.getByTestId('withdraw-button')
      expect(withdrawButton.hasAttribute('disabled')).toBe(false)
    })
  })

  it('fails closed -- disables Save and hides Submit -- when the resolved branch is missing writeBlocked/isProtected on the wire (version skew)', async () => {
    // Distinct from the read-only-banner test above: THIS branch resolves
    // (currentBranch is defined, status is 'editing', nothing is actually
    // protected) but the server simply didn't emit the newer flags at all --
    // the version-skew scenario branchContentLocked's `?? true` default
    // exists for. Before Change 1, `currentBranch?.writeBlocked ?? false`
    // would render this branch UNLOCKED and let Save send a request the
    // server has no basis to accept.
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/posts/hello'),
      contentId: unsafeAsContentId('def456ABC123'),
      label: 'Hello',
      status: 'entry',
      schema: [{ name: 'title', type: 'string' }],
      apiPath: '/api/canopycms/main/content/content/posts/hello',
      collectionPath: unsafeAsLogicalPath('content/posts'),
      collectionName: 'posts',
      slug: 'hello',
      format: 'json',
      type: 'entry',
    }

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
              branches: [
                {
                  // writeBlocked/isProtected/readOnly/submitBlocked all
                  // deliberately ABSENT -- an older server that predates
                  // these wire fields.
                  name: 'main',
                  status: 'editing',
                  access: {},
                  createdBy: 'user-1',
                  createdAt: '2024-01-01',
                  updatedAt: '2024-01-01',
                },
              ],
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
              collections: [],
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
            },
          }),
        )
      }
      if (url === entry.apiPath && (!init || !init.method || init.method === 'GET')) {
        return Promise.resolve(okJson({ ok: true, status: 200, data: { title: 'Loaded title' } }))
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    })

    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(
      <Editor
        entries={[entry]}
        title="Test Editor"
        branchName="main"
        operatingMode="dev"
        themeOptions={{}}
      />,
    )

    let input: HTMLInputElement
    await waitFor(() => {
      const el = screen.queryByRole('textbox', { name: /title/i }) as HTMLInputElement | null
      expect(el).not.toBeNull()
      input = el!
    })
    fireEvent.change(input!, { target: { value: 'Modified title' } })

    // Save stays disabled despite the edit -- writeBlocked's absence must
    // fail closed, not read as "server says go ahead".
    await waitFor(() => {
      const saveButton = screen.getByTestId('save-button')
      expect(saveButton.hasAttribute('disabled')).toBe(true)
    })

    // isProtected's absence must also fail closed -- Submit hides entirely,
    // the same treatment a genuinely protected branch gets, rather than
    // rendering enabled (or disabled-with-tooltip) as an ordinary editing
    // branch would.
    expect(screen.queryByTestId('submit-button')).toBeNull()
  })

  describe('reorder mid-branch-switch (Editor.tsx handleReorderEntry)', () => {
    // Two sub-collections of a "content/posts" parent, referenced by the
    // BUILD-TIME `collections` prop -- the data `activeCollections` falls
    // back to whenever the fetched view (`collectionsFromApi`) is empty.
    const subA: EditorCollection = {
      path: unsafeAsLogicalPath('content/posts/sub-a'),
      contentId: unsafeAsContentId('subA00000001'),
      name: 'sub-a',
      label: 'Sub A',
      format: 'json',
      type: 'collection',
    }
    const subB: EditorCollection = {
      path: unsafeAsLogicalPath('content/posts/sub-b'),
      contentId: unsafeAsContentId('subB00000002'),
      name: 'sub-b',
      label: 'Sub B',
      format: 'json',
      type: 'collection',
    }
    const buildTimeCollections: EditorCollection[] = [
      {
        path: unsafeAsLogicalPath('content/posts'),
        name: 'posts',
        label: 'Posts',
        format: 'json',
        type: 'collection',
        order: ['subA00000001', 'subB00000002'],
        children: [subA, subB],
      },
    ]

    // A branch list that leaves the branch unlocked (editing, unprotected),
    // so the reorder UI is reachable at all -- otherwise Change 1's
    // fail-closed default would hide it and these tests would prove nothing.
    const unlockedBranchesResponse = {
      ok: true,
      status: 200,
      data: {
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
      },
    }

    const openNavigatorAndFindSubA = async () => {
      fireEvent.click(screen.getByTestId('file-dropdown-button'))
      await waitFor(() => {
        expect(screen.getByTestId('all-files-menu-item')).toBeDefined()
      })
      fireEvent.click(screen.getByTestId('all-files-menu-item'))
      // hiddenRootPath collapses the single "content/posts" root (contentRoot
      // is pinned to it below), so its children render directly at the top
      // level with no expand click needed.
      await waitFor(() => {
        expect(screen.getByTestId('entry-nav-item-sub-a')).toBeDefined()
      })
    }

    it('does not call the update-order API and notifies the user when collectionsFromApi is empty, even though build-time collections are non-empty', async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/api/canopycms/branches')) {
          return Promise.resolve(okJson(unlockedBranchesResponse))
        }
        if (url.includes('/schema') && !url.includes('/schema/')) {
          // Empty flatSchema -- collectionsFromApi (buildEditorCollections)
          // resolves to [] for this branch, the same shape as the gap
          // between a branch switch and the new branch's fetch committing.
          return Promise.resolve(
            okJson({
              ok: true,
              status: 200,
              data: { schema: {}, flatSchema: [], entrySchemas: {} },
            }),
          )
        }
        if (url.includes('/entries')) {
          return Promise.resolve(
            okJson({
              ok: true,
              status: 200,
              data: { collections: [], entries: [], pagination: { hasMore: false, limit: 50 } },
            }),
          )
        }
        return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
      })
      vi.stubGlobal('fetch', fetchMock)

      renderWithProviders(
        <Editor
          entries={[]}
          collections={buildTimeCollections}
          contentRoot="content/posts"
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />,
      )

      // Branch data has loaded and content is unlocked (no read-only banner).
      await waitFor(() => {
        expect(screen.queryByTestId('protected-branch-banner')).toBeNull()
      })

      await openNavigatorAndFindSubA()

      fireEvent.click(screen.getByTestId('collection-menu-sub-a'))
      const moveDown = await screen.findByText('Move Down')
      fireEvent.click(moveDown)

      const { notifications } = await import('@mantine/notifications')
      await waitFor(() => {
        expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(
          expect.objectContaining({ color: 'yellow' }),
        )
      })

      // The not-found guard fired before any write went out.
      expect(
        fetchMock.mock.calls.some(([u, i]) => {
          const calledUrl = typeof u === 'string' ? u : u instanceof URL ? u.toString() : u.url
          return (
            calledUrl.includes('/schema/order/') &&
            (i as RequestInit | undefined)?.method === 'PATCH'
          )
        }),
      ).toBe(false)
    })

    it('reorders normally once collectionsFromApi has loaded (regression guard for the fix above)', async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/api/canopycms/branches')) {
          return Promise.resolve(okJson(unlockedBranchesResponse))
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
                    type: 'collection',
                    logicalPath: 'content/posts',
                    name: 'posts',
                    label: 'Posts',
                    order: ['subA00000001', 'subB00000002'],
                  },
                  {
                    type: 'collection',
                    logicalPath: 'content/posts/sub-a',
                    parentPath: 'content/posts',
                    contentId: 'subA00000001',
                    name: 'sub-a',
                    label: 'Sub A',
                  },
                  {
                    type: 'collection',
                    logicalPath: 'content/posts/sub-b',
                    parentPath: 'content/posts',
                    contentId: 'subB00000002',
                    name: 'sub-b',
                    label: 'Sub B',
                  },
                ],
                entrySchemas: {},
              },
            }),
          )
        }
        if (url.includes('/entries')) {
          return Promise.resolve(
            okJson({
              ok: true,
              status: 200,
              data: { collections: [], entries: [], pagination: { hasMore: false, limit: 50 } },
            }),
          )
        }
        if (url.includes('/schema/order/') && init?.method === 'PATCH') {
          return Promise.resolve(okJson({ ok: true, status: 200, data: { success: true } }))
        }
        return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
      })
      vi.stubGlobal('fetch', fetchMock)

      renderWithProviders(
        <Editor
          entries={[]}
          collections={buildTimeCollections}
          contentRoot="content/posts"
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />,
      )

      await waitFor(() => {
        expect(screen.queryByTestId('protected-branch-banner')).toBeNull()
      })

      await openNavigatorAndFindSubA()

      fireEvent.click(screen.getByTestId('collection-menu-sub-a'))
      const moveDown = await screen.findByText('Move Down')
      fireEvent.click(moveDown)

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([u, i]) => {
            const calledUrl = typeof u === 'string' ? u : u instanceof URL ? u.toString() : u.url
            return (
              calledUrl.includes('/schema/order/') &&
              (i as RequestInit | undefined)?.method === 'PATCH'
            )
          }),
        ).toBe(true)
      })

      const orderCall = fetchMock.mock.calls.find(([u, i]) => {
        const calledUrl = typeof u === 'string' ? u : u instanceof URL ? u.toString() : u.url
        return (
          calledUrl.includes('/schema/order/') && (i as RequestInit | undefined)?.method === 'PATCH'
        )
      })
      const body = JSON.parse((orderCall?.[1] as RequestInit).body as string)
      expect(body.order).toEqual(['subB00000002', 'subA00000001'])
    })
  })

  // This test verifies the fix for the bug where the last manually expanded collection
  // wouldn't persist when the drawer closed and reopened. The fix captures the tree's
  // expanded state synchronously when the drawer closes, preventing race conditions
  // with async callbacks.
  it.skip('preserves tree expansion state when drawer closes and reopens', async () => {
    // Test skipped: Requires full Editor render with all subcomponents.
    // The functionality is verified by the calculatePathToEntry unit tests
    // and manual testing in the actual application.
  })
})

describe('branches-fetch failure recovery', () => {
  it('retries the branches fetch when the branch manager is opened on a pinned branch', async () => {
    // The write lock now fails CLOSED on missing branch data, which turned a
    // pre-existing gate into a lockout: opening the branch manager only called
    // loadBranches() `if (!branchNameState)`, and every ordinary adopter pins a
    // branch. Meanwhile the fetch is terminal on its own -- SWRProvider sets
    // shouldRetryOnError and revalidateOnFocus false, and useBranchesData's
    // refreshInterval is 0 without data -- so one network blip locked the
    // editor for the whole session behind a "Manage Branches" button that
    // pointedly did not retry. Only a page reload got out.
    // The deliberate 500 below makes useBranchManager report the failure via
    // console.error, and vitest's onConsoleLog interceptor fails the whole run
    // on a stray console write. Swallow it here and assert it instead.
    const consoleSpy = mockConsole()
    let branchCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        branchCalls += 1
        // Fail the FIRST fetch only: the retry must be able to succeed, or
        // this test would pass just as well against a retry that never runs.
        if (branchCalls === 1) return Promise.resolve(okJson({ ok: false, status: 500 }, 500))
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
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
            },
          }),
        )
      }
      // Real shapes, not a bare `data: {}`: fetchEntriesAndSchema maps over
      // `data.flatSchema`, so an empty object makes it throw
      // "Cannot read properties of undefined (reading 'map')" as an UNHANDLED
      // rejection — which vitest reports separately from test results and
      // fails the run on, even while every assertion passes.
      if (url.includes('/schema') && !url.includes('/schema/')) {
        return Promise.resolve(
          okJson({ ok: true, status: 200, data: { schema: {}, flatSchema: [], entrySchemas: {} } }),
        )
      }
      if (url.includes('/entries')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: { collections: [], entries: [], pagination: { hasMore: false, limit: 50 } },
          }),
        )
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(
      <Editor
        entries={[]}
        collections={[]}
        title="Test Editor"
        branchName="main"
        operatingMode="dev"
        themeOptions={{}}
      />,
    )

    // The failed fetch leaves the editor locked -- that part is correct and is
    // what the fail-closed default is for.
    await waitFor(() => expect(branchCalls).toBe(1))
    await waitFor(() => expect(screen.getByTestId('status-locked-banner')).toBeTruthy())

    // Open the branch manager the way the lock banner tells the user to.
    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))

    // A second request goes out...
    await waitFor(() => expect(branchCalls).toBeGreaterThan(1))
    // ...and the editor actually recovers, without a reload.
    await waitFor(() => expect(screen.queryByTestId('status-locked-banner')).toBeNull())

    // The failure was reported, not swallowed silently.
    expect(consoleSpy).toHaveErrored(/Failed to load branches/)
    consoleSpy.restore()
  })
})
