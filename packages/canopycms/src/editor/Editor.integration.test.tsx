import React from 'react'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'

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
      id: 'content/posts/hello',
      label: 'Hello',
      status: 'entry',
      schema: [{ name: 'title', type: 'string' }],
      apiPath: '/api/canopycms/main/content/posts/hello',
      collectionId: 'content/posts',
      collectionName: 'posts',
      slug: 'hello',
      format: 'json',
      type: 'entry',
    }

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) return Promise.resolve(okJson({}, 404))
      if (url.includes('/entries')) {
        return Promise.resolve(
          okJson({
            collections: [],
            entries: [],
            pagination: { hasMore: false, limit: 50 },
          }),
        )
      }
      if (url === entry.apiPath && (!init || !init.method)) {
        return Promise.resolve(okJson({ data: { title: 'Loaded title' } }))
      }
      if (url === entry.apiPath && init?.method === 'PUT') {
        return Promise.resolve(okJson(JSON.parse(init.body as string)))
      }
      return Promise.resolve(okJson({}))
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

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === entry.apiPath)).toBe(true),
    )

    const saveButton = await screen.findByRole('button', { name: /save file/i })
    await userEvent.click(saveButton)

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
      collection: 'content/posts',
      slug: 'hello',
      data: { title: 'Loaded title' },
    })
  })
})
