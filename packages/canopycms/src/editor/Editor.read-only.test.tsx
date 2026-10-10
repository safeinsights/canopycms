/**
 * On a locked branch the editor writes no draft, whatever the form emits, and a draft kept from
 * earlier is announced rather than shown as the form's value.
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { modals } from '@mantine/modals'

// See FormRenderer.test.tsx: preloading MarkdownField's lazy chunk keeps mount timing honest.
import '@mdxeditor/editor'

import type { EntrySchema } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

// Lets a test reach the draft writer past FormRenderer's own gate: emit on mount, ignoring
// `readOnly`, or keep the latest `onChange`, as an async field callback holds it.
const formStub = vi.hoisted(() => ({
  emitOnMount: undefined as Record<string, unknown> | undefined,
  latestOnChange: undefined as ((next: Record<string, unknown>) => void) | undefined,
}))
vi.mock('./FormRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./FormRenderer')>()
  const { createElement, useEffect } = await import('react')
  const FormRenderer: typeof actual.FormRenderer = (props) => {
    formStub.latestOnChange = props.onChange
    useEffect(() => {
      if (formStub.emitOnMount) props.onChange(formStub.emitOnMount)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
    }, [])
    return createElement(actual.FormRenderer, props)
  }
  return { ...actual, FormRenderer }
})

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn() } }
})

afterEach(() => {
  formStub.emitOnMount = undefined
  formStub.latestOnChange = undefined
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const CONTENT_ID = 'def456ABC123'
const entryApiPath = '/api/canopycms/main/content/content/posts/hello'
const schema: EntrySchema = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'body', type: 'markdown', label: 'Body', isBody: true },
]
const entry: EditorEntry = {
  path: unsafeAsLogicalPath('content/posts/hello'),
  contentId: unsafeAsContentId(CONTENT_ID),
  label: 'Hello',
  status: 'entry',
  schema,
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug: 'hello',
  format: 'md',
  type: 'entry',
}

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const protectedMain = {
  name: 'main',
  status: 'editing',
  access: {},
  createdBy: 'canopycms-system',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  isProtected: true,
  readOnly: true,
  writeBlocked: true,
}

/**
 * `branches` undefined leaves the branch list unanswered, the fail-closed loading window; a
 * function answers each fetch afresh.
 */
const stubApi = (branches: unknown[] | undefined | (() => unknown[])) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        return branches === undefined
          ? new Promise<Response>(() => {})
          : Promise.resolve(
              okJson({
                branches: typeof branches === 'function' ? branches() : branches,
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
                format: 'md',
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
                contentId: CONTENT_ID,
                collectionPath: entry.collectionPath,
                collectionName: entry.collectionName,
                slug: entry.slug,
                format: entry.format,
                entryType: 'post',
                physicalPath: '/content/posts.abc123XYZ789/post.hello.def456ABC123.md',
                exists: true,
              },
            ],
            pagination: { hasMore: false, limit: 50 },
          }),
        )
      }
      if (url === entryApiPath && (!init?.method || init.method === 'GET')) {
        // A list MDXEditor re-serialises on mount ("*" becomes "-").
        return Promise.resolve(
          okJson({ title: 'Loaded title', body: '* one\n* two\n', version: 100 }),
        )
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
          entries={[entry]}
          initialSelectedId={entry.path}
          title="Test Editor"
          branchName="main"
          operatingMode="prod"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const persistedDrafts = (): Record<string, unknown> => {
  const raw = window.localStorage.getItem('canopycms:drafts:main')
  return raw ? (JSON.parse(raw) as { drafts: Record<string, unknown> }).drafts : {}
}

const seedDraft = () =>
  window.localStorage.setItem(
    'canopycms:drafts:main',
    JSON.stringify({
      v: 2,
      drafts: { [CONTENT_ID]: { title: 'Draft title', body: '* one\n* two\n' } },
      baseVersions: { [CONTENT_ID]: 100 },
    }),
  )

const titleInput = async (): Promise<HTMLInputElement> => {
  let input: HTMLInputElement | null = null
  await waitFor(() => {
    input = screen.queryByRole('textbox', { name: 'Title' }) as HTMLInputElement | null
    expect(input?.value).toBe('Loaded title')
  })
  return input!
}

describe('Editor on a read-only branch', () => {
  it('writes no draft from typing or from the markdown editor mounting', async () => {
    stubApi([protectedMain])
    const { container } = renderEditor()
    await waitFor(() => expect(screen.getByTestId('protected-branch-banner')).toBeTruthy())

    const input = await titleInput()
    expect(input.readOnly).toBe(true)
    fireEvent.change(input, { target: { value: 'Typed title' } })

    await waitFor(() => {
      expect(container.querySelector('.canopy-mdx-content')?.getAttribute('contenteditable')).toBe(
        'false',
      )
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(persistedDrafts()).not.toHaveProperty(CONTENT_ID)
    expect(input.value).toBe('Loaded title')
    expect(screen.queryByTestId('unsaved-indicator')).toBeNull()
  })

  it('drops whatever the form emits, so a field that ignores readOnly still writes no draft', async () => {
    formStub.emitOnMount = { title: 'Emitted title', body: '' }
    stubApi([protectedMain])
    renderEditor()

    await titleInput()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(persistedDrafts()).not.toHaveProperty(CONTENT_ID)
  })

  it('drops an edit that lands after the branch locks, from a callback made while it was open', async () => {
    const editingMain = {
      ...protectedMain,
      isProtected: false,
      readOnly: false,
      writeBlocked: false,
    }
    let branchFetches = 0
    stubApi(() =>
      ++branchFetches === 1
        ? [editingMain]
        : [{ ...editingMain, status: 'submitted', writeBlocked: true }],
    )
    renderEditor()
    await titleInput()
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('readOnly', false),
    )
    const staleOnChange = formStub.latestOnChange

    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))
    await waitFor(() => expect(screen.getByTestId('status-locked-banner')).toBeTruthy())

    act(() => staleOnChange?.({ title: 'Late upload', body: '' }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(persistedDrafts()).not.toHaveProperty(CONTENT_ID)
  })

  it('shows the saved content and a notice for a draft kept from earlier, until it is discarded', async () => {
    seedDraft()
    stubApi([protectedMain])
    renderEditor()

    await titleInput()
    await waitFor(() => expect(screen.getByTestId('read-only-draft-notice')).toBeTruthy())
    expect(persistedDrafts()).toHaveProperty(CONTENT_ID)

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    const confirm = vi.mocked(modals.openConfirmModal).mock.calls.at(-1)?.[0]
    expect(confirm?.title).toBe('Discard draft')
    act(() => confirm?.onConfirm?.())

    await waitFor(() => expect(screen.queryByTestId('read-only-draft-notice')).toBeNull())
    expect(persistedDrafts()).not.toHaveProperty(CONTENT_ID)
  })

  it('raises no notice while the branch list is still loading, though the form is locked', async () => {
    seedDraft()
    stubApi(undefined)
    renderEditor()

    const input = await titleInput()
    expect(input.readOnly).toBe(true)
    expect(screen.queryByTestId('read-only-draft-notice')).toBeNull()
    expect(persistedDrafts()).toHaveProperty(CONTENT_ID)
  })
})
