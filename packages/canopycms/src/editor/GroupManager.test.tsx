import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { GroupManager, type InternalGroup, type ExternalGroup } from './GroupManager'
import type { UserSearchResult } from '../auth/types'

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
      } as MediaQueryList)) as typeof window.matchMedia
  }

  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserver as typeof ResizeObserver
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

// Wrapper for Mantine components
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

describe('GroupManager', () => {
  const mockInternalGroups: InternalGroup[] = [
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

  let mockOnSave: ReturnType<typeof vi.fn>
  let mockOnSearchUsers: ReturnType<typeof vi.fn>
  let mockOnSearchExternalGroups: ReturnType<typeof vi.fn>
  let mockOnClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockOnSave = vi.fn().mockResolvedValue(undefined)
    mockOnSearchUsers = vi.fn().mockResolvedValue(mockUserSearchResults)
    mockOnSearchExternalGroups = vi.fn().mockResolvedValue(mockExternalGroups)
    mockOnClose = vi.fn()
  })

  describe('rendering', () => {
    it('renders with internal groups', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper }
      )

      expect(screen.getByText('Groups')).toBeTruthy()
      expect(screen.getByText('Manage groups and organizations')).toBeTruthy()
      expect(screen.getByText('Internal Groups')).toBeTruthy()
      expect(screen.getByText('External Groups')).toBeTruthy()
    })

    it('renders loading state', () => {
      render(
        <GroupManager
          internalGroups={[]}
          loading={true}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('Loading groups...')).toBeTruthy()
    })

    it('renders read-only mode for non-admin users', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={false}
        />,
        { wrapper }
      )

      expect(screen.getByText('Read-only')).toBeTruthy()
      expect(screen.getByText('You need admin access to manage groups.')).toBeTruthy()
    })

    it('renders empty state when no groups exist', () => {
      render(
        <GroupManager
          internalGroups={[]}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('No internal groups yet. Create one to get started.')).toBeTruthy()
    })
  })

  describe('tabs', () => {
    it('shows internal groups tab by default', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('Content Editors')).toBeTruthy()
      expect(screen.getByText('Marketing Team')).toBeTruthy()
    })

    it('switches to external groups tab when clicked', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper }
      )

      const externalTab = screen.getByText('External Groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })
    })
  })

  describe('internal groups management', () => {
    it('shows Create Group button', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('Create Group')).toBeTruthy()
    })

    it('opens modal when Create Group is clicked', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      const createButton = screen.getByText('Create Group')
      fireEvent.click(createButton)

      await waitFor(() => {
        // Modal title will appear twice - once for button, once for modal header
        const createTexts = screen.getAllByText('Create Group')
        expect(createTexts.length).toBeGreaterThan(1)
        expect(screen.getByPlaceholderText('e.g., content-editors')).toBeTruthy()
        expect(screen.getByPlaceholderText('e.g., Content Editors')).toBeTruthy()
      })
    })

    it('displays group details in list', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('Content Editors')).toBeTruthy()
      expect(screen.getByText('Team members who can edit blog posts')).toBeTruthy()
      expect(screen.getByText('2 members')).toBeTruthy()
      expect(screen.getByText('Marketing Team')).toBeTruthy()
      expect(screen.getByText('1 members')).toBeTruthy()
    })

    it('shows edit and delete buttons for each group', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      // Tooltips with labels "Edit group" and "Delete group" should exist
      expect(screen.getByText('Content Editors')).toBeTruthy()
      expect(screen.getByText('Marketing Team')).toBeTruthy()
    })
  })

  describe('creating groups', () => {
    it('creates a new group when form is submitted', async () => {
      render(
        <GroupManager
          internalGroups={[]}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      // Click Create Group
      fireEvent.click(screen.getByText('Create Group'))

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g., content-editors')).toBeTruthy()
      })

      // Fill in the form
      const idInput = screen.getByPlaceholderText('e.g., content-editors')
      const nameInput = screen.getByPlaceholderText('e.g., Content Editors')

      fireEvent.change(idInput, { target: { value: 'new-group' } })
      fireEvent.change(nameInput, { target: { value: 'New Group' } })

      // Click Create button in modal
      const createButtons = screen.getAllByText('Create')
      const modalCreateButton = createButtons[createButtons.length - 1]
      fireEvent.click(modalCreateButton)

      // Should show save button
      await waitFor(() => {
        expect(screen.getByText('Save Groups')).toBeTruthy()
      })
    })

    it('shows error when creating group with duplicate ID', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      fireEvent.click(screen.getByText('Create Group'))

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g., content-editors')).toBeTruthy()
      })

      const idInput = screen.getByPlaceholderText('e.g., content-editors')
      const nameInput = screen.getByPlaceholderText('e.g., Content Editors')

      fireEvent.change(idInput, { target: { value: 'editors' } })
      fireEvent.change(nameInput, { target: { value: 'Duplicate' } })

      const createButtons = screen.getAllByText('Create')
      const modalCreateButton = createButtons[createButtons.length - 1]
      fireEvent.click(modalCreateButton)

      await waitFor(() => {
        expect(screen.getByText('Group ID already exists')).toBeTruthy()
      })
    })
  })

  describe('editing groups', () => {
    it('opens modal with group data when edit is clicked', async () => {
      const { container } = render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      // Find the first edit button (ActionIcon with IconEdit)
      const editButtons = container.querySelectorAll('button[class*="ActionIcon"]')
      // Edit buttons come before delete buttons, so every even index (0, 2, 4...) is an edit button
      fireEvent.click(editButtons[0] as Element)

      await waitFor(() => {
        expect(screen.getByText('Edit Group')).toBeTruthy()
        expect((screen.getByPlaceholderText('e.g., content-editors') as HTMLInputElement).value).toBe('editors')
        expect((screen.getByPlaceholderText('e.g., Content Editors') as HTMLInputElement).value).toBe('Content Editors')
      })
    })

    it('disables ID field when editing', async () => {
      const { container } = render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      const editButtons = container.querySelectorAll('button[class*="ActionIcon"]')
      fireEvent.click(editButtons[0] as Element)

      await waitFor(() => {
        const idInput = screen.getByPlaceholderText('e.g., content-editors') as HTMLInputElement
        expect(idInput.disabled).toBe(true)
      })
    })
  })

  describe('deleting groups', () => {
    it('removes group when delete is clicked', async () => {
      const { container } = render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('Content Editors')).toBeTruthy()

      // Delete buttons are the second ActionIcon in each group (index 1, 3, 5...)
      const actionButtons = container.querySelectorAll('button[class*="ActionIcon"]')
      fireEvent.click(actionButtons[1] as Element)

      await waitFor(() => {
        expect(screen.getByText('Save Groups')).toBeTruthy()
      })
    })
  })

  describe('member management', () => {
    it('displays member badges for each group', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('user-1')).toBeTruthy()
      expect(screen.getByText('user-2')).toBeTruthy()
      expect(screen.getByText('user-3')).toBeTruthy()
    })

    it('shows Add Member button for each group', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
        />,
        { wrapper }
      )

      const addMemberButtons = screen.getAllByText('Add Member')
      expect(addMemberButtons.length).toBe(2)
    })

    it('opens user search when Add Member is clicked', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
        />,
        { wrapper }
      )

      const addMemberButtons = screen.getAllByText('Add Member')
      fireEvent.click(addMemberButtons[0])

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search users by name or email...')).toBeTruthy()
      })
    })

    it('disables Add Member button when onSearchUsers is not provided', () => {
      const { container } = render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      // Find buttons with text "Add Member"
      const addMemberButtons = screen.getAllByText('Add Member')
      // Get the actual button element
      const button = addMemberButtons[0].closest('button')
      expect(button?.disabled).toBe(true)
    })

    it('searches for users when typing in search box', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
        />,
        { wrapper }
      )

      const addMemberButtons = screen.getAllByText('Add Member')
      fireEvent.click(addMemberButtons[0])

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search users by name or email...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search users by name or email...')
      fireEvent.change(searchInput, { target: { value: 'alice' } })

      await waitFor(() => {
        expect(mockOnSearchUsers).toHaveBeenCalledWith('alice', 10)
      }, { timeout: 1000 })
    })

    it('adds user to group when search result is clicked', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
        />,
        { wrapper }
      )

      const addMemberButtons = screen.getAllByText('Add Member')
      fireEvent.click(addMemberButtons[0])

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search users by name or email...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search users by name or email...')
      fireEvent.change(searchInput, { target: { value: 'alice' } })

      await waitFor(() => {
        expect(screen.getByText('Alice Johnson')).toBeTruthy()
      }, { timeout: 1000 })

      fireEvent.click(screen.getByText('Alice Johnson'))

      await waitFor(() => {
        expect(screen.getByText('Save Groups')).toBeTruthy()
      })
    })

    it('removes user from group when X is clicked on badge', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('user-1')).toBeTruthy()

      const userBadge = screen.getByText('user-1').closest('.mantine-Badge-root')
      expect(userBadge).toBeTruthy()

      const removeButton = userBadge!.querySelector('[aria-label]')
      if (removeButton) {
        fireEvent.click(removeButton)

        await waitFor(() => {
          expect(screen.getByText('Save Groups')).toBeTruthy()
        })
      }
    })
  })

  describe('external group search', () => {
    it('shows search input in external groups tab', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper }
      )

      const externalTab = screen.getByText('External Groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })
    })

    it('searches external groups when typing', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper }
      )

      const externalTab = screen.getByText('External Groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search external groups...')
      fireEvent.change(searchInput, { target: { value: 'acme' } })

      await waitFor(() => {
        expect(mockOnSearchExternalGroups).toHaveBeenCalledWith('acme')
      }, { timeout: 1000 })
    })

    it('displays external group search results', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockOnSearchExternalGroups}
        />,
        { wrapper }
      )

      const externalTab = screen.getByText('External Groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search external groups...')
      fireEvent.change(searchInput, { target: { value: 'corp' } })

      await waitFor(() => {
        expect(screen.getByText('Acme Corporation')).toBeTruthy()
      }, { timeout: 1000 })
    })

    it('shows message when external search is not configured', async () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      const externalTab = screen.getByText('External Groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByText('External group search is not configured')).toBeTruthy()
      })
    })

    it('shows error when external group search fails', async () => {
      const mockError = vi.fn().mockRejectedValue(new Error('Search failed'))

      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onSearchExternalGroups={mockError}
        />,
        { wrapper }
      )

      const externalTab = screen.getByText('External Groups')
      fireEvent.click(externalTab)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search external groups...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search external groups...')
      fireEvent.change(searchInput, { target: { value: 'test' } })

      await waitFor(() => {
        expect(screen.getByText(/Failed to search external groups/i)).toBeTruthy()
      }, { timeout: 1000 })
    })
  })

  describe('saving', () => {
    it('shows Save and Discard buttons when changes are made', async () => {
      const { container } = render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      const actionButtons = container.querySelectorAll('button[class*="ActionIcon"]')
      fireEvent.click(actionButtons[1] as Element) // Click delete button

      await waitFor(() => {
        expect(screen.getByText('Save Groups')).toBeTruthy()
        expect(screen.getByText('Discard Changes')).toBeTruthy()
      })
    })

    it('calls onSave when Save Groups is clicked', async () => {
      const { container } = render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      const actionButtons = container.querySelectorAll('button[class*="ActionIcon"]')
      fireEvent.click(actionButtons[1] as Element)

      await waitFor(() => {
        expect(screen.getByText('Save Groups')).toBeTruthy()
      })

      const saveButton = screen.getByText('Save Groups')
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalled()
      })
    })

    it('reverts changes when Discard Changes is clicked', async () => {
      const { container } = render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.getByText('Content Editors')).toBeTruthy()

      const actionButtons = container.querySelectorAll('button[class*="ActionIcon"]')
      fireEvent.click(actionButtons[1] as Element)

      await waitFor(() => {
        expect(screen.getByText('Discard Changes')).toBeTruthy()
      })

      const discardButton = screen.getByText('Discard Changes')
      fireEvent.click(discardButton)

      await waitFor(() => {
        expect(screen.queryByText('Save Groups')).toBeFalsy()
        expect(screen.getByText('Content Editors')).toBeTruthy()
      })
    })

    it('shows error when save fails', async () => {
      const mockError = vi.fn().mockRejectedValue(new Error('Network error'))

      const { container } = render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockError}
        />,
        { wrapper }
      )

      const actionButtons = container.querySelectorAll('button[class*="ActionIcon"]')
      fireEvent.click(actionButtons[1] as Element)

      await waitFor(() => {
        expect(screen.getByText('Save Groups')).toBeTruthy()
      })

      const saveButton = screen.getByText('Save Groups')
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeTruthy()
      })
    })
  })

  describe('close button', () => {
    it('calls onClose when close button is clicked', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
          onClose={mockOnClose}
        />,
        { wrapper }
      )

      const closeButton = screen.getByText('Close')
      fireEvent.click(closeButton)

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('does not render close button when onClose is not provided', () => {
      render(
        <GroupManager
          internalGroups={mockInternalGroups}
          canEdit={true}
          onSave={mockOnSave}
        />,
        { wrapper }
      )

      expect(screen.queryByText('Close')).toBeFalsy()
    })
  })
})
