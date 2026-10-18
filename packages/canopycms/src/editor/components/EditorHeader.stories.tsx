import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import { EditorHeader, type EditorHeaderProps } from './EditorHeader'
import { EntryHeader, type EntryHeaderProps } from './EntryHeader'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'

const noop = () => {}

const phone = {
  viewport: {
    viewports: { phone: { name: 'Phone', styles: { width: '390px', height: '844px' } } },
    defaultViewport: 'phone',
  },
}

type HeadersProps = EditorHeaderProps & Omit<EntryHeaderProps, 'saveAllRunning'>

/** The top bar over the entry header, as the shell stacks them. */
function Headers(props: HeadersProps) {
  return (
    <>
      <EditorHeader {...props} />
      <EntryHeader {...props} saveAllRunning={!!props.saveAllProgress} />
    </>
  )
}

const meta: Meta<typeof Headers> = {
  title: 'Editor/EditorHeader',
  component: Headers,
  parameters: { layout: 'fullscreen' },
  args: {
    currentEntry: {
      path: unsafeAsLogicalPath('content/posts/hello'),
      contentId: unsafeAsContentId('abc123def456'),
      label: 'Hello',
      schema: [],
    },
    branchName: 'feature/landing',
    busy: false,
    breadcrumbSegments: [{ label: 'Posts', collectionPath: 'content/posts' }],
    modifiedCount: 3,
    onShowUnsaved: noop,
    onCollectionOpen: noop,
    onFileReload: noop,
    onFileDiscardDraft: noop,
    onEntryRename: noop,
    onEntryDelete: noop,
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
type Story = StoryObj<typeof Headers>

/** Three entries unsaved, the open one among them: its dot, and "3 unsaved" beside the status. */
export const Unsaved: Story = {}

export const Saved: Story = {
  args: { hasUnsavedChanges: false, modifiedCount: 0 },
}

/** In review: the status says so beside the pill, Submit becomes Withdraw, and saves are blocked. */
export const InReview: Story = {
  args: {
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    hasUnsavedChanges: false,

    modifiedCount: 0,
  },
}

/** The protected base branch in prod: "Protected · read-only", no Submit, and New branch…. */
export const ReadOnly: Story = {
  args: {
    branchName: 'main',
    branchIsProtected: true,
    branchServerProtected: true,
    branchReadOnly: true,
    branchWriteBlocked: true,
    hasUnsavedChanges: false,

    modifiedCount: 0,
  },
}

/** The protected base branch in dev: writable, so "Protected" with no read-only and no lock. */
export const ProtectedWritable: Story = {
  args: { branchName: 'main', branchIsProtected: true, branchServerProtected: true },
}

/** Branch details failed to load: locked, with Refresh branch to try again. */
export const DetailsUnavailable: Story = {
  args: {
    branchStatus: undefined,
    // Editor fails closed to protected while it has no branch details, so no Submit shows.
    branchIsProtected: true,
    branchLoading: true,
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
  },
}

/** The list answered without this branch: no access to it, or it is gone. Switch branch… opens another. */
export const NotAvailable: Story = {
  args: {
    ...DetailsUnavailable.args,
    branchMissing: true,
  },
}

/** Archived: read-only, with Switch branch… and Submit blocked with its reason. */
export const Archived: Story = {
  args: { branchStatus: 'archived', branchWriteBlocked: true, hasUnsavedChanges: false },
}

/** In review, for someone who may not withdraw it: Withdraw stays, blocked, with its reason. */
export const InReviewNoPermission: Story = {
  args: {
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    branchCreatedBy: 'someone-else',
    hasUnsavedChanges: false,
  },
}

/** A path rule refuses this entry to this user, on an editable branch. */
export const EntryReadOnly: Story = {
  args: { entryReadOnly: true, hasUnsavedChanges: false },
}

/** A path rule refuses this entry on a locked branch: the chip stays, as withdrawing won't unlock it. */
export const EntryReadOnlyInReview: Story = {
  args: {
    entryReadOnly: true,
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
  },
}

/** At 390px a branch in review offers Withdraw alone: Save all couldn't apply there. */
export const Narrow: Story = {
  parameters: phone,
  args: { branchStatus: 'submitted', branchWriteBlocked: true, hasUnsavedChanges: false },
}

/** Below `md` an editable branch's Save all and Submit share one split button. */
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

/** Before branch details arrive: "Loading branch…", and no lock named yet. */
export const BranchLoading: Story = {
  args: {
    branchStatus: undefined,
    branchIsProtected: true,
    branchLoading: true,
    branchPending: true,
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
  },
}

/** Save all shows its progress; the entry's Save waits for it, and says so on focus. */
export const SaveAllInProgress: Story = {
  args: { busy: true, saveAllProgress: { done: 1, total: 3 } },
}

/** The browser refused to store drafts: a warning joins the top bar, an icon below `lg`. */
export const UnsavedNotKept: Story = {
  args: { draftStorageFailed: true },
}

/** Entries still loading: a placeholder crumb, and Save blocked without a reason yet. */
export const EntryLoading: Story = {
  args: {
    currentEntry: undefined,
    entryLoading: true,
    breadcrumbSegments: [],
    hasUnsavedChanges: false,
  },
}

/** No entry open: Save stays in place, blocked, saying to open one. */
export const NoEntryOpen: Story = {
  args: {
    currentEntry: undefined,
    breadcrumbSegments: [],
    hasUnsavedChanges: false,
  },
}

const until = async (found: () => Element | null) => {
  for (let i = 0; i < 50 && !found(); i++) await new Promise((r) => setTimeout(r, 50))
}
const byTestId = (canvasElement: HTMLElement, testId: string) => () =>
  canvasElement.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)

/** Clicks `testId` once it has rendered, then waits for the menu it opens. */
const openMenu =
  (testId: string): Story['play'] =>
  async ({ canvasElement }) => {
    const trigger = byTestId(canvasElement, testId)
    await until(trigger)
    trigger()?.click()
    await until(() => document.querySelector('[role="menu"]'))
  }
const openEntryMenu = openMenu('file-dropdown-button')

/** Focuses `testId` once it has rendered, then waits for the Tooltip giving its reason. */
const focusReason =
  (testId: string): Story['play'] =>
  async ({ canvasElement }) => {
    const control = byTestId(canvasElement, testId)
    await until(control)
    control()?.focus()
    await until(() => document.querySelector('[role="tooltip"]'))
  }

/** The entry menu: refresh, discard, then Change URL… and the destructive Delete entry. */
export const EntryMenu: Story = {
  args: { hasUnsavedChanges: false },
  play: openEntryMenu,
}

/** On a branch in review, Change URL… and Delete entry stay in the menu, blocked, with the reason. */
export const EntryMenuBlocked: Story = {
  args: { branchStatus: 'submitted', branchWriteBlocked: true, hasUnsavedChanges: false },
  play: openEntryMenu,
}

/** A Save in flight. */
export const Saving: Story = {
  args: { busy: true, saving: true },
}

/** A Save that has just landed: "Saved" for two seconds, then "Save". */
export const JustSaved: Story = {
  args: { hasUnsavedChanges: false, modifiedCount: 2 },
  render: function JustSavedStory(args) {
    // Only a signal that rises after mount shows "Saved".
    const [signal, setSignal] = useState(0)
    useEffect(() => setSignal(1), [])
    return <Headers {...args} savedSignal={signal} savedHere />
  },
}

/** The branch's entry list failed to load, so Save all can't match drafts to entries. */
export const SaveAllEntryListFailed: Story = {
  args: { entryListFailed: true },
  play: focusReason('save-all-button'),
}

/** Another entry's Save is in flight, so Save all waits for it. */
export const SaveAllWaitsForSave: Story = {
  args: { singleSaving: true },
  play: focusReason('save-all-button'),
}

/** The split button's caret, holding Submit for review. */
export const NarrowBranchActions: Story = {
  parameters: phone,
  play: openMenu('branch-actions-button'),
}

/** Submit in the caret, blocked for someone without access: its reason wraps within the menu. */
export const NarrowBranchActionsBlocked: Story = {
  parameters: phone,
  args: { branchCreatedBy: 'someone-else' },
  play: openMenu('branch-actions-button'),
}

/** Withdraw in the caret, for a branch in review that is still writable. */
export const NarrowBranchActionsWithdraw: Story = {
  parameters: phone,
  args: { branchStatus: 'approved' },
  play: openMenu('branch-actions-button'),
}

/** In review below `md`, for someone who may not withdraw: Switch branch…, Withdraw in its caret. */
export const NarrowInReviewNoPermission: Story = {
  parameters: phone,
  args: {
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    branchCreatedBy: 'someone-else',
    hasUnsavedChanges: false,
  },
  play: openMenu('branch-actions-button'),
}

/** The protected base branch below `md`: New branch… alone. */
export const NarrowReadOnly: Story = {
  parameters: phone,
  args: { ...ReadOnly.args },
}

/** Archived below `md`: Switch branch…, the blocked Submit and its reason in the caret. */
export const NarrowArchived: Story = {
  parameters: phone,
  args: { ...Archived.args },
  play: openMenu('branch-actions-button'),
}
