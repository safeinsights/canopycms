import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { RenameEntryModal } from './RenameEntryModal'

afterEach(() => {
  cleanup()
})

const slugInput = () => screen.getByTestId('rename-slug-input') as HTMLInputElement
const submitButton = () => screen.getByTestId('rename-entry-submit') as HTMLButtonElement

const renderModal = (extra: Partial<React.ComponentProps<typeof RenameEntryModal>> = {}) => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(
    <MantineProvider>
      <RenameEntryModal
        isOpen
        entryLabel="Hello World"
        currentSlug="hello-world"
        onSave={onSave}
        onClose={onClose}
        {...extra}
      />
    </MantineProvider>,
  )
  return { onSave, onClose }
}

describe('RenameEntryModal', () => {
  it('is titled "Change URL" and starts from the current slug', async () => {
    renderModal()

    expect(screen.getByRole('dialog', { name: 'Change URL' })).toBeTruthy()
    expect(submitButton().textContent).toBe('Change URL')
    expect(slugInput().value).toBe('hello-world')
    await waitFor(() => expect(document.activeElement).toBe(slugInput()))
  })

  it("says the entry's name comes from its title field, which it names when it can", () => {
    renderModal({ titleFieldLabel: 'Hero › Heading' })
    expect(screen.getByTestId('change-url-help').textContent).toBe(
      'This changes the URL and file name of “Hello World”, not its name, which comes from its “Hero › Heading” field. Edit that field in the form to change the name.',
    )

    cleanup()
    renderModal()
    expect(screen.getByTestId('change-url-help').textContent).toContain(
      'not its name, which comes from its title field.',
    )
  })

  it.each([
    ['an error in red', { error: 'Not renamed.' }, 'red', 'Not renamed.'],
    [
      'an unknown outcome in yellow',
      { warning: 'May have gone through.' },
      'yellow',
      'May have gone through.',
    ],
  ])('shows %s', (_, props, colour, text) => {
    renderModal(props)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(text)
    expect(alert.getAttribute('style')).toContain(colour)
  })

  it('does not offer Change URL until the slug changes', () => {
    renderModal()

    expect(submitButton().disabled).toBe(true)
  })

  it('shows the URL path from previewPath, else the slug format', async () => {
    const user = userEvent.setup()
    renderModal({ previewPath: (slug) => `/posts/${slug}` })

    expect(screen.getByText('URL path: /posts/hello-world')).toBeTruthy()

    await user.type(slugInput(), '-2')
    expect(screen.getByText('URL path: /posts/hello-world-2')).toBeTruthy()
  })

  it('describes the slug format when the entry has no page', () => {
    renderModal({ previewPath: () => undefined })

    expect(screen.getByText('Lowercase letters, numbers and hyphens')).toBeTruthy()
  })

  it('uses the shared slug messages', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.clear(slugInput())
    expect(await screen.findByText('Enter a slug')).toBeTruthy()

    await user.type(slugInput(), 'Hello')
    expect(await screen.findByText('Use lowercase letters')).toBeTruthy()

    await user.clear(slugInput())
    await user.type(slugInput(), 'a/b')
    expect(await screen.findByText(/path separators/)).toBeTruthy()
  })

  it('blocks a slug another entry already holds', async () => {
    const user = userEvent.setup()
    const { onSave } = renderModal({ existingSlugs: new Set(['hello-world', 'taken']) })

    await user.clear(slugInput())
    await user.type(slugInput(), 'taken')

    expect(await screen.findByText('An entry with this slug already exists')).toBeTruthy()
    await user.click(submitButton())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does not call the entry’s own current slug a duplicate', async () => {
    const user = userEvent.setup()
    renderModal({ existingSlugs: new Set(['hello-world']) })

    await user.type(slugInput(), 'x')
    await user.type(slugInput(), '{Backspace}')

    expect(slugInput().value).toBe('hello-world')
    expect(screen.queryByText('An entry with this slug already exists')).toBeNull()
  })

  it('saves the new slug with the Change URL button', async () => {
    const user = userEvent.setup()
    const { onSave } = renderModal()

    await user.type(slugInput(), '-2')
    await user.click(submitButton())

    expect(onSave).toHaveBeenCalledWith('hello-world-2')
  })

  it('saves with Enter', async () => {
    const user = userEvent.setup()
    const { onSave } = renderModal()

    await user.type(slugInput(), '-2{Enter}')

    expect(onSave).toHaveBeenCalledWith('hello-world-2')
  })

  it('does not save an invalid slug with Enter', async () => {
    const user = userEvent.setup()
    const { onSave } = renderModal()

    await user.clear(slugInput())
    await user.type(slugInput(), 'Bad{Enter}')

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('Use lowercase letters')).toBeTruthy()
  })
})
