// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

interface FakeAuth {
  isLoaded: boolean
  isSignedIn: boolean | undefined
  getToken: ReturnType<typeof vi.fn>
  signOut: ReturnType<typeof vi.fn>
}
let auth: FakeAuth

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => auth,
  SignIn: (props: Record<string, unknown>) => (
    <div
      data-testid="clerk-sign-in"
      data-routing={String(props.routing)}
      data-redirect={String(props.forceRedirectUrl)}
      data-appearance={JSON.stringify(props.appearance ?? null)}
    />
  ),
}))

import { ClerkSignIn } from './ClerkSignIn'

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

beforeEach(() => {
  auth = {
    isLoaded: true,
    isSignedIn: false,
    getToken: vi.fn(async () => 'fresh-token'),
    signOut: vi.fn(async () => undefined),
  }
  window.history.replaceState(null, '', '/edit?branch=main#/factor-one')
})

afterEach(() => {
  cleanup()
})

describe('ClerkSignIn', () => {
  it("renders Clerk's sign-in, returning to this page (not Clerk's default '/')", () => {
    render(<ClerkSignIn onSignedIn={vi.fn()} sessionRejected={false} />)

    const signIn = screen.getByTestId('clerk-sign-in')
    expect(signIn.dataset.routing).toBe('hash')
    expect(signIn.dataset.redirect).toBe('http://localhost:3000/edit?branch=main')
  })

  it('waits for Clerk to load before showing or reporting anything', async () => {
    auth.isLoaded = false
    const onSignedIn = vi.fn()
    render(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected={false} />)
    await flush()

    expect(screen.getByText('Loading sign-in…')).toBeTruthy()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('reports once when the user completes sign-in, only after a fresh token is minted', async () => {
    let resolveToken: (token: string) => void = () => undefined
    auth.getToken = vi.fn(() => new Promise<string>((resolve) => (resolveToken = resolve)))
    const onSignedIn = vi.fn()
    const { rerender } = render(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected={false} />)

    auth.isSignedIn = true
    rerender(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected={false} />)
    await flush()
    // Minting the token is what writes __session; the editor must not re-check before it.
    expect(auth.getToken).toHaveBeenCalledWith({ skipCache: true })
    expect(onSignedIn).not.toHaveBeenCalled()

    resolveToken('fresh-token')
    await flush()
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('reports once when already signed in on display (a lapsed token)', async () => {
    auth.isSignedIn = true
    const onSignedIn = vi.fn()
    render(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected={false} />)
    await flush()

    expect(auth.getToken).toHaveBeenCalledTimes(1)
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Checking your session…')).toBeTruthy()
  })

  it('does not report again once the CMS rejects the session — no loop', async () => {
    auth.isSignedIn = true
    const onSignedIn = vi.fn()
    const { rerender } = render(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected={false} />)
    await flush()
    expect(onSignedIn).toHaveBeenCalledTimes(1)

    rerender(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected />)
    await flush()

    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain('did not accept your session')
  })

  it('offers sign-out, back to this page, when shown already rejected', async () => {
    auth.isSignedIn = true
    const onSignedIn = vi.fn()
    render(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected />)
    await flush()

    expect(onSignedIn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Sign out'))
    expect(auth.signOut).toHaveBeenCalledWith({
      redirectUrl: 'http://localhost:3000/edit?branch=main',
    })
  })

  it('reports again after a rejected user signs out and back in', async () => {
    auth.isSignedIn = true
    const onSignedIn = vi.fn()
    const { rerender } = render(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected />)
    await flush()

    auth.isSignedIn = false
    rerender(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected />)
    expect(screen.getByTestId('clerk-sign-in')).toBeTruthy()

    auth.isSignedIn = true
    rerender(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected />)
    await flush()
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('still reports when minting the token fails, so the editor can decide', async () => {
    auth.isSignedIn = true
    auth.getToken = vi.fn(async () => {
      throw new Error('network')
    })
    const onSignedIn = vi.fn()
    render(<ClerkSignIn onSignedIn={onSignedIn} sessionRejected={false} />)
    await flush()

    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('passes signInProps through but keeps routing and the return URL fixed', () => {
    render(
      <ClerkSignIn
        onSignedIn={vi.fn()}
        sessionRejected={false}
        // The type forbids `routing`/redirects here; a cast (or plain JS) must still not win.
        signInProps={
          {
            appearance: { variables: { colorPrimary: 'red' } },
            routing: 'path',
            forceRedirectUrl: '/',
          } as React.ComponentProps<typeof ClerkSignIn>['signInProps']
        }
      />,
    )

    const signIn = screen.getByTestId('clerk-sign-in')
    expect(JSON.parse(signIn.dataset.appearance ?? 'null')).toEqual({
      variables: { colorPrimary: 'red' },
    })
    expect(signIn.dataset.routing).toBe('hash')
    expect(signIn.dataset.redirect).toBe('http://localhost:3000/edit?branch=main')
  })
})
