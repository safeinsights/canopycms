import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BranchManager } from './BranchManager'
import type { BranchSummary, UserContext } from './BranchManager'
import { CanopyCMSProvider } from './theme'
import { RESERVED_GROUPS } from '../authorization'

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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const NAME = 'feature/x'
const CLOSED_REASON = /The pull request was closed on GitHub\./

const branch = (overrides: Partial<BranchSummary> = {}): BranchSummary => ({
  name: NAME,
  status: 'submitted',
  createdBy: 'maker',
  access: { users: ['maker'] },
  submitBlocked: true,
  pullRequestNumber: 7,
  pullRequestUrl: 'https://example.test/pull/7',
  ...overrides,
})

const reviewer: UserContext = { userId: 'rita', groups: [RESERVED_GROUPS.REVIEWERS] }
const admin: UserContext = { userId: 'adam', groups: [RESERVED_GROUPS.ADMINS] }
const creatorAdmin: UserContext = { userId: 'maker', groups: [RESERVED_GROUPS.ADMINS] }
const plain: UserContext = { userId: 'pat', groups: [] }

const renderCard = (
  b: BranchSummary,
  user: UserContext,
  open: boolean,
  handlers: Partial<React.ComponentProps<typeof BranchManager>> = {},
) =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <CanopyCMSProvider>
        <BranchManager
          branches={[b]}
          mode="prod"
          user={user}
          currentBranchName={open ? b.name : undefined}
          {...handlers}
        />
      </CanopyCMSProvider>
    </SWRConfig>,
  )

const ACTION_IDS = [
  'approve',
  'request-changes',
  'review',
  'withdraw',
  'submit',
  'switch-to',
] as const

/** The action buttons on the card itself, by kind, in document order. */
const visibleActions = () =>
  Array.from(
    screen.getByTestId(`branch-list-item-${NAME}`).querySelectorAll<HTMLElement>('[data-testid]'),
  )
    .filter((el) => !el.closest('[role="menu"]'))
    .map((el) => el.getAttribute('data-testid') ?? '')
    .flatMap((id) => ACTION_IDS.filter((a) => id === `${a}-branch-button-${NAME}`))

/** The actions in the "…" menu, opened. */
const menuActions = async () => {
  await userEvent.click(screen.getByTestId(`branch-actions-menu-${NAME}`))
  const menu = await screen.findByRole('menu')
  return Array.from(menu.querySelectorAll<HTMLElement>('[data-testid]'))
    .map((el) => el.getAttribute('data-testid') ?? '')
    .flatMap((id) => ACTION_IDS.filter((a) => id === `${a}-branch-button-${NAME}`))
}

interface Row {
  who: string
  user: UserContext
  branch: BranchSummary
  open: boolean
  visible: string[]
  menu: string[]
}

const rows: Row[] = [
  // A reviewer of someone else's submission.
  {
    who: 'reviewer, open, submitted',
    user: reviewer,
    branch: branch(),
    open: true,
    visible: ['request-changes', 'approve'],
    menu: ['withdraw'],
  },
  {
    who: 'admin, open, submitted',
    user: admin,
    branch: branch(),
    open: true,
    visible: ['request-changes', 'approve'],
    menu: ['withdraw'],
  },
  {
    who: 'reviewer, open, approved',
    user: reviewer,
    branch: branch({ status: 'approved' }),
    open: true,
    visible: ['request-changes'],
    menu: ['withdraw'],
  },
  {
    who: 'reviewer, not open, submitted',
    user: reviewer,
    branch: branch(),
    open: false,
    visible: ['review'],
    menu: ['approve', 'request-changes', 'withdraw'],
  },
  {
    who: 'reviewer, not open, approved',
    user: reviewer,
    branch: branch({ status: 'approved' }),
    open: false,
    visible: ['review'],
    menu: ['request-changes', 'withdraw'],
  },
  // The creator, even as an admin, is not a reviewer of their own work.
  {
    who: 'creator admin, open, submitted',
    user: creatorAdmin,
    branch: branch(),
    open: true,
    visible: ['withdraw'],
    menu: [],
  },
  {
    who: 'creator admin, not open, submitted',
    user: creatorAdmin,
    branch: branch(),
    open: false,
    visible: ['switch-to'],
    menu: ['withdraw'],
  },
  {
    who: 'creator admin, open, approved',
    user: creatorAdmin,
    branch: branch({ status: 'approved' }),
    open: true,
    visible: ['withdraw'],
    menu: [],
  },
  // A reviewer given access to the branch: their primary is unchanged.
  {
    who: 'reviewer on the access list, open, submitted',
    user: reviewer,
    branch: branch({ access: { users: ['maker', 'rita'] } }),
    open: true,
    visible: ['withdraw'],
    menu: ['approve', 'request-changes'],
  },
  {
    who: 'reviewer in an access-list group, not open, submitted',
    user: reviewer,
    branch: branch({ access: { users: ['maker'], groups: [RESERVED_GROUPS.REVIEWERS] } }),
    open: false,
    visible: ['switch-to'],
    menu: ['approve', 'request-changes', 'withdraw'],
  },
  // The protected base branch is left to Withdraw, whoever reviews.
  {
    who: 'reviewer, protected base open, submitted',
    user: reviewer,
    branch: branch({ isProtected: true }),
    open: true,
    visible: ['withdraw'],
    menu: [],
  },
  {
    who: 'reviewer, protected base not open, submitted',
    user: reviewer,
    branch: branch({ isProtected: true }),
    open: false,
    visible: ['switch-to'],
    menu: ['withdraw'],
  },
  // Someone who does not review.
  {
    who: 'editor with access, open, submitted',
    user: { userId: 'maker', groups: [] },
    branch: branch(),
    open: true,
    visible: ['withdraw'],
    menu: [],
  },
  {
    who: 'stranger, not open, submitted',
    user: plain,
    branch: branch(),
    open: false,
    visible: ['switch-to'],
    menu: [],
  },
]

describe('BranchCard review actions', () => {
  it.each(rows)('$who', async ({ user, branch: b, open, visible, menu }) => {
    renderCard(b, user, open)

    expect(visibleActions()).toEqual(visible)
    // A stranger's card has no menu entry of the actions at all, but it keeps its PR link.
    expect(await menuActions()).toEqual(menu)
  })

  it('offers a reviewer neither Approve nor Request changes on a branch still being edited', async () => {
    renderCard(branch({ status: 'editing', submitBlocked: false }), reviewer, true)

    expect(visibleActions()).toEqual(['submit'])
    expect(await menuActions()).toEqual([])
  })

  describe('handlers', () => {
    it('calls onApprove from Approve, on the open branch', async () => {
      const onApprove = vi.fn()
      renderCard(branch(), reviewer, true, { onApprove })
      await userEvent.click(screen.getByTestId(`approve-branch-button-${NAME}`))
      expect(onApprove).toHaveBeenCalledWith(NAME)
    })

    it('calls onRequestChanges from the visible Request changes', async () => {
      const onRequestChanges = vi.fn()
      renderCard(branch(), reviewer, true, { onRequestChanges })
      await userEvent.click(screen.getByTestId(`request-changes-branch-button-${NAME}`))
      expect(onRequestChanges).toHaveBeenCalledWith(NAME)
    })

    it('opens the branch from Review, as Open does', async () => {
      const onSelect = vi.fn()
      renderCard(branch(), reviewer, false, { onSelect })
      const review = screen.getByTestId(`review-branch-button-${NAME}`)
      expect(review.textContent).toBe('Review')
      await userEvent.click(review)
      expect(onSelect).toHaveBeenCalledWith(NAME)
    })

    it('calls onApprove from the menu of a branch that is not open', async () => {
      const onApprove = vi.fn()
      renderCard(branch(), reviewer, false, { onApprove })
      await userEvent.click(screen.getByTestId(`branch-actions-menu-${NAME}`))
      await userEvent.click(await screen.findByTestId(`approve-branch-button-${NAME}`))
      expect(onApprove).toHaveBeenCalledWith(NAME)
    })
  })

  describe('a closed pull request', () => {
    const closed = branch({ pullRequestState: 'closed' })

    it('leads with Withdraw on the open branch, and shows no review buttons', () => {
      renderCard(closed, reviewer, true)
      expect(visibleActions()).toEqual(['withdraw'])
    })

    it('blocks Approve and Request changes in the menu, keeping them focusable, with the reason once', async () => {
      renderCard(closed, reviewer, false)
      await userEvent.click(screen.getByTestId(`branch-actions-menu-${NAME}`))
      const menu = await screen.findByRole('menu')
      for (const id of ['approve', 'request-changes']) {
        const item = within(menu).getByTestId(`${id}-branch-button-${NAME}`)
        expect(item.getAttribute('aria-disabled')).toBe('true')
        expect(item.hasAttribute('disabled')).toBe(false)
      }
      expect(within(menu).getAllByText(CLOSED_REASON)).toHaveLength(1)
      expect(
        within(within(menu).getByTestId(`approve-branch-button-${NAME}`)).getByText(CLOSED_REASON),
      ).toBeTruthy()
    })

    it('shows the reason on Request changes alone once approved, as nothing sits above it', async () => {
      renderCard(branch({ status: 'approved', pullRequestState: 'closed' }), reviewer, false)
      await userEvent.click(screen.getByTestId(`branch-actions-menu-${NAME}`))
      const menu = await screen.findByRole('menu')
      expect(within(menu).queryByTestId(`approve-branch-button-${NAME}`)).toBeNull()
      expect(within(menu).getAllByText(CLOSED_REASON)).toHaveLength(1)
    })

    it('leaves Withdraw working, as the way out', async () => {
      renderCard(closed, reviewer, false)
      await userEvent.click(screen.getByTestId(`branch-actions-menu-${NAME}`))
      const withdraw = await screen.findByTestId(`withdraw-branch-button-${NAME}`)
      expect(withdraw.getAttribute('aria-disabled')).toBeNull()
    })
  })

  describe('layout', () => {
    it('puts two visible actions on their own row beneath the title, right-aligned', () => {
      renderCard(branch(), reviewer, true)
      const row = screen.getByTestId(`branch-action-row-${NAME}`)
      const card = screen.getByTestId(`branch-list-item-${NAME}`)
      expect(within(row).getByTestId(`approve-branch-button-${NAME}`)).toBeTruthy()
      expect(within(row).getByTestId(`request-changes-branch-button-${NAME}`)).toBeTruthy()
      // The "…" menu and the title stay above it, not in the row.
      expect(within(row).queryByTestId(`branch-actions-menu-${NAME}`)).toBeNull()
      expect(row.parentElement).toBe(card)
      expect(row.style.getPropertyValue('--group-justify')).toBe('flex-end')
      const title = within(card).getByText(NAME)
      expect(title.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it.each([
      [
        'a single action on the open branch',
        branch({ access: { users: ['maker', 'rita'] } }),
        true,
      ],
      ['Review on another branch', branch(), false],
      ['request changes alone once approved', branch({ status: 'approved' }), true],
    ])('keeps %s beside the title, with no action row', (_n, b, open) => {
      renderCard(b, reviewer, open)
      expect(screen.queryByTestId(`branch-action-row-${NAME}`)).toBeNull()
    })
  })

  describe('while the open branch is held back', () => {
    it('blocks Approve and Request changes with the reason it gives its workflow action', async () => {
      const onApprove = vi.fn()
      renderCard(branch(), reviewer, true, {
        onApprove,
        currentWorkflowBlockedReason: 'Wait for Save all to finish.',
      })
      for (const id of ['approve', 'request-changes']) {
        const button = screen.getByTestId(`${id}-branch-button-${NAME}`)
        expect(button.getAttribute('aria-disabled')).toBe('true')
      }
      await userEvent.click(screen.getByTestId(`approve-branch-button-${NAME}`))
      expect(onApprove).not.toHaveBeenCalled()
      await userEvent.hover(screen.getByTestId(`approve-branch-button-${NAME}`))
      expect(await screen.findByText('Wait for Save all to finish.')).toBeTruthy()
    })

    it('does not hold back the review actions of another branch', async () => {
      renderCard(branch(), reviewer, false, {
        currentWorkflowBlockedReason: 'Wait for Save all to finish.',
      })
      await userEvent.click(screen.getByTestId(`branch-actions-menu-${NAME}`))
      const item = await screen.findByTestId(`approve-branch-button-${NAME}`)
      expect(item.getAttribute('aria-disabled')).toBeNull()
    })
  })
})
