'use client'

import React from 'react'
import { Anchor, Box, Button, Group, List, Stack, Text, VisuallyHidden } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconAlertTriangle, IconCircleX } from '@tabler/icons-react'
import type { LogicalPath } from '../../paths/types'
import {
  SAVE_ALL_RESULT_TOAST_ID,
  type SaveAllFailure,
  type SaveAllResult,
} from '../hooks/save-all'
import { getNotificationDuration } from '../utils/env'

const entries = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`

/** Nothing is lost yet: no answer, or a change made elsewhere. */
const isWarning = (failure: SaveAllFailure) =>
  failure.kind === 'unanswered' || failure.kind === 'conflict'

interface SaveAllResultMessageProps {
  result: SaveAllResult
  onOpenEntry: (path: LogicalPath) => void
  /** Runs Save all again over whatever is still unsaved. */
  onRetry: () => void
}

/**
 * Names every entry Save all could not save, each opening that entry, with its reason and a
 * warning or error mark. "Try again" is offered only when a failure is one a retry can pass.
 * @internal Exported for stories.
 */
export function SaveAllResultMessage({ result, onOpenEntry, onRetry }: SaveAllResultMessageProps) {
  const retryable = result.failed.some((failure) => failure.kind === 'error' || failure.retryable)
  return (
    <Stack gap={6} data-testid="save-all-result">
      {result.saved.length > 0 && <Text size="sm">{`${entries(result.saved.length)} saved.`}</Text>}
      <List size="sm" spacing={6} listStyleType="none" pl={0}>
        {result.failed.map((failure) => (
          <List.Item key={failure.contentId} data-testid="save-all-failure">
            <Group gap={6} wrap="nowrap" align="flex-start">
              <Box
                component="span"
                display="inline-flex"
                mt={2}
                aria-hidden="true"
                c={isWarning(failure) ? 'var(--mantine-color-text)' : 'var(--canopy-danger-text)'}
              >
                {isWarning(failure) ? <IconAlertTriangle size={16} /> : <IconCircleX size={16} />}
              </Box>
              <div>
                <VisuallyHidden component="span">
                  {isWarning(failure) ? 'Warning: ' : 'Error: '}
                </VisuallyHidden>
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  fw={600}
                  onClick={() => onOpenEntry(failure.path)}
                >
                  {failure.label}
                </Anchor>
                <Text size="sm" span>
                  {`: ${failure.reason}`}
                </Text>
                {failure.recreate && (
                  <Button
                    display="block"
                    mt={4}
                    size="compact-xs"
                    variant="default"
                    onClick={failure.recreate}
                  >
                    Save as new entry
                  </Button>
                )}
              </div>
            </Group>
          </List.Item>
        ))}
      </List>
      <Text size="sm">
        {result.failed.length === 1
          ? 'Its unsaved changes are kept.'
          : 'Their unsaved changes are kept.'}
      </Text>
      {retryable && (
        <Button size="compact-sm" variant="default" w="fit-content" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Stack>
  )
}

type Actions = Omit<SaveAllResultMessageProps, 'result'>

// The result on screen, so an entry settled elsewhere (saved, refreshed, discarded) leaves it.
let shown: { result: SaveAllResult; actions: Actions } | undefined

const renderFailures = (result: SaveAllResult, actions: Actions, update: boolean) => {
  const data = {
    id: SAVE_ALL_RESULT_TOAST_ID,
    // An unanswered save may have landed, so "not saved" would claim more than is known.
    title: `${
      result.failed.length === result.total
        ? entries(result.total)
        : `${result.failed.length} of ${entries(result.total)}`
    } ${result.failed.some((failure) => failure.kind === 'unanswered') ? 'may not have saved' : 'not saved'}`,
    message: <SaveAllResultMessage result={result} {...actions} />,
    color: result.failed.every(isWarning) ? 'yellow' : 'red',
    autoClose: false as const,
    withCloseButton: true,
    onClose: () => {
      shown = undefined
    },
  }
  if (update) notifications.update(data)
  else notifications.show(data)
}

/**
 * Reports a finished Save all in one toast. Partly failed, it stays until dismissed: yellow when
 * nothing failed for good, else red, each entry marked by its own severity.
 */
export function showSaveAllResult(result: SaveAllResult, actions: Actions): void {
  shown = undefined
  notifications.hide(SAVE_ALL_RESULT_TOAST_ID)
  if (result.total === 0 || result.failed.length === 0) {
    notifications.show({
      id: SAVE_ALL_RESULT_TOAST_ID,
      // An empty run found every change already on the server, or settled meanwhile.
      message: result.total === 0 ? 'No changes to save' : `${entries(result.saved.length)} saved`,
      color: result.total === 0 ? 'blue' : 'green',
      autoClose: getNotificationDuration(4000),
      withCloseButton: true,
    })
    return
  }
  shown = { result, actions }
  renderFailures(result, actions, false)
}

/** Takes an entry out of the result on screen, and the toast down with its last entry. */
export function settleSaveAllEntry(contentId: string): void {
  if (!shown) return
  const failed = shown.result.failed.filter((failure) => failure.contentId !== contentId)
  if (failed.length === shown.result.failed.length) return
  if (failed.length === 0) {
    clearSaveAllResult()
    return
  }
  // Settled, the entry is no longer part of the run the title counts.
  shown = { ...shown, result: { ...shown.result, failed, total: shown.result.total - 1 } }
  renderFailures(shown.result, shown.actions, true)
}

/** Takes a partly failed result down, as when the branch it belongs to is left. */
export function clearSaveAllResult(): void {
  if (!shown) return
  shown = undefined
  notifications.hide(SAVE_ALL_RESULT_TOAST_ID)
}
