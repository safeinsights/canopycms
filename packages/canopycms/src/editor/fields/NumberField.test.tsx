import React, { useState } from 'react'
import { cleanup, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { NumberField } from './NumberField'

afterEach(cleanup)

const Harness: React.FC<{ initial?: number; onChange?: (v: number | undefined) => void }> = ({
  initial,
  onChange,
}) => {
  const [value, setValue] = useState<number | undefined>(initial)
  return (
    <CanopyCMSProvider>
      <NumberField
        label="Price"
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange?.(next)
        }}
        dataCanopyField="price"
      />
    </CanopyCMSProvider>
  )
}

const getInput = () =>
  document.querySelector('input[data-canopy-field="price"]') as HTMLInputElement

describe('NumberField', () => {
  it('renders a text input, not the "Unsupported field" fallback', () => {
    render(<Harness />)
    expect(getInput()).toBeTruthy()
  })

  // Regression: the wrapper used to round-trip every in-progress keystroke
  // through `Number()` and hand the result back as the controlled value.
  // `String(-0)` is `"0"`, so the minus was erased from the input after the
  // second keystroke of `-0.5` and the fraction digits appended to a POSITIVE
  // zero - the user typed -0.5 and 0.5 was stored, silently.
  describe('typing a value keystroke by keystroke stores exactly what was typed', () => {
    for (const typed of ['-0.5', '-0.05', '-1.5', '-42', '19.99', '0.5', '0.05', '19.50']) {
      it(`stores ${typed} as ${Number(typed)}`, async () => {
        const user = userEvent.setup()
        const changes: (number | undefined)[] = []
        render(<Harness onChange={(v) => changes.push(v)} />)

        await user.type(getInput(), typed)

        expect(getInput().value).toBe(typed)
        expect(changes.at(-1)).toBe(Number(typed))
      })
    }

    // Spellings Mantine canonicalizes on the way in, so the displayed text
    // legitimately differs from the keystrokes - only the stored value is
    // asserted.
    it('stores -.5 as -0.5', async () => {
      const user = userEvent.setup()
      const changes: (number | undefined)[] = []
      render(<Harness onChange={(v) => changes.push(v)} />)

      await user.type(getInput(), '-.5')

      expect(changes.at(-1)).toBe(-0.5)
    })

    it('keeps the minus visible while -0 is still an incomplete entry', async () => {
      const user = userEvent.setup()
      render(<Harness />)

      await user.type(getInput(), '-0')

      // The regression: this rendered "0", so the next keystroke built a
      // positive number.
      expect(getInput().value).toBe('-0')
    })
  })

  it('reports an empty input as undefined, not 0', async () => {
    const user = userEvent.setup()
    const changes: (number | undefined)[] = []
    render(<Harness initial={5} onChange={(v) => changes.push(v)} />)

    await user.clear(getInput())

    expect(changes.at(-1)).toBeUndefined()
  })

  it('keeps 0 distinct from "not filled in"', async () => {
    const user = userEvent.setup()
    const changes: (number | undefined)[] = []
    render(<Harness onChange={(v) => changes.push(v)} />)

    await user.type(getInput(), '0')

    expect(changes.at(-1)).toBe(0)
  })

  it('displays a value supplied by the parent (loading a stored entry)', () => {
    render(<Harness initial={-0.5} />)
    expect(getInput().value).toBe('-0.5')
  })
})
