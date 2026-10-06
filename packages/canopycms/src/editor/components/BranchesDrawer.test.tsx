import React, { useState } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BranchesDrawer } from './BranchesDrawer'
import { CanopyCMSProvider } from '../theme'
import { useBranchActions } from '../hooks/useBranchActions'
import { createApiClientWrapper } from '../hooks/__test__/test-utils'
import { createMockApiClient } from '../../api/__test__/mock-client'

// The real Drawer and the real ModalsProvider (nothing about @mantine/modals is mocked):
// stacking and keyboard behavior only exist in the composition.

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
  if (originalMatchMedia) window.matchMedia = originalMatchMedia
})

afterEach(() => {
  cleanup()
})

const Harness: React.FC<{ onDecision: (ok: boolean) => void }> = ({ onDecision }) => {
  const [open, setOpen] = useState(true)
  const { confirmCreate, confirmOpen } = useBranchActions({
    branchName: 'main',
    setBranchName: () => {},
    getUnsaved: async () => ({ count: 1, labels: ['About'] }),
    onReloadBranches: async () => {},
    onBranchCreated: () => {},
  })
  return (
    <>
      {/* The drawer's own `opened` state: the DOM lingers through the close transition. */}
      <output data-testid="drawer-opened">{String(open)}</output>
      <BranchesDrawer opened={open} onClose={() => setOpen(false)} confirmOpen={confirmOpen}>
        <p>Drawer body</p>
        <button type="button" onClick={() => void confirmCreate().then(onDecision)}>
          Create
        </button>
      </BranchesDrawer>
    </>
  )
}

const drawerOpened = (): string | null => screen.getByTestId('drawer-opened').textContent

const renderHarness = (onDecision: (ok: boolean) => void) => {
  const Wrapper = createApiClientWrapper(createMockApiClient())
  return render(
    <Wrapper>
      <CanopyCMSProvider withNotifications={false}>
        <Harness onDecision={onDecision} />
      </CanopyCMSProvider>
    </Wrapper>,
  )
}

/** The dialog whose text includes `text`. */
const dialogWith = (text: string): HTMLElement => {
  const dialog = screen
    .getAllByRole('dialog', { hidden: true })
    .find((el) => el.textContent?.includes(text))
  if (!dialog) throw new Error(`no dialog contains "${text}"`)
  return dialog
}

describe('BranchesDrawer with a confirm opened from inside it', () => {
  it('gives Escape and focus to the confirm, leaving the drawer open', async () => {
    const onDecision = vi.fn()
    renderHarness(onDecision)

    await userEvent.click(await screen.findByRole('button', { name: 'Create' }))
    await screen.findByText(/Unsaved changes in: About/)

    expect(dialogWith('Unsaved changes in').contains(document.activeElement)).toBe(true)

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(onDecision).toHaveBeenCalledWith(false))
    await waitFor(() => expect(screen.queryByText(/Unsaved changes in: About/)).toBeNull())
    // Past the transitions, so a drawer that is closing has been removed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(drawerOpened()).toBe('true')
    expect(screen.queryByText('Drawer body')).not.toBeNull()
  })

  it('does not close the drawer when the confirm is dismissed with Cancel', async () => {
    const onDecision = vi.fn()
    renderHarness(onDecision)

    await userEvent.click(await screen.findByRole('button', { name: 'Create' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(onDecision).toHaveBeenCalledWith(false))
    expect(drawerOpened()).toBe('true')
  })

  it('closes on Escape again once the confirm is gone', async () => {
    renderHarness(vi.fn())

    await userEvent.click(await screen.findByRole('button', { name: 'Create' }))
    await screen.findByText(/Unsaved changes in: About/)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText(/Unsaved changes in: About/)).toBeNull())

    // The confirm's settle reaches the drawer a tick later; wait for it to hand Escape back.
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(drawerOpened()).toBe('false'))
  })

  it('still closes on Escape when no confirm is open', async () => {
    renderHarness(vi.fn())
    await screen.findByText('Drawer body')

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(drawerOpened()).toBe('false'))
  })
})
