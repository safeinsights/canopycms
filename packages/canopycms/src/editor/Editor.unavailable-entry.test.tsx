import React from 'react'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'

import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { mockConsole, type MockConsole } from '../test-utils/console-spy'

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

let consoleSpy: MockConsole
beforeEach(() => {
  consoleSpy = mockConsole()
})
afterEach(() => {
  cleanup()
  consoleSpy.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const okJson = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const unavailable = {
  reason: 'unknown-schema',
  schemaRef: 'widgetSchema',
  metaFile: 'content/widgets/.collection.json',
}

const gadgetUnavailable = {
  reason: 'unknown-schema',
  schemaRef: 'gadgetSchema',
  metaFile: 'content/mixed/.collection.json',
}

const unlockedBranch = {
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
}

const listedEntry = (collection: string, slug: string, entryType: string, contentId: string) => ({
  logicalPath: `${collection}/${slug}`,
  contentId,
  collectionPath: collection,
  collectionName: collection,
  slug,
  format: 'json',
  entryType,
  physicalPath: `/${collection}/${slug}.json`,
  exists: true,
})

/**
 * A branch with a `widgets` collection whose only type is unavailable (or, with `flagged: false`,
 * looks healthy to the schema) and a healthy `posts` collection.
 */
function stubFetch(options: { flagged: boolean; widgetRead: () => Response }) {
  const flag = options.flagged ? { unavailable } : {}
  const widgetType = { name: 'widget', format: 'json', schemaRef: 'widgetSchema', ...flag }
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/api/canopycms/branches')) {
      return Promise.resolve(
        okJson({
          ok: true,
          status: 200,
          data: { branches: [unlockedBranch], defaultBranch: 'main' },
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
                type: 'collection',
                logicalPath: 'widgets',
                name: 'widgets',
                label: 'Widgets',
                entries: [widgetType],
              },
              {
                type: 'entry-type',
                logicalPath: 'widgets/widget',
                name: 'widget',
                parentPath: 'widgets',
                format: 'json',
                schemaRef: 'widgetSchema',
                ...flag,
              },
              {
                type: 'collection',
                logicalPath: 'mixed',
                name: 'mixed',
                label: 'Mixed',
                entries: [
                  {
                    name: 'gadget',
                    format: 'json',
                    schemaRef: 'gadgetSchema',
                    default: true,
                    unavailable: gadgetUnavailable,
                  },
                  { name: 'note', format: 'md', schemaRef: 'noteSchema' },
                ],
              },
              {
                type: 'entry-type',
                logicalPath: 'mixed/gadget',
                name: 'gadget',
                parentPath: 'mixed',
                format: 'json',
                schemaRef: 'gadgetSchema',
                unavailable: gadgetUnavailable,
              },
              {
                type: 'entry-type',
                logicalPath: 'mixed/note',
                name: 'note',
                parentPath: 'mixed',
                format: 'md',
                schemaRef: 'noteSchema',
              },
              {
                type: 'collection',
                logicalPath: 'posts',
                name: 'posts',
                label: 'Posts',
                entries: [{ name: 'post', format: 'json', schemaRef: 'postSchema' }],
              },
              {
                type: 'entry-type',
                logicalPath: 'posts/post',
                name: 'post',
                parentPath: 'posts',
                format: 'json',
                schemaRef: 'postSchema',
              },
            ],
            entrySchemas: {
              postSchema: [{ name: 'title', type: 'string' }],
              noteSchema: [{ name: 'title', type: 'string' }],
              gadgetSchema: [],
              widgetSchema: options.flagged ? [] : [{ name: 'size', type: 'string' }],
            },
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
              listedEntry('widgets', 'first', 'widget', 'widget000001'),
              listedEntry('posts', 'hello', 'post', 'post00000001'),
            ],
            pagination: { hasMore: false, limit: 50 },
          },
        }),
      )
    }
    if (url.endsWith('/content/widgets/first')) return Promise.resolve(options.widgetRead())
    if (url.endsWith('/content/posts/hello')) {
      return Promise.resolve(
        okJson({ ok: true, status: 200, data: { title: 'Hello post', version: 1 } }),
      )
    }
    return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderEditor = (initialSelectedId: string) =>
  renderWithProviders(
    <Editor
      entries={[]}
      title="Test Editor"
      branchName="main"
      operatingMode="dev"
      themeOptions={{}}
      initialSelectedId={initialSelectedId}
    />,
  )

const openNavigator = async () => {
  fireEvent.click(screen.getByTestId('file-dropdown-button'))
  await waitFor(() => expect(screen.getByTestId('all-files-menu-item')).toBeDefined())
  fireEvent.click(screen.getByTestId('all-files-menu-item'))
  await waitFor(() => expect(screen.getByTestId('entry-nav-item-widgets')).toBeDefined())
}

const readCalls = (fetchMock: ReturnType<typeof stubFetch>, suffix: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix))

describe('Editor: an entry of an unavailable type', () => {
  it('shows the shared message in place of the form, never reads the entry, and offers no Save', async () => {
    const fetchMock = stubFetch({
      flagged: true,
      widgetRead: () => okJson({ ok: true, status: 200, data: { size: 'large', version: 1 } }),
    })
    renderEditor('widgets/first')

    const notice = await screen.findByTestId('unavailable-entry-notice')
    expect(notice.textContent).toContain(
      "This section uses a content type this editor version doesn't know yet (widgetSchema). It usually appears after the editor finishes updating; reload in a few minutes.",
    )
    expect(screen.queryByRole('textbox', { hidden: true })).toBeNull()
    expect(screen.getByTestId('save-button').hasAttribute('disabled')).toBe(true)
    // Give a (wrongly) issued read time to land before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(readCalls(fetchMock, '/content/widgets/first')).toHaveLength(0)
  })

  it('shows the same message, not an error toast, when the read is refused as SCHEMA_UNAVAILABLE', async () => {
    const fetchMock = stubFetch({
      flagged: false,
      widgetRead: () =>
        okJson(
          {
            ok: false,
            status: 503,
            code: 'SCHEMA_UNAVAILABLE',
            error: 'Entry type widget is unavailable',
          },
          503,
        ),
    })
    renderEditor('widgets/first')

    const notice = await screen.findByTestId('unavailable-entry-notice')
    expect(notice.textContent).toContain("doesn't know yet")
    expect(readCalls(fetchMock, '/content/widgets/first').length).toBeGreaterThan(0)
    expect(notifications.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to load entry' }),
    )
    expect(screen.queryByRole('textbox', { hidden: true })).toBeNull()
  })

  it('still loads a healthy entry into its form', async () => {
    stubFetch({
      flagged: true,
      widgetRead: () => okJson({ ok: true, status: 200, data: {} }),
    })
    renderEditor('posts/hello')

    await waitFor(() => {
      const el = screen.queryByRole('textbox', {
        name: /title/i,
        hidden: true,
      }) as HTMLInputElement | null
      expect(el?.value).toBe('Hello post')
    })
    expect(screen.queryByTestId('unavailable-entry-notice')).toBeNull()
  })

  it('does not read a refused entry again when it is reopened', async () => {
    const fetchMock = stubFetch({
      flagged: false,
      widgetRead: () =>
        okJson({ ok: false, status: 503, code: 'SCHEMA_UNAVAILABLE', error: 'unavailable' }, 503),
    })
    renderEditor('widgets/first')
    await screen.findByTestId('unavailable-entry-notice')

    await openNavigator()
    fireEvent.click(screen.getByTestId('entry-nav-item-posts'))
    fireEvent.click(await screen.findByTestId('entry-nav-item-hello'))
    await waitFor(() => expect(screen.queryByTestId('unavailable-entry-notice')).toBeNull())
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('all-files-menu-item'))
    fireEvent.click(await screen.findByTestId('entry-nav-item-first'))
    await screen.findByTestId('unavailable-entry-notice')

    expect(readCalls(fetchMock, '/content/widgets/first')).toHaveLength(1)
  })

  it('reads a refused entry again after entries are refetched, and shows its form when the read succeeds', async () => {
    let widgetResponse: () => Response = () =>
      okJson({ ok: false, status: 503, code: 'SCHEMA_UNAVAILABLE', error: 'unavailable' }, 503)
    const fetchMock = stubFetch({ flagged: false, widgetRead: () => widgetResponse() })
    renderEditor('widgets/first')
    await screen.findByTestId('unavailable-entry-notice')
    expect(readCalls(fetchMock, '/content/widgets/first')).toHaveLength(1)

    // Saving another entry refetches entries and schema.
    await openNavigator()
    fireEvent.click(screen.getByTestId('entry-nav-item-posts'))
    fireEvent.click(await screen.findByTestId('entry-nav-item-hello'))
    const title = await waitFor(() => {
      const el = screen.queryByRole('textbox', { name: /title/i, hidden: true })
      expect(el).not.toBeNull()
      return el as HTMLInputElement
    })
    fireEvent.change(title, { target: { value: 'Edited title' } })
    await waitFor(() => {
      expect(screen.getByTestId('save-button').hasAttribute('disabled')).toBe(false)
    })
    const entriesCallsBefore = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/entries'),
    ).length
    fireEvent.click(screen.getByTestId('save-button'))
    await waitFor(() => {
      const entriesCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/entries'),
      ).length
      expect(entriesCalls).toBeGreaterThan(entriesCallsBefore)
    })

    widgetResponse = () => okJson({ ok: true, status: 200, data: { size: 'large', version: 1 } })
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('all-files-menu-item'))
    fireEvent.click(await screen.findByTestId('entry-nav-item-first'))

    await waitFor(() => {
      const el = screen.queryByRole('textbox', {
        name: /size/i,
        hidden: true,
      }) as HTMLInputElement | null
      expect(el?.value).toBe('large')
    })
    expect(screen.queryByTestId('unavailable-entry-notice')).toBeNull()
    expect(readCalls(fetchMock, '/content/widgets/first')).toHaveLength(2)
  })

  it('shows the form when File > Reload reads a refused entry successfully', async () => {
    let widgetResponse: () => Response = () =>
      okJson({ ok: false, status: 503, code: 'SCHEMA_UNAVAILABLE', error: 'unavailable' }, 503)
    stubFetch({ flagged: false, widgetRead: () => widgetResponse() })
    renderEditor('widgets/first')
    await screen.findByTestId('unavailable-entry-notice')

    widgetResponse = () => okJson({ ok: true, status: 200, data: { size: 'large', version: 1 } })
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByText('Reload File'))

    await waitFor(() => {
      const el = screen.queryByRole('textbox', {
        name: /size/i,
        hidden: true,
      }) as HTMLInputElement | null
      expect(el?.value).toBe('large')
    })
    expect(screen.queryByTestId('unavailable-entry-notice')).toBeNull()
  })

  describe('with a stored draft for the entry', () => {
    const seedDraft = () =>
      window.localStorage.setItem(
        'canopycms:drafts:main',
        JSON.stringify({
          v: 2,
          drafts: { widget000001: { size: 'draft size' } },
          baseVersions: { widget000001: 1 },
        }),
      )

    const writeCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')

    it('keeps Save disabled and sends no write for an entry whose type is unavailable', async () => {
      seedDraft()
      const fetchMock = stubFetch({
        flagged: true,
        widgetRead: () => okJson({ ok: true, status: 200, data: {} }),
      })
      renderEditor('widgets/first')

      await screen.findByTestId('unavailable-entry-notice')
      // Let the restored draft settle before asserting on Save.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.getByTestId('save-button').hasAttribute('disabled')).toBe(true)
      expect(writeCalls(fetchMock)).toHaveLength(0)
      expect(window.localStorage.getItem('canopycms:drafts:main')).toContain('draft size')
    })

    it('keeps Save disabled for an entry whose read the API refused', async () => {
      seedDraft()
      const fetchMock = stubFetch({
        flagged: false,
        widgetRead: () =>
          okJson({ ok: false, status: 503, code: 'SCHEMA_UNAVAILABLE', error: 'unavailable' }, 503),
      })
      renderEditor('widgets/first')

      await screen.findByTestId('unavailable-entry-notice')
      expect(screen.getByTestId('save-button').hasAttribute('disabled')).toBe(true)
      expect(writeCalls(fetchMock)).toHaveLength(0)
      expect(window.localStorage.getItem('canopycms:drafts:main')).toContain('draft size')
    })
  })

  it('shows the message once under the affected collection, which offers no Add Entry', async () => {
    stubFetch({
      flagged: true,
      widgetRead: () => okJson({ ok: true, status: 200, data: {} }),
    })
    renderEditor('posts/hello')
    await openNavigator()

    const widgetsRow = screen.getByTestId('entry-nav-item-widgets')
    const messages = within(widgetsRow).getAllByTestId('unavailable-type-message')
    expect(messages).toHaveLength(1)
    expect(messages[0].textContent).toContain('widgetSchema')

    fireEvent.click(screen.getByTestId('collection-menu-widgets'))
    await screen.findByText('Edit Collection')
    expect(screen.queryByTestId('add-entry-menu-item')).toBeNull()
  })

  it('leaves a healthy collection exactly as before: no message, Add Entry offered', async () => {
    stubFetch({
      flagged: true,
      widgetRead: () => okJson({ ok: true, status: 200, data: {} }),
    })
    renderEditor('posts/hello')
    await openNavigator()

    fireEvent.click(screen.getByTestId('collection-menu-posts'))
    await screen.findByTestId('add-entry-menu-item')
    expect(
      screen
        .getByTestId('entry-nav-item-posts')
        .querySelector('[data-testid="unavailable-type-message"]'),
    ).toBeNull()
  })

  it('offers only the available types when a collection mixes both, and never defaults to an unavailable one', async () => {
    stubFetch({
      flagged: true,
      widgetRead: () => okJson({ ok: true, status: 200, data: {} }),
    })
    renderEditor('posts/hello')
    await openNavigator()

    fireEvent.click(screen.getByTestId('collection-menu-mixed'))
    fireEvent.click(await screen.findByTestId('add-entry-menu-item'))

    const modal = await screen.findByTestId('create-entry-modal')
    expect(modal.textContent).toContain('Entry type: note')
    expect(modal.textContent).not.toContain('gadget')
    expect(screen.queryByTestId('no-creatable-types')).toBeNull()
  })
})
