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
    operatingMode: 'prod',
    busy: false,
    breadcrumbSegments: [{ label: 'Posts', collectionPath: 'content/posts' }],
    editedFiles: [
      { path: unsafeAsLogicalPath('content/posts/hello'), label: 'Hello' },
      { path: unsafeAsLogicalPath('content/pages/about'), label: 'About us' },
      { path: unsafeAsLogicalPath('content/pages/team'), label: 'Our team' },
    ],
    modifiedCount: 3,
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
type Story = StoryObj<typeof Headers>

/** Three entries unsaved, the open one among them: its dot, the pill's count and Save all (3). */
export const Unsaved: Story = {}

export const Saved: Story = {
  args: { hasUnsavedChanges: false, editedFiles: [], modifiedCount: 0 },
}

/**
 * In review: Submit becomes Withdraw, and Save and Save all are blocked. The lock banner, not
 * shown here, says why.
 */
export const InReview: Story = {
  args: {
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
    editedFiles: [],
    modifiedCount: 0,
  },
}

/**
 * The protected base branch: "Protected" status, no Submit, Save blocked with its reason. The
 * lock banner, not shown here, says it is read-only.
 */
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

/** A path rule refuses this entry on a locked branch: the chip stays, as withdrawing won't unlock it. */
export const EntryReadOnlyInReview: Story = {
  args: {
    entryReadOnly: true,
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
  },
}

/** At 390px the top bar wraps rather than clip "Withdraw from review"; the breadcrumb truncates. */
export const Narrow: Story = {
  parameters: phone,
  args: { branchStatus: 'submitted', branchWriteBlocked: true, hasUnsavedChanges: false },
}

/** On a phone unsaved changes add only the entry's dot and the pill's count. */
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

/** Before branch details arrive: no chip or status yet, as nothing is known. */
export const BranchLoading: Story = {
  args: { branchLoading: true, branchWriteBlocked: true, hasUnsavedChanges: false },
}

/** Save all shows its progress; the entry's Save waits for it, and says so on focus. */
export const SaveAllInProgress: Story = {
  args: { busy: true, saveAllProgress: { done: 1, total: 3 } },
}

/** The browser refused to store drafts: a warning joins the top bar, an icon below `lg`. */
export const UnsavedNotKept: Story = {
  args: { draftStorageFailed: true },
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
