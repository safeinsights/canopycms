import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { modals } from '@mantine/modals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StagedChangesDrawer, type StagedChangesDrawerProps } from './StagedChangesDrawer'

// The confirm's buttons are Mantine's, so these tests capture its options and drive them
// directly; the real dialog is covered by e2e (permissions-groups.spec.ts).
vi.mock('@mantine/modals', () => ({
  modals: { openConfirmModal: vi.fn() },
}))

type ConfirmOptions = { onConfirm?: () => void; onClose?: () => void }
const openConfirmModal = vi.mocked(modals.openConfirmModal)
const lastConfirm = (): ConfirmOptions =>
  openConfirmModal.mock.calls[openConfirmModal.mock.calls.length - 1][0] as ConfirmOptions

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

function renderDrawer(overrides: Partial<StagedChangesDrawerProps> = {}) {
  const props: StagedChangesDrawerProps = {
    opened: true,
    onClose: vi.fn(),
    title: 'Groups',
    description: 'Manage groups',
    size: 600,
    isDirty: false,
    isSaving: false,
    canEdit: true,
    saveLabel: 'Save Groups',
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    children: <div>panel body</div>,
    ...overrides,
  }
  const view = render(<StagedChangesDrawer {...props} />, { wrapper })
  return {
    props,
    ...view,
    rerenderWith: (next: Partial<StagedChangesDrawerProps>) =>
      view.rerender(<StagedChangesDrawer {...props} {...next} />),
  }
}

const pressEscape = () => fireEvent.keyDown(document.body, { key: 'Escape' })

/** Fires a cancelable beforeunload and reports whether anything asked the browser to prompt. */
function beforeUnloadPrompts(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('StagedChangesDrawer', () => {
  beforeEach(() => {
    openConfirmModal.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  describe('while clean', () => {
    it('shows neither the unsaved marker nor the save bar', () => {
      renderDrawer()
      expect(screen.getByText('panel body')).toBeTruthy()
      expect(screen.queryByText('Unsaved changes')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Save Groups' })).toBeNull()
    })

    it('closes at once, without a confirm', () => {
      const { props } = renderDrawer()
      pressEscape()
      expect(props.onClose).toHaveBeenCalledTimes(1)
      expect(openConfirmModal).not.toHaveBeenCalled()
    })

    it('registers no beforeunload prompt', () => {
      renderDrawer()
      expect(beforeUnloadPrompts()).toBe(false)
    })
  })

  describe('while dirty', () => {
    it('marks the title and shows the save bar', () => {
      const { props } = renderDrawer({ isDirty: true })
      expect(screen.getByRole('dialog', { name: /Unsaved changes/ })).toBeTruthy()
      expect(screen.getByText('Changes take effect only after you save.')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Save Groups' }))
      expect(props.onSave).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }))
      expect(props.onDiscard).toHaveBeenCalledTimes(1)
    })

    it('hides the save bar from a viewer who cannot edit', () => {
      renderDrawer({ isDirty: true, canEdit: false })
      expect(screen.queryByRole('button', { name: 'Save Groups' })).toBeNull()
    })

    it('asks before closing, and closes only after a confirmed discard', () => {
      const { props } = renderDrawer({ isDirty: true })
      pressEscape()
      expect(openConfirmModal).toHaveBeenCalledTimes(1)
      expect(props.onClose).not.toHaveBeenCalled()

      act(() => lastConfirm().onConfirm?.())
      expect(props.onDiscard).toHaveBeenCalledTimes(1)
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })

    it('keeps the drawer and the changes when the confirm is dismissed', () => {
      const { props } = renderDrawer({ isDirty: true })
      pressEscape()
      act(() => lastConfirm().onClose?.())
      expect(props.onClose).not.toHaveBeenCalled()
      expect(props.onDiscard).not.toHaveBeenCalled()
    })

    it('yields Escape to its open confirm instead of stacking a second one', () => {
      renderDrawer({ isDirty: true })
      pressEscape()
      pressEscape()
      expect(openConfirmModal).toHaveBeenCalledTimes(1)

      act(() => lastConfirm().onClose?.())
      pressEscape()
      expect(openConfirmModal).toHaveBeenCalledTimes(2)
    })

    it("yields Escape to the panel's own modal", () => {
      const { props } = renderDrawer({ isDirty: true, childModalOpen: true })
      pressEscape()
      expect(openConfirmModal).not.toHaveBeenCalled()
      expect(props.onClose).not.toHaveBeenCalled()
    })
  })

  describe('beforeunload', () => {
    it('prompts only while dirty, and stops once the changes are saved or discarded', () => {
      const { rerenderWith } = renderDrawer({ isDirty: true })
      expect(beforeUnloadPrompts()).toBe(true)

      rerenderWith({ isDirty: false })
      expect(beforeUnloadPrompts()).toBe(false)
    })

    it('stops prompting on unmount', () => {
      const { unmount } = renderDrawer({ isDirty: true })
      unmount()
      expect(beforeUnloadPrompts()).toBe(false)
    })
  })
})
