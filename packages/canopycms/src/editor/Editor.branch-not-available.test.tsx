/**
 * A branch the branch list answered without (the bar's "Not available" row): the content panel
 * and the panes say the user has no access and offer Switch branch…, and its refused content load
 * is not toasted. Any other failed load keeps its toast, with the diagnostic behind "Details".
 */
import React from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SWRConfig } from 'swr'

import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { mockConsole } from '../test-utils/console-spy'

Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

const originalMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.matchMedia = originalMatchMedia
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const listing = (names: string[]) =>
  json({
    ok: true,
    status: 200,
    data: {
      branches: names.map((name) => ({
        name,
        status: 'editing',
        access: {},
        createdBy: 'user-1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        isProtected: false,
        readOnly: false,
        writeBlocked: false,
        submitBlocked: false,
      })),
      defaultBranch: 'main',
      users: [],
    },
  })

/** The branch list answers with `branchNames` once `branchesAnswered` resolves; the schema fails. */
const stubApi = ({
  branchNames,
  schemaFailure,
  branchesAnswered = Promise.resolve(),
}: {
  branchNames: string[]
  schemaFailure: { status: number; error: string }
  branchesAnswered?: Promise<void>
}) => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/whoami')) {
      return Promise.resolve(
        json({ ok: true, status: 200, data: { userId: 'user-1', groups: [] } }),
      )
    }
    if (url.endsWith('/api/canopycms/branches')) {
      return branchesAnswered.then(() => listing(branchNames))
    }
    if (url.includes('/schema') && !url.includes('/schema/')) {
      return Promise.resolve(
        json(
          { ok: false, status: schemaFailure.status, error: schemaFailure.error },
          schemaFailure.status,
        ),
      )
    }
    return Promise.resolve(json({ ok: true, status: 200, data: {} }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const stubWideWindow = () => {
  window.matchMedia = (query: string) =>
    ({
      matches: query === '(min-width: 64em)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

const renderEditor = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[]}
          title="Test Editor"
          branchName="main"
          operatingMode="dev"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

const barStatus = () => screen.findByTestId('branch-status')

/** The schema request has been answered, and the effects that follow it have run. */
const schemaAnswered = async (fetchMock: ReturnType<typeof stubApi>) => {
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/schema'))).toBe(true),
  )
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
}

const openContentPanel = async () => {
  await waitFor(() => expect(screen.getByTestId('content-panel-toggle')).toBeTruthy())
  if (!screen.queryByTestId('content-panel'))
    fireEvent.click(screen.getByTestId('content-panel-toggle'))
}

describe('a branch the list answered without', () => {
  it('says so in the content panel and the panes, offering Switch branch…, with no toast', async () => {
    stubWideWindow()
    const fetchMock = stubApi({
      branchNames: ['other'],
      schemaFailure: { status: 403, error: 'no_acl' },
    })
    renderEditor()
    await waitFor(async () => expect((await barStatus()).dataset.status).toBe('not-available'))
    await schemaAnswered(fetchMock)
    await openContentPanel()

    const panelNotice = await screen.findByTestId('entry-nav-branch-not-available')
    expect(panelNotice.textContent).toContain("You don't have access to this branch.")
    expect(screen.queryByText('No content')).toBeNull()

    const formNotice = screen.getByTestId('form-branch-not-available')
    expect(formNotice.textContent).toContain("You don't have access to this branch.")
    expect(screen.getByTestId('preview-branch-not-available').textContent).toBe(
      "You don't have access to this branch.",
    )
    expect(screen.queryByText('Select an item to start editing.')).toBeNull()

    expect(screen.queryByText('Could not load content')).toBeNull()
    expect(screen.queryByText(/no_acl/)).toBeNull()

    const save = screen.getByTestId('save-button')
    act(() => save.focus())
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      "You don't have access to this branch",
    )
  })

  it.each([
    ['content panel', 'entry-nav-branch-not-available'],
    ['form pane', 'form-branch-not-available'],
  ])("opens Branches from the %s's Switch branch…", async (_where, testId) => {
    stubWideWindow()
    stubApi({ branchNames: ['other'], schemaFailure: { status: 403, error: 'no_acl' } })
    renderEditor()
    await openContentPanel()
    const notice = await screen.findByTestId(testId)
    expect(screen.queryByRole('heading', { name: 'Branches' })).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: 'Switch branch…' }))
    await screen.findByRole('heading', { name: 'Branches' })
  })

  it('toasts nothing while the branch list is still loading, nor once it answers without', async () => {
    stubWideWindow()
    let answer = () => {}
    const fetchMock = stubApi({
      branchNames: ['other'],
      schemaFailure: { status: 403, error: 'no_acl' },
      branchesAnswered: new Promise<void>((resolve) => (answer = resolve)),
    })
    renderEditor()
    await schemaAnswered(fetchMock)
    expect((await barStatus()).dataset.status).toBe('loading')
    expect(screen.queryByText('Could not load content')).toBeNull()

    await act(async () => answer())
    await waitFor(async () => expect((await barStatus()).dataset.status).toBe('not-available'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(screen.queryByText('Could not load content')).toBeNull()
  })
})

describe('a failed content load on a listed branch', () => {
  it('keeps its error toast, with the raw diagnostic behind "Details"', async () => {
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    stubWideWindow()
    stubApi({ branchNames: ['main'], schemaFailure: { status: 502, error: 'Bad Gateway' } })
    renderEditor()

    await screen.findByText('Could not load content')
    expect(screen.getByText("The editor couldn't fetch this branch's entries.")).toBeTruthy()
    expect(screen.queryByText(/Schema fetch failed/)).toBeNull()
    const details = screen.getByRole('button', { name: 'Details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Schema fetch failed: 502 — Bad Gateway')).toBeTruthy()
    expect(screen.queryByTestId('entry-nav-branch-not-available')).toBeNull()
    expect(screen.queryByTestId('form-branch-not-available')).toBeNull()
    expect(consoleSpy).toHaveErrored(/502/)
  })
})
