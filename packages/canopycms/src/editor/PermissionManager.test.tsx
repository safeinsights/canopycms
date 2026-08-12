import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { PermissionManager } from './PermissionManager'
import type { PathPermission } from '../config'
import type { UserSearchResult, PermissionGroupOption } from '../auth/types'
import type { EditorCollection } from './Editor'
import { unsafeAsPermissionPath } from '../authorization/test-utils'
import { unsafeAsLogicalPath } from '../paths/test-utils'
import { usePermissionManager } from './hooks/usePermissionManager'
import { setupMockApiClient, createApiClientWrapper } from './hooks/__test__/test-utils'

// Needed by setupMockApiClient, which injects the mock into the factory.
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, createApiClient: vi.fn() }
})

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Wrapper for Mantine components
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

describe('PermissionManager', () => {
  const mockCollections: EditorCollection[] = [
    {
      path: unsafeAsLogicalPath('content/posts'),
      name: 'posts',
      label: 'Posts',
      format: 'mdx',
      type: 'collection',
      entryTypes: [
        {
          name: 'entry',
          label: 'Entry',
          format: 'mdx',
        },
      ],
    },
    {
      path: unsafeAsLogicalPath('content/pages'),
      name: 'pages',
      label: 'Pages',
      format: 'mdx',
      type: 'collection',
      entryTypes: [
        {
          name: 'entry',
          label: 'Entry',
          format: 'mdx',
        },
      ],
    },
    {
      path: unsafeAsLogicalPath('content/about'),
      name: 'about',
      label: 'About',
      format: 'mdx',
      type: 'collection',
      entryTypes: [
        {
          name: 'entry',
          label: 'Entry',
          format: 'mdx',
        },
      ],
    },
  ]

  const mockPermissions: PathPermission[] = [
    {
      path: unsafeAsPermissionPath('content/posts/**'),
      read: { allowedGroups: ['editors'] },
    },
    {
      path: unsafeAsPermissionPath('content/about/**'),
      read: { allowedUsers: ['alice'] },
    },
  ]

  const mockGroups: PermissionGroupOption[] = [
    { id: 'editors', name: 'Editors', memberCount: 12, source: 'external' },
    { id: 'marketing', name: 'Marketing', memberCount: 8, source: 'external' },
  ]

  const mockUsers: UserSearchResult[] = [
    { id: 'alice', name: 'Alice Johnson', email: 'alice@example.com' },
    { id: 'bob', name: 'Bob Smith', email: 'bob@example.com' },
  ]

  let mockOnSave: (permissions: PathPermission[]) => Promise<void>
  let mockOnSearchUsers: (query: string, limit?: number) => Promise<UserSearchResult[]>
  let mockOnListGroups: () => Promise<PermissionGroupOption[]>

  beforeEach(() => {
    mockOnSave = vi.fn().mockResolvedValue(undefined)
    mockOnSearchUsers = vi.fn().mockResolvedValue(mockUsers)
    mockOnListGroups = vi.fn().mockResolvedValue(mockGroups)
  })

  describe('rendering', () => {
    it('renders with permissions', () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      expect(screen.getByText('content')).toBeTruthy()
      expect(screen.getByText('Expand All')).toBeTruthy()
      expect(screen.getByText('Collapse All')).toBeTruthy()
    })

    it('renders loading state', () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={[]}
          canEdit={true}
          loading={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      expect(screen.getByText('Loading permissions...')).toBeTruthy()
    })

    it('renders read-only warning for non-admin users', () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={false}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      expect(screen.getByText('Read-only')).toBeTruthy()
      expect(screen.getByText(/You need admin access to edit permissions/i)).toBeTruthy()
    })
  })

  describe('tree navigation', () => {
    it('shows content node by default', () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      expect(screen.getByText('content')).toBeTruthy()
    })

    it('expands and shows child nodes when content is expanded', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Content is expanded by default, wait for children to appear after Collapse animation
      await waitFor(() => {
        expect(screen.getByText('Posts')).toBeTruthy()
        expect(screen.getByText('Pages')).toBeTruthy()
        expect(screen.getByText('About')).toBeTruthy()
      })
    })

    it('expands all nodes when Expand All clicked', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => {
        expect(screen.getByText('Posts')).toBeTruthy()
        expect(screen.getByText('Pages')).toBeTruthy()
      })
    })

    it('collapses all nodes when Collapse All clicked', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // First expand all to ensure nodes are visible
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => {
        expect(screen.getByText('Posts')).toBeTruthy()
      })

      // Then collapse all
      const collapseAllButton = screen.getByText('Collapse All')
      fireEvent.click(collapseAllButton)

      // After collapsing, the Collapse component hides content but doesn't remove from DOM
      // We can verify by checking that the content node still exists (it's the root)
      await waitFor(() => {
        expect(screen.getByText('content')).toBeTruthy()
      })
    })

    it('preserves nested collection hierarchy in tree', async () => {
      // Collections with nested structure
      const nestedCollections: EditorCollection[] = [
        {
          path: unsafeAsLogicalPath('content/docs'),
          name: 'docs',
          label: 'Docs',
          format: 'md',
          type: 'collection',
          entryTypes: [
            {
              name: 'entry',
              label: 'Entry',
              format: 'md',
            },
          ],
          children: [
            {
              path: unsafeAsLogicalPath('content/docs/api'),
              name: 'api',
              label: 'API',
              format: 'md',
              type: 'collection',
              entryTypes: [
                {
                  name: 'entry',
                  label: 'Entry',
                  format: 'md',
                },
              ],
            },
            {
              path: unsafeAsLogicalPath('content/docs/guides'),
              name: 'guides',
              label: 'Guides',
              format: 'md',
              type: 'collection',
              entryTypes: [
                {
                  name: 'entry',
                  label: 'Entry',
                  format: 'md',
                },
              ],
            },
          ],
        },
      ]

      render(
        <PermissionManager
          collections={nestedCollections}
          permissions={[]}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand the content root
      const contentNode = screen.getByText('content')
      fireEvent.click(contentNode)

      await waitFor(() => {
        expect(screen.getByText('Docs')).toBeTruthy()
      })

      // Expand the docs collection
      const docsNode = screen.getByText('Docs')
      fireEvent.click(docsNode)

      // Wait for nested items to appear
      await waitFor(
        () => {
          // CRITICAL: Nested items should appear under 'docs', not at root level
          const apiNode = screen.queryByText('API')
          const guidesNode = screen.queryByText('Guides')

          // These items should exist when docs is expanded
          expect(apiNode).not.toBeNull()
          expect(guidesNode).not.toBeNull()
        },
        { timeout: 3000 },
      )
    })
  })

  describe('node selection', () => {
    it('shows permission editor when node is clicked', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand tree first to make nodes visible
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('Posts'))

      const postsNode = screen.getByText('Posts')
      fireEvent.click(postsNode)

      await waitFor(() => {
        expect(screen.getByText(/Path: content\/posts\/\*\*/)).toBeTruthy()
        const addGroupsButtons = screen.getAllByText('Add Groups')
        expect(addGroupsButtons.length).toBeGreaterThan(0)
        const addUserButtons = screen.getAllByText('Add User')
        expect(addUserButtons.length).toBeGreaterThan(0)
      })
    })
  })

  describe('permission badges in tree', () => {
    it('shows group badges on nodes with permissions', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Content is expanded by default - posts should be visible
      expect(screen.getByText('Posts')).toBeTruthy()

      // Click posts node to see its permissions (posts has group 'editors' assigned)
      fireEvent.click(screen.getByText('Posts'))

      // Wait for group badges to appear in the permission editor
      await waitFor(() => {
        const badges = screen.getAllByText('Editors')
        expect(badges.length).toBeGreaterThan(0)
      })
    })

    it('shows user badges on nodes with user permissions', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Content is expanded by default - about should be visible
      expect(screen.getByText('About')).toBeTruthy()

      // Click about node to see its permissions (about has user 'alice' assigned)
      fireEvent.click(screen.getByText('About'))

      // Wait for user badges to appear in the permission editor
      await waitFor(() => {
        const badges = screen.getAllByText('alice')
        expect(badges.length).toBeGreaterThan(0)
      })
    })
  })

  describe('loading groups', () => {
    it('loads groups on mount when canEdit is true', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      await waitFor(() => {
        expect(mockOnListGroups).toHaveBeenCalled()
      })
    })

    it('does not load groups when canEdit is false', () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={false}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      expect(mockOnListGroups).not.toHaveBeenCalled()
    })

    it('shows error when group loading fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockError = vi.fn().mockRejectedValue(new Error('Network error'))

      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockError}
        />,
        { wrapper },
      )

      await waitFor(() => {
        expect(screen.getByText(/Failed to load groups/i)).toBeTruthy()
      })

      consoleErrorSpy.mockRestore()
    })
  })

  describe('group search', () => {
    it('shows group search panel when Add Groups clicked', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('Posts'))

      // Click posts node to select it
      const postsNode = screen.getByText('Posts')
      fireEvent.click(postsNode)

      let addGroupsButton: HTMLElement
      await waitFor(() => {
        const buttons = screen.getAllByText('Add Groups')
        expect(buttons.length).toBeGreaterThan(0)
        addGroupsButton = buttons[0]
      })

      // Click Add Groups
      fireEvent.click(addGroupsButton!)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search groups...')).toBeTruthy()
      })
    })

    it('offers internally-created groups as options, tagged Internal', async () => {
      // Groups created in the Group Manager live in groups.json, not in the
      // auth provider. They are valid allowedGroups targets, so the picker has
      // to offer them -- it used to list only the auth provider's groups,
      // leaving an internal group assignable solely by hand-editing
      // permissions.json.
      const onListGroups = vi.fn().mockResolvedValue([
        { id: 'gen-abc123', name: 'Docs Team', source: 'internal' },
        { id: 'marketing', name: 'Marketing', memberCount: 8, source: 'external' },
      ] satisfies PermissionGroupOption[])

      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={onListGroups}
        />,
        { wrapper },
      )

      fireEvent.click(screen.getByText('Expand All'))
      await waitFor(() => screen.getByText('Posts'))
      fireEvent.click(screen.getByText('Posts'))

      let addGroupsButton: HTMLElement
      await waitFor(() => {
        const buttons = screen.getAllByText('Add Groups')
        expect(buttons.length).toBeGreaterThan(0)
        addGroupsButton = buttons[0]
      })
      fireEvent.click(addGroupsButton!)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search groups...')).toBeTruthy()
      })

      // The internal group is present in the option list...
      await waitFor(() => {
        expect(screen.getAllByText('Docs Team').length).toBeGreaterThan(0)
      })

      // ...and is distinguishable from the provider's groups, since the two ID
      // spaces are not namespaced against each other.
      expect(screen.getAllByText('Internal').length).toBeGreaterThan(0)
      expect(screen.getAllByText('External').length).toBeGreaterThan(0)

      // And it is selectable as a permission target. Selecting closes the
      // picker (handleAddGroup), so a surviving "Docs Team" afterwards can
      // only be the assigned badge -- re-asserting the text while the option
      // list is still open would pass even if the click were a no-op.
      fireEvent.click(screen.getAllByText('Docs Team')[0])

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Search groups...')).toBeNull()
      })
      expect(screen.getAllByText('Docs Team').length).toBeGreaterThan(0)
    })

    it('filters groups as user types', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('Posts'))

      // Open group search
      fireEvent.click(screen.getByText('Posts'))

      let addGroupsButton: HTMLElement
      await waitFor(() => {
        const buttons = screen.getAllByText('Add Groups')
        expect(buttons.length).toBeGreaterThan(0)
        addGroupsButton = buttons[0]
      })
      fireEvent.click(addGroupsButton!)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search groups...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search groups...')
      fireEvent.change(searchInput, { target: { value: 'edit' } })

      await waitFor(() => {
        const editorMatches = screen.getAllByText('Editors')
        expect(editorMatches.length).toBeGreaterThan(0)
        expect(screen.queryByText('Marketing')).toBeFalsy()
      })
    })

    it('closes search panel when Cancel clicked', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('Posts'))

      fireEvent.click(screen.getByText('Posts'))

      let addGroupsButton: HTMLElement
      await waitFor(() => {
        const buttons = screen.getAllByText('Add Groups')
        expect(buttons.length).toBeGreaterThan(0)
        addGroupsButton = buttons[0]
      })

      fireEvent.click(addGroupsButton!)
      await waitFor(() => screen.getByPlaceholderText('Search groups...'))

      // Click Cancel - the button text changes from "Add Groups" to "Cancel"
      const cancelButtons = screen.getAllByText('Cancel')
      fireEvent.click(cancelButtons[0])

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Search groups...')).toBeFalsy()
      })
    })
  })

  describe('user search', () => {
    it('shows user search panel when Add User clicked', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('Posts'))

      fireEvent.click(screen.getByText('Posts'))

      let addUserButton: HTMLElement
      await waitFor(() => {
        const buttons = screen.getAllByText('Add User')
        expect(buttons.length).toBeGreaterThan(0)
        addUserButton = buttons[0]
      })

      fireEvent.click(addUserButton!)

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Search users by name or email/i)).toBeTruthy()
      })
    })

    it('debounces search input', async () => {
      vi.useFakeTimers()

      try {
        render(
          <PermissionManager
            collections={mockCollections}
            permissions={mockPermissions}
            canEdit={true}
            onSave={mockOnSave}
            onSearchUsers={mockOnSearchUsers}
            onListGroups={mockOnListGroups}
          />,
          { wrapper },
        )

        // Expand tree first
        vi.useRealTimers()
        const expandAllButton = screen.getByText('Expand All')
        fireEvent.click(expandAllButton)

        await waitFor(() => screen.getByText('Posts'))
        vi.useFakeTimers()

        // Open user search
        fireEvent.click(screen.getByText('Posts'))

        vi.useRealTimers()
        let addUserButton: HTMLElement
        await waitFor(() => {
          const buttons = screen.getAllByText('Add User')
          expect(buttons.length).toBeGreaterThan(0)
          addUserButton = buttons[0]
        })
        vi.useFakeTimers()

        fireEvent.click(addUserButton!)

        vi.useRealTimers()
        await waitFor(() => screen.getByPlaceholderText(/Search users/i))
        vi.useFakeTimers()

        const searchInput = screen.getByPlaceholderText(/Search users/i)
        fireEvent.change(searchInput, { target: { value: 'a' } })
        fireEvent.change(searchInput, { target: { value: 'al' } })

        expect(mockOnSearchUsers).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(300)

        expect(mockOnSearchUsers).toHaveBeenCalledTimes(1)
        expect(mockOnSearchUsers).toHaveBeenCalledWith('al', 10)
      } finally {
        vi.useRealTimers()
      }
    })

    it('shows error when user search fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockError = vi.fn().mockRejectedValue(new Error('Search failed'))

      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockError}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('Posts'))

      fireEvent.click(screen.getByText('Posts'))

      let addUserButton: HTMLElement
      await waitFor(() => {
        const buttons = screen.getAllByText('Add User')
        expect(buttons.length).toBeGreaterThan(0)
        addUserButton = buttons[0]
      })
      fireEvent.click(addUserButton!)

      await waitFor(() => screen.getByPlaceholderText(/Search users/i))

      const searchInput = screen.getByPlaceholderText(/Search users/i)
      fireEvent.change(searchInput, { target: { value: 'test' } })

      await waitFor(
        () => {
          expect(screen.getByText(/Failed to search users/i)).toBeTruthy()
        },
        { timeout: 2000 },
      )

      consoleErrorSpy.mockRestore()
    })
  })

  describe('saving permissions', () => {
    it('saves changes and calls onSave', async () => {
      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('Posts'))

      // Open posts node and add a user
      fireEvent.click(screen.getByText('Posts'))

      let addUserButton: HTMLElement
      await waitFor(() => {
        const buttons = screen.getAllByText('Add User')
        expect(buttons.length).toBeGreaterThan(0)
        addUserButton = buttons[0]
      })
      fireEvent.click(addUserButton!)

      await waitFor(() => screen.getByPlaceholderText(/Search users/i))

      const searchInput = screen.getByPlaceholderText(/Search users/i)
      fireEvent.change(searchInput, { target: { value: 'alice' } })

      // Wait for search results
      let aliceElement: HTMLElement
      await waitFor(
        () => {
          const aliceMatches = screen.getAllByText('Alice Johnson')
          expect(aliceMatches.length).toBeGreaterThan(0)
          aliceElement = aliceMatches[0]
        },
        { timeout: 2000 },
      )

      // Click on the user to add them
      fireEvent.click(aliceElement!)

      // Should show save button
      await waitFor(() => {
        expect(screen.getByText('Save Permissions')).toBeTruthy()
      })

      // Click save
      const saveButton = screen.getByText('Save Permissions')
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalled()
      })
    })

    it('handles save errors gracefully', async () => {
      const mockError = vi.fn().mockRejectedValue(new Error('Network error'))

      render(
        <PermissionManager
          collections={mockCollections}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockError}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('Posts'))

      // Make a change by adding a user
      fireEvent.click(screen.getByText('Posts'))

      let addUserButton: HTMLElement
      await waitFor(() => {
        const buttons = screen.getAllByText('Add User')
        expect(buttons.length).toBeGreaterThan(0)
        addUserButton = buttons[0]
      })
      fireEvent.click(addUserButton!)
      await waitFor(() => screen.getByPlaceholderText(/Search users/i))

      const searchInput = screen.getByPlaceholderText(/Search users/i)
      fireEvent.change(searchInput, { target: { value: 'bob' } })

      let bobElement: HTMLElement
      await waitFor(
        () => {
          const bobMatches = screen.getAllByText('Bob Smith')
          expect(bobMatches.length).toBeGreaterThan(0)
          bobElement = bobMatches[0]
        },
        { timeout: 2000 },
      )
      fireEvent.click(bobElement!)

      await waitFor(() => screen.getByText('Save Permissions'))
      fireEvent.click(screen.getByText('Save Permissions'))

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeTruthy()
      })
    })
  })

  // Note: onClose prop is accepted but not used to render a close button
  // The close button is provided by parent component (Drawer/Modal)
})

/**
 * Integration cover for the seam between the API client and the picker.
 *
 * listGroupsHandler deliberately returns 500 rather than degrading to an
 * external-only list, but the generated client RESOLVES with the error
 * envelope instead of throwing. An earlier version of handleListGroups mapped
 * that to `[]`, so an unreadable groups.json reached the admin as an empty
 * dropdown with no warning at all -- the same silent-omission failure the 500
 * exists to prevent, one layer up. Wiring the real hook to the real component
 * is what pins that seam; testing either side alone missed it.
 */
describe('PermissionManager + usePermissionManager (group loading failures)', () => {
  it('shows the warning when listGroups returns an error envelope', async () => {
    const mockClient = await setupMockApiClient()
    const ApiWrapper = createApiClientWrapper(mockClient)

    mockClient.permissions.get.mockResolvedValue({
      ok: true,
      status: 200,
      data: { permissions: [], version: 0 },
    })
    // Not a rejection -- the envelope shape the client actually returns.
    mockClient.permissions.listGroups.mockResolvedValue({
      ok: false,
      status: 500,
      error: 'Failed to read groups.json',
    })

    const Harness = () => {
      const { handleListGroups } = usePermissionManager({ isOpen: true })
      return (
        <PermissionManager
          collections={[]}
          permissions={[]}
          canEdit={true}
          onListGroups={handleListGroups}
        />
      )
    }

    render(
      <ApiWrapper>
        <Harness />
      </ApiWrapper>,
      { wrapper: ({ children }) => <MantineProvider>{children}</MantineProvider> },
    )

    await waitFor(() => {
      expect(screen.getByText(/Failed to load groups/i)).toBeTruthy()
    })
  })
})
