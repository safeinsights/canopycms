'use client'

import { useState } from 'react'
import { Button, CopyButton, Stack, Text, Textarea } from '@mantine/core'
import { REQUEST_CHANGES_NOTE_MAX_LENGTH } from '../../authorization/review-role'

/** The note counter appears once a note is this long, and is announced in the last 100. */
const NOTE_COUNT_FROM = 1800
const NOTE_ANNOUNCE_FROM = REQUEST_CHANGES_NOTE_MAX_LENGTH - 100

/** What the Approve dialog says; the pull request clause needs a pull request to be true. */
export function approveMessage(branchName: string, hasPullRequest: boolean): string {
  return hasPullRequest
    ? `Approve "${branchName}"? Its pull request stays open on GitHub for someone with access to merge it.`
    : `Approve "${branchName}"? It stays locked until it is withdrawn or its pull request is merged.`
}

/** The Request changes dialog's body: what happens, and an optional note for the editor. */
export function RequestChangesForm({
  branchName,
  hasPullRequest,
  initialNote = '',
  onNoteChange,
}: {
  branchName: string
  hasPullRequest: boolean
  /** A note typed before, such as one a failed request left behind. */
  initialNote?: string
  onNoteChange: (note: string) => void
}) {
  const [note, setNote] = useState(initialNote)
  return (
    <Stack gap="sm">
      <Text size="sm">
        {`Send "${branchName}" back to its editor? It goes back to editing${hasPullRequest ? ', and its pull request becomes a draft' : ''}.`}
      </Text>
      <Stack gap={4}>
        <Textarea
          label="Note to the editor"
          description="Saved as a comment on the branch."
          value={note}
          onChange={(event) => {
            setNote(event.currentTarget.value)
            onNoteChange(event.currentTarget.value)
          }}
          maxLength={REQUEST_CHANGES_NOTE_MAX_LENGTH}
          autosize
          minRows={3}
          maxRows={8}
          // Mantine's focus trap focuses this rather than the first control, the dialog's close button.
          data-autofocus
          data-testid="request-changes-note"
        />
        {note.length > NOTE_COUNT_FROM && (
          <Text
            size="xs"
            c="dimmed"
            ta="end"
            aria-live={note.length >= NOTE_ANNOUNCE_FROM ? 'polite' : undefined}
            data-testid="request-changes-note-count"
          >
            {`${note.length.toLocaleString('en-US')} / ${REQUEST_CHANGES_NOTE_MAX_LENGTH.toLocaleString('en-US')}`}
          </Text>
        )}
      </Stack>
    </Stack>
  )
}

/**
 * A notification body that holds a note the reviewer typed, which is not saved: the message, the
 * note quoted, and a button to copy it. `hint` says what to do with the copy.
 */
export function NoteNotSavedMessage({
  message,
  note,
  hint = 'Copy it into a comment on the branch.',
}: {
  message: string
  note: string
  hint?: string
}) {
  return (
    <Stack gap={6}>
      <Text size="sm">{`${message} ${hint}`}</Text>
      <Text
        component="blockquote"
        size="sm"
        m={0}
        ps="sm"
        lineClamp={6}
        style={{
          whiteSpace: 'pre-wrap',
          borderInlineStart: '2px solid var(--canopy-input-border)',
        }}
        data-testid="note-not-saved-text"
      >
        {note}
      </Text>
      <CopyButton value={note}>
        {({ copied, copy }) => (
          <Button
            size="compact-sm"
            variant="light"
            style={{ alignSelf: 'flex-start' }}
            onClick={copy}
            data-testid="copy-note-button"
          >
            {copied ? 'Copied' : 'Copy note'}
          </Button>
        )}
      </CopyButton>
    </Stack>
  )
}
