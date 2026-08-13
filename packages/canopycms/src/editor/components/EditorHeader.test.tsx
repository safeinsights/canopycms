import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { EditorHeader, type EditorHeaderProps } from './EditorHeader'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'
import type { EditorEntry } from '../Editor'

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

const currentEntry: EditorEntry = {
  path: unsafeAsLogicalPath('posts/hello'),
  contentId: unsafeAsContentId('abc123def456'),
  label: 'Hello',
  schema: [],
  apiPath: '/api/canopy',
}

const defaultProps: EditorHeaderProps = {
  siteTitle: 'My Site',
  headerTitle: 'Edit Content',
  currentEntry,
  branchName: 'feature/x',
  operatingMode: 'prod',
  busy: false,
  breadcrumbSegments: ['Posts', 'Hello'],
  editedFiles: [],
  modifiedCount: 0,
  unresolvedCommentCount: 0,
  comments: [],
  onNavigatorOpen: vi.fn(),
  onFileReload: vi.fn(),
  onFileDiscardDraft: vi.fn(),
  onEntrySelect: vi.fn(),
  onBranchReloadData: vi.fn(),
  onBranchDiscardDrafts: vi.fn(),
  onBranchManagerOpen: vi.fn(),
  onCommentsPanelOpen: vi.fn(),
  onSave: vi.fn(),
  onSubmit: vi.fn(),
  hasUnsavedChanges: true,
  branchStatus: 'editing',
  onWithdraw: vi.fn(),
}

const renderHeader = (overrides: Partial<EditorHeaderProps> = {}) =>
  render(<EditorHeader {...defaultProps} {...overrides} />, { wrapper: Wrapper })

describe('EditorHeader - review lock', () => {
  afterEach(() => {
    cleanup()
  })

  // branchWriteBlocked is the server's own getBranchProtection() answer; the
  // Editor always passes it alongside branchStatus off the same BranchListItem,
  // so the two cannot diverge in practice.
  it('disables Save, shows the status-locked banner, and offers Withdraw when submitted', () => {
    renderHeader({
      branchStatus: 'submitted',
      branchWriteBlocked: true,
      userContext: { userId: 'u1' },
      branchCreatedBy: 'u1',
    })

    expect(screen.getByTestId('save-button').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('status-locked-banner')).toBeTruthy()
    expect(screen.queryByTestId('protected-branch-banner')).toBeNull()
    expect(screen.getByTestId('withdraw-button').textContent).toBe('Withdraw Branch...')
  })

  it('enables Save and shows no lock banner when editing with unsaved changes', () => {
    renderHeader({ branchStatus: 'editing', branchWriteBlocked: false, hasUnsavedChanges: true })

    expect(screen.getByTestId('save-button').hasAttribute('disabled')).toBe(false)
    expect(screen.queryByTestId('status-locked-banner')).toBeNull()
    expect(screen.queryByTestId('protected-branch-banner')).toBeNull()
  })

  it('shows the protected-branch banner (not the status banner) when branchReadOnly is set', () => {
    // The server sets writeBlocked on a read-only base branch too; readOnly is
    // what decides which of the two banners wins.
    renderHeader({
      branchStatus: 'editing',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
    })

    expect(screen.getByTestId('protected-branch-banner')).toBeTruthy()
    expect(screen.queryByTestId('status-locked-banner')).toBeNull()
    expect(screen.getByTestId('save-button').hasAttribute('disabled')).toBe(true)
  })

  it('shows only the protected-branch banner for a submitted base branch', () => {
    renderHeader({
      branchStatus: 'submitted',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
    })

    expect(screen.getByTestId('protected-branch-banner')).toBeTruthy()
    expect(screen.queryByTestId('status-locked-banner')).toBeNull()
  })

  it('never renders the status into the banner when the branch is locked but its status is unknown', () => {
    // The write lock now fails CLOSED while the branch list is unresolved
    // (Editor.tsx passes `writeBlocked ?? true`), but `branchStatus` comes from
    // the same unresolved `currentBranch` and is undefined in that window. The
    // banner interpolated it directly, so an ordinary initial load — and, until
    // a reload, every failed branches fetch — rendered the literal text
    // `Branch "main" is undefined — content is read-only.`
    //
    // Asserted as "the word undefined never appears", not just "some other copy
    // is shown": the point is that no interpolation of a missing value can leak
    // into user-facing text here, however the copy is later reworded.
    renderHeader({ branchStatus: undefined, branchWriteBlocked: true })

    const banner = screen.getByTestId('status-locked-banner')
    expect(banner.textContent).not.toMatch(/undefined/)
    expect(banner.textContent).toMatch(/could not be loaded/i)
    expect(screen.getByTestId('save-button').hasAttribute('disabled')).toBe(true)
  })

  it('still names a KNOWN status in the banner', () => {
    // Guards the fix from over-reaching: only the unknown case gets the new
    // copy, so a real status lock keeps saying which status locked it.
    renderHeader({ branchStatus: 'archived', branchWriteBlocked: true })

    expect(screen.getByTestId('status-locked-banner').textContent).toMatch(/archived/)
  })
})

describe('EditorHeader - branch menu file count', () => {
  afterEach(() => {
    cleanup()
  })

  it('singularizes the count for exactly one modified file', async () => {
    renderHeader({ modifiedCount: 1 })

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))

    expect(await screen.findByText('1 file modified')).toBeTruthy()
  })

  it('pluralizes the count for more than one modified file', async () => {
    renderHeader({ modifiedCount: 2 })

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))

    expect(await screen.findByText('2 files modified')).toBeTruthy()
  })
})

describe('EditorHeader - no leftover placeholder copy', () => {
  afterEach(() => {
    cleanup()
  })

  it('never renders the old TODO placeholder menu items', async () => {
    renderHeader()

    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    await screen.findByTestId('all-files-menu-item')
    expect(document.body.textContent).not.toContain('TODO')

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))
    await screen.findByTestId('manage-branches-menu-item')
    expect(document.body.textContent).not.toContain('TODO')
  })
})
