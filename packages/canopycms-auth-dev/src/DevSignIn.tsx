'use client'

import { Alert, Paper, Stack, Text, Title } from '@mantine/core'
import type { EditorSignInProps } from 'canopycms/client'
import { setDevUserCookie } from './cookie-utils'
import { DevUserList } from './DevUserList'

/** Dev auth's sign-in screen: pick a user. The server reads the cookie per request, so no reload. */
export function DevSignIn({ onSignedIn, sessionRejected }: EditorSignInProps) {
  const signInAs = (userId: string) => {
    setDevUserCookie(userId)
    onSignedIn()
  }

  return (
    <Paper withBorder p="xl" radius="md" maw={480}>
      <Stack gap="sm">
        <Title order={3}>Sign in (development)</Title>
        <Text size="sm" c="dimmed">
          Dev auth has no passwords: choose who to sign in as.
        </Text>
        {sessionRejected && (
          <Alert color="red" title="Not accepted">
            The CMS rejected that user. A dev auth plugin configured with custom users only accepts
            those users.
          </Alert>
        )}
        <DevUserList onSelect={signInAs} />
      </Stack>
    </Paper>
  )
}
