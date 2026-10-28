/**
 * The content panel: docked in a wide window, beside the panes side by side and beside the form row
 * stacked, otherwise an overlay on the form pane; its open state and width persist, and a URL
 * asking for no entry opens it. Also
 * how a maximized preview gives way to what needs the form, Save all without an entry list, and
 * the browser tab's title.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { editorLayoutStorageKey } from './hooks/useEditorLayout'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'
import { mockConsole } from '../test-utils/console-spy'

// The preview's focus message and the tree scroll fields into view; jsdom has no scrollIntoView.
Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

const originalMatchMedia = window.matchMedia

afterEach(() => {
  changesRequests = []
  cleanup()
  vi.unstubAllGlobals()
  window.matchMedia = originalMatchMedia
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

const schema: EntrySchema = [{ name: 'title', type: 'string', label: 'Title', required: true }]
const entry = (slug: string, contentId: string): EditorEntry => ({
  path: unsafeAsLogicalPath(`content/posts/${slug}`),
  contentId: unsafeAsContentId(contentId),
  label: slug,
  status: 'entry',
  schema,
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug,
  format: 'json',
  type: 'entry',
})
const hello = entry('hello', 'def456ABC123')
const second = entry('second', 'ghi789DEF456')

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/** The URL of every GET /:branch/changes the editor sends. */
let changesRequests: string[] = []

const stubApi = ({
  failingSlug,
  failingEntries,
  listed = [hello, second],
  postType = {},
  missingSlugs = [],
  loadedTitle = 'Loaded title',
  branchNames = ['main'],
  changedEntries = [],
}: {
  /** What GET /:branch/changes answers with. */
  changedEntries?: unknown[]
  /** The branches listed, each editable. */
  branchNames?: string[]
  failingSlug?: string
  failingEntries?: boolean
  listed?: EditorEntry[]
  /** Extra settings for the post entry type, such as `maxItems: 1` to make it a singleton. */
  postType?: { label?: string; maxItems?: number }
  /** Slugs listed with `exists: false`. */
  missingSlugs?: string[]
  /** The title every post loads with. */
  loadedTitle?: string
} = {}) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups: [] }))
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          okJson({
            branches: branchNames.map((name) => ({
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
            })),
            defaultBranch: 'main',
            users: [],
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
                entries: [{ name: 'post', format: 'json', schema, ...postType }],
              },
              {
                type: 'entry-type',
                logicalPath: 'content/posts/post',
                name: 'post',
                parentPath: 'content/posts',
                format: 'json',
                schemaRef: 'postSchema',
                ...postType,
              },
            ],
            entrySchemas: { postSchema: schema },
          }),
        )
      }
      if (url.endsWith('/changes')) {
        changesRequests.push(url)
        return Promise.resolve(
          okJson({ base: 'main', entries: changedEntries, collections: [], hiddenChanges: false }),
        )
      }
      if (url.includes('/entries')) {
        if (failingEntries) return Promise.resolve(new Response('{}', { status: 500 }))
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
            entries: listed.map((e) => ({
              logicalPath: e.path,
              contentId: e.contentId,
              collectionPath: e.collectionPath,
              collectionName: e.collectionName,
              slug: e.slug,
              title: e.label,
              format: e.format,
              entryType: 'post',
              physicalPath: `/content/posts.abc123XYZ789/post.${e.slug}.${e.contentId}.json`,
              exists: !missingSlugs.includes(e.slug ?? ''),
            })),
            pagination: { hasMore: false, limit: 50 },
          }),
        )
      }
      if (failingSlug && url.endsWith(`/content/content/posts/${failingSlug}`)) {
        return Promise.resolve(new Response('{}', { status: 500 }))
      }
      if (url.includes('/content/content/posts/')) {
        return Promise.resolve(okJson({ title: loadedTitle, version: 100 }))
      }
      return Promise.resolve(okJson({}))
    }),
  )
}

/** A window `wide` or narrower than the 64em breakpoint. */
const stubWindowWidth = (wide: boolean) => {
  window.matchMedia = (query: string) =>
    ({
      matches: query === '(min-width: 64em)' && wide,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

const storeLayout = (prefs: Record<string, unknown>) =>
  window.localStorage.setItem(editorLayoutStorageKey(), JSON.stringify(prefs))

const storedLayout = (): Record<string, unknown> =>
  JSON.parse(window.localStorage.getItem(editorLayoutStorageKey()) ?? '{}')

const renderEditor = ({
  renderPreview,
  entries = [hello, second],
  previewBaseByCollection,
}: Partial<
  Pick<React.ComponentProps<typeof Editor>, 'renderPreview' | 'entries' | 'previewBaseByCollection'>
> = {}) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={entries}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
          renderPreview={renderPreview}
          previewBaseByCollection={previewBaseByCollection}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const toggle = () => screen.getByTestId('content-panel-toggle')
const layoutButton = () => screen.getByTestId('rail-layout-button')
const splitOrientation = () =>
  screen
    .getByRole('separator', { name: 'Resize preview and form' })
    .getAttribute('aria-orientation')
const panel = () => screen.queryByTestId('content-panel')
const loaded = () => screen.findByTestId('entry-nav-item-posts', {}, { timeout: 3000 })

/** The tree row of `slug`, found through the filter so no collection needs expanding. */
const row = async (slug: string) => {
  fireEvent.change(screen.getByTestId('entry-nav-filter'), { target: { value: slug } })
  return screen.findByTestId(`entry-nav-item-${slug}`)
}

/** Escape from the panel's filter, emptied first so the filter leaves the key to the panel. */
const escapeFromPanel = () => {
  const filter = screen.getByTestId('entry-nav-filter')
  fireEvent.change(filter, { target: { value: '' } })
  fireEvent.keyDown(filter, { key: 'Escape' })
}

const setup = async (wide: boolean) => {
  stubWindowWidth(wide)
  stubApi()
  renderEditor()
  await waitFor(() => expect(screen.getByTestId('content-panel-toggle')).toBeTruthy())
  if (!panel()) {
    // A click in Chromium focuses the button it presses; fireEvent does not.
    act(() => toggle().focus())
    fireEvent.click(toggle())
  }
  await loaded()
}

describe('content panel', () => {
  it('docks beside the panes in a wide side-by-side window and stays open on select', async () => {
    await setup(true)
    expect(panel()?.closest('[data-canopy-region="panel"]')).not.toBeNull()
    expect(panel()?.getAttribute('data-panel-mode')).toBe('docked')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(await row('second'))
    await waitFor(() =>
      expect(screen.getByTestId('file-dropdown-button').textContent).toContain('second'),
    )
    expect(panel()).not.toBeNull()

    escapeFromPanel()
    expect(panel()).not.toBeNull()

    // Asked again while the docked panel stays open, the row takes focus again.
    screen.getByTestId('entry-nav-filter').focus()
    fireEvent.click(screen.getByRole('button', { name: 'Posts' }))
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.value).toBe(
        'collection:content/posts',
      ),
    )
  })

  it('stays open on Escape from a tree row while docked for good', async () => {
    await setup(true)
    const item = (await row('second')).closest<HTMLElement>('[role="treeitem"]')
    act(() => item?.focus())

    fireEvent.keyDown(item as HTMLElement, { key: 'Escape' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(panel()).not.toBeNull()
  })

  it('keeps its open state and width across a reload', async () => {
    await setup(true)
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize content panel' }), {
      key: 'ArrowRight',
    })
    expect(storedLayout()).toMatchObject({ contentPanelOpen: true, contentPanelWidth: 296 })

    cleanup()
    stubApi()
    renderEditor()
    await loaded()
    expect(panel()?.style.width).toBe('296px')

    fireEvent.click(toggle())
    expect(panel()).toBeNull()
    expect(storedLayout()).toMatchObject({ contentPanelOpen: false })
  })

  it.each([
    ['a narrow side-by-side window', 'side'],
    ['a narrow stacked window', 'stacked'],
  ])(
    'in %s, lays over the form pane only, and closes on select and on Escape',
    async (_where, layout) => {
      storeLayout({ layout })
      await setup(false)
      expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay')
      const formPane = panel()?.parentElement?.querySelector('[data-testid="form-pane"]')
      expect(formPane?.hasAttribute('inert')).toBe(true)

      fireEvent.click(await row('second'))
      await waitFor(() => expect(panel()).toBeNull())
      expect(formPane?.hasAttribute('inert')).toBe(false)
      await waitFor(() => expect(document.activeElement).toBe(toggle()))

      fireEvent.click(toggle())
      await loaded()
      escapeFromPanel()
      await waitFor(() => expect(panel()).toBeNull())
    },
  )

  it.each([
    ['side by side in a wide window', true, 'vertical'],
    ['stacked in a narrow one', false, 'horizontal'],
  ])('starts %s until the user picks a layout', async (_how, wide, separator) => {
    stubWindowWidth(wide)
    stubApi()
    renderEditor()
    const split = await screen.findByRole('separator', { name: 'Resize preview and form' })
    expect(split.getAttribute('aria-orientation')).toBe(separator)
  })

  it('leaves focus alone when it loads open, and takes it when asked for while open', async () => {
    storeLayout({ contentPanelOpen: true })
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await loaded()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.activeElement).toBe(document.body)

    fireEvent.click(screen.getByRole('button', { name: 'Posts' }))
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.value).toBe(
        'collection:content/posts',
      ),
    )
  })

  it("opens the panel on a collection crumb's collection, its row focused", async () => {
    window.history.replaceState({}, '', `/?entry=${hello.path}`)
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await waitFor(() =>
      expect(screen.getByTestId('file-dropdown-button').textContent).toContain('hello'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Posts' }))

    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.value).toBe(
        'collection:content/posts',
      ),
    )
    expect(panel()).not.toBeNull()
  })

  it('docks beside the form row only in a wide stacked window, the preview keeping its row', async () => {
    storeLayout({ layout: 'stacked' })
    await setup(true)
    expect(panel()?.getAttribute('data-panel-mode')).toBe('docked')
    expect(panel()?.closest('[data-testid="form-aside"]')).not.toBeNull()
    expect(document.querySelector('[data-canopy-region="panel"]')?.childElementCount).toBe(0)
    const previewRow = screen.getByTestId('preview-pane').closest('[data-panel]')
    expect(previewRow?.contains(panel())).toBe(false)
    expect(screen.getByTestId('form-pane').hasAttribute('inert')).toBe(false)

    fireEvent.click(await row('second'))
    await waitFor(() =>
      expect(screen.getByTestId('file-dropdown-button').textContent).toContain('second'),
    )
    escapeFromPanel()
    expect(panel()).not.toBeNull()
  })

  it('stays docked, open and at its width as the layout changes', async () => {
    await setup(true)
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize content panel' }), {
      key: 'ArrowRight',
    })
    act(() => layoutButton().focus())

    fireEvent.click(layoutButton())
    await waitFor(() => expect(splitOrientation()).toBe('horizontal'))
    expect(panel()?.closest('[data-testid="form-aside"]')).not.toBeNull()
    expect(panel()?.getAttribute('data-panel-mode')).toBe('docked')
    expect(panel()?.style.width).toBe('296px')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(layoutButton())

    fireEvent.click(layoutButton())
    await waitFor(() => expect(splitOrientation()).toBe('vertical'))
    expect(panel()?.closest('[data-canopy-region="panel"]')).not.toBeNull()
    expect(panel()?.style.width).toBe('296px')
  })

  it('does not bring a closed docked panel back as an overlay', async () => {
    storeLayout({ contentPanelOpen: true })
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await waitFor(() => expect(panel()?.getAttribute('data-panel-mode')).toBe('docked'))

    fireEvent.click(toggle())
    expect(panel()).toBeNull()
    fireEvent.click(layoutButton())
    await waitFor(() => expect(splitOrientation()).toBe('horizontal'))
    expect(panel()).toBeNull()
  })

  it('docks a URL-opened panel open when the stored layout is stacked', async () => {
    storeLayout({ layout: 'stacked' })
    window.history.replaceState({}, '', '/?entry=')
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await loaded()
    expect(panel()?.closest('[data-testid="form-aside"]')).not.toBeNull()
  })

  it('returns focus to the collection crumb when the overlay it opened closes', async () => {
    window.history.replaceState({}, '', `/?entry=${hello.path}`)
    stubWindowWidth(false)
    stubApi()
    renderEditor()
    const crumb = await screen.findByRole('button', { name: 'Posts' })
    crumb.focus()
    fireEvent.click(crumb)
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.value).toBe(
        'collection:content/posts',
      ),
    )

    escapeFromPanel()
    await waitFor(() => expect(panel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(crumb))
  })

  it('uncovers the form when the preview asks to focus one of its fields', async () => {
    await setup(false)
    const formPane = screen.getByTestId('form-pane')
    expect(formPane.hasAttribute('inert')).toBe(true)

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopycms:preview:focus', fieldPath: 'title' },
          origin: window.location.origin,
        }),
      )
    })

    await waitFor(() => expect(panel()).toBeNull())
    expect(formPane.hasAttribute('inert')).toBe(false)
  })

  it('leaves Mod+Alt+M to a form the overlay covers', async () => {
    stubWindowWidth(false)
    stubApi()
    renderEditor()
    await screen.findByTestId('form-comments-menu-button')
    const shortcut = () =>
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'm',
        code: 'KeyM',
        ctrlKey: true,
        metaKey: true,
        altKey: true,
      })

    act(() => toggle().focus())
    fireEvent.click(toggle())
    await loaded()
    shortcut()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByTestId('form-comments-menu')).toBeNull()

    escapeFromPanel()
    await waitFor(() => expect(panel()).toBeNull())
    shortcut()
    expect(await screen.findByTestId('form-comments-menu')).toBeDefined()
  })

  it('does not restore an overlay open on load', async () => {
    storeLayout({ contentPanelOpen: true })
    stubWindowWidth(false)
    stubApi()
    renderEditor()
    await waitFor(() =>
      expect(screen.getByTestId('file-dropdown-button').textContent).toContain('hello'),
    )
    expect(panel()).toBeNull()
  })

  it.each([
    ['docked', true],
    ['an overlay', false],
  ])('opens on load, %s, when the URL asks for no entry', async (_mode, wide) => {
    window.history.replaceState({}, '', '/?entry=')
    stubWindowWidth(wide)
    stubApi()
    renderEditor()
    await waitFor(() => expect(panel()).not.toBeNull())
    expect(panel()?.getAttribute('data-panel-mode')).toBe(wide ? 'docked' : 'overlay')
  })

  it('opens the home page, the entry routed at /, when the URL names no entry', async () => {
    const index = entry('index', 'jkl012GHI789')
    stubWindowWidth(true)
    stubApi({ listed: [hello, second, index] })
    renderEditor({
      entries: [hello, second, index],
      previewBaseByCollection: { 'content/posts': '/' },
    })
    await waitFor(() => expect(document.title).toBe('index · Test Editor'))
    expect(new URL(window.location.href).searchParams.get('entry')).toBe(index.path)
  })

  it.each([
    ['with a page, "Change URL"', undefined, 'Change URL'],
    ['with none, "Change slug"', { 'content/posts': false as const }, 'Change slug'],
  ])(
    'names the entry menu item and dialog by what changes: %s',
    async (_case, previewBaseByCollection, action) => {
      stubWindowWidth(true)
      stubApi()
      renderEditor({ previewBaseByCollection })
      await waitFor(() => expect(document.title).toBe('hello · Test Editor'))
      fireEvent.click(screen.getByTestId('file-dropdown-button'))
      const item = await screen.findByTestId('entry-menu-rename')
      expect(item.textContent).toBe(`${action}…`)
      fireEvent.click(item)
      const dialog = await screen.findByRole('dialog', { name: action })
      expect(dialog.textContent).toContain('which comes from its “Title” field')
    },
  )

  it.each([
    ['with a page, "Change URL"', undefined, 'Change URL'],
    ['with none, "Change slug"', { 'content/posts': false as const }, 'Change slug'],
  ])(
    'names the content tree row menu item and its dialog by what changes: %s',
    async (_case, previewBaseByCollection, action) => {
      stubWindowWidth(true)
      stubApi()
      renderEditor({ previewBaseByCollection })
      await waitFor(() => expect(document.title).toBe('hello · Test Editor'))
      fireEvent.click(toggle())
      fireEvent.click(await screen.findByTestId('entry-menu-second'))
      const item = await screen.findByTestId('rename-entry-menu-item')
      expect(item.textContent).toBe(`${action}…`)
      fireEvent.click(item)
      const dialog = await screen.findByRole('dialog', { name: action })
      // Not open, so its value is not at hand: its schema's title field names it.
      expect(dialog.textContent).toContain('which comes from its “Title” field')
    },
  )

  it("reads the open entry's value: an empty title leaves its name to its slug", async () => {
    stubWindowWidth(true)
    stubApi({ loadedTitle: '' })
    renderEditor()
    await waitFor(() => expect(document.title).toBe('hello · Test Editor'))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /^Title/ })).toHaveProperty('value', ''),
    )
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('entry-menu-rename'))
    const dialog = await screen.findByRole('dialog', { name: 'Change URL' })
    expect(dialog.textContent).toContain('with no title, its name follows the URL')
  })

  it('shows a missing entry as Missing, in error text, in the content tree', async () => {
    stubWindowWidth(true)
    stubApi({ missingSlugs: ['second'] })
    renderEditor()
    await waitFor(() => expect(document.title).toBe('hello · Test Editor'))
    fireEvent.click(toggle())
    const row = await screen.findByTestId('entry-nav-item-second')
    const detail = row.querySelector('[data-testid="entry-nav-detail"]')
    expect(detail?.textContent).toBe('Missing')
    expect(detail?.querySelector('p')?.getAttribute('style')).toContain('--canopy-danger-text')
  })

  it('finds a type-named entry in the content tree filter by its title', async () => {
    stubWindowWidth(true)
    // Its title shares no text with its slug or its type label.
    const welcome = { ...hello, label: 'Welcome aboard' }
    stubApi({ listed: [welcome], postType: { label: 'Featured', maxItems: 1 } })
    renderEditor({ entries: [welcome] })
    await waitFor(() => expect(document.title).toBe('Featured · Test Editor'))
    fireEvent.click(toggle())
    fireEvent.change(await screen.findByTestId('entry-nav-filter'), { target: { value: 'aboard' } })
    expect(screen.queryByTestId('entry-nav-filter-empty')).toBeNull()
    expect(screen.getByTestId('entry-nav-item-featured')).toBeTruthy()
  })

  it("names each entry's type and route under it in the content tree", async () => {
    await setup(true)
    fireEvent.click(screen.getByRole('button', { name: 'Posts' }))
    const details = await screen.findAllByTestId('entry-nav-detail')
    expect(details.map((detail) => detail.textContent)).toEqual([
      'Post · /posts/hello',
      'Post · /posts/second',
    ])
  })
})

describe('finding an entry with Mod+P', () => {
  const gone = entry('gone', 'jkl012GHI789')
  const titleField = () => screen.getByRole('textbox', { name: /^Title/ })
  const filter = () => screen.getByTestId('entry-nav-filter') as HTMLInputElement
  /** Presses Ctrl+P where focus is; false when the press's default (Print) was prevented. */
  const modP = (target: Element = document.activeElement ?? document.body) =>
    fireEvent.keyDown(target, { key: 'p', ctrlKey: true })
  const pause = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)))
  /** A wide window with the docked panel stored closed, and focus in the open entry's form. */
  const closedWide = async () => {
    stubWindowWidth(true)
    storeLayout({ contentPanelOpen: false })
    stubApi({ failingSlug: 'gone', listed: [hello, second, gone] })
    renderEditor({ entries: [hello, second, gone] })
    await waitFor(() => expect(titleField()).toHaveProperty('value', 'Loaded title'))
    expect(panel()).toBeNull()
    act(() => titleField().focus())
  }
  const transientOpen = async () => {
    await closedWide()
    expect(modP()).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(filter()))
  }
  const openWithEnter = (slug: string) => {
    fireEvent.change(filter(), { target: { value: slug } })
    fireEvent.keyDown(filter(), { key: 'Enter' })
  }

  it('opens a closed docked panel at its field, storing nothing, and keeps Print shut', async () => {
    await transientOpen()
    expect(panel()?.getAttribute('data-panel-mode')).toBe('docked')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(storedLayout().contentPanelOpen).toBe(false)
    expect(filter().getAttribute('aria-keyshortcuts')).toBe('Control+P')
    expect(screen.getByTestId('entry-nav-filter-shortcut').textContent).toBe('Ctrl+P')
    expect(toggle().getAttribute('aria-keyshortcuts')).toBe('Control+P')
  })

  it("on Enter, opens the first match, closes, and focuses the entry's first field", async () => {
    await transientOpen()
    // With no opener to go back to, a focus return would land on the entry menu.
    act(() => filter().blur())
    act(() => filter().focus())

    openWithEnter('second')

    await waitFor(() => expect(document.title).toBe('second · Test Editor'))
    await waitFor(() => expect(panel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(titleField()))
    expect(storedLayout().contentPanelOpen).toBe(false)
  })

  it('on Enter, focuses the form pane when the entry fails to load', async () => {
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    // Toasts are global; its "Failed to load entry" would hold later tests' toasts in the queue.
    onTestFinished(() => notifications.clean())
    await transientOpen()

    openWithEnter('gone')

    await screen.findByTestId('entry-load-failed')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('form-pane')))
    expect(screen.getByRole('region', { name: 'Form' })).toBe(screen.getByTestId('form-pane'))
  })

  it('on Enter, leaves focus the user moved before the form rendered', async () => {
    await transientOpen()

    openWithEnter('second')
    act(() => toggle().focus())

    await waitFor(() => expect(titleField()).toHaveProperty('value', 'Loaded title'))
    await waitFor(() => expect(document.title).toBe('second · Test Editor'))
    await pause()
    expect(document.activeElement).toBe(toggle())
  })

  it('on Enter over a maximized preview, restores it and focuses the field', async () => {
    await closedWide()
    fireEvent.click(await screen.findByRole('button', { name: 'Maximize preview' }))
    await screen.findByRole('button', { name: 'Restore' })
    modP(document.body)
    await waitFor(() => expect(document.activeElement).toBe(filter()))

    openWithEnter('second')

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(titleField()))
  })

  it('on Escape in its empty field, closes and returns focus to where Mod+P was pressed', async () => {
    await transientOpen()
    fireEvent.change(filter(), { target: { value: 'sec' } })
    fireEvent.keyDown(filter(), { key: 'Escape' })
    expect(panel()).not.toBeNull()

    fireEvent.keyDown(filter(), { key: 'Escape' })

    await waitFor(() => expect(panel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(titleField()))
  })

  it('on Escape from a tree row, closes and returns focus to where Mod+P was pressed', async () => {
    await transientOpen()
    const item = (await row('second')).closest<HTMLElement>('[role="treeitem"]')
    act(() => item?.focus())

    fireEvent.keyDown(item as HTMLElement, { key: 'Escape' })

    await waitFor(() => expect(panel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(titleField()))
    expect(storedLayout().contentPanelOpen).toBe(false)
  })

  it('on Escape from a tree row over a maximized preview, closes and leaves it maximized', async () => {
    await closedWide()
    fireEvent.click(await screen.findByRole('button', { name: 'Maximize preview' }))
    await screen.findByRole('button', { name: 'Restore' })
    modP(document.body)
    await waitFor(() => expect(document.activeElement).toBe(filter()))
    const item = (await row('second')).closest<HTMLElement>('[role="treeitem"]')
    act(() => item?.focus())

    fireEvent.keyDown(item as HTMLElement, { key: 'Escape' })

    await waitFor(() => expect(panel()).toBeNull())
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })

  it('on Escape over a maximized preview, closes and leaves the preview maximized', async () => {
    await closedWide()
    fireEvent.click(await screen.findByRole('button', { name: 'Maximize preview' }))
    await screen.findByRole('button', { name: 'Restore' })
    modP(document.body)
    await waitFor(() => expect(document.activeElement).toBe(filter()))

    // Dispatched as a browser does, to the window's capture listeners first.
    fireEvent.keyDown(filter(), { key: 'Escape' })

    await waitFor(() => expect(panel()).toBeNull())
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })

  it('keeps where focus returns when pressed again after focus dropped to nothing', async () => {
    await transientOpen()
    act(() => filter().blur())

    expect(modP(document.body)).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(filter()))
    fireEvent.keyDown(filter(), { key: 'Escape' })

    await waitFor(() => expect(panel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(titleField()))
  })

  it('closes when focus moves out of it, not when focus drops to nothing', async () => {
    await transientOpen()
    act(() => filter().blur())
    await pause()
    expect(panel()).not.toBeNull()

    act(() => filter().focus())
    act(() => titleField().focus())

    await waitFor(() => expect(panel()).toBeNull())
    expect(document.activeElement).toBe(titleField())
    expect(storedLayout().contentPanelOpen).toBe(false)
  })

  it('opens for good once a row menu opens', async () => {
    await transientOpen()
    fireEvent.change(filter(), { target: { value: 'second' } })
    fireEvent.click(await screen.findByTestId('entry-menu-second'))
    await screen.findByRole('menu')

    await waitFor(() => expect(storedLayout().contentPanelOpen).toBe(true))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    act(() => titleField().focus())
    await pause()
    expect(panel()).not.toBeNull()
  })

  it('opens for good when the Content button is pressed', async () => {
    await transientOpen()
    act(() => toggle().focus())
    fireEvent.click(toggle())
    await pause()

    expect(panel()).not.toBeNull()
    expect(storedLayout().contentPanelOpen).toBe(true)
    act(() => titleField().focus())
    await pause()
    expect(panel()).not.toBeNull()
  })

  it('selects the text of its field when pressed there', async () => {
    await transientOpen()
    fireEvent.change(filter(), { target: { value: 'sec' } })
    filter().setSelectionRange(3, 3)

    expect(modP(filter())).toBe(false)

    expect([filter().selectionStart, filter().selectionEnd]).toEqual([0, 3])
    expect(panel()).not.toBeNull()
  })

  it('opens nothing over a modal dialog, and still keeps Print shut', async () => {
    await closedWide()
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('entry-menu-rename'))
    const dialog = await screen.findByRole('dialog', { name: 'Change URL' })

    expect(modP(dialog)).toBe(false)
    await pause()
    expect(panel()).toBeNull()
  })

  it('takes ⌘P only on macOS, where Ctrl+P moves the caret', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    onTestFinished(() => platform.mockRestore())
    await closedWide()

    expect(modP()).toBe(true)
    await pause()
    expect(panel()).toBeNull()

    expect(fireEvent.keyDown(titleField(), { key: 'p', metaKey: true })).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(filter()))
    expect(screen.getByTestId('entry-nav-filter-shortcut').textContent).toBe('⌘P')
  })

  it('pressed inside the rail-opened overlay, keeps the Content button as where focus returns', async () => {
    await setup(false)
    const collapse = screen.getByRole('button', { name: 'Collapse all folders' })
    act(() => collapse.focus())

    modP(collapse)
    await waitFor(() => expect(document.activeElement).toBe(filter()))
    escapeFromPanel()

    await waitFor(() => expect(panel()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(toggle()))
  })

  it('in a narrow window, opens the content overlay at its field', async () => {
    stubWindowWidth(false)
    stubApi()
    renderEditor()
    await waitFor(() => expect(titleField()).toHaveProperty('value', 'Loaded title'))
    act(() => titleField().focus())

    modP()

    await waitFor(() => expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay'))
    await waitFor(() => expect(document.activeElement).toBe(filter()))
  })
})

describe('unsaved entries', () => {
  const keepDraft = (...entries: EditorEntry[]) =>
    window.localStorage.setItem(
      'canopycms:drafts:main',
      JSON.stringify({
        v: 2,
        drafts: Object.fromEntries(entries.map((e) => [e.contentId, { title: 'Kept' }])),
        baseVersions: {},
      }),
    )
  const unsaved = () => screen.findByTestId('branch-unsaved-count', {}, { timeout: 3000 })
  const unsavedRadio = () => screen.getByRole('radio', { name: /^Unsaved/ }) as HTMLInputElement
  const allRadio = () => screen.getByRole('radio', { name: 'All' }) as HTMLInputElement
  const shown = (slug: string) => screen.queryByTestId(`entry-nav-item-${slug}`) !== null
  const openedOn = async (wide: boolean, layout: Record<string, unknown> = {}) => {
    window.history.replaceState({}, '', `/?entry=${hello.path}`)
    stubWindowWidth(wide)
    storeLayout(layout)
    stubApi()
    renderEditor()
    await waitFor(() =>
      expect(screen.getByTestId('file-dropdown-button').textContent).toContain('hello'),
    )
  }

  it("lists them in a closed docked panel, filtered to Unsaved, from the bar's count", async () => {
    keepDraft(second)
    await openedOn(true, { contentPanelOpen: false })
    expect(panel()).toBeNull()

    fireEvent.click(await unsaved())

    await waitFor(() => expect(unsavedRadio().checked).toBe(true))
    expect(panel()?.getAttribute('data-panel-mode')).toBe('docked')
    expect(storedLayout().contentPanelOpen).toBe(true)
    await waitFor(() => expect(shown('second')).toBe(true))
    expect(shown('hello')).toBe(false)
  })

  it('opens the narrow overlay with Unsaved already set', async () => {
    keepDraft(second)
    await openedOn(false)

    fireEvent.click(await unsaved())

    await waitFor(() => expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay'))
    expect(unsavedRadio().checked).toBe(true)
    await waitFor(() => expect(shown('second')).toBe(true))
    expect(shown('hello')).toBe(false)
  })

  it('says the list failed to load, not that nothing changed, when it did', async () => {
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    keepDraft(hello)
    stubWindowWidth(true)
    stubApi({ failingEntries: true })
    renderEditor({ entries: [] })
    await screen.findByText('Could not load content')

    fireEvent.click(await unsaved())

    expect((await screen.findByTestId('entry-nav-unsaved-failed')).textContent).toContain(
      "The list of entries couldn't be loaded",
    )
    expect(screen.queryByTestId('entry-nav-unsaved-none')).toBeNull()
    expect(consoleSpy).toHaveErrored(/500/)
  })

  it("shows the open entry's row from its menu: All again, its row focused", async () => {
    keepDraft(second)
    await openedOn(true)
    fireEvent.click(await unsaved())
    await waitFor(() => expect(shown('hello')).toBe(false))

    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('entry-menu-reveal'))

    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.value).toBe(hello.path),
    )
    expect(allRadio().checked).toBe(true)
    expect(shown('second')).toBe(true)
  })

  it("clears a standing query when the bar's count lists them", async () => {
    keepDraft(second)
    await openedOn(true, { contentPanelOpen: true })
    await loaded()
    fireEvent.change(screen.getByTestId('entry-nav-filter'), { target: { value: 'hello' } })

    fireEvent.click(await unsaved())

    await waitFor(() => expect(screen.getByTestId('entry-nav-filter')).toHaveProperty('value', ''))
    expect(unsavedRadio().checked).toBe(true)
    await waitFor(() => expect(shown('second')).toBe(true))
  })

  it('switches back to All when Mod+P finds an entry', async () => {
    keepDraft(second)
    await openedOn(true)
    fireEvent.click(await unsaved())
    await waitFor(() => expect(unsavedRadio().checked).toBe(true))

    fireEvent.keyDown(document.body, { key: 'p', ctrlKey: true })

    await waitFor(() => expect(allRadio().checked).toBe(true))
  })

  it('switches back to All on another branch, whose unsaved entries are its own', async () => {
    // Nothing unsaved, so the switch asks no confirm (`useBranchActions`); Unsaved is chosen in the panel.
    window.history.replaceState({}, '', `/?branch=main&entry=${hello.path}`)
    stubWindowWidth(true)
    storeLayout({ contentPanelOpen: true })
    stubApi({ branchNames: ['main', 'feature'] })
    renderEditor()
    await loaded()
    fireEvent.click(unsavedRadio())
    await waitFor(() => expect(unsavedRadio().checked).toBe(true))

    window.history.replaceState(null, '', `/?branch=feature&entry=${hello.path}`)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(screen.getByTestId('branch-dropdown-button').textContent).toContain('feature'),
    )
    await waitFor(() => expect(allRadio().checked).toBe(true))
  })

  it('opens a Mod+P panel for good when it shows the open entry', async () => {
    await openedOn(true, { contentPanelOpen: false })
    const title = screen.getByRole('textbox', { name: /^Title/ })
    await waitFor(() => expect(title).toHaveProperty('value', 'Loaded title'))
    act(() => title.focus())
    fireEvent.keyDown(title, { key: 'p', ctrlKey: true })
    await waitFor(() => expect(panel()).not.toBeNull())
    expect(storedLayout().contentPanelOpen).toBe(false)

    act(() => screen.getByTestId('file-dropdown-button').focus())
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('entry-menu-reveal'))

    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.value).toBe(hello.path),
    )
    expect(storedLayout().contentPanelOpen).toBe(true)
    act(() => title.focus())
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(panel()).not.toBeNull()
  })
})

describe('changed on this branch', () => {
  const changedRadio = () => screen.getByRole('radio', { name: /^Changed/ }) as HTMLInputElement
  const allRadio = () => screen.getByRole('radio', { name: 'All' }) as HTMLInputElement
  const helloChanged = {
    status: 'modified',
    logicalPath: hello.path,
    contentId: hello.contentId,
    collectionPath: 'content/posts',
    entryType: 'post',
  }

  it('lists what differs from the base, counted in the control', async () => {
    window.history.replaceState({}, '', `/?entry=${second.path}`)
    stubWindowWidth(true)
    storeLayout({ contentPanelOpen: true })
    stubApi({ changedEntries: [helloChanged] })
    renderEditor()
    await loaded()
    await waitFor(() => expect(changedRadio().closest('div')?.textContent).toBe('Changed 1'))
    fireEvent.click(changedRadio())
    expect(await screen.findByTestId('entry-nav-item-hello')).toBeTruthy()
    expect(screen.queryByTestId('entry-nav-item-second')).toBeNull()
    expect(changesRequests[0]).toMatch(/\/main\/changes$/)
  })

  it('reads nothing while the panel is closed', async () => {
    window.history.replaceState({}, '', `/?entry=${hello.path}`)
    stubWindowWidth(true)
    storeLayout({ contentPanelOpen: false })
    stubApi()
    renderEditor()
    await waitFor(() =>
      expect(screen.getByTestId('file-dropdown-button').textContent).toContain('hello'),
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(changesRequests).toEqual([])
  })

  it('reloads after a save', async () => {
    window.history.replaceState({}, '', `/?entry=${hello.path}`)
    stubWindowWidth(true)
    storeLayout({ contentPanelOpen: true })
    stubApi()
    renderEditor()
    await loaded()
    await waitFor(() => expect(changesRequests).toHaveLength(1))
    fireEvent.change(await screen.findByRole('textbox', { name: /^Title/ }), {
      target: { value: 'Saved title' },
    })
    fireEvent.click(screen.getByTestId('save-button'))
    await waitFor(() => expect(changesRequests).toHaveLength(2))
  })

  it('switches back to All on another branch', async () => {
    window.history.replaceState({}, '', `/?branch=main&entry=${hello.path}`)
    stubWindowWidth(true)
    storeLayout({ contentPanelOpen: true })
    stubApi({ branchNames: ['main', 'feature'] })
    renderEditor()
    await loaded()
    fireEvent.click(changedRadio())
    await waitFor(() => expect(changedRadio().checked).toBe(true))

    window.history.replaceState(null, '', `/?branch=feature&entry=${hello.path}`)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await waitFor(() =>
      expect(screen.getByTestId('branch-dropdown-button').textContent).toContain('feature'),
    )
    await waitFor(() => expect(allRadio().checked).toBe(true))
  })
})

describe('layout button', () => {
  it('switches the layout with no entry open, and stores the choice', async () => {
    window.history.replaceState({}, '', '/?entry=')
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await loaded()
    expect(screen.getAllByText('Select an item to start editing.').length).toBeGreaterThan(0)
    expect(splitOrientation()).toBe('vertical')

    fireEvent.click(layoutButton())
    await waitFor(() => expect(splitOrientation()).toBe('horizontal'))
    expect(storedLayout().layout).toBe('stacked')
  })

  it("switches the layout around an adopter's renderPreview, which has no toolbar", async () => {
    window.history.replaceState({}, '', `/?entry=${hello.path}`)
    stubWindowWidth(true)
    stubApi()
    renderEditor({ renderPreview: () => <div data-testid="custom-preview" /> })
    await screen.findByTestId('custom-preview')
    expect(screen.queryByRole('button', { name: 'Maximize preview' })).toBeNull()

    fireEvent.click(layoutButton())
    await waitFor(() => expect(splitOrientation()).toBe('horizontal'))
    expect(storedLayout().layout).toBe('stacked')
  })
})

describe('maximized preview', () => {
  const maximize = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Maximize preview' }))
    await screen.findByRole('button', { name: 'Restore' })
  }
  const formPanel = () => screen.getByTestId('form-pane').parentElement as HTMLElement

  it('leaves the entry header and its Save out of the maximized panes, in reach', async () => {
    await setup(true)
    await maximize()
    const header = screen.getByRole('region', { name: 'Entry' })
    const preview = screen.getByTestId('preview-pane')
    expect(header.contains(screen.getByTestId('save-button'))).toBe(true)
    // In `main`, beside the box holding the panes, where the preview's absolute inset can't reach.
    expect(header.closest('[data-canopy-region="main"]')).not.toBeNull()
    expect(header.nextElementSibling?.contains(preview)).toBe(true)
    expect(header.contains(preview)).toBe(false)
    expect(header.closest('[inert]')).toBeNull()
  })

  it('blocks the layout button while maximized, and frees it on restore', async () => {
    await setup(true)
    expect(layoutButton().getAttribute('aria-disabled')).toBeNull()
    await maximize()
    expect(layoutButton().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(layoutButton())
    expect(splitOrientation()).toBe('vertical')

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(layoutButton().getAttribute('aria-disabled')).toBeNull())
  })

  it('restores when the preview asks to focus one of its fields', async () => {
    await setup(true)
    await maximize()
    expect(formPanel().hasAttribute('inert')).toBe(true)

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopycms:preview:focus', fieldPath: 'title' },
          origin: window.location.origin,
        }),
      )
    })

    await waitFor(() => expect(formPanel().hasAttribute('inert')).toBe(false))
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
  })

  it('stays maximized while another entry opens from the docked panel', async () => {
    await setup(true)
    await maximize()
    fireEvent.click(await row('second'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Copy path/ }).textContent).toContain('second'),
    )
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })

  it('restores when the content overlay opens over the form', async () => {
    stubWindowWidth(false)
    stubApi()
    renderEditor()
    await maximize()

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay'))
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
  })

  it('closes the content overlay when the preview maximizes, and keeps a docked one', async () => {
    await setup(false)
    expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay')

    await maximize()
    await waitFor(() => expect(panel()).toBeNull())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    for (const layout of ['side', 'stacked']) {
      cleanup()
      window.localStorage.clear()
      storeLayout({ layout })
      await setup(true)
      expect(panel()?.getAttribute('data-panel-mode')).toBe('docked')
      await maximize()
      expect(panel()?.closest('[inert]')).toBeNull()
      expect(toggle().getAttribute('aria-expanded')).toBe('true')
    }
  })

  it('shows the form while a maximized entry loads, and when its load fails', async () => {
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    stubWindowWidth(true)
    stubApi({ failingSlug: 'second' })
    storeLayout({ contentPanelOpen: true })
    renderEditor()
    await loaded()
    await maximize()

    fireEvent.click(await row('second'))
    expect(await screen.findByTestId('entry-load-failed')).toBeTruthy()
    expect(formPanel().hasAttribute('inert')).toBe(false)
    expect(screen.getByTestId('preview-pane').style.position).toBe('')
    expect(consoleSpy).toHaveErrored(/Load failed: 500/)
  })

  it('restores when a save fails validation, whose errors are in the form', async () => {
    await setup(true)
    fireEvent.change(await screen.findByRole('textbox', { name: /^Title/ }), {
      target: { value: '' },
    })
    await maximize()

    fireEvent.click(screen.getByTestId('save-button'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull())
    expect(formPanel().hasAttribute('inert')).toBe(false)
  })

  it('restores when Save all refuses the open entry for field errors', async () => {
    await setup(true)
    fireEvent.change(await screen.findByRole('textbox', { name: /^Title/ }), {
      target: { value: '' },
    })
    await maximize()

    fireEvent.click(screen.getByTestId('save-all-button'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull())
    expect(formPanel().hasAttribute('inert')).toBe(false)
  })

  it('gives the content overlay its focus when it opens over a maximized preview', async () => {
    stubWindowWidth(false)
    stubApi()
    renderEditor()
    await maximize()

    act(() => toggle().focus())
    fireEvent.click(toggle())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('entry-nav-filter')))
  })
})

describe('entry menu', () => {
  it("leaves no entry open once the open one is deleted, focus on the rail's Content button", async () => {
    await setup(true)
    await waitFor(() => expect(document.title).toBe('hello · Test Editor'))
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('entry-menu-delete'))
    fireEvent.click(await screen.findByTestId('confirm-delete-submit'))

    await waitFor(() =>
      expect(screen.getByTestId('file-dropdown-button').textContent).toBe('No entry open'),
    )
    await waitFor(() => expect(document.activeElement).toBe(toggle()))
    expect(document.title).toBe('Test Editor')
  })

  it('deletes once, however often its confirm is pressed as the dialog closes', async () => {
    await setup(true)
    await waitFor(() => expect(document.title).toBe('hello · Test Editor'))
    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('entry-menu-delete'))
    const confirm = await screen.findByTestId('confirm-delete-submit')
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(screen.getByTestId('file-dropdown-button').textContent).toBe('No entry open'),
    )
    fireEvent.click(confirm)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const deletes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')
    expect(deletes).toHaveLength(1)
  })
})

describe('entry header while loading', () => {
  it('shows a placeholder crumb, not "No entry open", until the entries arrive', async () => {
    stubWindowWidth(true)
    stubApi()
    const answered = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/entries')) await held
      return answered(input, init)
    })
    renderEditor({ entries: [] })
    expect(await screen.findByTestId('entry-crumb-loading')).toBeTruthy()
    expect(screen.queryByText('No entry open')).toBeNull()

    await act(async () => release())
    await waitFor(() => expect(screen.queryByTestId('entry-crumb-loading')).toBeNull())
    // The entry the editor opens, or "No entry open": a crumb either way, never a blank.
    expect(await screen.findByTestId('file-dropdown-button')).toBeTruthy()
  })
})

describe('saving', () => {
  it('says "Saving…" on the entry being saved only', async () => {
    await setup(true)
    const answered = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') await held
      return answered(input, init)
    })
    fireEvent.change(await screen.findByRole('textbox', { name: /^Title/ }), {
      target: { value: 'Edited' },
    })
    fireEvent.click(screen.getByTestId('save-button'))
    await screen.findByRole('button', { name: 'Saving…' })

    fireEvent.click(await row('second'))
    await waitFor(() => expect(document.title).toBe('second · Test Editor'))
    expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull()
    await act(async () => release())
  })

  it("holds Save all while another entry's save is in flight", async () => {
    await setup(true)
    const answered = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') await held
      return answered(input, init)
    })
    fireEvent.change(await screen.findByRole('textbox', { name: /^Title/ }), {
      target: { value: 'Edited' },
    })
    fireEvent.click(screen.getByTestId('save-button'))
    await screen.findByRole('button', { name: 'Saving…' })

    fireEvent.click(await row('second'))
    await waitFor(() => expect(document.title).toBe('second · Test Editor'))
    const saveAll = screen.getByTestId('save-all-button')
    expect(saveAll.getAttribute('aria-disabled')).toBe('true')
    act(() => saveAll.focus())
    const reason = await screen.findByText('Wait for the save to finish.')
    expect(saveAll.getAttribute('aria-describedby')).toBe(reason.closest('[role="tooltip"]')?.id)
    await act(async () => release())
  })

  it('says "Saved" on the Save button, with no toast, for the entry it saved only', async () => {
    const show = vi.spyOn(notifications, 'show')
    onTestFinished(() => show.mockRestore())
    await setup(true)
    fireEvent.change(await screen.findByRole('textbox', { name: /^Title/ }), {
      target: { value: 'Edited' },
    })
    fireEvent.click(screen.getByTestId('save-button'))
    await screen.findByRole('button', { name: 'Saved' })
    expect(show).not.toHaveBeenCalled()

    fireEvent.click(await row('second'))
    await waitFor(() => expect(document.title).toBe('second · Test Editor'))
    expect(screen.getByTestId('save-button')).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it("blocks Save all while the branch's entry list failed to load", async () => {
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    window.localStorage.setItem(
      'canopycms:drafts:main',
      JSON.stringify({ v: 2, drafts: { [hello.contentId]: { title: 'Kept' } }, baseVersions: {} }),
    )
    stubWindowWidth(true)
    stubApi({ failingEntries: true })
    renderEditor({ entries: [] })
    await screen.findByText('Could not load content')

    const saveAll = screen.getByTestId('save-all-button')
    expect(saveAll).toBe(screen.getByRole('button', { name: 'Save all' }))
    expect(saveAll.getAttribute('aria-disabled')).toBe('true')
    act(() => saveAll.focus())
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'Choose "Refresh branch" in the branch menu to try again.',
    )
    expect(consoleSpy).toHaveErrored(/500/)
  })
})

describe('browser tab title', () => {
  it("names the open entry and the site, and gives the host page's title back on unmount", async () => {
    document.title = 'Host page'
    await setup(true)
    await waitFor(() => expect(document.title).toBe('hello · Test Editor'))

    fireEvent.click(await row('second'))
    await waitFor(() => expect(document.title).toBe('second · Test Editor'))

    cleanup()
    expect(document.title).toBe('Host page')
  })

  it('leaves a title set after its own alone on unmount, as a route navigated to sets', async () => {
    document.title = 'Host page'
    await setup(true)
    await waitFor(() => expect(document.title).toBe('hello · Test Editor'))

    document.title = 'Next page'
    cleanup()
    expect(document.title).toBe('Next page')
  })

  it('names only the site with no entry open', async () => {
    window.history.replaceState({}, '', '/?entry=')
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await loaded()
    expect(document.title).toBe('Test Editor')
  })
})

describe('divider resizes', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const originalResizeObserver = window.ResizeObserver

  // jsdom lays nothing out, and the panel library measures its group before it resizes it.
  const sizeProps = ['offsetWidth', 'offsetHeight'] as const
  const originalSizes = sizeProps.map((prop) =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop),
  )

  beforeAll(() => {
    HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800)
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1000 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 800 })
    window.ResizeObserver = class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const rect = target.getBoundingClientRect()
        const size = [{ inlineSize: rect.width, blockSize: rect.height }]
        const entry = { target, contentRect: rect, borderBoxSize: size, contentBoxSize: size }
        this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    }
  })
  afterAll(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    window.ResizeObserver = originalResizeObserver
    sizeProps.forEach((prop, i) => {
      const descriptor = originalSizes[i]
      if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor)
    })
  })

  it('switches the preview width to Fit once a held divider moves, or a key resizes it', async () => {
    storeLayout({ previewWidth: 'desktop' })
    await setup(true)
    const width = () => screen.getByRole('textbox', { name: 'Preview width' })
    const separator = () => screen.getByRole('separator', { name: 'Resize preview and form' })
    expect(width()).toHaveProperty('value', 'Desktop')

    // A press alone, as a click that only focuses the divider is, keeps the width.
    act(() => separator().setAttribute('data-separator', 'active'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    act(() => separator().setAttribute('data-separator', 'hover'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(width()).toHaveProperty('value', 'Desktop')

    act(() => separator().setAttribute('data-separator', 'active'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    act(() => fireEvent.keyDown(separator(), { key: 'ArrowLeft' }))
    await waitFor(() => expect(storedLayout().previewWidth).toBe('fit'))
    expect(width()).toHaveProperty('value', 'Fit')
    expect(screen.getByTestId('preview-resize-readout')).toBeTruthy()
    act(() => separator().setAttribute('data-separator', 'hover'))
    await waitFor(() => expect(screen.queryByTestId('preview-resize-readout')).toBeNull())
  })

  it('switches the preview width to Fit when a key resizes the divider', async () => {
    storeLayout({ previewWidth: 'tablet' })
    await setup(true)
    act(() =>
      fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize preview and form' }), {
        key: 'ArrowRight',
      }),
    )
    await waitFor(() => expect(storedLayout().previewWidth).toBe('fit'))
  })
})
