import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BranchManager } from './BranchManager'
import type { BranchSummary } from './BranchManager'
import { CanopyCMSProvider } from './theme'

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

const renderBranchManager = (props: React.ComponentProps<typeof BranchManager>) => {
  return render(
    <CanopyCMSProvider>
      <BranchManager {...props} />
    </CanopyCMSProvider>,
  )
}

describe('BranchManager', () => {
  const baseBranches: BranchSummary[] = [
    {
      name: 'main',
      status: 'editing',
      updatedAt: '2024-01-01',
      access: { users: ['user1'] },
    },
    {
      name: 'feature/test',
      status: 'submitted',
      updatedAt: '2024-01-02',
      access: { users: ['user1'] },
      pullRequestUrl: 'https://github.com/owner/repo/pull/1',
      pullRequestNumber: 1,
      commentCount: 3,
    },
  ]

  it('renders branch list', () => {
    renderBranchManager({ branches: baseBranches })
    expect(screen.getByText('main')).toBeDefined()
    expect(screen.getByText('feature/test')).toBeDefined()
  })

  it('shows PR status and link when present', () => {
    renderBranchManager({ branches: baseBranches })
    const prBadge = screen.getByText(/PR #1/)
    expect(prBadge).toBeDefined()

    const prLink = screen.getByText('View PR')
    expect(prLink).toBeDefined()
    expect(prLink.getAttribute('href')).toBe('https://github.com/owner/repo/pull/1')
  })

  it('shows comment count badge when present', () => {
    renderBranchManager({ branches: baseBranches })
    expect(screen.getByText(/3 comments/)).toBeDefined()
  })

  it('calls onSubmit when Submit button clicked', async () => {
    const onSubmit = vi.fn()
    renderBranchManager({ branches: baseBranches, onSubmit })

    const submitButton = screen.getByRole('button', { name: /submit/i })
    await userEvent.click(submitButton)

    expect(onSubmit).toHaveBeenCalledWith('main')
  })

  it('calls onWithdraw when Withdraw button clicked', async () => {
    const onWithdraw = vi.fn()
    renderBranchManager({ branches: baseBranches, onWithdraw })

    const withdrawButton = screen.getByRole('button', { name: /withdraw/i })
    await userEvent.click(withdrawButton)

    expect(onWithdraw).toHaveBeenCalledWith('feature/test')
  })

  it('shows create branch form when Create button clicked', async () => {
    renderBranchManager({ branches: baseBranches })

    const createButton = screen.getByRole('button', { name: /create new branch/i })
    await userEvent.click(createButton)

    await waitFor(() => {
      expect(screen.getByLabelText(/branch name/i)).toBeDefined()
    })
  })

  it('calls onCreate with branch details when form submitted', async () => {
    const onCreate = vi.fn()
    renderBranchManager({ branches: baseBranches, onCreate })

    // Open form
    const createButton = screen.getByRole('button', { name: /create new branch/i })
    await userEvent.click(createButton)

    // Fill form
    const nameInput = await screen.findByLabelText(/branch name/i)
    const titleInput = await screen.findByLabelText(/title/i)
    const descriptionInput = await screen.findByLabelText(/description/i)

    await userEvent.type(nameInput, 'feature/new-feature')
    await userEvent.type(titleInput, 'New Feature')
    await userEvent.type(descriptionInput, 'A great new feature')

    // Submit form
    const submitButton = screen.getByRole('button', { name: /^create branch$/i })
    await userEvent.click(submitButton)

    expect(onCreate).toHaveBeenCalledWith({
      name: 'feature/new-feature',
      title: 'New Feature',
      description: 'A great new feature',
    })
  })

  it('disables create button when name is empty', async () => {
    renderBranchManager({ branches: baseBranches, onCreate: vi.fn() })

    // Open form
    const createButton = screen.getByRole('button', { name: /create new branch/i })
    await userEvent.click(createButton)

    // Submit button should be disabled with no name
    const submitButton = await screen.findByRole('button', { name: /^create branch$/i })
    expect(submitButton.hasAttribute('disabled')).toBe(true)

    // Type name
    const nameInput = await screen.findByLabelText(/branch name/i)
    await userEvent.type(nameInput, 'test')

    // Submit button should be enabled
    await waitFor(() => {
      expect(submitButton.hasAttribute('disabled')).toBe(false)
    })
  })

  it('hides create form in local-simple mode', () => {
    renderBranchManager({ branches: baseBranches, mode: 'local-simple' })

    const createButton = screen.queryByRole('button', { name: /create new branch/i })
    expect(createButton).toBeNull()
  })

  it('calls onRequestChanges when button clicked', async () => {
    const onRequestChanges = vi.fn()
    renderBranchManager({ branches: baseBranches, onRequestChanges })

    const requestChangesButtons = screen.getAllByRole('button', { name: /request changes/i })
    // The second branch (feature/test) is submitted, so its button should be at index 1
    await userEvent.click(requestChangesButtons[1])

    expect(onRequestChanges).toHaveBeenCalledWith('feature/test')
  })

  it('calls onDelete when delete button clicked', async () => {
    const onDelete = vi.fn()
    renderBranchManager({ branches: baseBranches, onDelete })

    const deleteButtons = screen.getAllByRole('button', { name: /delete/i })
    await userEvent.click(deleteButtons[0])

    expect(onDelete).toHaveBeenCalledWith('main')
  })
})
