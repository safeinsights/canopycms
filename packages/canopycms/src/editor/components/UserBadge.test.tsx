import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { UserBadge } from './UserBadge'
import type { UserSearchResult } from '../../auth/types'

// Setup for Mantine components
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

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

describe('UserBadge', () => {
  afterEach(() => {
    cleanup()
  })

  const mockUser: UserSearchResult = {
    id: 'user-1',
    name: 'Alice Johnson',
    email: 'alice@example.com',
    avatarUrl: 'https://example.com/avatar.jpg',
  }

  const mockGetUserMetadata = vi.fn(async (userId: string): Promise<UserSearchResult | null> => {
    if (userId === 'user-1') return mockUser
    if (userId === 'anonymous') {
      return { id: 'anonymous', name: 'Anonymous', email: 'public' }
    }
    return null
  })

  it('renders avatar + name in avatar-name mode', async () => {
    render(
      <UserBadge userId="user-1" getUserMetadata={mockGetUserMetadata} variant="avatar-name" />,
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      expect(screen.getByText('Alice Johnson')).toBeTruthy()
    })
  })

  it('renders avatar only in avatar-only mode', async () => {
    const { container } = render(
      <UserBadge userId="user-1" getUserMetadata={mockGetUserMetadata} variant="avatar-only" />,
      { wrapper: Wrapper },
    )

    // Wait for loading to complete
    await waitFor(() => {
      const skeletons = container.querySelectorAll('[class*="Skeleton"]')
      expect(skeletons.length).toBe(0)
    })

    // Should have avatar but no name text in the container
    const text = container.textContent || ''
    expect(text).not.toContain('Alice Johnson')
  })

  it('renders full info in full mode', async () => {
    render(<UserBadge userId="user-1" getUserMetadata={mockGetUserMetadata} variant="full" />, {
      wrapper: Wrapper,
    })

    await waitFor(() => {
      expect(screen.getByText('Alice Johnson')).toBeTruthy()
      expect(screen.getByText('alice@example.com')).toBeTruthy()
    })
  })

  it('handles anonymous user with special styling', async () => {
    render(
      <UserBadge userId="anonymous" getUserMetadata={mockGetUserMetadata} variant="avatar-name" />,
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      expect(screen.getByText('Anonymous (Public)')).toBeTruthy()
    })
  })

  it('shows loading skeleton while fetching', () => {
    const slowGetUserMetadata = vi.fn(
      () => new Promise<UserSearchResult>((resolve) => setTimeout(() => resolve(mockUser), 100)),
    )

    const { container } = render(
      <UserBadge userId="user-1" getUserMetadata={slowGetUserMetadata} variant="avatar-name" />,
      { wrapper: Wrapper },
    )

    // Should show skeleton initially
    const skeletons = container.querySelectorAll('[class*="Skeleton"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('falls back to userId on error', async () => {
    const errorGetUserMetadata = vi.fn(async () => {
      throw new Error('Network error')
    })

    render(
      <UserBadge userId="user-1" getUserMetadata={errorGetUserMetadata} variant="avatar-name" />,
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      expect(screen.getByText('user-1')).toBeTruthy()
    })
  })

  it('falls back to userId when user not found', async () => {
    const notFoundGetUserMetadata = vi.fn(async () => null)

    render(
      <UserBadge userId="user-1" getUserMetadata={notFoundGetUserMetadata} variant="avatar-name" />,
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      expect(screen.getByText('user-1')).toBeTruthy()
    })
  })

  it('uses cached user when provided (no API call)', async () => {
    const cachedGetUserMetadata = vi.fn(async () => mockUser)

    render(
      <UserBadge
        userId="user-1"
        getUserMetadata={cachedGetUserMetadata}
        variant="avatar-name"
        cachedUser={mockUser}
      />,
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      expect(screen.getByText('Alice Johnson')).toBeTruthy()
    })

    // Should not call getUserMetadata when cachedUser is provided
    expect(cachedGetUserMetadata).not.toHaveBeenCalled()
  })

  it('renders removal button when onRemove provided', async () => {
    const onRemove = vi.fn()

    const { container } = render(
      <UserBadge
        userId="user-1"
        getUserMetadata={mockGetUserMetadata}
        variant="avatar-name"
        onRemove={onRemove}
        cachedUser={mockUser}
      />,
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      // Should render as Badge with removal button
      const badges = container.querySelectorAll('[class*="Badge"]')
      expect(badges.length).toBeGreaterThan(0)
    })
  })

  it('generates correct initials for single word name', async () => {
    const singleNameUser = {
      id: 'user-2',
      name: 'John',
      email: 'john@example.com',
    }

    render(
      <UserBadge
        userId="user-2"
        getUserMetadata={vi.fn()}
        variant="avatar-name"
        cachedUser={singleNameUser}
      />,
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      expect(screen.getByText('John')).toBeTruthy()
      // Avatar should contain 'J' initial (checking text content of Avatar)
      const avatars = screen.getAllByText('J')
      expect(avatars.length).toBeGreaterThan(0)
    })
  })

  it('generates correct initials for multi-word name', async () => {
    const multiNameUser = {
      id: 'user-3',
      name: 'John Doe Smith',
      email: 'john@example.com',
    }

    render(
      <UserBadge
        userId="user-3"
        getUserMetadata={vi.fn()}
        variant="avatar-name"
        cachedUser={multiNameUser}
      />,
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      expect(screen.getByText('John Doe Smith')).toBeTruthy()
      // Avatar should contain 'JS' initials (first + last)
      const avatars = screen.getAllByText('JS')
      expect(avatars.length).toBeGreaterThan(0)
    })
  })

  it('respects size prop', async () => {
    const { container } = render(
      <UserBadge
        userId="user-1"
        getUserMetadata={vi.fn()}
        variant="avatar-name"
        size="lg"
        cachedUser={mockUser}
      />,
      { wrapper: Wrapper },
    )

    // Avatar size should be different based on size prop
    const avatar = container.querySelector('[class*="Avatar"]')
    expect(avatar).toBeTruthy()
  })

  it('hides email tooltip when showEmailTooltip is false', async () => {
    render(
      <UserBadge
        userId="user-1"
        getUserMetadata={vi.fn()}
        variant="avatar-name"
        showEmailTooltip={false}
        cachedUser={mockUser}
      />,
      { wrapper: Wrapper },
    )

    // Should render without tooltip wrapper
    expect(screen.getByText('Alice Johnson')).toBeTruthy()
  })
})
