import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import React, { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FieldConfig } from '../config'
import { primitiveFieldTypes } from '../config'
import { validateEntryData } from '../validation/entry-validator'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { TextField } from './fields/TextField'
import { CanopyCMSProvider } from './theme'
import type { MockApiClient } from '../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from './hooks/__test__/test-utils'

// Preload the chunk MarkdownField's React.lazy() imports (the 'markdown' and
// 'mdx' cases both render MarkdownField). Without this the mount assertion
// below also silently measures how long vitest takes to transform
// @mdxeditor/editor, which made it fail under full-suite contention while
// passing whenever this project ran alone. Static import puts the module in
// vitest's registry during THIS file's import phase, so React.lazy resolves
// from cache on the first microtask and the assertion measures only the
// product. See fields/MarkdownField.test.tsx, which does the same for the
// same reason.
import '@mdxeditor/editor'

// ImageField (the 'image' field case) reads the API client via context DI -
// mock the factory module so createApiClientWrapper's ApiClientProvider and
// useUserContext's internal createApiClient() calls agree on one instance.
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

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

  describe('object list item headings', () => {
    const listFields = (itemTitleField?: string): FieldConfig[] => [
      {
        name: 'features',
        type: 'object',
        label: 'Features',
        list: true,
        ...(itemTitleField ? { itemTitleField } : {}),
        fields: [
          { name: 'title', type: 'string', label: 'Heading' },
          { name: 'rank', type: 'number', label: 'Rank' },
        ],
      },
    ]

    it('shows the list label once, with numbered card headings and no nested legend', () => {
      render(<StatefulForm fields={listFields()} initialValue={{ features: [{}, {}] }} />)

      expect(screen.getAllByText('Features')).toHaveLength(1)
      expect(screen.getByText('Features #1')).toBeTruthy()
      expect(screen.getByText('Features #2')).toBeTruthy()
    })

    it('titles each card with its itemTitleField value, coercing numbers', () => {
      render(
        <StatefulForm
          fields={listFields('title')}
          initialValue={{ features: [{ title: 'Fast builds' }, { title: 7 }] }}
        />,
      )

      expect(screen.getByText('Fast builds')).toBeTruthy()
      expect(screen.getByText('7')).toBeTruthy()
      expect(screen.queryByText('Features #1')).toBeNull()
      expect(screen.getAllByText('Features')).toHaveLength(1)
    })

    it('falls back to the numbered heading when the title value is empty or not a primitive', () => {
      render(
        <StatefulForm
          fields={listFields('title')}
          initialValue={{ features: [{ title: '' }, { title: '   ' }, { title: { a: 1 } }, {}] }}
        />,
      )

      for (const n of [1, 2, 3, 4]) {
        expect(screen.getByText(`Features #${n}`)).toBeTruthy()
      }
    })

    // YAML's `.nan` and `.inf` parse to non-finite numbers, which must not title a card.
    it('falls back to the numbered heading for a non-finite number', () => {
      render(
        <StatefulForm
          fields={listFields('rank')}
          initialValue={{ features: [{ rank: Number.NaN }, { rank: Infinity }, { rank: 3 }] }}
        />,
      )

      expect(screen.getByText('Features #1')).toBeTruthy()
      expect(screen.getByText('Features #2')).toBeTruthy()
      expect(screen.getByText('3')).toBeTruthy()
    })

    it('updates the card heading as the title field is edited', async () => {
      const user = userEvent.setup()
      render(<StatefulForm fields={listFields('title')} initialValue={{ features: [{}] }} />)

      expect(screen.getByText('Features #1')).toBeTruthy()
      await user.type(screen.getByLabelText('Heading'), 'Typed')

      expect(screen.getByText('Typed')).toBeTruthy()
      expect(screen.queryByText('Features #1')).toBeNull()
    })

    it('gives each card an accessible name matching its heading', () => {
      render(
        <StatefulForm
          fields={listFields('title')}
          initialValue={{ features: [{ title: 'Fast builds' }, {}] }}
        />,
      )

      expect(screen.getByRole('group', { name: 'Fast builds' })).toBeTruthy()
      expect(screen.getByRole('group', { name: 'Features #2' })).toBeTruthy()
    })
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

  describe("'image' field type", () => {
    let mockClient: MockApiClient
    let wrapper: ReturnType<typeof createApiClientWrapper>

    beforeEach(async () => {
      mockClient = await setupMockApiClient()
      wrapper = createApiClientWrapper(mockClient)
    })

    it('renders ImageField, not the "Unsupported field" fallback', () => {
      const fields: FieldConfig[] = [{ name: 'hero', type: 'image', label: 'Hero image' }]
      const Wrapper = wrapper
      render(
        <CanopyCMSProvider>
          <Wrapper>
            <FormRenderer fields={fields} value={{}} onChange={() => {}} />
          </Wrapper>
        </CanopyCMSProvider>,
      )
      expect(screen.getByTestId('image-field-hero')).toBeTruthy()
      expect(screen.queryByText(/Unsupported field/)).toBeNull()
    })

    it('threads the aspect config through to ImageField (Crop button appears)', () => {
      const fields: FieldConfig[] = [
        { name: 'hero', type: 'image', label: 'Hero image', aspect: '16:9' },
      ]
      const Wrapper = wrapper
      render(
        <CanopyCMSProvider>
          <Wrapper>
            <FormRenderer
              fields={fields}
              value={{
                hero: {
                  src: '/assets/t/orig/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cat.png',
                  alt: 'Cat',
                },
              }}
              onChange={() => {}}
            />
          </Wrapper>
        </CanopyCMSProvider>,
      )
      expect(screen.getByTestId('image-field-crop-hero')).toBeTruthy()
    })

    it('wires <field>.alt sub-path fieldErrors onto the alt input', () => {
      const fields: FieldConfig[] = [{ name: 'hero', type: 'image', label: 'Hero image' }]
      const Wrapper = wrapper
      render(
        <CanopyCMSProvider>
          <Wrapper>
            <FormRenderer
              fields={fields}
              value={{
                hero: { src: '/assets/t/orig/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cat.png', alt: '' },
              }}
              onChange={() => {}}
              fieldErrors={{ 'hero.alt': 'Image alt text is required' }}
            />
          </Wrapper>
        </CanopyCMSProvider>,
      )
      expect(screen.getByText('Image alt text is required')).toBeTruthy()
    })
  })

  describe("'number' field type", () => {
    it('renders NumberField, not the "Unsupported field" fallback', () => {
      const fields: FieldConfig[] = [{ name: 'price', type: 'number', label: 'Price' }]
      render(
        <CanopyCMSProvider>
          <FormRenderer fields={fields} value={{}} onChange={() => {}} />
        </CanopyCMSProvider>,
      )
      expect(screen.getByLabelText('Price')).toBeTruthy()
      expect(screen.queryByText(/Unsupported field/)).toBeNull()
    })

    it('updates form state when edited, and the value survives a save round-trip', async () => {
      const user = userEvent.setup()
      const fields: FieldConfig[] = [{ name: 'price', type: 'number', label: 'Price' }]
      render(<StatefulForm fields={fields} initialValue={{ price: 5 }} />)

      const input = screen.getByLabelText('Price') as HTMLInputElement
      expect(input.value).toBe('5')
      await user.clear(input)
      await user.type(input, '42')

      const state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(state.price).toBe(42)
    })

    it('does not coerce an empty input to 0, and does not treat 0 as absent', async () => {
      const user = userEvent.setup()
      const fields: FieldConfig[] = [
        { name: 'count', type: 'number', label: 'Count', required: true },
      ]
      render(<StatefulForm fields={fields} initialValue={{}} />)

      const input = screen.getByLabelText('Count') as HTMLInputElement
      await user.type(input, '0')
      let state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(state.count).toBe(0)
      // 0 is a valid value for a required numeric field - not "empty".
      expect(validateEntryData(fields, state)).toEqual([])

      await user.clear(input)
      state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(state.count).toBeUndefined()
      // An emptied input must read as "missing", not silently become 0.
      expect(validateEntryData(fields, state)).toEqual([
        { fieldPath: 'count', message: 'This field is required' },
      ])
    })

    it('a required number field can be filled and saved (previously permanently unsaveable)', async () => {
      const user = userEvent.setup()
      const fields: FieldConfig[] = [
        { name: 'price', type: 'number', label: 'Price', required: true },
      ]
      render(<StatefulForm fields={fields} initialValue={{}} />)

      // Before any input, the required field correctly fails validation...
      expect(validateEntryData(fields, {})).not.toEqual([])

      // ...and the form actually provides a way to fill it in.
      const input = screen.getByLabelText('Price')
      await user.type(input, '19.99')

      const state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(validateEntryData(fields, state)).toEqual([])
    })

    it('handles the list: true variant like StringListField does for strings', () => {
      const fields: FieldConfig[] = [
        { name: 'scores', type: 'number', label: 'Scores', list: true },
      ]
      render(<StatefulForm fields={fields} initialValue={{ scores: [1, 2] }} />)

      // TagsInput-based list field, same DOM contract as StringListField.
      const input = document.querySelector('input[data-canopy-field="scores"]') as HTMLInputElement
      expect(input).toBeTruthy()
      expect(screen.getByText('1')).toBeTruthy()
      expect(screen.getByText('2')).toBeTruthy()

      fireEvent.change(input, { target: { value: '3' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      const state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(state.scores).toEqual([1, 2, 3])
    })

    it('customRenderers overrides the default control for a top-level number field', () => {
      const fields: FieldConfig[] = [{ name: 'price', type: 'number', label: 'Price' }]
      render(
        <StatefulForm
          fields={fields}
          initialValue={{ price: 5 }}
          customRenderers={{
            number: ({ value }) => <div data-testid="custom-number">{String(value)}</div>,
          }}
        />,
      )
      expect(screen.getByTestId('custom-number').textContent).toBe('5')
      expect(screen.queryByLabelText('Price')).toBeNull()
    })
  })

  describe("'datetime' field type", () => {
    it('renders a native datetime-local input, not the "Unsupported field" fallback', () => {
      const fields: FieldConfig[] = [
        { name: 'publishedAt', type: 'datetime', label: 'Published At' },
      ]
      render(
        <CanopyCMSProvider>
          <FormRenderer fields={fields} value={{}} onChange={() => {}} />
        </CanopyCMSProvider>,
      )
      const input = screen.getByLabelText('Published At') as HTMLInputElement
      expect(input.type).toBe('datetime-local')
      expect(screen.queryByText(/Unsupported field/)).toBeNull()
    })

    it('updates form state when edited, and the value survives a save round-trip', () => {
      const fields: FieldConfig[] = [
        { name: 'publishedAt', type: 'datetime', label: 'Published At' },
      ]
      render(<StatefulForm fields={fields} initialValue={{}} />)

      const input = screen.getByLabelText('Published At') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2024-06-15T04:30:00' } })

      // The expectation is DERIVED from the same local wall-clock the input
      // carries, never hardcoded. A datetime-local value is local time, so the
      // ISO string it converts to depends on the runner's timezone: hardcoding
      // one asserts the author's machine. The first version of this test did
      // exactly that and passed locally (UTC-6) while failing in CI's UTC by
      // precisely six hours -- which is also why a green local suite could not
      // catch it. `new Date(y, monthIndex, ...)` constructs in local time, so
      // this stays correct in every zone, including ones with a half-hour
      // offset or a DST boundary.
      const expectedIso = new Date(2024, 5, 15, 4, 30, 0).toISOString()

      const state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(state.publishedAt).toBe(expectedIso)
    })

    it('a required datetime field can be filled and saved (previously permanently unsaveable)', () => {
      const fields: FieldConfig[] = [
        { name: 'publishedAt', type: 'datetime', label: 'Published At', required: true },
      ]
      render(<StatefulForm fields={fields} initialValue={{}} />)

      expect(validateEntryData(fields, {})).not.toEqual([])

      const input = screen.getByLabelText('Published At') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2024-06-15T04:30:00' } })

      const state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(validateEntryData(fields, state)).toEqual([])
    })
  })

  // Retargeted from the since-removed 'rich-text' type, which was only ever an
  // alias for this one. Keeping the assertions here is deliberate: they are the
  // only direct coverage that the markdown editor renders through FormRenderer.
  describe("'markdown' field type", () => {
    let mockClient: MockApiClient
    let wrapper: ReturnType<typeof createApiClientWrapper>

    beforeEach(async () => {
      mockClient = await setupMockApiClient()
      wrapper = createApiClientWrapper(mockClient)
    })

    it('renders the markdown editor (same component as "mdx"), not the "Unsupported field" fallback', () => {
      const fields: FieldConfig[] = [{ name: 'body', type: 'markdown', label: 'Body' }]
      const Wrapper = wrapper
      render(
        <CanopyCMSProvider>
          <Wrapper>
            <FormRenderer
              fields={fields}
              value={{ body: 'Existing content' }}
              onChange={() => {}}
            />
          </Wrapper>
        </CanopyCMSProvider>,
      )
      // Synchronous first render, before the MDXEditor chunk loads: the
      // readonly fallback textarea shows the existing value (proving it
      // round-trips from storage into the form), never the "Unsupported
      // field" text.
      expect(screen.getByPlaceholderText('Loading markdown editor...')).toBeTruthy()
      expect(screen.getByDisplayValue('Existing content')).toBeTruthy()
      expect(screen.queryByText(/Unsupported field/)).toBeNull()
    })

    it('mounts a real, editable control once the editor chunk loads (not stuck on the readonly fallback)', async () => {
      const fields: FieldConfig[] = [{ name: 'body', type: 'markdown', label: 'Body' }]
      const Wrapper = wrapper
      render(
        <CanopyCMSProvider>
          <Wrapper>
            <FormRenderer fields={fields} value={{ body: '' }} onChange={() => {}} />
          </Wrapper>
        </CanopyCMSProvider>,
      )
      await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toBeTruthy())
    })

    it('a required markdown field can be filled and saved', () => {
      const fields: FieldConfig[] = [
        { name: 'body', type: 'markdown', label: 'Body', required: true },
      ]
      expect(validateEntryData(fields, {})).not.toEqual([])
      expect(validateEntryData(fields, { body: 'Hello world' })).toEqual([])
    })
  })

  describe("'object' field type", () => {
    const objectFields: FieldConfig[] = [
      {
        name: 'meta',
        type: 'object',
        label: 'Meta',
        fields: [{ name: 'label', type: 'string', label: 'Label', required: true }],
      },
    ]

    it('has no Clear affordance while the field is absent (nothing to clear)', () => {
      render(<StatefulForm fields={objectFields} initialValue={{}} />)
      expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    })

    it('a filled-then-cleared required child is recoverable via Clear, resetting to undefined (not {})', async () => {
      const user = userEvent.setup()
      render(<StatefulForm fields={objectFields} initialValue={{}} />)

      // Fill in the required nested child.
      const labelInput = screen.getByLabelText('Label')
      await user.type(labelInput, 'x')

      let state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(state.meta).toEqual({ label: 'x' })

      // The object now has a value, so the Clear affordance appears.
      const clearButton = screen.getByRole('button', { name: 'Clear' })

      // Change their mind and empty the child back out. The object is still
      // "present" ({ label: '' }), so entry-validator's required-child check
      // fires and, without Clear, there would be no way back to "not filled
      // in" (isEmptyForRequired only special-cases undefined/null for plain
      // objects, not their contents).
      await user.clear(labelInput)
      state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(state.meta).toEqual({ label: '' })
      expect(validateEntryData(objectFields, state)).toEqual([
        { fieldPath: 'meta.label', message: 'This field is required' },
      ])

      // Clear recovers by resetting the whole object field to undefined,
      // never to {} (which would still carry the required-but-empty child
      // straight back into validation).
      await user.click(clearButton)
      state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')
      expect(state.meta).toBeUndefined()
      expect(validateEntryData(objectFields, state)).toEqual([])
    })

    it('does not show Clear for a required object field, even when it has a value', () => {
      const requiredFields: FieldConfig[] = [
        {
          name: 'meta',
          type: 'object',
          label: 'Meta',
          required: true,
          fields: [{ name: 'label', type: 'string', label: 'Label' }],
        },
      ]
      render(<StatefulForm fields={requiredFields} initialValue={{ meta: { label: 'x' } }} />)
      expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    })

    it('gets its own comment affordance, and a nested child keeps its own (regression guard)', () => {
      // The original bug report claimed nested comment affordances were
      // broken too. They were not: children render through the same
      // recursive renderField path and already get FieldWrapper. What was
      // actually missing is an affordance for the object AS A WHOLE.
      render(
        <CanopyCMSProvider>
          <FormRenderer
            fields={objectFields}
            value={{}}
            onChange={() => {}}
            currentEntryPath="pages/home.md"
            currentUserId="user-1"
            onAddComment={vi.fn()}
            onResolveThread={vi.fn()}
          />
        </CanopyCMSProvider>,
      )
      expect(screen.getByTestId('field-new-comment-meta')).toBeTruthy()
      expect(screen.getByTestId('field-new-comment-meta.label')).toBeTruthy()
    })
  })

  describe('primitive field type coverage (config <-> renderer drift guard)', () => {
    let mockClient: MockApiClient
    let wrapper: ReturnType<typeof createApiClientWrapper>

    beforeEach(async () => {
      mockClient = await setupMockApiClient()
      wrapper = createApiClientWrapper(mockClient)
    })

    it('renders something other than the "Unsupported field" fallback for every primitiveFieldTypes entry', () => {
      // Guards against config/types.ts's primitiveFieldTypes and this
      // switch drifting apart again (the bug this file's new tests were
      // written for: number/datetime, and the since-removed rich-text, fell
      // through to the "Unsupported field" default, making required fields of
      // those types permanently unsaveable).
      const fields: FieldConfig[] = primitiveFieldTypes.map((type) => ({
        name: `field_${type.replace(/[^a-zA-Z0-9]/g, '_')}`,
        type,
        label: `Field ${type}`,
      }))
      const Wrapper = wrapper
      render(
        <CanopyCMSProvider>
          <Wrapper>
            <FormRenderer fields={fields} value={{}} onChange={() => {}} />
          </Wrapper>
        </CanopyCMSProvider>,
      )
      expect(screen.queryByText(/Unsupported field/)).toBeNull()
    })
  })

  describe('field descriptions', () => {
    const DESCRIPTION = 'Guidance for the editor'
    let mockClient: MockApiClient
    let wrapper: ReturnType<typeof createApiClientWrapper>

    beforeEach(async () => {
      mockClient = await setupMockApiClient()
      wrapper = createApiClientWrapper(mockClient)
    })

    const renderFields = (fields: FieldConfig[], initialValue: FormValue = {}) => {
      const Wrapper = wrapper
      return render(
        <Wrapper>
          <StatefulForm fields={fields} initialValue={initialValue} />
        </Wrapper>,
      )
    }

    const describedBy = (id: string): HTMLElement[] =>
      Array.from(document.querySelectorAll('[aria-describedby]')).filter((el) =>
        (el.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(id),
      ) as HTMLElement[]

    /**
     * The description text is rendered once, has an id, and exactly one element points
     * at that id through `aria-describedby`: the input itself for Mantine-native fields,
     * the field's group container for custom ones.
     */
    const expectDescribed = (kind: 'input' | 'group', text: string = DESCRIPTION): HTMLElement => {
      const node = screen.getByText(text)
      expect(node.id).toMatch(/-description$/)
      const owners = describedBy(node.id)
      expect(owners).toHaveLength(1)
      const owner = owners[0]
      if (kind === 'input') {
        expect(['INPUT', 'TEXTAREA']).toContain(owner.tagName)
      } else {
        expect(owner.getAttribute('role')).toBe('group')
      }
      return owner
    }

    const described = (field: FieldConfig): FieldConfig[] => [
      { ...field, description: DESCRIPTION },
    ]

    it('string', () => {
      renderFields(described({ name: 'title', type: 'string', label: 'Title' }))
      expect(expectDescribed('input')).toBe(screen.getByLabelText('Title'))
    })

    it('string list', () => {
      renderFields(described({ name: 'tags', type: 'string', label: 'Tags', list: true }))
      expectDescribed('input')
    })

    it('boolean', () => {
      renderFields(described({ name: 'flag', type: 'boolean', label: 'Flag' }))
      expect(expectDescribed('input')).toBe(screen.getByRole('switch'))
    })

    it('number', () => {
      renderFields(described({ name: 'price', type: 'number', label: 'Price' }))
      expect(expectDescribed('input')).toBe(screen.getByLabelText('Price'))
    })

    it('number list', () => {
      renderFields(described({ name: 'scores', type: 'number', label: 'Scores', list: true }))
      expectDescribed('input')
    })

    it('datetime', () => {
      renderFields(described({ name: 'publishedAt', type: 'datetime', label: 'Published At' }))
      expect(expectDescribed('input')).toBe(screen.getByLabelText('Published At'))
    })

    it('markdown', () => {
      renderFields(described({ name: 'body', type: 'markdown', label: 'Body' }))
      expectDescribed('group')
    })

    it('mdx', () => {
      renderFields(described({ name: 'body', type: 'mdx', label: 'Body' }))
      expectDescribed('group')
    })

    it('select', () => {
      renderFields(described({ name: 'kind', type: 'select', label: 'Kind', options: ['a', 'b'] }))
      expectDescribed('input')
    })

    it('select multi', () => {
      renderFields(
        described({
          name: 'kinds',
          type: 'select',
          label: 'Kinds',
          list: true,
          options: ['a', 'b'],
        }),
      )
      expectDescribed('input')
    })

    it('reference', () => {
      renderFields(
        described({
          name: 'author',
          type: 'reference',
          label: 'Author',
          options: [{ value: 'id1', label: 'Alice' }],
        }),
      )
      expectDescribed('input')
    })

    it('reference while options load', () => {
      mockClient.content.getReferenceOptions.mockReturnValue(new Promise(() => {}))
      renderFields(
        described({ name: 'author', type: 'reference', label: 'Author', collections: ['people'] }),
      )
      expect(screen.getByTestId('reference-loading-author')).toBeTruthy()
      expect(screen.getByText(DESCRIPTION).id).toMatch(/-description$/)
    })

    it('reference after options fail to load', async () => {
      mockClient.content.getReferenceOptions.mockResolvedValue({
        ok: false,
        status: 500,
        error: 'boom',
      })
      renderFields(
        described({ name: 'author', type: 'reference', label: 'Author', collections: ['people'] }),
      )
      await screen.findByTestId('reference-error-author')
      expect(screen.getByText(DESCRIPTION).id).toMatch(/-description$/)
    })

    it('image', () => {
      renderFields(described({ name: 'hero', type: 'image', label: 'Hero image' }))
      expect(expectDescribed('group')).toBe(screen.getByTestId('image-field-hero'))
    })

    it('block', () => {
      renderFields(described({ name: 'blocks', type: 'block', label: 'Blocks', templates: [] }))
      expectDescribed('group')
    })

    it('object', () => {
      renderFields(
        described({
          name: 'meta',
          type: 'object',
          label: 'Meta',
          fields: [{ name: 'label', type: 'string', label: 'Label' }],
        }),
      )
      expectDescribed('group')
    })

    it('object without a label still renders its description', () => {
      renderFields(
        described({
          name: 'meta',
          type: 'object',
          fields: [{ name: 'label', type: 'string', label: 'Label' }],
        }),
      )
      expectDescribed('group')
    })

    it('object list', () => {
      renderFields(
        described({
          name: 'features',
          type: 'object',
          label: 'Features',
          list: true,
          fields: [{ name: 'title', type: 'string', label: 'Heading' }],
        }),
        { features: [] },
      )
      expectDescribed('group')
    })

    it('object list renders its description once, not per item', () => {
      renderFields(
        described({
          name: 'features',
          type: 'object',
          label: 'Features',
          list: true,
          itemTitleField: 'title',
          fields: [{ name: 'title', type: 'string', label: 'Heading' }],
        }),
        { features: [{ title: 'First' }, { title: 'Second' }] },
      )
      expect(screen.getAllByText(DESCRIPTION)).toHaveLength(1)
      const list = expectDescribed('group')
      expect(list.contains(screen.getByRole('group', { name: 'First' }))).toBe(true)
      expect(screen.getByRole('group', { name: 'First' }).hasAttribute('aria-describedby')).toBe(
        false,
      )
    })

    it('code', () => {
      renderFields(described({ name: 'snippet', type: 'code', label: 'Snippet' }))
      expect(expectDescribed('input')).toBe(screen.getByLabelText('Snippet'))
    })

    it.each([undefined, ''])('a string field with description %j renders no description', (d) => {
      renderFields([{ name: 'title', type: 'string', label: 'Title', description: d }])
      expect(document.querySelector('[id$="-description"]')).toBeNull()
      expect(screen.getByLabelText('Title').hasAttribute('aria-describedby')).toBe(false)
    })

    it.each([undefined, ''])('an object field with description %j renders no description', (d) => {
      renderFields(
        [
          {
            name: 'meta',
            type: 'object',
            label: 'Meta',
            description: d,
            fields: [{ name: 'label', type: 'string', label: 'Label' }],
          },
        ],
        { meta: {} },
      )
      expect(document.querySelector('[id$="-description"]')).toBeNull()
      expect(document.querySelector('[aria-describedby]')).toBeNull()
      expect(document.querySelector('[role="group"]')).toBeNull()
    })

    it('a markdown field without a description renders no description', () => {
      renderFields([{ name: 'body', type: 'markdown', label: 'Body' }])
      expect(document.querySelector('[id$="-description"]')).toBeNull()
      expect(document.querySelector('[aria-describedby]')).toBeNull()
    })
  })
})
