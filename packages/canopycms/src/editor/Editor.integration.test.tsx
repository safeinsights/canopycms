import React from 'react'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'

// Mock @mantine/modals
vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: {
    openConfirmModal: vi.fn(),
  },
}))

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
      id: 'posts/hello',
      label: 'Hello',
      status: 'entry',
      schema: [{ name: 'title', type: 'string' }],
      apiPath: '/api/canopycms/main/content/posts/hello',
      collectionId: 'posts',
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
      if (url.includes('/entries')) {
        return Promise.resolve(
          okJson({
            ok: true,
            status: 200,
            data: {
              collections: [
                {
                  id: 'posts',
                  name: 'posts',
                  type: 'collection',
                  format: 'json',
                  schema: entry.schema,
                },
              ],
              entries: [
                {
                  id: entry.id,
                  collectionId: entry.collectionId,
                  collectionName: entry.collectionName,
                  slug: entry.slug,
                  format: entry.format,
                  type: entry.type,
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
      if (url === entry.apiPath && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string)
        return Promise.resolve(okJson({ ok: true, status: 200, data: body.data }))
      }
      return Promise.resolve(okJson({ ok: true, status: 200, data: {} }))
    })

    vi.stubGlobal('fetch', fetchMock)

    render(
      <Editor
        entries={[entry]}
        title="Test Editor"
        branchName="main"
        branchMode="local-simple"
        themeOptions={{}}
      />,
    )

    // Wait for the entry data to be loaded and form to render with loaded value
    await waitFor(() => {
      const input = screen.queryByRole('textbox', { name: /title/i }) as HTMLInputElement | null
      expect(input).not.toBeNull()
      expect(input?.value).toBe('Loaded title')
    })

    // Ensure save button is enabled (not disabled due to loading state)
    const saveButton = await screen.findByRole('button', { name: /save file/i })
    expect(saveButton.hasAttribute('disabled')).toBe(false)

    fireEvent.click(saveButton)

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === entry.apiPath && (init as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toBe(true),
    )

    const saveCall = fetchMock.mock.calls.find(
      ([url, init]) => url === entry.apiPath && (init as RequestInit | undefined)?.method === 'PUT',
    )
    expect(saveCall).toBeTruthy()
    const body = JSON.parse((saveCall?.[1] as RequestInit).body as string)
    expect(body).toMatchObject({
      collection: 'posts',
      slug: 'hello',
      data: { title: 'Loaded title' },
    })
  })
})
