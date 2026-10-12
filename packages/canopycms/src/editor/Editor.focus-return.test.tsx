/**
 * An overlay opened from a header or rail menu item returns focus to that menu's trigger when it
 * closes, since the item is gone once it acts. Nothing of @mantine/modals is mocked: the
 * composition (ModalsProvider, Drawer, Modal) is what decides where focus lands.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { RESERVED_GROUPS } from '../authorization'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

// A highlighted branch thread's carousel scrolls itself; jsdom has no Element.scrollTo.
Object.defineProperty(Element.prototype, 'scrollTo', { value: () => {}, configurable: true })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

const schema: EntrySchema = [{ name: 'title', type: 'string', label: 'Title' }]
const hello: EditorEntry = {
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

const stubApi = (options: { groups?: string[]; locked?: boolean; threads?: unknown[] } = {}) => {
  const { groups = [], locked = false, threads = [] } = options
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups }))
      if (url.endsWith('/main/comments')) return Promise.resolve(okJson({ threads, users: [] }))
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          okJson({
            branches: [
              {
                name: 'main',
                status: locked ? 'submitted' : 'editing',
                access: {},
                createdBy: 'user-1',
                createdAt: '2024-01-01',
                updatedAt: '2024-01-01',
                isProtected: false,
                readOnly: false,
                writeBlocked: locked,
                submitBlocked: false,
              },
            ],
            defaultBranch: 'main',
            users: [],
          }),
        )
      }
      if (url.includes('/assets')) return Promise.resolve(okJson({ assets: [] }))
      if (url.endsWith('/admin/status')) {
        return Promise.resolve(
          okJson({
            generatedAt: '2026-01-01T00:00:00.000Z',
            mode: 'dev',
            queue: { pending: 0, processing: 0, completed: 0, failed: 0, corrupt: 0 },
            worker: { state: 'alive' },
            workerStatus: null,
            build: { canopycmsVersion: '1.2.3', sourceRevision: 'abcdef0123456789abcdef' },
            assetStore: { configured: true },
            imageProcessing: { available: true },
          }),
        )
      }
      if (url.includes('/admin/tasks/')) return Promise.resolve(okJson({ tasks: [] }))
      if (url.includes('/admin/branch-health')) {
        return Promise.resolve(okJson({ entries: [], generatedAt: '2026-01-01T00:00:00.000Z' }))
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
            entries: [
              {
                logicalPath: hello.path,
                contentId: hello.contentId,
                collectionPath: hello.collectionPath,
                collectionName: hello.collectionName,
                slug: hello.slug,
                title: hello.label,
                format: hello.format,
                entryType: 'post',
                physicalPath: `/content/posts.abc123XYZ789/post.hello.${hello.contentId}.json`,
                exists: true,
              },
            ],
            pagination: { hasMore: false, limit: 50 },
          }),
        )
      }
      if (url.includes('/content/content/posts/') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(okJson({ title: 'Loaded title', version: 100 }))
      }
      return Promise.resolve(okJson({}))
    }),
  )
}

const renderEditor = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[hello]}
          initialSelectedId={hello.path}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const titleInput = () => screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement

const loaded = async () => {
  await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
  await waitFor(() =>
    expect(screen.getByTestId('branch-dropdown-button').textContent).toContain('main'),
  )
}

const editTitle = async () => {
  await userEvent.type(titleInput(), ' edited')
  await waitFor(() => expect(screen.getByTestId('unsaved-indicator')).toBeTruthy())
}

const focusEl = (el: HTMLElement) => {
  act(() => el.focus())
  expect(document.activeElement).toBe(el)
}

/** Opens `trigger`'s menu from the keyboard, arrows to the item `find` returns and activates it. */
const activateByKeyboard = async (trigger: HTMLElement, find: () => Promise<HTMLElement>) => {
  focusEl(trigger)
  await userEvent.keyboard('{Enter}')
  const item = await find()
  for (let i = 0; i < 12 && document.activeElement !== item; i++) {
    await userEvent.keyboard('{ArrowDown}')
  }
  expect(document.activeElement).toBe(item)
  await userEvent.keyboard('{Enter}')
}
const byTestId = (id: string) => () => screen.findByTestId(id)

const fileTrigger = () => screen.getByTestId('file-dropdown-button')
const branchTrigger = () => screen.getByTestId('branch-dropdown-button')
const settingsTrigger = () => screen.getByTestId('settings-button')

describe('Discard changes (file menu)', () => {
  it.each([
    ['Escape', async () => userEvent.keyboard('{Escape}')],
    ['Cancel', async () => userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))],
  ])(
    'returns focus to the file menu button when the confirm is closed with %s',
    async (_how, close) => {
      stubApi()
      renderEditor()
      await loaded()
      await editTitle()

      await activateByKeyboard(fileTrigger(), byTestId('discard-file-draft-menu-item'))
      await screen.findByTestId('confirm-discard-entry')
      await close()

      await waitFor(() => expect(screen.queryByTestId('confirm-discard-entry')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(fileTrigger()))
    },
  )

  it('returns focus to the file menu button after the discard is confirmed', async () => {
    stubApi()
    renderEditor()
    await loaded()
    await editTitle()

    await activateByKeyboard(fileTrigger(), byTestId('discard-file-draft-menu-item'))
    await userEvent.click(await screen.findByTestId('confirm-discard-entry'))

    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await waitFor(() => expect(document.activeElement).toBe(fileTrigger()))
  })
})

describe('Discard all changes (branch menu)', () => {
  it.each([
    ['Escape', async () => userEvent.keyboard('{Escape}')],
    ['Cancel', async () => userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))],
  ])(
    'returns focus to the branch menu button when the confirm is closed with %s',
    async (_how, close) => {
      stubApi()
      renderEditor()
      await loaded()
      await editTitle()

      await activateByKeyboard(branchTrigger(), byTestId('discard-all-drafts-menu-item'))
      await screen.findByTestId('confirm-discard-all')
      await close()

      await waitFor(() => expect(screen.queryByTestId('confirm-discard-all')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(branchTrigger()))
    },
  )
})

describe('Reload entry (file menu)', () => {
  it('returns focus to the file menu button when the confirm over a draft is cancelled', async () => {
    stubApi()
    renderEditor()
    await loaded()
    await editTitle()

    await activateByKeyboard(fileTrigger(), () =>
      screen.findByRole('menuitem', { name: 'Reload entry' }),
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(fileTrigger()))
  })
})

describe('Switch branch… (branch menu)', () => {
  it.each([
    ['Escape', async () => userEvent.keyboard('{Escape}')],
    [
      'its close button',
      async () => {
        const close = document.querySelector('.mantine-Drawer-close')
        if (!(close instanceof HTMLElement)) throw new Error('no drawer close button')
        await userEvent.click(close)
      },
    ],
  ])(
    'returns focus to the branch menu button when the drawer is closed with %s',
    async (_how, close) => {
      stubApi()
      renderEditor()
      await loaded()

      await activateByKeyboard(branchTrigger(), byTestId('manage-branches-menu-item'))
      await screen.findByText('Manage access, status, and lifecycle')
      await close()

      await waitFor(() =>
        expect(screen.queryByText('Manage access, status, and lifecycle')).toBeNull(),
      )
      await waitFor(() => expect(document.activeElement).toBe(branchTrigger()))
    },
  )

  it('returns focus to the banner button that opened it, not to the menu button', async () => {
    stubApi({ locked: true })
    renderEditor()
    await loaded()
    const banner = await screen.findByTestId('status-locked-banner')
    const opener = banner.querySelector('button')
    if (!opener) throw new Error('no banner button')

    focusEl(opener)
    await userEvent.keyboard('{Enter}')
    await screen.findByText('Manage access, status, and lifecycle')
    await userEvent.keyboard('{Escape}')

    await waitFor(() =>
      expect(screen.queryByText('Manage access, status, and lifecycle')).toBeNull(),
    )
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('returns focus to the branch menu button after "Open branch discussion", not to an earlier opener', async () => {
    stubApi({
      locked: true,
      threads: [
        {
          id: 'thread-1',
          type: 'branch',
          resolved: false,
          authorId: 'user-1',
          createdAt: '2024-01-01T00:00:00.000Z',
          comments: [
            {
              id: 'c1',
              threadId: 'thread-1',
              userId: 'user-1',
              timestamp: '2024-01-01T00:00:00.000Z',
              text: 'Branch note',
            },
          ],
        },
      ],
    })
    renderEditor()
    await loaded()
    const banner = await screen.findByTestId('status-locked-banner')
    const bannerOpener = banner.querySelector('button')
    if (!bannerOpener) throw new Error('no banner button')

    focusEl(bannerOpener)
    await userEvent.keyboard('{Enter}')
    await screen.findByText('Manage access, status, and lifecycle')
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByText('Manage access, status, and lifecycle')).toBeNull(),
    )

    await userEvent.click(screen.getByTestId('comments-button'))
    await userEvent.click(await screen.findByRole('button', { name: 'Open branch discussion' }))
    await screen.findByText('Manage access, status, and lifecycle')
    await userEvent.keyboard('{Escape}')

    await waitFor(() =>
      expect(screen.queryByText('Manage access, status, and lifecycle')).toBeNull(),
    )
    await waitFor(() => expect(document.activeElement).toBe(branchTrigger()))
  })
})

describe('Menu items that act without opening an overlay', () => {
  const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)))

  it.each([
    ['Reload entry', fileTrigger, () => screen.findByRole('menuitem', { name: 'Reload entry' })],
    ['Discard changes with nothing to lose', fileTrigger, byTestId('discard-file-draft-menu-item')],
    [
      'Reload all entries',
      branchTrigger,
      () => screen.findByRole('menuitem', { name: 'Reload all entries' }),
    ],
    [
      'Discard all changes with nothing modified',
      branchTrigger,
      byTestId('discard-all-drafts-menu-item'),
    ],
  ])('%s leaves focus on its menu button', async (_name, trigger, find) => {
    stubApi()
    renderEditor()
    await loaded()

    await activateByKeyboard(trigger(), find)

    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it('picking a recently modified entry leaves focus on the file menu button', async () => {
    stubApi()
    renderEditor()
    await loaded()
    await editTitle()

    await activateByKeyboard(fileTrigger(), async () => {
      const items = await screen.findAllByRole('menuitem', { name: 'Hello' })
      return items[0]
    })

    await waitFor(() => expect(document.activeElement).toBe(fileTrigger()))
  })

  it('leaves focus in the drawer that Switch branch… opened', async () => {
    stubApi()
    renderEditor()
    await loaded()

    await activateByKeyboard(branchTrigger(), byTestId('manage-branches-menu-item'))
    await screen.findByText('Manage access, status, and lifecycle')
    await waitFor(() => expect(screen.queryByTestId('branch-menu')).toBeNull())
    await settled()

    expect(document.activeElement).not.toBe(branchTrigger())
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull()
  })

  it('leaves focus in the drawer that Media library opened', async () => {
    stubApi()
    renderEditor()
    await loaded()

    await activateByKeyboard(settingsTrigger(), byTestId('settings-menu-media-library'))
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.queryByTestId('settings-menu')).toBeNull())
    await settled()

    expect(document.activeElement).not.toBe(settingsTrigger())
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull()
  })

  it('a menu dismissed by a press outside it leaves focus where the press left it', async () => {
    stubApi()
    renderEditor()
    await loaded()

    focusEl(branchTrigger())
    await userEvent.keyboard('{Enter}')
    await screen.findByTestId('branch-menu')
    await userEvent.click(document.body)
    await waitFor(() => expect(screen.queryByTestId('branch-menu')).toBeNull())
    await settled()

    expect(document.activeElement).toBe(document.body)
  })
})

describe('Settings menu', () => {
  it.each([
    ['Media library', 'settings-menu-media-library'],
    ['System health', 'settings-menu-system-health'],
    ['Manage Permissions', 'settings-menu-permissions'],
    ['Manage Groups', 'settings-menu-groups'],
  ])(
    'returns focus to the Settings button when %s is closed with Escape',
    async (_name, itemTestId) => {
      stubApi({ groups: [RESERVED_GROUPS.ADMINS] })
      renderEditor()
      await loaded()

      await activateByKeyboard(settingsTrigger(), byTestId(itemTestId))
      const dialog = await screen.findByRole('dialog')
      await userEvent.keyboard('{Escape}')

      await waitFor(() => expect(dialog.isConnected).toBe(false))
      await waitFor(() => expect(document.activeElement).toBe(settingsTrigger()))
    },
  )

  it('returns focus to the Settings button when the Media library is closed with its close button', async () => {
    stubApi()
    renderEditor()
    await loaded()

    await activateByKeyboard(settingsTrigger(), byTestId('settings-menu-media-library'))
    const dialog = await screen.findByRole('dialog')
    const close = document.querySelector('.mantine-Drawer-close')
    if (!(close instanceof HTMLElement)) throw new Error('no drawer close button')
    fireEvent.click(close)

    await waitFor(() => expect(dialog.isConnected).toBe(false))
    await waitFor(() => expect(document.activeElement).toBe(settingsTrigger()))
  })
})
