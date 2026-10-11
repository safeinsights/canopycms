import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { CommentsPanel } from './CommentsPanel'
import type { CommentThread } from '../comment-store'

afterEach(() => {
  cleanup()
})

// Setup for Mantine components (jsdom lacks these)
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

describe('CommentsPanel', () => {
  const recentTimestamp = new Date(Date.now() - 2 * 60 * 1000).toISOString() // 2 minutes ago

  const branchThread: CommentThread = {
    id: 'thread-branch-1',
    type: 'branch',
    authorId: 'alice',
    createdAt: recentTimestamp,
    resolved: false,
    comments: [
      {
        id: 'comment-1',
        threadId: 'thread-branch-1',
        userId: 'alice',
        timestamp: recentTimestamp,
        text: 'A branch-level comment',
      },
    ],
  }

  const renderPanel = (overrides: Partial<React.ComponentProps<typeof CommentsPanel>> = {}) =>
    render(
      <CommentsPanel
        branchName="feature/my-branch"
        comments={[branchThread]}
        canResolve={true}
        currentUserId="alice"
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
        onClose={vi.fn()}
        onJumpToBranch={vi.fn()}
        {...overrides}
      />,
      { wrapper: Wrapper },
    )

  it('shows a composer hint describing branch-level scope', () => {
    renderPanel()

    expect(screen.getByText(/Posts a branch-level comment on "feature\/my-branch"/)).toBeTruthy()
  })

  it('keeps the text and says why when a comment fails', async () => {
    renderPanel({
      onAddComment: vi.fn(async () => {
        throw new Error("Couldn't add the comment. Try again.")
      }),
    })
    const box = screen.getByTestId('comment-textarea') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByTestId('comment-submit'))
    expect(await screen.findByText("Couldn't add the comment. Try again.")).toBeTruthy()
    expect(box.value).toBe('Keep me')
  })

  it('renders an "Open branch discussion" action for branch threads', () => {
    renderPanel()

    expect(screen.getByRole('button', { name: 'Open branch discussion' })).toBeTruthy()
  })

  it('renders comment timestamps as relative time', () => {
    renderPanel()

    // recentTimestamp is ~2 minutes old
    expect(screen.getByText(/2m ago/)).toBeTruthy()
  })

  const fieldThread = (id: string, overrides: Partial<CommentThread> = {}): CommentThread => ({
    id,
    type: 'field',
    entryPath: 'posts/hello',
    canopyPath: 'blocks[0].title',
    authorId: 'alice',
    createdAt: recentTimestamp,
    resolved: false,
    comments: [
      {
        id: `${id}-c1`,
        threadId: id,
        userId: 'alice',
        timestamp: recentTimestamp,
        text: `Comment in ${id}`,
      },
    ],
    ...overrides,
  })

  const card = (id: string) =>
    screen.getByText(`Comment in ${id}`).closest('[data-testid="comment-thread"]') as HTMLElement

  describe('top composer', () => {
    it('only starts branch comments, with no reply mode', async () => {
      const onAddComment = vi.fn().mockResolvedValue(undefined)
      renderPanel({ comments: [fieldThread('t1')], onAddComment })

      expect(screen.getByPlaceholderText('Add a comment…')).toBeTruthy()
      expect(screen.getByTestId('comment-submit').textContent).toBe('Comment')
      expect(screen.queryByText('Replying to thread')).toBeNull()

      await userEvent.click(within(card('t1')).getByTestId('reply-thread-button'))
      expect(screen.queryByText('Replying to thread')).toBeNull()
      expect(screen.getByTestId('comment-submit').textContent).toBe('Comment')

      await userEvent.type(screen.getByTestId('comment-textarea'), 'A new one')
      await userEvent.click(screen.getByTestId('comment-submit'))
      expect(onAddComment).toHaveBeenCalledWith(
        'A new one',
        'branch',
        undefined,
        undefined,
        undefined,
      )
    })
  })

  describe('replying from a thread card', () => {
    it('shows a Reply button per open thread and no reply box until one is clicked', () => {
      renderPanel({ comments: [fieldThread('t1'), fieldThread('t2'), fieldThread('t3')] })

      expect(screen.getAllByTestId('reply-thread-button')).toHaveLength(3)
      // Only the composer at the top is a text box.
      expect(screen.getAllByRole('textbox')).toHaveLength(1)
    })

    it("posts to that thread with the thread's type, entry, field and id", async () => {
      const onAddComment = vi.fn().mockResolvedValue(undefined)
      renderPanel({
        comments: [fieldThread('t1'), fieldThread('t2', { canopyPath: 'meta.summary' })],
        onAddComment,
      })

      const second = card('t2')
      await userEvent.click(within(second).getByTestId('reply-thread-button'))
      await userEvent.type(within(second).getByRole('textbox'), 'On the second')
      await userEvent.click(within(second).getByTestId('submit-reply-button'))

      expect(onAddComment).toHaveBeenCalledTimes(1)
      expect(onAddComment).toHaveBeenCalledWith(
        'On the second',
        'field',
        'posts/hello',
        'meta.summary',
        't2',
      )
    })

    it('shows a failed reply in its own card only, and keeps the text', async () => {
      renderPanel({
        comments: [fieldThread('t1'), fieldThread('t2')],
        onAddComment: vi.fn().mockRejectedValue(new Error("Couldn't add the comment.")),
      })

      const first = card('t1')
      await userEvent.click(within(first).getByTestId('reply-thread-button'))
      await userEvent.type(within(first).getByRole('textbox'), 'Keep this')
      await userEvent.click(within(first).getByTestId('submit-reply-button'))

      expect(await within(first).findByText("Couldn't add the comment.")).toBeTruthy()
      expect(screen.getAllByText("Couldn't add the comment.")).toHaveLength(1)
      expect((within(first).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this')
      expect(within(card('t2')).queryByText("Couldn't add the comment.")).toBeNull()
    })

    it('keeps a draft per thread', async () => {
      renderPanel({ comments: [fieldThread('t1'), fieldThread('t2')] })

      await userEvent.click(within(card('t1')).getByTestId('reply-thread-button'))
      await userEvent.type(within(card('t1')).getByRole('textbox'), 'Draft one')
      await userEvent.click(within(card('t2')).getByTestId('reply-thread-button'))
      await userEvent.type(within(card('t2')).getByRole('textbox'), 'Draft two')

      expect((within(card('t1')).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Draft one',
      )
      expect((within(card('t2')).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Draft two',
      )
    })
  })

  describe('resolving', () => {
    it('shows progress on the resolved thread only', async () => {
      let finish: () => void = () => {}
      const onResolveThread = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      renderPanel({ comments: [fieldThread('a'), fieldThread('b')], onResolveThread })

      await userEvent.click(within(card('a')).getByTestId('resolve-thread-button'))

      expect(
        within(card('a')).getByTestId('resolve-thread-button').hasAttribute('data-loading'),
      ).toBe(true)
      expect(
        within(card('b')).getByTestId('resolve-thread-button').hasAttribute('data-loading'),
      ).toBe(false)
      expect(
        (within(card('b')).getByTestId('reply-thread-button') as HTMLButtonElement).disabled,
      ).toBe(false)
      expect(
        (within(card('a')).getByTestId('reply-thread-button') as HTMLButtonElement).disabled,
      ).toBe(true)

      await act(async () => {
        finish()
      })
      await waitFor(() =>
        expect(
          within(card('a')).getByTestId('resolve-thread-button').hasAttribute('data-loading'),
        ).toBe(false),
      )
    })

    it('shows Resolve to a reviewer on any thread, and to others on their own threads only', () => {
      const comments = [
        fieldThread('mine', { authorId: 'alice' }),
        fieldThread('theirs', { authorId: 'bob' }),
      ]
      const { unmount } = renderPanel({ comments, canResolve: false })
      expect(within(card('mine')).getByTestId('resolve-thread-button')).toBeTruthy()
      expect(within(card('theirs')).queryByTestId('resolve-thread-button')).toBeNull()
      // A card with a Reply button is present, so the missing Resolve is not a missing card.
      expect(within(card('theirs')).getByTestId('reply-thread-button')).toBeTruthy()
      unmount()

      renderPanel({ comments, canResolve: true })
      expect(within(card('theirs')).getByTestId('resolve-thread-button')).toBeTruthy()
    })
  })

  describe('thread headings', () => {
    const comments = [
      fieldThread('f1'),
      fieldThread('e1', { type: 'entry', canopyPath: undefined }),
      branchThread,
    ]
    const headings = () => screen.getAllByTestId('comment-thread-heading').map((h) => h.textContent)

    it('names threads by their human labels when resolvers are given', () => {
      renderPanel({
        comments,
        entryLabel: (entryPath) => (entryPath === 'posts/hello' ? 'Blog post title' : undefined),
        fieldLabel: (_entry, canopyPath) =>
          canopyPath === 'blocks[0].title' ? 'Page sections › Hero › Heading' : undefined,
      })

      expect(headings()).toEqual([
        'Field · Blog post title › Page sections › Hero › Heading',
        'Entry · Blog post title',
        'Branch',
      ])
    })

    it('falls back to the raw paths without resolvers, or when they have no answer', () => {
      const { unmount } = renderPanel({ comments })
      expect(headings()).toEqual([
        'Field · posts/hello › blocks[0].title',
        'Entry · posts/hello',
        'Branch',
      ])
      unmount()

      renderPanel({ comments, entryLabel: () => undefined, fieldLabel: () => undefined })
      expect(headings()).toEqual([
        'Field · posts/hello › blocks[0].title',
        'Entry · posts/hello',
        'Branch',
      ])
    })
  })
})
