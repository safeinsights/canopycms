import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { StringListField } from './StringListField'

// Controlled harness mirroring how FormRenderer drives the field.
const Harness: React.FC<{ initial?: string[]; onChange?: (v: string[]) => void }> = ({
  initial = [],
  onChange,
}) => {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <CanopyCMSProvider>
      <StringListField
        label="Tags"
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange?.(next)
        }}
        dataCanopyField="tags"
      />
    </CanopyCMSProvider>
  )
}

afterEach(cleanup)

describe('StringListField', () => {
  it('renders existing items as pills and tags the input with data-canopy-field', () => {
    render(<Harness initial={['alpha', 'beta']} />)

    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    // The e2e fixture locates fields via input[data-canopy-field=...] — keep
    // that contract (TagsInput must forward unknown props to its input).
    const input = document.querySelector('input[data-canopy-field="tags"]')
    expect(input).toBeTruthy()
  })

  it('adds an item on Enter and removes the last on Backspace with empty input', () => {
    const changes: string[][] = []
    render(<Harness initial={['alpha']} onChange={(v) => changes.push(v)} />)

    const input = document.querySelector('input[data-canopy-field="tags"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'beta' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(changes.at(-1)).toEqual(['alpha', 'beta'])

    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(changes.at(-1)).toEqual(['alpha'])
  })

  it('round-trips comma-containing values and duplicates faithfully', () => {
    // Generic string lists are data, not tags: "New York, NY" must stay one
    // item (splitChars off) and duplicate entries must not be dropped.
    const changes: string[][] = []
    render(<Harness initial={['alpha']} onChange={(v) => changes.push(v)} />)

    const input = document.querySelector('input[data-canopy-field="tags"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'New York, NY' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(changes.at(-1)).toEqual(['alpha', 'New York, NY'])

    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(changes.at(-1)).toEqual(['alpha', 'New York, NY', 'alpha'])
  })
})
