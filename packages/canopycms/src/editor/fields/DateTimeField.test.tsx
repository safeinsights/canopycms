import React, { useState } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { DateTimeField, datetimeLocalValueToIso, isoToDatetimeLocalValue } from './DateTimeField'

afterEach(cleanup)

// Chosen well clear of any DST transition so the round trip is deterministic
// regardless of the machine's local timezone.
const SAMPLE_ISO_TIMESTAMPS = [
  '2024-06-15T10:30:00.000Z',
  '2024-01-01T00:00:00.000Z',
  '2024-12-31T23:59:59.000Z',
]

const Harness: React.FC<{ initial?: string; onChange?: (v: string) => void }> = ({
  initial = '',
  onChange,
}) => {
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
      />
    </CanopyCMSProvider>
  )
}

describe('DateTimeField', () => {
  describe('isoToDatetimeLocalValue / datetimeLocalValueToIso (UTC <-> local wall-clock)', () => {
    it('round-trips ISO UTC timestamps without shifting by the local timezone offset', () => {
      for (const iso of SAMPLE_ISO_TIMESTAMPS) {
        const local = isoToDatetimeLocalValue(iso)
        const backToIso = datetimeLocalValueToIso(local)
        expect(backToIso).toBe(iso)
      }
    })

    it('treats empty string as "not set" in both directions', () => {
      expect(isoToDatetimeLocalValue('')).toBe('')
      expect(datetimeLocalValueToIso('')).toBe('')
    })
  })

  it('renders a native datetime-local input, not the "Unsupported field" fallback', () => {
    render(<Harness />)
    const input = document.querySelector('input[data-canopy-field="publishedAt"]')
    expect(input).toBeTruthy()
    expect(input?.getAttribute('type')).toBe('datetime-local')
  })

  it('updates form state when edited, and the new value is a valid ISO UTC string', () => {
    const changes: string[] = []
    render(<Harness onChange={(v) => changes.push(v)} />)
    const input = document.querySelector(
      'input[data-canopy-field="publishedAt"]',
    ) as HTMLInputElement

    fireEvent.change(input, { target: { value: '2024-06-15T04:30:00' } })

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // Re-parsing the stored value must land back on the same wall-clock time
    // (seconds omitted here since :00 is the platform's canonical form for
    // a zero seconds component - see isoToDatetimeLocalValue).
    expect(isoToDatetimeLocalValue(changes[0])).toBe('2024-06-15T04:30')
  })

  it('loading a stored value displays and can be re-saved as the exact same ISO string (no timezone shift)', () => {
    const initial = '2024-06-15T10:30:00.000Z'
    const changes: string[] = []
    render(<Harness initial={initial} onChange={(v) => changes.push(v)} />)
    const input = document.querySelector(
      'input[data-canopy-field="publishedAt"]',
    ) as HTMLInputElement

    // The input displays the local wall-clock equivalent - proves loading a
    // stored value doesn't shift it.
    const displayed = input.value
    expect(displayed).toBe(isoToDatetimeLocalValue(initial))

    // Re-entering that exact displayed value (a real DOM change, unlike
    // re-firing an identical value which React's controlled-input change
    // detection would swallow as a no-op) must convert back to the exact
    // original ISO string, not one shifted by the browser's UTC offset.
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.change(input, { target: { value: displayed } })
    expect(changes.at(-1)).toBe(initial)
  })

  it('a required datetime field can be filled with a real value (not left permanently empty)', () => {
    const changes: string[] = []
    render(<Harness onChange={(v) => changes.push(v)} />)
    const input = document.querySelector(
      'input[data-canopy-field="publishedAt"]',
    ) as HTMLInputElement

    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '2024-06-15T04:30:00' } })
    expect(changes.at(-1)).not.toBe('')
  })
})
