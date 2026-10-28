import React from 'react'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SWRConfig } from 'swr'
import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import type { CustomFieldRenderers } from './FormRenderer'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'
import { RESERVED_GROUPS } from '../authorization'
import { mockConsole, type MockConsole } from '../test-utils/console-spy'
import { silenceReportedRenderErrors } from '../test-utils/render-errors'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn() } }
})

interface FrameProps {
  data?: unknown
  isLoading?: unknown
  onMarks?: (marks: { count: number; paths?: string[] }) => void
  onPreviewError?: (error: { message: string; fieldPath?: string } | null) => void
}

/** Every `data`/`isLoading` pair the editor hands the preview frame, in render order. */
const frames: FrameProps[] = []

vi.mock('./PreviewFrame', () => ({
  PreviewFrame: ({ data, isLoading, onMarks, onPreviewError }: FrameProps) => {
    frames.push({ data, isLoading, onMarks, onPreviewError })
    return <iframe title="preview" />
  },
}))

const AUTHOR = 'perAAAAAAAAA'
const SPEAKER = 'perBBBBBBBBB'
const PANELIST_1 = 'perCCCCCCCCC'
const PANELIST_2 = 'perDDDDDDDDD'

const schema: EntrySchema = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'settings', type: 'code', label: 'Settings' },
  { name: 'panel', type: 'reference', label: 'Panel', list: true, collections: ['people'] },
  {
    name: 'byline',
    type: 'object',
    label: 'Byline',
    fields: [{ name: 'person', type: 'reference', label: 'Person', collections: ['people'] }],
  },
  {
    name: 'blocks',
    type: 'block',
    label: 'Blocks',
    templates: [
      {
        name: 'quote',
        label: 'Quote',
        fields: [{ name: 'speaker', type: 'reference', label: 'Speaker', collections: ['people'] }],
      },
    ],
  },
]

const entryApiPath = '/api/canopycms/main/content/content/posts/hello'
const entry: EditorEntry = {
  path: unsafeAsLogicalPath('content/posts/hello'),
  contentId: unsafeAsContentId('def456ABC123'),
  label: 'Hello',
  status: 'entry',
  schema,
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug: 'hello',
  format: 'json',
  type: 'entry',
}

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const person = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase(),
  collection: 'content/people',
  urlPath: `/people/${name.toLowerCase()}`,
})

const stubApi = (groups: string[] = []) => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups }))
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
          entries: [
            {
              logicalPath: entry.path,
              contentId: entry.contentId,
              collectionPath: entry.collectionPath,
              collectionName: entry.collectionName,
              slug: entry.slug,
              format: entry.format,
              entryType: 'post',
              physicalPath: '/content/posts/post.hello.def456ABC123.json',
              exists: true,
            },
          ],
          pagination: { hasMore: false, limit: 50 },
        }),
      )
    }
    if (url.endsWith('/resolve-references')) {
      return Promise.resolve(
        okJson({
          resolved: { [AUTHOR]: person(AUTHOR, 'Ada'), [SPEAKER]: person(SPEAKER, 'Grace') },
        }),
      )
    }
    if (url === entryApiPath && (!init?.method || init.method === 'GET')) {
      return Promise.resolve(
        okJson({
          title: 'Loaded title',
          settings: '{}',
          byline: { person: AUTHOR },
          // The entry's read resolves references, so a list arrives as targets, not ids.
          panel: [person(PANELIST_1, 'Edsger'), person(PANELIST_2, 'Barbara')],
          blocks: [{ template: 'quote', value: { speaker: SPEAKER } }],
          version: 1,
        }),
      )
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderEditor = (customRenderers?: CustomFieldRenderers) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[entry]}
          initialSelectedId={entry.path}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
          contentRoot="content"
          previewPrefix="/edit/preview"
          customRenderers={customRenderers}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

interface PreviewDraft {
  byline?: { person?: unknown }
  blocks?: Array<{ value?: { speaker?: unknown } }>
}

const referencesOf = (frame: FrameProps) => {
  const data = frame.data as PreviewDraft
  return [data.byline?.person, data.blocks?.[0]?.value?.speaker]
}

describe('Editor preview references', () => {
  let consoleSpy: MockConsole
  let unsilence: () => void

  beforeEach(() => {
    frames.length = 0
    consoleSpy = mockConsole()
    unsilence = silenceReportedRenderErrors()
  })

  afterEach(() => {
    unsilence()
    consoleSpy.restore()
    vi.unstubAllGlobals()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('hands the frame null for a pending reference, never its id, then the resolved target', async () => {
    const fetchMock = stubApi()
    renderEditor()

    // The entry load, the 300ms debounce and the resolve request all precede this frame.
    await waitFor(
      () =>
        expect(referencesOf(frames[frames.length - 1])).toEqual([
          person(AUTHOR, 'Ada'),
          person(SPEAKER, 'Grace'),
        ]),
      { timeout: 10_000 },
    )

    const withEntry = frames.filter((frame) => (frame.data as PreviewDraft).byline)
    expect(withEntry.length).toBeGreaterThan(0)
    for (const frame of withEntry) {
      for (const reference of referencesOf(frame)) {
        expect(typeof reference).not.toBe('string')
      }
    }
    expect(referencesOf(withEntry[0])).toEqual([null, null])
    expect(withEntry[0].isLoading).toEqual({
      panel: [false, false],
      byline: { person: true },
      blocks: [{ value: { speaker: true } }],
    })
    expect(frames[frames.length - 1].isLoading).toEqual({
      panel: [false, false],
      byline: { person: false },
      blocks: [{ value: { speaker: false } }],
    })

    const resolveCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/resolve-references'),
    )
    expect(resolveCalls).toHaveLength(1)
  })

  it('hands the frame a list reference loaded as targets on load, without asking for them', async () => {
    const fetchMock = stubApi()
    renderEditor()

    await waitFor(
      () =>
        expect(referencesOf(frames[frames.length - 1])).toEqual([
          person(AUTHOR, 'Ada'),
          person(SPEAKER, 'Grace'),
        ]),
      { timeout: 10_000 },
    )

    const panels = frames
      .map((frame) => (frame.data as { panel?: unknown } | undefined)?.panel)
      .filter((panel) => panel !== undefined)
    expect(panels.length).toBeGreaterThan(0)
    for (const panel of panels) {
      expect(panel).toEqual([person(PANELIST_1, 'Edsger'), person(PANELIST_2, 'Barbara')])
    }
    const askedFor = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/resolve-references'))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { ids: string[] }).ids)
    expect(askedFor).not.toContain(PANELIST_1)
    expect(askedFor).not.toContain(PANELIST_2)
  })

  it('still resolves every reference while another field has crashed', async () => {
    stubApi()
    renderEditor({
      code: () => {
        throw new Error('settings exploded')
      },
    })

    // The entry load, the 300ms debounce and the resolve request all precede this frame.
    await waitFor(
      () =>
        expect(referencesOf(frames[frames.length - 1])).toEqual([
          person(AUTHOR, 'Ada'),
          person(SPEAKER, 'Grace'),
        ]),
      { timeout: 10_000 },
    )
    expect(consoleSpy).toHaveErrored('[canopycms] editor error caught (field settings)')
  })
})

describe('Editor preview marks', () => {
  let consoleSpy: MockConsole

  beforeEach(() => {
    frames.length = 0
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    vi.unstubAllGlobals()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('notes a preview that marks nothing only while highlighting is on, from a count sent since', async () => {
    stubApi()
    renderEditor()
    await waitFor(() => expect(frames.some((frame) => frame.onMarks)).toBe(true), {
      timeout: 10_000,
    })
    const reportCount = (count: number) =>
      act(() => {
        frames[frames.length - 1].onMarks?.({ count })
      })
    const note = () => screen.queryByText(/marks no editable elements/)
    const toggle = screen.getByRole('button', { name: 'Highlight fields in the preview' })

    reportCount(0)
    expect(note()).toBeNull()

    fireEvent.click(toggle)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(note()).toBeNull()

    reportCount(0)
    expect(await screen.findByText(/marks no editable elements/)).toBeTruthy()

    reportCount(3)
    await waitFor(() => expect(note()).toBeNull())

    reportCount(0)
    await screen.findByText(/marks no editable elements/)
    fireEvent.click(toggle)
    await waitFor(() => expect(note()).toBeNull())
    fireEvent.click(toggle)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(note()).toBeNull()
  })

  it('counts the marks that name no field for an admin, and warns once for each', async () => {
    stubApi([RESERVED_GROUPS.ADMINS])
    renderEditor()
    await waitFor(() => expect(frames.some((frame) => frame.onMarks)).toBe(true), {
      timeout: 10_000,
    })
    const report = (paths: string[]) =>
      act(() => {
        frames[frames.length - 1].onMarks?.({ count: paths.length, paths })
      })
    const toggle = screen.getByRole('button', { name: 'Highlight fields in the preview' })
    const warnings = () =>
      consoleSpy.all().warn.filter((message) => message.includes('[canopycms]'))

    const chip = () => screen.queryByTestId('preview-unmapped-chip')

    fireEvent.click(toggle)
    report(['title', 'byline.person', 'byline.person.name', 'subtitle'])
    await waitFor(() => expect(chip()?.textContent).toBe('2 unmapped preview marks'))
    fireEvent.click(chip()!)
    expect((await screen.findByRole('dialog')).textContent).toContain(
      "2 elements on this page carry field marks that don't match a field of this entry: byline.person.name, subtitle.",
    )
    await waitFor(() =>
      expect(warnings()).toEqual([
        '[canopycms] The preview marks "byline.person.name", which names no field of this entry; its nearest field is "byline.person".',
        '[canopycms] The preview marks "subtitle", which names no field of this entry.',
      ]),
    )

    report(['title', 'byline.person.name', 'subtitle', 'blocks[0]'])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(warnings()).toHaveLength(2)

    fireEvent.click(toggle)
    await waitFor(() => expect(chip()).toBeNull())
    report(['subtitle', 'heading'])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(chip()).toBeNull()
    expect(warnings()).toHaveLength(2)
  })

  it('shows an editor no count of unmapped marks', async () => {
    stubApi()
    renderEditor()
    await waitFor(() => expect(frames.some((frame) => frame.onMarks)).toBe(true), {
      timeout: 10_000,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Highlight fields in the preview' }))
    act(() => {
      frames[frames.length - 1].onMarks?.({ count: 2, paths: ['title', 'subtitle'] })
    })
    // The marks did arrive: the console names the unmapped one.
    await waitFor(() =>
      expect(consoleSpy.all().warn.some((message) => message.includes('"subtitle"'))).toBe(true),
    )
    expect(screen.queryByTestId('preview-unmapped-chip')).toBeNull()
  })

  it("names a preview error's field by its labels and shows the page's path without the mount", async () => {
    stubApi()
    renderEditor()
    await waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 10_000 })

    expect(screen.getByRole('button', { name: 'Copy path /posts/hello' })).toBeTruthy()

    act(() => {
      frames[frames.length - 1].onPreviewError?.({
        message: 'Unknown speaker',
        fieldPath: 'blocks[0].speaker',
      })
    })
    expect(await screen.findByText('Blocks › Quote › Speaker: Unknown speaker')).toBeTruthy()

    act(() => {
      frames[frames.length - 1].onPreviewError?.({ message: 'Unknown speaker', fieldPath: '.' })
    })
    expect(await screen.findByText('Unknown speaker')).toBeTruthy()
  })
})
