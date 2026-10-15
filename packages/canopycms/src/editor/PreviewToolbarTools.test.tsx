import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HighlightToggle,
  LayoutToggle,
  MaximizeToggle,
  UnmappedMarksChip,
} from './PreviewToolbarTools'
import { CanopyCMSProvider } from './theme'

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CanopyCMSProvider>{children}</CanopyCMSProvider>
)

afterEach(() => cleanup())

describe('HighlightToggle', () => {
  const name = 'Highlight fields in the preview'

  it('draws its icon as a dashed outline, like the outline it turns on in the preview', () => {
    render(<HighlightToggle enabled={false} onToggle={vi.fn()} />, { wrapper: Wrapper })
    const strokes = [...screen.getByRole('button', { name }).querySelectorAll('svg path')]
      .map((path) => path.getAttribute('d') ?? '')
      .join(' ')
      .match(/[Mm]/g)
    expect(strokes?.length ?? 0).toBeGreaterThanOrEqual(8)
  })

  it('reports its state as pressed', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<HighlightToggle enabled={false} onToggle={onToggle} />, {
      wrapper: Wrapper,
    })
    const toggle = screen.getByRole('button', { name })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<HighlightToggle enabled onToggle={onToggle} />)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('says beside the toggle, and to assistive tech, when highlights are on and nothing is marked', () => {
    const { rerender } = render(<HighlightToggle enabled onToggle={vi.fn()} />, {
      wrapper: Wrapper,
    })
    expect(screen.queryByText('Nothing to highlight')).toBeNull()

    rerender(<HighlightToggle enabled marksNothing onToggle={vi.fn()} />)
    expect(screen.getByText('Nothing to highlight')).toBeTruthy()
    const describedBy = screen.getByRole('button', { name }).getAttribute('aria-describedby')
    expect(document.getElementById(describedBy ?? '')?.textContent).toMatch(
      /marks no editable elements/,
    )

    rerender(<HighlightToggle enabled={false} marksNothing onToggle={vi.fn()} />)
    expect(screen.queryByText('Nothing to highlight')).toBeNull()
    expect(screen.getByRole('button', { name }).getAttribute('aria-describedby')).toBeNull()
  })
})

describe('UnmappedMarksChip', () => {
  it('renders nothing for no marks', () => {
    render(<UnmappedMarksChip marks={[]} />, { wrapper: Wrapper })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('puts the count in the text colour on an opaque orange tint', () => {
    render(<UnmappedMarksChip marks={[{ path: 'hero.subtitle', nearest: 'hero' }]} />, {
      wrapper: Wrapper,
    })
    const chip = screen.getByRole('button', { name: '1 unmapped preview mark' })
    expect(chip.style.background).toBe('var(--canopy-count-bg-orange)')
    expect(chip.style.color).toBe('var(--mantine-color-text)')
  })

  it('explains what unmapped means and where to look, listing three marks and a count', async () => {
    render(
      <UnmappedMarksChip
        marks={[{ path: 'a' }, { path: 'b.c', nearest: 'b' }, { path: '' }, { path: 'd' }]}
      />,
      { wrapper: Wrapper },
    )
    fireEvent.click(screen.getByRole('button', { name: '4 unmapped preview marks' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(
      '4 elements on this page carry field marks that don\'t match a field of this entry: a, b.c, "", and 1 more. They\'re outlined, but clicking one focuses no field.',
    )
    expect(dialog.textContent).toContain('The browser console names the nearest field of each,')
    // Only the paths are set as code, not the count after them.
    const code = [...dialog.querySelectorAll('span')].map((span) => span.textContent)
    expect(code).toContain('a, b.c, ""')
  })

  it('takes focus when it opens, and gives it back to the chip on Escape', async () => {
    render(<UnmappedMarksChip marks={[{ path: 'x' }]} />, { wrapper: Wrapper })
    const chip = screen.getByRole('button', { name: '1 unmapped preview mark' })
    act(() => chip.focus())
    fireEvent.click(chip)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(chip))
  })

  it('speaks of one mark in the singular', async () => {
    render(<UnmappedMarksChip marks={[{ path: 'x' }]} />, { wrapper: Wrapper })
    fireEvent.click(screen.getByRole('button', { name: '1 unmapped preview mark' }))
    expect((await screen.findByRole('dialog')).textContent).toContain(
      "One element on this page carries a field mark that doesn't match a field of this entry: x. It's outlined, but clicking it focuses no field.The browser console names the nearest field of it,",
    )
  })
})

describe('LayoutToggle', () => {
  it('shows the current layout as the pressed one of the pair', () => {
    const onChange = vi.fn()
    const { rerender } = render(<LayoutToggle layout="side" onChange={onChange} />, {
      wrapper: Wrapper,
    })
    const side = screen.getByRole('button', { name: 'Side by side' })
    const stacked = screen.getByRole('button', { name: 'Stacked' })
    expect([side, stacked].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false'])

    fireEvent.click(stacked)
    expect(onChange).toHaveBeenCalledWith('stacked')

    rerender(<LayoutToggle layout="stacked" onChange={onChange} />)
    expect([side, stacked].map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
  })

  it('shows its tooltip on keyboard focus', async () => {
    render(<LayoutToggle layout="side" onChange={vi.fn()} />, { wrapper: Wrapper })
    act(() => screen.getByRole('button', { name: 'Stacked' }).focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe('Stacked')
  })

  it('says why it is blocked while the preview is maximized, and does nothing', async () => {
    const onChange = vi.fn()
    render(<LayoutToggle layout="side" onChange={onChange} blocked />, { wrapper: Wrapper })
    const stacked = screen.getByRole('button', { name: 'Stacked' })
    expect(stacked.getAttribute('aria-disabled')).toBe('true')
    const describedBy = stacked.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Restore the preview to change the layout.',
    )

    fireEvent.click(stacked)
    expect(onChange).not.toHaveBeenCalled()
    act(() => stacked.focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Restore the preview to change the layout.',
    )
  })
})

describe('MaximizeToggle', () => {
  it('offers Maximize as an icon, then a labelled Restore that names Escape', () => {
    const onChange = vi.fn()
    const { rerender } = render(<MaximizeToggle maximized={false} onChange={onChange} />, {
      wrapper: Wrapper,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Maximize preview' }))
    expect(onChange).toHaveBeenLastCalledWith(true)

    rerender(<MaximizeToggle maximized onChange={onChange} />)
    const restore = screen.getByRole('button', { name: 'Restore' })
    expect(restore.getAttribute('aria-keyshortcuts')).toBe('Escape')
    fireEvent.click(restore)
    expect(onChange).toHaveBeenLastCalledWith(false)
  })
})
