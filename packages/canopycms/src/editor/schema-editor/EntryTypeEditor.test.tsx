// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EntryTypeEditor } from './EntryTypeEditor'
import { CanopyCMSProvider } from '../theme'

// Setup browser APIs
beforeAll(() => {
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
      ResizeObserver
  }

  // Mock scrollIntoView for Mantine Combobox
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderEntryTypeEditor = (
  props: Partial<React.ComponentProps<typeof EntryTypeEditor>> = {},
) => {
  const defaultProps: React.ComponentProps<typeof EntryTypeEditor> = {
    isOpen: true,
    editingEntryType: null,
    availableSchemas: ['postSchema', 'pageSchema', 'authorSchema'],
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...props,
  }

  return {
    ...render(
      <CanopyCMSProvider>
        <EntryTypeEditor {...defaultProps} />
      </CanopyCMSProvider>,
    ),
    props: defaultProps,
  }
}

describe('EntryTypeEditor', () => {
  describe('create mode', () => {
    it('renders create modal with empty form', () => {
      renderEntryTypeEditor()

      // Use getAllByText since "Add Entry Type" appears in both title and button
      const addEntryTypeElements = screen.getAllByText('Add Entry Type')
      expect(addEntryTypeElements.length).toBeGreaterThan(0)
      expect(screen.getByLabelText(/^Name/)).toBeTruthy()
      expect(screen.getByLabelText(/^Label/)).toBeTruthy()
    })

    it('validates name is required', async () => {
      const user = userEvent.setup()
      const { props } = renderEntryTypeEditor()

      // Click the submit button (use getAllBy since title and button have same text)
      const buttons = screen.getAllByRole('button', { name: /Add Entry Type/i })
      await user.click(buttons[0])

      expect(screen.getByText(/Name is required/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('validates name format', async () => {
      const user = userEvent.setup()
      const { props } = renderEntryTypeEditor()

      await user.type(screen.getByLabelText(/^Name/), 'Invalid Name!')
      const buttons = screen.getAllByRole('button', { name: /Add Entry Type/i })
      await user.click(buttons[0])

      expect(screen.getByText(/must start with a letter/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('closes modal on cancel', async () => {
      const user = userEvent.setup()
      const { props } = renderEntryTypeEditor()

      await user.click(screen.getByRole('button', { name: /Cancel/i }))

      expect(props.onClose).toHaveBeenCalled()
    })

    it('validates against duplicate entry type names', async () => {
      const user = userEvent.setup()
      const { props } = renderEntryTypeEditor({
        existingEntryTypeNames: ['post', 'page', 'article'],
      })

      await user.type(screen.getByLabelText(/^Name/), 'post') // Duplicate name
      const buttons = screen.getAllByRole('button', { name: /Add Entry Type/i })
      await user.click(buttons[0])

      expect(screen.getByText(/already exists in this collection/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('allows name that does not duplicate existing entry types', async () => {
      const user = userEvent.setup()
      const { props } = renderEntryTypeEditor({
        existingEntryTypeNames: ['post', 'page'],
      })

      await user.type(screen.getByLabelText(/^Name/), 'article') // Not a duplicate
      const buttons = screen.getAllByRole('button', { name: /Add Entry Type/i })
      await user.click(buttons[0])

      expect(props.onSave).toHaveBeenCalled()
    })
  })

  describe('edit mode', () => {
    const existingEntryType = {
      name: 'post',
      label: 'Blog Post',
      format: 'mdx' as const,
      schema: 'postSchema',
      default: true,
      maxItems: 10,
    }

    it('renders edit modal with existing data', () => {
      renderEntryTypeEditor({ editingEntryType: existingEntryType })

      expect(screen.getByText(/Edit Entry Type: post/)).toBeTruthy()
      const nameInput = screen.getByLabelText(/^Name/) as HTMLInputElement
      expect(nameInput.value).toBe('post')
      expect(nameInput.disabled).toBe(true)
      const labelInput = screen.getByLabelText(/^Label/) as HTMLInputElement
      expect(labelInput.value).toBe('Blog Post')
    })

    it('only includes changed fields in update', async () => {
      const user = userEvent.setup()
      const { props } = renderEntryTypeEditor({
        editingEntryType: existingEntryType,
      })

      // Change only the label
      const labelInput = screen.getByLabelText(/^Label/)
      await user.clear(labelInput)
      await user.type(labelInput, 'Updated Post')

      await user.click(screen.getByRole('button', { name: /Save Changes/i }))

      expect(props.onSave).toHaveBeenCalledWith({ label: 'Updated Post' }, false)
    })
  })

  describe('error handling', () => {
    it('displays external error', () => {
      renderEntryTypeEditor({ error: 'Entry type already exists' })

      expect(screen.getByText(/Entry type already exists/)).toBeTruthy()
    })

    it('shows saving state', () => {
      renderEntryTypeEditor({ isSaving: true })

      const saveButtons = screen.getAllByRole('button', {
        name: /Add Entry Type/i,
      })
      expect(saveButtons[0].getAttribute('data-loading')).toBe('true')
    })
  })

  describe('form defaults', () => {
    it('uses first available schema as default', () => {
      renderEntryTypeEditor({ availableSchemas: ['mySchema', 'otherSchema'] })

      // The schema input should have the first schema pre-selected
      const schemaInput = screen.getByRole('textbox', {
        name: /Schema/,
      }) as HTMLInputElement
      expect(schemaInput.value).toBe('mySchema')
    })

    it('defaults format to json', () => {
      renderEntryTypeEditor()

      // Format select should show JSON as selected
      const formatInput = screen.getByRole('textbox', {
        name: /Format/,
      }) as HTMLInputElement
      expect(formatInput.value).toBe('JSON')
    })
  })
})
