'use client'

/**
 * EditorAuthGate — decides, from the SERVER, whether the editor below it may mount.
 *
 * A 401 from the CMS API is the only signed-out signal trusted: the API accepts or rejects every
 * request, and client-side auth state (Clerk's `isSignedIn`, a dev cookie) can disagree with it.
 *
 * - The editor mounts only once `whoami` succeeds, so it always belongs to a known identity. A
 *   401 first shows the provider's `SignInComponent` full-screen; any other failure shows the
 *   error with Retry. The editor's first requests therefore wait one `whoami` round trip.
 * - After mount, a 401 from ANY request overlays the sign-in UI on the still-mounted editor, so
 *   unsaved edits survive re-authentication. The request that 401'd is not retried.
 * - Re-authenticating as the same user keeps the editor and revalidates its SWR cache; as a
 *   different user the editor and its cache remount, because the SWRProvider is keyed by user id.
 * - A re-check that fails for a non-auth reason keeps the sign-in UI up with the error and Retry,
 *   so a provider that has already reported sign-in is never left waiting on nothing.
 * - A response refusing the editor's mode (`EDITOR_MODE_MISMATCH`, see
 *   operating-mode/editor-mode-check.ts) blocks for good, with no Retry: only a rebuild fixes it.
 *   The server answers it before auth, so `whoami` meets it before any sign-in UI.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { Alert, Button, Center, Loader, Modal, Paper, Stack, Text, Title } from '@mantine/core'
import { useSWRConfig } from 'swr'

import type { EditorSignInProps } from '../config'
import { getErrorMessage } from '../utils/error'
import { editorModeMismatchMessage } from '../operating-mode/editor-mode-check'
import type { OperatingMode } from '../operating-mode/types'
import type { UserContext } from './BranchManager'
import {
  useApiClient,
  useOnEditorModeMismatch,
  useOnUnauthorized,
} from './context/ApiClientContext'
import { EditorIdentityContext, type EditorIdentity } from './context/EditorIdentityContext'
import { SWRProvider } from './context/SWRProvider'
import { CanopyCMSProvider, type CanopyThemeOptions } from './theme'

type GatePhase = 'checking' | 'signed-in' | 'signed-out' | 'error'

interface GateState {
  phase: GatePhase
  /** The identity the mounted editor belongs to. Set before the editor first mounts, never cleared. */
  user: UserContext | undefined
  sessionRejected: boolean
  /** The last non-auth `whoami` failure: the whole screen in 'error', a Retry line in 'signed-out'. */
  error: string | undefined
  /** Increments each time the server re-accepts a session after a 401. */
  reauthCount: number
  /** Set once the server refuses the editor's mode; never cleared. */
  modeMismatch: boolean
}

type GateAction =
  | { type: 'accepted'; user: UserContext }
  | { type: 'unauthorized'; afterSignIn: boolean }
  | { type: 'failed'; error: string }
  | { type: 'retry' }
  | { type: 'modeMismatch' }

const initialGateState: GateState = {
  phase: 'checking',
  user: undefined,
  sessionRejected: false,
  error: undefined,
  reauthCount: 0,
  modeMismatch: false,
}

function gateReducer(state: GateState, action: GateAction): GateState {
  switch (action.type) {
    case 'modeMismatch':
      return state.modeMismatch ? state : { ...state, modeMismatch: true }
    case 'accepted':
      return {
        ...state,
        phase: 'signed-in',
        user: action.user,
        sessionRejected: false,
        error: undefined,
        reauthCount: state.phase === 'signed-out' ? state.reauthCount + 1 : state.reauthCount,
      }
    case 'unauthorized': {
      // Sticky while signed out: the mounted editor keeps making requests behind the overlay,
      // they 401 too, and they must not clear a rejection the provider is showing.
      const sessionRejected =
        (state.phase === 'signed-out' && state.sessionRejected) || action.afterSignIn
      // A re-check's own 401 supersedes an earlier failure; a background 401 does not.
      const error = action.afterSignIn ? undefined : state.error
      const unchanged =
        state.phase === 'signed-out' &&
        sessionRejected === state.sessionRejected &&
        error === state.error
      return unchanged ? state : { ...state, phase: 'signed-out', sessionRejected, error }
    }
    case 'failed':
      if (state.phase === 'signed-in') return state
      return {
        ...state,
        phase: state.phase === 'checking' ? 'error' : state.phase,
        error: action.error,
      }
    case 'retry':
      return state.phase === 'error' ? { ...state, phase: 'checking', error: undefined } : state
  }
}

export interface EditorAuthGateProps {
  children: React.ReactNode
  /** The auth provider's sign-in UI. Absent, a plain "sign in, then continue" notice is shown. */
  SignInComponent?: React.ComponentType<EditorSignInProps>
  /** The editor's theme, so the gate's own screens match it. */
  themeOptions?: CanopyThemeOptions
  /** The mode this bundle was built for, named by the mode-mismatch screen. */
  editorMode?: OperatingMode
}

export function EditorAuthGate({
  children,
  SignInComponent,
  themeOptions,
  editorMode,
}: EditorAuthGateProps) {
  const apiClient = useApiClient()
  const [state, dispatch] = useReducer(gateReducer, initialGateState)

  const handleUnauthorized = useCallback(() => {
    dispatch({ type: 'unauthorized', afterSignIn: false })
  }, [])
  useOnUnauthorized(handleUnauthorized)

  const handleModeMismatch = useCallback(() => {
    dispatch({ type: 'modeMismatch' })
  }, [])
  useOnEditorModeMismatch(handleModeMismatch)

  const check = useCallback(
    async (afterSignIn: boolean) => {
      try {
        const result = await apiClient.user.whoami()
        if (result.code === 'EDITOR_MODE_MISMATCH') {
          dispatch({ type: 'modeMismatch' })
        } else if (result.ok && result.data) {
          dispatch({
            type: 'accepted',
            user: { userId: result.data.userId, groups: result.data.groups },
          })
        } else if (result.status === 401) {
          dispatch({ type: 'unauthorized', afterSignIn })
        } else {
          dispatch({ type: 'failed', error: result.error ?? 'Failed to load user context' })
        }
      } catch (err) {
        // Only non-auth failures land here: the client returns every 401 as a result.
        dispatch({ type: 'failed', error: getErrorMessage(err) })
      }
    },
    [apiClient],
  )

  useEffect(() => {
    void check(false)
  }, [check])

  const onSignedIn = useCallback(() => {
    void check(true)
  }, [check])

  const retryInitial = useCallback(() => {
    dispatch({ type: 'retry' })
    void check(false)
  }, [check])

  const identity = useMemo<EditorIdentity | null>(
    () => (state.user ? { user: state.user } : null),
    [state.user],
  )

  const signIn = (
    <>
      {state.phase === 'signed-out' && state.error && (
        <RetryNotice
          title="Couldn't confirm your sign-in"
          error={state.error}
          onRetry={onSignedIn}
        />
      )}
      {SignInComponent ? (
        <SignInComponent onSignedIn={onSignedIn} sessionRejected={state.sessionRejected} />
      ) : (
        <DefaultSignedOutNotice onSignedIn={onSignedIn} sessionRejected={state.sessionRejected} />
      )}
    </>
  )

  const modeMismatchNotice = state.modeMismatch && <ModeMismatchNotice editorMode={editorMode} />

  if (!state.user || !identity) {
    if (modeMismatchNotice) {
      return (
        <CanopyCMSProvider {...themeOptions} withNotifications={false}>
          <Center mih="100vh" p="md">
            {modeMismatchNotice}
          </Center>
        </CanopyCMSProvider>
      )
    }
    return (
      <CanopyCMSProvider {...themeOptions} withNotifications={false}>
        <Center mih="100vh" p="md">
          {state.phase === 'signed-out' ? (
            <Stack align="center" gap="md" data-testid="canopy-sign-in-screen">
              {signIn}
            </Stack>
          ) : state.phase === 'error' ? (
            <RetryNotice
              title="Couldn't load the editor"
              error={state.error ?? 'Unknown error'}
              onRetry={retryInitial}
            />
          ) : (
            <Stack align="center" gap="xs" data-testid="canopy-auth-checking">
              <Loader />
              <Text size="sm" c="dimmed">
                Checking sign-in…
              </Text>
            </Stack>
          )}
        </Center>
      </CanopyCMSProvider>
    )
  }

  return (
    <EditorIdentityContext.Provider value={identity}>
      <SWRProvider key={state.user.userId}>
        <RevalidateOnReauth reauthCount={state.reauthCount} />
        {children}
      </SWRProvider>
      {modeMismatchNotice && (
        <CanopyCMSProvider {...themeOptions} withNotifications={false}>
          <Modal
            opened
            onClose={keepOpen}
            withCloseButton={false}
            closeOnClickOutside={false}
            closeOnEscape={false}
            centered
            size="lg"
          >
            {modeMismatchNotice}
          </Modal>
        </CanopyCMSProvider>
      )}
      {!modeMismatchNotice && state.phase === 'signed-out' && (
        // The editor's own MantineProvider is inside <Editor>, so the overlay brings its own.
        // Notifications stay with the editor's provider; a second container would duplicate them.
        <CanopyCMSProvider {...themeOptions} withNotifications={false}>
          <Modal
            opened
            onClose={keepOpen}
            withCloseButton={false}
            closeOnClickOutside={false}
            closeOnEscape={false}
            centered
            title="Sign in to continue"
          >
            <Stack gap="md" data-testid="canopy-sign-in-overlay">
              <Text size="sm">
                Your session has ended. Unsaved edits stay in place if you sign back in as the same
                user.
              </Text>
              {signIn}
            </Stack>
          </Modal>
        </CanopyCMSProvider>
      )}
    </EditorIdentityContext.Provider>
  )
}

/** The sign-in overlay closes only when the server accepts a session again; the mode one never. */
function keepOpen(): void {}

/** Blocking, with no Retry: the editor bundle itself is wrong, so only a rebuild helps. */
function ModeMismatchNotice({ editorMode }: { editorMode: OperatingMode | undefined }) {
  return (
    <Alert
      color="red"
      title="This editor doesn't match its CMS server"
      maw={560}
      data-testid="canopy-mode-mismatch"
    >
      <Text size="sm">
        {editorMode
          ? editorModeMismatchMessage(editorMode)
          : 'This editor was built for a different mode than the CMS server runs, so signing in ' +
            'cannot work. Whoever deploys this site needs to rebuild the editor with ' +
            'NEXT_PUBLIC_CANOPY_MODE set to the server mode at build time.'}
      </Text>
    </Alert>
  )
}

/**
 * Revalidates every SWR key when the same identity is re-accepted. `revalidateOnFocus` is off
 * (see SWRProvider), so without this the data that 401'd behind the overlay would stay stale.
 * A different identity remounts the SWRProvider instead, and this with it.
 */
function RevalidateOnReauth({ reauthCount }: { reauthCount: number }) {
  const { mutate } = useSWRConfig()
  const seen = useRef(reauthCount)
  useEffect(() => {
    if (seen.current === reauthCount) return
    seen.current = reauthCount
    // Each data hook surfaces its own fetch error; nothing to add here.
    mutate(() => true).catch(() => undefined)
  }, [reauthCount, mutate])
  return null
}

function RetryNotice(props: { title: string; error: string; onRetry: () => void }) {
  return (
    <Alert color="red" title={props.title} maw={480} data-testid="canopy-auth-error">
      <Stack gap="xs" align="flex-start">
        <Text size="sm">{props.error}</Text>
        <Button size="xs" variant="light" onClick={props.onRetry}>
          Retry
        </Button>
      </Stack>
    </Alert>
  )
}

/** Re-checks rather than reloading: in the overlay, a reload would discard the unsaved edits. */
function DefaultSignedOutNotice({ onSignedIn, sessionRejected }: EditorSignInProps) {
  return (
    <Paper withBorder p="xl" radius="md" maw={420}>
      <Stack gap="sm">
        <Title order={3}>Sign in required</Title>
        <Text size="sm">
          You are not signed in to the CMS. Sign in through this site&apos;s auth provider, then
          continue.
        </Text>
        {sessionRejected && (
          <Text size="sm" c="red">
            Still not signed in.
          </Text>
        )}
        <Button onClick={onSignedIn}>Continue</Button>
      </Stack>
    </Paper>
  )
}
