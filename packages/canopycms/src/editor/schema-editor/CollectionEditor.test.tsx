// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CollectionEditor, type ExistingCollection } from './CollectionEditor'
import type { SchemaOpResult } from '../hooks/useSchemaManager'
import { CanopyCMSProvider } from '../theme'
import { unsafeAsLogicalPath } from '../../paths/test-utils'

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

const renderCollectionEditor = (
  props: Partial<React.ComponentProps<typeof CollectionEditor>> = {},
) => {
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
      </CanopyCMSProvider>,
    ),
    props: defaultProps,
  }
}

// The dismiss button is found inside the footer so the modal's own close (X) can't satisfy it.
const footer = () => within(screen.getByTestId('collection-editor-footer'))
const footerButton = (name: string) => footer().getByRole('button', { name })
const dismissLabel = () => {
  const names = footer()
    .getAllByRole('button')
    .map((b) => b.textContent)
  return names.filter((n) => n === 'Cancel' || n === 'Close')
}

const ok: SchemaOpResult = { ok: true }

const entryTypeDialog = async (name: string) => screen.findByRole('dialog', { name })

const addEntryTypeViaUi = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name: 'Add entry type…' }))
  const dialog = await entryTypeDialog('Add entry type')
  await user.type(within(dialog).getByLabelText(/^Name/), name)
  await user.click(within(dialog).getByRole('button', { name: 'Add entry type' }))
}

const openRowMenu = async (user: ReturnType<typeof userEvent.setup>, rowName: string) => {
  await user.click(screen.getByRole('button', { name: `Actions for ${rowName}` }))
}

const editEntryTypeLabelViaUi = async (
  user: ReturnType<typeof userEvent.setup>,
  rowName: string,
  label: string,
) => {
  await openRowMenu(user, rowName)
  await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
  const dialog = await entryTypeDialog(`Edit entry type: ${rowName}`)
  const labelInput = within(dialog).getByLabelText(/^Label/)
  await user.clear(labelInput)
  await user.type(labelInput, label)
  await user.click(within(dialog).getByRole('button', { name: 'Save entry type' }))
}

const removeEntryTypeViaUi = async (user: ReturnType<typeof userEvent.setup>, rowName: string) => {
  await openRowMenu(user, rowName)
  await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
  const confirm = await screen.findByTestId('confirm-delete-modal')
  await user.click(within(confirm).getByRole('button', { name: 'Remove entry type' }))
}

describe('CollectionEditor', () => {
  describe('create mode', () => {
    it('renders create modal with empty form', () => {
      renderCollectionEditor()

      // Title appears in both modal header and button - use getAllByText
      const createCollectionTexts = screen.getAllByText('Create collection')
      expect(createCollectionTexts.length).toBeGreaterThan(0)
      expect(screen.getByLabelText(/^Name/)).toBeTruthy()
      expect(screen.getByLabelText(/^Label/)).toBeTruthy()
      expect(screen.getByText(/No entry types yet/i)).toBeTruthy()
    })

    it('validates name is required', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor()

      // Try to save without name
      await user.click(screen.getByRole('button', { name: /Create collection/i }))

      expect(screen.getByText(/Name is required/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('validates name format', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor()

      await user.type(screen.getByLabelText(/^Name/), 'Invalid Name!')
      await user.click(screen.getByRole('button', { name: /Create collection/i }))

      expect(screen.getByText(/must start with a letter/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('validates at least one entry type is required', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor()

      await user.type(screen.getByLabelText(/^Name/), 'posts')
      await user.click(screen.getByRole('button', { name: /Create collection/i }))

      expect(screen.getByText(/At least one entry type is required/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('opens entry type editor when clicking add entry type', async () => {
      const user = userEvent.setup()
      renderCollectionEditor()

      await user.click(screen.getByRole('button', { name: /Add entry type/i }))

      // Entry type modal should appear - there are now multiple "Add Entry Type" texts
      await waitFor(() => {
        const elements = screen.getAllByText(/Add entry type/i)
        expect(elements.length).toBeGreaterThan(1) // Title and button in nested modal
      })
    })

    it('shows parent path when provided', () => {
      renderCollectionEditor({ parentPath: unsafeAsLogicalPath('blog') })

      expect(screen.getByText(/created inside/i)).toBeTruthy()
      expect(screen.getByText('blog')).toBeTruthy()
    })

    it('closes modal on cancel', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor()

      await user.click(footerButton('Cancel'))

      expect(props.onClose).toHaveBeenCalled()
    })
  })

  describe('edit mode', () => {
    const existingCollection: ExistingCollection = {
      name: 'posts',
      label: 'Blog Posts',
      logicalPath: unsafeAsLogicalPath('posts'),
      entries: [
        {
          name: 'post',
          label: 'Post',
          format: 'mdx',
          schema: 'postSchema',
          default: true,
        },
        {
          name: 'featured',
          label: 'Featured',
          format: 'json',
          schema: 'postSchema',
        },
      ],
    }

    it('renders edit modal with existing data', () => {
      renderCollectionEditor({ editingCollection: existingCollection })

      expect(screen.getByText(/Edit collection: posts/)).toBeTruthy()
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
      const { props } = renderCollectionEditor({
        editingCollection: existingCollection,
      })

      // Change only the label
      const labelInput = screen.getByLabelText(/^Label/)
      await user.clear(labelInput)
      await user.type(labelInput, 'Updated Posts')

      await user.click(screen.getByRole('button', { name: /Save collection details/i }))

      expect(props.onSave).toHaveBeenCalledWith({ label: 'Updated Posts' }, false)
    })

    it('validates name format in edit mode (UI-M3)', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor({
        editingCollection: existingCollection,
      })

      // Change the name to an unsafe value (uppercase + space + dot)
      const nameInput = screen.getByLabelText(/^Name/)
      await user.clear(nameInput)
      await user.type(nameInput, 'Bad Name.evil')

      await user.click(screen.getByRole('button', { name: /Save collection details/i }))

      expect(screen.getByText(/must start with a letter/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('rejects a name with path traversal in edit mode (UI-M3)', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor({
        editingCollection: existingCollection,
      })

      const nameInput = screen.getByLabelText(/^Name/)
      await user.clear(nameInput)
      await user.type(nameInput, '../evil')

      await user.click(screen.getByRole('button', { name: /Save collection details/i }))

      expect(screen.getByText(/must start with a letter/i)).toBeTruthy()
      expect(props.onSave).not.toHaveBeenCalled()
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
        logicalPath: unsafeAsLogicalPath('settings'),
        entries: [{ name: 'config', format: 'json', schema: 'postSchema', maxItems: 1 }],
      }

      renderCollectionEditor({ editingCollection: singleEntryCollection })

      expect(screen.getByText('config')).toBeTruthy()
      expect(screen.getByText('Singleton')).toBeTruthy()
    })
  })

  describe('removing the only entry type', () => {
    it('keeps Remove focusable and says what to do first', async () => {
      const user = userEvent.setup()
      const onlyOne: ExistingCollection = {
        name: 'settings',
        logicalPath: unsafeAsLogicalPath('settings'),
        entries: [{ name: 'config', format: 'json', schema: 'postSchema', maxItems: 1 }],
      }
      const { container } = renderCollectionEditor({ editingCollection: onlyOne })
      const menuButton = container.ownerDocument.querySelector(
        '.mantine-Modal-body .mantine-ActionIcon-root',
      ) as HTMLElement
      await user.click(menuButton)

      const remove = await screen.findByRole('menuitem', { name: /^Remove/ })
      expect(remove.getAttribute('aria-disabled')).toBe('true')
      expect(remove.textContent).toContain(
        'A collection needs at least one entry type. Add another before removing this one.',
      )
    })
  })

  describe('error handling', () => {
    it('displays external error', () => {
      renderCollectionEditor({ error: 'Collection already exists' })

      expect(screen.getByText(/Collection already exists/)).toBeTruthy()
    })

    it('shows saving state', () => {
      renderCollectionEditor({ isSaving: true })

      const saveButton = screen.getByRole('button', {
        name: /Create collection/i,
      })
      expect(saveButton.getAttribute('data-loading')).toBe('true')
    })
  })

  describe('Cancel and Close', () => {
    const collection: ExistingCollection = {
      name: 'posts',
      label: 'Blog Posts',
      logicalPath: unsafeAsLogicalPath('posts'),
      entries: [
        { name: 'post', label: 'Post', format: 'mdx', schema: 'postSchema', default: true },
        { name: 'featured', label: 'Featured', format: 'json', schema: 'postSchema' },
      ],
    }

    const editProps = () => ({
      editingCollection: collection,
      onAddEntryType: vi.fn().mockResolvedValue(ok),
      onUpdateEntryType: vi.fn().mockResolvedValue(ok),
      onRemoveEntryType: vi.fn().mockResolvedValue(ok),
    })

    it('create mode: discards staged entry types on Cancel without calling any API', async () => {
      const user = userEvent.setup()
      const onAddEntryType = vi.fn()
      const { props } = renderCollectionEditor({ onAddEntryType })

      await addEntryTypeViaUi(user, 'article')
      expect(await screen.findByText('article')).toBeTruthy()
      expect(dismissLabel()).toEqual(['Cancel'])

      await user.click(footerButton('Cancel'))

      expect(props.onClose).toHaveBeenCalledTimes(1)
      expect(props.onSave).not.toHaveBeenCalled()
      expect(onAddEntryType).not.toHaveBeenCalled()
    })

    it('edit mode: reads Cancel until something saved, and Cancel only closes', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      expect(dismissLabel()).toEqual(['Cancel'])
      await user.click(footerButton('Cancel'))

      expect(props.onClose).toHaveBeenCalledTimes(1)
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('edit mode: an added entry type shows in the list and turns Cancel into Close', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      await addEntryTypeViaUi(user, 'article')

      expect(await screen.findByText('article')).toBeTruthy()
      expect(screen.getByRole('status').textContent).toBe('Entry type "article" added')
      expect(props.onAddEntryType).toHaveBeenCalledWith(
        'posts',
        expect.objectContaining({ name: 'article' }),
      )
      expect(dismissLabel()).toEqual(['Close'])

      await user.click(footerButton('Close'))

      expect(props.onClose).toHaveBeenCalledTimes(1)
      expect(props.onSave).not.toHaveBeenCalled()
    })

    it('edit mode: a failed add keeps Cancel, shows the error in the entry type modal and adds no row', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor({
        ...editProps(),
        onAddEntryType: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
      })

      await addEntryTypeViaUi(user, 'article')

      const dialog = await entryTypeDialog('Add entry type')
      expect(await within(dialog).findByText('boom')).toBeTruthy()
      expect(screen.queryByText('article', { selector: 'p' })).toBeNull()
      expect(screen.getByRole('status').textContent).toBe('')
      expect(dismissLabel()).toEqual(['Cancel'])
      expect(props.onClose).not.toHaveBeenCalled()
    })

    it('edit mode: an updated entry type shows its new label and turns Cancel into Close', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      await editEntryTypeLabelViaUi(user, 'post', 'Article')

      await waitFor(() => expect(screen.getByText(/"Article"/)).toBeTruthy())
      expect(screen.queryByText(/"Post"/)).toBeNull()
      expect(screen.getByRole('status').textContent).toBe('Entry type "post" updated')
      expect(props.onUpdateEntryType).toHaveBeenCalledWith('posts', 'post', { label: 'Article' })
      expect(dismissLabel()).toEqual(['Close'])
    })

    it('edit mode: a cleared label keeps showing the stored label, as the server skips it', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      await openRowMenu(user, 'post')
      await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
      const dialog = await entryTypeDialog('Edit entry type: post')
      await user.clear(within(dialog).getByLabelText(/^Label/))
      await user.click(within(dialog).getByRole('button', { name: 'Save entry type' }))

      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe('Entry type "post" updated'),
      )
      expect(props.onUpdateEntryType).toHaveBeenCalledWith('posts', 'post', { label: undefined })
      expect(screen.getByText(/"Post"/)).toBeTruthy()
    })

    it('edit mode: a removed entry type leaves the list and turns Cancel into Close', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      await removeEntryTypeViaUi(user, 'featured')

      await waitFor(() => expect(screen.queryByText('featured', { selector: 'p' })).toBeNull())
      expect(screen.getByText('post')).toBeTruthy()
      expect(screen.getByRole('status').textContent).toBe('Entry type "featured" removed')
      expect(props.onRemoveEntryType).toHaveBeenCalledWith('posts', 'featured')
      expect(dismissLabel()).toEqual(['Close'])
    })

    it('edit mode: a failed remove shows the error inline, keeps the row and Cancel', async () => {
      const user = userEvent.setup()
      renderCollectionEditor({
        ...editProps(),
        onRemoveEntryType: vi.fn().mockResolvedValue({ ok: false, error: 'locked by branch' }),
      })

      await removeEntryTypeViaUi(user, 'featured')

      expect(await screen.findByText('locked by branch')).toBeTruthy()
      expect(screen.getByText('featured')).toBeTruthy()
      expect(screen.getByRole('status').textContent).toBe('')
      expect(dismissLabel()).toEqual(['Cancel'])
    })

    it('edit mode: a thrown remove shows its message inline', async () => {
      const user = userEvent.setup()
      renderCollectionEditor({
        ...editProps(),
        onRemoveEntryType: vi.fn().mockRejectedValue(new Error('network down')),
      })

      await removeEntryTypeViaUi(user, 'featured')

      expect(await screen.findByText('network down')).toBeTruthy()
      expect(screen.getByText('featured')).toBeTruthy()
    })

    it('edit mode: Save collection details sends the staged label, with or without an entry type change', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      const labelInput = screen.getByLabelText(/^Label/)
      await user.clear(labelInput)
      await user.type(labelInput, 'Articles')
      await user.click(footerButton('Save collection details'))
      expect(props.onSave).toHaveBeenLastCalledWith({ label: 'Articles' }, false)

      await removeEntryTypeViaUi(user, 'featured')
      await waitFor(() => expect(dismissLabel()).toEqual(['Close']))
      await user.click(footerButton('Save collection details'))
      expect(props.onSave).toHaveBeenCalledTimes(2)
      expect(props.onSave).toHaveBeenLastCalledWith({ label: 'Articles' }, false)
    })

    it('edit mode: reopening resets Close to Cancel and reloads the list', async () => {
      const user = userEvent.setup()
      const { rerender, props } = renderCollectionEditor(editProps())
      await addEntryTypeViaUi(user, 'article')
      await screen.findByText('article')
      expect(dismissLabel()).toEqual(['Close'])

      const rerenderWith = (isOpen: boolean, editingCollection: ExistingCollection) =>
        rerender(
          <CanopyCMSProvider>
            <CollectionEditor {...props} isOpen={isOpen} editingCollection={editingCollection} />
          </CanopyCMSProvider>,
        )
      rerenderWith(false, collection)
      const reloaded: ExistingCollection = {
        ...collection,
        entries: [{ name: 'gallery', format: 'json', schema: 'postSchema' }],
      }
      rerenderWith(true, reloaded)

      expect(await screen.findByText('gallery')).toBeTruthy()
      expect(screen.queryByText('article', { selector: 'p' })).toBeNull()
      expect(screen.queryByText('post', { selector: 'p' })).toBeNull()
      expect(dismissLabel()).toEqual(['Cancel'])
      expect(screen.getByRole('status').textContent).toBe('')
    })

    it('says which entry type changes save at once', () => {
      const edit = renderCollectionEditor(editProps())
      expect(screen.getByText('Changes here save to the branch immediately.')).toBeTruthy()
      edit.unmount()

      renderCollectionEditor()
      expect(screen.queryByText('Changes here save to the branch immediately.')).toBeNull()
    })

    it('does not spin the footer while an entry type saves, and blocks closing', async () => {
      const user = userEvent.setup()
      let finish: (r: SchemaOpResult) => void = () => {}
      const onRemoveEntryType = vi.fn(
        () => new Promise<SchemaOpResult>((resolve) => (finish = resolve)),
      )
      const { rerender, props } = renderCollectionEditor({ ...editProps(), onRemoveEntryType })

      await removeEntryTypeViaUi(user, 'featured')

      const primary = footerButton('Save collection details')
      expect((footerButton('Cancel') as HTMLButtonElement).disabled).toBe(true)
      expect((primary as HTMLButtonElement).disabled).toBe(true)

      // The hook's shared loading flag turns on with the action; the primary must not spin.
      rerender(
        <CanopyCMSProvider>
          <CollectionEditor {...props} isSaving />
        </CanopyCMSProvider>,
      )
      expect(footerButton('Save collection details').getAttribute('data-loading')).toBeNull()

      finish(ok)
      await waitFor(() => expect(dismissLabel()).toEqual(['Close']))
    })

    it('words the remove confirm for what removal does in each mode', async () => {
      const user = userEvent.setup()
      const used: ExistingCollection = {
        ...collection,
        entries: [
          { name: 'post', format: 'mdx', schema: 'postSchema', usageCount: 3 },
          { name: 'featured', format: 'json', schema: 'postSchema', usageCount: 1 },
          { name: 'spare', format: 'json', schema: 'postSchema' },
        ],
      }
      renderCollectionEditor({ ...editProps(), editingCollection: used })

      const confirmText = async (rowName: string) => {
        await openRowMenu(user, rowName)
        await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
        const confirm = await screen.findByTestId('confirm-delete-modal')
        const text = confirm.textContent
        await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
        await waitFor(() => expect(screen.queryByTestId('confirm-delete-modal')).toBeNull())
        return text
      }

      expect(await confirmText('post')).toContain(
        '"post" is used by 3 entries. Removing it saves immediately and stops those entries from being edited.',
      )
      expect(await confirmText('featured')).toContain(
        '"featured" is used by 1 entry. Removing it saves immediately',
      )
      expect(await confirmText('spare')).toContain(
        'Remove "spare"? This saves immediately and cannot be undone.',
      )
    })

    it('create mode: removing a staged entry type drops its row without calling the API', async () => {
      const user = userEvent.setup()
      const onRemoveEntryType = vi.fn()
      renderCollectionEditor({ onRemoveEntryType })
      await addEntryTypeViaUi(user, 'article')
      await addEntryTypeViaUi(user, 'page')
      await screen.findByText('page')

      await removeEntryTypeViaUi(user, 'page')

      await waitFor(() => expect(screen.queryByText('page')).toBeNull())
      expect(screen.getByText('article')).toBeTruthy()
      expect(onRemoveEntryType).not.toHaveBeenCalled()
    })

    it('create mode: the remove confirm wording names the new collection', async () => {
      const user = userEvent.setup()
      renderCollectionEditor()
      await addEntryTypeViaUi(user, 'article')
      await addEntryTypeViaUi(user, 'page')
      await screen.findByText('page')

      await openRowMenu(user, 'page')
      await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))

      expect((await screen.findByTestId('confirm-delete-modal')).textContent).toContain(
        'Remove "page" from this new collection?',
      )
    })
  })
})
