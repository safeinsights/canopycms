import type { Meta, StoryObj } from '@storybook/react'

import { EditorHeader } from './EditorHeader'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'

const noop = () => {}

const phone = {
  viewport: {
    viewports: { phone: { name: 'Phone', styles: { width: '390px', height: '844px' } } },
    defaultViewport: 'phone',
  },
}

const meta: Meta<typeof EditorHeader> = {
  title: 'Editor/EditorHeader',
  component: EditorHeader,
  parameters: { layout: 'fullscreen' },
  args: {
    currentEntry: {
      path: unsafeAsLogicalPath('content/posts/hello'),
      contentId: unsafeAsContentId('abc123def456'),
      label: 'Hello',
      schema: [],
    },
    branchName: 'feature/landing',
    operatingMode: 'prod',
    busy: false,
    breadcrumbSegments: [
      { label: 'All content' },
      { label: 'Posts', collectionPath: 'content/posts' },
    ],
    editedFiles: [
      { path: unsafeAsLogicalPath('content/posts/hello'), label: 'Hello' },
      { path: unsafeAsLogicalPath('content/pages/about'), label: 'About us' },
      { path: unsafeAsLogicalPath('content/pages/team'), label: 'Our team' },
    ],
    modifiedCount: 3,
    onNavigatorOpen: noop,
    onCollectionOpen: noop,
    onFileReload: noop,
    onFileDiscardDraft: noop,
    onEntryRename: noop,
    onEntryDelete: noop,
    onEntrySelect: noop,
    onBranchReloadData: noop,
    onBranchDiscardDrafts: noop,
    onBranchManagerOpen: noop,
    onSave: noop,
    onSaveAll: noop,
    saveAllProgress: null,
    onSubmit: noop,
    onWithdraw: noop,
    hasUnsavedChanges: true,
    branchStatus: 'editing',
    userContext: { userId: 'user-1' },
    branchCreatedBy: 'user-1',
  },
}

export default meta
type Story = StoryObj<typeof EditorHeader>

/** Three entries unsaved, the open one among them: its dot, the pill's count and Save all (3). */
export const Unsaved: Story = {}

export const Saved: Story = {
  args: { hasUnsavedChanges: false, editedFiles: [], modifiedCount: 0 },
}

export const InReview: Story = {
  args: {
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
    editedFiles: [],
    modifiedCount: 0,
  },
}

/** The protected base branch: the "Read-only" chip, no Submit, Save blocked with its reason. */
export const ReadOnly: Story = {
  args: {
    branchName: 'main',
    branchIsProtected: true,
    branchReadOnly: true,
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
    editedFiles: [],
    modifiedCount: 0,
  },
}

/** A path rule refuses this entry to this user, on an editable branch. */
export const EntryReadOnly: Story = {
  args: { entryReadOnly: true, hasUnsavedChanges: false },
}

/** At 390px the breadcrumb takes its own row, so "Withdraw from review" is never clipped. */
export const Narrow: Story = {
  parameters: phone,
  args: { branchStatus: 'submitted', branchWriteBlocked: true, hasUnsavedChanges: false },
}

/** Below `lg` the unsaved indicator is an icon, its text in its Tooltip and accessible name. */
export const NarrowUnsaved: Story = {
  parameters: phone,
}

/** The widest phone case: in review, many unsaved; the pill keeps its count and the row wraps. */
export const NarrowInReviewManyUnsaved: Story = {
  parameters: phone,
  args: {
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
    modifiedCount: 12,
  },
}

/** Before branch details arrive: no lock chip or status yet, as nothing is known. */
export const BranchLoading: Story = {
  args: { branchLoading: true, branchWriteBlocked: true, hasUnsavedChanges: false },
}

export const SaveAllInProgress: Story = {
  args: { busy: true, saveAllProgress: { done: 1, total: 3 } },
}

/** The browser refused to store drafts, so leaving the page would lose them. */
export const UnsavedNotKept: Story = {
  args: { draftStorageFailed: true },
}

export const NoEntryOpen: Story = {
  args: {
    currentEntry: undefined,
    breadcrumbSegments: [{ label: 'All content' }],
    hasUnsavedChanges: false,
  },
}

const openEntryMenu: Story['play'] = async ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[data-testid="file-dropdown-button"]')?.click()
}

/** The entry menu: refresh, discard, then Rename… and the destructive Delete entry. */
export const EntryMenu: Story = {
  args: { hasUnsavedChanges: false },
  play: openEntryMenu,
}

/** On a branch in review, Rename… and Delete entry stay in the menu, blocked, with the reason. */
export const EntryMenuBlocked: Story = {
  args: { branchStatus: 'submitted', branchWriteBlocked: true, hasUnsavedChanges: false },
  play: openEntryMenu,
}
