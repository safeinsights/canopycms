import React from 'react'

import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SWRConfig } from 'swr'
import { defineCanopyConfig, type EntrySchema } from '../config'
import { CanopyEditorPage } from './CanopyEditorPage'
import { mockConsole, type MockConsole } from '../test-utils/console-spy'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn() } }
})

vi.mock('./PreviewFrame', () => ({
  PreviewFrame: () => <iframe title="preview" />,
}))

/** The deployment's base, which only the server knows; the bundle never names it. */
const SERVER_DEFAULT = 'tier-base'

const schema: EntrySchema = [{ name: 'title', type: 'string', label: 'Title', isTitle: true }]

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const listedEntry = (slug: string, contentId: string) => ({
  logicalPath: `content/posts/${slug}`,
  contentId,
  collectionPath: 'content/posts',
  collectionName: 'posts',
  slug,
  format: 'json',
  entryType: 'post',
  physicalPath: `/content/posts/post.${slug}.${contentId}.json`,
  exists: true,
})

const stubApi = () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups: [] }))
    if (url.endsWith('/api/canopycms/branches')) {
      return Promise.resolve(
        okJson({
          branches: [
            {
              name: SERVER_DEFAULT,
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
          defaultBranch: SERVER_DEFAULT,
        }),
      )
    }
    if (url.includes('/schema') && !url.includes('/schema/')) {
      return Promise.resolve(
        okJson({
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
          entrySchemas: { postSchema: schema },
        }),
      )
    }
    if (url.includes('/entries')) {
      return Promise.resolve(
        okJson({
          collections: [],
          entries: [listedEntry('hello', 'def456ABC123'), listedEntry('other', 'ghi789DEF456')],
          pagination: { hasMore: false, limit: 50 },
        }),
      )
    }
    if (url.includes('/content/content/posts/')) {
      return Promise.resolve(okJson({ title: 'Loaded', version: 1 }))
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// As an adopter's `/edit` builds it in the browser, where the env var naming the deployment's
// base is absent and the literal fallback wins.
const config = defineCanopyConfig({
  mode: 'prod',
  contentRoot: 'content',
  defaultBaseBranch: 'bundle-literal',
  gitBotAuthorName: 'Bot',
  gitBotAuthorEmail: 'bot@example.com',
}).client()

const renderPage = (searchParams?: { branch?: string; entry?: string }) => {
  const Page = CanopyEditorPage(config)
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <Page searchParams={searchParams} />
    </SWRConfig>,
  )
}

/** The branch segment of every branch-scoped API request made so far, `''` for an empty one. */
const requestedBranches = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([input]) => /^\/api\/canopycms\/([^/?]*)\//.exec(String(input))?.[1])
    .filter((branch): branch is string => branch !== undefined)

describe('CanopyEditorPage starting branch', () => {
  let consoleSpy: MockConsole

  beforeEach(() => {
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it("opens on the server's default branch when the URL names none", async () => {
    const fetchMock = stubApi()
    renderPage()

    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
        `/api/canopycms/${SERVER_DEFAULT}/entries?limit=200`,
      ),
    )
    expect(new Set(requestedBranches(fetchMock))).toEqual(new Set([SERVER_DEFAULT]))
  })

  it('opens the entry ?entry= names, on the server default branch', async () => {
    const fetchMock = stubApi()
    renderPage({ entry: 'content/posts/other' })

    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
        `/api/canopycms/${SERVER_DEFAULT}/content/content/posts/other`,
      ),
    )
    expect(new Set(requestedBranches(fetchMock))).toEqual(new Set([SERVER_DEFAULT]))
  })

  it('opens the branch ?branch= names, whatever the server default', async () => {
    const fetchMock = stubApi()
    renderPage({ branch: 'feature' })

    await waitFor(() => expect(requestedBranches(fetchMock)).toContain('feature'))
    expect(requestedBranches(fetchMock)).not.toContain(SERVER_DEFAULT)
  })
})
