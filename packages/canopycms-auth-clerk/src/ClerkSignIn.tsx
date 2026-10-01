'use client'

import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { SignIn, useAuth } from '@clerk/nextjs'
import type { EditorSignInProps } from 'canopycms/client'

type ClerkSignInComponentProps = ComponentProps<typeof SignIn>

export interface ClerkSignInProps extends EditorSignInProps {
  /** Passed to Clerk's `<SignIn>`; `routing` and the redirect URLs stay fixed to this page. */
  signInProps?: Omit<
    ClerkSignInComponentProps,
    'routing' | 'path' | 'forceRedirectUrl' | 'signUpForceRedirectUrl'
  >
}

/**
 * The editor's Clerk sign-in (`editor.SignInComponent`), publishable key only. Reports sign-in
 * once per piece of evidence, never in a loop: on completing `<SignIn>`, or on being shown while
 * already signed in unless the CMS has rejected the session, when it offers sign-out instead.
 *
 * The fresh token is awaited before reporting because minting it writes `__session`: clerk-js
 * (6.36.0, CDN-loaded) emits `token:update` and its cookie service writes the cookie from that.
 */
export function ClerkSignIn({ onSignedIn, sessionRejected, signInProps }: ClerkSignInProps) {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth()
  const previousSignedIn = useRef<boolean | undefined>(undefined)
  // Return here after sign-in/out; Clerk's default "/" leaves the editor. Client-side only.
  const [returnUrl] = useState(() =>
    typeof window === 'undefined' ? undefined : window.location.href.split('#')[0],
  )

  useEffect(() => {
    if (!isLoaded) return
    const previous = previousSignedIn.current
    previousSignedIn.current = isSignedIn
    if (!isSignedIn) return
    const justSignedIn = previous === false
    const signedInWhenShown = previous === undefined && !sessionRejected
    if (!justSignedIn && !signedInWhenShown) return
    // Not cancelled on cleanup: a dropped re-check would strand the user on "Checking".
    void getToken({ skipCache: true })
      .catch(() => null)
      .finally(onSignedIn)
  }, [isLoaded, isSignedIn, sessionRejected, getToken, onSignedIn])

  if (!isLoaded) {
    return <p>Loading sign-in…</p>
  }

  if (!isSignedIn) {
    return (
      <SignIn
        {...signInProps}
        routing="hash"
        forceRedirectUrl={returnUrl}
        signUpForceRedirectUrl={returnUrl}
      />
    )
  }

  if (sessionRejected) {
    return (
      <div role="alert" style={{ maxWidth: 420 }}>
        <p>
          You are signed in, but the CMS did not accept your session. This usually means the
          server&apos;s Clerk verification key (<code>CLERK_JWT_KEY</code>) or authorized parties do
          not match this Clerk instance.
        </p>
        <button type="button" onClick={() => void signOut({ redirectUrl: returnUrl })}>
          Sign out
        </button>
      </div>
    )
  }

  return <p>Checking your session…</p>
}
