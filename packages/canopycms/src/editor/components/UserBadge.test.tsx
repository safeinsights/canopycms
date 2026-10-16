import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { SWRConfig } from 'swr'
import { UserBadge } from './UserBadge'
import type { UserSearchResult } from '../../auth/types'
import { CanopyCMSProvider } from '../theme'

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

const SWRWrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
)

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

    // The name is there for assistive tech only, never as visible text.
    const hidden = screen.getByText('Alice Johnson')
    expect(hidden.className).toContain('mantine-VisuallyHidden-root')
  })

  it("gives an avatar-only badge's tooltip the name before the email", async () => {
    const { container } = render(
      <UserBadge userId="user-1" getUserMetadata={mockGetUserMetadata} variant="avatar-only" />,
      { wrapper: Wrapper },
    )
    await screen.findByText('Alice Johnson')
    await userEvent.hover(container.querySelector('.mantine-Avatar-root') as HTMLElement)

    expect((await screen.findByRole('tooltip')).textContent).toBe(
      `Alice Johnson, ${mockUser.email}`,
    )
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

    it.each([
      ['filled', 'var(--mantine-color-white)'],
      ['light', 'var(--mantine-color-text)'],
      ['outline', 'var(--mantine-color-text)'],
    ] as const)('draws the X of a %s badge in a colour that shows on it', (badgeVariant, color) => {
      render(
        <UserBadge
          userId="user-1"
          getUserMetadata={vi.fn()}
          cachedUser={mockUser}
          badgeVariant={badgeVariant}
          onRemove={vi.fn()}
        />,
        { wrapper: Wrapper },
      )
      expect(screen.getByRole('button', { name: 'Remove Alice Johnson' }).style.color).toBe(color)
    })

    it("opens only the X's tooltip, not the badge's email one as well, while the pointer is on the X", async () => {
      render(
        <UserBadge
          userId="user-1"
          getUserMetadata={vi.fn()}
          cachedUser={mockUser}
          onRemove={vi.fn()}
        />,
        { wrapper: Wrapper },
      )
      await userEvent.hover(screen.getByText('Alice Johnson'))
      expect((await screen.findByRole('tooltip')).textContent).toBe(
        'Alice Johnson, alice@example.com',
      )

      await userEvent.hover(screen.getByRole('button', { name: 'Remove Alice Johnson' }))
      await waitFor(() =>
        expect(screen.getAllByRole('tooltip').map((t) => t.textContent)).toEqual([
          'Remove Alice Johnson',
        ]),
      )
    })

    it("keeps the badge's email tooltip shut while focus is on the X", async () => {
      render(
        <CanopyCMSProvider>
          <UserBadge
            userId="user-1"
            getUserMetadata={vi.fn()}
            cachedUser={mockUser}
            onRemove={vi.fn()}
          />
        </CanopyCMSProvider>,
        { wrapper: SWRWrapper },
      )
      await userEvent.tab()
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove Alice Johnson' }),
      )
      await waitFor(() =>
        expect(screen.getAllByRole('tooltip').map((t) => t.textContent)).toEqual([
          'Remove Alice Johnson',
        ]),
      )
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

  describe('an avatar is always hidden from assistive tech', () => {
    const accessibleText = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('*'))
        .filter((el) => el.tagName !== 'STYLE' && !el.closest('[aria-hidden="true"]'))
        .flatMap((el) => Array.from(el.childNodes))
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')

    it('beside a name, has empty alt and aria-hidden', () => {
      const { container } = render(
        <UserBadge userId="user-1" getUserMetadata={vi.fn()} cachedUser={mockUser} />,
        { wrapper: Wrapper },
      )
      expect(container.querySelector('.mantine-Avatar-root')?.getAttribute('aria-hidden')).toBe(
        'true',
      )
      expect(container.querySelector('img')?.getAttribute('alt')).toBe('')
    })

    it('alone with initials, hides the initials and names the person in visually hidden text', () => {
      const { container } = render(
        <UserBadge
          userId="user-3"
          getUserMetadata={vi.fn()}
          cachedUser={{ id: 'user-3', name: 'Alice Johnson', email: 'alice@example.com' }}
          variant="avatar-only"
        />,
        { wrapper: Wrapper },
      )
      const avatar = container.querySelector('.mantine-Avatar-root')
      expect(avatar?.textContent).toBe('AJ')
      expect(avatar?.getAttribute('aria-hidden')).toBe('true')
      expect(accessibleText(container)).toBe('Alice Johnson, alice@example.com')
      expect(screen.getByText('Alice Johnson').className).toContain('mantine-VisuallyHidden-root')
    })

    it('alone with a picture, has empty alt and names the person in visually hidden text', () => {
      const { container } = render(
        <UserBadge
          userId="user-1"
          getUserMetadata={vi.fn()}
          cachedUser={mockUser}
          variant="avatar-only"
        />,
        { wrapper: Wrapper },
      )
      expect(container.querySelector('.mantine-Avatar-root')?.getAttribute('aria-hidden')).toBe(
        'true',
      )
      expect(container.querySelector('img')?.getAttribute('alt')).toBe('')
      expect(accessibleText(container)).toBe('Alice Johnson, alice@example.com')
    })

    it('alone as the anonymous user, is named "Anonymous (Public)" in visually hidden text', () => {
      const { container } = render(
        <UserBadge
          userId="anonymous"
          getUserMetadata={vi.fn()}
          cachedUser={{ id: 'anonymous', name: 'Anonymous', email: 'public' }}
          variant="avatar-only"
        />,
        { wrapper: Wrapper },
      )
      expect(container.querySelector('.mantine-Avatar-root')?.getAttribute('aria-hidden')).toBe(
        'true',
      )
      expect(screen.getByText('Anonymous (Public)').className).toContain(
        'mantine-VisuallyHidden-root',
      )
    })
  })

  describe('a person whose name is empty or is their id', () => {
    const ID = 'user_2abNameless'
    const nameless = (name: string, extra: Partial<UserSearchResult> = {}): UserSearchResult => ({
      id: ID,
      name,
      email: '',
      ...extra,
    })
    const unusableNames = [
      ['their id', ID],
      ['padded with their id', `  ${ID} `],
      ['empty', ''],
      ['blank', '   '],
    ] as const

    // Every attribute a screen reader or a hover can reach, as well as the text.
    const reachable = (container: HTMLElement): string =>
      [
        container.textContent,
        ...Array.from(container.querySelectorAll('[aria-label], [title], img[alt]')).flatMap(
          (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')],
        ),
      ].join('|')

    it.each(unusableNames)('says the name is unavailable when it is %s', async (_label, name) => {
      const { container } = render(
        <UserBadge userId={ID} getUserMetadata={vi.fn()} cachedUser={nameless(name)} />,
        { wrapper: Wrapper },
      )
      const fallback = screen.getByText('Name unavailable')
      expect(fallback.style.fontStyle).toBe('italic')
      expect(fallback.style.color).toBe('var(--mantine-color-dimmed)')
      expect(reachable(container)).not.toContain(ID)
    })

    it('treats a fetched record the same as a cached one', async () => {
      const { container } = render(
        <UserBadge userId={ID} getUserMetadata={async () => nameless(ID)} />,
        { wrapper: Wrapper },
      )
      expect(await screen.findByText('Name unavailable')).toBeTruthy()
      expect(reachable(container)).not.toContain(ID)
    })

    it('shows no initials for it', () => {
      const { container } = render(
        <UserBadge userId={ID} getUserMetadata={vi.fn()} cachedUser={nameless('')} />,
        { wrapper: Wrapper },
      )
      expect(container.querySelector('.mantine-Avatar-root')?.textContent).toBe('')
    })

    it('hides the id from an avatar-only badge, which names itself by the fallback', () => {
      const { container } = render(
        <UserBadge
          userId={ID}
          getUserMetadata={vi.fn()}
          cachedUser={nameless(ID)}
          variant="avatar-only"
        />,
        { wrapper: Wrapper },
      )
      expect(screen.getByText('Name unavailable')).toBeTruthy()
      expect(reachable(container)).not.toContain(ID)
    })

    it('hides the id from the full variant, which keeps the email it has', () => {
      const { container } = render(
        <UserBadge
          userId={ID}
          getUserMetadata={vi.fn()}
          cachedUser={nameless(ID, { email: 'private.person@example.com' })}
          variant="full"
        />,
        { wrapper: Wrapper },
      )
      expect(screen.getByText('Name unavailable')).toBeTruthy()
      expect(screen.getByText('private.person@example.com')).toBeTruthy()
      expect(reachable(container)).not.toContain(ID)
    })

    it('keeps its avatar image and puts its email in the tooltip and the hidden text', async () => {
      const { container } = render(
        <UserBadge
          userId={ID}
          getUserMetadata={vi.fn()}
          cachedUser={nameless(ID, {
            email: 'private.person@example.com',
            avatarUrl: 'https://example.com/face.jpg',
          })}
        />,
        { wrapper: Wrapper },
      )
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://example.com/face.jpg',
      )
      expect(screen.getByText(', private.person@example.com').className).toContain(
        'mantine-VisuallyHidden-root',
      )
      await userEvent.hover(container.querySelector('.mantine-Avatar-root') as HTMLElement)
      expect((await screen.findByRole('tooltip')).textContent).toBe('private.person@example.com')
      expect(reachable(container)).not.toContain(ID)
    })

    it('names an avatar-only badge by the fallback and the email it has', () => {
      render(
        <UserBadge
          userId={ID}
          getUserMetadata={vi.fn()}
          cachedUser={nameless('', { email: 'private.person@example.com' })}
          variant="avatar-only"
        />,
        { wrapper: Wrapper },
      )
      expect(screen.getByText('Name unavailable, private.person@example.com')).toBeTruthy()
    })

    it('labels the Remove button by the fallback, adding the id only for an admin surface', async () => {
      const { unmount } = render(
        <UserBadge
          userId={ID}
          getUserMetadata={vi.fn()}
          cachedUser={nameless(ID)}
          onRemove={vi.fn()}
        />,
        { wrapper: Wrapper },
      )
      const remove = screen.getByRole('button', { name: 'Remove Name unavailable' })
      await userEvent.hover(remove)
      for (const tooltip of await screen.findAllByRole('tooltip')) {
        expect(tooltip.textContent).not.toContain(ID)
      }
      unmount()

      render(
        <UserBadge
          userId={ID}
          getUserMetadata={vi.fn()}
          cachedUser={nameless(ID)}
          onRemove={vi.fn()}
          revealIdOnFallback
        />,
        { wrapper: Wrapper },
      )
      expect(screen.getByRole('button', { name: `Remove Name unavailable · ${ID}` })).toBeTruthy()
    })
  })

  describe('a long name beside a photo avatar', () => {
    const longName = 'Alexandria Montgomery-Featherstonehaugh de la Cruz Fitzgerald'
    const photoUser: UserSearchResult = {
      id: 'photo-user',
      name: longName,
      email: 'long.name@example.com',
      avatarUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    }

    // jsdom has no layout, so these pin the rules that keep the avatar and name on one line.
    const renderChip = async (props: Partial<React.ComponentProps<typeof UserBadge>> = {}) => {
      const view = render(
        <UserBadge
          userId="photo-user"
          getUserMetadata={vi.fn()}
          cachedUser={photoUser}
          variant="avatar-name"
          size="xs"
          showBadge
          badgeVariant="light"
          color="gray"
          {...props}
        />,
        { wrapper: Wrapper },
      )
      const name = await screen.findByText(longName)
      return { ...view, name }
    }

    it('keeps the label on one line and cuts it with an ellipsis', async () => {
      const { container, name } = await renderChip()
      expect(name.getAttribute('data-truncate')).toBe('end')
      const row = name.parentElement as HTMLElement
      expect(row.style.getPropertyValue('--group-wrap')).toBe('nowrap')
      expect(row.querySelector('.mantine-Avatar-root')).toBeTruthy()
      const label = container.querySelector('.mantine-Badge-label') as HTMLElement
      expect(label.style.minWidth).toBe('0')
    })

    it('gives the full name and email in the tooltip', async () => {
      const { name } = await renderChip()
      await userEvent.hover(name)
      expect((await screen.findByRole('tooltip')).textContent).toBe(
        `${longName}, long.name@example.com`,
      )
    })

    it('gives the full name as a title when no tooltip opens', async () => {
      const { name } = await renderChip({ showEmailTooltip: false })
      expect(name.getAttribute('title')).toBe(longName)
    })

    it('keeps the unavailable fallback on one line beside the avatar', async () => {
      const { unmount } = await renderChip()
      unmount()
      render(
        <UserBadge
          userId="gone"
          getUserMetadata={vi.fn()}
          cachedUser={{ id: 'gone', name: '', email: '', avatarUrl: photoUser.avatarUrl }}
          showBadge
        />,
        { wrapper: Wrapper },
      )
      const fallback = screen.getByText('Name unavailable')
      expect(fallback.getAttribute('data-truncate')).toBe('end')
      expect((fallback.parentElement as HTMLElement).style.getPropertyValue('--group-wrap')).toBe(
        'nowrap',
      )
    })
  })
})
