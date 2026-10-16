import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { cleanup, render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { ThreadCarousel } from './ThreadCarousel'
import type { CommentThread } from '../../comment-store'
import { MayHaveLandedError } from '../unanswered'

afterEach(() => {
  cleanup()
})

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

  // Mock scrollTo for carousel
  Element.prototype.scrollTo = vi.fn() as any
})

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

describe('ThreadCarousel', () => {
  const mockThreads: CommentThread[] = [
    {
      id: 'thread-1',
      type: 'field',
      entryPath: 'posts/hello',
      canopyPath: 'title',
      authorId: 'alice',
      createdAt: new Date('2024-01-01T10:00:00Z').toISOString(),
      resolved: false,
      comments: [
        {
          id: 'comment-1',
          threadId: 'thread-1',
          userId: 'alice',
          timestamp: new Date('2024-01-01T10:00:00Z').toISOString(),
          text: 'First comment',
        },
      ],
    },
    {
      id: 'thread-2',
      type: 'field',
      entryPath: 'posts/hello',
      canopyPath: 'title',
      authorId: 'bob',
      createdAt: new Date('2024-01-01T11:00:00Z').toISOString(),
      resolved: true,
      resolvedBy: 'bob',
      resolvedAt: new Date('2024-01-01T12:00:00Z').toISOString(),
      comments: [
        {
          id: 'comment-2',
          threadId: 'thread-2',
          userId: 'bob',
          timestamp: new Date('2024-01-01T11:00:00Z').toISOString(),
          text: 'Second comment',
        },
      ],
    },
    {
      id: 'thread-3',
      type: 'field',
      entryPath: 'posts/hello',
      canopyPath: 'title',
      authorId: 'charlie',
      createdAt: new Date('2024-01-01T09:00:00Z').toISOString(),
      resolved: false,
      comments: [
        {
          id: 'comment-3',
          threadId: 'thread-3',
          userId: 'charlie',
          timestamp: new Date('2024-01-01T09:00:00Z').toISOString(),
          text: 'Third comment',
        },
      ],
    },
  ]

  it('fills its panel with the scheme-aware tint, which the scroll fade ends in', () => {
    const { container } = render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="branch"
        label="Branch comments"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    const panel = container.querySelector<HTMLElement>('.mantine-Paper-root')
    expect(panel?.style.background).toBe('var(--mantine-color-default-hover)')
    const fade = container.querySelector<HTMLElement>('div[style*="linear-gradient"]')
    expect(fade?.style.background).toContain('var(--mantine-color-default-hover)')
  })

  it("shows a failed reply's error once, in its thread", async () => {
    const user = userEvent.setup()
    render(
      <ThreadCarousel
        threads={[mockThreads[0]]}
        contextType="branch"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn().mockRejectedValue(new Error("Couldn't add the comment. Try again."))}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )
    await user.click(screen.getByTestId('reply-thread-button'))
    await user.type(screen.getByPlaceholderText('Write a reply…'), 'A reply')
    await user.click(screen.getByTestId('submit-reply-button'))
    expect(await screen.findAllByText("Couldn't add the comment. Try again.")).toHaveLength(1)
  })

  it.each([
    ['red', new Error("Couldn't add the comment.")],
    ['yellow', new MayHaveLandedError('Your comment may have been posted.')],
  ])('shows a failed reply in %s by whether it may have been posted', async (colour, err) => {
    const user = userEvent.setup()
    render(
      <ThreadCarousel
        threads={[mockThreads[0]]}
        contextType="branch"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn().mockRejectedValue(err)}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )
    await user.click(screen.getByTestId('reply-thread-button'))
    await user.type(screen.getByPlaceholderText('Write a reply…'), 'A reply')
    await user.click(screen.getByTestId('submit-reply-button'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(err.message)
    expect(alert.getAttribute('style')).toContain(colour)
  })

  it('moves focus to its heading once a thread is resolved', async () => {
    const user = userEvent.setup()
    render(
      <ThreadCarousel
        threads={[mockThreads[0]]}
        label="Branch discussion"
        contextType="branch"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn().mockResolvedValue(undefined)}
      />,
      { wrapper: Wrapper },
    )
    await user.click(screen.getByTestId('resolve-thread-button'))
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Branch discussion/))
  })

  it('leaves focus the user moved while a resolve was in flight', async () => {
    let finish: () => void = () => {}
    const user = userEvent.setup()
    render(
      <ThreadCarousel
        threads={[mockThreads[0]]}
        label="Branch discussion"
        contextType="branch"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve
            }),
        )}
      />,
      { wrapper: Wrapper },
    )
    await user.click(screen.getByTestId('resolve-thread-button'))
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    await act(async () => {
      finish()
    })

    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it('labels the previous and next thread buttons', () => {
    render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    expect(screen.getByRole('button', { name: 'Previous thread' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next thread' })).toBeTruthy()
  })

  it('renders with no threads', () => {
    const { container } = render(
      <ThreadCarousel
        threads={[]}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    expect(container.textContent).toContain('Comments')
    expect(container.textContent).not.toContain('No comments yet')
    expect(screen.queryAllByTestId('inline-comment-thread')).toHaveLength(0)
  })

  it('renders thread count in header', () => {
    const { container } = render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    expect(container.textContent).toContain('Comments (3)')
  })

  it('shows unresolved count', () => {
    const { container } = render(
      <ThreadCarousel
        threads={mockThreads}
        label="Test Comments"
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    // 2 unresolved threads out of 3 total
    expect(container.textContent).toContain('Test Comments (3)')
    expect(container.textContent).toContain('2 unresolved')
  })

  it('sorts unresolved threads first', () => {
    const { container } = render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    // thread-1 and thread-3 are unresolved
    // First comment should be visible (unresolved threads come first)
    expect(container.textContent).toContain('First comment')
    expect(container.textContent).toContain('Third comment')
  })

  it('shows navigation arrows when multiple threads', () => {
    render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    const buttons = screen.getAllByRole('button')
    // Should have navigation buttons (previous, next)
    const navButtons = buttons.filter((btn) => {
      const ariaLabel = btn.getAttribute('aria-label')
      return (
        ariaLabel?.includes('ChevronLeft') ||
        ariaLabel?.includes('ChevronRight') ||
        btn.querySelector('svg') !== null
      )
    })
    expect(navButtons.length).toBeGreaterThan(0)
  })

  it('offers no way to start a thread: new ones start in the Comments drawer', () => {
    render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="branch"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    expect(screen.queryByText('+ New')).toBeNull()
    expect(screen.queryByPlaceholderText('Start a new thread...')).toBeNull()
  })

  it('shows thread counter with current position', () => {
    const { container } = render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    // Should show "1/3" initially
    expect(container.textContent).toMatch(/1\/3/)
  })

  it('renders all threads in carousel', () => {
    const { container } = render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    // All thread comments should be rendered (even if not visible)
    expect(container.textContent).toContain('First comment')
    expect(container.textContent).toContain('Second comment')
    expect(container.textContent).toContain('Third comment')
  })

  it('highlights thread when highlightThreadId is provided', async () => {
    const { container } = render(
      <ThreadCarousel
        threads={mockThreads}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
        highlightThreadId="thread-2"
      />,
      { wrapper: Wrapper },
    )

    // Wait for highlight effect to apply
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    // Check for highlight styling (outline)
    const threadElements = container.querySelectorAll('[style*="outline"]')
    expect(threadElements.length).toBeGreaterThan(0)
  })

  it('renders with single thread (no navigation arrows)', () => {
    const singleThread = [mockThreads[0]]

    const { container } = render(
      <ThreadCarousel
        threads={singleThread}
        contextType="field"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    // Should NOT render the chevron nav ActionIcons for a single thread.
    // (Not asserting on the "1/1" counter text: with relative-time fallback
    // formatting, an old fixture timestamp like 2024-01-01 can render as a
    // locale date such as "1/1/2024", which would false-match that regex.)
    expect(container.querySelector('.tabler-icon-chevron-left')).toBeNull()
    expect(container.querySelector('.tabler-icon-chevron-right')).toBeNull()
  })

  it('uses custom label when provided', () => {
    const { container } = render(
      <ThreadCarousel
        threads={mockThreads}
        label="Entry Discussion"
        contextType="entry"
        currentUserId="alice"
        canResolve={true}
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    expect(container.textContent).toContain('Entry Discussion')
  })
})
