import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { EditorHeader, type EditorHeaderProps } from './EditorHeader'
import { EntryHeader, type EntryHeaderProps } from './EntryHeader'
import { UnsavedMark } from './UnsavedMark'
import { CanopyCMSProvider } from '../theme'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'
import type { EditorEntry } from '../Editor'
import type { BranchHold, BranchStatus } from '../../types'
import { RESERVED_GROUPS } from '../../authorization/helpers'

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CanopyCMSProvider>{children}</CanopyCMSProvider>
)

const currentEntry: EditorEntry = {
  path: unsafeAsLogicalPath('posts/hello'),
  contentId: unsafeAsContentId('abc123def456'),
  label: 'Hello',
  schema: [],
  previewSrc: '/posts/hello',
}

/** Both headers' props, as Editor.tsx passes them; the entry header's Save all flag follows. */
type HeadersProps = EditorHeaderProps & Omit<EntryHeaderProps, 'saveAllRunning'>

const defaultProps: HeadersProps = {
  currentEntry,
  branchName: 'feature/x',
  busy: false,
  breadcrumbSegments: [{ label: 'Posts', collectionPath: 'content/posts' }],
  modifiedCount: 0,
  onShowUnsaved: vi.fn(),
  onCollectionOpen: vi.fn(),
  onFileReload: vi.fn(),
  onFileDiscardDraft: vi.fn(),
  onEntryRename: vi.fn(),
  onEntryDelete: vi.fn(),
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

const Headers = (props: HeadersProps) => (
  <>
    <header data-canopy-region="topbar">
      <EditorHeader {...props} />
    </header>
    <EntryHeader {...props} saveAllRunning={!!props.saveAllProgress} />
  </>
)

/** The top bar and the entry header, as Editor.tsx renders them from one state. */
const renderHeader = (overrides: Partial<HeadersProps> = {}) =>
  render(<Headers {...defaultProps} {...overrides} />, { wrapper: Wrapper })

/** The branch bar's status element. */
const barStatus = () => screen.getByTestId('branch-status')

describe('EditorHeader - review lock', () => {
  afterEach(() => {
    cleanup()
  })

  // branchWriteBlocked is the server's own getBranchProtection() answer; the
  // Editor always passes it alongside branchStatus off the same BranchListItem,
  // so the two cannot diverge in practice.
  it('disables Save, says the branch is in review, and offers Withdraw when submitted', () => {
    renderHeader({
      branchStatus: 'submitted',
      branchWriteBlocked: true,
      userContext: { userId: 'u1' },
      branchCreatedBy: 'u1',
    })

    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBe('true')
    expect(barStatus().textContent).toBe('In review · read-only')
    expect(screen.getByTestId('withdraw-button').textContent).toBe('Withdraw from review')
  })

  it('enables Save and shows no status when editing with unsaved changes', () => {
    renderHeader({ branchStatus: 'editing', branchWriteBlocked: false, hasUnsavedChanges: true })

    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByTestId('branch-status')).toBeNull()
  })

  it('says "Protected · read-only", not a status lock, when branchReadOnly is set', () => {
    // The server sets writeBlocked on a read-only base branch too; readOnly is
    // what decides which lock the status names.
    renderHeader({
      branchStatus: 'editing',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
    })

    expect(barStatus().textContent).toBe('Protected · read-only')
    expect(screen.getByTestId('save-button').getAttribute('aria-disabled')).toBe('true')
  })

  it('names the protection, not the review, for a submitted base branch', () => {
    renderHeader({
      branchStatus: 'submitted',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
    })

    expect(barStatus().textContent).toBe('Protected · read-only')
  })

  it('never renders an unknown status into the bar when the branch is locked', () => {
    // The write lock now fails CLOSED while the branch list is unresolved
    // (Editor.tsx passes `writeBlocked ?? true`), but `branchStatus` comes from
    // the same unresolved `currentBranch` and is undefined in that window, so
    // interpolating it would read "undefined" after every failed branches fetch.
    //
    // Asserted as "the word undefined never appears", not just "some other copy
    // is shown": the point is that no interpolation of a missing value can leak
    // into user-facing text here, however the copy is later reworded.
    renderHeader({ branchStatus: undefined, branchWriteBlocked: true })

    expect(barStatus().textContent).not.toMatch(/undefined/)
    expect(barStatus().textContent).toBe('Details unavailable · read-only')
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

  it('still names a KNOWN status in the bar', () => {
    // Guards the fix from over-reaching: only the unknown case gets the new
    // copy, so a real status lock keeps saying which status locked it.
    renderHeader({ branchStatus: 'archived', branchWriteBlocked: true })

    expect(barStatus().textContent).toBe('Archived · read-only')
  })

  it('treats a status-lock that contradicts a known "editing" status as unavailable data, not a real lock', () => {
    // Version skew: an old server that omits `writeBlocked` while still
    // sending `status: 'editing'` would otherwise read "Editing · read-only".
    // `branchDataUnavailable` covers branchStatus === 'editing' under a status
    // lock, so this renders the honest data-unavailable copy instead.
    renderHeader({
      branchWriteBlocked: true,
      branchReadOnly: false,
      branchStatus: 'editing',
    })

    expect(barStatus().textContent).toBe('Details unavailable · read-only')
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
  } satisfies Partial<HeadersProps>

  it.each(['maker', 'invited'])('blocks Withdraw for %s, whom only the ACL admits', (userId) => {
    renderHeader({ ...lockedProps, userContext: { userId, groups: [] } })
    expect(screen.getByTestId('withdraw-button').getAttribute('aria-disabled')).toBe('true')
  })

  it.each([RESERVED_GROUPS.ADMINS, RESERVED_GROUPS.REVIEWERS])(
    'offers Approve and Request changes to a member of %s, whom the lockdown still admits',
    (group) => {
      renderHeader({ ...lockedProps, userContext: { userId: 'boss', groups: [group] } })
      expect(screen.getByTestId('approve-button').getAttribute('aria-disabled')).toBeNull()
      expect(screen.getByTestId('request-changes-button').getAttribute('aria-disabled')).toBeNull()
    },
  )
})

describe('EditorHeader - branch pill unsaved count', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the branch name at every width, and heads its menu with it', async () => {
    renderHeader()
    const pill = screen.getByTestId('branch-dropdown-button')
    const name = within(pill).getByText('feature/x')
    // No breakpoint hides it, and it is no visually hidden stand-in.
    expect(name.className).not.toMatch(/visible-from|hidden-from|VisuallyHidden/)
    await userEvent.click(pill)
    const label = within(await screen.findByTestId('branch-menu')).getByText('feature/x')
    expect(label.className).toMatch(/Menu-label/)
    expect(label.className).not.toMatch(/hidden-from/)
  })

  it('shows the unsaved count in the bar, apart from the pill, and lists them on click', async () => {
    const onShowUnsaved = vi.fn()
    renderHeader({ modifiedCount: 2, onShowUnsaved })
    const count = screen.getByTestId('branch-unsaved-count')
    expect(count).toBe(screen.getByRole('button', { name: '2 unsaved' }))
    expect(count.closest('[data-canopy-region="topbar"]')).not.toBeNull()
    expect(screen.getByTestId('branch-dropdown-button').contains(count)).toBe(false)
    expect(within(screen.getByTestId('branch-dropdown-button')).queryByText(/\b2\b/)).toBeNull()

    act(() => count.focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Show unsaved entries in the content panel',
    )
    await userEvent.click(count)
    expect(onShowUnsaved).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))
    expect((await screen.findByTestId('discard-all-drafts-menu-item')).textContent).toBe(
      'Discard all changes (2 entries)',
    )
  })

  describe('on a locked branch, says why the unsaved edits wait and what lets them be saved', () => {
    const creator = { userContext: { userId: 'u1' }, branchCreatedBy: 'u1' }
    const locks: Array<[string, Partial<HeadersProps>, string]> = [
      [
        'in review',
        { branchStatus: 'submitted', branchWriteBlocked: true, ...creator },
        'Withdraw to save them.',
      ],
      [
        'approved',
        { branchStatus: 'approved', branchWriteBlocked: true, ...creator },
        'Withdraw to save them.',
      ],
      [
        'in review, for someone who may not withdraw',
        { branchStatus: 'submitted', branchWriteBlocked: true, userContext: { userId: 'u2' } },
        'They can be saved once the branch is editable again.',
      ],
      [
        'protected and read-only',
        { branchReadOnly: true, branchWriteBlocked: true, branchIsProtected: true },
        "This branch won't become editable, so they can only be discarded.",
      ],
      [
        'archived',
        { branchStatus: 'archived', branchWriteBlocked: true },
        "This branch won't become editable, so they can only be discarded.",
      ],
      [
        'of an unknown status',
        { branchStatus: 'frozen' as BranchStatus, branchWriteBlocked: true },
        'They can be saved once the branch is editable again.',
      ],
      [
        'not available',
        { branchStatus: undefined, branchWriteBlocked: true, branchMissing: true },
        "They can't be saved unless this branch is available to you.",
      ],
      [
        'with details unavailable',
        { branchStatus: undefined, branchWriteBlocked: true },
        'Use "Refresh branch" to load its details.',
      ],
    ]
    it.each(locks)('%s', async (_name, lock, wayForward) => {
      const onShowUnsaved = vi.fn()
      for (const [count, edits] of [
        [1, '1 unsaved edit in this browser.'],
        [12, '12 unsaved edits in this browser.'],
      ] as const) {
        renderHeader({ ...lock, modifiedCount: count, onShowUnsaved })
        const button = screen.getByTestId('branch-unsaved-count')
        act(() => button.focus())
        expect((await screen.findByRole('tooltip')).textContent).toBe(`${edits} ${wayForward}`)
        await userEvent.click(button)
        cleanup()
      }
      expect(onShowUnsaved).toHaveBeenCalledTimes(2)
    })

    it('keeps the editable wording while the branch is loading or protected but writable', async () => {
      for (const lock of [
        { branchStatus: undefined, branchWriteBlocked: true, branchPending: true },
        { branchServerProtected: true, branchIsProtected: true },
      ]) {
        renderHeader({ ...lock, modifiedCount: 3 })
        act(() => screen.getByTestId('branch-unsaved-count').focus())
        expect((await screen.findByRole('tooltip')).textContent).toBe(
          'Show unsaved entries in the content panel',
        )
        cleanup()
      }
    })
  })

  it('draws the count and the breadcrumb dot as the same mark as the tree', () => {
    renderHeader({ modifiedCount: 1, hasUnsavedChanges: true })
    const reference = within(
      render(<UnsavedMark data-testid="reference-mark" />, { wrapper: Wrapper }).container,
    ).getByTestId('reference-mark')
    const style = reference.getAttribute('style')
    expect(style).toContain('--canopy-unsaved-mark')
    const countDot = screen
      .getByTestId('branch-unsaved-count')
      .querySelector('[aria-hidden="true"]:empty')
    expect(countDot?.getAttribute('style')).toBe(style)
    expect(screen.getByTestId('entry-unsaved-dot').getAttribute('style')).toBe(style)
  })

  it('shows no count with nothing unsaved', () => {
    renderHeader({ modifiedCount: 0 })
    expect(screen.queryByTestId('branch-unsaved-count')).toBeNull()
  })
})

describe('EditorHeader - branch menu', () => {
  afterEach(() => {
    cleanup()
  })

  it('holds the branch actions only, not the unsaved entries', async () => {
    renderHeader({ modifiedCount: 1 })
    await userEvent.click(screen.getByTestId('branch-dropdown-button'))
    const menu = await screen.findByTestId('branch-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Switch branch…', 'Refresh branch', 'Discard all changes (1 entry)'])
    expect(within(menu).queryByText('Unsaved changes')).toBeNull()
  })

  it('blocks Discard all with a reason when nothing is unsaved', async () => {
    const onBranchDiscardDrafts = vi.fn()
    renderHeader({ modifiedCount: 0, onBranchDiscardDrafts })

    await userEvent.click(screen.getByTestId('branch-dropdown-button'))
    const discard = await screen.findByTestId('discard-all-drafts-menu-item')
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

  it('starts with the collection crumb, which opens its collection', async () => {
    const onCollectionOpen = vi.fn()
    renderHeader({ onCollectionOpen })

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    const crumbs = within(nav).getAllByRole('listitem')
    expect(crumbs).toHaveLength(2)
    expect(crumbs[0].textContent).toBe('Posts')
    expect(crumbs[1].textContent).toContain('Hello')
    await userEvent.click(within(nav).getByRole('button', { name: 'Posts' }))
    expect(onCollectionOpen).toHaveBeenCalledWith('content/posts')
  })

  it('shows a root entry as its crumb alone, with no separator before it', () => {
    renderHeader({ breadcrumbSegments: [] })
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(nav).getAllByRole('listitem')).toHaveLength(1)
    const separators = within(nav)
      .getByRole('listitem')
      .querySelectorAll('svg.tabler-icon-chevron-right')
    expect(separators.length).toBe(0)
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
      breadcrumbSegments: [{ label: '2024', folder: true }],
    })
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(nav).getByText('2024').closest('button')).toBeNull()
  })

  it('offers "Refresh from server", "Discard changes", "Change URL…" and "Delete entry" in the entry menu', async () => {
    const onFileReload = vi.fn()
    renderHeader({ onFileReload })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Refresh from server',
      'Discard changes',
      'Change URL…',
      'Delete entry',
    ])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Refresh from server' }))
    expect(onFileReload).toHaveBeenCalled()
  })

  it('offers "Change slug…" for an entry with no page', async () => {
    renderHeader({ currentEntry: { ...currentEntry, previewSrc: undefined } })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    expect((await screen.findByTestId('entry-menu-rename')).textContent).toBe('Change slug…')
  })

  it.each([
    ['Change URL…', 'onEntryRename'],
    ['Delete entry', 'onEntryDelete'],
  ] as const)('runs "%s" from the entry menu', async (name, handler) => {
    const run = vi.fn()
    renderHeader({ [handler]: run })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    await userEvent.click(await screen.findByRole('menuitem', { name }))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('hides Change URL… and Delete entry for an entry a path rule refuses, as the tree does', async () => {
    renderHeader({ entryReadOnly: true, hasUnsavedChanges: false })
    await userEvent.click(screen.getByTestId('file-dropdown-button'))
    await screen.findByTestId('refresh-entry-menu-item')
    expect(screen.queryByTestId('entry-menu-rename')).toBeNull()
    expect(screen.queryByTestId('entry-menu-delete')).toBeNull()
  })

  it.each([
    [
      'a branch in review',
      { branchStatus: 'submitted' as const, branchWriteBlocked: true },
      'This branch is in review. Withdraw it to make changes.',
    ],
    [
      'an entry of an unknown type',
      { entryUnavailable: true },
      "This entry's content type isn't known to this editor version yet.",
    ],
  ])('blocks Change URL… and Delete entry for %s, saying why', async (_what, props, reason) => {
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

  it("is hidden while the bar's status already says the branch is locked", () => {
    renderHeader({ branchStatus: 'submitted', branchWriteBlocked: true })
    expect(barStatus().textContent).toBe('In review · read-only')
    expect(screen.queryByTestId('read-only-chip')).toBeNull()
  })

  it('is hidden on the protected base branch too', () => {
    renderHeader({ branchReadOnly: true, branchWriteBlocked: true, branchIsProtected: true })
    expect(barStatus().textContent).toBe('Protected · read-only')
    expect(screen.queryByTestId('read-only-chip')).toBeNull()
  })

  it("stays for an entry read-only for its own reason on a locked branch, giving that reason, not the branch's", () => {
    renderHeader({ entryReadOnly: true, branchStatus: 'approved', branchWriteBlocked: true })
    expect(barStatus().textContent).toBe('Approved · read-only')
    const chip = screen.getByTestId('read-only-chip')
    expect(chip.textContent).toContain("You don't have edit access to this entry.")
    expect(chip.textContent).not.toContain('Withdraw it')
  })

  it('stays for an entry alone being read-only on a branch that takes writes', () => {
    renderHeader({ entryReadOnly: true })
    expect(screen.queryByTestId('branch-status')).toBeNull()
    expect(screen.getByTestId('read-only-chip')).toBeTruthy()
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

describe('EditorHeader - branch status', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows no status for the default editing state', () => {
    renderHeader({ branchStatus: 'editing' })
    expect(screen.queryByTestId('branch-status')).toBeNull()
    expect(screen.getByTestId('branch-dropdown-button').textContent).not.toContain('Editing')
  })

  it.each([
    ['submitted', 'In review · read-only'],
    ['approved', 'Approved · read-only'],
    ['archived', 'Archived · read-only'],
  ] as const)('labels a %s branch "%s", with a lock', (status, label) => {
    renderHeader({ branchStatus: status, branchWriteBlocked: true })
    expect(barStatus().textContent).toBe(label)
    expect(barStatus().getAttribute('data-status')).toBe(status)
    expect(barStatus().querySelector('svg')).not.toBeNull()
  })

  it('names a status this editor does not know as itself', () => {
    renderHeader({ branchStatus: 'merged' as BranchStatus, branchWriteBlocked: true })
    expect(barStatus().textContent).toBe('Merged · read-only')
  })

  it('sits beside the pill, outside it', () => {
    renderHeader({ branchStatus: 'submitted', branchWriteBlocked: true })
    const pill = screen.getByTestId('branch-dropdown-button')
    expect(pill.contains(barStatus())).toBe(false)
    expect(pill.textContent).not.toContain('In review')
  })

  it('says "Protected", with no lock, for a protected branch that takes writes, as in dev', () => {
    renderHeader({ branchIsProtected: true, branchServerProtected: true })
    expect(barStatus().textContent).toBe('Protected')
    expect(barStatus().querySelector('svg')).toBeNull()
    expect(screen.getByTestId('save-all-button')).toBeTruthy()
  })

  it("names no protection the server didn't report, though Submit stays hidden", () => {
    renderHeader({ branchIsProtected: true, branchServerProtected: undefined })
    expect(screen.queryByTestId('branch-status')).toBeNull()
    expect(screen.queryByTestId('submit-button')).toBeNull()
  })

  it('says "Loading branch…" while the details are fetched, offering no way forward yet', () => {
    renderHeader({
      branchStatus: undefined,
      branchLoading: true,
      branchPending: true,
      branchWriteBlocked: true,
    })
    expect(barStatus().textContent).toBe('Loading branch…')
    expect(screen.queryByTestId('switch-branch-button')).toBeNull()
  })

  it('announces a lock that arrives, from a status region that was already there', () => {
    const props: HeadersProps = { ...defaultProps }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    const regions = screen.getAllByRole('status')
    rerender(<Headers {...props} branchStatus="submitted" branchWriteBlocked />)
    const region = barStatus().closest('[role="status"]')
    expect(region).not.toBeNull()
    expect(regions).toContain(region)
  })

  it("says the entry's Save waits for the branch details while they load", async () => {
    renderHeader({
      branchStatus: undefined,
      branchLoading: true,
      branchPending: true,
      branchWriteBlocked: true,
    })
    act(() => screen.getByTestId('save-button').focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Wait for the branch details to load.',
    )
  })

  it('says Save all waits for the branch details while they load, not that they failed', async () => {
    renderHeader({
      branchStatus: undefined,
      branchLoading: true,
      branchPending: true,
      branchWriteBlocked: true,
      modifiedCount: 1,
    })
    act(() => screen.getByTestId('save-all-button').focus())
    expect(await screen.findByText('Wait for the branch details to load.')).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
  })

  it('says the details are unavailable once the fetch has failed', () => {
    renderHeader({ branchStatus: undefined, branchLoading: true, branchWriteBlocked: true })
    expect(barStatus().textContent).toBe('Details unavailable · read-only')
  })
})

describe('EditorHeader - unsaved changes kept on this device', () => {
  afterEach(() => {
    cleanup()
  })

  const KEPT = 'Unsaved changes are kept on this device until you save.'

  it("keeps the bar free of device text, and says it in Save's description", () => {
    renderHeader({ hasUnsavedChanges: true })
    expect(screen.queryByTestId('unsaved-indicator')).toBeNull()
    for (const region of screen.getAllByRole('status')) {
      expect(region.textContent).not.toContain('kept on this device')
    }
    const save = screen.getByTestId('save-button')
    const description = document.getElementById(save.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe(KEPT)
    // Hidden, so browse mode doesn't read it a second time beside the description.
    expect(description?.hasAttribute('hidden')).toBe(true)
  })

  it("shows it in Save's Tooltip on focus, for keyboard users", async () => {
    renderHeader({ hasUnsavedChanges: true })
    act(() => screen.getByTestId('save-button').focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe(KEPT)
  })

  it('says nothing about the device with nothing unsaved', () => {
    renderHeader({ hasUnsavedChanges: false })
    expect(screen.getByTestId('save-button').hasAttribute('aria-describedby')).toBe(false)
    expect(document.body.textContent).not.toContain('kept on this device')
  })

  it('leaves a blocked Save to its reason', async () => {
    renderHeader({ hasUnsavedChanges: true, branchStatus: 'submitted', branchWriteBlocked: true })
    const save = screen.getByTestId('save-button')
    expect(save.hasAttribute('aria-describedby')).toBe(false)
    act(() => save.focus())
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain('This branch is in review.')
    // The Tooltip's own description, which an explicit `aria-describedby={undefined}` would drop.
    expect(save.getAttribute('aria-describedby')).toBe(tooltip.id)
  })

  it('keeps a warning in the top bar when storing drafts failed', () => {
    renderHeader({ hasUnsavedChanges: true, modifiedCount: 1, draftStorageFailed: true })
    const indicator = screen.getByTestId('unsaved-indicator')
    expect(indicator.textContent).toContain('Unsaved · not kept on this device')
    // The tooltip's consequence is mouse-only, so the status text carries it too.
    expect(indicator.textContent).toContain("Save before you leave or reload, or they'll be lost.")
    expect(indicator.querySelector('svg')).toBeTruthy()
    expect(indicator.getAttribute('style')).toContain('var(--canopy-danger-text)')
    // Nothing is kept, so Save does not claim it.
    expect(screen.getByTestId('save-button').hasAttribute('aria-describedby')).toBe(false)
    expect(document.body.textContent).not.toContain(KEPT)
  })

  it('warns for unsaved changes on another entry, the open one clean', () => {
    renderHeader({ hasUnsavedChanges: false, modifiedCount: 2, draftStorageFailed: true })
    expect(screen.getByTestId('unsaved-indicator').textContent).toContain(
      'Unsaved · not kept on this device',
    )
  })

  it('sits in the top bar, not in the entry header', () => {
    renderHeader({ hasUnsavedChanges: true, modifiedCount: 1, draftStorageFailed: true })
    const indicator = screen.getByTestId('unsaved-indicator')
    expect(indicator.closest('[data-canopy-region="topbar"]')).not.toBeNull()
    expect(screen.getByRole('region', { name: 'Entry' }).contains(indicator)).toBe(false)
  })

  it('shows no warning with nothing unsaved on the branch', () => {
    renderHeader({ hasUnsavedChanges: false, modifiedCount: 0, draftStorageFailed: true })
    expect(screen.queryByTestId('unsaved-indicator')).toBeNull()
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

  it('offers Withdraw from review alone as the way forward from a branch in review', () => {
    renderHeader({ branchStatus: 'submitted', branchWriteBlocked: true })

    expect(screen.getByTestId('withdraw-button').textContent).toBe('Withdraw from review')
    expect(screen.queryByTestId('switch-branch-button')).toBeNull()
    expect(screen.queryByTestId('new-branch-button')).toBeNull()
  })

  it('leaves a Withdraw the user may not take as the only workflow control, with no Switch branch… beside it', () => {
    renderHeader({
      branchStatus: 'submitted',
      branchWriteBlocked: true,
      userContext: { userId: 'someone-else' },
      branchCreatedBy: 'u1',
    })

    expect(screen.getByTestId('withdraw-button').getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByTestId('switch-branch-button')).toBeNull()
  })

  it('offers the protected base branch the shared New branch… verb', async () => {
    const onBranchManagerOpen = vi.fn()
    renderHeader({
      branchStatus: 'editing',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
      onBranchManagerOpen,
    })

    await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
    expect(onBranchManagerOpen).toHaveBeenCalled()
    expect(screen.queryByTestId('switch-branch-button')).toBeNull()
  })

  it.each([
    ['a branch the list answered without', { branchStatus: undefined, branchMissing: true }],
    ['an archived branch', { branchStatus: 'archived' as const }],
  ])('offers Switch branch… from %s', async (_label, overrides) => {
    const onBranchManagerOpen = vi.fn()
    renderHeader({ ...overrides, branchWriteBlocked: true, onBranchManagerOpen })

    await userEvent.click(screen.getByRole('button', { name: 'Switch branch…' }))
    expect(onBranchManagerOpen).toHaveBeenCalled()
    expect(screen.queryByTestId('refresh-branch-button')).toBeNull()
  })

  it('offers Refresh branch, not Switch branch…, when branch details failed to load', async () => {
    const onBranchReloadData = vi.fn()
    const onBranchManagerOpen = vi.fn()
    renderHeader({
      branchStatus: undefined,
      branchWriteBlocked: true,
      onBranchReloadData,
      onBranchManagerOpen,
    })

    expect(barStatus().textContent).toBe('Details unavailable · read-only')
    expect(screen.queryByTestId('switch-branch-button')).toBeNull()
    await userEvent.click(screen.getByTestId('refresh-branch-button'))
    expect(onBranchReloadData).toHaveBeenCalledTimes(1)
    expect(onBranchManagerOpen).not.toHaveBeenCalled()
  })

  it('opens the new-branch form from the bar, not Branches alone', async () => {
    const onNewBranch = vi.fn()
    const onBranchManagerOpen = vi.fn()
    renderHeader({
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
      onNewBranch,
      onBranchManagerOpen,
    })

    await userEvent.click(screen.getByTestId('new-branch-button'))
    expect(onNewBranch).toHaveBeenCalledTimes(1)
    expect(onBranchManagerOpen).not.toHaveBeenCalled()
  })

  it('tells assistive technology the status in words, with its reason, and nothing while loading', () => {
    const props: HeadersProps = { ...defaultProps }
    const { rerender } = render(
      <Headers {...props} branchStatus="submitted" branchWriteBlocked />,
      {
        wrapper: Wrapper,
      },
    )
    const region = barStatus().closest('[role="status"]') as HTMLElement
    expect(barStatus().getAttribute('aria-hidden')).toBe('true')
    expect(region.textContent).toContain(
      'In review, read-only. This branch is in review. Withdraw it to make changes.',
    )
    rerender(
      <Headers
        {...props}
        branchStatus={undefined}
        branchLoading
        branchPending
        branchWriteBlocked
        branchIsProtected
      />,
    )
    expect(barStatus().textContent).toBe('Loading branch…')
    expect(region.textContent).toBe('Loading branch…')
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
      'Branch details could not be loaded. Use "Refresh branch" to try again.',
    )
  })

  it('tells someone the list answered without the branch that no retry will help', async () => {
    renderHeader({ branchStatus: undefined, branchWriteBlocked: true, branchMissing: true })
    act(() => screen.getByTestId('save-button').focus())
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toBe(
      `You don't have access to this branch, or it no longer exists. Use "Switch branch…" to open another.`,
    )
  })

  describe('a held branch', () => {
    const author = { userId: 'u1' }

    it('says so on an editable branch, where nothing else would', () => {
      renderHeader({ branchHold: { kind: 'rewritten' } })

      expect(screen.getByTestId('branch-hold-status').textContent).toBe('Needs action')
      expect(screen.queryByTestId('branch-status')).toBeNull()
    })

    it('says so beside the lock of a branch in review, in words anyone can reach', async () => {
      renderHeader({
        branchStatus: 'submitted',
        branchWriteBlocked: true,
        branchHold: { kind: 'conflicts' },
        userContext: author,
        branchCreatedBy: 'u1',
      })

      expect(barStatus().textContent).toBe('In review · read-only')
      const badge = screen.getByTestId('branch-hold-status')
      const trigger = badge.closest('[aria-describedby]') as HTMLElement
      expect(trigger.tabIndex).toBe(0)
      act(() => trigger.focus())
      const detail = document.getElementById(trigger.getAttribute('aria-describedby') ?? '')
      expect(detail?.textContent).toContain('Use "Withdraw from review"')
      expect(detail?.closest('[role="status"]')).toBeTruthy()
    })

    it("speaks a reviewer's way forward, not an author's", () => {
      renderHeader({
        branchStatus: 'submitted',
        branchWriteBlocked: true,
        branchHold: { kind: 'conflicts' },
        userContext: { userId: 'r', groups: [RESERVED_GROUPS.REVIEWERS] },
        branchCreatedBy: 'u1',
      })

      const status = screen.getByTestId('branch-hold-status').closest('[role="status"]')
      expect(status?.textContent).toContain('Use "Request changes"')
    })

    it('keeps Withdraw on a rewritten branch in review: it is the way back to editing', () => {
      renderHeader({
        branchStatus: 'submitted',
        branchWriteBlocked: true,
        branchHold: { kind: 'rewritten' },
        userContext: author,
        branchCreatedBy: 'u1',
      })

      expect(screen.getByTestId('withdraw-button').getAttribute('aria-disabled')).toBeNull()
    })

    it('treats a reviewer the branch was shared with as its editor, as the card does', () => {
      renderHeader({
        branchStatus: 'submitted',
        branchWriteBlocked: true,
        branchHold: { kind: 'conflicts' },
        userContext: { userId: 'r', groups: [RESERVED_GROUPS.REVIEWERS] },
        branchCreatedBy: 'u1',
        branchAccess: { allowedUsers: ['r'] },
      })

      const status = screen.getByTestId('branch-hold-status').closest('[role="status"]')
      expect(status?.textContent).toContain('Use "Withdraw from review"')
    })

    it('waits for the branch to load', () => {
      renderHeader({ branchHold: { kind: 'rewritten' }, branchPending: true })

      expect(screen.queryByTestId('branch-hold-status')).toBeNull()
    })

    it.each([
      [undefined, /until an admin sorts out/],
      [[RESERVED_GROUPS.ADMINS], /until the changes made to it on GitHub/],
    ])('blocks Submit on a rewritten branch with a reason for %s', async (groups, reason) => {
      const onSubmit = vi.fn()
      renderHeader({
        branchHold: { kind: 'rewritten' },
        userContext: { userId: 'u1', groups },
        branchCreatedBy: 'u1',
        onSubmit,
      })
      const submit = screen.getByTestId('submit-button')

      expect(submit.getAttribute('aria-disabled')).toBe('true')
      act(() => submit.focus())
      expect(await screen.findByText(reason)).toBeTruthy()
      await userEvent.click(submit)
      expect(onSubmit).not.toHaveBeenCalled()
    })
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

describe('EditorHeader - entry header', () => {
  afterEach(() => {
    cleanup()
  })

  it("holds the entry's breadcrumb, menu, chip and Save, and leaves the branch's controls to the top bar", () => {
    renderHeader({ entryReadOnly: true, modifiedCount: 1 })
    const header = screen.getByRole('region', { name: 'Entry' })
    for (const testId of ['file-dropdown-button', 'read-only-chip', 'save-button']) {
      expect(header.contains(screen.getByTestId(testId))).toBe(true)
    }
    for (const testId of ['save-all-button', 'submit-button', 'branch-dropdown-button']) {
      expect(header.contains(screen.getByTestId(testId))).toBe(false)
    }
  })

  it('shows a placeholder crumb, and no reason on Save, while the entry is still loading', async () => {
    renderHeader({ currentEntry: undefined, entryLoading: true, hasUnsavedChanges: false })
    expect(screen.getByTestId('entry-crumb-loading')).toBeTruthy()
    expect(screen.queryByText('No entry open')).toBeNull()
    const save = screen.getByTestId('save-button')
    expect(save.getAttribute('aria-disabled')).toBe('true')
    act(() => save.focus())
    await expect(screen.findByRole('tooltip', {}, { timeout: 300 })).rejects.toThrow()
  })

  it('keeps Save in place, blocked, with no entry open', () => {
    renderHeader({ currentEntry: undefined, hasUnsavedChanges: false })
    const save = within(screen.getByRole('region', { name: 'Entry' })).getByTestId('save-button')
    expect(save.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('EditorHeader - Save all', () => {
  afterEach(() => {
    cleanup()
  })

  const saveAll = () => screen.getByTestId('save-all-button')
  const focusReason = async () => {
    act(() => saveAll().focus())
    return (await screen.findByRole('tooltip')).textContent
  }

  it('offers Save all in the top bar, the count left to the bar, and runs it', async () => {
    const onSaveAll = vi.fn()
    renderHeader({ modifiedCount: 3, onSaveAll })
    expect(saveAll()).toBe(screen.getByRole('button', { name: 'Save all' }))
    await userEvent.click(saveAll())
    expect(onSaveAll).toHaveBeenCalledTimes(1)
  })

  it('blocks Save all with a reason when nothing on the branch is unsaved', async () => {
    const onSaveAll = vi.fn()
    renderHeader({ modifiedCount: 0, hasUnsavedChanges: false, onSaveAll })
    expect(saveAll().getAttribute('aria-disabled')).toBe('true')
    expect(await focusReason()).toBe('No entry on this branch has unsaved changes.')
    await userEvent.click(saveAll())
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
    expect(await focusReason()).toBe('This branch is in review. Withdraw it to make changes.')
    await userEvent.click(saveAll())
    expect(onSaveAll).not.toHaveBeenCalled()
  })

  it("blocks Save all with a way to retry when the branch's entry list didn't load", async () => {
    const onSaveAll = vi.fn()
    renderHeader({ modifiedCount: 2, entryListFailed: true, onSaveAll })
    expect(saveAll().getAttribute('aria-disabled')).toBe('true')
    expect(await focusReason()).toContain(
      'Choose "Refresh branch" in the branch menu to try again.',
    )
    await userEvent.click(saveAll())
    expect(onSaveAll).not.toHaveBeenCalled()
  })

  it("waits for a save in flight on any entry, the open one's or another's", async () => {
    const onSaveAll = vi.fn()
    renderHeader({ modifiedCount: 2, singleSaving: true, saving: false, onSaveAll })
    expect(saveAll().getAttribute('aria-disabled')).toBe('true')
    expect(await focusReason()).toBe('Wait for the save to finish.')
    await userEvent.click(saveAll())
    expect(onSaveAll).not.toHaveBeenCalled()
  })

  it('shows progress on Save all, blocks both buttons, and announces the run once', async () => {
    const onSave = vi.fn()
    const onSaveAll = vi.fn()
    renderHeader({
      modifiedCount: 3,
      hasUnsavedChanges: true,
      busy: true,
      saveAllProgress: { done: 1, total: 3 },
      onSave,
      onSaveAll,
    })
    expect(saveAll()).toBe(screen.getByRole('button', { name: 'Saving 2 of 3…' }))
    expect(saveAll().querySelector('[style*="grid-area"]:not([aria-hidden])')?.textContent).toBe(
      '2 of 3…',
    )
    expect(saveAll().getAttribute('aria-disabled')).toBe('true')
    // The progress label stays readable: no disabled styling.
    expect(saveAll().hasAttribute('data-disabled')).toBe(false)
    await userEvent.click(saveAll())
    expect(onSaveAll).not.toHaveBeenCalled()
    const save = screen.getByTestId('save-button')
    expect(save).toBe(screen.getByRole('button', { name: 'Save' }))
    expect(save.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
    const announced = screen
      .getAllByRole('status')
      .map((region) => region.textContent)
      .filter(Boolean)
    expect(announced).toEqual(['Saving 3 entries…'])
  })

  it('keeps one width whichever label shows, so the top bar does not shift', () => {
    renderHeader({ modifiedCount: 0, hasUnsavedChanges: false })
    const labels = [...saveAll().querySelectorAll('[style*="grid-area"]')]
    expect(labels.map((label) => label.textContent)).toEqual(['Save all', '1 of 1…', '1 of 1…'])
    expect(labels.filter((label) => label.getAttribute('aria-hidden') === null)).toHaveLength(1)
  })

  it("keeps the largest count's width on the branch, and starts over on another", () => {
    const reserved = () =>
      [...saveAll().querySelectorAll('[style*="grid-area"][aria-hidden]')].map(
        (label) => label.textContent,
      )
    const view = renderHeader({ modifiedCount: 12 })
    view.rerender(<Headers {...defaultProps} modifiedCount={3} />)
    expect(reserved()).toContain('12 of 12…')
    view.rerender(<Headers {...defaultProps} modifiedCount={3} branchName="feature/y" />)
    expect(reserved()).toContain('3 of 3…')
    expect(reserved()).not.toContain('12 of 12…')
  })

  it('keeps its progress readable and reasonless when a lock arrives mid-run', async () => {
    renderHeader({
      modifiedCount: 3,
      branchStatus: 'submitted',
      branchWriteBlocked: true,
      saveAllProgress: { done: 1, total: 3 },
    })
    expect(saveAll()).toBe(screen.getByRole('button', { name: 'Saving 2 of 3…' }))
    expect(saveAll().getAttribute('aria-disabled')).toBe('true')
    expect(saveAll().hasAttribute('data-disabled')).toBe(false)
    act(() => saveAll().focus())
    await expect(screen.findByRole('tooltip', {}, { timeout: 300 })).rejects.toThrow()
  })

  it("says why Save waits during Save all, though the run's reloads leave the editor busy", async () => {
    renderHeader({ hasUnsavedChanges: true, busy: true, saveAllProgress: { done: 0, total: 2 } })
    act(() => screen.getByTestId('save-button').focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe('Wait for Save all to finish.')
  })
})

describe('EditorHeader - Save says how it went', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const saveButton = () => screen.getByTestId('save-button')
  const renderSave = (props: Partial<HeadersProps>) => {
    const view = render(<Headers {...defaultProps} {...props} />, { wrapper: Wrapper })
    return (next: Partial<HeadersProps>) => view.rerender(<Headers {...defaultProps} {...next} />)
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

    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: true })
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
    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: true })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Saved' }))
    rerender({ hasUnsavedChanges: true, savedSignal: 1, savedHere: true })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it('says nothing, then or later, for a save that landed while another entry was open', () => {
    const rerender = renderSave({ hasUnsavedChanges: false, savedSignal: 0 })
    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: false })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: true })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it('says nothing again on returning to the saved entry while "Saved" would still show', () => {
    const rerender = renderSave({ hasUnsavedChanges: false, savedSignal: 0 })
    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: true })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Saved' }))
    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: false })
    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: true })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it('says nothing again for an earlier save once a Save all ends inside its window', () => {
    const rerender = renderSave({ hasUnsavedChanges: false, savedSignal: 0, modifiedCount: 2 })
    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: true, modifiedCount: 2 })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Saved' }))
    const run = { hasUnsavedChanges: false, savedSignal: 1, savedHere: true }
    rerender({ ...run, saveAllProgress: { done: 0, total: 2 } })
    rerender({ ...run, saveAllProgress: null })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
    expect(statuses()).toEqual([])
  })

  it('says nothing for a save that landed before it was shown', () => {
    renderHeader({ hasUnsavedChanges: false, savedSignal: 3, savedHere: true })
    expect(saveButton()).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it('says nothing more in a Tooltip while it reads "Saved"', async () => {
    const rerender = renderSave({ hasUnsavedChanges: false, savedSignal: 0 })
    rerender({ hasUnsavedChanges: false, savedSignal: 1, savedHere: true })
    act(() => saveButton().focus())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByText('No changes to save.')).toBeNull()
  })

  it('hides the status words, not the icon, on a phone, so Save keeps its width there', () => {
    renderHeader()
    const words = [...saveButton().querySelectorAll('.canopy-save-label-text')]
    expect(words.map((word) => word.textContent)).toEqual(['Saving…', 'Saved'])
    const rule = [...document.querySelectorAll('style')].find((style) =>
      style.textContent?.includes('.canopy-save-label-text'),
    )
    expect(rule?.textContent).toMatch(/max-width: 47\.99em[^}]*clip/)
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

  it('greys a blocked Save', () => {
    renderHeader({ hasUnsavedChanges: false })
    expect(screen.getByTestId('save-button').hasAttribute('data-disabled')).toBe(true)
  })

  it("fills the entry's Save as the one primary, and leaves Save all, Submit and Withdraw secondary", () => {
    renderHeader({ modifiedCount: 1, userContext: { userId: 'u1' }, branchCreatedBy: 'u1' })
    expect(screen.getByTestId('save-button').getAttribute('data-variant')).toBe('filled')
    expect(screen.getByTestId('save-all-button').getAttribute('data-variant')).toBe('light')
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

  it('names no lock until they arrive, only that they are loading', () => {
    renderHeader({
      branchLoading: true,
      branchPending: true,
      branchWriteBlocked: true,
      branchStatus: undefined,
    })
    expect(screen.queryByTestId('read-only-chip')).toBeNull()
    expect(barStatus().textContent).toBe('Loading branch…')
    expect(barStatus().querySelector('svg')).toBeNull()
  })
})

describe('EditorHeader - during Save all', () => {
  afterEach(() => {
    cleanup()
  })

  it('says why Submit waits', async () => {
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

describe('EditorHeader - branch bar', () => {
  const originalMatchMedia = window.matchMedia
  /** A window below `md`: max-width queries match, min-width ones don't. */
  const stubNarrowWindow = () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.startsWith('(max-width:'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
  const owner = { userContext: { userId: 'u1' }, branchCreatedBy: 'u1' }
  const follows = (a: Element, b: Element) =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    cleanup()
  })

  it('puts the pill first, then Save all, then Submit', () => {
    renderHeader({ ...owner, modifiedCount: 2 })
    const pill = screen.getByTestId('branch-dropdown-button')
    const saveAll = screen.getByTestId('save-all-button')
    const submit = screen.getByTestId('submit-button')
    expect(follows(pill, saveAll)).toBe(true)
    expect(follows(saveAll, submit)).toBe(true)
    expect(screen.queryByTestId('branch-actions-button')).toBeNull()
  })

  it('below md, joins Submit to Save all as its caret on an editable branch', async () => {
    stubNarrowWindow()
    const onSubmit = vi.fn()
    renderHeader({ ...owner, modifiedCount: 2, onSubmit })
    expect(screen.queryByTestId('submit-button')).toBeNull()
    const caret = screen.getByTestId('branch-actions-button')
    expect(caret.closest('.mantine-Button-group')).toBe(
      screen.getByTestId('save-all-button').closest('.mantine-Button-group'),
    )
    await userEvent.click(caret)
    await userEvent.click(await screen.findByTestId('submit-menu-item'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const returnFocusTo = onSubmit.mock.calls[0][0] as () => HTMLElement | null
    expect(returnFocusTo()).toBe(caret)
  })

  it('below md, offers Withdraw in the caret when the branch can be withdrawn', async () => {
    stubNarrowWindow()
    const onWithdraw = vi.fn()
    renderHeader({ ...owner, branchStatus: 'approved', onWithdraw })
    await userEvent.click(screen.getByTestId('branch-actions-button'))
    const item = await screen.findByTestId('withdraw-menu-item')
    expect(item.textContent).toBe('Withdraw from review')
    await userEvent.click(item)
    expect(onWithdraw).toHaveBeenCalledTimes(1)
  })

  it('below md, says in the caret why Submit is blocked and does not run it', async () => {
    stubNarrowWindow()
    const onSubmit = vi.fn()
    renderHeader({ userContext: { userId: 'someone-else' }, branchCreatedBy: 'u1', onSubmit })
    await userEvent.click(screen.getByTestId('branch-actions-button'))
    const item = await screen.findByTestId('submit-menu-item')
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain('You do not have permission to submit this branch')
    await userEvent.click(item)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('below md, draws no caret when the branch has no workflow action', () => {
    stubNarrowWindow()
    renderHeader({ ...owner, modifiedCount: 1 })
    expect(screen.getByTestId('branch-actions-button')).toBeTruthy()
    cleanup()
    // A protected branch that is writable, as in dev mode: Submit never shows on it.
    renderHeader({ ...owner, branchIsProtected: true, modifiedCount: 1 })
    expect(screen.getByTestId('save-all-button')).toBeTruthy()
    expect(screen.queryByTestId('branch-actions-button')).toBeNull()
    expect(screen.queryByTestId('submit-button')).toBeNull()
  })

  it('below md, moves focus from the caret to Withdraw when a submit locks the branch', () => {
    stubNarrowWindow()
    const onSubmit = vi.fn()
    const props: HeadersProps = { ...defaultProps, ...owner, onSubmit }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    act(() => screen.getByTestId('branch-actions-button').focus())
    rerender(<Headers {...props} branchStatus="submitted" branchWriteBlocked />)
    const withdraw = screen.getByTestId('withdraw-button')
    expect(document.activeElement).toBe(withdraw)
  })

  it('below md, moves focus from the open caret menu to Withdraw when a submit locks the branch', async () => {
    stubNarrowWindow()
    const props: HeadersProps = { ...defaultProps, ...owner }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    await userEvent.click(screen.getByTestId('branch-actions-button'))
    const menu = await screen.findByRole('menu')
    act(() => within(menu).getByTestId('submit-menu-item').focus())
    expect(menu.contains(document.activeElement)).toBe(true)
    rerender(<Headers {...props} branchStatus="submitted" branchWriteBlocked />)
    expect(document.activeElement).toBe(screen.getByTestId('withdraw-button'))
  })

  it('below md, leaves focus where it is when the swapped controls did not have it', () => {
    stubNarrowWindow()
    const props: HeadersProps = { ...defaultProps, ...owner, modifiedCount: 1 }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    const pill = screen.getByTestId('branch-dropdown-button')
    act(() => pill.focus())
    rerender(<Headers {...props} branchStatus="submitted" branchWriteBlocked />)
    expect(screen.getByTestId('withdraw-button')).toBeTruthy()
    expect(document.activeElement).toBe(pill)
  })

  it('below md, moves focus from Save all to the way forward when a lock hides Save all', () => {
    stubNarrowWindow()
    const props: HeadersProps = { ...defaultProps, ...owner, modifiedCount: 1 }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    act(() => screen.getByTestId('save-all-button').focus())
    rerender(<Headers {...props} branchStatus="archived" branchWriteBlocked />)
    expect(screen.queryByTestId('save-all-button')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('switch-branch-button'))
  })

  it('below md, moves focus from Withdraw to the caret when a withdraw unlocks the branch', () => {
    stubNarrowWindow()
    const props: HeadersProps = {
      ...defaultProps,
      ...owner,
      branchStatus: 'submitted',
      branchWriteBlocked: true,
    }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    act(() => screen.getByTestId('withdraw-button').focus())
    rerender(<Headers {...props} branchStatus="editing" branchWriteBlocked={false} />)
    expect(document.activeElement).toBe(screen.getByTestId('branch-actions-button'))
  })

  it("returns a dialog's focus to whichever workflow control is mounted when it closes", async () => {
    stubNarrowWindow()
    const onSubmit = vi.fn()
    const props: HeadersProps = { ...defaultProps, ...owner, onSubmit }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    await userEvent.click(screen.getByTestId('branch-actions-button'))
    await userEvent.click(await screen.findByTestId('submit-menu-item'))
    const returnFocusTo = onSubmit.mock.calls[0][0] as () => HTMLElement | null
    rerender(<Headers {...props} branchStatus="submitted" branchWriteBlocked />)
    expect(returnFocusTo()).toBe(screen.getByTestId('withdraw-button'))
  })

  it("returns a withdraw dialog's focus to the way forward when no workflow action is left", async () => {
    const onWithdraw = vi.fn()
    const props: HeadersProps = {
      ...defaultProps,
      userContext: { userId: 'boss', groups: [RESERVED_GROUPS.ADMINS] },
      branchStatus: 'submitted',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
      onWithdraw,
    }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    await userEvent.click(screen.getByTestId('withdraw-button'))
    const returnFocusTo = onWithdraw.mock.calls[0][0] as () => HTMLElement | null
    rerender(<Headers {...props} branchStatus="editing" />)
    expect(screen.queryByTestId('withdraw-button')).toBeNull()
    expect(returnFocusTo()).toBe(screen.getByTestId('new-branch-button'))
  })

  it('gives the wide button itself as where its dialog returns focus', async () => {
    const onSubmit = vi.fn()
    renderHeader({ ...owner, onSubmit })
    const submit = screen.getByTestId('submit-button')
    await userEvent.click(submit)
    const returnFocusTo = onSubmit.mock.calls[0][0] as () => HTMLElement | null
    expect(returnFocusTo()).toBe(submit)
  })

  it('below md, says in the caret that Submit waits for a load or save', async () => {
    stubNarrowWindow()
    renderHeader({ ...owner, busy: true })
    await userEvent.click(screen.getByTestId('branch-actions-button'))
    const item = await screen.findByTestId('submit-menu-item')
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain('Wait for the current save or load to finish.')
  })

  it('groups Save all only when the caret joins it', () => {
    renderHeader({ ...owner, modifiedCount: 1 })
    expect(screen.getByTestId('save-all-button').closest('[role="group"]')).toBeNull()
    cleanup()
    stubNarrowWindow()
    renderHeader({ ...owner, modifiedCount: 1 })
    const group = screen.getByTestId('save-all-button').closest('[role="group"]')
    expect(group?.contains(screen.getByTestId('branch-actions-button'))).toBe(true)
  })

  it('below md, shows no Save all on a locked or loading branch, where it could not apply', () => {
    stubNarrowWindow()
    renderHeader({ ...owner, branchStatus: 'submitted', branchWriteBlocked: true })
    expect(screen.queryByTestId('save-all-button')).toBeNull()
    cleanup()
    renderHeader({ ...owner, branchLoading: true, branchPending: true, branchWriteBlocked: true })
    expect(barStatus().textContent).toBe('Loading branch…')
    expect(screen.queryByTestId('save-all-button')).toBeNull()
  })

  it('below md, makes Withdraw the default on a branch in review the user may withdraw', () => {
    stubNarrowWindow()
    renderHeader({ ...owner, branchStatus: 'approved', branchWriteBlocked: true })
    expect(screen.getByTestId('withdraw-button').getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByTestId('branch-actions-button')).toBeNull()
    expect(screen.queryByTestId('switch-branch-button')).toBeNull()
  })

  it('below md, makes Switch branch… the default when the user may not withdraw, Withdraw blocked in the caret', async () => {
    stubNarrowWindow()
    const onWithdraw = vi.fn()
    renderHeader({
      userContext: { userId: 'someone-else' },
      branchCreatedBy: 'u1',
      branchStatus: 'submitted',
      branchWriteBlocked: true,
      onWithdraw,
    })
    expect(screen.queryByTestId('withdraw-button')).toBeNull()
    const way = screen.getByTestId('switch-branch-button')
    const caret = screen.getByTestId('branch-actions-button')
    expect(caret.closest('[role="group"]')?.contains(way)).toBe(true)
    await userEvent.click(caret)
    const item = await screen.findByTestId('withdraw-menu-item')
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain('You do not have permission')
    await userEvent.click(item)
    expect(onWithdraw).not.toHaveBeenCalled()
  })

  it('below md, names the Save all split button by its two parts', () => {
    stubNarrowWindow()
    renderHeader({ ...owner, modifiedCount: 2 })
    const group = screen.getByRole('group', { name: 'Save all and branch actions' })
    expect(within(group).getByTestId('save-all-button')).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Branch actions' })).toBeTruthy()
  })

  it("below md, names the way forward's split button apart from its caret", () => {
    stubNarrowWindow()
    renderHeader({ ...owner, branchStatus: 'archived', branchWriteBlocked: true })
    const group = screen.getByRole('group', { name: 'Branch controls' })
    expect(within(group).getByTestId('switch-branch-button')).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Branch actions' })).toBeTruthy()
  })

  it('draws no group around a button without a caret', () => {
    renderHeader({ ...owner, modifiedCount: 2 })
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('below md, makes New branch… the default on the protected base branch', () => {
    stubNarrowWindow()
    renderHeader({
      ...owner,
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
    })
    expect(screen.getByTestId('new-branch-button')).toBeTruthy()
    expect(screen.queryByTestId('branch-actions-button')).toBeNull()
    expect(screen.queryByTestId('save-all-button')).toBeNull()
  })

  it('below md, keeps New branch… the default on a protected branch stuck in review, Withdraw blocked in the caret', async () => {
    stubNarrowWindow()
    renderHeader({
      userContext: { userId: 'someone-else' },
      branchCreatedBy: 'u1',
      branchStatus: 'submitted',
      branchReadOnly: true,
      branchWriteBlocked: true,
      branchIsProtected: true,
    })
    expect(screen.getByTestId('new-branch-button')).toBeTruthy()
    expect(screen.queryByTestId('switch-branch-button')).toBeNull()
    await userEvent.click(screen.getByTestId('branch-actions-button'))
    const item = await screen.findByTestId('withdraw-menu-item')
    expect(item.getAttribute('aria-disabled')).toBe('true')
  })

  it('below md, makes Switch branch… the default on an archived branch, the blocked Submit in the caret', async () => {
    stubNarrowWindow()
    renderHeader({ ...owner, branchStatus: 'archived', branchWriteBlocked: true })
    expect(screen.getByTestId('switch-branch-button')).toBeTruthy()
    await userEvent.click(screen.getByTestId('branch-actions-button'))
    const item = await screen.findByTestId('submit-menu-item')
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain('This branch is archived')
  })

  it('wide, offers Switch branch… beside the blocked Submit on an archived branch', () => {
    renderHeader({ ...owner, branchStatus: 'archived', branchWriteBlocked: true })
    const way = screen.getByTestId('switch-branch-button')
    const submit = screen.getByTestId('submit-button')
    expect(submit.getAttribute('aria-disabled')).toBe('true')
    expect(follows(screen.getByTestId('save-all-button'), way)).toBe(true)
    expect(follows(way, submit)).toBe(true)
    expect(screen.queryByTestId('branch-actions-button')).toBeNull()
  })
})

describe('EditorHeader - bar tooltips', () => {
  const originalMatchMedia = window.matchMedia
  const owner = { userContext: { userId: 'u1' }, branchCreatedBy: 'u1' }

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    cleanup()
  })

  /**
   * Focuses a control and returns how far its Tooltip sits from it, in px. jsdom lays out nothing,
   * so this is the offset alone: a fixed one that assumed a one-row bar puts the Tooltip a row or
   * two away, over other controls, where the default stays within a few pixels.
   */
  const tooltipGap = async (control: HTMLElement) => {
    act(() => control.focus())
    const tooltip = await screen.findByRole('tooltip')
    return Math.max(
      Math.abs(parseFloat(tooltip.style.top)),
      Math.abs(parseFloat(tooltip.style.left)),
    )
  }

  it("opens the unsaved count's Tooltip at its control", async () => {
    renderHeader({ modifiedCount: 2 })
    expect(await tooltipGap(screen.getByTestId('branch-unsaved-count'))).toBeLessThan(10)
  })

  it("opens Save all's reason Tooltip at its control", async () => {
    renderHeader({ modifiedCount: 0, hasUnsavedChanges: false })
    expect(await tooltipGap(screen.getByTestId('save-all-button'))).toBeLessThan(10)
  })

  it("opens the branch-actions caret's Tooltip at its control", async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.startsWith('(max-width:'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
    renderHeader({ ...owner, modifiedCount: 2 })
    expect(await tooltipGap(screen.getByTestId('branch-actions-button'))).toBeLessThan(10)
    expect((await screen.findByRole('tooltip')).textContent).toBe('Branch actions')
  })
})

describe('EditorHeader - review actions', () => {
  const originalMatchMedia = window.matchMedia
  /** A window below `md`: max-width queries match, min-width ones don't. */
  const stubNarrowWindow = () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.startsWith('(max-width:'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
  const inReview = {
    branchStatus: 'submitted',
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
    modifiedCount: 0,
    branchCreatedBy: 'maker',
    branchAccess: { allowedUsers: ['maker'] },
  } satisfies Partial<HeadersProps>
  const reviewer = { userId: 'rita', groups: [RESERVED_GROUPS.REVIEWERS] }
  const creatorAdmin = { userId: 'maker', groups: [RESERVED_GROUPS.ADMINS] }

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    cleanup()
  })

  it("offers a reviewer of someone else's submission Approve and Request changes, not Withdraw", () => {
    renderHeader({ ...inReview, userContext: reviewer })
    const approve = screen.getByTestId('approve-button')
    expect(approve.textContent).toBe('Approve')
    expect(approve.getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByTestId('request-changes-button').textContent).toBe('Request changes')
    expect(screen.queryByTestId('withdraw-button')).toBeNull()
    expect(screen.queryByTestId('submit-button')).toBeNull()
  })

  describe('while a submit is unfinished', () => {
    const blocked = {
      ...inReview,
      branchHold: { kind: 'submit-unfinished', opened: true } as BranchHold,
      branchApproveBlocked: true,
    }

    it('blocks Approve with its reason, and leaves Request changes open', async () => {
      const onApprove = vi.fn()
      const onRequestChanges = vi.fn()
      renderHeader({ ...blocked, userContext: reviewer, onApprove, onRequestChanges })
      const approve = screen.getByTestId('approve-button')

      expect(approve.getAttribute('aria-disabled')).toBe('true')
      await userEvent.click(approve)
      expect(onApprove).not.toHaveBeenCalled()
      act(() => approve.focus())
      expect((await screen.findByRole('tooltip')).textContent).toContain(
        'Use "Request changes" to send it back to its editor.',
      )

      const requestChanges = screen.getByTestId('request-changes-button')
      expect(requestChanges.getAttribute('aria-disabled')).toBeNull()
      await userEvent.click(requestChanges)
      expect(onRequestChanges).toHaveBeenCalledTimes(1)
    })

    it('takes Approve out of the reason a locked control gives', async () => {
      renderHeader({ ...blocked, userContext: reviewer })

      const status = barStatus().closest('[role="status"]')
      expect(status?.textContent).toContain('Request changes to send it back')
      expect(status?.textContent).not.toContain('Approve it')
    })

    it('leads with Request changes below `md`, with Approve and its reason under the caret', async () => {
      stubNarrowWindow()
      renderHeader({ ...blocked, userContext: reviewer })

      expect(screen.queryByTestId('approve-button')).toBeNull()
      expect(screen.getByTestId('request-changes-button').getAttribute('aria-disabled')).toBeNull()

      await userEvent.click(screen.getByTestId('branch-actions-button'))
      const approve = await screen.findByTestId('approve-menu-item')
      expect(approve.getAttribute('aria-disabled')).toBe('true')
      expect(approve.textContent).toContain('Use "Request changes"')
      expect(screen.queryByTestId('request-changes-menu-item')).toBeNull()
    })

    it('leaves Approve open for any other hold', () => {
      renderHeader({ ...inReview, userContext: reviewer, branchHold: { kind: 'conflicts' } })

      expect(screen.getByTestId('approve-button').getAttribute('aria-disabled')).toBeNull()
    })
  })

  it('offers an admin who did not make the branch the same', () => {
    renderHeader({ ...inReview, userContext: { userId: 'adam', groups: [RESERVED_GROUPS.ADMINS] } })
    expect(screen.getByTestId('approve-button')).toBeTruthy()
    expect(screen.queryByTestId('withdraw-button')).toBeNull()
  })

  it('still offers an admin who made the branch Withdraw', () => {
    renderHeader({ ...inReview, userContext: creatorAdmin })
    expect(screen.getByTestId('withdraw-button').getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByTestId('approve-button')).toBeNull()
    expect(screen.queryByTestId('request-changes-button')).toBeNull()
  })

  it('still offers a reviewer given access to the branch Withdraw', () => {
    renderHeader({
      ...inReview,
      branchAccess: { allowedUsers: ['maker', 'rita'] },
      userContext: reviewer,
    })
    expect(screen.getByTestId('withdraw-button')).toBeTruthy()
    expect(screen.queryByTestId('approve-button')).toBeNull()
  })

  it('shows only Request changes once approved', () => {
    renderHeader({ ...inReview, branchStatus: 'approved', userContext: reviewer })
    expect(screen.getByTestId('request-changes-button')).toBeTruthy()
    expect(screen.queryByTestId('approve-button')).toBeNull()
    expect(screen.queryByTestId('withdraw-button')).toBeNull()
  })

  it('leaves the protected base branch stuck in review to Withdraw', () => {
    renderHeader({ ...inReview, branchIsProtected: true, userContext: reviewer })
    expect(screen.getByTestId('withdraw-button')).toBeTruthy()
    expect(screen.queryByTestId('approve-button')).toBeNull()
  })

  it('opens the dialogs with where focus returns, from the wide buttons', async () => {
    const onApprove = vi.fn()
    const onRequestChanges = vi.fn()
    renderHeader({ ...inReview, userContext: reviewer, onApprove, onRequestChanges })

    await userEvent.click(screen.getByTestId('approve-button'))
    await userEvent.click(screen.getByTestId('request-changes-button'))

    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onRequestChanges).toHaveBeenCalledTimes(1)
    const returnFocusTo = (handler: typeof onApprove) =>
      handler.mock.calls[0][0] as () => HTMLElement | null
    // Each returns to its own button while that is mounted.
    expect(returnFocusTo(onApprove)()).toBe(screen.getByTestId('approve-button'))
    expect(returnFocusTo(onRequestChanges)()).toBe(screen.getByTestId('request-changes-button'))
  })

  it('returns an approve to Request changes, the control left, once Approve is gone', async () => {
    const onApprove = vi.fn()
    const props: HeadersProps = {
      ...defaultProps,
      ...inReview,
      userContext: reviewer,
      onApprove,
    }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    await userEvent.click(screen.getByTestId('approve-button'))
    const returnFocusTo = onApprove.mock.calls[0][0] as () => HTMLElement | null
    rerender(<Headers {...props} branchStatus="approved" />)
    expect(screen.queryByTestId('approve-button')).toBeNull()
    expect(returnFocusTo()).toBe(screen.getByTestId('request-changes-button'))
  })

  it('below md, returns Approve to its button and Request changes to the caret', async () => {
    stubNarrowWindow()
    const onApprove = vi.fn()
    const onRequestChanges = vi.fn()
    renderHeader({ ...inReview, userContext: reviewer, onApprove, onRequestChanges })
    await userEvent.click(screen.getByTestId('approve-button'))
    await userEvent.click(screen.getByTestId('branch-actions-button'))
    await userEvent.click(await screen.findByTestId('request-changes-menu-item'))
    const returnFocusTo = (handler: typeof onApprove) =>
      handler.mock.calls[0][0] as () => HTMLElement | null
    expect(returnFocusTo(onApprove)()).toBe(screen.getByTestId('approve-button'))
    expect(returnFocusTo(onRequestChanges)()).toBe(screen.getByTestId('branch-actions-button'))
  })

  it('names the review caret "More review actions", and keeps "Branch actions" on the others', () => {
    stubNarrowWindow()
    renderHeader({ ...inReview, userContext: reviewer })
    expect(screen.getByRole('button', { name: 'More review actions' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Branch actions' })).toBeNull()
    cleanup()
    renderHeader({ ...defaultProps, userContext: { userId: 'u1' }, branchCreatedBy: 'u1' })
    expect(screen.getByRole('button', { name: 'Branch actions' })).toBeTruthy()
  })

  it('says in the lock reason that a reviewer approves or requests changes, not withdraws', async () => {
    renderHeader({ ...inReview, userContext: reviewer, branchReviewing: true })
    act(() => screen.getByTestId('save-button').focus())
    expect(
      await screen.findByText(
        'This branch is in review. Approve it, or request changes to send it back to its editor.',
      ),
    ).toBeTruthy()
    expect(barStatus().closest('[role="status"]')?.textContent).toContain(
      'Approve it, or request changes',
    )
  })

  it('does not tell a reviewer with unsaved edits to withdraw, which the bar no longer offers', async () => {
    renderHeader({ ...inReview, userContext: reviewer, modifiedCount: 2 })
    act(() => screen.getByTestId('branch-unsaved-count').focus())
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain('2 unsaved edits in this browser.')
    expect(tooltip.textContent).not.toContain('Withdraw')
  })

  it('says in the bar why a reviewer has Withdraw and not Approve once the pull request is closed', async () => {
    renderHeader({
      ...inReview,
      branchPullRequestState: 'closed',
      userContext: reviewer,
      branchPullRequestClosed: true,
    })
    act(() => screen.getByTestId('save-button').focus())
    expect(
      await screen.findByText(
        'The pull request was closed on GitHub. Use "Withdraw from review", then submit it again to open a new one.',
      ),
    ).toBeTruthy()
    expect(barStatus().closest('[role="status"]')?.textContent).toContain(
      'Use "Withdraw from review"',
    )
  })

  it('offers a reviewer Withdraw, not review buttons, once the pull request is closed', () => {
    renderHeader({ ...inReview, branchPullRequestState: 'closed', userContext: reviewer })
    expect(screen.getByTestId('withdraw-button').getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByTestId('approve-button')).toBeNull()
    expect(screen.queryByTestId('request-changes-button')).toBeNull()
  })

  it('holds both while a Save all runs or the bar is busy', () => {
    renderHeader({
      ...inReview,
      userContext: reviewer,
      saveAllProgress: { done: 1, total: 2 },
    })
    expect(screen.getByTestId('approve-button').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('request-changes-button').getAttribute('aria-disabled')).toBe('true')
    cleanup()

    renderHeader({ ...inReview, userContext: reviewer, busy: true })
    expect(screen.getByTestId('approve-button').getAttribute('aria-disabled')).toBe('true')
  })

  it('says a busy bar alone is waiting on a save or load, as the caret items do', async () => {
    renderHeader({ ...inReview, userContext: reviewer, busy: true })
    for (const id of ['approve-button', 'request-changes-button']) {
      act(() => screen.getByTestId(id).focus())
      expect((await screen.findByRole('tooltip')).textContent).toBe(
        'Wait for the current save or load to finish.',
      )
      act(() => screen.getByTestId(id).blur())
    }
  })

  it('below md, keeps Approve visible and moves Request changes under its caret', async () => {
    stubNarrowWindow()
    const onApprove = vi.fn()
    const onRequestChanges = vi.fn()
    renderHeader({ ...inReview, userContext: reviewer, onApprove, onRequestChanges })

    expect(screen.queryByTestId('request-changes-button')).toBeNull()
    await userEvent.click(screen.getByTestId('approve-button'))
    expect(onApprove).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('branch-actions-button'))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByTestId('approve-menu-item')).toBeNull()
    await userEvent.click(within(menu).getByTestId('request-changes-menu-item'))
    expect(onRequestChanges).toHaveBeenCalledTimes(1)
  })

  it('below md, shows Request changes alone, with no caret, once approved', () => {
    stubNarrowWindow()
    renderHeader({ ...inReview, branchStatus: 'approved', userContext: reviewer })
    expect(screen.getByTestId('request-changes-button')).toBeTruthy()
    expect(screen.queryByTestId('approve-button')).toBeNull()
    expect(screen.queryByTestId('branch-actions-button')).toBeNull()
  })

  it('moves focus to Request changes when an approve that resolves late takes Approve away', async () => {
    const onApprove = vi.fn()
    const props: HeadersProps = { ...defaultProps, ...inReview, userContext: reviewer, onApprove }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    await userEvent.click(screen.getByTestId('approve-button'))
    // The dialog has closed and returned focus to Approve; the API has not answered yet.
    const returnFocusTo = onApprove.mock.calls[0][0] as () => HTMLElement | null
    act(() => returnFocusTo()?.focus())
    expect(document.activeElement).toBe(screen.getByTestId('approve-button'))

    // The answer arrives: the branch is approved and Approve unmounts with focus on it.
    rerender(<Headers {...props} branchStatus="approved" />)

    expect(screen.queryByTestId('approve-button')).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBe(screen.getByTestId('request-changes-button'))
  })

  it('moves focus on, not to the page, when a late request for changes takes the review buttons away', () => {
    const props: HeadersProps = { ...defaultProps, ...inReview, userContext: reviewer }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    act(() => screen.getByTestId('request-changes-button').focus())

    rerender(<Headers {...props} branchStatus="editing" branchWriteBlocked={false} />)

    expect(screen.queryByTestId('request-changes-button')).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBeTruthy()
  })

  it('below md, moves focus on from the review caret when the branch leaves review', () => {
    stubNarrowWindow()
    const props: HeadersProps = { ...defaultProps, ...inReview, userContext: reviewer }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    act(() => screen.getByRole('button', { name: 'More review actions' }).focus())

    rerender(<Headers {...props} branchStatus="editing" branchWriteBlocked={false} />)

    expect(screen.queryByRole('button', { name: 'More review actions' })).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBeTruthy()
  })

  it('below md, moves focus from Approve to Request changes when an approve takes Approve away', () => {
    stubNarrowWindow()
    const props: HeadersProps = { ...defaultProps, ...inReview, userContext: reviewer }
    const { rerender } = render(<Headers {...props} />, { wrapper: Wrapper })
    act(() => screen.getByTestId('approve-button').focus())
    rerender(<Headers {...props} branchStatus="approved" />)
    expect(document.activeElement).toBe(screen.getByTestId('request-changes-button'))
  })
})

describe('EntryHeader - Show changes', () => {
  const originalMatchMedia = window.matchMedia
  afterEach(() => {
    window.matchMedia = originalMatchMedia
    cleanup()
  })

  it('offers a text button that opens the changes', async () => {
    const onShowChanges = vi.fn()
    renderHeader({ onShowChanges })
    await userEvent.click(screen.getByRole('button', { name: 'Show changes' }))
    expect(onShowChanges).toHaveBeenCalled()
    expect(screen.getByTestId('entry-show-changes').textContent).toBe('Show changes')
  })

  it('takes one slot, alike in every state, so the header never shifts', () => {
    const slot = () =>
      screen.queryByTestId('entry-show-changes') ?? screen.getByTestId('entry-show-changes-pending')
    const { rerender } = renderHeader({ showChangesPending: true })
    const pending = slot().className
    rerender(<Headers {...defaultProps} showChangesPending onShowChanges={vi.fn()} />)
    expect(slot().className).toBe(pending)
    expect(slot().style.visibility).toBe('')
    rerender(<Headers {...defaultProps} showChangesPending />)
    expect(slot().className).toBe(pending)
    expect(slot().style.visibility).toBe('hidden')
  })

  it('holds its slot unseen and unreachable while the changes list loads', () => {
    renderHeader({ showChangesPending: true })
    const held = screen.getByTestId('entry-show-changes-pending')
    expect(held.style.visibility).toBe('hidden')
    expect(held.getAttribute('aria-hidden')).toBe('true')
    expect(held.getAttribute('tabindex')).toBe('-1')
    expect(screen.queryByRole('button', { name: 'Show changes' })).toBeNull()
  })

  it('is an icon-only control below sm, named and with a Tooltip on focus', async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.startsWith('(max-width:'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
    renderHeader({ onShowChanges: vi.fn() })
    const control = screen.getByRole('button', { name: 'Show changes' })
    expect(control.textContent).toBe('')
    // At least 28px to touch.
    expect(control.style.getPropertyValue('--ai-size')).toBe('var(--ai-size-md)')
    act(() => control.focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe('Show changes')
  })
})
