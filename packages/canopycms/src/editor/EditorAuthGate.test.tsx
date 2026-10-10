import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import useSWR from 'swr'

import type { EditorSignInProps } from '../config'
import { createApiClient } from '../api/client'
import { ApiClientProvider, useApiClient } from './context'
import { EditorAuthGate } from './EditorAuthGate'
import { useUserContext } from './hooks/useUserContext'

// A fake CMS API behind the real client. Each test sets what whoami and every other endpoint
// answer; `html` simulates a 401 whose body is not JSON (e.g. from a proxy).
interface Reply {
  status: number
  body?: unknown
  html?: boolean
  networkError?: boolean
}
const signedInAs = (userId: string): Reply => ({
  status: 200,
  body: { ok: true, status: 200, data: { userId, groups: [] } },
})
const unauthorized: Reply = { status: 401, body: { ok: false, status: 401, error: 'Unauthorized' } }
const ok: Reply = { status: 200, body: { ok: true, status: 200, data: { branches: [] } } }
/** What the handler answers an editor bundle built for the other mode (editor-mode-check.ts). */
const modeMismatch = (editorMode: 'prod' | 'dev'): Reply => ({
  status: 412,
  body: {
    ok: false,
    status: 412,
    code: 'EDITOR_MODE_MISMATCH',
    error: `This editor was built for "${editorMode}" mode`,
  },
})
const unavailable: Reply = {
  status: 503,
  body: { ok: false, status: 503, error: 'Workspace unavailable' },
}

let whoamiReply: Reply
/** Answers for the next whoami calls, in order, before falling back to `whoamiReply`. */
let whoamiQueue: Reply[]
let otherReply: Reply
const calls = { whoami: 0, other: 0 }

const fetchMock = vi.fn(async (url: string) => {
  const isWhoami = new URL(url, 'http://localhost').pathname.endsWith('/whoami')
  if (isWhoami) calls.whoami++
  else calls.other++
  const reply = isWhoami ? (whoamiQueue.shift() ?? whoamiReply) : otherReply
  if (reply.networkError) throw new TypeError('Failed to fetch')
  return {
    status: reply.status,
    ok: reply.status < 400,
    json: async () => {
      if (reply.html) throw new SyntaxError('Unexpected token < in JSON')
      return reply.body
    },
  } as unknown as Response
})

beforeEach(() => {
  whoamiReply = signedInAs('alice')
  whoamiQueue = []
  otherReply = ok
  calls.whoami = 0
  calls.other = 0
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

let probeFetches = 0

/** Stands in for the editor: holds unsaved state, reads identity, fetches through SWR. */
function Probe() {
  const api = useApiClient()
  const { userContext, error } = useUserContext()
  const [draft, setDraft] = useState('')
  useSWR('probe:branches', () => {
    probeFetches++
    return api.branches.list()
  })
  return (
    <div>
      <span data-testid="probe-user">{userContext?.userId ?? 'none'}</span>
      <span data-testid="probe-error">{error ?? ''}</span>
      <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => void api.branches.list()}>call api</button>
    </div>
  )
}

function TestSignIn({ onSignedIn, sessionRejected }: EditorSignInProps) {
  return (
    <div>
      <span data-testid="rejected">{String(sessionRejected)}</span>
      <button onClick={onSignedIn}>report signed in</button>
    </div>
  )
}

/** Like ClerkSignIn when already signed in: reports once on mount, then offers nothing to click. */
function OneShotSignIn({ onSignedIn, sessionRejected }: EditorSignInProps) {
  const reported = React.useRef(false)
  React.useEffect(() => {
    if (reported.current) return
    reported.current = true
    onSignedIn()
  }, [onSignedIn])
  return <span data-testid="rejected">{String(sessionRejected)}</span>
}

function renderGate(
  props: {
    withSignIn?: boolean
    signIn?: React.ComponentType<EditorSignInProps>
    client?: ReturnType<typeof createApiClient>
    editorMode?: 'prod' | 'dev'
  } = {},
) {
  const { withSignIn = true, signIn = TestSignIn, client, editorMode } = props
  return render(
    <ApiClientProvider client={client} editorMode={editorMode}>
      <EditorAuthGate SignInComponent={withSignIn ? signIn : undefined} editorMode={editorMode}>
        <Probe />
      </EditorAuthGate>
    </ApiClientProvider>,
  )
}

describe('EditorAuthGate', () => {
  beforeEach(() => {
    probeFetches = 0
  })

  it('mounts the editor once the server accepts the session, sharing its one whoami', async () => {
    renderGate()
    expect(screen.getByTestId('canopy-auth-checking')).toBeTruthy()

    expect((await screen.findByTestId('probe-user')).textContent).toBe('alice')
    // findBy resolves on commit, before the editor's effects run; let them run before counting.
    await new Promise((resolve) => setTimeout(resolve, 20))
    // useUserContext read the gate's identity rather than fetching its own.
    expect(calls.whoami).toBe(1)
  })

  it('shows the sign-in screen instead of the editor on a 401, without mounting the editor', async () => {
    whoamiReply = unauthorized
    renderGate()

    await screen.findByTestId('canopy-sign-in-screen')
    expect(screen.getByTestId('rejected').textContent).toBe('false')
    expect(screen.queryByTestId('probe-user')).toBeNull()
    // The unmounted editor issued nothing.
    expect(calls.other).toBe(0)
  })

  it('mounts the editor after the provider reports sign-in and the server agrees', async () => {
    whoamiReply = unauthorized
    renderGate()
    await screen.findByTestId('canopy-sign-in-screen')

    whoamiReply = signedInAs('alice')
    fireEvent.click(screen.getByText('report signed in'))

    expect((await screen.findByTestId('probe-user')).textContent).toBe('alice')
    expect(screen.queryByTestId('canopy-sign-in-screen')).toBeNull()
  })

  it('reports sessionRejected instead of looping when the server still rejects after sign-in', async () => {
    whoamiReply = unauthorized
    renderGate()
    await screen.findByTestId('canopy-sign-in-screen')

    fireEvent.click(screen.getByText('report signed in'))

    await waitFor(() => expect(screen.getByTestId('rejected').textContent).toBe('true'))
    // One initial check, one re-check: nothing re-checks on its own.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.whoami).toBe(2)
    expect(screen.queryByTestId('probe-user')).toBeNull()
  })

  it('reports sessionRejected, not an error, when the re-check gets a non-JSON 401', async () => {
    // A proxy's 401 is still an auth answer: a provider must be able to offer sign-out.
    whoamiReply = unauthorized
    renderGate()
    await screen.findByTestId('canopy-sign-in-screen')

    whoamiReply = { status: 401, html: true }
    fireEvent.click(screen.getByText('report signed in'))

    await waitFor(() => expect(screen.getByTestId('rejected').textContent).toBe('true'))
    expect(screen.queryByTestId('canopy-auth-error')).toBeNull()
  })

  it('offers Retry when the re-check after sign-in fails, so a one-shot provider is not stranded', async () => {
    // ClerkSignIn reports once and then has nothing to click; the gate's Retry is the way out.
    whoamiQueue = [unauthorized, unavailable]
    whoamiReply = signedInAs('alice')
    renderGate({ signIn: OneShotSignIn })

    const retry = await screen.findByText('Retry')
    expect(calls.whoami).toBe(2)
    expect(screen.getByTestId('canopy-sign-in-screen')).toBeTruthy()
    expect(screen.queryByTestId('probe-user')).toBeNull()

    fireEvent.click(retry)
    expect((await screen.findByTestId('probe-user')).textContent).toBe('alice')
  })

  it('replaces an earlier Retry error with the rejection when a retried re-check 401s', async () => {
    whoamiReply = unauthorized
    renderGate()
    await screen.findByTestId('canopy-sign-in-screen')

    whoamiReply = { status: 0, networkError: true }
    fireEvent.click(screen.getByText('report signed in'))
    const retry = await screen.findByText('Retry')

    whoamiReply = unauthorized
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId('rejected').textContent).toBe('true'))
    expect(screen.queryByTestId('canopy-auth-error')).toBeNull()
  })

  it('falls back to a plain notice that re-checks instead of reloading', async () => {
    whoamiReply = unauthorized
    renderGate({ withSignIn: false })
    expect(await screen.findByText('Sign in required')).toBeTruthy()

    whoamiReply = signedInAs('alice')
    fireEvent.click(screen.getByText('Continue'))
    expect((await screen.findByTestId('probe-user')).textContent).toBe('alice')
  })

  it('treats a non-JSON 401 as signed out, not as a failure', async () => {
    whoamiReply = { status: 401, html: true }
    renderGate()

    await screen.findByTestId('canopy-sign-in-screen')
    expect(screen.queryByTestId('probe-user')).toBeNull()
    expect(screen.queryByTestId('canopy-auth-error')).toBeNull()
  })

  it('shows the error with Retry instead of mounting when whoami fails for a non-auth reason', async () => {
    whoamiReply = unavailable
    renderGate()

    expect((await screen.findByTestId('canopy-auth-error')).textContent).toContain(
      'Workspace unavailable',
    )
    expect(screen.queryByTestId('probe-user')).toBeNull()
    expect(calls.other).toBe(0)

    whoamiReply = signedInAs('alice')
    fireEvent.click(screen.getByText('Retry'))
    expect((await screen.findByTestId('probe-user')).textContent).toBe('alice')
  })

  it('keeps unsaved edits through a lapse when the first whoami had failed and been retried', async () => {
    // The editor only ever mounts under a known identity, so the same user signing back in is
    // never mistaken for a different one (which would remount it).
    whoamiReply = unavailable
    renderGate()
    whoamiReply = signedInAs('alice')
    fireEvent.click(await screen.findByText('Retry'))
    await screen.findByTestId('probe-user')
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unsaved edit' } })

    otherReply = unauthorized
    fireEvent.click(screen.getByText('call api'))
    await screen.findByTestId('canopy-sign-in-overlay')
    otherReply = ok
    fireEvent.click(screen.getByText('report signed in'))

    await waitFor(() => expect(screen.queryByTestId('canopy-sign-in-overlay')).toBeNull())
    expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('unsaved edit')
  })

  it("reaches the sign-in screen through whoami's result when the client is injected", async () => {
    // An injected client has no onUnauthorized wired, so only the result path can see the 401.
    whoamiReply = unauthorized
    renderGate({ client: createApiClient({ fetch: fetchMock as unknown as typeof fetch }) })

    await screen.findByTestId('canopy-sign-in-screen')
  })

  describe('when a session lapses mid-edit', () => {
    async function mountThenLapse() {
      renderGate()
      await screen.findByTestId('probe-user')
      fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unsaved edit' } })

      otherReply = unauthorized
      fireEvent.click(screen.getByText('call api'))
      await screen.findByTestId('canopy-sign-in-overlay')
    }

    it('overlays sign-in on the still-mounted editor, keeping unsaved state', async () => {
      await mountThenLapse()

      expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('unsaved edit')
      expect(screen.getByTestId('rejected').textContent).toBe('false')
    })

    it('keeps the editor and revalidates its data when the same user signs back in', async () => {
      await mountThenLapse()
      const fetchesBefore = probeFetches

      otherReply = ok
      fireEvent.click(screen.getByText('report signed in'))

      await waitFor(() => expect(screen.queryByTestId('canopy-sign-in-overlay')).toBeNull())
      expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('unsaved edit')
      await waitFor(() => expect(probeFetches).toBeGreaterThan(fetchesBefore))
    })

    it('remounts the editor when a different user signs in', async () => {
      await mountThenLapse()

      whoamiReply = signedInAs('bob')
      otherReply = ok
      fireEvent.click(screen.getByText('report signed in'))

      await waitFor(() => expect(screen.getByTestId('probe-user').textContent).toBe('bob'))
      expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('')
    })

    it('keeps the overlay up, with Retry, when the re-check fails for a non-auth reason', async () => {
      await mountThenLapse()
      whoamiReply = unavailable
      fireEvent.click(screen.getByText('report signed in'))

      expect(await screen.findByText('Retry')).toBeTruthy()
      expect(screen.getByTestId('canopy-sign-in-overlay')).toBeTruthy()
      expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('unsaved edit')
    })

    it('does not report a re-check network failure as a rejection when a background 401 lands', async () => {
      await mountThenLapse()
      whoamiReply = { status: 0, networkError: true }
      fireEvent.click(screen.getByText('report signed in'))
      // A request from the still-mounted editor 401s while that re-check is failing.
      fireEvent.click(screen.getByText('call api'))

      await screen.findByText('Retry')
      expect(screen.getByTestId('rejected').textContent).toBe('false')
    })

    it('keeps a rejection visible while the editor behind the overlay keeps getting 401s', async () => {
      await mountThenLapse()
      whoamiReply = unauthorized
      fireEvent.click(screen.getByText('report signed in'))
      await waitFor(() => expect(screen.getByTestId('rejected').textContent).toBe('true'))

      // A background request from the still-mounted editor 401s as well.
      fireEvent.click(screen.getByText('call api'))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(screen.getByTestId('rejected').textContent).toBe('true')
    })
  })

  describe('when the editor was built for the other mode than the server runs', () => {
    it('blocks with both modes and the build variable instead of offering sign-in', async () => {
      whoamiReply = modeMismatch('dev')
      renderGate({ editorMode: 'dev' })

      const notice = await screen.findByTestId('canopy-mode-mismatch')
      expect(notice.textContent).toContain('built for "dev" mode')
      expect(notice.textContent).toContain('runs in "prod" mode')
      expect(notice.textContent).toContain('NEXT_PUBLIC_CANOPY_MODE=prod')
      expect(screen.queryByTestId('canopy-sign-in-screen')).toBeNull()
      expect(screen.queryByText('Retry')).toBeNull()
      expect(screen.queryByTestId('probe-user')).toBeNull()
    })

    // An injected client reports nothing to the provider's signals, so this is the gate's own check.
    it('blocks from the whoami result alone with an injected client', async () => {
      whoamiReply = modeMismatch('dev')
      renderGate({ editorMode: 'dev', client: createApiClient({ editorMode: 'dev' }) })

      expect((await screen.findByTestId('canopy-mode-mismatch')).textContent).toContain(
        'NEXT_PUBLIC_CANOPY_MODE=prod',
      )
      expect(screen.queryByTestId('canopy-auth-error')).toBeNull()
    })

    it('mounts the editor when the server accepts its mode, having sent it', async () => {
      renderGate({ editorMode: 'prod' })

      expect((await screen.findByTestId('probe-user')).textContent).toBe('alice')
      expect(screen.queryByTestId('canopy-mode-mismatch')).toBeNull()
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(init.headers).toMatchObject({ 'x-canopy-editor-mode': 'prod' })
    })

    it('overlays a mounted editor when a later request is refused, keeping its edits', async () => {
      renderGate({ editorMode: 'dev' })
      await screen.findByTestId('probe-user')
      fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unsaved edit' } })

      otherReply = modeMismatch('dev')
      fireEvent.click(screen.getByText('call api'))

      expect((await screen.findByTestId('canopy-mode-mismatch')).textContent).toContain(
        'NEXT_PUBLIC_CANOPY_MODE=prod',
      )
      expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('unsaved edit')
    })
  })
})
