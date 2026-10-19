import React, { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { SelectField } from './SelectField'

afterEach(cleanup)

const COLOURS = [
  { value: 'red', label: 'Red' },
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
]

const Harness: React.FC<{ initial: string[]; maxItems?: number }> = ({ initial, maxItems }) => {
  const [value, setValue] = useState(initial)
  return (
    <CanopyCMSProvider>
      <SelectField
        label="Colours"
        options={COLOURS}
        value={value}
        onChange={(next) => setValue(next as string[])}
        multiple
        maxItems={maxItems}
        dataCanopyField="colours"
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </CanopyCMSProvider>
  )
}

describe('a multiple SelectField at its maxItems', () => {
  it('takes no more values and says why', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['red', 'blue']} maxItems={2} />)

    expect(
      screen.getByText('This list holds at most 2 items. Remove one to add another.'),
    ).toBeTruthy()
    await user.click(screen.getByRole('textbox', { name: 'Colours' }))
    const green = screen.queryByRole('option', { name: 'Green' })
    if (green) await user.click(green)
    expect(JSON.parse(screen.getByTestId('value').textContent ?? '[]')).toEqual(['red', 'blue'])
  })

  it('takes a value below the cap', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['red']} maxItems={2} />)

    await user.click(screen.getByRole('textbox', { name: 'Colours' }))
    await user.click(screen.getByRole('option', { name: 'Green' }))
    expect(JSON.parse(screen.getByTestId('value').textContent ?? '[]')).toEqual(['red', 'green'])
    expect(
      screen.getByText('This list holds at most 2 items. Remove one to add another.'),
    ).toBeTruthy()
  })
})
