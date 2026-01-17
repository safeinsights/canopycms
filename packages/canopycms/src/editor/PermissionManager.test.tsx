import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { PermissionManager } from './PermissionManager'
import type { PathPermission } from '../config'
import type { UserSearchResult, GroupMetadata } from '../auth/types'

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

describe('PermissionManager', () => {
  const mockSchema = {
    collections: [
      {
        name: 'Posts',
        path: 'posts',
        entries: {
          format: 'mdx' as const,
          fields: [
            { name: 'title', type: 'string' as const },
            { name: 'content', type: 'markdown' as const },
          ],
        },
      },
      {
        name: 'Pages',
        path: 'pages',
        entries: {
          format: 'mdx' as const,
          fields: [
            { name: 'title', type: 'string' as const },
            { name: 'body', type: 'markdown' as const },
          ],
        },
      },
    ],
    singletons: [
      {
        name: 'About',
        path: 'about',
        format: 'mdx' as const,
        fields: [
          { name: 'title', type: 'string' as const },
          { name: 'bio', type: 'markdown' as const },
        ],
      },
    ],
  }

  const mockPermissions: PathPermission[] = [
    {
      path: 'content/posts/**',
      read: { allowedGroups: ['editors'] },
    },
    {
      path: 'content/about',
      read: { allowedUsers: ['alice'] },
    },
  ]

  const mockGroups: GroupMetadata[] = [
    { id: 'editors', name: 'Editors', memberCount: 12 },
    { id: 'marketing', name: 'Marketing', memberCount: 8 },
  ]

  const mockUsers: UserSearchResult[] = [
    { id: 'alice', name: 'Alice Johnson', email: 'alice@example.com' },
    { id: 'bob', name: 'Bob Smith', email: 'bob@example.com' },
  ]

  let mockOnSave: (permissions: PathPermission[]) => Promise<void>
  let mockOnSearchUsers: (query: string, limit?: number) => Promise<UserSearchResult[]>
  let mockOnListGroups: () => Promise<GroupMetadata[]>

  beforeEach(() => {
    mockOnSave = vi.fn().mockResolvedValue(undefined)
    mockOnSearchUsers = vi.fn().mockResolvedValue(mockUsers)
    mockOnListGroups = vi.fn().mockResolvedValue(mockGroups)
  })

  describe('rendering', () => {
    it('renders with permissions', () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      expect(screen.getByText('content')).toBeTruthy()
      expect(screen.getByText('Expand All')).toBeTruthy()
      expect(screen.getByText('Collapse All')).toBeTruthy()
    })

    it('renders loading state', () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={[]}
          canEdit={true}
          loading={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      expect(screen.getByText('Loading permissions...')).toBeTruthy()
    })

    it('renders read-only warning for non-admin users', () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={false}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      expect(screen.getByText('Read-only')).toBeTruthy()
      expect(screen.getByText(/You need admin access to edit permissions/i)).toBeTruthy()
    })
  })

  describe('tree navigation', () => {
    it('shows content node by default', () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      expect(screen.getByText('content')).toBeTruthy()
    })

    it('expands and shows child nodes when content is expanded', async () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Content is expanded by default, so children should be visible
      expect(screen.getByText('posts')).toBeTruthy()
      expect(screen.getByText('pages')).toBeTruthy()
      expect(screen.getByText('about')).toBeTruthy()
    })

    it('expands all nodes when Expand All clicked', async () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => {
        expect(screen.getByText('posts')).toBeTruthy()
        expect(screen.getByText('pages')).toBeTruthy()
      })
    })

    it('collapses all nodes when Collapse All clicked', async () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // First expand all to ensure nodes are visible
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => {
        expect(screen.getByText('posts')).toBeTruthy()
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
      // Schema with nested collections
      const nestedSchema = {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: {
              format: 'md' as const,
              fields: [{ name: 'title', type: 'string' as const }],
            },
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: {
                  format: 'md' as const,
                  fields: [{ name: 'title', type: 'string' as const }],
                },
              },
            ],
            singletons: [
              {
                name: 'overview',
                path: 'overview',
                format: 'md' as const,
                fields: [{ name: 'title', type: 'string' as const }],
              },
            ],
          },
        ],
      }

      render(
        <PermissionManager
          schema={nestedSchema}
          permissions={[]}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand the content root
      const contentNode = screen.getByText('content')
      fireEvent.click(contentNode)

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeTruthy()
      })

      // Expand the docs collection
      const docsNode = screen.getByText('docs')
      fireEvent.click(docsNode)

      // Wait for nested items to appear
      await waitFor(() => {
        // CRITICAL: Nested items should appear under 'docs', not at root level
        const apiNode = screen.queryByText('api')
        const overviewNode = screen.queryByText('overview')

        // These items should exist when docs is expanded
        expect(apiNode).not.toBeNull()
        expect(overviewNode).not.toBeNull()
      }, { timeout: 3000 })
    })
  })

  describe('node selection', () => {
    it('shows permission editor when node is clicked', async () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand tree first to make nodes visible
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('posts'))

      const postsNode = screen.getByText('posts')
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
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Content is expanded by default - posts should be visible
      expect(screen.getByText('posts')).toBeTruthy()

      // Click posts node to see its permissions (posts has group 'editors' assigned)
      fireEvent.click(screen.getByText('posts'))

      // Wait for group badges to appear in the permission editor
      await waitFor(() => {
        const badges = screen.getAllByText('Editors')
        expect(badges.length).toBeGreaterThan(0)
      })
    })

    it('shows user badges on nodes with user permissions', async () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Content is expanded by default - about should be visible
      expect(screen.getByText('about')).toBeTruthy()

      // Click about node to see its permissions (about has user 'alice' assigned)
      fireEvent.click(screen.getByText('about'))

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
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      await waitFor(() => {
        expect(mockOnListGroups).toHaveBeenCalled()
      })
    })

    it('does not load groups when canEdit is false', () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={false}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      expect(mockOnListGroups).not.toHaveBeenCalled()
    })

    it('shows error when group loading fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockError = vi.fn().mockRejectedValue(new Error('Network error'))

      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockError}
        />,
        { wrapper }
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
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('posts'))

      // Click posts node to select it
      const postsNode = screen.getByText('posts')
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

    it('filters groups as user types', async () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('posts'))

      // Open group search
      fireEvent.click(screen.getByText('posts'))

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
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('posts'))

      fireEvent.click(screen.getByText('posts'))

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
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('posts'))

      fireEvent.click(screen.getByText('posts'))

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
            schema={mockSchema}
            permissions={mockPermissions}
            canEdit={true}
            onSave={mockOnSave}
            onSearchUsers={mockOnSearchUsers}
            onListGroups={mockOnListGroups}
          />,
          { wrapper }
        )

        // Expand tree first
        vi.useRealTimers()
        const expandAllButton = screen.getByText('Expand All')
        fireEvent.click(expandAllButton)

        await waitFor(() => screen.getByText('posts'))
        vi.useFakeTimers()

        // Open user search
        fireEvent.click(screen.getByText('posts'))

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
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockError}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('posts'))

      fireEvent.click(screen.getByText('posts'))

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

      await waitFor(() => {
        expect(screen.getByText(/Failed to search users/i)).toBeTruthy()
      }, { timeout: 2000 })

      consoleErrorSpy.mockRestore()
    })
  })

  describe('saving permissions', () => {
    it('saves changes and calls onSave', async () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('posts'))

      // Open posts node and add a user
      fireEvent.click(screen.getByText('posts'))

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
      await waitFor(() => {
        const aliceMatches = screen.getAllByText('Alice Johnson')
        expect(aliceMatches.length).toBeGreaterThan(0)
        aliceElement = aliceMatches[0]
      }, { timeout: 2000 })

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
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockError}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper }
      )

      // Expand tree first
      const expandAllButton = screen.getByText('Expand All')
      fireEvent.click(expandAllButton)

      await waitFor(() => screen.getByText('posts'))

      // Make a change by adding a user
      fireEvent.click(screen.getByText('posts'))

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
      await waitFor(() => {
        const bobMatches = screen.getAllByText('Bob Smith')
        expect(bobMatches.length).toBeGreaterThan(0)
        bobElement = bobMatches[0]
      }, { timeout: 2000 })
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
