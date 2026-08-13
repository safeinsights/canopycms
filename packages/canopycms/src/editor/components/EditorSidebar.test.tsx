import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { EditorSidebar, type EditorSidebarProps } from './EditorSidebar'

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

const defaultProps: EditorSidebarProps = {
  layout: 'side',
  highlightEnabled: false,
  sidebarWidth: 60,
  headerHeight: 60,
  footerHeight: 40,
  onLayoutChange: vi.fn(),
  onHighlightToggle: vi.fn(),
  onPermissionManagerOpen: vi.fn(),
  onGroupManagerOpen: vi.fn(),
  onMediaLibraryOpen: vi.fn(),
}

/**
 * Editor.tsx has no existing precedent for testing admin-gated UI (the
 * Manage Permissions/Manage Groups menu items it already renders are NOT
 * gated by isAdmin() at all), so there's no established integration harness
 * to mirror for the System Health menu item either. Testing the prop
 * contract directly here is the fallback the PR-U1 spec calls for.
 */
describe('EditorSidebar - System health menu item', () => {
  afterEach(() => {
    cleanup()
  })

  it('does not render "System health" when onSystemHealthOpen is not provided', async () => {
    render(<EditorSidebar {...defaultProps} />, { wrapper: Wrapper })

    await userEvent.click(screen.getByLabelText('Settings'))

    // Wait for the (unrelated) always-present item so we know the dropdown
    // actually opened before asserting System health's absence.
    await screen.findByText('Manage Groups')
    expect(screen.queryByText('System health')).toBeNull()
  })

  it('renders and invokes onSystemHealthOpen when provided', async () => {
    const onSystemHealthOpen = vi.fn()
    render(<EditorSidebar {...defaultProps} onSystemHealthOpen={onSystemHealthOpen} />, {
      wrapper: Wrapper,
    })

    await userEvent.click(screen.getByLabelText('Settings'))
    const item = await screen.findByText('System health')
    expect(item).toBeTruthy()

    await userEvent.click(item)
    expect(onSystemHealthOpen).toHaveBeenCalledTimes(1)
  })
})
