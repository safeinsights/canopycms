import { describe, it, expect, vi, beforeAll } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { InlineCommentThread } from './InlineCommentThread'
import type { CommentThread } from '../../comment-store'

// Setup for Mantine components
beforeAll(() => {
  // Mantine color scheme helpers expect matchMedia to exist (jsdom does not provide it)
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

// Wrapper for Mantine components
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

describe('InlineCommentThread', () => {
  const mockThread: CommentThread = {
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
        text: 'This needs improvement',
      },
      {
        id: 'comment-2',
        threadId: 'thread-1',
        userId: 'bob',
        timestamp: new Date('2024-01-01T11:00:00Z').toISOString(),
        text: 'I agree, let me revise',
      },
    ],
  }

  const mockResolvedThread: CommentThread = {
    ...mockThread,
    id: 'thread-2',
    resolved: true,
    resolvedBy: 'alice',
    resolvedAt: new Date('2024-01-01T12:00:00Z').toISOString(),
  }

  it('renders all comments in thread', () => {
    render(
      <InlineCommentThread
        thread={mockThread}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        currentUserId="alice"
        canResolve={true}
      />,
      { wrapper: Wrapper },
    )

    expect(screen.getByText('This needs improvement')).toBeTruthy()
    expect(screen.getByText('I agree, let me revise')).toBeTruthy()
  })

  it('shows unresolved badge when thread is not resolved', () => {
    render(
      <InlineCommentThread
        thread={mockThread}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        currentUserId="alice"
        canResolve={true}
      />,
      { wrapper: Wrapper },
    )

    expect(screen.getAllByText('Unresolved').length).toBeGreaterThan(0)
    expect(screen.queryAllByText('Resolved')).toHaveLength(0)
  })

  it('shows resolved badge when thread is resolved', () => {
    const { container } = render(
      <InlineCommentThread
        thread={mockResolvedThread}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        currentUserId="alice"
        canResolve={true}
      />,
      { wrapper: Wrapper },
    )

    // Check that Resolved badge exists and Unresolved doesn't
    expect(container.textContent).toContain('Resolved')
    expect(container.textContent).not.toContain('Unresolved')
  })

  it('shows resolved metadata when thread is resolved', () => {
    const { container } = render(
      <InlineCommentThread
        thread={mockResolvedThread}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        currentUserId="alice"
        canResolve={true}
      />,
      { wrapper: Wrapper },
    )

    // Check that resolved metadata is present in the DOM
    // Using container.textContent to check the full text content
    const text = container.textContent || ''
    expect(text).toMatch(/Resolved by.*alice/)
  })

  const renderThread = (props: Partial<React.ComponentProps<typeof InlineCommentThread>> = {}) =>
    render(
      <InlineCommentThread
        thread={mockThread}
        onAddReply={vi.fn().mockResolvedValue(undefined)}
        onResolve={vi.fn().mockResolvedValue(undefined)}
        currentUserId="charlie"
        canResolve={true}
        {...props}
      />,
      { wrapper: Wrapper },
    )

  describe('reply', () => {
    it('shows a Reply button and no reply box until Reply is clicked', async () => {
      const user = userEvent.setup()
      renderThread()

      expect(screen.getByTestId('reply-thread-button')).toBeTruthy()
      expect(screen.queryByLabelText('Reply to this thread')).toBeNull()
      expect(screen.queryByTestId('submit-reply-button')).toBeNull()

      await user.click(screen.getByTestId('reply-thread-button'))

      const box = screen.getByLabelText('Reply to this thread')
      expect(document.activeElement).toBe(box)
      expect(screen.getByTestId('submit-reply-button')).toBeTruthy()
      expect(screen.queryByTestId('reply-thread-button')).toBeNull()
    })

    it('Cancel collapses the box and keeps the draft for the next Reply', async () => {
      const user = userEvent.setup()
      renderThread()

      await user.click(screen.getByTestId('reply-thread-button'))
      await user.type(screen.getByLabelText('Reply to this thread'), 'Half a thought')
      await user.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByLabelText('Reply to this thread')).toBeNull()
      expect(document.activeElement).toBe(screen.getByTestId('reply-thread-button'))

      await user.click(screen.getByTestId('reply-thread-button'))
      expect((screen.getByLabelText('Reply to this thread') as HTMLTextAreaElement).value).toBe(
        'Half a thought',
      )
    })

    it('starts expanded when the caller already holds a draft', () => {
      renderThread({ replyText: 'Unsent', onReplyTextChange: vi.fn() })

      expect((screen.getByLabelText('Reply to this thread') as HTMLTextAreaElement).value).toBe(
        'Unsent',
      )
      expect(screen.queryByTestId('reply-thread-button')).toBeNull()
    })

    it('posts the text, then collapses and returns focus to Reply', async () => {
      const onAddReply = vi.fn().mockResolvedValue(undefined)
      const user = userEvent.setup()
      renderThread({ onAddReply })

      await user.click(screen.getByTestId('reply-thread-button'))
      await user.type(screen.getByLabelText('Reply to this thread'), 'My reply')
      await user.click(screen.getByTestId('submit-reply-button'))

      await waitFor(() => expect(screen.queryByLabelText('Reply to this thread')).toBeNull())
      expect(onAddReply).toHaveBeenCalledWith('My reply')
      expect(document.activeElement).toBe(screen.getByTestId('reply-thread-button'))
      await user.click(screen.getByTestId('reply-thread-button'))
      expect((screen.getByLabelText('Reply to this thread') as HTMLTextAreaElement).value).toBe('')
    })

    it('keeps the box open with the text, and shows one error, when the reply fails', async () => {
      const onAddReply = vi.fn().mockRejectedValue(new Error("Couldn't add the comment."))
      const user = userEvent.setup()
      renderThread({ onAddReply })

      await user.click(screen.getByTestId('reply-thread-button'))
      await user.type(screen.getByLabelText('Reply to this thread'), 'Keep me')
      await user.click(screen.getByTestId('submit-reply-button'))

      expect(await screen.findAllByText("Couldn't add the comment.")).toHaveLength(1)
      const box = screen.getByLabelText('Reply to this thread') as HTMLTextAreaElement
      expect(box.value).toBe('Keep me')
      await waitFor(() => expect(document.activeElement).toBe(box))
    })

    it('shows progress on Reply only, and disables Resolve, while a reply is in flight', async () => {
      let finish: () => void = () => {}
      const onAddReply = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      const user = userEvent.setup()
      renderThread({ onAddReply })

      await user.click(screen.getByTestId('reply-thread-button'))
      await user.type(screen.getByLabelText('Reply to this thread'), 'Slow reply')
      await user.click(screen.getByTestId('submit-reply-button'))

      const resolve = screen.getByTestId('resolve-thread-button') as HTMLButtonElement
      expect(screen.getByTestId('submit-reply-button').hasAttribute('data-loading')).toBe(true)
      expect(resolve.disabled).toBe(true)
      expect(resolve.hasAttribute('data-loading')).toBe(false)

      await act(async () => {
        finish()
      })
      await waitFor(() => expect(screen.queryByTestId('submit-reply-button')).toBeNull())
    })

    it('shows progress on Resolve only, and disables Reply, while a resolve is in flight', async () => {
      let finish: () => void = () => {}
      const onResolve = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      const user = userEvent.setup()
      renderThread({ onResolve })

      await user.click(screen.getByTestId('resolve-thread-button'))

      expect(screen.getByTestId('resolve-thread-button').hasAttribute('data-loading')).toBe(true)
      expect((screen.getByTestId('reply-thread-button') as HTMLButtonElement).disabled).toBe(true)

      await act(async () => {
        finish()
      })
      await waitFor(() =>
        expect(screen.getByTestId('resolve-thread-button').hasAttribute('data-loading')).toBe(
          false,
        ),
      )
    })

    it('does not show a resolve in flight as progress on the open reply box', async () => {
      let finish: () => void = () => {}
      const onResolve = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      const user = userEvent.setup()
      renderThread({ onResolve })

      await user.click(screen.getByTestId('reply-thread-button'))
      await user.type(screen.getByLabelText('Reply to this thread'), 'A draft')
      await user.click(screen.getByTestId('resolve-thread-button'))

      const submit = screen.getByTestId('submit-reply-button') as HTMLButtonElement
      expect(screen.getByTestId('resolve-thread-button').hasAttribute('data-loading')).toBe(true)
      expect(submit.hasAttribute('data-loading')).toBe(false)
      expect(submit.disabled).toBe(true)

      await act(async () => {
        finish()
      })
    })

    it('disables the submit button until there is text', async () => {
      const user = userEvent.setup()
      renderThread()

      await user.click(screen.getByTestId('reply-thread-button'))
      const submit = screen.getByTestId('submit-reply-button') as HTMLButtonElement
      expect(submit.disabled).toBe(true)

      await user.type(screen.getByLabelText('Reply to this thread'), 'Some text')
      expect(submit.disabled).toBe(false)
    })
  })

  it('shows resolve button when user can resolve and thread is unresolved', () => {
    render(
      <InlineCommentThread
        thread={mockThread}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        currentUserId="alice"
        canResolve={true}
      />,
      { wrapper: Wrapper },
    )

    const resolveButtons = screen.getAllByRole('button', { name: /resolve/i })
    expect(resolveButtons.length).toBeGreaterThan(0)
  })

  it('hides Resolve from a user who cannot resolve any thread and did not start this one', () => {
    renderThread({ canResolve: false })

    expect(screen.getByTestId('reply-thread-button')).toBeTruthy()
    expect(screen.queryByTestId('resolve-thread-button')).toBeNull()
  })

  it('shows Resolve to the thread author even without the right to resolve any thread', () => {
    renderThread({ canResolve: false, currentUserId: 'alice' })

    expect(screen.getByTestId('resolve-thread-button')).toBeTruthy()
  })

  it('hides resolve button when thread is already resolved', () => {
    const { container } = render(
      <InlineCommentThread
        thread={mockResolvedThread}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        currentUserId="alice"
        canResolve={true}
      />,
      { wrapper: Wrapper },
    )

    // Check that there's no button with exactly "Resolve" text
    const buttons = Array.from(container.querySelectorAll('button'))
    const resolveButton = buttons.find((btn) => btn.textContent === 'Resolve')
    expect(resolveButton).toBeUndefined()
  })

  it('calls onResolve when Resolve is clicked, and shows its failure once', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('Could not resolve.'))
    const user = userEvent.setup()
    renderThread({ onResolve })

    await user.click(screen.getByTestId('resolve-thread-button'))

    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(await screen.findAllByText('Could not resolve.')).toHaveLength(1)
  })

  it('formats timestamps correctly', () => {
    const recentThread: CommentThread = {
      ...mockThread,
      comments: [
        {
          id: 'comment-recent',
          threadId: 'thread-1',
          userId: 'alice',
          timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
          text: 'Recent comment',
        },
      ],
    }

    render(
      <InlineCommentThread
        thread={recentThread}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        currentUserId="alice"
        canResolve={true}
      />,
      { wrapper: Wrapper },
    )

    expect(screen.getByText(/2m ago/)).toBeTruthy()
  })

  it('renders multiple comments with separators', () => {
    const { container } = render(
      <InlineCommentThread
        thread={mockThread}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        currentUserId="alice"
        canResolve={true}
      />,
      { wrapper: Wrapper },
    )

    // Both comments should be visible
    expect(container.textContent).toContain('This needs improvement')
    expect(container.textContent).toContain('I agree, let me revise')
    // Both users should be visible
    expect(container.textContent).toContain('alice')
    expect(container.textContent).toContain('bob')
  })
})
