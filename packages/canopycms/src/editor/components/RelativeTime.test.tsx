import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { RelativeTime } from './RelativeTime'

afterEach(cleanup)

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

describe('RelativeTime', () => {
  it('renders a time element carrying the ISO value, with the prefix before the relative label', () => {
    const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const { container } = render(<RelativeTime iso={iso} prefix="Updated " />, { wrapper: Wrapper })

    const time = container.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe(iso)
    expect(time?.firstChild?.textContent).toBe('Updated ')
    expect(time?.textContent).toContain('Updated 3h ago')
  })

  it('reads the absolute date after the label for a screen reader, with no tab stop', () => {
    const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const { container } = render(<RelativeTime iso={iso} />, { wrapper: Wrapper })

    const time = container.querySelector('time') as HTMLElement
    const hidden = time.querySelector('.mantine-VisuallyHidden-root')
    expect(hidden?.textContent).toBe(`, ${new Date(iso).toLocaleString()}`)
    expect(time.textContent).toBe(`3h ago, ${new Date(iso).toLocaleString()}`)
    expect(time.querySelectorAll('button, a, [tabindex]')).toHaveLength(0)
  })

  it('shows the absolute date and time in a tooltip', async () => {
    const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const { container } = render(<RelativeTime iso={iso} />, { wrapper: Wrapper })

    fireEvent.mouseEnter(container.querySelector('time') as HTMLElement)

    expect(await screen.findByText(new Date(iso).toLocaleString())).toBeTruthy()
  })

  it('shows an unparseable value as it is, with no tooltip', async () => {
    const { container } = render(<RelativeTime iso="not-a-date" />, { wrapper: Wrapper })
    const time = container.querySelector('time') as HTMLElement

    fireEvent.mouseEnter(time)
    // A tooltip would be on screen by now: the valid case above finds one as soon as it waits.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })

    expect(time.textContent).toBe('not-a-date')
    expect(screen.queryByText('Invalid Date')).toBeNull()
    expect(time.querySelector('.mantine-VisuallyHidden-root')).toBeNull()
  })
})
