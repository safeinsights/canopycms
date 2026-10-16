/**
 * The content panel: docked beside the panes in a wide side-by-side layout, otherwise an overlay on
 * the form pane; its open state and width persist, and a URL asking for no entry opens it. Also
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

const stubApi = ({
  failingSlug,
  failingEntries,
  listed = [hello, second],
}: { failingSlug?: string; failingEntries?: boolean; listed?: EditorEntry[] } = {}) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups: [] }))
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          okJson({
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
                entries: [{ name: 'post', format: 'json', schema }],
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
            entrySchemas: { postSchema: schema },
          }),
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
              exists: true,
            })),
            pagination: { hasMore: false, limit: 50 },
          }),
        )
      }
      if (failingSlug && url.endsWith(`/content/content/posts/${failingSlug}`)) {
        return Promise.resolve(new Response('{}', { status: 500 }))
      }
      if (url.includes('/content/content/posts/')) {
        return Promise.resolve(okJson({ title: 'Loaded title', version: 100 }))
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
    ['a narrow window', false, 'side'],
    ['the stacked layout', true, 'stacked'],
  ])(
    'in %s, lays over the form pane only, and closes on select and on Escape',
    async (_where, wide, layout) => {
      storeLayout({ layout })
      await setup(wide)
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

  it('docks an open overlay open when the layout turns side by side', async () => {
    storeLayout({ layout: 'stacked' })
    await setup(true)
    expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay')

    fireEvent.click(layoutButton())
    await waitFor(() => expect(panel()?.getAttribute('data-panel-mode')).toBe('docked'))
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

  it('keeps a URL-opened overlay open when the stored layout is stacked', async () => {
    storeLayout({ layout: 'stacked' })
    window.history.replaceState({}, '', '/?entry=')
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await loaded()
    expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay')
  })

  it('returns focus to the collection crumb when the overlay it opened closes', async () => {
    storeLayout({ layout: 'stacked' })
    window.history.replaceState({}, '', `/?entry=${hello.path}`)
    stubWindowWidth(true)
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
    storeLayout({ layout: 'stacked' })
    await setup(true)
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
    storeLayout({ layout: 'stacked' })
    stubWindowWidth(true)
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
    ['with none, "Change file name"', { 'content/posts': false as const }, 'Change file name'],
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

  it("names each entry's type and route under it in quick open", async () => {
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await waitFor(() => expect(document.title).toBe('hello · Test Editor'))
    fireEvent.click(screen.getByTestId('rail-search-button'))
    const details = await screen.findAllByTestId('quick-open-option-detail')
    expect(details.map((detail) => detail.textContent)).toEqual([
      'Post · /posts/hello',
      'Post · /posts/second',
    ])
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
    storeLayout({ layout: 'stacked' })
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await maximize()

    fireEvent.click(toggle())
    await waitFor(() => expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay'))
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
  })

  it('closes the content overlay when the preview maximizes, and keeps a docked one', async () => {
    storeLayout({ layout: 'stacked' })
    await setup(true)
    expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay')

    await maximize()
    expect(panel()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    cleanup()
    window.localStorage.clear()
    await setup(true)
    expect(panel()?.getAttribute('data-panel-mode')).toBe('docked')
    await maximize()
    expect(panel()).not.toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
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

    fireEvent.click(screen.getByTestId('save-options-button'))
    fireEvent.click(await screen.findByTestId('save-all-menu-item'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull())
    expect(formPanel().hasAttribute('inert')).toBe(false)
  })

  it('gives the content overlay its focus when it opens over a maximized preview', async () => {
    storeLayout({ layout: 'stacked' })
    stubWindowWidth(true)
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

    fireEvent.click(screen.getByTestId('save-options-button'))
    const item = await screen.findByTestId('save-all-menu-item')
    expect(item.textContent).toContain('Save all (1)')
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain('Choose "Refresh branch" in the branch menu to try again.')
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
