import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { DateField } from './DateField'

const zone = process.env.TZ

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const Harness: React.FC<{
  initial?: string
  onChange?: (v: string) => void
  readOnly?: boolean
  description?: string
}> = ({ initial = '', onChange, readOnly, description }) => {
  const [value, setValue] = useState(initial)
  return (
    <CanopyCMSProvider>
      <DateField
        label="Event date"
        description={description}
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange?.(next)
        }}
        dataCanopyField="eventDate"
        readOnly={readOnly}
      />
    </CanopyCMSProvider>
  )
}

const trigger = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-canopy-field="eventDate"]')
  if (!el) throw new Error('picker button not rendered')
  return el
}

const openPicker = async (): Promise<HTMLElement> => {
  fireEvent.click(trigger())
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

const REMOVE = { name: 'Remove date' }

// West of UTC, east of it, far east, and a zone whose clocks skip the midnight of 8 March 2026.
describe.each([
  'America/Los_Angeles',
  'America/New_York',
  'Asia/Tokyo',
  'Pacific/Auckland',
  'America/Havana',
])('in %s', (timeZone) => {
  it('stores the day clicked, from an empty field', async () => {
    process.env.TZ = timeZone
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 15, 12, 0, 0))
    const changes: string[] = []
    render(<Harness onChange={(v) => changes.push(v)} />)
    pickDay(await openPicker(), '5 November 2026')
    expect(changes).toEqual(['2026-11-05'])
    expect(trigger().textContent).toBe('5 Nov 2026')
  })

  it('stores the day clicked, on the day of a clock change', async () => {
    process.env.TZ = timeZone
    const changes: string[] = []
    render(<Harness initial="2026-03-20" onChange={(v) => changes.push(v)} />)
    pickDay(await openPicker(), '8 March 2026')
    expect(changes).toEqual(['2026-03-08'])
    expect(trigger().textContent).toBe('8 Mar 2026')
  })

  it('shows a stored value as that day, and writes nothing', () => {
    process.env.TZ = timeZone
    const onChange = vi.fn()
    render(<Harness initial="2024-05-01" onChange={onChange} />)
    expect(trigger().textContent).toBe('1 May 2024')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('DateField', () => {
  it('is a date picker with no time input, named by its label and value', async () => {
    render(<Harness initial="2024-05-01" />)
    const button = trigger()
    expect(button.getAttribute('data-dates-input')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Event date, 1 May 2024')
    expect(screen.getByLabelText('Event date', { exact: false })).toBe(button)
    const dropdown = await openPicker()
    expect(dropdown.querySelector('input[type="time"]')).toBeNull()
  })

  it('names the trigger "not set", shows the placeholder and offers no Remove when empty', () => {
    render(<Harness />)
    expect(trigger().getAttribute('aria-label')).toBe('Event date, not set')
    expect(trigger().textContent).toBe('Pick a date')
    expect(screen.queryByRole('button', REMOVE)).toBeNull()
  })

  it('shows its description and no time zone: a day has none', () => {
    render(<Harness initial="2024-05-01" description="The day it runs." />)
    const ids = trigger().getAttribute('aria-describedby')?.split(' ') ?? []
    const text = ids.map((id) => document.getElementById(id)?.textContent).join(' ')
    expect(text).toBe('The day it runs.')
    expect(document.body.textContent).not.toMatch(/time zone/i)
  })

  it('labels the calendar and does not colour weekends differently', async () => {
    render(<Harness initial="2024-06-15" />)
    const dropdown = await openPicker()
    expect(dropdown.querySelector('button[aria-label="Choose a month"]')).not.toBeNull()
    expect(dropdown.querySelector('button[aria-label="Previous month"]')).not.toBeNull()
    expect(dropdown.querySelectorAll('button[aria-label$="June 2024"]').length).toBeGreaterThan(27)
    expect(dropdown.querySelector('[data-weekend]')).toBeNull()
  })

  it('closes on a pick, and opening and closing it writes nothing', async () => {
    const onChange = vi.fn()
    render(<Harness initial="2024-06-15" onChange={onChange} />)
    const dropdown = await openPicker()
    expect(onChange).not.toHaveBeenCalled()
    pickDay(dropdown, '17 June 2024')
    expect(onChange.mock.calls).toEqual([['2024-06-17']])
    await waitFor(() => expect(document.querySelector('[data-dates-dropdown]')).toBeNull())
  })

  it('Remove writes the empty string, takes the control away and focuses the trigger', async () => {
    const changes: string[] = []
    render(<Harness initial="2024-05-01" onChange={(v) => changes.push(v)} />)
    fireEvent.click(screen.getByRole('button', REMOVE))
    expect(changes).toEqual([''])
    expect(trigger().textContent).toBe('Pick a date')
    expect(screen.queryByRole('button', REMOVE)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
    expect(document.querySelector('[data-dates-dropdown]')).toBeNull()
  })

  it.each(['2026-02-30', '2026-5-1', '2026-05-01T05:00:00.000Z', 'next tuesday'])(
    'shows %s, no real day, as not set, writes nothing, and Remove clears it',
    (stored) => {
      const changes: string[] = []
      render(<Harness initial={stored} onChange={(v) => changes.push(v)} />)
      expect(trigger().textContent).toBe('Pick a date')
      expect(trigger().getAttribute('aria-label')).toBe('Event date, not set')
      expect(changes).toEqual([])
      fireEvent.click(screen.getByRole('button', REMOVE))
      expect(changes).toEqual([''])
    },
  )

  it('keeps a year below 100 as written, not as a 1900s year', () => {
    render(<Harness initial="0099-01-01" />)
    expect(trigger().textContent).toBe('1 Jan 0099')
  })

  describe('read-only', () => {
    it('shows the value with no Remove', () => {
      render(<Harness initial="2024-05-01" readOnly />)
      expect(trigger().textContent).toBe('1 May 2024')
      expect(screen.queryByRole('button', REMOVE)).toBeNull()
    })

    it('shows an empty value as empty, without the placeholder', () => {
      render(<Harness readOnly />)
      expect(trigger().textContent).toBe('')
    })

    it('does not open and writes nothing', async () => {
      const onChange = vi.fn()
      render(<Harness initial="2024-05-01" readOnly onChange={onChange} />)
      fireEvent.click(trigger())
      fireEvent.keyDown(trigger(), { key: 'Enter' })
      // Time for an opening transition to mount a dropdown it should not.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(document.querySelector('[data-dates-dropdown]')).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
    })
  })
})
