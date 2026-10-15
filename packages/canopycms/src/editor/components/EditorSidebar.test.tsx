import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, waitFor } from '@testing-library/react'
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
}

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

  it('shows the Toggle layout tooltip on keyboard focus', async () => {
    render(<EditorSidebar {...defaultProps} />, { wrapper: Wrapper })
    expect(screen.queryByRole('tooltip')).toBeNull()

    act(() => screen.getByRole('button', { name: 'Toggle layout' }).focus())

    expect((await screen.findByRole('tooltip')).textContent).toBe('Toggle layout')
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
