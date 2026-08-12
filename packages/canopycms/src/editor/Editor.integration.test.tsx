import React from 'react'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SWRConfig } from 'swr'
import type { EditorEntry } from './Editor'
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
      if (url.endsWith('/api/canopycms/branches'))
        return Promise.resolve(okJson({ ok: false, status: 404 }, 404))
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
      if (url.endsWith('/api/canopycms/branches'))
        return Promise.resolve(okJson({ ok: false, status: 404 }, 404))
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
      if (url.endsWith('/api/canopycms/branches'))
        return Promise.resolve(okJson({ ok: false, status: 404 }, 404))
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
