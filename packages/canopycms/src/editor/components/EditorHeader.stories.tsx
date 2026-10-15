import type { Meta, StoryObj } from '@storybook/react'

import { EditorHeader } from './EditorHeader'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'

const noop = () => {}

const meta: Meta<typeof EditorHeader> = {
  title: 'Editor/EditorHeader',
  component: EditorHeader,
  args: {
    siteTitle: 'Example Site',
    headerTitle: 'Hello',
    currentEntry: {
      path: unsafeAsLogicalPath('posts/hello'),
      contentId: unsafeAsContentId('abc123def456'),
      label: 'Hello',
      schema: [],
    },
    branchName: 'feature/landing',
    operatingMode: 'prod',
    busy: false,
    breadcrumbSegments: ['Posts', 'Hello'],
    editedFiles: [],
    modifiedCount: 0,
    onNavigatorOpen: noop,
    onFileReload: noop,
    onFileDiscardDraft: noop,
    onEntrySelect: noop,
    onBranchReloadData: noop,
    onBranchDiscardDrafts: noop,
    onBranchManagerOpen: noop,
    onSave: noop,
    onSubmit: noop,
    onWithdraw: noop,
    hasUnsavedChanges: true,
    branchStatus: 'editing',
  },
}

export default meta
type Story = StoryObj<typeof EditorHeader>

export const Editing: Story = {}

export const InReview: Story = {
  args: { branchStatus: 'submitted', branchWriteBlocked: true, hasUnsavedChanges: false },
}

export const ProtectedBaseBranch: Story = {
  args: {
    branchName: 'main',
    branchIsProtected: true,
    branchReadOnly: true,
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
  },
}

/** The browser refused to store drafts, so leaving the page would lose them. */
export const UnsavedNotKept: Story = {
  args: { draftStorageFailed: true },
}
