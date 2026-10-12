import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { DateTimeField } from './DateTimeField'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// Mid-month and mid-day, well clear of any DST transition, so what the picker shows and writes
// is deterministic whatever the machine's time zone.
const STORED = '2024-06-15T10:30:20.000Z'

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const two = (n: number): string => String(n).padStart(2, '0')

/** The picker's button text for an instant, in the machine's time zone: "D MMM YYYY, HH:mm:ss". */
const displayed = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** An ISO string's local wall clock, as [year, month (1-12), day, hours, minutes, seconds]. */
const wallClock = (iso: string): number[] => {
  const d = new Date(iso)
  return [
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  ]
}

const Harness: React.FC<{
  initial?: string
  onChange?: (v: string) => void
  readOnly?: boolean
}> = ({ initial = '', onChange, readOnly }) => {
  const [value, setValue] = useState(initial)
  return (
    <CanopyCMSProvider>
      <DateTimeField
        label="Published at"
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange?.(next)
        }}
        dataCanopyField="publishedAt"
        readOnly={readOnly}
      />
    </CanopyCMSProvider>
  )
}

const pickerButton = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-canopy-field="publishedAt"]')
  if (!el) throw new Error('picker button not rendered')
  return el
}

/** Opens the picker and returns its dropdown. */
const openPicker = async (): Promise<HTMLElement> => {
  fireEvent.click(pickerButton())
  return waitFor(() => {
    const dropdown = document.querySelector<HTMLElement>('[data-dates-dropdown]')
    if (!dropdown) throw new Error('dropdown not open')
    return dropdown
  })
}

const pickDay = (dropdown: HTMLElement, ariaLabel: string) => {
  const day = dropdown.querySelector<HTMLElement>(`button[aria-label="${ariaLabel}"]`)
  if (!day) throw new Error(`no day button "${ariaLabel}"`)
  fireEvent.click(day)
}

const setTime = (dropdown: HTMLElement, time: string) => {
  const input = dropdown.querySelector<HTMLInputElement>('input[type="time"]')
  if (!input) throw new Error('no time input')
  fireEvent.change(input, { target: { value: time } })
}

/** The check button beside the time input, which closes the dropdown. */
const submitTime = (dropdown: HTMLElement) => {
  const buttons = dropdown.querySelectorAll<HTMLElement>('button')
  fireEvent.click(buttons[buttons.length - 1])
}

describe('DateTimeField', () => {
  it('renders a date-time picker, not the "Unsupported field" fallback, labelled by the field', () => {
    render(<Harness />)
    expect(screen.queryByText(/unsupported field/i)).toBeNull()
    const button = pickerButton()
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('data-dates-input')).toBe('true')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(screen.getByLabelText('Published at')).toBe(button)
  })

  it('shows a stored ISO UTC value as the local wall clock, with seconds', () => {
    render(<Harness initial={STORED} />)
    expect(pickerButton().textContent).toBe(displayed(STORED))
    expect(pickerButton().textContent).toMatch(/^\d{1,2} [A-Z][a-z]{2} 2024, \d{2}:\d{2}:\d{2}$/)
  })

  it('shows the placeholder when nothing is stored', () => {
    render(<Harness />)
    expect(pickerButton().textContent).toBe('Pick a date and time')
  })

  it('calls no onChange on mount, on re-render, or on opening and closing the picker', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<Harness initial={STORED} onChange={onChange} />)
    rerender(<Harness initial={STORED} onChange={onChange} />)
    const dropdown = await openPicker()
    // Focus lands in the picker without writing.
    expect(onChange).not.toHaveBeenCalled()
    submitTime(dropdown)
    await waitFor(() => expect(document.querySelector('[data-dates-dropdown]')).toBeNull())
    expect(onChange).not.toHaveBeenCalled()
    expect(pickerButton().textContent).toBe(displayed(STORED))
  })

  it('picking a day keeps the stored time and writes a valid ISO UTC string on that local day', async () => {
    const changes: string[] = []
    render(<Harness initial={STORED} onChange={(v) => changes.push(v)} />)
    const dropdown = await openPicker()

    pickDay(dropdown, '17 June 2024')

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatch(ISO_UTC)
    expect(new Date(changes[0]).toISOString()).toBe(changes[0])
    expect(wallClock(changes[0]).slice(0, 3)).toEqual([2024, 6, 17])
    // The time of day is the stored one, in local time, seconds included.
    expect(wallClock(changes[0]).slice(3)).toEqual(wallClock(STORED).slice(3))
    expect(pickerButton().textContent).toBe(displayed(changes[0]))
  })

  it('setting the time writes an ISO UTC string whose local wall clock is the time entered', async () => {
    const changes: string[] = []
    render(<Harness initial={STORED} onChange={(v) => changes.push(v)} />)
    const dropdown = await openPicker()

    setTime(dropdown, '08:15:45')

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatch(ISO_UTC)
    expect(changes[0].endsWith('.000Z')).toBe(true)
    // The day is the stored one; only the time moved.
    expect(wallClock(changes[0])).toEqual([...wallClock(STORED).slice(0, 3), 8, 15, 45])
  })

  it('picks a day, then a time, from an empty field: the result is that local date and time', async () => {
    // Faked clock so the calendar opens on a known month; timers stay real for Mantine's transitions.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2024, 2, 10, 12, 0, 0))
    const changes: string[] = []
    render(<Harness onChange={(v) => changes.push(v)} />)
    const dropdown = await openPicker()

    pickDay(dropdown, '20 March 2024')
    setTime(dropdown, '14:05:09')
    submitTime(dropdown)

    expect(changes.length).toBeGreaterThanOrEqual(2)
    for (const change of changes) expect(change).toMatch(ISO_UTC)
    expect(wallClock(changes.at(-1) as string)).toEqual([2024, 3, 20, 14, 5, 9])
    await waitFor(() => expect(pickerButton().textContent).toBe('20 Mar 2024, 14:05:09'))
  })

  it('clearing writes the empty string, which means "not set", and shows the placeholder', () => {
    const changes: string[] = []
    render(<Harness initial={STORED} onChange={(v) => changes.push(v)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear date and time' }))

    expect(changes).toEqual([''])
    expect(pickerButton().textContent).toBe('Pick a date and time')
    expect(screen.queryByRole('button', { name: 'Clear date and time' })).toBeNull()
  })

  it('offers no clear button when nothing is stored', () => {
    render(<Harness />)
    expect(screen.queryByRole('button', { name: 'Clear date and time' })).toBeNull()
  })

  it('renders an unparsable stored value as empty and writes nothing', async () => {
    const onChange = vi.fn()
    render(<Harness initial="next tuesday" onChange={onChange} />)
    expect(pickerButton().textContent).toBe('Pick a date and time')
    expect(screen.queryByRole('button', { name: 'Clear date and time' })).toBeNull()
    const dropdown = await openPicker()
    submitTime(dropdown)
    expect(onChange).not.toHaveBeenCalled()
  })

  describe('read-only', () => {
    it('shows the value with no clear button and no placeholder', () => {
      render(<Harness initial={STORED} readOnly />)
      expect(pickerButton().textContent).toBe(displayed(STORED))
      expect(screen.queryByRole('button', { name: 'Clear date and time' })).toBeNull()
    })

    it('shows an empty value as empty, without the placeholder', () => {
      render(<Harness readOnly />)
      expect(pickerButton().textContent).toBe('')
    })

    it('does not open on click and writes nothing', async () => {
      const onChange = vi.fn()
      render(<Harness initial={STORED} readOnly onChange={onChange} />)
      fireEvent.click(pickerButton())
      fireEvent.keyDown(pickerButton(), { key: 'Enter' })
      // Give an opening transition the chance to mount a dropdown it should not.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(document.querySelector('[data-dates-dropdown]')).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
      expect(pickerButton().textContent).toBe(displayed(STORED))
    })

    it('renders an unparsable value as empty and writes nothing', () => {
      const onChange = vi.fn()
      render(<Harness initial="next tuesday" readOnly onChange={onChange} />)
      expect(pickerButton().textContent).toBe('')
      fireEvent.click(pickerButton())
      expect(onChange).not.toHaveBeenCalled()
    })
  })
})
