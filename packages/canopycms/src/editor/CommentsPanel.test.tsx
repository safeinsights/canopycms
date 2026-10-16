import { useState } from 'react'
import { CLOSE_WAITS_FOR_WRITE } from './comments/use-tracked-writes'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_THEME, defaultCssVariablesResolver } from '@mantine/core'
import { CommentsPanel } from './CommentsPanel'
import { CanopyCMSProvider } from './theme'
import type { CommentThread } from '../comment-store'

const showNotification = vi.hoisted(() => vi.fn())
vi.mock('@mantine/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@mantine/notifications')>('@mantine/notifications')
  return { ...actual, notifications: { ...actual.notifications, show: showNotification } }
})

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
  <CanopyCMSProvider>{children}</CanopyCMSProvider>
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

  const panelProps = (
    overrides: Partial<React.ComponentProps<typeof CommentsPanel>> = {},
  ): React.ComponentProps<typeof CommentsPanel> => ({
    opened: true,
    branchName: 'feature/my-branch',
    comments: [branchThread],
    canResolve: true,
    currentUserId: 'alice',
    onAddComment: vi.fn(),
    onResolveThread: vi.fn(),
    onClose: vi.fn(),
    onJumpToBranch: vi.fn(),
    ...overrides,
  })

  const renderPanel = (overrides: Partial<React.ComponentProps<typeof CommentsPanel>> = {}) =>
    render(<CommentsPanel {...panelProps(overrides)} />, { wrapper: Wrapper })

  it('returns no focus to its opener on a jump, which hands focus to the target', async () => {
    const fieldThread: CommentThread = {
      ...branchThread,
      id: 'thread-field-1',
      type: 'field',
      entryPath: 'content/pages/home',
      canopyPath: 'title',
    }
    const Harness = () => {
      const [opened, setOpened] = useState(false)
      return (
        <>
          <button onClick={() => setOpened(true)}>Open comments</button>
          <CommentsPanel
            {...panelProps({
              opened,
              comments: [fieldThread],
              onJumpToField: vi.fn(),
              onClose: () => setOpened(false),
            })}
          />
        </>
      )
    }
    const user = userEvent.setup()
    render(<Harness />, { wrapper: Wrapper })
    const opener = screen.getByRole('button', { name: 'Open comments' })
    await user.click(opener)
    await user.click(await screen.findByRole('button', { name: 'Jump to field' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Jump to field' })).toBeNull())
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)))
    expect(document.activeElement).not.toBe(opener)
  })

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

  describe('a field thread on a removed item', () => {
    const onItem = fieldThread('on-item', { canopyPath: 'team[1].name', itemKeys: ['k-bo'] })
    const removed = fieldThread('removed', {
      canopyPath: 'team[1].name',
      itemKeys: ['k-gone'],
      onRemovedItem: true,
    })

    it('is marked, and jumps to its entry, not to a field no item holds', async () => {
      const onJumpToEntry = vi.fn()
      const onJumpToField = vi.fn()
      const user = userEvent.setup()
      renderPanel({ comments: [onItem, removed], onJumpToEntry, onJumpToField })

      expect(within(card('removed')).getByText('On a removed item')).toBeTruthy()
      // The heading names the card, so it says so too, for a reader moving by article.
      expect(within(card('removed')).getByTestId('comment-thread-heading').textContent).toMatch(
        /, on a removed item$/,
      )
      expect(within(card('on-item')).getByTestId('comment-thread-heading').textContent).not.toMatch(
        /removed/,
      )
      expect(within(card('removed')).getByRole('button', { name: 'Jump to entry' })).toBeTruthy()
      expect(within(card('removed')).queryByRole('button', { name: 'Jump to field' })).toBeNull()

      // The thread on its item is the other way round.
      expect(within(card('on-item')).queryByText('On a removed item')).toBeNull()
      expect(within(card('on-item')).getByRole('button', { name: 'Jump to field' })).toBeTruthy()
      expect(within(card('on-item')).queryByRole('button', { name: 'Jump to entry' })).toBeNull()

      await user.click(within(card('removed')).getByRole('button', { name: 'Jump to entry' }))
      expect(onJumpToEntry).toHaveBeenCalledWith('posts/hello', 'removed')
      expect(onJumpToField).not.toHaveBeenCalled()
    })

    it('says so once resolved, and still jumps only to its entry', () => {
      renderPanel({
        comments: [{ ...removed, resolved: true }],
        onJumpToEntry: vi.fn(),
        onJumpToField: vi.fn(),
      })
      fireEvent.click(screen.getByLabelText('Show resolved'))

      expect(within(card('removed')).getByText('On a removed item')).toBeTruthy()
      expect(within(card('removed')).getByText('Resolved')).toBeTruthy()
      expect(within(card('removed')).queryByRole('button', { name: 'Jump to field' })).toBeNull()
    })
  })

  describe('jumping from a thread card', () => {
    it('jumps as its Jump button does when the card body is clicked', async () => {
      const onJumpToField = vi.fn()
      const onClose = vi.fn()
      const user = userEvent.setup()
      renderPanel({ comments: [fieldThread('a')], onJumpToField, onClose })

      await user.click(screen.getByText('Comment in a'))
      expect(onJumpToField).toHaveBeenCalledWith('posts/hello', 'blocks[0].title', 'a')
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('jumps an entry thread to its entry and a branch thread to the branch', async () => {
      const onJumpToEntry = vi.fn()
      const onJumpToBranch = vi.fn()
      const user = userEvent.setup()
      renderPanel({
        comments: [fieldThread('e', { type: 'entry', canopyPath: undefined }), branchThread],
        onJumpToEntry,
        onJumpToBranch,
      })

      await user.click(screen.getByText('Comment in e'))
      expect(onJumpToEntry).toHaveBeenCalledWith('posts/hello', 'e')
      await user.click(screen.getByText('A branch-level comment'))
      expect(onJumpToBranch).toHaveBeenCalledWith('thread-branch-1')
    })

    it('does not jump from the reply and resolve controls or a text selection', async () => {
      const onJumpToField = vi.fn()
      const user = userEvent.setup()
      renderPanel({ comments: [fieldThread('a')], onJumpToField })

      await user.click(within(card('a')).getByTestId('reply-thread-button'))
      await user.click(screen.getByLabelText('Reply to this thread'))
      await user.type(screen.getByLabelText('Reply to this thread'), 'Draft')
      await user.click(within(card('a')).getByTestId('resolve-thread-button'))
      expect(onJumpToField).not.toHaveBeenCalled()

      const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => 'Comment',
      } as unknown as Selection)
      await user.click(screen.getByText('Comment in a'))
      selection.mockRestore()
      expect(onJumpToField).not.toHaveBeenCalled()
    })

    it('ignores a card click while a write is in flight', async () => {
      const onAddComment = vi.fn(() => new Promise<void>(() => {}))
      const onJumpToField = vi.fn()
      const user = userEvent.setup()
      renderPanel({ comments: [fieldThread('a')], onAddComment, onJumpToField })

      await user.click(within(card('a')).getByTestId('reply-thread-button'))
      await user.type(screen.getByLabelText('Reply to this thread'), 'Wait')
      await user.click(screen.getByTestId('submit-reply-button'))
      await user.click(screen.getByText('Comment in a'))
      expect(onJumpToField).not.toHaveBeenCalled()
    })

    it('leaves a card with no jump target alone', async () => {
      const onClose = vi.fn()
      const user = userEvent.setup()
      renderPanel({ comments: [fieldThread('a')], onClose })

      await user.click(screen.getByText('Comment in a'))
      expect(onClose).not.toHaveBeenCalled()
    })

    it('keeps the Jump button the only extra tab stop on a card', () => {
      renderPanel({ comments: [fieldThread('a')], onJumpToField: vi.fn() })

      expect(card('a').getAttribute('tabindex')).toBeNull()
      expect(card('a').getAttribute('role')).toBe(null)
      expect(within(card('a')).getByRole('button', { name: 'Jump to field' })).toBeTruthy()
    })
  })

  it('explains what Jump does in a dimmed line at the top, and keeps the title short', () => {
    renderPanel()

    const intro = screen.getByText('Jump shows each comment where it was left.')
    expect(intro.style.color).toBe('var(--mantine-color-dimmed)')
    const dialog = screen.getByRole('dialog', { name: 'Comments' })
    expect(dialog.querySelector('.mantine-Drawer-header')?.textContent).toBe('Comments')
    expect(dialog.querySelector('.mantine-Drawer-body')?.firstElementChild?.firstElementChild).toBe(
      intro,
    )
  })

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

  describe('in both colour schemes', () => {
    const resolved = defaultCssVariablesResolver(DEFAULT_THEME)
    const twoComments = (id: string, overrides: Partial<CommentThread> = {}) =>
      fieldThread(id, {
        comments: [
          ...fieldThread(id).comments,
          {
            id: `${id}-c2`,
            threadId: id,
            userId: 'bob',
            timestamp: recentTimestamp,
            text: `Reply in ${id}`,
          },
        ],
        ...overrides,
      })

    it('tints a resolved card and draws dividers with tokens that follow the scheme', async () => {
      renderPanel({ comments: [twoComments('a', { resolved: true }), twoComments('b')] })
      await userEvent.click(screen.getByLabelText('Show resolved'))

      expect(card('a').style.background).toBe('var(--mantine-color-default-hover)')
      expect(card('b').style.background).toBe('')
      for (const id of ['a', 'b']) {
        const divider = card(id).querySelector<HTMLElement>('div[style*="border-top"]')
        expect(divider?.style.borderTop).toBe('1px solid var(--mantine-color-default-border)')
      }

      // Each token names a different shade under each scheme, so neither is a fixed one.
      expect(resolved.light['--mantine-color-default-hover']).toBe('var(--mantine-color-gray-0)')
      expect(resolved.dark['--mantine-color-default-hover']).toBe('var(--mantine-color-dark-5)')
      expect(resolved.dark['--mantine-color-default-border']).toBe('var(--mantine-color-dark-4)')
    })
  })

  describe('as a list of threads', () => {
    it('labels each thread card as an article named by its heading', () => {
      renderPanel({
        comments: [fieldThread('t1'), fieldThread('t2', { canopyPath: 'meta.summary' })],
      })

      const articles = screen.getAllByRole('article')
      expect(articles).toHaveLength(2)
      for (const article of articles) {
        const heading = within(article).getByTestId('comment-thread-heading')
        expect(article.getAttribute('aria-labelledby')).toBe(heading.id)
        expect(heading.id).not.toBe('')
      }
      expect(
        screen.getByRole('article', { name: 'Field · posts/hello › meta.summary' }),
      ).toBeTruthy()
    })

    it('words the collapsed reply control "Reply…" and the submit "Reply"', async () => {
      renderPanel({ comments: [fieldThread('t1')] })

      const expander = within(card('t1')).getByTestId('reply-thread-button')
      expect(expander.textContent).toBe('Reply…')
      await userEvent.click(expander)
      expect(within(card('t1')).getByTestId('submit-reply-button').textContent).toBe('Reply')
    })
  })

  describe('closing and reopening', () => {
    it('keeps the composer text and a reply draft across a close', async () => {
      const { rerender } = renderPanel({ comments: [fieldThread('t1')] })
      await userEvent.type(screen.getByTestId('comment-textarea'), 'Half a comment')
      await userEvent.click(within(card('t1')).getByTestId('reply-thread-button'))
      await userEvent.type(within(card('t1')).getByRole('textbox'), 'Half a reply')

      rerender(<CommentsPanel {...panelProps({ comments: [fieldThread('t1')], opened: false })} />)
      await waitFor(() => expect(screen.queryByTestId('comment-textarea')).toBeNull())
      rerender(<CommentsPanel {...panelProps({ comments: [fieldThread('t1')], opened: true })} />)

      expect(((await screen.findByTestId('comment-textarea')) as HTMLTextAreaElement).value).toBe(
        'Half a comment',
      )
      // The reply box reopens by itself because it holds a draft.
      expect((within(card('t1')).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Half a reply',
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

    it('moves focus to the thread count once a resolved thread leaves the list', async () => {
      const onResolveThread = vi.fn().mockResolvedValue(undefined)
      renderPanel({ comments: [fieldThread('a'), fieldThread('b')], onResolveThread })

      await userEvent.click(within(card('a')).getByTestId('resolve-thread-button'))

      await waitFor(() => expect(document.activeElement?.textContent).toBe('2 threads'))
    })

    it('moves focus to the resolved thread heading when resolved threads stay in the list', async () => {
      const onResolveThread = vi.fn().mockResolvedValue(undefined)
      renderPanel({ comments: [fieldThread('a'), fieldThread('b')], onResolveThread })
      await userEvent.click(screen.getByLabelText('Show resolved'))

      await userEvent.click(within(card('a')).getByTestId('resolve-thread-button'))

      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(card('a')).getByTestId('comment-thread-heading'),
        ),
      )
    })

    it('reports a reply that fails after the panel is gone (another branch opened), as a toast', async () => {
      showNotification.mockClear()
      let fail: (err: Error) => void = () => {}
      const onAddComment = vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            fail = reject
          }),
      )
      const { unmount } = renderPanel({ comments: [fieldThread('a')], onAddComment })

      await userEvent.click(within(card('a')).getByTestId('reply-thread-button'))
      await userEvent.type(screen.getByLabelText('Reply to this thread'), 'Too late')
      await userEvent.click(screen.getByTestId('submit-reply-button'))
      unmount()
      await act(async () => {
        fail(new Error("Couldn't add the comment. Try again."))
      })

      expect(showNotification).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'red', message: "Couldn't add the comment. Try again." }),
      )
    })

    it('refuses to close, and disables its jumps, while a reply is in flight', async () => {
      let finish: () => void = () => {}
      const onAddComment = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      const onClose = vi.fn()
      renderPanel({
        comments: [fieldThread('a')],
        onAddComment,
        onClose,
        onJumpToField: vi.fn(),
      })

      await userEvent.click(within(card('a')).getByTestId('reply-thread-button'))
      await userEvent.type(screen.getByLabelText('Reply to this thread'), 'Wait for me')
      await userEvent.click(screen.getByTestId('submit-reply-button'))
      expect(screen.queryByText(CLOSE_WAITS_FOR_WRITE)).toBeNull()
      await userEvent.keyboard('{Escape}')

      expect(onClose).not.toHaveBeenCalled()
      // A refused close says why.
      expect(screen.getByRole('status').textContent).toBe(CLOSE_WAITS_FOR_WRITE)
      expect(
        within(card('a'))
          .getByRole('button', { name: 'Jump to field' })
          .getAttribute('aria-disabled'),
      ).toBe('true')

      await act(async () => {
        finish()
      })
      expect(screen.getByRole('status').textContent).toBe('')
      await userEvent.keyboard('{Escape}')
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('says why the X does nothing while a write is in flight', async () => {
      let finish: () => void = () => {}
      const onAddComment = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      const onClose = vi.fn()
      renderPanel({ comments: [fieldThread('a')], onAddComment, onClose })

      await userEvent.click(within(card('a')).getByTestId('reply-thread-button'))
      await userEvent.type(screen.getByLabelText('Reply to this thread'), 'Wait for me')
      await userEvent.click(screen.getByTestId('submit-reply-button'))
      const closeButton = document.querySelector<HTMLElement>('.mantine-Drawer-close')
      expect(closeButton).not.toBeNull()
      await userEvent.click(closeButton!)

      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole('status').textContent).toBe(CLOSE_WAITS_FOR_WRITE)
      expect(screen.getByText(CLOSE_WAITS_FOR_WRITE, { selector: 'p' })).toBeTruthy()

      await act(async () => {
        finish()
      })
      await userEvent.click(document.querySelector<HTMLElement>('.mantine-Drawer-close')!)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('keeps a blocked jump focusable, says why on focus and ignores its click', async () => {
      let finish: () => void = () => {}
      const onAddComment = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      const onJumpToField = vi.fn()
      renderPanel({ comments: [fieldThread('a')], onAddComment, onJumpToField })

      await userEvent.click(within(card('a')).getByTestId('reply-thread-button'))
      await userEvent.type(screen.getByLabelText('Reply to this thread'), 'Wait for me')
      await userEvent.click(screen.getByTestId('submit-reply-button'))

      const jump = within(card('a')).getByRole('button', { name: 'Jump to field' })
      expect((jump as HTMLButtonElement).disabled).toBe(false)
      expect(screen.queryByText(/still saving/)).toBeNull()
      act(() => jump.focus())
      expect(
        await screen.findByText('Your change is still saving. Try again once it finishes.'),
      ).toBeTruthy()
      expect(document.activeElement).toBe(jump)

      await userEvent.click(jump)
      expect(onJumpToField).not.toHaveBeenCalled()

      await act(async () => {
        finish()
      })
      await waitFor(() => expect(jump.getAttribute('aria-disabled')).toBeNull())
      await userEvent.click(jump)
      expect(onJumpToField).toHaveBeenCalledTimes(1)
    })

    it('leaves focus where the user put it while a resolve was in flight', async () => {
      let finish: () => void = () => {}
      const onResolveThread = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      renderPanel({ comments: [fieldThread('a'), fieldThread('b')], onResolveThread })

      await userEvent.click(within(card('a')).getByTestId('resolve-thread-button'))
      const composer = screen.getByTestId('comment-textarea')
      await userEvent.click(composer)
      await act(async () => {
        finish()
      })

      await waitFor(() => expect(onResolveThread).toHaveBeenCalled())
      expect(document.activeElement).toBe(composer)
    })

    it('moves focus to the thread count when the resolved card actually leaves the list', async () => {
      const Harness = () => {
        const [comments, setComments] = useState([fieldThread('a'), fieldThread('b')])
        return (
          <CommentsPanel
            {...panelProps({
              comments,
              onResolveThread: async (id) =>
                setComments((all) => all.map((t) => (t.id === id ? { ...t, resolved: true } : t))),
            })}
          />
        )
      }
      render(<Harness />, { wrapper: Wrapper })

      await userEvent.click(within(card('a')).getByTestId('resolve-thread-button'))

      await waitFor(() => expect(screen.queryByText('Comment in a')).toBeNull())
      await waitFor(() => expect(document.activeElement?.textContent).toBe('1 thread'))
    })

    it('leaves focus the user moved while Reply and resolve posted its reply', async () => {
      let finishReply: () => void = () => {}
      const onAddComment = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishReply = resolve
          }),
      )
      const onResolveThread = vi.fn().mockResolvedValue(undefined)
      renderPanel({ comments: [fieldThread('a'), fieldThread('b')], onAddComment, onResolveThread })

      await userEvent.click(within(card('a')).getByTestId('reply-thread-button'))
      await userEvent.type(screen.getByLabelText('Reply to this thread'), 'Last word')
      await userEvent.click(within(card('a')).getByTestId('resolve-thread-button'))
      const composer = screen.getByTestId('comment-textarea')
      await userEvent.click(composer)
      await act(async () => {
        finishReply()
      })

      await waitFor(() => expect(onResolveThread).toHaveBeenCalled())
      expect(document.activeElement).toBe(composer)
    })

    it('reports a new comment that fails after the panel is gone, as a toast', async () => {
      showNotification.mockClear()
      let fail: (err: Error) => void = () => {}
      const onAddComment = vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            fail = reject
          }),
      )
      const { unmount } = renderPanel({ onAddComment })

      await userEvent.type(screen.getByTestId('comment-textarea'), 'Lost?')
      await userEvent.click(screen.getByTestId('comment-submit'))
      unmount()
      await act(async () => {
        fail(new Error("Couldn't add the comment. Try again."))
      })

      expect(showNotification).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'red', message: "Couldn't add the comment. Try again." }),
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
        fieldLabel: (thread) =>
          thread.canopyPath === 'blocks[0].title' ? 'Page sections › Hero › Heading' : undefined,
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
