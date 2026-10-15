import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { EditorHeader, type EditorHeaderProps } from './EditorHeader'
import { BranchLockBanner } from './BranchLockBanner'
import { CanopyCMSProvider } from '../theme'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'
import type { EditorEntry } from '../Editor'
import { RESERVED_GROUPS } from '../../authorization/helpers'

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CanopyCMSProvider>{children}</CanopyCMSProvider>
)

const currentEntry: EditorEntry = {
  path: unsafeAsLogicalPath('posts/hello'),
  contentId: unsafeAsContentId('abc123def456'),
  label: 'Hello',
  schema: [],
}

const defaultProps: EditorHeaderProps = {
  currentEntry,
  branchName: 'feature/x',
  operatingMode: 'prod',
  busy: false,
  breadcrumbSegments: [
    { label: 'All content' },
    { label: 'Posts', collectionPath: 'content/posts' },
  ],
  editedFiles: [],
  modifiedCount: 0,
  onNavigatorOpen: vi.fn(),
  onCollectionOpen: vi.fn(),
  onFileReload: vi.fn(),
  onFileDiscardDraft: vi.fn(),
  onEntryRename: vi.fn(),
  onEntryDelete: vi.fn(),
  onEntrySelect: vi.fn(),
  onBranchReloadData: vi.fn(),
  onBranchDiscardDrafts: vi.fn(),
  onBranchManagerOpen: vi.fn(),
  onSave: vi.fn(),
  onSaveAll: vi.fn(),
  saveAllProgress: null,
  onSubmit: vi.fn(),
  hasUnsavedChanges: true,
  branchStatus: 'editing',
  onWithdraw: vi.fn(),
}

/** The header with the lock banner Editor.tsx renders under it from the same branch props. */
const renderHeader = (overrides: Partial<EditorHeaderProps> = {}) => {
  const props = { ...defaultProps, ...overrides }
  return render(
    <>
      <EditorHeader {...props} />
      <BranchLockBanner {...props} />
    </>,
    { wrapper: Wrapper },
  )
}

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

describe('EditorHeader - locked-down branch', () => {
  afterEach(() => {
    cleanup()
  })

  const lockedProps = {
    branchStatus: 'submitted',
    branchIsProtected: false,
    branchCreatedBy: 'maker',
    branchAccess: { allowedUsers: ['maker', 'invited'], managerOrAdminAllowed: true },
  } satisfies Partial<EditorHeaderProps>

  it.each(['maker', 'invited'])('blocks Withdraw for %s, whom only the ACL admits', (userId) => {
    renderHeader({ ...lockedProps, userContext: { userId, groups: [] } })
    expect(screen.getByTestId('withdraw-button').getAttribute('aria-disabled')).toBe('true')
  })

  it.each([RESERVED_GROUPS.ADMINS, RESERVED_GROUPS.REVIEWERS])(
    'offers Withdraw to a member of %s',
    (group) => {
      renderHeader({ ...lockedProps, userContext: { userId: 'boss', groups: [group] } })
      expect(screen.getByTestId('withdraw-button').getAttribute('aria-disabled')).toBeNull()
    },
  )
})

describe('EditorHeader - branch pill unsaved count', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the unsaved count on the pill and names each entry in its menu', async () => {
    const onEntrySelect = vi.fn()
    renderHeader({
      modifiedCount: 2,
      editedFiles: [
        { path: unsafeAsLogicalPath('posts/a'), label: 'Post A' },
        { path: unsafeAsLogicalPath('posts/b'), label: 'Post B' },
      ],
      onEntrySelect,
    })
    // " unsaved" shows from `sm`; below it the pill is icon-only and the word is visually hidden.
    expect(screen.getByTestId('branch-unsaved-count').textContent).toBe('2 unsaved unsaved')

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))
    expect((await screen.findByTestId('discard-all-drafts-menu-item')).textContent).toBe(
      'Discard all changes (2 entries)',
    )
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Post B' }))
    expect(onEntrySelect).toHaveBeenCalledWith('posts/b')
  })

  it('shows no count with nothing unsaved', () => {
    renderHeader({ modifiedCount: 0, editedFiles: [] })
    expect(screen.queryByTestId('branch-unsaved-count')).toBeNull()
  })
})

describe('EditorHeader - branch menu with no edits', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the empty list as plain text that arrow keys skip, and blocks Discard all with a reason', async () => {
    const onBranchDiscardDrafts = vi.fn()
    renderHeader({ modifiedCount: 0, editedFiles: [], onBranchDiscardDrafts })

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))

    const empty = await screen.findByTestId('edited-entries-empty')
    expect(empty.textContent).toBe('No unsaved changes on this branch.')
    expect(empty.getAttribute('role')).toBeNull()
    expect(empty.hasAttribute('aria-disabled')).toBe(false)
    expect(screen.queryByText('0 unsaved')).toBeNull()

    screen.getByTestId('manage-branches-menu-item').focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(empty.contains(document.activeElement)).toBe(false)
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')

    const discard = screen.getByTestId('discard-all-drafts-menu-item')
    expect(discard.getAttribute('aria-disabled')).toBe('true')
    expect(discard.textContent).toBe('Discard all changesNothing to discard.')
    await userEvent.click(discard)
    expect(onBranchDiscardDrafts).not.toHaveBeenCalled()
  })
})

describe('EditorHeader - no leftover placeholder copy', () => {
  afterEach(() => {
    cleanup()
  })

  it('never renders the old TODO placeholder menu items', async () => {
    renderHeader()

    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    await screen.findByTestId('refresh-entry-menu-item')
    expect(document.body.textContent).not.toContain('TODO')

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))
    await screen.findByTestId('manage-branches-menu-item')
    expect(document.body.textContent).not.toContain('TODO')
  })
})

describe('EditorHeader - breadcrumb', () => {
  afterEach(() => {
    cleanup()
  })

  it('opens the content panel from "All content" and a collection from its crumb', async () => {
    const onNavigatorOpen = vi.fn()
    const onCollectionOpen = vi.fn()
    renderHeader({ onNavigatorOpen, onCollectionOpen })

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    await userEvent.click(within(nav).getByRole('button', { name: 'All content' }))
    expect(onNavigatorOpen).toHaveBeenCalledTimes(1)
    await userEvent.click(within(nav).getByRole('button', { name: 'Posts' }))
    expect(onCollectionOpen).toHaveBeenCalledWith('content/posts')
    expect(onNavigatorOpen).toHaveBeenCalledTimes(1)
  })

  it('marks the entry crumb current, with its unsaved state in its name', () => {
    renderHeader({ hasUnsavedChanges: true })
    const crumb = screen.getByTestId('file-dropdown-button')
    expect(crumb.getAttribute('aria-current')).toBe('page')
    expect(crumb.textContent).toContain('Hello')
    expect(crumb.textContent).toContain(', unsaved changes')
    expect(screen.getByTestId('entry-unsaved-dot')).toBeTruthy()
  })

  it('shows a slug folder as text that navigates nowhere', () => {
    renderHeader({
      breadcrumbSegments: [{ label: 'All content' }, { label: '2024', folder: true }],
    })
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(nav).getByText('2024').closest('button')).toBeNull()
  })

  it('offers "Refresh from server", "Discard changes", "Rename…" and "Delete entry" in the entry menu', async () => {
    const onFileReload = vi.fn()
    renderHeader({ onFileReload })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Refresh from server',
      'Discard changes',
      'Rename…',
      'Delete entry',
    ])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Refresh from server' }))
    expect(onFileReload).toHaveBeenCalled()
  })

  it.each([
    ['Rename…', 'onEntryRename'],
    ['Delete entry', 'onEntryDelete'],
  ] as const)('runs "%s" from the entry menu', async (name, handler) => {
    const run = vi.fn()
    renderHeader({ [handler]: run })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    await userEvent.click(await screen.findByRole('menuitem', { name }))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'an entry a path rule refuses',
      { entryReadOnly: true },
      "You don't have edit access to this entry.",
    ],
    [
      'an entry of an unknown type',
      { entryUnavailable: true },
      "This entry's content type isn't known to this editor version yet.",
    ],
  ])('blocks Rename… and Delete entry for %s, saying why', async (_what, props, reason) => {
    const onEntryRename = vi.fn()
    const onEntryDelete = vi.fn()
    renderHeader({ ...props, hasUnsavedChanges: false, onEntryRename, onEntryDelete })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    for (const id of ['entry-menu-rename', 'entry-menu-delete']) {
      const item = await screen.findByTestId(id)
      expect(item.getAttribute('aria-disabled')).toBe('true')
      expect(item.textContent).toContain(reason)
      await userEvent.click(item)
    }
    expect(onEntryRename).not.toHaveBeenCalled()
    expect(onEntryDelete).not.toHaveBeenCalled()
  })

  it('blocks Discard changes with a reason when the entry has no draft', async () => {
    const onFileDiscardDraft = vi.fn()
    renderHeader({ hasUnsavedChanges: false, onFileDiscardDraft })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    const discard = await screen.findByTestId('discard-file-draft-menu-item')
    expect(discard.textContent).toContain('This entry has no unsaved changes.')
    await userEvent.click(discard)
    expect(onFileDiscardDraft).not.toHaveBeenCalled()
  })

  it('still discards a draft the read-only form is not showing', async () => {
    const onFileDiscardDraft = vi.fn()
    renderHeader({
      hasUnsavedChanges: false,
      entryHasDraft: true,
      branchWriteBlocked: true,
      branchStatus: 'submitted',
      onFileDiscardDraft,
    })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    await userEvent.click(await screen.findByTestId('discard-file-draft-menu-item'))
    expect(onFileDiscardDraft).toHaveBeenCalled()
  })
})

describe('EditorHeader - read-only chip', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows on a locked branch, its reason in its accessible text', () => {
    renderHeader({ branchStatus: 'submitted', branchWriteBlocked: true })
    expect(screen.getByTestId('read-only-chip').textContent).toBe(
      'Read-only. This branch is in review. Withdraw it to make changes.',
    )
  })

  it('shows for an entry a path rule refuses this user', () => {
    renderHeader({ entryReadOnly: true })
    expect(screen.getByTestId('read-only-chip').textContent).toContain(
      "You don't have edit access to this entry.",
    )
  })

  it('is absent on an editable entry and branch', () => {
    renderHeader()
    expect(screen.queryByTestId('read-only-chip')).toBeNull()
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

describe('EditorHeader - unsaved indicator', () => {
  it('says unsaved changes are kept on this device', () => {
    renderHeader({ hasUnsavedChanges: true })
    // The text shows from `lg`, the icon below it; each form carries the text for assistive tech.
    const indicator = screen.getByTestId('unsaved-indicator')
    expect(indicator.textContent).toBe('Unsaved · kept on this deviceUnsaved · kept on this device')
    expect(indicator.querySelector('svg')).toBeTruthy()
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

    expect(screen.getByTestId('save-button')).toBe(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByTestId('submit-button').textContent).toBe('Submit for review')
  })

  it('names the branch menu items with the shared vocabulary', async () => {
    renderHeader({ onBranchManagerOpen: vi.fn() })
    await userEvent.click(screen.getByTestId('branch-dropdown-button'))

    const menu = await screen.findByTestId('branch-menu')
    expect(menu.textContent).toContain('Refresh branch')
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
    renderHeader({ branchName: '', hasUnsavedChanges: false, onFileReload })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))

    const refresh = await screen.findByRole('menuitem', { name: /^Refresh from server/ })
    expect(refresh.getAttribute('aria-disabled')).toBe('true')
    expect(refresh.hasAttribute('disabled')).toBe(false)
    expect(within(refresh).getByText('Open a branch first.')).toBeTruthy()

    // Arrow keys move between blocked items: the menu skips neither.
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(refresh)
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /^Discard changes/ }))
    await userEvent.keyboard('{ArrowUp}')
    await userEvent.keyboard('{Enter}')
    expect(onFileReload).not.toHaveBeenCalled()
    // The menu stays open, since nothing happened.
    expect(screen.queryByRole('menuitem', { name: /^Refresh from server/ })).toBeTruthy()
  })

  it('says no entry is open, with no entry menu to open', () => {
    renderHeader({ currentEntry: undefined, hasUnsavedChanges: false })
    const crumb = screen.getByTestId('file-dropdown-button')
    expect(crumb.textContent).toBe('No entry open')
    expect(crumb.closest('button')).toBeNull()
  })

  it('runs the same menu item once it can act', async () => {
    const onFileReload = vi.fn()
    renderHeader({ onFileReload })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))

    const refresh = await screen.findByRole('menuitem', { name: 'Refresh from server' })
    expect(refresh.getAttribute('aria-disabled')).toBeNull()
    await userEvent.click(refresh)

    expect(onFileReload).toHaveBeenCalledTimes(1)
  })
})

describe('EditorHeader - Save all', () => {
  afterEach(() => {
    cleanup()
  })

  const openSaveOptions = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Save options' }))
    return screen.findByTestId('save-all-menu-item')
  }

  it('offers Save all with the unsaved count, and runs it', async () => {
    const onSaveAll = vi.fn()
    renderHeader({ modifiedCount: 3, onSaveAll })
    const item = await openSaveOptions()
    expect(item.textContent).toBe('Save all (3)')
    await userEvent.click(item)
    expect(onSaveAll).toHaveBeenCalledTimes(1)
  })

  it('blocks Save all with a reason when nothing on the branch is unsaved', async () => {
    const onSaveAll = vi.fn()
    renderHeader({ modifiedCount: 0, hasUnsavedChanges: false, onSaveAll })
    const item = await openSaveOptions()
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain('No entry on this branch has unsaved changes.')
    await userEvent.click(item)
    expect(onSaveAll).not.toHaveBeenCalled()
  })

  it("blocks Save all on a locked branch with the lock's way forward", async () => {
    const onSaveAll = vi.fn()
    renderHeader({
      modifiedCount: 2,
      branchStatus: 'submitted',
      branchWriteBlocked: true,
      onSaveAll,
    })
    const item = await openSaveOptions()
    expect(item.textContent).toContain('This branch is in review. Withdraw it to make changes.')
    await userEvent.click(item)
    expect(onSaveAll).not.toHaveBeenCalled()
  })

  it("blocks Save all with a way to retry when the branch's entry list didn't load", async () => {
    const onSaveAll = vi.fn()
    renderHeader({ modifiedCount: 2, entryListFailed: true, onSaveAll })
    const item = await openSaveOptions()
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain('Use "Refresh branch" to try again.')
    await userEvent.click(item)
    expect(onSaveAll).not.toHaveBeenCalled()
  })

  it('shows progress on Save, blocks it, and announces the run once', async () => {
    const onSave = vi.fn()
    renderHeader({
      modifiedCount: 3,
      hasUnsavedChanges: false,
      busy: true,
      saveAllProgress: { done: 1, total: 3 },
      onSave,
    })
    const save = screen.getByTestId('save-button')
    expect(save.textContent).toBe('Saving 2 of 3…')
    expect(save.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
    const announced = screen
      .getAllByRole('status')
      .map((region) => region.textContent)
      .filter(Boolean)
    expect(announced).toEqual(['Saving 3 entries…'])
  })
})

describe('EditorHeader - Save says how it went', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const saveButton = () => screen.getByTestId('save-button')
  const renderSave = (props: Partial<EditorHeaderProps>) => {
    const view = render(<EditorHeader {...defaultProps} {...props} />, { wrapper: Wrapper })
    return (next: Partial<EditorHeaderProps>) =>
      view.rerender(<EditorHeader {...defaultProps} {...next} />)
  }
  const statuses = () =>
    screen
      .getAllByRole('status')
      .map((region) => region.textContent)
      .filter(Boolean)

  it('reads "Saving…" while the save is out, then "Saved" once, announced, and "Save" again', () => {
    vi.useFakeTimers()
    const rerender = renderSave({ busy: true, saving: true })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Saving…' }))
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')

    rerender({ hasUnsavedChanges: false, savedSignal: 1 })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Saved' }))
    // Readable, not greyed by disabled styling, though there is nothing left to save.
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    expect(saveButton().hasAttribute('data-disabled')).toBe(false)
    expect(statuses()).toEqual(['Saved'])

    act(() => vi.advanceTimersByTime(2000))
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
    expect(statuses()).toEqual([])
  })

  it('goes back to "Save" as soon as the entry changes again', () => {
    const rerender = renderSave({ hasUnsavedChanges: false, savedSignal: 0 })
    rerender({ hasUnsavedChanges: false, savedSignal: 1 })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Saved' }))
    rerender({ hasUnsavedChanges: true, savedSignal: 1 })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it('says nothing for a save that landed before it was shown', () => {
    renderHeader({ hasUnsavedChanges: false, savedSignal: 3 })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it('keeps one width whichever label shows', () => {
    renderHeader()
    const labels = saveButton().querySelectorAll('[style*="grid-area"]')
    expect([...labels].map((label) => label.textContent)).toEqual(['Save', 'Saving…', 'Saved'])
    expect([...labels].filter((label) => label.getAttribute('aria-hidden') === null)).toHaveLength(
      1,
    )
  })
})

describe('EditorHeader - emphasis', () => {
  afterEach(() => {
    cleanup()
  })

  it('fills Save and its caret as the one primary, and leaves Submit and Withdraw secondary', () => {
    renderHeader({ userContext: { userId: 'u1' }, branchCreatedBy: 'u1' })
    expect(screen.getByTestId('save-button').getAttribute('data-variant')).toBe('filled')
    expect(screen.getByTestId('save-options-button').getAttribute('data-variant')).toBe('filled')
    expect(screen.getByTestId('submit-button').getAttribute('data-variant')).toBe('light')
    cleanup()
    renderHeader({
      branchStatus: 'submitted',
      branchWriteBlocked: true,
      userContext: { userId: 'u1' },
      branchCreatedBy: 'u1',
    })
    expect(screen.getByTestId('withdraw-button').getAttribute('data-variant')).toBe('light')
  })
})

describe('EditorHeader - while branch details load', () => {
  afterEach(() => {
    cleanup()
  })

  it('names no lock and no status until they arrive', () => {
    renderHeader({ branchLoading: true, branchWriteBlocked: true, branchStatus: undefined })
    expect(screen.queryByTestId('read-only-chip')).toBeNull()
    expect(document.querySelector('[data-testid^="header-status-badge-"]')).toBeNull()
  })
})

describe('EditorHeader - during Save all', () => {
  afterEach(() => {
    cleanup()
  })

  it('says why Submit waits, and keeps the progress label out of disabled styling', async () => {
    renderHeader({
      busy: true,
      saveAllProgress: { done: 0, total: 2 },
      userContext: { userId: 'u1' },
      branchCreatedBy: 'u1',
    })
    const submit = screen.getByTestId('submit-button')
    expect(submit.getAttribute('aria-disabled')).toBe('true')
    await act(async () => {
      submit.focus()
    })
    expect(await screen.findByText('Wait for Save all to finish.')).toBeTruthy()

    const save = screen.getByTestId('save-button')
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(save.hasAttribute('data-disabled')).toBe(false)
  })

  it('holds Submit even when an entry load has cleared the shared busy flag', async () => {
    const onSubmit = vi.fn()
    renderHeader({
      busy: false,
      saveAllProgress: { done: 1, total: 3 },
      userContext: { userId: 'u1' },
      branchCreatedBy: 'u1',
      onSubmit,
    })
    const submit = screen.getByTestId('submit-button')
    expect(submit.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
