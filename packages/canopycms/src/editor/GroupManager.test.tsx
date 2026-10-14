import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { SWRConfig } from 'swr'
import { GroupManager as RealGroupManager, type GroupManagerProps } from './GroupManager'
import type { InternalGroup } from '../authorization'
import type { ExternalGroup } from '../api/groups'
import type { UserSearchResult } from '../auth/types'
import { mockConsole } from '../test-utils/console-spy'

// Confirms by default, as the user clicking the dialog's red button, then closes as Mantine does;
// a test overrides it to cancel.
vi.mock('@mantine/modals', () => ({
  modals: {
    openConfirmModal: vi.fn((options: { onConfirm?: () => void; onClose?: () => void }) => {
      options.onConfirm?.()
      options.onClose?.()
      return 'mock-modal-id'
    }),
  },
}))

const originalMatchMedia = window.matchMedia

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }

  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver as typeof ResizeObserver
  }
})

afterAll(() => {
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// The manager requires a name lookup; a test passes its own to override this one.
const personOf = (id: string): UserSearchResult => ({
  id,
  name: `Person ${id}`,
  email: `${id}@example.com`,
})
const GroupManager = (
  props: Omit<GroupManagerProps, 'onGetUserMetadata'> &
    Partial<Pick<GroupManagerProps, 'onGetUserMetadata'>>,
) => <RealGroupManager onGetUserMetadata={async (id) => personOf(id)} {...props} />

// Wrapper for Mantine components
// A fresh SWR cache per render, so one test's resolved names never answer another's.
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map() }}>
    <MantineProvider>{children}</MantineProvider>
  </SWRConfig>
)

describe('GroupManager', () => {
  const mockInternalGroups: InternalGroup[] = [
    {
      id: 'Admins',
      name: 'Admins',
      description: 'System administrators',
      members: ['admin-1'],
    },
    {
      id: 'editors',
      name: 'Content Editors',
      description: 'Team members who can edit blog posts',
      members: ['user-1', 'user-2'],
    },
    {
      id: 'marketing',
      name: 'Marketing Team',
      description: 'Marketing staff',
      members: ['user-3'],
    },
  ]

  const mockExternalGroups: ExternalGroup[] = [
    { id: 'org_123', name: 'Acme Corporation' },
    { id: 'org_456', name: 'Partner Organization' },
  ]

  const mockUserSearchResults: UserSearchResult[] = [
    { id: 'user-4', name: 'Alice Johnson', email: 'alice@example.com' },
    { id: 'user-5', name: 'Bob Smith', email: 'bob@example.com' },
  ]

  let mockOnSave: (groups: InternalGroup[]) => Promise<void>
  let mockOnSearchUsers: (query: string, limit?: number) => Promise<UserSearchResult[]>
  let mockOnSearchExternalGroups: (query: string) => Promise<ExternalGroup[]>

  beforeEach(() => {
    mockOnSave = vi.fn().mockResolvedValue(undefined)
    mockOnSearchUsers = vi.fn().mockResolvedValue(mockUserSearchResults)
    mockOnSearchExternalGroups = vi.fn().mockResolvedValue(mockExternalGroups)
  })

  describe('rendering', () => {
    it('renders with internal groups', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper },
      )

      expect(screen.getByText('Internal groups')).toBeTruthy()
      expect(screen.getByText('External groups')).toBeTruthy()
    })

    it('renders loading state', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={[]}
          loading={true}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(screen.getByText('Loading groups...')).toBeTruthy()
    })

    it('renders read-only mode for non-admin users', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={false}
        />,
        { wrapper },
      )

      expect(screen.getByText('Read-only')).toBeTruthy()
      expect(screen.getByText('You need admin access to manage groups.')).toBeTruthy()
    })

    it('renders empty state when no groups exist', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={[]}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(screen.getByText('No internal groups yet. Create one to get started.')).toBeTruthy()
    })
  })

  describe('tabs', () => {
    it('shows internal groups tab by default', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(screen.getByText('Content Editors')).toBeTruthy()
      expect(screen.getByText('Marketing Team')).toBeTruthy()
    })

    it('switches to external groups tab when clicked', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper },
      )

      const externalTab = screen.getByText('External groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })
    })
  })

  describe('internal groups management', () => {
    it('shows Create group button', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(screen.getByText('Create group')).toBeTruthy()
    })

    it('opens modal when Create group is clicked', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      const createButton = screen.getByText('Create group')
      fireEvent.click(createButton)

      await waitFor(() => {
        // Modal title will appear twice - once for button, once for modal header
        const createTexts = screen.getAllByText('Create group')
        expect(createTexts.length).toBeGreaterThan(1)
        // New groups don't have ID input field - ID is autogenerated
        expect(screen.getByPlaceholderText('e.g. Content editors')).toBeTruthy()
      })
    })

    it('displays group details in list', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(screen.getByText('Admins')).toBeTruthy()
      expect(screen.getByText('System administrators')).toBeTruthy()
      expect(screen.getByText('Content Editors')).toBeTruthy()
      expect(screen.getByText('Team members who can edit blog posts')).toBeTruthy()
      expect(screen.getByText('2 members')).toBeTruthy()
      expect(screen.getByText('Marketing Team')).toBeTruthy()
      expect(screen.getAllByText('1 member').length).toBe(2) // Admins and Marketing both have 1 member
      expect(screen.queryByText('1 members')).toBeNull()
    })

    it('shows edit and delete buttons for each group', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(screen.getByText('Content Editors')).toBeTruthy()
      expect(screen.getByText('Marketing Team')).toBeTruthy()
      // Each button names its group, so a screen reader can tell the rows apart.
      expect(screen.getByRole('button', { name: 'Edit group "Marketing Team"' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Delete group "Marketing Team"' })).toBeTruthy()
    })
  })

  describe('lifetime', () => {
    it('starts each opening from the loaded groups, not from what the last opening staged', async () => {
      const props = {
        onClose: vi.fn(),
        internalGroups: mockInternalGroups,
        canEdit: true,
        onSave: mockOnSave,
      }
      const { rerender } = render(<GroupManager opened {...props} />, { wrapper })
      fireEvent.click(screen.getByText('Create group'))
      const nameInput = await screen.findByPlaceholderText('e.g. Content editors')
      fireEvent.change(nameInput, {
        target: { value: 'Staged Group' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      await waitFor(() => expect(screen.getByText('Staged Group')).toBeTruthy())

      // Closed by the parent directly, so no discard runs: only the remount can drop it.
      rerender(<GroupManager opened={false} {...props} />)
      await waitFor(() => expect(screen.queryByText('Content Editors')).toBeNull())
      rerender(<GroupManager opened {...props} />)

      await waitFor(() => expect(screen.getByText('Content Editors')).toBeTruthy())
      expect(screen.queryByText('Staged Group')).toBeNull()
      expect(screen.queryByText('Save groups')).toBeNull()
    })
  })

  describe('creating groups', () => {
    it('creates a new group when form is submitted', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      // Click Create group
      fireEvent.click(screen.getByText('Create group'))

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. Content editors')).toBeTruthy()
      })

      // Fill in the form (ID is autogenerated, only need name)
      const nameInput = screen.getByPlaceholderText('e.g. Content editors')
      fireEvent.change(nameInput, { target: { value: 'New Group' } })

      fireEvent.click(screen.getByRole('button', { name: 'Add' }))

      // Adding only stages the group: its row says so until the batch is saved.
      await waitFor(() => {
        expect(screen.getByText('Save groups')).toBeTruthy()
      })
      const newGroupCard = screen.getByText('New Group').closest('.mantine-Paper-root')
      expect(newGroupCard?.textContent).toContain('Unsaved')
      const existingCard = screen.getByText('Marketing Team').closest('.mantine-Paper-root')
      expect(existingCard?.textContent).not.toContain('Unsaved')
    })
  })

  describe('editing groups', () => {
    it('opens modal with group data when edit is clicked', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      // Find the Content Editors group and click its edit button
      // Strategy: Find the group by name, then navigate to find the edit button within that group's Paper container
      const contentEditorsText = screen.getByText('Content Editors')
      const groupPaper = contentEditorsText.closest('[class*="Paper"]')
      const editButton = groupPaper?.querySelector('button[class*="ActionIcon"]') as HTMLElement
      fireEvent.click(editButton)

      await waitFor(() => {
        expect(screen.getByText('Edit group')).toBeTruthy()
        // Should show read-only ID display
        expect(screen.getByText('ID (system-generated)')).toBeTruthy()
        expect(screen.getByText('editors')).toBeTruthy()
        expect(
          (screen.getByPlaceholderText('e.g. Content editors') as HTMLInputElement).value,
        ).toBe('Content Editors')
      })
    })

    it('shows read-only ID when editing existing group', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      // Find the Content Editors group and click its edit button
      const contentEditorsText = screen.getByText('Content Editors')
      const groupPaper = contentEditorsText.closest('[class*="Paper"]')
      const editButton = groupPaper?.querySelector('button[class*="ActionIcon"]') as HTMLElement
      fireEvent.click(editButton)

      await waitFor(() => {
        // ID should be shown as read-only text, not an input field
        expect(screen.getByText('ID (system-generated)')).toBeTruthy()
        expect(screen.getByText('editors')).toBeTruthy()
      })
    })
  })

  describe('deleting groups', () => {
    it('deletes a group not saved yet without asking, since nothing stored is lost', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockClear()
      const unsaved: InternalGroup = {
        id: 'temp-1' as InternalGroup['id'],
        name: 'Draft group',
        members: [],
      }
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={[unsaved]}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      fireEvent.click(screen.getByRole('button', { name: 'Delete group "Draft group"' }))

      expect(modals.openConfirmModal).not.toHaveBeenCalled()
      expect(screen.queryByText('Draft group')).toBeNull()
    })

    it('asks before deleting a group, and a cancel keeps it', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockImplementationOnce(() => 'mock-modal-id')
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      fireEvent.click(screen.getByRole('button', { name: 'Delete group "Content Editors"' }))

      expect(modals.openConfirmModal).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Delete group' }),
      )
      expect(screen.getByText('Content Editors')).toBeTruthy()
      expect(screen.queryByText('Save groups')).toBeNull()
    })

    it('leaves Escape to the delete confirm while it is open, not the drawer behind it', async () => {
      const { modals } = await import('@mantine/modals')
      let closeConfirm: (() => void) | undefined
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        closeConfirm = options.onClose
        return 'mock-modal-id'
      })
      const onClose = vi.fn()
      render(
        <GroupManager
          opened
          onClose={onClose}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      fireEvent.click(screen.getByRole('button', { name: 'Delete group "Content Editors"' }))
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()

      act(() => closeConfirm?.())
      await waitFor(() => {
        fireEvent.keyDown(document.body, { key: 'Escape' })
        expect(onClose).toHaveBeenCalledTimes(1)
      })
    })

    it('disables Delete on the built-in groups and says why, on focus too', async () => {
      const { modals } = await import('@mantine/modals')
      vi.mocked(modals.openConfirmModal).mockClear()
      const builtIn: InternalGroup[] = [
        { id: 'Admins' as InternalGroup['id'], name: 'Admins', members: [] },
        { id: 'Reviewers' as InternalGroup['id'], name: 'Reviewers', members: [] },
        { id: 'editors' as InternalGroup['id'], name: 'Content Editors', members: [] },
      ]
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={builtIn}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      const admins = screen.getByRole('button', { name: 'Delete group "Admins"' })
      const reviewers = screen.getByRole('button', { name: 'Delete group "Reviewers"' })
      const editors = screen.getByRole('button', { name: 'Delete group "Content Editors"' })
      for (const button of [admins, reviewers]) {
        expect(button.getAttribute('aria-disabled')).toBe('true')
        expect(button.hasAttribute('data-disabled')).toBe(true)
        expect(button.hasAttribute('disabled')).toBe(false)
        fireEvent.click(button)
      }
      expect(editors.getAttribute('aria-disabled')).toBeNull()
      expect(modals.openConfirmModal).not.toHaveBeenCalled()
      expect(screen.queryByText('Save groups')).toBeNull()

      act(() => admins.focus())
      expect(
        await screen.findByText(`"Admins" is a built-in group, so it can't be deleted.`),
      ).toBeTruthy()
    })

    it('removes group when delete is clicked', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(screen.getByText('Content Editors')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Delete group "Content Editors"' }))

      await waitFor(() => {
        expect(screen.getByText('Save groups')).toBeTruthy()
      })
    })
  })

  describe('member management', () => {
    it('displays member badges for each group', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(await screen.findByText('Person user-1')).toBeTruthy()
      expect(screen.getByText('Person user-2')).toBeTruthy()
      expect(screen.getByText('Person user-3')).toBeTruthy()
    })

    it('never shows a member id as the label, even when the lookup has no name for it', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onGetUserMetadata={async () => null}
        />,
        { wrapper },
      )

      expect((await screen.findAllByText('Name unavailable')).length).toBe(4)
      expect(screen.queryByText('user-1')).toBeNull()
    })

    it('tells unresolved members apart, and names whom each Remove removes (admin surface)', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onGetUserMetadata={async () => null}
        />,
        { wrapper },
      )

      expect(
        await screen.findByRole('button', { name: 'Remove Name unavailable · user-1' }),
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Remove Name unavailable · user-2' })).toBeTruthy()
    })

    it('shows Add member button for each group', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
        />,
        { wrapper },
      )

      const addMemberButtons = screen.getAllByText('Add member')
      expect(addMemberButtons.length).toBe(3) // Now have 3 groups: Admins, Content Editors, Marketing
    })

    it('opens user search when Add member is clicked', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
        />,
        { wrapper },
      )

      const addMemberButtons = screen.getAllByText('Add member')
      fireEvent.click(addMemberButtons[0])

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search users by name or email...')).toBeTruthy()
      })
    })

    it('disables Add member button when onSearchUsers is not provided', () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      // Find buttons with text "Add member"
      const addMemberButtons = screen.getAllByText('Add member')
      // Get the actual button element
      const button = addMemberButtons[0].closest('button')
      expect(button?.disabled).toBe(true)
    })

    it('searches for users when typing in search box', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
        />,
        { wrapper },
      )

      const addMemberButtons = screen.getAllByText('Add member')
      fireEvent.click(addMemberButtons[0])

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search users by name or email...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search users by name or email...')
      fireEvent.change(searchInput, { target: { value: 'alice' } })

      await waitFor(
        () => {
          expect(mockOnSearchUsers).toHaveBeenCalledWith('alice', 10)
        },
        { timeout: 1000 },
      )
    })

    it('adds user to group when search result is clicked', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
        />,
        { wrapper },
      )

      const addMemberButtons = screen.getAllByText('Add member')
      fireEvent.click(addMemberButtons[0])

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search users by name or email...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search users by name or email...')
      fireEvent.change(searchInput, { target: { value: 'alice' } })

      await waitFor(
        () => {
          expect(screen.getByText('Alice Johnson')).toBeTruthy()
        },
        { timeout: 1000 },
      )

      fireEvent.click(screen.getByText('Alice Johnson'))

      await waitFor(() => {
        expect(screen.getByText('Save groups')).toBeTruthy()
      })
    })

    it('removes user from group when X is clicked on badge', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      fireEvent.click(await screen.findByRole('button', { name: 'Remove Person user-1' }))

      await waitFor(() => {
        expect(screen.getByText('Save groups')).toBeTruthy()
      })
      expect(screen.queryByText('Person user-1')).toBeNull()
    })
  })

  describe('external group search', () => {
    it('shows search input in external groups tab', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper },
      )

      const externalTab = screen.getByText('External groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })
    })

    it('searches external groups when typing', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper },
      )

      const externalTab = screen.getByText('External groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search external groups...')
      fireEvent.change(searchInput, { target: { value: 'acme' } })

      await waitFor(
        () => {
          expect(mockOnSearchExternalGroups).toHaveBeenCalledWith('acme')
        },
        { timeout: 1000 },
      )
    })

    it('displays external group search results', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper },
      )

      const externalTab = screen.getByText('External groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search external groups...')
      fireEvent.change(searchInput, { target: { value: 'corp' } })

      await waitFor(
        () => {
          expect(screen.getByText('Acme Corporation')).toBeTruthy()
        },
        { timeout: 1000 },
      )
    })

    it('shows message when external search is not configured', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      const externalTab = screen.getByText('External groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByText('External group search is not configured')).toBeTruthy()
      })
    })

    it('shows error when external group search fails', async () => {
      const consoleSpy = mockConsole()
      const mockError = vi.fn().mockRejectedValue(new Error('Search failed'))

      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockError}
        />,
        { wrapper },
      )

      const externalTab = screen.getByText('External groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search external groups...')
      fireEvent.change(searchInput, { target: { value: 'test' } })

      await waitFor(
        () => {
          expect(screen.getByText(/Failed to search external groups/i)).toBeTruthy()
        },
        { timeout: 1000 },
      )
      expect(consoleSpy).toHaveErrored('External group search failed')
      consoleSpy.restore()
    })
  })

  describe('saving', () => {
    it('shows Save and Discard buttons when changes are made', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      const actionButtons = document.body.querySelectorAll('button[class*="ActionIcon"]')
      // Delete buttons are at odd indexes (1, 3, 5...)
      // Click Marketing Team's delete button (index 5 = third group)
      fireEvent.click(actionButtons[5] as Element)

      await waitFor(() => {
        expect(screen.getByText('Save groups')).toBeTruthy()
        expect(screen.getByText('Discard changes')).toBeTruthy()
      })
    })

    it('calls onSave when Save groups is clicked', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      // Find the Marketing Team group and click its delete button (second button in the group paper)
      const marketingText = screen.getByText('Marketing Team')
      const groupPaper = marketingText.closest('[class*="Paper"]')
      const actionButtons = groupPaper?.querySelectorAll('button[class*="ActionIcon"]')
      const deleteButton = actionButtons?.[1] as HTMLElement // Second button is delete
      fireEvent.click(deleteButton)

      await waitFor(() => {
        expect(screen.getByText('Save groups')).toBeTruthy()
      })

      const saveButton = screen.getByText('Save groups')
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalled()
      })
    })

    it('reverts changes when Discard changes is clicked', async () => {
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )

      expect(screen.getByText('Content Editors')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Delete group "Content Editors"' }))

      await waitFor(() => {
        expect(screen.getByText('Discard changes')).toBeTruthy()
      })

      const discardButton = screen.getByText('Discard changes')
      fireEvent.click(discardButton)

      await waitFor(() => {
        expect(screen.queryByText('Save groups')).toBeFalsy()
        expect(screen.getByText('Content Editors')).toBeTruthy()
      })
    })

    it('asks before the save bar throws away staged edits, and keeps them when told to keep editing', async () => {
      const { modals } = await import('@mantine/modals')
      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper },
      )
      fireEvent.click(screen.getByRole('button', { name: 'Delete group "Content Editors"' }))
      await waitFor(() => expect(screen.getByText('Save groups')).toBeTruthy())

      vi.mocked(modals.openConfirmModal).mockClear()
      vi.mocked(modals.openConfirmModal).mockImplementationOnce((options) => {
        options.onClose?.()
        return 'mock-modal-id'
      })
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

      expect(modals.openConfirmModal).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: { confirm: 'Discard changes', cancel: 'Keep editing' },
        }),
      )
      expect(screen.getByText('Save groups')).toBeTruthy()
      expect(screen.queryByText('Content Editors')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
      await waitFor(() => expect(screen.queryByText('Save groups')).toBeNull())
      expect(screen.getByText('Content Editors')).toBeTruthy()
    })

    it('shows error when save fails', async () => {
      const mockError = vi.fn().mockRejectedValue(new Error('Network error'))

      render(
        <GroupManager
          opened
          onClose={vi.fn()}
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockError}
        />,
        { wrapper },
      )

      // Find the Content Editors group and click its delete button (second button in the group paper)
      const contentEditorsText = screen.getByText('Content Editors')
      const groupPaper = contentEditorsText.closest('[class*="Paper"]')
      const actionButtons = groupPaper?.querySelectorAll('button[class*="ActionIcon"]')
      const deleteButton = actionButtons?.[1] as HTMLElement // Second button is delete
      fireEvent.click(deleteButton)

      await waitFor(() => {
        expect(screen.getByText('Save groups')).toBeTruthy()
      })

      const saveButton = screen.getByText('Save groups')
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeTruthy()
      })
    })
  })

  // Note: onClose prop is accepted but not used to render a close button
  // The close button is provided by parent component (Drawer/Modal)
})
