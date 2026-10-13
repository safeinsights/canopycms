import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import { CanopyCMSProvider } from '../theme'

afterEach(cleanup)

const renderModal = (loading: boolean) =>
  render(
    <CanopyCMSProvider>
      <ConfirmDeleteModal
        isOpen
        title="Delete entry"
        message="Delete it?"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        loading={loading}
      />
    </CanopyCMSProvider>,
  )

describe('ConfirmDeleteModal', () => {
  it.each([
    [true, 'disables'],
    [false, 'enables'],
  ])('with loading %s, %s its close button with Cancel', (loading) => {
    renderModal(loading)
    const dialog = screen.getByRole('dialog', { name: 'Delete entry' })

    const close = within(dialog).getByRole('button', { name: 'Close' })
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    expect(close.hasAttribute('disabled')).toBe(loading)
    expect(cancel.hasAttribute('disabled')).toBe(loading)
  })
})
