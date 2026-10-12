import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, within } from '@testing-library/react'
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

    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('status-locked-banner')).toBeTruthy()
    expect(screen.queryByTestId('protected-branch-banner')).toBeNull()
    expect(screen.getByTestId('withdraw-button').textContent).toBe('Withdraw from review')
  })

  it('enables Save and shows no lock banner when editing with unsaved changes', () => {
    renderHeader({ branchStatus: 'editing', branchWriteBlocked: false, hasUnsavedChanges: true })

    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBeNull()
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
    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBe('true')
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
    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBe('true')
  })

  it('never interpolates an unknown status into the submit/withdraw tooltip either', async () => {
    // The third and last `${branchStatus}` interpolation in this file. Reached
    // by mounting the action button with no branch data: `statusHasAction` is
    // false (undefined is neither 'editing' nor withdrawable), so the tooltip
    // renders, and it used to read "This branch is undefined and has no submit
    // or withdraw action available".
    //
    // Not reachable through Editor.tsx today, and only by accident: it passes
    // `branchIsProtected={... ?? true}` since the fail-closed change, and the
    // early return `branchIsProtected && !isWithdrawable` unmounts the button
    // in exactly this window. So this test pins the COMPONENT's contract --
    // `branchIsProtected={false}` is a legitimate prop combination -- rather
    // than relying on an unrelated guard to keep the copy off screen.
    renderHeader({
      branchStatus: undefined,
      branchIsProtected: false,
      userContext: { userId: 'u1' },
      branchCreatedBy: 'u1',
    })

    // Assert the RIGHT copy renders before asserting the wrong copy is gone --
    // a bare absence check would pass against a tooltip that never mounted.
    // Not withdrawable with an unknown status, so it renders as the submit side.
    await userEvent.hover(screen.getByTestId('submit-button'))
    expect(await screen.findByText(/Branch details could not be loaded/i)).toBeTruthy()
    expect(screen.queryByText(/is undefined/)).toBeNull()
  })

  it('still names a KNOWN status in the banner', () => {
    // Guards the fix from over-reaching: only the unknown case gets the new
    // copy, so a real status lock keeps saying which status locked it.
    renderHeader({ branchStatus: 'archived', branchWriteBlocked: true })

    expect(screen.getByTestId('status-locked-banner').textContent).toMatch(/archived/)
  })

  it('treats a status-lock that contradicts a known "editing" status as unavailable data, not a real lock', () => {
    // Version skew: an old server that omits `writeBlocked` while still
    // sending `status: 'editing'` used to render the self-contradicting
    // "Branch is editing — content is read-only" banner. `branchDataUnavailable`
    // now also covers branchStatus === 'editing' under a status lock, so this
    // renders the honest data-unavailable copy instead.
    renderHeader({
      branchWriteBlocked: true,
      branchReadOnly: false,
      branchStatus: 'editing',
    })

    // Assert the RIGHT copy renders before asserting the wrong copy is gone --
    // a bare absence check would pass against a banner that never mounted.
    const banner = screen.getByTestId('status-locked-banner')
    expect(banner.textContent).toMatch(/could not be loaded/i)
    expect(banner.textContent).not.toMatch(/is editing — content is read-only/)
  })
})

describe('EditorHeader - branch menu file count', () => {
  afterEach(() => {
    cleanup()
  })

  it('singularizes the count for exactly one modified entry', async () => {
    renderHeader({ modifiedCount: 1 })

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))

    expect(await screen.findByText('1 entry modified')).toBeTruthy()
  })

  it('pluralizes the count for more than one modified entry', async () => {
    renderHeader({ modifiedCount: 2 })

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))

    expect(await screen.findByText('2 entries modified')).toBeTruthy()
  })
})

describe('EditorHeader - branch menu with no edits', () => {
  afterEach(() => {
    cleanup()
  })

  it('says no entries have been edited yet, once, without a zero count above it', async () => {
    renderHeader({ modifiedCount: 0, editedFiles: [] })

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))

    const note = await screen.findByText('No edited entries yet')
    expect(screen.queryByText('0 entries modified')).toBeNull()
    expect(note.closest('[role="menuitem"]')).toBeNull()
    expect(
      within(screen.getByTestId('branch-menu')).getAllByRole('menuitem').length,
    ).toBeGreaterThan(0)
  })

  it('says nothing was modified recently in the file menu, as text rather than a menu item', async () => {
    renderHeader({ editedFiles: [] })

    await userEvent.click(screen.getByTestId('file-dropdown-button'))

    const note = await screen.findByText('No recently modified entries')
    expect(note.closest('[role="menuitem"]')).toBeNull()
    expect(screen.queryByText('<none>')).toBeNull()
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

describe('EditorHeader - status badge', () => {
  afterEach(() => {
    cleanup()
  })

  it('labels an editing branch "Editing"', () => {
    renderHeader({ branchStatus: 'editing' })
    const badge = screen.getByTestId('header-status-badge-editing')
    expect(badge.textContent).toBe('Editing')
    expect(badge.getAttribute('data-status')).toBe('editing')
  })

  it('labels a submitted branch "In review"', () => {
    renderHeader({ branchStatus: 'submitted', branchWriteBlocked: true })
    const badge = screen.getByTestId('header-status-badge-submitted')
    expect(badge.textContent).toBe('In review')
    expect(badge.getAttribute('data-status')).toBe('submitted')
  })

  it('labels the protected base branch "Protected" instead of its workflow status', () => {
    renderHeader({ branchStatus: 'editing', branchIsProtected: true, branchReadOnly: true })
    const badge = screen.getByTestId('header-status-badge-protected')
    expect(badge.textContent).toBe('Protected')
    expect(badge.getAttribute('data-status')).toBe('protected')
    expect(screen.queryByText('Editing')).toBeNull()
    expect(screen.queryByTestId('header-status-badge-editing')).toBeNull()
  })

  it('renders no badge while the branch status is unknown', () => {
    renderHeader({ branchStatus: undefined })
    expect(document.querySelector('[data-testid^="header-status-badge-"]')).toBeNull()
  })
})

describe('EditorHeader - comments indicator', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the unresolved count, ignoring resolved threads', () => {
    renderHeader({ comments: [{ resolved: false }, { resolved: true }, { resolved: false }] })
    expect(screen.getByTestId('comments-unresolved-count').textContent).toBe('2')
  })

  it('names the unresolved count on the button, and lets clicks pass through the count', () => {
    renderHeader({ comments: [{ resolved: false }, { resolved: false }] })
    expect(screen.getByRole('button', { name: 'Comments, 2 unresolved' })).toBeDefined()
    const count = screen.getByTestId('comments-unresolved-count').parentElement
    expect(count && getComputedStyle(count).pointerEvents).toBe('none')
  })

  it('shows no count when every thread is resolved', () => {
    renderHeader({ comments: [{ resolved: true }] })
    expect(screen.queryByTestId('comments-unresolved-count')).toBeNull()
    expect(screen.getByTestId('comments-button')).toBeDefined()
  })
})

describe('EditorHeader - unsaved indicator', () => {
  it('says unsaved changes are kept on this device', () => {
    renderHeader({ hasUnsavedChanges: true })
    expect(screen.getByTestId('unsaved-indicator').textContent).toBe(
      'Unsaved · kept on this device',
    )
  })

  it('says they are not kept when storing drafts failed', () => {
    renderHeader({ hasUnsavedChanges: true, draftStorageFailed: true })
    const indicator = screen.getByTestId('unsaved-indicator')
    expect(indicator.textContent).toContain('Unsaved · not kept on this device')
    // The tooltip's consequence is mouse-only, so the status text carries it too.
    expect(indicator.textContent).toContain("Save before you leave or reload, or they'll be lost.")
  })

  it('is absent with nothing unsaved', () => {
    renderHeader({ hasUnsavedChanges: false })
    expect(screen.queryByTestId('unsaved-indicator')).toBeNull()
  })
})

describe('EditorHeader - modified-file menus only select', () => {
  afterEach(() => {
    cleanup()
  })

  const editedFiles = [{ path: unsafeAsLogicalPath('posts/draft'), label: 'Draft post' }]

  it('opens the entry from "Recently modified" without opening the navigator', async () => {
    const onEntrySelect = vi.fn()
    const onNavigatorOpen = vi.fn()
    renderHeader({ editedFiles, modifiedCount: 1, onEntrySelect, onNavigatorOpen })

    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Draft post' }))

    expect(onEntrySelect).toHaveBeenCalledWith('posts/draft')
    expect(onNavigatorOpen).not.toHaveBeenCalled()
  })

  it('opens the entry from the branch menu without opening the navigator', async () => {
    const onEntrySelect = vi.fn()
    const onNavigatorOpen = vi.fn()
    renderHeader({ editedFiles, modifiedCount: 1, onEntrySelect, onNavigatorOpen })

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Draft post' }))

    expect(onEntrySelect).toHaveBeenCalledWith('posts/draft')
    expect(onNavigatorOpen).not.toHaveBeenCalled()
  })
})

describe('EditorHeader - vocabulary', () => {
  afterEach(() => {
    cleanup()
  })

  it('labels Save, and Submit for review with no ellipsis, with the shared verbs', () => {
    renderHeader({ userContext: { userId: 'u1' }, branchCreatedBy: 'u1' })

    expect(screen.getByTestId('save-button').textContent).toBe('Save')
    expect(screen.getByTestId('submit-button').textContent).toBe('Submit for review')
  })

  it('names the branch menu items with the shared vocabulary', async () => {
    renderHeader({ onBranchManagerOpen: vi.fn() })
    await userEvent.click(screen.getByTestId('branch-dropdown-button'))

    const menu = await screen.findByTestId('branch-menu')
    expect(menu.textContent).toContain('Reload all entries')
    expect(menu.textContent).toContain('Discard all changes')
    expect(screen.getByTestId('manage-branches-menu-item').textContent).toBe('Switch branch…')
    expect(menu.textContent).not.toContain('Manage Branches')
  })

  it('points the review-lock banner at Withdraw from review and the Switch branch… action', async () => {
    const onBranchManagerOpen = vi.fn()
    renderHeader({
      branchStatus: 'submitted',
      branchWriteBlocked: true,
      onBranchManagerOpen,
    })

    const banner = screen.getByTestId('status-locked-banner')
    expect(banner.textContent).toContain('Withdraw it from review to make changes.')
    await userEvent.click(within(banner).getByRole('button', { name: 'Switch branch…' }))
    expect(onBranchManagerOpen).toHaveBeenCalled()
  })

  it('offers the protected-branch banner the shared New branch… verb', async () => {
    const onBranchManagerOpen = vi.fn()
    renderHeader({
      branchStatus: 'editing',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
      onBranchManagerOpen,
    })

    const banner = screen.getByTestId('protected-branch-banner')
    await userEvent.click(within(banner).getByRole('button', { name: 'New branch…' }))
    expect(onBranchManagerOpen).toHaveBeenCalled()
  })

  it('points the unavailable-data banner at Switch branch… to retry', () => {
    renderHeader({ branchStatus: undefined, branchWriteBlocked: true })

    expect(screen.getByTestId('status-locked-banner').textContent).toContain(
      'Use Switch branch… to retry.',
    )
  })
})

describe('EditorHeader - blocked controls say why on focus and ignore their click', () => {
  afterEach(() => {
    cleanup()
  })

  it('keeps a blocked Save focusable, explains it on keyboard focus, and does not save', async () => {
    const onSave = vi.fn()
    renderHeader({ hasUnsavedChanges: false, onSave })
    const save = screen.getByTestId('save-button')

    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(save.hasAttribute('disabled')).toBe(false)
    act(() => save.focus())
    expect(document.activeElement).toBe(save)
    expect(await screen.findByText('No changes to save.')).toBeTruthy()

    await userEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('says on focus why Save is blocked with no entry open, and names the reason for the button', async () => {
    renderHeader({ currentEntry: undefined, hasUnsavedChanges: false })
    const save = screen.getByTestId('save-button')

    act(() => save.focus())
    const reason = await screen.findByText('Open an entry to save it.')
    expect(save.getAttribute('aria-describedby')).toBe(reason.closest('[role="tooltip"]')?.id)
  })

  it('shows no Save reason while a save is in flight', async () => {
    // Even one that would show the moment the save finishes.
    renderHeader({ busy: true, hasUnsavedChanges: false })
    act(() => screen.getByTestId('save-button').focus())

    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBe('true')
    await expect(screen.findByRole('tooltip', {}, { timeout: 300 })).rejects.toThrow()
  })

  it('gives the base-branch and in-review Save reasons a way forward', async () => {
    const { unmount } = renderHeader({ branchReadOnly: true })
    act(() => screen.getByTestId('save-button').focus())
    expect(
      await screen.findByText('The base branch is read-only. Create a branch to make changes.'),
    ).toBeTruthy()
    unmount()

    renderHeader({ branchStatus: 'submitted', branchWriteBlocked: true })
    act(() => screen.getByTestId('save-button').focus())
    expect(
      await screen.findByText('This branch is in review. Withdraw it to make changes.'),
    ).toBeTruthy()
  })

  it('points an approved branch to Withdraw, and unloadable branch details to a retry', async () => {
    const { unmount } = renderHeader({ branchStatus: 'approved', branchWriteBlocked: true })
    act(() => screen.getByTestId('save-button').focus())
    expect(
      await screen.findByText('This branch is approved. Withdraw it to make changes.'),
    ).toBeTruthy()
    unmount()

    renderHeader({ branchStatus: undefined, branchWriteBlocked: true })
    act(() => screen.getByTestId('save-button').focus())
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toBe(
      'Branch details could not be loaded. Use "Switch branch…" to retry.',
    )
  })

  it('keeps a Submit for review the user may not use focusable, explains it on focus, and ignores its click', async () => {
    const onSubmit = vi.fn()
    renderHeader({
      userContext: { userId: 'someone-else' },
      branchCreatedBy: 'u1',
      onSubmit,
    })
    const submit = screen.getByTestId('submit-button')

    expect(submit.getAttribute('aria-disabled')).toBe('true')
    expect(submit.hasAttribute('disabled')).toBe(false)
    act(() => submit.focus())
    expect(await screen.findByText(/do not have permission to submit/)).toBeTruthy()
    await userEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('saves from an enabled Save', async () => {
    const onSave = vi.fn()
    renderHeader({ hasUnsavedChanges: true, onSave })

    await userEvent.click(screen.getByTestId('save-button'))

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('shows why a menu item is blocked, keeps it in keyboard order, and does not run it', async () => {
    const onFileReload = vi.fn()
    renderHeader({ currentEntry: undefined, onFileReload })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))

    const reload = await screen.findByRole('menuitem', { name: /^Reload entry/ })
    expect(reload.getAttribute('aria-disabled')).toBe('true')
    expect(reload.hasAttribute('disabled')).toBe(false)
    expect(within(reload).getByText('Open an entry first.')).toBeTruthy()

    // Arrow keys move between blocked items: the menu skips neither.
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(reload)
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /^Discard changes/ }))
    await userEvent.keyboard('{ArrowUp}')
    await userEvent.keyboard('{Enter}')
    expect(onFileReload).not.toHaveBeenCalled()
    // The menu stays open, since nothing happened.
    expect(screen.queryByRole('menuitem', { name: /^Reload entry/ })).toBeTruthy()
  })

  it('speaks of the entry, not a file, in the entry menu', async () => {
    renderHeader({ currentEntry: undefined })
    const trigger = screen.getByTestId('file-dropdown-button')
    expect(trigger.textContent).toBe('No entry selected')
    await userEvent.click(trigger)

    expect(await screen.findByRole('menuitem', { name: /^Reload entry/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Discard changes/ })).toBeTruthy()
  })

  it('runs the same menu item once it can act', async () => {
    const onFileReload = vi.fn()
    renderHeader({ onFileReload })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))

    const reload = await screen.findByRole('menuitem', { name: 'Reload entry' })
    expect(reload.getAttribute('aria-disabled')).toBeNull()
    await userEvent.click(reload)

    expect(onFileReload).toHaveBeenCalledTimes(1)
  })
})
