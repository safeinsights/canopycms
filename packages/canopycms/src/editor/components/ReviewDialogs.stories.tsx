import { useEffect, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { Text } from '@mantine/core'
import { modals } from '@mantine/modals'

import { openConfirm } from '../utils/confirm-modal'
import { EDITOR_ACTIONS } from '../copy'
import { approveMessage, NoteNotSavedMessage, RequestChangesForm } from './ReviewDialogs'

const noop = () => {}

/** Opens `children` in the confirm modal the editor uses, with the labels its dialog gives it. */
function InConfirm({
  title,
  confirm,
  color,
  children,
}: {
  title: string
  confirm: string
  color: 'red' | 'brand'
  children: ReactNode
}) {
  useEffect(() => {
    const id = openConfirm({
      title,
      children,
      labels: { confirm, cancel: 'Cancel' },
      confirmProps: { color },
    })
    return () => modals.close(id)
    // The dialog is opened once; its body is fixed per story.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

const meta: Meta = {
  title: 'Editor/Review dialogs',
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

const longNote = `${'The headline claims more than the page backs up. '.repeat(37)}Please tighten it.`

const requestChanges = (props: { hasPullRequest: boolean; initialNote?: string }) => (
  <InConfirm
    title={EDITOR_ACTIONS.requestChanges}
    confirm={EDITOR_ACTIONS.requestChanges}
    color="red"
  >
    <RequestChangesForm branchName="feature/docs" onNoteChange={noop} {...props} />
  </InConfirm>
)

/** An empty note, with a pull request that becomes a draft; the note field has focus. */
export const RequestChangesEmpty: Story = {
  render: () => requestChanges({ hasPullRequest: true }),
}

/** A note near the 2,000-character cap: the count appears and is announced in the last 100. */
export const RequestChangesLongNote: Story = {
  render: () => requestChanges({ hasPullRequest: true, initialNote: longNote.slice(0, 1950) }),
}

/** A note a failed request left behind, prefilled. */
export const RequestChangesWithDraft: Story = {
  render: () =>
    requestChanges({ hasPullRequest: true, initialNote: 'Please tighten the headline.' }),
}

/** A branch with no pull request: the draft clause is left out. */
export const RequestChangesNoPullRequest: Story = {
  render: () => requestChanges({ hasPullRequest: false }),
}

const approve = (hasPullRequest: boolean) => (
  <InConfirm title={EDITOR_ACTIONS.approve} confirm={EDITOR_ACTIONS.approve} color="brand">
    <Text size="sm">{approveMessage('feature/docs', hasPullRequest)}</Text>
  </InConfirm>
)

/** Its pull request stays open on GitHub for someone with access to merge it. */
export const ApproveWithPullRequest: Story = { render: () => approve(true) }

/** No pull request yet, as in dev without GitHub, or while a sync is pending. */
export const ApproveNoPullRequest: Story = { render: () => approve(false) }

/** The notification body when changes were requested but the note could not be saved. */
export const NoteNotSaved: Story = {
  render: () => (
    <div style={{ maxWidth: 380, padding: 16 }}>
      <NoteNotSavedMessage
        warning="Changes were requested, but your note couldn't be saved."
        note="Please tighten the headline, and say where the 40% figure comes from."
      />
    </div>
  ),
}
