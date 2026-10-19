import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { StringListField } from './StringListField'

// Controlled harness mirroring how FormRenderer drives the field.
const Harness: React.FC<{
  initial?: string[]
  onChange?: (v: string[]) => void
  description?: string
  readOnly?: boolean
  maxItems?: number
}> = ({ initial = [], onChange, description, readOnly, maxItems }) => {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <CanopyCMSProvider>
      <StringListField
        label="Tags"
        description={description}
        readOnly={readOnly}
        maxItems={maxItems}
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

/** The text the input is described by, which is where Mantine puts a field's description. */
const describedBy = (): string | undefined => {
  const input = document.querySelector('input[data-canopy-field="tags"]')
  const ids = input?.getAttribute('aria-describedby')?.split(' ') ?? []
  const texts = ids.map((id) => document.getElementById(id)?.textContent).filter(Boolean)
  return texts.length > 0 ? texts.join(' ') : undefined
}

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

  describe('the Enter hint', () => {
    it('is the whole description of an editable list that has none', () => {
      render(<Harness />)
      expect(describedBy()).toBe('Press Enter to add.')
    })

    it('follows the field description, in one line, when the list is editable', () => {
      render(<Harness description="Used for search." />)
      expect(describedBy()).toBe('Used for search. Press Enter to add.')
    })

    it.each([
      ['Used for search', 'Used for search. Press Enter to add.'],
      ['Used for search.', 'Used for search. Press Enter to add.'],
      ['Really, tags!', 'Really, tags! Press Enter to add.'],
      ['Which tags?', 'Which tags? Press Enter to add.'],
      ['  Used for search  ', 'Used for search. Press Enter to add.'],
      ['', 'Press Enter to add.'],
      ['   ', 'Press Enter to add.'],
    ])('after the description %j reads %j', (description, expected) => {
      render(<Harness description={description} />)
      expect(describedBy()).toBe(expected)
    })

    it('leaves a read-only description exactly as given, with no full stop added', () => {
      render(<Harness description="Used for search" readOnly />)
      expect(describedBy()).toBe('Used for search')
    })

    it('is absent from a read-only list that has a description', () => {
      render(<Harness description="Used for search." readOnly />)
      expect(describedBy()).toBe('Used for search.')
      expect(screen.queryByText(/press enter/i)).toBeNull()
    })

    it('is absent from a read-only list that has no description', () => {
      render(<Harness readOnly />)
      expect(describedBy()).toBeUndefined()
      expect(screen.queryByText(/press enter/i)).toBeNull()
    })
  })
})

describe('StringListField at its maxItems', () => {
  it('adds nothing more and says why in place of the Enter hint', async () => {
    const user = userEvent.setup()
    const changes: string[][] = []
    render(<Harness initial={['red', 'blue']} maxItems={2} onChange={(v) => changes.push(v)} />)

    expect(describedBy()).toBe('This list holds at most 2 items. Remove one to add another.')
    const input = document.querySelector('input[data-canopy-field="tags"]') as HTMLInputElement
    await user.type(input, 'green{Enter}')
    expect(changes).toEqual([])
  })

  it('keeps the Enter hint below the cap', () => {
    render(<Harness initial={['red']} maxItems={2} />)
    expect(describedBy()).toBe('Press Enter to add.')
  })
})
