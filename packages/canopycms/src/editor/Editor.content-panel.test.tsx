/**
 * The content panel: docked beside the panes in a wide side-by-side layout, otherwise an overlay on
 * the form pane; its open state and width persist, and a URL asking for no entry opens it.
 */
import React from 'react'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { editorLayoutStorageKey } from './hooks/useEditorLayout'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

const originalMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.matchMedia = originalMatchMedia
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

const schema: EntrySchema = [{ name: 'title', type: 'string', label: 'Title' }]
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

const stubApi = () => {
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
            entries: [hello, second].map((e) => ({
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

const renderEditor = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[hello, second]}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const toggle = () => screen.getByTestId('content-panel-toggle')
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
  if (!panel()) fireEvent.click(toggle())
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
      expect(panel()?.parentElement?.querySelector('[data-testid="form-pane"]')).not.toBeNull()

      fireEvent.click(await row('second'))
      await waitFor(() => expect(panel()).toBeNull())
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

    fireEvent.click(screen.getByTestId('file-dropdown-button'))
    fireEvent.click(await screen.findByTestId('all-files-menu-item'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('entry-nav-filter')))
  })

  it('docks an open overlay open when the layout turns side by side', async () => {
    storeLayout({ layout: 'stacked' })
    await setup(true)
    expect(panel()?.getAttribute('data-panel-mode')).toBe('overlay')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle layout' }))
    await waitFor(() => expect(panel()?.getAttribute('data-panel-mode')).toBe('docked'))
  })

  it('does not bring a closed docked panel back as an overlay', async () => {
    window.history.replaceState({}, '', '/?entry=')
    stubWindowWidth(true)
    stubApi()
    renderEditor()
    await waitFor(() => expect(panel()?.getAttribute('data-panel-mode')).toBe('docked'))

    fireEvent.click(toggle())
    expect(panel()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle layout' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('separator', { name: 'Resize preview and form' })
          .getAttribute('aria-orientation'),
      ).toBe('horizontal'),
    )
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
})
