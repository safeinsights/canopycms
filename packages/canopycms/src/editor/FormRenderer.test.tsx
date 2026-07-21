import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import React, { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { TextField } from './fields/TextField'
import { CanopyCMSProvider } from './theme'

afterEach(() => cleanup())

beforeAll(() => {
  // Mantine color scheme helpers expect matchMedia to exist (jsdom does not provide it).
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }
  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver as typeof ResizeObserver
  }
})

const StatefulForm = ({
  fields,
  initialValue,
  customRenderers,
}: {
  fields: FieldConfig[]
  initialValue: FormValue
  customRenderers?: React.ComponentProps<typeof FormRenderer>['customRenderers']
}) => {
  const [value, setValue] = useState<FormValue>(initialValue)
  return (
    <CanopyCMSProvider>
      <FormRenderer
        fields={fields}
        value={value}
        onChange={setValue}
        customRenderers={customRenderers}
      />
      <pre data-testid="form-state">{JSON.stringify(value)}</pre>
    </CanopyCMSProvider>
  )
}

describe('FormRenderer', () => {
  it('updates multi-select fields when list=true', async () => {
    const user = userEvent.setup()
    const fields: FieldConfig[] = [
      { name: 'title', type: 'string', label: 'Title' },
      {
        name: 'tags',
        type: 'select',
        label: 'Tags',
        list: true,
        options: ['fast', 'typed', 'lambda'],
      },
    ]

    render(<StatefulForm fields={fields} initialValue={{ title: 'Hello', tags: [] }} />)

    const select = screen.getByLabelText('Tags', { selector: 'input' })
    await user.click(select)
    await user.click(screen.getByRole('option', { name: 'fast' }))
    await user.click(screen.getByRole('option', { name: 'typed' }))

    const state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
    expect(state.tags).toEqual(['fast', 'typed'])
  })

  it('adds and removes object list items', async () => {
    const user = userEvent.setup()
    const fields: FieldConfig[] = [
      {
        name: 'features',
        type: 'object',
        label: 'Features',
        list: true,
        fields: [
          { name: 'title', type: 'string', label: 'Title' },
          { name: 'description', type: 'string', label: 'Description' },
        ],
      },
    ]

    render(<StatefulForm fields={fields} initialValue={{ features: [] }} />)

    const addButton = screen.getByRole('button', { name: 'Add item' })
    await user.click(addButton)

    let state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
    expect(state.features).toHaveLength(1)

    const removeButton = screen.getByRole('button', { name: /remove/i })
    await user.click(removeButton)

    state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
    expect(state.features).toHaveLength(0)
  })

  it('propagates block field changes with path-aware custom renderers', async () => {
    const user = userEvent.setup()
    const fields: FieldConfig[] = [
      {
        name: 'blocks',
        type: 'block',
        templates: [
          {
            name: 'hero',
            label: 'Hero',
            fields: [{ name: 'headline', type: 'string', label: 'Headline' }],
          },
        ],
      },
    ]

    let lastPath: Array<string | number> | undefined

    render(
      <StatefulForm
        fields={fields}
        initialValue={{ blocks: [] }}
        customRenderers={{
          string: ({ field, value, onChange, path, id }) => {
            lastPath = path
            return (
              <TextField
                id={id}
                label={field.label ?? field.name}
                value={(value as string) ?? ''}
                onChange={(v) => onChange(v)}
              />
            )
          },
        }}
      />,
    )

    const addSelect = screen.getByPlaceholderText('Add block...')
    await user.click(addSelect)
    await user.click(screen.getByRole('option', { name: 'Hero' }))

    const headlineInput = screen.getByLabelText('Headline') as HTMLInputElement
    await user.type(headlineInput, 'Hello Blocks')

    const state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
    expect(state.blocks[0]?.value?.headline).toBe('Hello Blocks')
    expect(lastPath).toEqual(['blocks', 0, 'headline'])
  })

  describe('conflictNotice prop', () => {
    it('shows an informational notice when conflictNotice is true', () => {
      const fields: FieldConfig[] = [{ name: 'title', type: 'string', label: 'Title' }]
      render(
        <CanopyCMSProvider>
          <FormRenderer
            fields={fields}
            value={{ title: 'hello' }}
            onChange={() => {}}
            conflictNotice
          />
        </CanopyCMSProvider>,
      )
      expect(screen.getByText(/Someone else has recently changed this page/)).toBeTruthy()
    })

    it('does not show a conflict notice by default', () => {
      const fields: FieldConfig[] = [{ name: 'title', type: 'string', label: 'Title' }]
      render(
        <CanopyCMSProvider>
          <FormRenderer fields={fields} value={{ title: 'hello' }} onChange={() => {}} />
        </CanopyCMSProvider>,
      )
      expect(screen.queryByText(/Someone else has recently changed this page/)).toBeNull()
    })
  })

  describe('fieldErrors prop (ED-H1)', () => {
    const fields: FieldConfig[] = [
      { name: 'title', type: 'string', label: 'Title', required: true },
      {
        name: 'blocks',
        type: 'block',
        label: 'Blocks',
        templates: [
          { name: 'hero', label: 'Hero', fields: [{ name: 'headline', type: 'string' }] },
        ],
      },
    ]

    it('shows a summary alert and an inline message under the offending field', () => {
      render(
        <CanopyCMSProvider>
          <FormRenderer
            fields={fields}
            value={{ title: '' }}
            onChange={() => {}}
            fieldErrors={{ title: 'This field is required' }}
          />
        </CanopyCMSProvider>,
      )
      expect(screen.getByTestId('validation-alert')).toBeTruthy()
      expect(screen.getByText(/Fix these issues before saving/)).toBeTruthy()
      expect(screen.getByTestId('field-error-title').textContent).toBe('This field is required')
    })

    it('shows inline errors for block-nested field paths', () => {
      render(
        <CanopyCMSProvider>
          <FormRenderer
            fields={fields}
            value={{ title: 'ok', blocks: [{ template: 'hero', value: { headline: '' } }] }}
            onChange={() => {}}
            fieldErrors={{ 'blocks[0].headline': 'This field is required' }}
          />
        </CanopyCMSProvider>,
      )
      expect(screen.getByTestId('field-error-blocks[0].headline').textContent).toBe(
        'This field is required',
      )
    })

    it('renders no validation UI when there are no errors', () => {
      render(
        <CanopyCMSProvider>
          <FormRenderer fields={fields} value={{ title: 'ok' }} onChange={() => {}} />
        </CanopyCMSProvider>,
      )
      expect(screen.queryByTestId('validation-alert')).toBeNull()
      expect(screen.queryByTestId('field-error-title')).toBeNull()
    })

    it('keeps the same input DOM node across error/no-error transitions (no remount on fix)', () => {
      const { rerender } = render(
        <CanopyCMSProvider>
          <FormRenderer
            fields={fields}
            value={{ title: '' }}
            onChange={() => {}}
            fieldErrors={{ title: 'This field is required' }}
          />
        </CanopyCMSProvider>,
      )
      const inputWithError = screen.getByLabelText('Title') as HTMLInputElement
      expect(screen.getByTestId('field-error-title')).toBeTruthy()

      // Simulate the error clearing (e.g. user typed a character and the live
      // recompute effect in useDraftManager cleared the field error).
      rerender(
        <CanopyCMSProvider>
          <FormRenderer fields={fields} value={{ title: 'o' }} onChange={() => {}} />
        </CanopyCMSProvider>,
      )
      const inputWithoutError = screen.getByLabelText('Title') as HTMLInputElement
      expect(screen.queryByTestId('field-error-title')).toBeNull()
      expect(inputWithoutError).toBe(inputWithError)

      // And back again, in case the error reappears (e.g. a subsequent save attempt).
      rerender(
        <CanopyCMSProvider>
          <FormRenderer
            fields={fields}
            value={{ title: 'o' }}
            onChange={() => {}}
            fieldErrors={{ title: 'This field is required' }}
          />
        </CanopyCMSProvider>,
      )
      const inputWithErrorAgain = screen.getByLabelText('Title') as HTMLInputElement
      expect(screen.getByTestId('field-error-title')).toBeTruthy()
      expect(inputWithErrorAgain).toBe(inputWithError)
    })
  })
})
