import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'

import { fieldDescriptionId } from './FieldDescription'
import { FieldLabel, type FieldLabelProps } from './FieldLabel'

const renderLabel = (props: FieldLabelProps) =>
  render(
    <MantineProvider>
      <FieldLabel {...props} />
    </MantineProvider>,
  )

describe('FieldLabel', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders a <label for> when htmlFor is set', () => {
    renderLabel({ label: 'Title', htmlFor: 'title-input', labelId: 'title-label' })
    const label = screen.getByText('Title')
    expect(label.tagName).toBe('LABEL')
    expect(label.getAttribute('for')).toBe('title-input')
    expect(label.id).toBe('title-label')
  })

  it('renders a <div> without htmlFor', () => {
    renderLabel({ label: 'Group', labelId: 'group-label' })
    const label = screen.getByText('Group')
    expect(label.tagName).toBe('DIV')
    expect(label.getAttribute('for')).toBeNull()
    expect(label.id).toBe('group-label')
  })

  it('shows the required asterisk only when required', () => {
    const { container, rerender } = renderLabel({ label: 'Title', required: true })
    expect(container.textContent).toContain('*')

    rerender(
      <MantineProvider>
        <FieldLabel label="Title" />
      </MantineProvider>,
    )
    expect(container.textContent).not.toContain('*')
  })

  it('renders the description under the id fieldDescriptionId(baseId)', () => {
    renderLabel({ label: 'Title', description: 'Shown in the header', descriptionBaseId: 'base-1' })
    const description = screen.getByText('Shown in the header')
    expect(description.id).toBe(fieldDescriptionId('base-1'))
  })

  it('renders the action and comment-control slots', () => {
    renderLabel({
      label: 'Items',
      actions: <button type="button">Add item</button>,
      commentControl: <span data-testid="comment-slot">2</span>,
    })
    expect(screen.getByRole('button', { name: 'Add item' })).toBeDefined()
    expect(screen.getByTestId('comment-slot')).toBeDefined()
  })

  it('renders actions even when there is no label', () => {
    renderLabel({ actions: <button type="button">Remove</button> })
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined()
  })

  it('renders only the description when there is no label, comment control, or actions', () => {
    const { container } = renderLabel({
      description: 'Just guidance',
      descriptionBaseId: 'base-2',
    })
    expect(screen.getByText('Just guidance').id).toBe(fieldDescriptionId('base-2'))
    expect(container.querySelector('label, .mantine-Input-label')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('renders nothing at all with no props', () => {
    const { container } = renderLabel({})
    expect(container.querySelector('.mantine-Stack-root')).toBeNull()
    expect(container.querySelectorAll('*:not(style)')).toHaveLength(0)
  })
})
