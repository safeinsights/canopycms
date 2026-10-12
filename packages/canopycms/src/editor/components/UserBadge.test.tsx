import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { SWRConfig } from 'swr'
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

// A fresh SWR cache per render, so one test's user never answers another's.
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map() }}>
    <MantineProvider>{children}</MantineProvider>
  </SWRConfig>
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

  it('says the name could not load on error, never showing the id', async () => {
    const errorGetUserMetadata = vi.fn(async () => {
      throw new Error('Network error')
    })

    render(
      <UserBadge userId="user-1" getUserMetadata={errorGetUserMetadata} variant="avatar-name" />,
      { wrapper: Wrapper },
    )

    expect(await screen.findByText("Couldn't load this name")).toBeTruthy()
    expect(screen.queryByText('user-1')).toBeNull()
  })

  it('says the name is unavailable when the user is not found, never showing the id', async () => {
    const notFoundGetUserMetadata = vi.fn(async () => null)

    render(
      <UserBadge userId="user-1" getUserMetadata={notFoundGetUserMetadata} variant="avatar-name" />,
      { wrapper: Wrapper },
    )

    expect(await screen.findByText('Name unavailable')).toBeTruthy()
    expect(screen.queryByText('user-1')).toBeNull()
  })

  it('names an avatar-only badge with no name by its fallback text, not its id', async () => {
    const { container } = render(
      <UserBadge userId="user-1" getUserMetadata={async () => null} variant="avatar-only" />,
      { wrapper: Wrapper },
    )
    expect(await screen.findByText('Name unavailable')).toBeTruthy()
    expect(container.textContent).not.toContain('user-1')
  })

  it('shows an avatar-only badge with no name its fallback in a tooltip, for sighted and touch users', async () => {
    const { container } = render(
      <UserBadge userId="user-1" getUserMetadata={async () => null} variant="avatar-only" />,
      { wrapper: Wrapper },
    )
    await screen.findByText('Name unavailable')
    await userEvent.hover(container.querySelector('.mantine-Avatar-root') as HTMLElement)

    expect((await screen.findByRole('tooltip')).textContent).toBe('Name unavailable')
  })

  it('draws the fallback name dimmed and italic, so it does not read as a real name', async () => {
    render(<UserBadge userId="user-1" getUserMetadata={async () => null} />, { wrapper: Wrapper })
    const fallback = await screen.findByText('Name unavailable')
    expect(fallback.style.color).toBe('var(--mantine-color-dimmed)')
    expect(fallback.style.fontStyle).toBe('italic')
  })

  describe('revealIdOnFallback, for admin-only surfaces', () => {
    it('puts the id in the tooltip and the hidden text, never in the visible text', async () => {
      const { container } = render(
        <UserBadge userId="user-9" getUserMetadata={async () => null} revealIdOnFallback />,
        { wrapper: Wrapper },
      )
      const visible = await screen.findByText('Name unavailable')
      expect(visible.className).not.toContain('VisuallyHidden')
      const hidden = screen.getByText('· user-9')
      expect(hidden.className).toContain('mantine-VisuallyHidden-root')

      await userEvent.hover(container.querySelector('.mantine-Avatar-root') as HTMLElement)
      expect((await screen.findByRole('tooltip')).textContent).toBe('Name unavailable · user-9')
    })

    it('names an avatar-only fallback with the id in its hidden text', async () => {
      render(
        <UserBadge
          userId="user-9"
          getUserMetadata={async () => null}
          variant="avatar-only"
          revealIdOnFallback
        />,
        { wrapper: Wrapper },
      )
      expect(await screen.findByText('Name unavailable · user-9')).toBeTruthy()
    })
  })

  describe('the remove button names its person', () => {
    it('says "Remove <name>" and shows the same text in a tooltip', async () => {
      const onRemove = vi.fn()
      render(
        <UserBadge
          userId="user-1"
          getUserMetadata={vi.fn()}
          cachedUser={mockUser}
          onRemove={onRemove}
        />,
        { wrapper: Wrapper },
      )
      const remove = screen.getByRole('button', { name: 'Remove Alice Johnson' })
      await userEvent.hover(remove)
      const tooltips = await screen.findAllByRole('tooltip')
      expect(tooltips.map((t) => t.textContent)).toContain('Remove Alice Johnson')
      await userEvent.click(remove)
      expect(onRemove).toHaveBeenCalledWith('user-1')
    })

    it('names the fallback for an unresolved person, adding the id only for an admin surface', async () => {
      const { unmount } = render(
        <UserBadge userId="user-9" getUserMetadata={async () => null} onRemove={vi.fn()} />,
        { wrapper: Wrapper },
      )
      expect(await screen.findByRole('button', { name: 'Remove Name unavailable' })).toBeTruthy()
      unmount()

      render(
        <UserBadge
          userId="user-9"
          getUserMetadata={async () => null}
          onRemove={vi.fn()}
          revealIdOnFallback
        />,
        { wrapper: Wrapper },
      )
      expect(
        await screen.findByRole('button', { name: 'Remove Name unavailable · user-9' }),
      ).toBeTruthy()
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

  it('reads the email after the name for a screen reader, without a tab stop', async () => {
    const { container } = render(
      <UserBadge userId="user-1" getUserMetadata={vi.fn()} cachedUser={mockUser} />,
      { wrapper: Wrapper },
    )
    const hidden = screen.getByText(', alice@example.com')
    expect(hidden.className).toContain('mantine-VisuallyHidden-root')
    expect(container.textContent).toContain('Alice Johnson, alice@example.com')
    expect(container.querySelectorAll('button, a, [tabindex]')).toHaveLength(0)
  })

  it('adds no hidden email when the email is empty, hidden by the caller, or already shown', () => {
    const { container, rerender } = render(
      <UserBadge
        userId="user-1"
        getUserMetadata={vi.fn()}
        cachedUser={{ ...mockUser, email: '' }}
      />,
      { wrapper: Wrapper },
    )
    expect(container.querySelector('.mantine-VisuallyHidden-root')).toBeNull()

    rerender(
      <UserBadge
        userId="user-1"
        getUserMetadata={vi.fn()}
        cachedUser={mockUser}
        showEmailTooltip={false}
      />,
    )
    expect(container.querySelector('.mantine-VisuallyHidden-root')).toBeNull()

    rerender(
      <UserBadge userId="user-1" getUserMetadata={vi.fn()} cachedUser={mockUser} variant="full" />,
    )
    expect(container.querySelector('.mantine-VisuallyHidden-root')).toBeNull()
  })

  it('reads the email for an avatar shown alone', () => {
    render(
      <UserBadge
        userId="user-1"
        getUserMetadata={vi.fn()}
        cachedUser={mockUser}
        variant="avatar-only"
      />,
      { wrapper: Wrapper },
    )
    expect(screen.getByText(', alice@example.com')).toBeTruthy()
  })

  describe('in a light comment badge', () => {
    const badgeProps = { showBadge: true, badgeVariant: 'light' as const, color: 'gray' }

    it('draws the name in body text colour, not the faint badge tint', () => {
      render(
        <UserBadge
          userId="user-1"
          getUserMetadata={vi.fn()}
          cachedUser={mockUser}
          {...badgeProps}
        />,
        { wrapper: Wrapper },
      )
      expect(screen.getByText('Alice Johnson').style.color).toBe('var(--mantine-color-text)')
    })

    it('keeps an unnamed user in the same pill, saying the name is unavailable', async () => {
      const { container } = render(
        <UserBadge userId="user-9" getUserMetadata={async () => null} {...badgeProps} />,
        { wrapper: Wrapper },
      )
      const fallback = await screen.findByText('Name unavailable')
      expect(fallback.closest('.mantine-Badge-root')).toBeTruthy()
      expect(fallback.style.color).toBe('var(--mantine-color-dimmed)')
      expect(container.textContent).not.toContain('user-9')
      expect(container.textContent).not.toContain('not found')
    })
  })

  it('hides an avatar that repeats the name beside it, and labels one shown alone', async () => {
    const { container, rerender } = render(
      <UserBadge userId="user-1" getUserMetadata={vi.fn()} cachedUser={mockUser} />,
      { wrapper: Wrapper },
    )
    const avatar = () => container.querySelector('.mantine-Avatar-root')
    expect(avatar()?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('')

    rerender(
      <UserBadge
        userId="user-1"
        getUserMetadata={vi.fn()}
        cachedUser={mockUser}
        variant="avatar-only"
      />,
    )
    expect(avatar()?.getAttribute('aria-hidden')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Alice Johnson')
  })
})
