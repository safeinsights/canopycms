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

// Wrapper for Mantine components
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

describe('PermissionManager', () => {
  const mockSchema = [
    {
      type: 'collection' as const,
      name: 'Posts',
      path: 'posts',
      format: 'mdx' as const,
      fields: [
        { name: 'title', type: 'string' as const },
        { name: 'content', type: 'markdown' as const },
      ],
    },
    {
      type: 'collection' as const,
      name: 'Pages',
      path: 'pages',
      format: 'mdx' as const,
      fields: [
        { name: 'title', type: 'string' as const },
        { name: 'body', type: 'markdown' as const },
      ],
    },
    {
      type: 'singleton' as const,
      name: 'About',
      path: 'about.md',
      format: 'mdx' as const,
      fields: [
        { name: 'title', type: 'string' as const },
        { name: 'bio', type: 'markdown' as const },
      ],
    },
  ]

  const mockPermissions: PathPermission[] = [
    {
      path: 'content/posts/**',
      allowedGroups: ['editors'],
    },
    {
      path: 'content/about.md',
      allowedUsers: ['alice'],
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
  let mockOnClose: () => void

  beforeEach(() => {
    mockOnSave = vi.fn().mockResolvedValue(undefined)
    mockOnSearchUsers = vi.fn().mockResolvedValue(mockUsers)
    mockOnListGroups = vi.fn().mockResolvedValue(mockGroups)
    mockOnClose = vi.fn()
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
        { wrapper },
      )

      expect(screen.getByText('Permissions')).toBeTruthy()
      expect(screen.getByText('Manage content access by path')).toBeTruthy()
      expect(screen.getByText('content')).toBeTruthy()
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
        { wrapper },
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
          schema={mockSchema}
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
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
        />,
        { wrapper },
      )

      // Content is expanded by default, so children should be visible
      expect(screen.getByText('posts')).toBeTruthy()
      expect(screen.getByText('pages')).toBeTruthy()
      expect(screen.getByText('about.md')).toBeTruthy()
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
        { wrapper },
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
        { wrapper },
      )

      const collapseAllButton = screen.getByText('Collapse All')
      fireEvent.click(collapseAllButton)

      // After collapsing, child nodes should not be visible
      await waitFor(() => {
        expect(screen.queryByText('posts')).toBeFalsy()
      })
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
        { wrapper },
      )

      const postsNode = screen.getByText('posts')
      fireEvent.click(postsNode)

      await waitFor(() => {
        expect(screen.getByText(/Path: content\/posts\/\*\*/)).toBeTruthy()
        expect(screen.getByText('Add Groups')).toBeTruthy()
        expect(screen.getByText('Add User')).toBeTruthy()
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
        { wrapper },
      )

      await waitFor(() => {
        expect(screen.getByText('Editors')).toBeTruthy()
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
        { wrapper },
      )

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy()
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
        { wrapper },
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
        { wrapper },
      )

      expect(mockOnListGroups).not.toHaveBeenCalled()
    })

    it('shows error when group loading fails', async () => {
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
        { wrapper },
      )

      await waitFor(() => {
        expect(screen.getByText(/Failed to load groups/i)).toBeTruthy()
      })
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
        { wrapper },
      )

      // Click posts node to select it
      const postsNode = screen.getByText('posts')
      fireEvent.click(postsNode)

      await waitFor(() => {
        expect(screen.getByText('Add Groups')).toBeTruthy()
      })

      // Click Add Groups
      const addGroupsButton = screen.getByText('Add Groups')
      fireEvent.click(addGroupsButton)

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
        { wrapper },
      )

      // Open group search
      fireEvent.click(screen.getByText('posts'))
      await waitFor(() => screen.getByText('Add Groups'))
      fireEvent.click(screen.getByText('Add Groups'))

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search groups...')).toBeTruthy()
      })

      const searchInput = screen.getByPlaceholderText('Search groups...')
      fireEvent.change(searchInput, { target: { value: 'edit' } })

      await waitFor(() => {
        expect(screen.getByText('Editors')).toBeTruthy()
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
        { wrapper },
      )

      fireEvent.click(screen.getByText('posts'))
      await waitFor(() => screen.getByText('Add Groups'))

      fireEvent.click(screen.getByText('Add Groups'))
      await waitFor(() => screen.getByPlaceholderText('Search groups...'))

      // Click Cancel
      fireEvent.click(screen.getByText('Cancel'))

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
        { wrapper },
      )

      fireEvent.click(screen.getByText('posts'))
      await waitFor(() => screen.getByText('Add User'))

      fireEvent.click(screen.getByText('Add User'))

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
          { wrapper },
        )

        // Open user search
        fireEvent.click(screen.getByText('posts'))

        vi.useRealTimers()
        await waitFor(() => screen.getByText('Add User'))
        vi.useFakeTimers()

        fireEvent.click(screen.getByText('Add User'))

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
        { wrapper },
      )

      fireEvent.click(screen.getByText('posts'))
      await waitFor(() => screen.getByText('Add User'))
      fireEvent.click(screen.getByText('Add User'))

      await waitFor(() => screen.getByPlaceholderText(/Search users/i))

      const searchInput = screen.getByPlaceholderText(/Search users/i)
      fireEvent.change(searchInput, { target: { value: 'test' } })

      await waitFor(
        () => {
          expect(screen.getByText(/Failed to search users/i)).toBeTruthy()
        },
        { timeout: 2000 },
      )
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
        { wrapper },
      )

      // Open posts node and add a user
      fireEvent.click(screen.getByText('posts'))
      await waitFor(() => screen.getByText('Add User'))
      fireEvent.click(screen.getByText('Add User'))

      await waitFor(() => screen.getByPlaceholderText(/Search users/i))

      const searchInput = screen.getByPlaceholderText(/Search users/i)
      fireEvent.change(searchInput, { target: { value: 'alice' } })

      // Wait for search results
      await waitFor(
        () => {
          expect(screen.getByText('Alice Johnson')).toBeTruthy()
        },
        { timeout: 2000 },
      )

      // Click on the user to add them
      fireEvent.click(screen.getByText('Alice Johnson'))

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
        { wrapper },
      )

      // Make a change by adding a user
      fireEvent.click(screen.getByText('posts'))
      await waitFor(() => screen.getByText('Add User'))
      fireEvent.click(screen.getByText('Add User'))
      await waitFor(() => screen.getByPlaceholderText(/Search users/i))

      const searchInput = screen.getByPlaceholderText(/Search users/i)
      fireEvent.change(searchInput, { target: { value: 'bob' } })

      await waitFor(() => screen.getByText('Bob Smith'), { timeout: 2000 })
      fireEvent.click(screen.getByText('Bob Smith'))

      await waitFor(() => screen.getByText('Save Permissions'))
      fireEvent.click(screen.getByText('Save Permissions'))

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeTruthy()
      })
    })
  })

  describe('close button', () => {
    it('calls onClose when close button clicked', () => {
      render(
        <PermissionManager
          schema={mockSchema}
          permissions={mockPermissions}
          canEdit={true}
          onSave={mockOnSave}
          onSearchUsers={mockOnSearchUsers}
          onListGroups={mockOnListGroups}
          onClose={mockOnClose}
        />,
        { wrapper },
      )

      const closeButton = screen.getByText('Close')
      fireEvent.click(closeButton)

      expect(mockOnClose).toHaveBeenCalled()
    })
  })
})
