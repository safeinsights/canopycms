/**
 * The editor opened on a namespace branch by its short name (`?branch=spring`), the form every
 * link the CMS writes carries: it opens that branch unlocked, and actions on it reach it.
 */
import React from 'react'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { modals } from '@mantine/modals'

import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { RESERVED_GROUPS } from '../authorization/helpers'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn(), update: vi.fn() } }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const spring = {
  name: 'canopycms/local/spring',
  shortName: 'spring',
  status: 'approved',
  access: {},
  createdBy: 'author-1',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  isProtected: false,
  readOnly: false,
  writeBlocked: false,
  submitBlocked: false,
}

const stubApi = () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/whoami')) {
      return Promise.resolve(okJson({ userId: 'reviewer-1', groups: [RESERVED_GROUPS.REVIEWERS] }))
    }
    if (url.endsWith('/comments')) return Promise.resolve(okJson({ threads: [], users: [] }))
    if (url.endsWith('/api/canopycms/branches')) {
      return Promise.resolve(okJson({ branches: [spring], defaultBranch: 'main', users: [] }))
    }
    if (url.includes('/schema') && !url.includes('/schema/')) {
      return Promise.resolve(okJson({ schema: {}, flatSchema: [], entrySchemas: {} }))
    }
    if (url.includes('/entries')) {
      return Promise.resolve(
        okJson({ collections: [], entries: [], pagination: { hasMore: false, limit: 50 } }),
      )
    }
    if (url.endsWith('/request-changes') && init?.method === 'POST') {
      return Promise.resolve(okJson({ branch: { ...spring, status: 'editing' } }))
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const commentReads = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => String(input).endsWith('/comments') && (init?.method ?? 'GET') === 'GET',
  ).length

describe('the editor on a namespace branch named by its short name', () => {
  it('offers its review actions, and reloads its comments after a request for changes', async () => {
    vi.mocked(modals.openConfirmModal).mockImplementation((options) => {
      void options.onConfirm?.()
      return 'confirm'
    })
    window.history.replaceState({}, '', '/?branch=spring')
    const fetchMock = stubApi()
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
        <ApiClientProvider>
          <Editor
            entries={[]}
            title="Test Editor"
            branchName="spring"
            operatingMode="dev"
            themeOptions={{}}
          />
        </ApiClientProvider>
      </SWRConfig>,
    )

    const requestChanges = await screen.findByRole('button', { name: 'Request changes' })
    await waitFor(() => expect(commentReads(fetchMock)).toBeGreaterThan(0))
    const readsBefore = commentReads(fetchMock)

    fireEvent.click(requestChanges)

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith('/canopycms%2Flocal%2Fspring/request-changes'),
        ),
      ).toBe(true),
    )
    await waitFor(() => expect(commentReads(fetchMock)).toBeGreaterThan(readsBefore))
  })
})
