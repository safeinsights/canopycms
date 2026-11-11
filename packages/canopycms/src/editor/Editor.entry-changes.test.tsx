/**
 * "Show changes" end to end in the editor: offered on an open entry the branch changed, opening
 * the lazily loaded drawer, and handing focus back to it on Escape.
 */
import React from 'react'

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'
import { plainBranchPath } from '../test-utils/branch-wire'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

const schema: EntrySchema = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'author', type: 'reference', label: 'Author', collections: ['posts'] },
]
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

/** The API for a branch `main` (not protected) whose changes list `changed`. */
const stubApi = (
  changed: string[],
  entryChange?: { status: number; error: string },
  options: { branch?: Record<string, unknown>; added?: boolean } = {},
) => {
  const threads: unknown[] = []
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = plainBranchPath(new URL(url, 'http://localhost').pathname)
    if (path.endsWith('/whoami')) return Promise.resolve(okJson({ userId: 'user-1', groups: [] }))
    if (path.endsWith('/main/comments')) return Promise.resolve(okJson({ threads, users: [] }))
    if (path.endsWith('/main/changes')) {
      return Promise.resolve(
        okJson({
          base: 'main',
          entries: changed.map((logicalPath) => ({
            status: options.added ? 'added' : 'modified',
            logicalPath,
            contentId: hello.contentId,
            collectionPath: 'content/posts',
            entryType: 'post',
          })),
          collections: [],
          hiddenChanges: false,
        }),
      )
    }
    if (path.includes('/main/changes/') && entryChange) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, ...entryChange }), {
          status: entryChange.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    if (path.includes('/main/changes/')) {
      return Promise.resolve(
        okJson({
          before: options.added
            ? null
            : {
                format: 'json',
                entryType: 'post',
                data: { title: 'Old title', author: 'aaaaaaaaaaaa' },
              },
          after: {
            format: 'json',
            entryType: 'post',
            data: { title: 'Loaded title', author: 'bbbbbbbbbbbb' },
          },
          mergeBaseSha: 'a'.repeat(40),
        }),
      )
    }
    if (path.endsWith('/api/canopycms/branches')) {
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
              ...options.branch,
            },
          ],
          defaultBranch: 'main',
          users: [],
        }),
      )
    }
    if (path.endsWith('/schema')) {
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
    if (path.includes('/entries')) {
      return Promise.resolve(
        okJson({
          collections: [],
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
    if (path.includes('/content/content/posts/') && (!init?.method || init.method === 'GET')) {
      // The form's read resolves references; the comparison's sides hold their ids.
      return Promise.resolve(
        okJson({
          title: 'Loaded title',
          author: { id: 'bbbbbbbbbbbb', title: 'Grace' },
          version: 100,
        }),
      )
    }
    if (path.includes('/content/content/posts/') && init?.method === 'PUT') {
      return Promise.resolve(okJson({ format: 'json', data: { title: 'Saved' }, version: 101 }))
    }
    return Promise.resolve(okJson({}))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const renderEditor = (
  swr: { dedupingInterval: number; focusThrottleInterval?: number } = {
    dedupingInterval: 2000,
  },
) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), ...swr }}>
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
const requested = (fetch: ReturnType<typeof stubApi>, fragment: string) =>
  fetch.mock.calls.some(([input]) => String(input).includes(fragment))

describe('Show changes', () => {
  it('opens the changed entry’s comparison and returns focus to its button on Escape', async () => {
    const fetch = stubApi(['content/posts/hello'])
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    const button = await screen.findByTestId('entry-show-changes')
    expect(button.textContent).toBe('Show changes')
    expect(requested(fetch, 'main/changes/')).toBe(false)

    await userEvent.click(button)
    // The drawer replaces the skeleton drawer shown while its chunk loads.
    const summary = await screen.findByTestId('entry-changes-summary')
    await waitFor(() => expect(summary.textContent).toBe('2 fields changed since main'))
    const dialog = screen.getByRole('dialog', { name: 'Changes to Hello' })
    expect(requested(fetch, `/~main/changes/content/posts/hello?id=${hello.contentId}`)).toBe(true)
    expect(within(dialog).queryByTestId('entry-changes-unsaved')).toBeNull()

    await userEvent.keyboard('{Escape}')
    // Through the close transition the drawer keeps what it showed, with no skeleton.
    expect(dialog.isConnected).toBe(true)
    expect(within(dialog).queryByTestId('entry-changes-loading')).toBeNull()
    expect(within(dialog).getByTestId('entry-changes-summary')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it('says unsaved edits apply on save, on the line beside the undo controls', async () => {
    stubApi(['content/posts/hello'])
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.type(titleInput(), ' edited')
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    expect((await screen.findByTestId('entry-changes-all-undone')).textContent).toBe(
      'Unsaved edits, undos included, apply when you save.',
    )
    expect(screen.queryByTestId('entry-changes-unsaved')).toBeNull()
  })

  it('offers no "Open the entry" for the entry already open', async () => {
    stubApi(['content/posts/hello'], {
      status: 413,
      error: 'This entry is too large to compare here.',
    })
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    const refusal = await screen.findByTestId('entry-changes-tooLarge')
    expect(within(refusal).queryByRole('button', { name: 'Open the entry' })).toBeNull()
  })

  it('fetches nothing for a closed drawer when a save reloads the branch’s changes', async () => {
    const fetch = stubApi(['content/posts/hello'])
    const calls = (fragment: string) =>
      fetch.mock.calls.filter(([input]) =>
        new URL(String(input), 'http://localhost').pathname.endsWith(fragment),
      ).length
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    await screen.findByTestId('entry-changes-summary')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const entryReads = calls('/~main/changes/content/posts/hello')
    const listReads = calls('/~main/changes')

    await userEvent.type(titleInput(), ' edited')
    await userEvent.click(screen.getByTestId('save-button'))
    await waitFor(() => expect(calls('/~main/changes')).toBeGreaterThan(listReads))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls('/~main/changes/content/posts/hello')).toBe(entryReads)
  })

  it('returns focus to the rail’s Content button when the deleted entry’s row is gone', async () => {
    const fetch = stubApi([])
    const answered = fetch.getMockImplementation()!
    let deleted = [{ status: 'deleted', logicalPath: 'content/posts/gone' }]
    fetch.mockImplementation((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (new URL(url, 'http://localhost').pathname.endsWith('main/changes')) {
        return Promise.resolve(
          okJson({
            base: 'main',
            entries: deleted.map((e) => ({
              ...e,
              contentId: 'zzz999ZZZ999',
              collectionPath: 'content/posts',
              entryType: 'post',
              title: 'Gone',
            })),
            collections: [],
            hiddenChanges: false,
          }),
        )
      }
      return answered(input, init)
    })
    renderEditor({ dedupingInterval: 0, focusThrottleInterval: 0 })
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    const toggle = await screen.findByTestId('content-panel-toggle')
    if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle)
    await userEvent.click(await screen.findByRole('radio', { name: /^Changed/ }))
    const row = await screen.findByTestId('entry-nav-deleted-entry')
    await userEvent.click(row)
    const dialog = await screen.findByRole('dialog', { name: 'Changes to Gone' })

    // The list reloads without the entry, and its row goes with it.
    deleted = []
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(row.isConnected).toBe(false))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(dialog.isConnected).toBe(false))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('content-panel-toggle')),
    )
  })

  it('undoes a change into the form, as an unsaved edit', async () => {
    stubApi(['content/posts/hello'])
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    const undo = await screen.findByRole('button', { name: 'Undo change to Title' })
    await userEvent.click(undo)
    await waitFor(() => expect(undo.textContent).toBe('Redo change'))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(titleInput().value).toBe('Old title')
    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBeNull()
  })

  it('leaves nothing unsaved after a redo, its references as the form read them', async () => {
    stubApi(['content/posts/hello'])
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    const undo = await screen.findByTestId('entry-changes-undo-all')
    await userEvent.click(undo)
    await waitFor(() => expect(undo.textContent).toBe('Redo all changes'))
    await userEvent.click(undo)
    await waitFor(() => expect(undo.textContent).toBe('Undo all changes'))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(titleInput().value).toBe('Loaded title')
    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps undo disabled on a locked branch, giving the lock’s reason', async () => {
    stubApi(['content/posts/hello'], undefined, {
      branch: { status: 'submitted', writeBlocked: true },
    })
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    const undo = await screen.findByRole('button', { name: 'Undo change to Title' })
    expect(undo.getAttribute('aria-disabled')).toBe('true')
    await userEvent.hover(undo)
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'This branch is in review. Withdraw it to make changes.',
    )
    await userEvent.click(undo)
    expect(undo.textContent).toBe('Undo change')
  })

  it('closes the drawer before the delete confirm for an entry added on the branch', async () => {
    stubApi(['content/posts/hello'], undefined, { added: true })
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await userEvent.click(await screen.findByTestId('entry-show-changes'))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete entry' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Changes to Hello' })).toBeNull(),
    )
    const confirm = await screen.findByRole('dialog', { name: 'Delete entry' })
    // Focus stays in the confirm once the drawer has gone.
    await waitFor(() => expect(confirm.contains(document.activeElement)).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(confirm.contains(document.activeElement)).toBe(true)
    // Cancelled, focus goes to the entry menu's trigger, as for a delete from that menu.
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(confirm.isConnected).toBe(false))
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-testid')).toBe('file-dropdown-button'),
    )
  })

  describe('"Restore entry"', () => {
    /** The API with `gone` deleted on the branch, answering its restore with `restored`. */
    const stubDeleted = (
      restored: { status: number; body: unknown } | 'timeout' | 'lost',
      options: { noAdd?: boolean; listedAs?: string; listFails?: boolean } = {},
    ) => {
      const fetch = stubApi([])
      const answered = fetch.getMockImplementation()!
      let back = false
      fetch.mockImplementation((input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const path = plainBranchPath(new URL(url, 'http://localhost').pathname)
        if (path.endsWith('main/changes')) {
          return Promise.resolve(
            okJson({
              base: 'main',
              entries: back
                ? []
                : [
                    {
                      status: 'deleted',
                      logicalPath: 'content/posts/gone',
                      contentId: 'zzz999ZZZ999',
                      collectionPath: 'content/posts',
                      entryType: 'post',
                      title: 'Gone',
                    },
                  ],
              collections: [],
              hiddenChanges: false,
            }),
          )
        }
        if (path.includes('/main/changes/')) {
          return Promise.resolve(
            okJson({
              before: { format: 'json', entryType: 'post', data: { title: 'Gone' } },
              after: null,
              mergeBaseSha: 'a'.repeat(40),
            }),
          )
        }
        if (path.includes('/restore-entry/')) {
          if (restored === 'timeout' || restored === 'lost') {
            back = restored === 'timeout' || options.listedAs !== undefined
            return Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 }))
          }
          if (restored.status === 200) back = true
          return Promise.resolve(
            new Response(JSON.stringify(restored.body), {
              status: restored.status,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
        if (path.includes('/entries') && back && options.listFails) {
          return Promise.resolve(new Response('{}', { status: 500 }))
        }
        if (path.includes('/entries') && options.noAdd) {
          return answered(input, init).then(async (res) => {
            const body = await res.json()
            return okJson({
              ...body.data,
              collectionAccess: [{ logicalPath: 'content/posts', canAddEntry: false }],
            })
          })
        }
        if (path.includes('/entries') && back) {
          return answered(input, init).then(async (res) => {
            const body = await res.json()
            body.data.entries.push({
              ...body.data.entries[0],
              logicalPath: 'content/posts/gone',
              contentId: options.listedAs ?? 'zzz999ZZZ999',
              slug: 'gone',
              title: 'Gone',
              physicalPath: '/content/posts.abc123XYZ789/post.gone.zzz999ZZZ999.json',
            })
            return okJson(body.data)
          })
        }
        return answered(input, init)
      })
      return fetch
    }
    const openDeleted = async () => {
      renderEditor({ dedupingInterval: 0, focusThrottleInterval: 0 })
      await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
      const toggle = await screen.findByTestId('content-panel-toggle')
      if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle)
      await userEvent.click(await screen.findByRole('radio', { name: /^Changed/ }))
      await userEvent.click(await screen.findByTestId('entry-nav-deleted-entry'))
      return screen.findByRole('dialog', { name: 'Changes to Gone' })
    }

    it('puts the entry back, closes the drawer and opens it', async () => {
      const fetch = stubDeleted({
        status: 200,
        body: {
          ok: true,
          status: 200,
          data: { logicalPath: 'content/posts/gone', contentId: 'zzz999ZZZ999' },
        },
      })
      const dialog = await openDeleted()
      await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore entry' }))
      await waitFor(() => expect(dialog.isConnected).toBe(false))
      const call = fetch.mock.calls.find(([input]) => String(input).includes('/restore-entry/'))
      expect(String(call?.[0])).toContain('/~main/restore-entry/content/posts/gone')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ id: 'zzz999ZZZ999' })
      await waitFor(() => expect(screen.getByTestId('entry-header').textContent).toContain('Gone'))
    })

    it('keeps the drawer and says why when the server refuses', async () => {
      stubDeleted({
        status: 409,
        body: { ok: false, status: 409, error: "Another entry now has this entry's URL." },
      })
      const dialog = await openDeleted()
      await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore entry' }))
      const refused = await within(dialog).findByTestId('entry-changes-restore-refused')
      expect(refused.textContent).toBe("Another entry now has this entry's URL.")
      // A 409 loses nothing, so it is yellow.
      expect(refused.getAttribute('style')).toContain('yellow')
    })

    it('warns that an unanswered restore may have gone through while the entry isn’t listed', async () => {
      stubDeleted('lost')
      const dialog = await openDeleted()
      await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore entry' }))
      const refused = await within(dialog).findByTestId('entry-changes-restore-refused')
      expect(refused.textContent).toBe(
        'Restoring "Gone" may have gone through, but the server couldn’t confirm it. Check the "Content" panel for it before trying again.',
      )
      expect(refused.getAttribute('style')).toContain('yellow')
    })

    it('isn’t offered where the user can’t add entries, saying why', async () => {
      stubDeleted({ status: 200, body: {} }, { noAdd: true })
      const dialog = await openDeleted()
      expect(await within(dialog).findByTestId('entry-changes-no-edit')).toBeTruthy()
      expect(within(dialog).queryByRole('button', { name: 'Restore entry' })).toBeNull()
    })

    it('settles a restore whose write may have run by the entry list', async () => {
      stubDeleted({
        status: 409,
        body: { ok: false, status: 409, error: 'Lock lost.', code: 'WRITE_OUTCOME_UNKNOWN' },
      })
      const dialog = await openDeleted()
      await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore entry' }))
      expect(
        (await within(dialog).findByTestId('entry-changes-restore-refused')).textContent,
      ).toContain('may have gone through')
    })

    it('doesn’t take another entry at the path for an unanswered restore', async () => {
      stubDeleted('lost', { listedAs: 'yyy888YYY888' })
      const dialog = await openDeleted()
      await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore entry' }))
      expect(
        (await within(dialog).findByTestId('entry-changes-restore-refused')).textContent,
      ).toContain('may have gone through')
    })

    it('takes an answered restore as done when the list can’t be refreshed', async () => {
      stubDeleted(
        {
          status: 200,
          body: {
            ok: true,
            status: 200,
            data: { logicalPath: 'content/posts/gone', contentId: 'zzz999ZZZ999' },
          },
        },
        { listFails: true },
      )
      const dialog = await openDeleted()
      await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore entry' }))
      await waitFor(() => expect(dialog.isConnected).toBe(false))
      expect(
        await screen.findByText(
          '"Gone" is restored. Refresh the page to see it in the "Content" panel.',
        ),
      ).toBeTruthy()
    })

    it('treats an unanswered restore as done once the entry is listed', async () => {
      stubDeleted('timeout')
      const dialog = await openDeleted()
      await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore entry' }))
      await waitFor(() => expect(dialog.isConnected).toBe(false))
    })
  })

  it('isn’t offered on an entry the branch hasn’t changed', async () => {
    const fetch = stubApi([])
    renderEditor()
    await waitFor(() => expect(titleInput().value).toBe('Loaded title'))
    await waitFor(() => expect(requested(fetch, '/~main/changes')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTestId('entry-show-changes')).toBeNull()
    // Its slot is held, unseen, so the header doesn't shift between entries.
    expect(screen.getByTestId('entry-show-changes-pending').style.visibility).toBe('hidden')
  })
})
