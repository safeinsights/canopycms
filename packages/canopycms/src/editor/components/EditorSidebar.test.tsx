import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { EditorSidebar, type EditorSidebarProps } from './EditorSidebar'
import { CanopyCMSProvider } from '../theme'

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CanopyCMSProvider>{children}</CanopyCMSProvider>
)

const defaultProps: EditorSidebarProps = {
  layout: 'side',
  highlightEnabled: false,
  onLayoutChange: vi.fn(),
  onHighlightToggle: vi.fn(),
  onPermissionManagerOpen: vi.fn(),
  onGroupManagerOpen: vi.fn(),
  onMediaLibraryOpen: vi.fn(),
}

/** Editor.tsx gates each admin item on the viewer; here, the prop contract it relies on. */
describe('EditorSidebar - admin menu items', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders no Manage permissions or Manage groups without their callbacks', async () => {
    render(
      <EditorSidebar
        {...defaultProps}
        onPermissionManagerOpen={undefined}
        onGroupManagerOpen={undefined}
      />,
      { wrapper: Wrapper },
    )

    await userEvent.click(screen.getByLabelText('Settings'))
    await screen.findByText('Media library')
    expect(screen.queryByText('Manage permissions')).toBeNull()
    expect(screen.queryByText('Manage groups')).toBeNull()
  })
})

describe('EditorSidebar - System health menu item', () => {
  afterEach(() => {
    cleanup()
  })

  it('does not render "System health" when onSystemHealthOpen is not provided', async () => {
    render(<EditorSidebar {...defaultProps} />, { wrapper: Wrapper })

    await userEvent.click(screen.getByLabelText('Settings'))

    // Wait for the (unrelated) always-present item so we know the dropdown
    // actually opened before asserting System health's absence.
    await screen.findByText('Manage groups')
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

describe('EditorSidebar - icon button tooltips', () => {
  afterEach(() => {
    cleanup()
  })

  it.each(['Settings', 'Toggle layout'])('shows the %s tooltip on keyboard focus', async (name) => {
    render(<EditorSidebar {...defaultProps} />, { wrapper: Wrapper })
    expect(screen.queryByRole('tooltip')).toBeNull()

    act(() => screen.getByRole('button', { name }).focus())

    expect((await screen.findByRole('tooltip')).textContent).toBe(name)
  })

  it('returns focus to the Settings button after an item acts and nothing takes focus', async () => {
    const onMediaLibraryOpen = vi.fn()
    render(<EditorSidebar {...defaultProps} onMediaLibraryOpen={onMediaLibraryOpen} />, {
      wrapper: Wrapper,
    })
    const settings = screen.getByRole('button', { name: 'Settings' })

    act(() => settings.focus())
    await userEvent.keyboard('{Enter}')
    const item = await screen.findByRole('menuitem', { name: 'Media library' })
    for (let i = 0; i < 6 && document.activeElement !== item; i++) {
      await userEvent.keyboard('{ArrowDown}')
    }
    await userEvent.keyboard('{Enter}')

    expect(onMediaLibraryOpen).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(settings))
  })

  it('hides the Settings tooltip while its menu is open', async () => {
    render(<EditorSidebar {...defaultProps} />, { wrapper: Wrapper })
    const settings = screen.getByRole('button', { name: 'Settings' })

    await userEvent.hover(settings)
    await screen.findByRole('tooltip')
    await userEvent.click(settings)

    await screen.findByText('Media library')
    // Otherwise it lingers beside the menu while the pointer stays on the button. It fades out, so
    // read its opacity rather than its presence.
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
    expect(tooltip?.style.opacity ?? '0').toBe('0')
  })
})

describe('EditorSidebar - inexact marks count', () => {
  afterEach(() => {
    cleanup()
  })

  it('puts the count in the text colour on an opaque orange tint', () => {
    render(
      <EditorSidebar
        {...defaultProps}
        highlightEnabled
        previewInexactMarks={[{ path: 'hero.subtitle', nearest: 'hero' }]}
      />,
      { wrapper: Wrapper },
    )
    const count = document.querySelector('.mantine-Indicator-indicator') as HTMLElement
    expect(count.textContent).toBe('1')
    expect(count.style.getPropertyValue('--indicator-color')).toBe('var(--canopy-count-bg-orange)')
    expect(count.style.getPropertyValue('--indicator-text-color')).toBe('var(--mantine-color-text)')
  })
})
