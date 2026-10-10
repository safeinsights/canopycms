/**
 * The editor hands the config's `mdxAllow` and the entry's format to each markdown field, so the
 * body of an `mdx` entry offers no toolbar action writing a tag the site refuses.
 */
import React from 'react'

import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SWRConfig } from 'swr'
import type { EntrySchema, MdxAllowlist } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn() } }
})

const entryApiPath = '/api/canopycms/main/content/content/posts/hello'
const schema: EntrySchema = [{ name: 'body', type: 'markdown', label: 'Body', isBody: true }]
const entry: EditorEntry = {
  path: unsafeAsLogicalPath('content/posts/hello'),
  contentId: unsafeAsContentId('def456ABC123'),
  label: 'Hello',
  status: 'entry',
  schema,
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug: 'hello',
  format: 'mdx',
  type: 'entry',
}

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const stubApi = () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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
              format: 'mdx',
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
              format: 'mdx',
              schema,
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
              physicalPath: '/content/posts.abc123XYZ789/post.hello.def456ABC123.mdx',
              exists: true,
            },
          ],
          pagination: { hasMore: false, limit: 50 },
        }),
      )
    }
    if (url === entryApiPath && (!init?.method || init.method === 'GET')) {
      return Promise.resolve(okJson({ body: 'Loaded body', version: 100 }))
    }
    if (url.startsWith(entryApiPath) && init?.method === 'PUT') {
      return Promise.resolve(okJson(JSON.parse(init.body as string).data))
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The Underline buttons once the body's rich-text editor has loaded. */
async function underlineButtons(mdxAllow?: MdxAllowlist): Promise<number> {
  const view = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[entry]}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
          initialSelectedId={entry.contentId}
          mdxAllow={mdxAllow}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )
  try {
    // The rich-text editor is a lazy chunk, slow to load under a full run.
    await waitFor(
      () => {
        expect(view.container.querySelector('.canopy-mdx-content')).not.toBeNull()
      },
      { timeout: 15000 },
    )
    return view.container.querySelectorAll('[aria-label="Underline"], [title="Underline"]').length
  } finally {
    view.unmount()
  }
}

describe('Editor: the site mdxAllow and the entry format reach the body field', () => {
  beforeEach(() => {
    stubApi()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it(
    'offers Underline in an mdx body only when the site allows <u>',
    { timeout: 40000 },
    async () => {
      expect(await underlineButtons()).toBeGreaterThan(0)
      expect(await underlineButtons({ htmlTags: [] })).toBe(0)
    },
  )
})
