'use client'

/**
 * The "Show changes" drawer as Editor.tsx mounts it: loaded on first open with `React.lazy`, so
 * the diff model and jsdiff stay out of the editor's first chunk, and behind an error boundary,
 * so a chunk that fails to load or a comparison that throws costs the drawer, not the editor.
 */

import React, { Suspense, useState } from 'react'
import { Alert, Button, Stack, Text } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import { OverlayDrawer } from '../shell/OverlayHeader'
import { focusReturnProps } from '../utils/focus-return'
import { EditorErrorBoundary } from './EditorErrorBoundary'
import { LoadingCards, LoadingSummary } from './EntryChangesSkeleton'
import type { EntryChangesDrawerProps } from './EntryChangesDrawer'

type DrawerModule = { default: React.ComponentType<EntryChangesDrawerProps> }

const loadDrawer = (): Promise<DrawerModule> =>
  import('./EntryChangesDrawer').then((m) => ({ default: m.EntryChangesDrawer }))

export interface LazyEntryChangesDrawerProps extends EntryChangesDrawerProps {
  /** @internal The chunk's loader, for tests. */
  load?: () => Promise<DrawerModule>
}

/**
 * Which opening this is, and the lazy component it renders. `React.lazy` keeps a rejected
 * import for good, so an opening after a failure starts from a fresh one.
 */
interface Opening {
  opened: boolean
  /** Openings so far; nothing loads before the first. */
  seq: number
  failed: boolean
  Drawer: React.LazyExoticComponent<React.ComponentType<EntryChangesDrawerProps>>
}

export const LazyEntryChangesDrawer: React.FC<LazyEntryChangesDrawerProps> = ({
  load = loadDrawer,
  ...props
}) => {
  const [opening, setOpening] = useState<Opening>(() => ({
    opened: props.opened,
    seq: props.opened ? 1 : 0,
    failed: false,
    Drawer: React.lazy(load),
  }))
  if (props.opened !== opening.opened) {
    const reopened = props.opened && !opening.opened
    setOpening({
      opened: props.opened,
      seq: opening.seq + (reopened ? 1 : 0),
      failed: reopened ? false : opening.failed,
      Drawer: reopened && opening.failed ? React.lazy(load) : opening.Drawer,
    })
  }
  const { Drawer } = opening
  const focusReturn = focusReturnProps(props.returnFocusTo)
  if (opening.seq === 0) return null
  return (
    <EditorErrorBoundary
      context={{ boundary: 'changes' }}
      // Each opening, and each entry, starts clear of an earlier one's failure.
      resetKey={`${props.subject.logicalPath}#${opening.seq}`}
      onCaught={() => setOpening((current) => ({ ...current, failed: true }))}
      fallback={() => (
        <OverlayDrawer
          opened={props.opened}
          onClose={props.onClose}
          position="right"
          size={720}
          title={`Changes to ${props.subject.title}`}
          {...focusReturn}
          onExitTransitionEnd={() => {
            focusReturn.onExitTransitionEnd?.()
            props.onExited?.()
          }}
        >
          <Alert
            variant="light"
            color="red"
            icon={<IconAlertCircle size={16} />}
            data-testid="entry-changes-crashed"
          >
            <Stack gap={4} align="flex-start">
              <Text size="sm">
                Changes couldn’t be shown. Close and reopen to try again, or reload the page.
              </Text>
              <Button size="compact-sm" variant="subtle" onClick={props.onClose}>
                Close
              </Button>
            </Stack>
          </Alert>
        </OverlayDrawer>
      )}
    >
      <Suspense
        fallback={
          <OverlayDrawer
            opened={props.opened}
            onClose={props.onClose}
            position="right"
            size={720}
            title={`Changes to ${props.subject.title}`}
            {...focusReturn}
          >
            <Stack gap="sm">
              <Stack gap={2} role="status">
                <LoadingSummary />
              </Stack>
              <LoadingCards />
            </Stack>
          </OverlayDrawer>
        }
      >
        <Drawer {...props} />
      </Suspense>
    </EditorErrorBoundary>
  )
}
