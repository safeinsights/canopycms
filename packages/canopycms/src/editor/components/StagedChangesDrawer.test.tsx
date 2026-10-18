import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { modals } from '@mantine/modals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StagedChangesDrawer, type StagedChangesDrawerProps } from './StagedChangesDrawer'

// The confirm's buttons are Mantine's, so these tests capture its options and drive them
// directly; the real dialog is covered by e2e (permissions-groups.spec.ts).
vi.mock('@mantine/modals', () => ({
  modals: { openConfirmModal: vi.fn() },
}))

type ConfirmOptions = {
  onConfirm?: () => void
  onClose?: () => void
  onExitTransitionEnd?: () => void
  labels?: { confirm?: string; cancel?: string }
}
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
    size: 600,
    isDirty: false,
    isSaving: false,
    canEdit: true,
    saveLabel: 'Save groups',
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
      expect(screen.queryByRole('button', { name: 'Save groups' })).toBeNull()
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

  describe('header', () => {
    it('holds the title and Close button only', () => {
      renderDrawer()
      const dialog = screen.getByRole('dialog', { name: 'Groups' })
      expect(dialog.querySelector('.mantine-Drawer-header')?.textContent).toBe('Groups')
      expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    })

    it('keeps the unsaved badge beside the title, inside the dialog name', () => {
      renderDrawer({ isDirty: true })
      const header = screen
        .getByRole('dialog', { name: /Unsaved changes/ })
        .querySelector('.mantine-Drawer-header')
      expect(header?.textContent).toContain('Groups')
      expect(header?.textContent).toContain('Unsaved changes')
    })
  })

  describe('while dirty', () => {
    it('marks the title and shows the save bar', () => {
      const { props } = renderDrawer({ isDirty: true })
      expect(screen.getByRole('dialog', { name: /Unsaved changes/ })).toBeTruthy()
      expect(screen.getByText('Changes take effect only after you save.')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Save groups' }))
      expect(props.onSave).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
      expect(openConfirmModal).toHaveBeenCalledTimes(1)
    })

    it('hides the save bar from a viewer who cannot edit', () => {
      renderDrawer({ isDirty: true, canEdit: false })
      expect(screen.queryByRole('button', { name: 'Save groups' })).toBeNull()
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

    it('words the close confirm\'s red button as the action, "Discard changes"', () => {
      renderDrawer({ isDirty: true })
      pressEscape()
      expect(lastConfirm().labels).toEqual({ confirm: 'Discard changes', cancel: 'Keep editing' })
    })

    it('asks before the save bar discards, and discards only once confirmed, leaving the drawer open', () => {
      const { props } = renderDrawer({ isDirty: true })
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
      expect(openConfirmModal).toHaveBeenCalledTimes(1)
      expect(lastConfirm().labels).toEqual({ confirm: 'Discard changes', cancel: 'Keep editing' })
      expect(props.onDiscard).not.toHaveBeenCalled()

      act(() => lastConfirm().onConfirm?.())
      expect(props.onDiscard).toHaveBeenCalledTimes(1)
      expect(props.onClose).not.toHaveBeenCalled()
    })

    it('moves focus to the title once a confirmed save-bar discard takes the save bar away', () => {
      const { rerenderWith } = renderDrawer({ isDirty: true })
      const discard = screen.getByRole('button', { name: 'Discard changes' })
      discard.focus()
      fireEvent.click(discard)

      act(() => lastConfirm().onConfirm?.())
      rerenderWith({ isDirty: false })
      act(() => lastConfirm().onExitTransitionEnd?.())

      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Groups' }))
    })

    it('returns focus to the save bar\'s "Discard changes" when its confirm is dismissed', () => {
      renderDrawer({ isDirty: true })
      const discard = screen.getByRole('button', { name: 'Discard changes' })
      discard.focus()
      fireEvent.click(discard)
      ;(document.activeElement as HTMLElement | null)?.blur()

      act(() => lastConfirm().onClose?.())
      act(() => lastConfirm().onExitTransitionEnd?.())

      expect(document.activeElement).toBe(discard)
    })

    it('keeps the staged changes when the save bar discard is dismissed', () => {
      const { props } = renderDrawer({ isDirty: true })
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
      act(() => lastConfirm().onClose?.())
      expect(props.onDiscard).not.toHaveBeenCalled()
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

    it("disables the panel's controls while a save is in flight", () => {
      const { rerenderWith } = renderDrawer({
        isDirty: true,
        children: <button type="button">Remove member</button>,
      })
      const control = screen.getByRole('button', { name: 'Remove member' }) as HTMLButtonElement
      expect(control.matches(':disabled')).toBe(false)
      rerenderWith({
        isDirty: true,
        isSaving: true,
        children: <button type="button">Remove member</button>,
      })
      expect(control.matches(':disabled')).toBe(true)
    })

    it('ignores close while a save is in flight', () => {
      const { props } = renderDrawer({ isDirty: true, isSaving: true })
      pressEscape()
      expect(openConfirmModal).not.toHaveBeenCalled()
      expect(props.onClose).not.toHaveBeenCalled()
    })

    it("yields Escape to the panel's own modal", () => {
      const { props } = renderDrawer({ isDirty: true, childModalOpen: true })
      pressEscape()
      expect(openConfirmModal).not.toHaveBeenCalled()
      expect(props.onClose).not.toHaveBeenCalled()
    })
  })

  it('reports the end of the close transition through onExited', async () => {
    const onExited = vi.fn()
    const { rerenderWith } = renderDrawer({ onExited })
    expect(onExited).not.toHaveBeenCalled()
    rerenderWith({ opened: false, onExited })
    await waitFor(() => expect(onExited).toHaveBeenCalledTimes(1))
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
