'use client'

import React from 'react'
import { Anchor, Button, List, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import type { LogicalPath } from '../../paths/types'
import { SAVE_ALL_RESULT_TOAST_ID, type SaveAllResult } from '../hooks/save-all'
import { getNotificationDuration } from '../utils/env'

const entries = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`

export interface SaveAllResultMessageProps {
  result: SaveAllResult
  onOpenEntry: (path: LogicalPath) => void
  /** Runs Save all again over whatever is still unsaved. */
  onRetry: () => void
}

/**
 * Names every entry Save all could not save, each opening that entry, with its reason.
 * @internal Exported for stories.
 */
export function SaveAllResultMessage({ result, onOpenEntry, onRetry }: SaveAllResultMessageProps) {
  return (
    <Stack gap={6} data-testid="save-all-result">
      {result.saved.length > 0 && <Text size="sm">{`${entries(result.saved.length)} saved.`}</Text>}
      <List size="sm" spacing={6} listStyleType="none" pl={0}>
        {result.failed.map((failure) => (
          <List.Item key={failure.contentId} data-testid="save-all-failure">
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
          </List.Item>
        ))}
      </List>
      <Text size="sm">
        {result.failed.length === 1
          ? 'Its unsaved changes are kept.'
          : 'Their unsaved changes are kept.'}
      </Text>
      <Button size="compact-sm" variant="default" w="fit-content" onClick={onRetry}>
        Try again
      </Button>
    </Stack>
  )
}

/**
 * Reports a finished Save all in one toast. Partly failed, it stays until dismissed: yellow when
 * nothing failed for good (no answer, or changed elsewhere), else red.
 */
export function showSaveAllResult(
  result: SaveAllResult,
  actions: Omit<SaveAllResultMessageProps, 'result'>,
): void {
  notifications.hide(SAVE_ALL_RESULT_TOAST_ID)
  if (result.total === 0) {
    // The draft check found every change already on the server.
    notifications.show({
      id: SAVE_ALL_RESULT_TOAST_ID,
      message: 'No changes to save',
      color: 'blue',
      autoClose: getNotificationDuration(4000),
      withCloseButton: true,
    })
    return
  }
  if (result.failed.length === 0) {
    notifications.show({
      id: SAVE_ALL_RESULT_TOAST_ID,
      message: `${entries(result.saved.length)} saved`,
      color: 'green',
      autoClose: getNotificationDuration(4000),
      withCloseButton: true,
    })
    return
  }
  const warningOnly = result.failed.every((f) => f.kind === 'unanswered' || f.kind === 'conflict')
  notifications.show({
    id: SAVE_ALL_RESULT_TOAST_ID,
    title:
      result.failed.length === result.total
        ? `${entries(result.total)} not saved`
        : `${result.failed.length} of ${entries(result.total)} not saved`,
    message: <SaveAllResultMessage result={result} {...actions} />,
    color: warningOnly ? 'yellow' : 'red',
    autoClose: false,
    withCloseButton: true,
  })
}
