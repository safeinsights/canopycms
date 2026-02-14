// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CollectionEditor, type ExistingCollection } from './CollectionEditor'
import { CanopyCMSProvider } from '../theme'
import { toLogicalPath } from '../../paths'

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
      } as MediaQueryList)) as typeof window.matchMedia
  }

  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserver
  }

  // Mock scrollIntoView for Mantine Combobox
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderCollectionEditor = (props: Partial<React.ComponentProps<typeof CollectionEditor>> = {}) => {
  const defaultProps: React.ComponentProps<typeof CollectionEditor> = {
    isOpen: true,
    editingCollection: null,
    availableSchemas: ['postSchema', 'pageSchema', 'authorSchema'],
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...props,
  }

  return {
    ...render(
      <CanopyCMSProvider>
        <CollectionEditor {...defaultProps} />
      </CanopyCMSProvider>
    ),
    props: defaultProps,
  }
}

describe('CollectionEditor', () => {
  describe('create mode', () => {
    it('renders create modal with empty form', () => {
      renderCollectionEditor()

      // Title appears in both modal header and button - use getAllByText
      const createCollectionTexts = screen.getAllByText('Create Collection')
      expect(createCollectionTexts.length).toBeGreaterThan(0)
      expect(screen.getByLabelText(/^Name/)).toBeTruthy()
      expect(screen.getByLabelText(/^Label/)).toBeTruthy()
      expect(screen.getByText(/No entry types defined/i)).toBeTruthy()
    })

    it('validates name is required', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor()

      // Try to save without name
      await user.click(screen.getByRole('button', { name: /Create Collection/i }))

      expect(screen.getByText(/Name is required/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('validates name format', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor()

      await user.type(screen.getByLabelText(/^Name/), 'Invalid Name!')
      await user.click(screen.getByRole('button', { name: /Create Collection/i }))

      expect(screen.getByText(/must start with a letter/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('validates at least one entry type is required', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor()

      await user.type(screen.getByLabelText(/^Name/), 'posts')
      await user.click(screen.getByRole('button', { name: /Create Collection/i }))

      expect(screen.getByText(/At least one entry type is required/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('opens entry type editor when clicking add entry type', async () => {
      const user = userEvent.setup()
      renderCollectionEditor()

      await user.click(screen.getByRole('button', { name: /Add Entry Type/i }))

      // Entry type modal should appear - there are now multiple "Add Entry Type" texts
      await waitFor(() => {
        const elements = screen.getAllByText(/Add Entry Type/i)
        expect(elements.length).toBeGreaterThan(1) // Title and button in nested modal
      })
    })

    it('shows parent path when provided', () => {
      renderCollectionEditor({ parentPath: toLogicalPath('blog') })

      expect(screen.getByText(/created inside/i)).toBeTruthy()
      expect(screen.getByText('blog')).toBeTruthy()
    })

    it('closes modal on cancel', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor()

      await user.click(screen.getByRole('button', { name: /Cancel/i }))

      expect(props.onClose).toHaveBeenCalled()
    })
  })

  describe('edit mode', () => {
    const existingCollection: ExistingCollection = {
      name: 'posts',
      label: 'Blog Posts',
      logicalPath: toLogicalPath('posts'),
      entries: [
        { name: 'post', label: 'Post', format: 'mdx', fields: 'postSchema', default: true },
        { name: 'featured', label: 'Featured', format: 'json', fields: 'postSchema' },
      ],
    }

    it('renders edit modal with existing data', () => {
      renderCollectionEditor({ editingCollection: existingCollection })

      expect(screen.getByText(/Edit Collection: posts/)).toBeTruthy()
      const nameInput = screen.getByLabelText(/^Name/) as HTMLInputElement
      expect(nameInput.value).toBe('posts')
      expect(nameInput.disabled).toBe(false) // Name field is now editable (it's just metadata)
      const labelInput = screen.getByLabelText(/^Label/) as HTMLInputElement
      expect(labelInput.value).toBe('Blog Posts')
    })

    it('displays existing entry types', () => {
      renderCollectionEditor({ editingCollection: existingCollection })

      expect(screen.getByText('post')).toBeTruthy()
      expect(screen.getByText('featured')).toBeTruthy()
      expect(screen.getByText('Default')).toBeTruthy() // Default badge
    })

    it('only includes changed fields in update', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor({ editingCollection: existingCollection })

      // Change only the label
      const labelInput = screen.getByLabelText(/^Label/)
      await user.clear(labelInput)
      await user.type(labelInput, 'Updated Posts')

      await user.click(screen.getByRole('button', { name: /Save Changes/i }))

      expect(props.onSave).toHaveBeenCalledWith(
        { label: 'Updated Posts' },
        false
      )
    })

    it('shows entry type count', () => {
      renderCollectionEditor({ editingCollection: existingCollection })

      // Both entry types should be visible
      expect(screen.getByText('post')).toBeTruthy()
      expect(screen.getByText('featured')).toBeTruthy()
    })

    it('shows singleton badge for single entry collection', () => {
      const singleEntryCollection: ExistingCollection = {
        name: 'settings',
        logicalPath: toLogicalPath('settings'),
        entries: [{ name: 'config', format: 'json', fields: 'postSchema', maxItems: 1 }],
      }

      renderCollectionEditor({ editingCollection: singleEntryCollection })

      expect(screen.getByText('config')).toBeTruthy()
      expect(screen.getByText('Singleton')).toBeTruthy()
    })
  })

  describe('error handling', () => {
    it('displays external error', () => {
      renderCollectionEditor({ error: 'Collection already exists' })

      expect(screen.getByText(/Collection already exists/)).toBeTruthy()
    })

    it('shows saving state', () => {
      renderCollectionEditor({ isSaving: true })

      const saveButton = screen.getByRole('button', { name: /Create Collection/i })
      expect(saveButton.getAttribute('data-loading')).toBe('true')
    })
  })
})
