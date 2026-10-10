'use client'

import React from 'react'

import { Button, Center, Group, Paper, Stack, Text, Title } from '@mantine/core'
import { IconAlertTriangle, IconArrowLeft, IconRefresh } from '@tabler/icons-react'

import { CanopyCMSProvider, type CanopyThemeOptions } from '../theme'
import { CopyErrorDetailsButton, EditorErrorBoundary } from './EditorErrorBoundary'

/**
 * The editor's URL opening no entry, keeping the branch: an empty `entry` shows the navigator
 * rather than the first entry, which may be the one that crashed.
 * @internal Exported for tests.
 */
export const entriesUrl = (href: string): string => {
  const url = new URL(href)
  url.searchParams.set('entry', '')
  return url.toString()
}

/**
 * The last resort when the editor itself throws while rendering. It brings its own theme
 * provider, the editor's having gone with the crash. Edits made before the crash are in the
 * browser's draft store, so a reload offers them; the edit whose render crashed is not.
 */
export const EditorCrashBoundary: React.FC<{
  themeOptions?: CanopyThemeOptions
  children: React.ReactNode
}> = ({ themeOptions, children }) => (
  <EditorErrorBoundary
    context={{ boundary: 'editor' }}
    fallback={(caught) => (
      <CanopyCMSProvider {...themeOptions} withNotifications={false}>
        <Center mih="100vh" p="md" data-testid="editor-crash-screen">
          <Paper withBorder p="xl" maw={560}>
            <Stack gap="md">
              <Group gap="sm">
                <IconAlertTriangle size={24} color="var(--mantine-color-red-6)" />
                <Title order={3}>The editor stopped working</Title>
              </Group>
              <Text size="sm">
                Something went wrong while showing this page. Unsaved changes made before the error
                are kept in this browser and come back when the editor opens again.
              </Text>
              <Text size="sm">
                Reload to try again. If it happens again on the same entry, go back to the list of
                entries and copy the error details for whoever looks after the site.
              </Text>
              <Group gap="sm">
                <Button
                  size="sm"
                  leftSection={<IconRefresh size={16} />}
                  onClick={() => window.location.reload()}
                >
                  Reload
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  leftSection={<IconArrowLeft size={16} />}
                  onClick={() => window.location.assign(entriesUrl(window.location.href))}
                >
                  Back to entries
                </Button>
                <CopyErrorDetailsButton caught={caught} size="sm" />
              </Group>
            </Stack>
          </Paper>
        </Center>
      </CanopyCMSProvider>
    )}
  >
    {children}
  </EditorErrorBoundary>
)
