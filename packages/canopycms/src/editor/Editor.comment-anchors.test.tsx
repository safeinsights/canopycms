/**
 * A field comment thread inside list items follows its item by key (`CommentThread.itemKeys`):
 * through a move, Duplicate, insert, Remove and Undo, the thread sits on its item's place in the
 * form; one whose item is gone sits on the entry. Runs the whole `<Editor>` against a stubbed
 * `fetch`, with entries whose items carry keys.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'
import { MantineProvider } from '@mantine/core'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { NEW_ITEM_COMMENT_MESSAGE } from './comments/item-anchor-copy'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

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
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

type Rec = Record<string, unknown>

const teamSchema: EntrySchema = [
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'team',
    type: 'object',
    label: 'Team',
    list: true,
    fields: [
      { name: 'name', type: 'string', label: 'Name' },
      {
        name: 'links',
        type: 'object',
        label: 'Links',
        list: true,
        fields: [{ name: 'href', type: 'string', label: 'Href' }],
      },
    ],
  },
]
const pageSchema: EntrySchema = [
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'blocks',
    type: 'block',
    label: 'Sections',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [{ name: 'headline', type: 'string', label: 'Headline' }],
      },
      { name: 'text', label: 'Text', fields: [{ name: 'body', type: 'string', label: 'Body' }] },
    ],
  },
]

const entryOf = (slug: string, contentId: string, entryType: string, schema: EntrySchema) =>
  ({
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
    entryType,
  }) as EditorEntry
const team = entryOf('hello', 'def456ABC123', 'team', teamSchema)
const page = entryOf('landing', 'ghi789DEF456', 'page', pageSchema)

/** What a read of each entry returns: every item and block carries its key. */
const teamData = (): Rec => ({
  title: 'Loaded title',
  team: [
    {
      _key: 'k-ada',
      name: 'Ada',
      links: [
        { _key: 'k-a1', href: '/a1' },
        { _key: 'k-a2', href: '/a2' },
      ],
    },
    { _key: 'k-bo', name: 'Bo' },
    { _key: 'k-cy', name: 'Cy' },
  ],
})
const pageData = (): Rec => ({
  title: 'Loaded title',
  blocks: [
    { _key: 'k-b1', template: 'hero', value: { headline: 'One' } },
    { _key: 'k-b2', template: 'hero', value: { headline: 'Two' } },
    { _key: 'k-b3', template: 'text', value: { body: 'Three' } },
  ],
})

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const fieldThread = (
  id: string,
  entry: EditorEntry,
  canopyPath: string,
  itemKeys: string[],
  text = 'Check this',
) => ({
  id,
  comments: [
    { id: `${id}-c1`, text, userId: 'author-1', threadId: id, timestamp: '2024-01-01T00:00:00Z' },
  ],
  resolved: false,
  type: 'field',
  entryPath: entry.path,
  canopyPath,
  itemKeys,
  authorId: 'author-1',
  createdAt: '2024-01-01T00:00:00Z',
})

interface Recorded {
  /** Bodies of POST /main/comments. */
  commentBodies: Rec[]
  /** Bodies of the content writes. */
  writeBodies: Rec[]
}

const stubApi = (threads: unknown[], contents: Record<string, () => Rec>): Recorded => {
  const recorded: Recorded = { commentBodies: [], writeBodies: [] }
  const entrySchemas = { teamSchema, pageSchema }
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    if (url.endsWith('/whoami')) {
      return Promise.resolve(okJson({ userId: 'user-1', groups: [] }))
    }
    if (url.endsWith('/main/comments')) {
      if (method === 'POST') {
        recorded.commentBodies.push(JSON.parse(String(init?.body)) as Rec)
        return Promise.resolve(okJson({ threadId: 'new-thread', commentId: 'new-comment' }))
      }
      return Promise.resolve(okJson({ threads, users: [{ id: 'author-1', name: 'Ada Lovelace' }] }))
    }
    if (url.endsWith('/users/batch')) {
      return Promise.resolve(okJson({ users: [{ id: 'author-1', name: 'Ada Lovelace' }] }))
    }
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
              entries: [
                { name: 'team', format: 'json', schema: teamSchema },
                { name: 'page', format: 'json', schema: pageSchema },
              ],
            },
            {
              type: 'entry-type',
              logicalPath: 'content/posts/team',
              name: 'team',
              parentPath: 'content/posts',
              format: 'json',
              schemaRef: 'teamSchema',
            },
            {
              type: 'entry-type',
              logicalPath: 'content/posts/page',
              name: 'page',
              parentPath: 'content/posts',
              format: 'json',
              schemaRef: 'pageSchema',
            },
          ],
          entrySchemas,
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
              schema: teamSchema,
              order: [],
            },
          ],
          entries: [team, page].map((e) => ({
            logicalPath: e.path,
            contentId: e.contentId,
            collectionPath: e.collectionPath,
            collectionName: e.collectionName,
            slug: e.slug,
            title: e.label,
            format: e.format,
            entryType: e.entryType,
            physicalPath: `/content/posts.abc123XYZ789/${e.entryType}.${e.slug}.${e.contentId}.json`,
            exists: true,
          })),
          pagination: { hasMore: false, limit: 50 },
        }),
      )
    }
    const slug = /\/content\/content\/posts\/([^/?]+)/.exec(url)?.[1]
    if (slug && contents[slug]) {
      if (method === 'GET')
        return Promise.resolve(okJson({ format: 'json', data: contents[slug](), version: 100 }))
      const body = JSON.parse(String(init?.body)) as Rec
      recorded.writeBodies.push(body)
      return Promise.resolve(okJson({ format: 'json', data: body.data, version: 101 }))
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return recorded
}

const renderEditor = (entry: EditorEntry) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[team, page]}
          initialSelectedId={entry.path}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const loaded = async () => {
  await waitFor(() => {
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(
      'Loaded title',
    )
  })
}

/** The canopy paths of the field controls that show an open thread, in document order. */
const threadPaths = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-comment-control]'))
    .filter((control) => /open thread/.test(control.getAttribute('aria-label') ?? ''))
    .map((control) => (control.getAttribute('data-testid') ?? '').replace('field-comment-', ''))

const rowsTitled = (title: string): HTMLElement[] =>
  screen.getAllByTestId('item-row').filter((row) => row.getAttribute('aria-label') === title)

/** The `nth` row titled `title`, on which the thread test below asks where a thread sits. */
const rowTitled = (title: string, nth = 0): HTMLElement => {
  const row = rowsTitled(title)[nth]
  expect(row, `row ${nth} titled "${title}"`).toBeDefined()
  return row
}

/** Opens the "..." menu of a row and chooses `item`, as a person does. */
const chooseFromRow = async (row: HTMLElement, item: string | RegExp) => {
  const title = row.getAttribute('aria-label') ?? ''
  fireEvent.click(within(row).getByRole('button', { name: `Actions for ${title}` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: item }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

/** The open-thread control for `path` inside `row`, or null when that field shows none there. */
const threadControlIn = (row: HTMLElement, path: string): HTMLElement | null => {
  const control = row.querySelector<HTMLElement>(`[data-testid="field-comment-${path}"]`)
  expect(control, `a comment control for ${path} in the row`).not.toBeNull()
  return /open thread/.test(control?.getAttribute('aria-label') ?? '') ? control : null
}

const entryButton = () => screen.getByTestId('entry-comment-button')

describe('an object list', () => {
  const bo = () => fieldThread('t-bo', team, 'team[1].name', ['k-bo'], 'Check Bo')
  const open = async (threads: unknown[] = [bo()]) => {
    const recorded = stubApi(threads, { hello: teamData, landing: pageData })
    renderEditor(team)
    await loaded()
    return recorded
  }

  it('shows the thread on its item to begin with', async () => {
    await open()

    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
    expect(threadControlIn(rowTitled('Bo'), 'team[1].name')).not.toBeNull()
    expect(threadControlIn(rowTitled('Ada'), 'team[0].name')).toBeNull()
    expect(threadControlIn(rowTitled('Cy'), 'team[2].name')).toBeNull()
    expect(entryButton().getAttribute('aria-label')).toBe('Comment on this entry')
  })

  it('moves the thread with its item when the item moves up', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

    await chooseFromRow(rowTitled('Bo'), /^Move up/)

    await waitFor(() => expect(threadPaths()).toEqual(['team[0].name']))
    expect(rowsTitled('Bo')).toHaveLength(1)
    expect(threadControlIn(rowTitled('Bo'), 'team[0].name')).not.toBeNull()
    expect(threadControlIn(rowTitled('Ada'), 'team[1].name')).toBeNull()
  })

  it('moves the thread down one when the item above it is duplicated', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

    await chooseFromRow(rowTitled('Ada'), 'Duplicate')

    await waitFor(() => expect(threadPaths()).toEqual(['team[2].name']))
    expect(rowsTitled('Ada')).toHaveLength(2)
    expect(threadControlIn(rowTitled('Bo'), 'team[2].name')).not.toBeNull()
    // Neither Ada, nor her copy, holds it.
    expect(threadControlIn(rowTitled('Ada', 0), 'team[0].name')).toBeNull()
    expect(threadControlIn(rowTitled('Ada', 1), 'team[1].name')).toBeNull()
  })

  it('keeps the thread on the original when its item is duplicated, and gives the copy none', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

    await chooseFromRow(rowTitled('Bo'), 'Duplicate')

    await waitFor(() => expect(rowsTitled('Bo')).toHaveLength(2))
    expect(threadPaths()).toEqual(['team[1].name'])
    expect(threadControlIn(rowTitled('Bo', 0), 'team[1].name')).not.toBeNull()
    expect(threadControlIn(rowTitled('Bo', 1), 'team[2].name')).toBeNull()
  })

  it('moves the thread up one when the item above it is removed', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

    await chooseFromRow(rowTitled('Ada'), 'Remove')

    await waitFor(() => expect(threadPaths()).toEqual(['team[0].name']))
    expect(rowsTitled('Ada')).toHaveLength(0)
    expect(threadControlIn(rowTitled('Bo'), 'team[0].name')).not.toBeNull()
    expect(entryButton().getAttribute('aria-label')).toBe('Comment on this entry')
  })

  it('takes the thread off every field when its item is removed, and lists it on the entry', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

    await chooseFromRow(rowTitled('Bo'), 'Remove')

    await waitFor(() => expect(threadPaths()).toEqual([]))
    expect(rowsTitled('Bo')).toHaveLength(0)
    // On no other item either: Cy now holds the index Bo had.
    expect(threadControlIn(rowTitled('Cy'), 'team[1].name')).toBeNull()
    await waitFor(() =>
      expect(entryButton().getAttribute('aria-label')).toBe(
        'Comment on this entry (1 open thread)',
      ),
    )
    fireEvent.click(entryButton())
    const popover = await screen.findByTestId('entry-comment-button-popover')
    expect(within(popover).getByText('Check Bo')).toBeTruthy()
    expect(within(popover).getByText('On a removed item')).toBeTruthy()
    // The removal is only in the draft, so the saved value still names the item.
    expect(popover.textContent).toContain('Team › Bo › Name')
  })

  it("says on the Remove toast that the item's comment moved to the entry", async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

    await chooseFromRow(rowTitled('Bo'), 'Remove')

    const toast = vi
      .mocked(notifications.show)
      .mock.calls.find(([options]) => String(options.id ?? '').startsWith('canopy-undo-'))![0]
    const message = render(<MantineProvider>{toast.message}</MantineProvider>)
    expect(
      message.getByText(
        'Removed "Bo" from Team. Its comment thread moved to "Comment on this entry".',
      ),
    ).toBeTruthy()
  })

  it('says nothing of comments on the Remove toast of an item that had none', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

    await chooseFromRow(rowTitled('Cy'), 'Remove')

    const toast = vi
      .mocked(notifications.show)
      .mock.calls.find(([options]) => String(options.id ?? '').startsWith('canopy-undo-'))![0]
    const message = render(<MantineProvider>{toast.message}</MantineProvider>)
    expect(message.getByText('Removed "Cy" from Team')).toBeTruthy()
  })

  it("names the removed item's field from the schema alone once the removal is saved", async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
    await chooseFromRow(rowTitled('Bo'), 'Remove')
    await waitFor(() => expect(threadPaths()).toEqual([]))

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await screen.findByRole('button', { name: 'Saved' })

    fireEvent.click(entryButton())
    const popover = await screen.findByTestId('entry-comment-button-popover')
    expect(within(popover).getByText('On a removed item')).toBeTruthy()
    expect(popover.textContent).toContain('Team › Name')
    expect(popover.textContent).not.toContain('Team › Bo')
  })

  it('puts the thread back on its item when the removal is undone', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
    await chooseFromRow(rowTitled('Bo'), 'Remove')
    await waitFor(() => expect(threadPaths()).toEqual([]))
    const toast = vi
      .mocked(notifications.show)
      .mock.calls.find(([options]) => String(options.id ?? '').startsWith('canopy-undo-'))![0]
    const message = render(<MantineProvider>{toast.message}</MantineProvider>)

    act(() => fireEvent.click(message.getByRole('button', { name: /^Undo removing / })))

    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
    expect(threadControlIn(rowTitled('Bo'), 'team[1].name')).not.toBeNull()
    expect(entryButton().getAttribute('aria-label')).toBe('Comment on this entry')
  })

  it('follows an item restored by Undo even after the list moved meanwhile', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
    await chooseFromRow(rowTitled('Bo'), 'Remove')
    await waitFor(() => expect(threadPaths()).toEqual([]))
    await chooseFromRow(rowTitled('Cy'), /^Move up/)
    const toast = vi
      .mocked(notifications.show)
      .mock.calls.find(([options]) => String(options.id ?? '').startsWith('canopy-undo-'))![0]
    const message = render(<MantineProvider>{toast.message}</MantineProvider>)

    act(() => fireEvent.click(message.getByRole('button', { name: /^Undo removing / })))

    await waitFor(() => expect(threadPaths()).toHaveLength(1))
    expect(threadControlIn(rowTitled('Bo'), threadPaths()[0])).not.toBeNull()
  })

  describe('a new comment', () => {
    const post = async (path: string, text: string) => {
      fireEvent.click(await screen.findByTestId(`field-comment-${path}`))
      fireEvent.change(await screen.findByTestId('new-thread-textarea'), {
        target: { value: text },
      })
      fireEvent.click(screen.getByTestId('create-thread-button'))
    }

    it('names the item it is on by key', async () => {
      const recorded = await open()
      await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

      await post('team[2].name', 'About Cy')

      await waitFor(() => expect(recorded.commentBodies).toHaveLength(1))
      expect(recorded.commentBodies[0]).toMatchObject({
        text: 'About Cy',
        type: 'field',
        entryPath: team.path,
        canopyPath: 'team[2].name',
        itemKeys: ['k-cy'],
      })
      expect(recorded.commentBodies[0]).not.toHaveProperty('threadId')
    })

    it('names every list item on a nested path, outermost first', async () => {
      const recorded = await open()
      await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))

      await post('team[0].links[1].href', 'About the link')

      await waitFor(() => expect(recorded.commentBodies).toHaveLength(1))
      expect(recorded.commentBodies[0]).toMatchObject({
        canopyPath: 'team[0].links[1].href',
        itemKeys: ['k-ada', 'k-a2'],
      })
    })

    it('names an item that moved by its key, at the place it holds now', async () => {
      const recorded = await open()
      await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
      await chooseFromRow(rowTitled('Cy'), /^Move up/)

      await post('team[1].name', 'About Cy, moved')

      await waitFor(() => expect(recorded.commentBodies).toHaveLength(1))
      expect(recorded.commentBodies[0]).toMatchObject({
        canopyPath: 'team[1].name',
        itemKeys: ['k-cy'],
      })
    })

    it('sends no keys for a field outside any list', async () => {
      const recorded = await open()

      await post('title', 'About the title')

      await waitFor(() => expect(recorded.commentBodies).toHaveLength(1))
      expect(recorded.commentBodies[0]).toMatchObject({ canopyPath: 'title' })
      expect(recorded.commentBodies[0]).not.toHaveProperty('itemKeys')
    })

    it('is refused on an item added since the last save, and keeps what was typed', async () => {
      const recorded = await open()
      await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
      // The team list's own Add follows every row, and so every nested list's.
      fireEvent.click(screen.getAllByTestId('object-list-add').at(-1)!)
      await waitFor(() => expect(screen.getByTestId('field-comment-team[3].name')).toBeTruthy())

      // The reason shows as soon as the box opens, before anything is typed.
      fireEvent.click(await screen.findByTestId('field-comment-team[3].name'))
      const box = (await screen.findByTestId('new-thread-textarea')) as HTMLTextAreaElement
      expect(screen.getByText(NEW_ITEM_COMMENT_MESSAGE)).toBeTruthy()

      // A draft can still be typed; "Comment" says it can't act, and posts nothing.
      fireEvent.change(box, { target: { value: 'About the new item' } })
      const submit = screen.getByTestId('create-thread-button')
      expect(submit.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(submit)
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(box.value).toBe('About the new item')
      expect(recorded.commentBodies).toEqual([])
    })

    it('shows no such reason on an item the saved entry has', async () => {
      await open()
      fireEvent.click(await screen.findByTestId('field-comment-team[2].name'))
      await screen.findByTestId('new-thread-textarea')
      expect(screen.queryByText(NEW_ITEM_COMMENT_MESSAGE)).toBeNull()
      expect(screen.getByTestId('create-thread-button').getAttribute('aria-disabled')).toBeNull()
    })
  })

  it('posts the items with their keys, in their new order, when saved after a move', async () => {
    const recorded = await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
    await chooseFromRow(rowTitled('Bo'), /^Move up/)
    await waitFor(() => expect(threadPaths()).toEqual(['team[0].name']))

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(recorded.writeBodies).toHaveLength(1))
    expect(recorded.writeBodies[0].data).toEqual({
      title: 'Loaded title',
      team: [
        { _key: 'k-bo', name: 'Bo' },
        {
          _key: 'k-ada',
          name: 'Ada',
          links: [
            { _key: 'k-a1', href: '/a1' },
            { _key: 'k-a2', href: '/a2' },
          ],
        },
        { _key: 'k-cy', name: 'Cy' },
      ],
    })
    // The thread was told nothing about the move: the keys are the whole of what it needs.
    expect(recorded.writeBodies[0]).not.toHaveProperty('listMoves')
    expect(threadPaths()).toEqual(['team[0].name'])
  })

  it('posts a duplicate with a key of its own', async () => {
    const recorded = await open()
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].name']))
    await chooseFromRow(rowTitled('Ada'), 'Duplicate')
    await waitFor(() => expect(rowsTitled('Ada')).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(recorded.writeBodies).toHaveLength(1))
    const written = (recorded.writeBodies[0].data as { team: Rec[] }).team
    expect(written.map((t) => t.name)).toEqual(['Ada', 'Ada', 'Bo', 'Cy'])
    expect(written[0]._key).toBe('k-ada')
    expect(written[1]._key).not.toBe('k-ada')
    const links = written[1].links as Rec[]
    expect(links.map((l) => l.href)).toEqual(['/a1', '/a2'])
    expect(links.map((l) => l._key)).not.toContain('k-a1')
    expect(links.map((l) => l._key)).not.toContain('k-a2')
    expect(written[2]._key).toBe('k-bo')
  })
})

describe('a nested list', () => {
  const link = () =>
    fieldThread('t-link', team, 'team[0].links[1].href', ['k-ada', 'k-a2'], 'Check the link')
  const open = async () => {
    stubApi([link()], { hello: teamData })
    renderEditor(team)
    await loaded()
    await waitFor(() => expect(threadPaths()).toEqual(['team[0].links[1].href']))
  }

  it('follows the outer item when it moves', async () => {
    await open()

    await chooseFromRow(rowTitled('Ada'), /^Move down/)

    await waitFor(() => expect(threadPaths()).toEqual(['team[1].links[1].href']))
    expect(threadControlIn(rowTitled('/a2'), 'team[1].links[1].href')).not.toBeNull()
    expect(threadControlIn(rowTitled('/a1'), 'team[1].links[0].href')).toBeNull()
  })

  it('follows the inner item too when both lists move', async () => {
    await open()
    await chooseFromRow(rowTitled('Ada'), /^Move down/)
    await waitFor(() => expect(threadPaths()).toEqual(['team[1].links[1].href']))

    await chooseFromRow(rowTitled('/a2'), /^Move up/)

    await waitFor(() => expect(threadPaths()).toEqual(['team[1].links[0].href']))
    expect(threadControlIn(rowTitled('/a2'), 'team[1].links[0].href')).not.toBeNull()
  })

  it('takes the thread to the entry when the inner item is removed, and when the outer one is', async () => {
    await open()

    await chooseFromRow(rowTitled('/a2'), 'Remove')

    await waitFor(() => expect(threadPaths()).toEqual([]))
    await waitFor(() =>
      expect(entryButton().getAttribute('aria-label')).toBe(
        'Comment on this entry (1 open thread)',
      ),
    )

    // Removing the outer item takes the inner one with it; the thread stays on the entry.
    await chooseFromRow(rowTitled('Ada'), 'Remove')
    await waitFor(() => expect(rowsTitled('Ada')).toHaveLength(0))
    expect(threadPaths()).toEqual([])
    expect(entryButton().getAttribute('aria-label')).toBe('Comment on this entry (1 open thread)')
  })
})

describe('a block list', () => {
  const two = () => fieldThread('t-two', page, 'blocks[1].headline', ['k-b2'], 'Check Two')
  const open = async (threads: unknown[] = [two()]) => {
    const recorded = stubApi(threads, { hello: teamData, landing: pageData })
    renderEditor(page)
    await loaded()
    return recorded
  }

  it('shows the thread on its block, keyed beside the template and not inside its value', async () => {
    await open()

    await waitFor(() => expect(threadPaths()).toEqual(['blocks[1].headline']))
    expect(threadControlIn(rowTitled('Hero, Two'), 'blocks[1].headline')).not.toBeNull()
    expect(threadControlIn(rowTitled('Hero, One'), 'blocks[0].headline')).toBeNull()
  })

  it('moves the thread with its block', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['blocks[1].headline']))

    await chooseFromRow(rowTitled('Hero, Two'), /^Move up/)

    await waitFor(() => expect(threadPaths()).toEqual(['blocks[0].headline']))
    expect(threadControlIn(rowTitled('Hero, Two'), 'blocks[0].headline')).not.toBeNull()
  })

  it('shifts the thread down when a block is inserted above it', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['blocks[1].headline']))

    const inserts = screen.getAllByTestId('block-insert-between')
    fireEvent.click(within(inserts[0]).getByRole('button', { name: 'Add section here' }))
    fireEvent.click(
      within(await screen.findByTestId('block-template-menu')).getByTestId('block-template-hero'),
    )

    await waitFor(() => expect(threadPaths()).toEqual(['blocks[2].headline']))
    expect(threadControlIn(rowTitled('Hero, Two'), 'blocks[2].headline')).not.toBeNull()
  })

  it('shifts the thread up when a block above it is removed, and drops it to the entry when its own is', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['blocks[1].headline']))

    await chooseFromRow(rowTitled('Hero, One'), 'Remove')
    await waitFor(() => expect(threadPaths()).toEqual(['blocks[0].headline']))
    expect(threadControlIn(rowTitled('Hero, Two'), 'blocks[0].headline')).not.toBeNull()

    await chooseFromRow(rowTitled('Hero, Two'), 'Remove')
    await waitFor(() => expect(threadPaths()).toEqual([]))
    await waitFor(() =>
      expect(entryButton().getAttribute('aria-label')).toBe(
        'Comment on this entry (1 open thread)',
      ),
    )
    fireEvent.click(entryButton())
    const popover = await screen.findByTestId('entry-comment-button-popover')
    expect(within(popover).getByText('On a removed item')).toBeTruthy()
    // The removal is only in the draft, so the saved value still names the block.
    expect(within(popover).getByTestId('inline-comment-thread-field').textContent).toBe(
      'Sections › Hero › Headline',
    )
  })

  it('keeps the thread on the original block when it is duplicated, and gives the copy none', async () => {
    await open()
    await waitFor(() => expect(threadPaths()).toEqual(['blocks[1].headline']))

    await chooseFromRow(rowTitled('Hero, Two'), 'Duplicate')

    await waitFor(() => expect(rowsTitled('Hero, Two')).toHaveLength(2))
    expect(threadPaths()).toEqual(['blocks[1].headline'])
    expect(threadControlIn(rowTitled('Hero, Two', 0), 'blocks[1].headline')).not.toBeNull()
    expect(threadControlIn(rowTitled('Hero, Two', 1), 'blocks[2].headline')).toBeNull()
  })

  it('names a block by its key when commenting on a field of it', async () => {
    const recorded = await open()
    await waitFor(() => expect(threadPaths()).toEqual(['blocks[1].headline']))

    fireEvent.click(await screen.findByTestId('field-comment-blocks[2].body'))
    fireEvent.change(await screen.findByTestId('new-thread-textarea'), {
      target: { value: 'About Three' },
    })
    fireEvent.click(screen.getByTestId('create-thread-button'))

    await waitFor(() => expect(recorded.commentBodies).toHaveLength(1))
    expect(recorded.commentBodies[0]).toMatchObject({
      canopyPath: 'blocks[2].body',
      itemKeys: ['k-b3'],
    })
  })

  it('posts the blocks with their keys on the block, in their new order, when saved after a move', async () => {
    const recorded = await open()
    await waitFor(() => expect(threadPaths()).toEqual(['blocks[1].headline']))
    await chooseFromRow(rowTitled('Hero, Two'), /^Move up/)
    await waitFor(() => expect(threadPaths()).toEqual(['blocks[0].headline']))

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(recorded.writeBodies).toHaveLength(1))
    expect(recorded.writeBodies[0].data).toEqual({
      title: 'Loaded title',
      blocks: [
        { _key: 'k-b2', template: 'hero', value: { headline: 'Two' } },
        { _key: 'k-b1', template: 'hero', value: { headline: 'One' } },
        { _key: 'k-b3', template: 'text', value: { body: 'Three' } },
      ],
    })
  })
})

describe('an entry whose items carry no keys yet', () => {
  it('keys them in the draft so a thread made right away can name its item', async () => {
    const recorded = stubApi([], {
      hello: () => ({ title: 'Loaded title', team: [{ name: 'Ada' }, { name: 'Bo' }] }),
    })
    renderEditor(team)
    await loaded()
    // An un-keyed file is keyed by the server's read; one that reaches the editor un-keyed gets
    // random keys as soon as the form commits a change.
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Loaded title, edited' },
    })
    await waitFor(() => {
      const raw = window.localStorage.getItem('canopycms:drafts:main')
      expect(raw).toBeTruthy()
      const draft = (JSON.parse(raw!) as { drafts: Record<string, Rec> }).drafts[team.contentId]
      const keys = (draft.team as Rec[]).map((t) => t._key)
      // Random keys, 12 characters; a key made from content is shorter.
      expect(keys.every((k) => typeof k === 'string' && k.length === 12)).toBe(true)
      expect(new Set(keys).size).toBe(2)
    })

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(recorded.writeBodies).toHaveLength(1))
    const written = (recorded.writeBodies[0].data as { team: Rec[] }).team
    expect(written.map((t) => typeof t._key)).toEqual(['string', 'string'])
    expect(written.map((t) => (t._key as string).length)).toEqual([12, 12])
  })
})

describe('jumping to a thread on another entry', () => {
  it('goes to the field the thread is on once that entry has loaded, not to its stored index', async () => {
    // Made when the block was first, so its stored path is blocks[0]; the saved entry has it second.
    const stale = fieldThread('t-two', page, 'blocks[0].headline', ['k-b2'], 'Check Two')
    stubApi([stale], { hello: teamData, landing: pageData })
    renderEditor(team)
    await loaded()

    fireEvent.click(screen.getByTestId('comments-button'))
    fireEvent.click(await screen.findByRole('button', { name: 'Jump to field' }))

    // The popover of the thread opens on the field it highlights: the block's real place.
    expect(await screen.findByTestId('field-comment-blocks[1].headline-popover')).toBeTruthy()
    expect(screen.queryByTestId('field-comment-blocks[0].headline-popover')).toBeNull()
    expect(threadPaths()).toEqual(['blocks[1].headline'])
    // The field the jump scrolls to and outlines is that one too.
    const outlined = (path: string) =>
      Array.from(document.querySelector(`[data-canopy-field="${path}"]`)?.children ?? []).some(
        (child) => (child as HTMLElement).style.outline.includes('solid'),
      )
    expect(outlined('blocks[1].headline')).toBe(true)
    expect(outlined('blocks[0].headline')).toBe(false)
  })

  it('opens the entry popover, not the field at its stored index, when its item is gone', async () => {
    // Stored at blocks[0], whose block is now another one; its own block was removed.
    const orphan = fieldThread('t-gone', page, 'blocks[0].headline', ['k-gone'], 'Check gone')
    stubApi([orphan], { hello: teamData, landing: pageData })
    renderEditor(team)
    await loaded()

    fireEvent.click(screen.getByTestId('comments-button'))
    fireEvent.click(await screen.findByRole('button', { name: 'Jump to field' }))

    const popover = await screen.findByTestId('entry-comment-button-popover')
    expect(within(popover).getByText('Check gone')).toBeTruthy()
    expect(within(popover).getByText('On a removed item')).toBeTruthy()
    expect(screen.queryByTestId('field-comment-blocks[0].headline-popover')).toBeNull()
    // Nor does it outline the block now at the stored index, which is another block.
    const outline = () =>
      Array.from(
        document.querySelector('[data-canopy-field="blocks[0].headline"]')?.children ?? [],
      ).some((child) => (child as HTMLElement).style.outline.includes('solid'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(outline()).toBe(false)
  })
})

describe('threads on another entry, in the comments panel', () => {
  const card = (text: string): HTMLElement => {
    const found = screen
      .getAllByTestId('comment-thread')
      .find((article) => within(article).queryByText(text))
    if (!found) throw new Error(`no thread card says "${text}"`)
    return found
  }
  const heading = (text: string) =>
    within(card(text)).getByTestId('comment-thread-heading').textContent

  it('names no item of an entry not loaded, since its stored index may be stale', async () => {
    const stale = fieldThread('t-two', page, 'blocks[0].headline', ['k-b2'], 'Check Two')
    stubApi([stale], { hello: teamData, landing: pageData })
    renderEditor(team)
    await loaded()

    fireEvent.click(screen.getByTestId('comments-button'))
    await waitFor(() => expect(heading('Check Two')).toBe('Field · landing › Sections › Headline'))
  })

  it('places a thread on an entry already loaded, marking one whose item is gone', async () => {
    const gone = fieldThread('t-gone', team, 'team[0].name', ['k-gone'], 'Team gone')
    const onPage = fieldThread('t-page', page, 'blocks[0].headline', ['k-b1'], 'On page')
    stubApi([gone, onPage], { hello: teamData, landing: pageData })
    renderEditor(team)
    await loaded()

    // Open the other entry by jumping to its thread; the first stays loaded.
    fireEvent.click(screen.getByTestId('comments-button'))
    const onPageCard = await waitFor(() => card('On page'))
    fireEvent.click(within(onPageCard).getByRole('button', { name: 'Jump to field' }))
    await waitFor(() =>
      expect(screen.getByTestId('field-comment-blocks[0].headline-popover')).toBeTruthy(),
    )
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('field-comment-blocks[0].headline-popover')).toBeNull(),
    )

    fireEvent.click(screen.getByTestId('comments-button'))
    await waitFor(() =>
      expect(within(card('Team gone')).getByText('On a removed item')).toBeTruthy(),
    )
    expect(within(card('Team gone')).getByRole('button', { name: 'Jump to entry' })).toBeTruthy()
    expect(heading('Team gone')).toBe('Field · hello › Team › Name, on a removed item')
  })
})
