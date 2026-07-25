import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
        onAddComment={vi.fn()}
        onResolveThread={vi.fn()}
        onClose={vi.fn()}
        onJumpToBranch={vi.fn()}
        {...overrides}
      />,
      { wrapper: Wrapper },
    )

  it('shows a composer hint describing branch-level scope when not replying', () => {
    renderPanel()

    expect(screen.getByText(/Posts a branch-level comment on "feature\/my-branch"/)).toBeTruthy()
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
})
