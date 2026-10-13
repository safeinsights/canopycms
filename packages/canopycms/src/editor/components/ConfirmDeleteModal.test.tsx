import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import { CanopyCMSProvider } from '../theme'

afterEach(cleanup)

const renderModal = (loading: boolean, onClose = vi.fn()) =>
  render(
    <CanopyCMSProvider>
      <ConfirmDeleteModal
        isOpen
        title="Delete entry"
        message="Delete it?"
        onConfirm={vi.fn()}
        onClose={onClose}
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

  it('ignores Escape while loading, and closes on it otherwise', () => {
    for (const loading of [true, false]) {
      const onClose = vi.fn()
      renderModal(loading, onClose)
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Delete entry' }), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(loading ? 0 : 1)
      cleanup()
    }
  })
})
