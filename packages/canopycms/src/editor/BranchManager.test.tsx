import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BranchManager, getBranchPermissions } from './BranchManager'
import type { BranchSummary } from './BranchManager'
import { CanopyCMSProvider } from './theme'
import { RESERVED_GROUPS } from '../authorization'

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

describe('getBranchPermissions', () => {
  it('returns all false when no user provided', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'editing',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, undefined)
    expect(perms.canSubmit).toBe(false)
    expect(perms.canWithdraw).toBe(false)
    expect(perms.canDelete).toBe(false)
    expect(perms.canRequestChanges).toBe(false)
  })

  it('allows creator to submit editing branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'editing',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canSubmit).toBe(true)
  })

  it('allows creator to withdraw submitted branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canWithdraw).toBe(true)
  })

  it('allows admin to delete any branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'editing',
      createdBy: 'other',
    }
    const perms = getBranchPermissions(branch, {
      userId: 'admin',
      groups: [RESERVED_GROUPS.ADMINS],
    })
    expect(perms.canDelete).toBe(true)
  })

  it('blocks delete for submitted branches', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canDelete).toBe(false)
  })

  it('allows reviewer to request changes on submitted branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'other',
    }
    const perms = getBranchPermissions(branch, {
      userId: 'reviewer',
      groups: [RESERVED_GROUPS.REVIEWERS],
    })
    expect(perms.canRequestChanges).toBe(true)
  })
})

describe('BranchManager', () => {
  // Admin user can do everything
  const adminUser = { userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] }
  // Creator user for testing branch operations
  const creatorUser = { userId: 'user1', groups: [] }

  const baseBranches: BranchSummary[] = [
    {
      name: 'main',
      status: 'editing',
      createdBy: 'user1',
      updatedAt: '2024-01-01',
      access: { users: ['user1'] },
    },
    {
      name: 'feature/test',
      status: 'submitted',
      createdBy: 'user1',
      updatedAt: '2024-01-02',
      access: { users: ['user1'] },
      pullRequestUrl: 'https://github.com/owner/repo/pull/1',
      pullRequestNumber: 1,
      commentCount: 3,
    },
  ]

  it('renders branch list', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    expect(screen.getByText('main')).toBeDefined()
    expect(screen.getByText('feature/test')).toBeDefined()
  })

  it('shows PR status and link when present', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    const prBadge = screen.getByText(/PR #1/)
    expect(prBadge).toBeDefined()

    const prLink = screen.getByText('View PR')
    expect(prLink).toBeDefined()
    expect(prLink.getAttribute('href')).toBe('https://github.com/owner/repo/pull/1')
  })

  it('shows comment count badge when present', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    expect(screen.getByText(/3 comments/)).toBeDefined()
  })

  it('calls onSubmit when Submit button clicked', async () => {
    const onSubmit = vi.fn()
    // Use creator user so they can submit their own branch
    renderBranchManager({
      branches: baseBranches,
      onSubmit,
      user: creatorUser,
      mode: 'prod',
    })

    const submitButton = screen.getByRole('button', { name: /submit/i })
    await userEvent.click(submitButton)

    expect(onSubmit).toHaveBeenCalledWith('main')
  })

  it('calls onWithdraw when Withdraw button clicked', async () => {
    const onWithdraw = vi.fn()
    // Use creator user so they can withdraw their own branch
    renderBranchManager({
      branches: baseBranches,
      onWithdraw,
      user: creatorUser,
      mode: 'prod',
    })

    const withdrawButton = screen.getByRole('button', { name: /withdraw/i })
    await userEvent.click(withdrawButton)

    expect(onWithdraw).toHaveBeenCalledWith('feature/test')
  })

  it('shows create branch form when Create button clicked', async () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })

    const createButton = screen.getByRole('button', {
      name: /create new branch/i,
    })
    await userEvent.click(createButton)

    await waitFor(() => {
      expect(screen.getByLabelText(/branch name/i)).toBeDefined()
    })
  })

  it('calls onCreate with branch details when form submitted', async () => {
    const onCreate = vi.fn()
    renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })

    // Open form
    const createButton = screen.getByRole('button', {
      name: /create new branch/i,
    })
    await userEvent.click(createButton)

    // Fill form
    const nameInput = await screen.findByLabelText(/branch name/i)
    const titleInput = await screen.findByLabelText(/title/i)
    const descriptionInput = await screen.findByLabelText(/description/i)

    await userEvent.type(nameInput, 'feature/new-feature')
    await userEvent.type(titleInput, 'New Feature')
    await userEvent.type(descriptionInput, 'A great new feature')

    // Submit form
    const submitButton = screen.getByRole('button', {
      name: /^create branch$/i,
    })
    await userEvent.click(submitButton)

    expect(onCreate).toHaveBeenCalledWith({
      name: 'feature/new-feature',
      title: 'New Feature',
      description: 'A great new feature',
    })
  })

  it('disables create button when name is empty', async () => {
    renderBranchManager({
      branches: baseBranches,
      onCreate: vi.fn(),
      mode: 'prod',
    })

    // Open form
    const createButton = screen.getByRole('button', {
      name: /create new branch/i,
    })
    await userEvent.click(createButton)

    // Submit button should be disabled with no name
    const submitButton = await screen.findByRole('button', {
      name: /^create branch$/i,
    })
    expect(submitButton.hasAttribute('disabled')).toBe(true)

    // Type name
    const nameInput = await screen.findByLabelText(/branch name/i)
    await userEvent.type(nameInput, 'test')

    // Submit button should be enabled
    await waitFor(() => {
      expect(submitButton.hasAttribute('disabled')).toBe(false)
    })
  })

  it('hides create form in dev mode', () => {
    renderBranchManager({ branches: baseBranches, mode: 'dev' })

    const createButton = screen.queryByRole('button', {
      name: /create new branch/i,
    })
    expect(createButton).toBeNull()
  })

  it('calls onRequestChanges when button clicked', async () => {
    const onRequestChanges = vi.fn()
    // Use admin user who can request changes on submitted branches
    renderBranchManager({
      branches: baseBranches,
      onRequestChanges,
      user: adminUser,
      mode: 'prod',
    })

    const requestChangesButtons = screen.getAllByRole('button', {
      name: /request changes/i,
    })
    // The second branch (feature/test) is submitted, so its button should be at index 1
    await userEvent.click(requestChangesButtons[1])

    expect(onRequestChanges).toHaveBeenCalledWith('feature/test')
  })

  it('calls onDelete when delete button clicked', async () => {
    const onDelete = vi.fn()
    // Use creator user so they can delete their own branch (main is editing, not submitted)
    renderBranchManager({
      branches: baseBranches,
      onDelete,
      user: creatorUser,
      mode: 'prod',
    })

    const deleteButtons = screen.getAllByRole('button', { name: /delete/i })
    await userEvent.click(deleteButtons[0])

    expect(onDelete).toHaveBeenCalledWith('main')
  })
})
