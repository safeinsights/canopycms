/** Each Remove a form offers reports what it took out, so the editor can offer Undo. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { CanopyCMSProvider } from './theme'
import type { MockApiClient } from '../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from './hooks/__test__/test-utils'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, createApiClient: vi.fn() }
})

let mockClient: MockApiClient
beforeEach(async () => {
  mockClient = await setupMockApiClient()
})
afterEach(() => cleanup())

const renderForm = (fields: FieldConfig[], value: FormValue) => {
  const onRemoved = vi.fn()
  const onChange = vi.fn()
  const Wrapper = createApiClientWrapper(mockClient)
  render(
    <CanopyCMSProvider>
      <Wrapper>
        <FormRenderer fields={fields} value={value} onChange={onChange} onRemoved={onRemoved} />
      </Wrapper>
    </CanopyCMSProvider>,
  )
  return { onRemoved, onChange }
}

describe('FormRenderer removals', () => {
  it('reports a removed object-list item, as the same object, named by its content', () => {
    const second = { href: '/b' }
    const { onRemoved, onChange } = renderForm(
      [
        {
          name: 'links',
          type: 'object',
          label: 'Links',
          list: true,
          fields: [{ name: 'href', type: 'string' }],
        },
      ],
      { links: [{ href: '/a' }, second] },
    )
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Links #2' })).getByRole('button', {
        name: 'Remove',
      }),
    )
    expect(onChange).toHaveBeenCalledWith({ links: [{ href: '/a' }] })
    expect(onRemoved).toHaveBeenCalledWith({
      kind: 'list-item',
      listPath: ['links'],
      index: 1,
      item: second,
      label: '"/b" from Links',
    })
    expect(onRemoved.mock.calls[0][0].item).toBe(second)
  })

  it('reports a removed block with its template label', () => {
    const block = { template: 'hero', value: { heading: 'Hi' } }
    const { onRemoved } = renderForm(
      [
        {
          name: 'blocks',
          type: 'block',
          templates: [
            { name: 'hero', label: 'Hero', fields: [{ name: 'heading', type: 'string' }] },
          ],
        },
      ],
      { blocks: [block] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemoved).toHaveBeenCalledWith({
      kind: 'list-item',
      listPath: ['blocks'],
      index: 0,
      item: block,
      label: '"Hero" from blocks',
    })
  })

  it('reports a removed image with its value and the field label', () => {
    const image = { src: 'https://example.com/a.png', alt: 'A' }
    const { onRemoved } = renderForm([{ name: 'hero', type: 'image', label: 'Hero image' }], {
      hero: image,
    })
    fireEvent.click(screen.getByTestId('image-field-remove-hero'))
    expect(onRemoved).toHaveBeenCalledWith({
      kind: 'value',
      path: ['hero'],
      value: image,
      label: 'the image from Hero image',
    })
  })

  it('names an item with no text by its position, which the toast then states', () => {
    const { onRemoved } = renderForm(
      [
        {
          name: 'sizes',
          type: 'object',
          label: 'Sizes',
          list: true,
          fields: [{ name: 'width', type: 'number' }],
        },
      ],
      { sizes: [{ width: 1 }, { width: 2 }] },
    )
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Sizes #1' })).getByRole('button', {
        name: 'Remove',
      }),
    )
    expect(onRemoved.mock.calls[0][0].label).toBe('item 1 from Sizes')
  })

  it('shortens a long title in the label to 60 characters', () => {
    const long = 'x'.repeat(200)
    const { onRemoved } = renderForm(
      [
        {
          name: 'links',
          type: 'object',
          label: 'Links',
          list: true,
          fields: [{ name: 'href', type: 'string' }],
        },
      ],
      { links: [{ href: long }] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemoved.mock.calls[0][0].label).toBe(`"${'x'.repeat(59)}…" from Links`)
  })
})
