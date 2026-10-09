import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
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

describe('EditorSidebar - highlight toggle', () => {
  afterEach(() => {
    cleanup()
  })

  it('draws its icon as a dashed outline, like the outline it turns on in the preview', () => {
    render(<EditorSidebar {...defaultProps} />, { wrapper: Wrapper })

    const strokes = [...screen.getByLabelText('Toggle highlights').querySelectorAll('svg path')]
      .map((path) => path.getAttribute('d') ?? '')
      .join(' ')
      .match(/[Mm]/g)
    expect(strokes?.length ?? 0).toBeGreaterThanOrEqual(8)
  })

  it('says so beside the toggle when highlights are on and the preview marks nothing', async () => {
    const { rerender } = render(<EditorSidebar {...defaultProps} highlightEnabled />, {
      wrapper: Wrapper,
    })
    expect(screen.queryByText(/marks no editable elements/)).toBeNull()

    rerender(<EditorSidebar {...defaultProps} highlightEnabled previewMarksNothing />)
    expect(await screen.findByText(/marks no editable elements/)).toBeTruthy()

    rerender(<EditorSidebar {...defaultProps} previewMarksNothing />)
    await waitFor(() => expect(screen.queryByText(/marks no editable elements/)).toBeNull())
  })
})
