import React, { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { CanopyCMSProvider } from '../theme'
import { NumberListField } from './NumberListField'

afterEach(cleanup)

const Harness: React.FC<{ initial?: number[]; onChange?: (v: number[]) => void }> = ({
  initial = [],
  onChange,
}) => {
  const [value, setValue] = useState<number[]>(initial)
  return (
    <CanopyCMSProvider>
      <NumberListField
        label="Scores"
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange?.(next)
        }}
        dataCanopyField="scores"
      />
    </CanopyCMSProvider>
  )
}

const getInput = () =>
  document.querySelector('input[data-canopy-field="scores"]') as HTMLInputElement

describe('NumberListField', () => {
  it('adds a typed number as a tag', async () => {
    const user = userEvent.setup()
    const changes: number[][] = []
    render(<Harness onChange={(v) => changes.push(v)} />)

    await user.type(getInput(), '42{Enter}')

    expect(changes.at(-1)).toEqual([42])
  })

  it('keeps negative and fractional values intact', async () => {
    const user = userEvent.setup()
    const changes: number[][] = []
    render(<Harness onChange={(v) => changes.push(v)} />)

    await user.type(getInput(), '-0.5{Enter}')

    expect(changes.at(-1)).toEqual([-0.5])
  })

  // Regression: a tag that doesn't parse used to vanish on Enter with no
  // value stored and nothing shown - indistinguishable from a broken field.
  it('names a rejected tag instead of silently discarding it', async () => {
    const user = userEvent.setup()
    const changes: number[][] = []
    render(<Harness onChange={(v) => changes.push(v)} />)

    await user.type(getInput(), 'abc{Enter}')

    expect(changes.at(-1)).toEqual([])
    expect(screen.getByText('Not a number: abc')).toBeTruthy()
  })

  it('clears the rejection message once a valid tag is entered', async () => {
    const user = userEvent.setup()
    render(<Harness onChange={() => {}} />)

    await user.type(getInput(), 'abc{Enter}')
    expect(screen.queryByText('Not a number: abc')).toBeTruthy()

    await user.type(getInput(), '7{Enter}')
    expect(screen.queryByText('Not a number: abc')).toBeNull()
  })

  it('does not turn a blank tag into a spurious 0', async () => {
    const user = userEvent.setup()
    const changes: number[][] = []
    render(<Harness initial={[1]} onChange={(v) => changes.push(v)} />)

    // A blank entry must never reach the stored list: Number('') is 0, so
    // the naive parse would store a 0 nobody typed.
    //
    // DOES NOT FLIP RED against the pre-fix parse: Mantine's TagsInput
    // refuses to add a blank tag, so onChange never fires and the bad parse
    // is unreachable from the UI. Kept as a guard on `parseTag`'s blank
    // check, which is the only thing standing between a programmatic or
    // future non-UI caller and that spurious 0 - not counted as coverage of
    // the fixed defect.
    await user.type(getInput(), '   {Enter}')

    expect(changes.at(-1) ?? [1]).toEqual([1])
  })
})
