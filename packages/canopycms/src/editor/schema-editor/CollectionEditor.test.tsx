// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
  return names.filter((n) => n === 'Cancel' || n === 'Close' || n === 'Discard changes')
}

const ok: SchemaOpResult = { ok: true }

const entryTypeDialog = async (name: string | RegExp) => screen.findByRole('dialog', { name })

const addEntryTypeViaUi = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name: 'Add entry type…' }))
  const dialog = await entryTypeDialog('Add entry type')
  await user.type(within(dialog).getByLabelText(/^Name/), name)
  await user.click(within(dialog).getByRole('button', { name: 'Add entry type' }))
}

const openRowMenu = async (user: ReturnType<typeof userEvent.setup>, rowName: string) => {
  await user.click(screen.getByRole('button', { name: `Actions for ${rowName}` }))
}

/**
 * Closes the open row menu and waits for it to leave the DOM: a menu still animating out keeps
 * its items, which a query for the next row's menu would otherwise find first.
 */
const closeRowMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

const editEntryTypeLabelViaUi = async (
  user: ReturnType<typeof userEvent.setup>,
  rowName: string,
  label: string,
) => {
  await openRowMenu(user, rowName)
  await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
  const dialog = await entryTypeDialog(/^Edit entry type:/)
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

      expect(screen.getByText('Edit collection: Blog Posts')).toBeTruthy()
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

    it('titles an external error for the mode, and lets it be dismissed', async () => {
      const user = userEvent.setup()
      const edit = renderCollectionEditor({
        error: 'The branch changed',
        editingCollection: {
          name: 'posts',
          logicalPath: unsafeAsLogicalPath('posts'),
          entries: [{ name: 'post', format: 'mdx', schema: 'postSchema' }],
        },
      })
      const alert = screen.getByRole('alert')
      expect(within(alert).getByText("Couldn't save collection details")).toBeTruthy()

      await user.click(within(alert).getByRole('button'))

      expect(screen.queryByText('The branch changed')).toBeNull()
      edit.unmount()

      renderCollectionEditor({ error: 'Collection already exists' })
      expect(screen.getByText("Couldn't create collection")).toBeTruthy()
    })

    it('shows a dismissed external error again when it changes or the dialog reopens', async () => {
      const user = userEvent.setup()
      const { rerender, props } = renderCollectionEditor({ error: 'First problem' })
      await user.click(within(screen.getByRole('alert')).getByRole('button'))
      expect(screen.queryByText('First problem')).toBeNull()

      const rerenderWith = (isOpen: boolean, error: string | null) =>
        rerender(
          <CanopyCMSProvider>
            <CollectionEditor {...props} isOpen={isOpen} error={error} />
          </CanopyCMSProvider>,
        )
      rerenderWith(true, 'Second problem')
      expect(screen.getByText('Second problem')).toBeTruthy()

      await user.click(within(screen.getByRole('alert')).getByRole('button'))
      rerenderWith(false, 'Second problem')
      rerenderWith(true, 'Second problem')
      expect(await screen.findByText('Second problem')).toBeTruthy()
    })

    it('gives a validation error no title and clears it on dismiss', async () => {
      const user = userEvent.setup()
      renderCollectionEditor()
      await user.click(screen.getByRole('button', { name: /Create collection/i }))
      const alert = screen.getByRole('alert')
      expect(alert.querySelector('.mantine-Alert-title')).toBeNull()
      expect(within(alert).getByText('Name is required')).toBeTruthy()

      await user.click(within(alert).getByRole('button'))

      expect(screen.queryByText('Name is required')).toBeNull()
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

    it('edit mode: clearing only the label saves nothing, as the server would skip it', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      await openRowMenu(user, 'post')
      await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
      const dialog = await entryTypeDialog('Edit entry type: Post')
      await user.clear(within(dialog).getByLabelText(/^Label/))
      await user.click(within(dialog).getByRole('button', { name: 'Save entry type' }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: /entry type/ })).toBeNull())
      expect(props.onUpdateEntryType).not.toHaveBeenCalled()
      expect(screen.getByText(/"Post"/)).toBeTruthy()
      expect(screen.getByRole('status').textContent).toBe('')
      expect(dismissLabel()).toEqual(['Cancel'])
    })

    it('edit mode: saving an entry type with no change calls no API', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      await openRowMenu(user, 'post')
      await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
      const dialog = await entryTypeDialog('Edit entry type: Post')
      await user.click(within(dialog).getByRole('button', { name: 'Save entry type' }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: /entry type/ })).toBeNull())
      expect(props.onUpdateEntryType).not.toHaveBeenCalled()
      expect(screen.getByRole('status').textContent).toBe('')
      expect(dismissLabel()).toEqual(['Cancel'])
    })

    it('edit mode: a removed entry type leaves the list and turns Cancel into Close', async () => {
      const user = userEvent.setup()
      const { props } = renderCollectionEditor(editProps())

      await removeEntryTypeViaUi(user, 'featured')

      await waitFor(() => expect(screen.queryByText('featured', { selector: 'p' })).toBeNull())
      expect(screen.getByText('post')).toBeTruthy()
      expect(screen.getByRole('status').textContent).toBe('Entry type "featured" removed')
      expect(props.onRemoveEntryType).toHaveBeenCalledWith('posts', 'featured')
      // Only the check icon is green: green text misses the 4.5:1 contrast text needs.
      expect(
        screen.getByText('Entry type "featured" removed').getAttribute('style') ?? '',
      ).not.toContain('green')
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
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('removed'))
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
      await user.keyboard('{Escape}')
      expect(props.onClose).not.toHaveBeenCalled()

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
      renderCollectionEditor(editProps())

      await openRowMenu(user, 'featured')
      await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))

      expect((await screen.findByTestId('confirm-delete-modal')).textContent).toContain(
        'Remove "featured"? This saves immediately and cannot be undone.',
      )
    })

    it('edit mode: blocks removing an entry type that entries use, and says why', async () => {
      const user = userEvent.setup()
      const used: ExistingCollection = {
        ...collection,
        entries: [
          { name: 'post', format: 'mdx', schema: 'postSchema', usageCount: 3 },
          { name: 'featured', format: 'json', schema: 'postSchema', usageCount: 1 },
          { name: 'spare', format: 'json', schema: 'postSchema', usageCount: 0 },
        ],
      }
      const { props } = renderCollectionEditor({ ...editProps(), editingCollection: used })

      await openRowMenu(user, 'post')
      const many = await screen.findByRole('menuitem', { name: /^Remove/ })
      expect(many.getAttribute('aria-disabled')).toBe('true')
      expect(many.textContent).toContain(
        '3 entries use this entry type. Move or delete them first.',
      )
      await user.click(many)
      expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()
      await closeRowMenu(user)

      await openRowMenu(user, 'featured')
      const one = await screen.findByRole('menuitem', { name: /^Remove/ })
      expect(one.textContent).toContain('1 entry uses this entry type. Move or delete it first.')
      await closeRowMenu(user)

      await openRowMenu(user, 'spare')
      const free = await screen.findByRole('menuitem', { name: 'Remove' })
      expect(free.getAttribute('aria-disabled')).toBeNull()
      expect(props.onRemoveEntryType).not.toHaveBeenCalled()
    })

    it('edit mode: the last-entry-type reason wins over the in-use reason', async () => {
      const user = userEvent.setup()
      const onlyOne: ExistingCollection = {
        ...collection,
        entries: [{ name: 'post', format: 'mdx', schema: 'postSchema', usageCount: 3 }],
      }
      renderCollectionEditor({ ...editProps(), editingCollection: onlyOne })

      await openRowMenu(user, 'post')

      expect((await screen.findByRole('menuitem', { name: /^Remove/ })).textContent).toContain(
        'A collection needs at least one entry type.',
      )
    })

    it('create mode: removes a staged entry type at once, offering Undo, without calling the API', async () => {
      const user = userEvent.setup()
      const onRemoveEntryType = vi.fn()
      renderCollectionEditor({ onRemoveEntryType })
      await addEntryTypeViaUi(user, 'article')
      await addEntryTypeViaUi(user, 'page')
      await addEntryTypeViaUi(user, 'author')
      await screen.findByText('author')

      await openRowMenu(user, 'page')
      await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))

      await waitFor(() => expect(screen.queryByText('page')).toBeNull())
      expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()
      expect(onRemoveEntryType).not.toHaveBeenCalled()

      expect(screen.getByRole('status').textContent).toContain('Removed entry type "page".')
      await user.click(screen.getByRole('button', { name: 'Undo removing entry type "page"' }))

      await screen.findByText('page')
      const rows = screen.getAllByRole('button', { name: /^Actions for / })
      expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
        'Actions for article',
        'Actions for page',
        'Actions for author',
      ])
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Actions for page' }),
        ),
      )
    })

    it.each([
      ['closes on an outside click with nothing typed', false],
      ['keeps typed input through an outside click', true],
    ])('create mode: %s', async (_, typed) => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      renderCollectionEditor({ onClose })
      if (typed) await user.type(screen.getByLabelText(/^Name/), 'posts')

      const overlay = document.querySelector('.mantine-Modal-overlay')
      if (!overlay) throw new Error('no modal overlay')
      await user.click(overlay)

      expect(onClose).toHaveBeenCalledTimes(typed ? 0 : 1)
    })

    it('create mode: offers Undo for the latest removal, until the dialog closes', async () => {
      const user = userEvent.setup()
      const { rerender, props } = renderCollectionEditor()
      await addEntryTypeViaUi(user, 'article')
      await addEntryTypeViaUi(user, 'page')
      await addEntryTypeViaUi(user, 'author')
      await screen.findByText('author')
      const remove = async (name: string) => {
        await openRowMenu(user, name)
        await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
        await waitFor(() => expect(screen.queryByText(name)).toBeNull())
      }

      await remove('page')
      await remove('author')

      expect(screen.queryByRole('button', { name: 'Undo removing entry type "page"' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Undo removing entry type "author"' })).toBeTruthy()

      rerender(
        <CanopyCMSProvider>
          <CollectionEditor {...props} isOpen={false} />
        </CanopyCMSProvider>,
      )
      rerender(
        <CanopyCMSProvider>
          <CollectionEditor {...props} isOpen={true} />
        </CanopyCMSProvider>,
      )
      expect(screen.queryByRole('button', { name: /^Undo removing/ })).toBeNull()
    })

    describe('sub-dialogs', () => {
      const pending = () => {
        let finish: (r: SchemaOpResult) => void = () => {}
        const promise = new Promise<SchemaOpResult>((resolve) => (finish = resolve))
        return { promise, finish: (r: SchemaOpResult) => finish(r) }
      }

      it('keeps the entry type dialog open while it saves, then shows a failure in it', async () => {
        const user = userEvent.setup()
        const request = pending()
        renderCollectionEditor({ ...editProps(), onAddEntryType: vi.fn(() => request.promise) })

        await addEntryTypeViaUi(user, 'article')
        await user.keyboard('{Escape}')
        // A closing dialog stays in the DOM until its exit transition ends; wait that out.
        await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

        expect(screen.getByRole('dialog', { name: 'Add entry type' })).toBeTruthy()

        request.finish({ ok: false, error: 'boom' })
        expect(
          await within(await entryTypeDialog('Add entry type')).findByText('boom'),
        ).toBeTruthy()
      })

      it('closes the entry type dialog when the collection dialog closes', async () => {
        const user = userEvent.setup()
        const { rerender, props } = renderCollectionEditor(editProps())
        await user.click(screen.getByRole('button', { name: 'Add entry type…' }))
        await entryTypeDialog('Add entry type')

        rerender(
          <CanopyCMSProvider>
            <CollectionEditor {...props} isOpen={false} />
          </CanopyCMSProvider>,
        )

        await waitFor(() =>
          expect(screen.queryByRole('dialog', { name: 'Add entry type' })).toBeNull(),
        )
      })

      it('closes the remove confirm when the collection dialog closes', async () => {
        const user = userEvent.setup()
        const { rerender, props } = renderCollectionEditor(editProps())
        await openRowMenu(user, 'featured')
        await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
        await screen.findByTestId('confirm-delete-modal')

        rerender(
          <CanopyCMSProvider>
            <CollectionEditor {...props} isOpen={false} />
          </CanopyCMSProvider>,
        )

        await waitFor(() => expect(screen.queryByTestId('confirm-delete-modal')).toBeNull())
      })

      it('locks the entry types and ignores Escape while collection details save', async () => {
        const user = userEvent.setup()
        const { props } = renderCollectionEditor({ ...editProps(), isSaving: true })

        expect(
          screen.getByRole('button', { name: 'Add entry type…' }).hasAttribute('disabled'),
        ).toBe(true)
        for (const row of ['post', 'featured']) {
          expect(
            screen.getByRole('button', { name: `Actions for ${row}` }).hasAttribute('disabled'),
          ).toBe(true)
        }

        await user.keyboard('{Escape}')

        expect(props.onClose).not.toHaveBeenCalled()
      })

      it('ignores Escape on the collection dialog while the entry type dialog is open', async () => {
        const user = userEvent.setup()
        const { props } = renderCollectionEditor(editProps())
        await user.click(screen.getByRole('button', { name: 'Add entry type…' }))
        await entryTypeDialog('Add entry type')

        await user.keyboard('{Escape}')

        await waitFor(() =>
          expect(screen.queryByRole('dialog', { name: 'Add entry type' })).toBeNull(),
        )
        expect(props.onClose).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog', { name: /^Edit collection/ })).toBeTruthy()
      })

      it('ignores Escape on the collection dialog while the remove confirm is open', async () => {
        const user = userEvent.setup()
        const { props } = renderCollectionEditor(editProps())
        await openRowMenu(user, 'featured')
        await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
        await screen.findByTestId('confirm-delete-modal')

        await user.keyboard('{Escape}')

        expect(props.onClose).not.toHaveBeenCalled()
      })

      it('keeps the remove confirm text while it closes', async () => {
        const user = userEvent.setup()
        renderCollectionEditor(editProps())
        await openRowMenu(user, 'featured')
        await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
        const confirm = await screen.findByTestId('confirm-delete-modal')

        await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))

        const closing = screen.queryByTestId('confirm-delete-modal')
        if (closing) expect(closing.textContent).toContain('Remove "featured"?')
      })
    })

    describe('retrying a failed remove', () => {
      it('re-runs the remove for the same entry type without a second confirm', async () => {
        const user = userEvent.setup()
        const onRemoveEntryType = vi
          .fn()
          .mockResolvedValueOnce({ ok: false, error: 'locked by branch' })
          .mockResolvedValueOnce(ok)
        renderCollectionEditor({ ...editProps(), onRemoveEntryType })
        await removeEntryTypeViaUi(user, 'featured')
        await screen.findByText('locked by branch')

        await user.click(screen.getByRole('button', { name: 'Retry' }))

        await waitFor(() => expect(screen.queryByText('featured', { selector: 'p' })).toBeNull())
        expect(onRemoveEntryType).toHaveBeenCalledTimes(2)
        expect(onRemoveEntryType).toHaveBeenLastCalledWith('posts', 'featured')
        expect(screen.getByRole('status').textContent).toBe('Entry type "featured" removed')
        expect(screen.queryByText('locked by branch')).toBeNull()
        await waitFor(() => expect(screen.queryByTestId('confirm-delete-modal')).toBeNull())
      })

      it('disables Retry while collection details save', async () => {
        const user = userEvent.setup()
        const onRemoveEntryType = vi
          .fn()
          .mockResolvedValue({ ok: false, error: 'locked by branch' })
        const { rerender, props } = renderCollectionEditor({ ...editProps(), onRemoveEntryType })
        await removeEntryTypeViaUi(user, 'featured')
        await screen.findByText('locked by branch')

        rerender(
          <CanopyCMSProvider>
            <CollectionEditor {...props} isSaving />
          </CanopyCMSProvider>,
        )

        expect(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(true)
      })

      it('ignores Escape on the collection dialog while a retried remove is in flight', async () => {
        const user = userEvent.setup()
        let finish: (r: SchemaOpResult) => void = () => {}
        const onRemoveEntryType = vi
          .fn()
          .mockResolvedValueOnce({ ok: false, error: 'locked by branch' })
          .mockImplementationOnce(
            () => new Promise<SchemaOpResult>((resolve) => (finish = resolve)),
          )
        const { props } = renderCollectionEditor({ ...editProps(), onRemoveEntryType })
        await removeEntryTypeViaUi(user, 'featured')
        await screen.findByText('locked by branch')
        await waitFor(() => expect(screen.queryByTestId('confirm-delete-modal')).toBeNull())

        await user.click(screen.getByRole('button', { name: 'Retry' }))
        await user.keyboard('{Escape}')

        expect(props.onClose).not.toHaveBeenCalled()
        finish(ok)
        await waitFor(() => expect(dismissLabel()).toEqual(['Close']))
      })
    })

    describe('dismiss label', () => {
      it('reads Discard changes once details are edited, and Close after reverting them', async () => {
        const user = userEvent.setup()
        const { props } = renderCollectionEditor(editProps())
        const labelInput = screen.getByLabelText(/^Label/)

        await user.type(labelInput, 's')
        expect(dismissLabel()).toEqual(['Discard changes'])
        await user.click(footerButton('Discard changes'))
        expect(props.onClose).toHaveBeenCalledTimes(1)
        expect(props.onSave).not.toHaveBeenCalled()

        await removeEntryTypeViaUi(user, 'featured')
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('removed'))
        expect(dismissLabel()).toEqual(['Discard changes'])
        // The remove moves focus to the neighbouring row on a timer; typing before it lands would
        // send the keystroke there.
        await waitFor(() =>
          expect(document.activeElement).toBe(
            screen.getByRole('button', { name: 'Actions for post' }),
          ),
        )

        await user.type(labelInput, '{Backspace}')
        expect(dismissLabel()).toEqual(['Close'])
      })

      it('reads Discard changes for an edited name or slug', async () => {
        const user = userEvent.setup()
        renderCollectionEditor(editProps())

        await user.type(screen.getByLabelText(/^Slug/), 'x')
        expect(dismissLabel()).toEqual(['Discard changes'])
        await user.type(screen.getByLabelText(/^Slug/), '{Backspace}')
        expect(dismissLabel()).toEqual(['Cancel'])

        await user.type(screen.getByLabelText(/^Name/), 'x')
        expect(dismissLabel()).toEqual(['Discard changes'])
      })

      it('create mode keeps Cancel even with typed details', async () => {
        const user = userEvent.setup()
        renderCollectionEditor()

        await user.type(screen.getByLabelText(/^Name/), 'posts')

        expect(dismissLabel()).toEqual(['Cancel'])
      })
    })

    describe('focus after an entry type action', () => {
      const trigger = (rowName: string) =>
        screen.getByRole('button', { name: `Actions for ${rowName}` })
      const expectFocusOn = (rowName: string) =>
        waitFor(() => expect(document.activeElement).toBe(trigger(rowName)))

      it('returns to the row after saving an edit', async () => {
        const user = userEvent.setup()
        renderCollectionEditor(editProps())

        await editEntryTypeLabelViaUi(user, 'post', 'Article')

        await expectFocusOn('post')
      })

      it('returns to the row after an edit that changes nothing', async () => {
        const user = userEvent.setup()
        renderCollectionEditor(editProps())
        await openRowMenu(user, 'featured')
        await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
        const dialog = await entryTypeDialog('Edit entry type: Featured')

        await user.click(within(dialog).getByRole('button', { name: 'Save entry type' }))

        await expectFocusOn('featured')
      })

      it('returns to the row after cancelling an edit', async () => {
        const user = userEvent.setup()
        renderCollectionEditor(editProps())
        await openRowMenu(user, 'featured')
        await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
        const dialog = await entryTypeDialog('Edit entry type: Featured')

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

        await expectFocusOn('featured')
      })

      it('moves to the next row after a remove', async () => {
        const user = userEvent.setup()
        renderCollectionEditor(editProps())

        await removeEntryTypeViaUi(user, 'post')

        await expectFocusOn('featured')
      })

      it('prefers the next row over the previous one after removing a middle row', async () => {
        const user = userEvent.setup()
        const three: ExistingCollection = {
          ...collection,
          entries: [
            { name: 'one', format: 'json', schema: 'postSchema' },
            { name: 'two', format: 'json', schema: 'postSchema' },
            { name: 'three', format: 'json', schema: 'postSchema' },
          ],
        }
        renderCollectionEditor({ ...editProps(), editingCollection: three })

        await removeEntryTypeViaUi(user, 'two')

        await expectFocusOn('three')
      })

      it('moves to the previous row after removing the last one', async () => {
        const user = userEvent.setup()
        renderCollectionEditor(editProps())

        await removeEntryTypeViaUi(user, 'featured')

        await expectFocusOn('post')
      })

      it('returns to the row after a failed remove', async () => {
        const user = userEvent.setup()
        renderCollectionEditor({
          ...editProps(),
          onRemoveEntryType: vi.fn().mockResolvedValue({ ok: false, error: 'locked by branch' }),
        })

        await removeEntryTypeViaUi(user, 'post')

        await screen.findByText('locked by branch')
        await expectFocusOn('post')
      })

      it('returns to the row after cancelling a remove', async () => {
        const user = userEvent.setup()
        renderCollectionEditor(editProps())
        await openRowMenu(user, 'featured')
        await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
        const confirm = await screen.findByTestId('confirm-delete-modal')

        await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))

        await expectFocusOn('featured')
      })
    })

    describe('an entry type action the server never answered', () => {
      const unanswered: SchemaOpResult = {
        ok: false,
        error: "The server didn't answer",
        unanswered: true,
      }
      const article: ExistingCollection['entries'][number] = {
        name: 'article',
        label: 'Article',
        format: 'json',
        schema: 'postSchema',
      }
      const trigger = (rowName: string) =>
        screen.queryByRole('button', { name: `Actions for ${rowName}` })
      const expectFocusOn = (rowName: string) =>
        waitFor(() => expect(document.activeElement).toBe(trigger(rowName)))
      const expectFocusOnHeading = () =>
        waitFor(() =>
          expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Entry types' })),
        )
      const noEntryTypeDialog = () =>
        waitFor(() => expect(screen.queryByRole('dialog', { name: /entry type/ })).toBeNull())
      const noAnswerTitle = 'No answer from the server'
      const notAdded = (name: string) =>
        `"${name}" may not have been added. Select "Add entry type" to try again: if it was added, you'll be told it already exists.`
      const notSaved =
        'The change may not have been saved. Select "Save entry type" to send it again.'
      const stillListed = (name: string) =>
        `"${name}" is still listed, so it may not have been removed yet. Remove it again to retry, or close and reopen this collection later to check.`
      const maybeRemoved = (name: string) =>
        `"${name}" may already have been removed. Close and reopen this collection to check before trying again.`
      const alertOf = (text: string) =>
        screen.getByText(text).closest('[role="alert"]') as HTMLElement
      const precedes = (earlier: Node, later: Node) =>
        !!(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)

      const addWithLabelViaUi = async (
        user: ReturnType<typeof userEvent.setup>,
        name: string,
        label: string,
      ) => {
        await user.click(screen.getByRole('button', { name: 'Add entry type…' }))
        const dialog = await entryTypeDialog('Add entry type')
        await user.type(within(dialog).getByLabelText(/^Name/), name)
        await user.type(within(dialog).getByLabelText(/^Label/), label)
        await user.click(within(dialog).getByRole('button', { name: 'Add entry type' }))
        return dialog
      }

      const unreadable = [
        ['resolves null', { onReloadEntryTypes: vi.fn().mockResolvedValue(null) }],
        ['rejects', { onReloadEntryTypes: vi.fn().mockRejectedValue(new Error('offline')) }],
        ['is not provided', {}],
      ] as const

      describe('add', () => {
        it('counts it as added when the re-read lists the name: status line, row, closed dialog, focus on the row', async () => {
          const user = userEvent.setup()
          const onReloadEntryTypes = vi.fn().mockResolvedValue([...collection.entries, article])
          renderCollectionEditor({
            ...editProps(),
            onAddEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes,
          })

          await addEntryTypeViaUi(user, 'article')

          await noEntryTypeDialog()
          expect(screen.getByRole('status').textContent).toBe('Entry type "article" added')
          expect(onReloadEntryTypes).toHaveBeenCalledWith('posts')
          expect(trigger('article')).toBeTruthy()
          expect(screen.queryByText(noAnswerTitle)).toBeNull()
          expect(dismissLabel()).toEqual(['Close'])
          await expectFocusOn('article')
        })

        it('keeps the dialog open with what was typed and warns when the re-read lacks the name', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onAddEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue(collection.entries),
          })

          const dialog = await addWithLabelViaUi(user, 'article', 'Article')

          expect(await within(dialog).findByText(notAdded('article'))).toBeTruthy()
          expect(within(dialog).getByText(noAnswerTitle)).toBeTruthy()
          expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('article')
          expect((within(dialog).getByLabelText(/^Label/) as HTMLInputElement).value).toBe(
            'Article',
          )
          expect(within(dialog).queryByText('Error')).toBeNull()
          expect(trigger('article')).toBeNull()
          expect(screen.getByRole('dialog', { name: 'Add entry type' })).toBe(dialog)
        })

        it('keeps the dialog open when the re-read lists the name with other fields, as when someone else added it', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onAddEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi
              .fn()
              .mockResolvedValue([...collection.entries, { ...article, label: 'Theirs' }]),
          })

          const dialog = await addWithLabelViaUi(user, 'article', 'Article')

          expect(await within(dialog).findByText(notAdded('article'))).toBeTruthy()
          expect((within(dialog).getByLabelText(/^Label/) as HTMLInputElement).value).toBe(
            'Article',
          )
          expect(screen.getByRole('status').textContent).toBe('')
        })

        it('replaces the list with the re-read when the name is missing from it', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onAddEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi
              .fn()
              .mockResolvedValue([collection.entries[0], { ...article, name: 'other' }]),
          })

          await addEntryTypeViaUi(user, 'article')

          await screen.findByText(notAdded('article'))
          await waitFor(() => expect(trigger('other')).toBeTruthy())
          expect(trigger('featured')).toBeNull()
        })

        it.each(unreadable)(
          'keeps the dialog open and warns when the re-read %s',
          async (_label, reloadProps) => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            const user = userEvent.setup()
            renderCollectionEditor({
              ...editProps(),
              onAddEntryType: vi.fn().mockResolvedValue(unanswered),
              ...reloadProps,
            })

            const dialog = await addWithLabelViaUi(user, 'article', 'Article')

            expect(await within(dialog).findByText(notAdded('article'))).toBeTruthy()
            expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
              'article',
            )
            expect(trigger('post')).toBeTruthy()
            expect(trigger('featured')).toBeTruthy()
            expect(trigger('article')).toBeNull()
          },
        )

        it('clears the warning when the dialog is cancelled', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onAddEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue(collection.entries),
          })
          const dialog = await addWithLabelViaUi(user, 'article', 'Article')
          await within(dialog).findByText(notAdded('article'))

          await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
          await noEntryTypeDialog()
          expect(dismissLabel()).toEqual(['Close'])
          await user.click(screen.getByRole('button', { name: 'Add entry type…' }))

          const reopened = await entryTypeDialog('Add entry type')
          expect(within(reopened).queryByText(noAnswerTitle)).toBeNull()
        })

        it('clears the warning when the next save starts', async () => {
          const user = userEvent.setup()
          let finishSecond: (result: SchemaOpResult) => void = () => {}
          renderCollectionEditor({
            ...editProps(),
            onAddEntryType: vi
              .fn()
              .mockResolvedValueOnce(unanswered)
              .mockReturnValueOnce(
                new Promise<SchemaOpResult>((resolve) => {
                  finishSecond = resolve
                }),
              ),
            onReloadEntryTypes: vi.fn().mockResolvedValue(collection.entries),
          })
          const dialog = await addWithLabelViaUi(user, 'article', 'Article')
          await within(dialog).findByText(notAdded('article'))

          await user.click(within(dialog).getByRole('button', { name: 'Add entry type' }))

          await waitFor(() => expect(within(dialog).queryByText(noAnswerTitle)).toBeNull())
          await act(async () => finishSecond(ok))
          await noEntryTypeDialog()
        })

        it('keeps Discard changes while collection details are edited', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onAddEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue([...collection.entries, article]),
          })
          await user.type(screen.getByLabelText(/^Label/), 's')

          await addEntryTypeViaUi(user, 'article')

          await noEntryTypeDialog()
          expect(dismissLabel()).toEqual(['Discard changes'])
        })
      })

      describe('update', () => {
        it('counts it as updated when the re-read shows the sent fields: status line, closed dialog, focus on the row', async () => {
          const user = userEvent.setup()
          const onUpdateEntryType = vi.fn().mockResolvedValue(unanswered)
          renderCollectionEditor({
            ...editProps(),
            onUpdateEntryType,
            onReloadEntryTypes: vi
              .fn()
              .mockResolvedValue([
                { ...collection.entries[0], label: 'Article' },
                collection.entries[1],
              ]),
          })

          await editEntryTypeLabelViaUi(user, 'post', 'Article')

          await noEntryTypeDialog()
          expect(onUpdateEntryType).toHaveBeenCalledWith('posts', 'post', { label: 'Article' })
          expect(screen.getByRole('status').textContent).toBe('Entry type "post" updated')
          expect(screen.getByText(/"Article"/)).toBeTruthy()
          expect(screen.queryByText(noAnswerTitle)).toBeNull()
          expect(dismissLabel()).toEqual(['Close'])
          await expectFocusOn('post')
        })

        it('compares default as a boolean, so an unset default matches a sent false', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onUpdateEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi
              .fn()
              .mockResolvedValue([
                { name: 'post', label: 'Post', format: 'mdx', schema: 'postSchema' },
                collection.entries[1],
              ]),
          })
          await openRowMenu(user, 'post')
          await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
          const dialog = await entryTypeDialog(/^Edit entry type:/)

          await user.click(within(dialog).getByRole('switch', { name: /^Default entry type/ }))
          await user.click(within(dialog).getByRole('button', { name: 'Save entry type' }))

          await noEntryTypeDialog()
          expect(screen.getByRole('status').textContent).toBe('Entry type "post" updated')
          expect(screen.queryByText(noAnswerTitle)).toBeNull()
        })

        it('keeps the dialog open with what was typed and warns when the re-read differs', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onUpdateEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue(collection.entries),
          })

          await editEntryTypeLabelViaUi(user, 'post', 'Article')

          const dialog = await entryTypeDialog(/^Edit entry type:/)
          expect(await within(dialog).findByText(notSaved)).toBeTruthy()
          expect(within(dialog).getByText(noAnswerTitle)).toBeTruthy()
          expect((within(dialog).getByLabelText(/^Label/) as HTMLInputElement).value).toBe(
            'Article',
          )
          expect(within(dialog).queryByText('Error')).toBeNull()
          expect(screen.getByRole('status').textContent).toBe('')
        })

        it('warns when the re-read shows only some of the sent fields', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onUpdateEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi
              .fn()
              .mockResolvedValue([
                { ...collection.entries[0], label: 'Article' },
                collection.entries[1],
              ]),
          })
          await openRowMenu(user, 'post')
          await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
          const dialog = await entryTypeDialog(/^Edit entry type:/)
          const labelInput = within(dialog).getByLabelText(/^Label/)
          await user.clear(labelInput)
          await user.type(labelInput, 'Article')
          await user.click(within(dialog).getByRole('switch', { name: /^Default entry type/ }))

          await user.click(within(dialog).getByRole('button', { name: 'Save entry type' }))

          expect(await within(dialog).findByText(notSaved)).toBeTruthy()
        })

        it.each(unreadable)(
          'keeps the dialog open and warns when the re-read %s',
          async (_label, reloadProps) => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            const user = userEvent.setup()
            renderCollectionEditor({
              ...editProps(),
              onUpdateEntryType: vi.fn().mockResolvedValue(unanswered),
              ...reloadProps,
            })

            await editEntryTypeLabelViaUi(user, 'post', 'Article')

            const dialog = await entryTypeDialog(/^Edit entry type:/)
            expect(await within(dialog).findByText(notSaved)).toBeTruthy()
            expect(trigger('post')).toBeTruthy()
          },
        )
      })

      describe('remove', () => {
        it('counts it as removed when the re-read lacks the name: row gone, status line, no alert or Retry, focus on the previous row', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onRemoveEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue([collection.entries[0]]),
          })

          await removeEntryTypeViaUi(user, 'featured')

          await waitFor(() => expect(screen.queryByTestId('confirm-delete-modal')).toBeNull())
          expect(screen.getByRole('status').textContent).toBe('Entry type "featured" removed')
          expect(trigger('featured')).toBeNull()
          expect(screen.queryByText(noAnswerTitle)).toBeNull()
          expect(screen.queryByText("Couldn't remove entry type")).toBeNull()
          expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
          expect(dismissLabel()).toEqual(['Close'])
          await expectFocusOn('post')
        })

        it('focuses the next row when one is listed', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onRemoveEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue([collection.entries[1]]),
          })

          await removeEntryTypeViaUi(user, 'post')

          await expectFocusOn('featured')
        })

        it('focuses the heading when no neighbour is left listed', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onRemoveEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue([article]),
          })

          await removeEntryTypeViaUi(user, 'featured')

          await screen.findByText('Entry type "featured" removed')
          await expectFocusOnHeading()
        })

        it('keeps the row, warns above the list and focuses the row when the re-read still lists it', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onRemoveEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue(collection.entries),
          })

          await removeEntryTypeViaUi(user, 'featured')

          const alert = alertOf(stillListed('featured'))
          expect(within(alert).getByText(noAnswerTitle)).toBeTruthy()
          expect(trigger('featured')).toBeTruthy()
          expect(screen.queryByText("Couldn't remove entry type")).toBeNull()
          expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
          expect(screen.getByRole('status').textContent).toBe('')
          expect(dismissLabel()).toEqual(['Close'])
          const heading = screen.getByRole('heading', { name: 'Entry types' })
          const firstRow = trigger('post') as HTMLElement
          const lastRow = trigger('featured') as HTMLElement
          expect(precedes(heading, alert)).toBe(true)
          expect(precedes(alert, firstRow)).toBe(true)
          expect(precedes(alert, lastRow)).toBe(true)
          await expectFocusOn('featured')
        })

        it.each(unreadable)(
          'warns above the list and focuses the row when the re-read %s',
          async (_label, reloadProps) => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            const user = userEvent.setup()
            renderCollectionEditor({
              ...editProps(),
              onRemoveEntryType: vi.fn().mockResolvedValue(unanswered),
              ...reloadProps,
            })

            await removeEntryTypeViaUi(user, 'featured')

            const alert = alertOf(maybeRemoved('featured'))
            expect(precedes(alert, trigger('post') as HTMLElement)).toBe(true)
            expect(trigger('post')).toBeTruthy()
            expect(trigger('featured')).toBeTruthy()
            expect(screen.queryByText("Couldn't remove entry type")).toBeNull()
            expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
            expect(dismissLabel()).toEqual(['Close'])
            await expectFocusOn('featured')
          },
        )

        it('replaces a plain failure alert and Retry when the retry goes unanswered', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onRemoveEntryType: vi
              .fn()
              .mockResolvedValueOnce({ ok: false, error: 'locked by branch' })
              .mockResolvedValueOnce(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue(collection.entries),
          })
          await removeEntryTypeViaUi(user, 'featured')
          await screen.findByText('locked by branch')

          await user.click(screen.getByRole('button', { name: 'Retry' }))

          expect(await screen.findByText(stillListed('featured'))).toBeTruthy()
          expect(screen.queryByText('locked by branch')).toBeNull()
          expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
        })

        it('keeps Discard changes while collection details are edited', async () => {
          const user = userEvent.setup()
          renderCollectionEditor({
            ...editProps(),
            onRemoveEntryType: vi.fn().mockResolvedValue(unanswered),
            onReloadEntryTypes: vi.fn().mockResolvedValue(collection.entries),
          })
          await user.type(screen.getByLabelText(/^Label/), 's')

          await removeEntryTypeViaUi(user, 'featured')

          await screen.findByText(stillListed('featured'))
          expect(dismissLabel()).toEqual(['Discard changes'])
        })
      })

      describe('the alert above the list', () => {
        const stillListedProps = () => ({
          ...editProps(),
          onRemoveEntryType: vi.fn().mockResolvedValueOnce(unanswered).mockResolvedValue(ok),
          onReloadEntryTypes: vi.fn().mockResolvedValue(collection.entries),
        })

        it('moves focus to the Entry types heading when dismissed', async () => {
          const user = userEvent.setup()
          renderCollectionEditor(stillListedProps())
          await removeEntryTypeViaUi(user, 'featured')
          const alert = alertOf(stillListed('featured'))
          await expectFocusOn('featured')

          await user.click(within(alert).getByRole('button', { name: 'Close' }))

          expect(screen.queryByText(stillListed('featured'))).toBeNull()
          await expectFocusOnHeading()
        })

        it.each([
          [
            'an add',
            async (user: ReturnType<typeof userEvent.setup>) => addEntryTypeViaUi(user, 'article'),
          ],
          [
            'an update',
            async (user: ReturnType<typeof userEvent.setup>) =>
              editEntryTypeLabelViaUi(user, 'post', 'Article'),
          ],
          [
            'a remove',
            async (user: ReturnType<typeof userEvent.setup>) => removeEntryTypeViaUi(user, 'post'),
          ],
        ])('clears when %s starts', async (_label, nextAction) => {
          const user = userEvent.setup()
          renderCollectionEditor(stillListedProps())
          await removeEntryTypeViaUi(user, 'featured')
          await screen.findByText(stillListed('featured'))

          await nextAction(user)

          await waitFor(() => expect(screen.queryByText(stillListed('featured'))).toBeNull())
        })

        it('clears when the dialog reopens', async () => {
          const user = userEvent.setup()
          const { rerender, props } = renderCollectionEditor(stillListedProps())
          await removeEntryTypeViaUi(user, 'featured')
          await screen.findByText(stillListed('featured'))
          const rerenderWith = (isOpen: boolean) =>
            rerender(
              <CanopyCMSProvider>
                <CollectionEditor {...props} isOpen={isOpen} editingCollection={collection} />
              </CanopyCMSProvider>,
            )

          rerenderWith(false)
          rerenderWith(true)

          await waitFor(() => expect(screen.queryByText(stillListed('featured'))).toBeNull())
          expect(dismissLabel()).toEqual(['Cancel'])
        })
      })

      it('moves focus to the Entry types heading when the red "Couldn\'t remove entry type" alert is dismissed', async () => {
        const user = userEvent.setup()
        renderCollectionEditor({
          ...editProps(),
          onRemoveEntryType: vi.fn().mockResolvedValue({ ok: false, error: 'locked by branch' }),
        })
        await removeEntryTypeViaUi(user, 'featured')
        const alert = alertOf('locked by branch')
        await expectFocusOn('featured')

        await user.click(within(alert).getByRole('button', { name: 'Close' }))

        expect(screen.queryByText('locked by branch')).toBeNull()
        await expectFocusOnHeading()
      })
    })

    describe('layout and wording', () => {
      it('titles the dialogs by label, falling back to the name', async () => {
        const user = userEvent.setup()
        const unlabelled: ExistingCollection = {
          name: 'notes',
          logicalPath: unsafeAsLogicalPath('notes'),
          entries: [
            { name: 'plain', format: 'json', schema: 'postSchema' },
            { name: 'other', format: 'json', schema: 'postSchema' },
          ],
        }
        const edit = renderCollectionEditor({ editingCollection: unlabelled })
        expect(screen.getByRole('dialog', { name: 'Edit collection: notes' })).toBeTruthy()

        await openRowMenu(user, 'plain')
        await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
        expect(await entryTypeDialog('Edit entry type: plain')).toBeTruthy()
        edit.unmount()

        renderCollectionEditor(editProps())
        expect(screen.getByRole('dialog', { name: 'Edit collection: Blog Posts' })).toBeTruthy()
        await openRowMenu(user, 'post')
        await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
        expect(await entryTypeDialog('Edit entry type: Post')).toBeTruthy()
      })

      it('headings: both sections at one level in edit mode, only entry types in create mode', () => {
        const edit = renderCollectionEditor(editProps())
        const details = screen.getByRole('heading', { name: 'Collection details' })
        const types = screen.getByRole('heading', { name: 'Entry types' })
        expect(details.tagName).toBe(types.tagName)
        expect(types.getAttribute('tabindex')).toBe('-1')
        edit.unmount()

        renderCollectionEditor()
        expect(screen.getByRole('heading', { name: 'Entry types' })).toBeTruthy()
        expect(screen.queryByRole('heading', { name: 'Collection details' })).toBeNull()
      })

      it('reserves the status line height so a message shifts nothing', () => {
        renderCollectionEditor(editProps())

        expect(screen.getByRole('status').style.minHeight).toContain('--mantine-line-height-sm')
      })

      it('create mode: a staged entry type is changed with Update entry type, without an API call', async () => {
        const user = userEvent.setup()
        const onUpdateEntryType = vi.fn()
        renderCollectionEditor({ onUpdateEntryType })
        await addEntryTypeViaUi(user, 'article')
        await screen.findByText('article')
        await openRowMenu(user, 'article')
        await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
        const dialog = await entryTypeDialog('Edit entry type: article')

        await user.type(within(dialog).getByLabelText(/^Label/), 'Article')
        await user.click(within(dialog).getByRole('button', { name: 'Update entry type' }))

        expect(await screen.findByText(/"Article"/)).toBeTruthy()
        expect(onUpdateEntryType).not.toHaveBeenCalled()
      })
    })
  })

  describe('input restored after a write with no answer', () => {
    const staged = {
      name: 'article',
      format: 'json' as const,
      schema: 'postSchema',
    }

    it('fills a create in again, and discards it on request', async () => {
      const user = userEvent.setup()
      const onDiscardRestored = vi.fn()
      renderCollectionEditor({
        restored: { name: 'posts', label: 'Blog posts', entries: [staged] },
        onDiscardRestored,
      })

      expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('posts')
      expect((screen.getByLabelText(/^Label/) as HTMLInputElement).value).toBe('Blog posts')
      expect(screen.getByText('article')).toBeTruthy()

      await user.click(screen.getByRole('button', { name: 'Discard changes' }))

      expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('')
      expect(screen.queryByText('article')).toBeNull()
      expect(screen.queryByText('Restored what you entered')).toBeNull()
      expect(onDiscardRestored).toHaveBeenCalledTimes(1)
    })

    it("fills a details save's changes in over the stored values", () => {
      renderCollectionEditor({
        editingCollection: {
          name: 'posts',
          label: 'Posts',
          logicalPath: unsafeAsLogicalPath('content/posts'),
          entries: [{ ...staged, usageCount: 0 }],
        },
        restored: { label: 'Blog posts', slug: 'blog' },
      })

      expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('posts')
      expect((screen.getByLabelText(/^Label/) as HTMLInputElement).value).toBe('Blog posts')
      expect((screen.getByLabelText(/^Slug/) as HTMLInputElement).value).toBe('blog')
      expect(screen.getByText('Restored what you entered')).toBeTruthy()
    })

    it('discards the kept input with the footer\'s "Discard changes" too', async () => {
      const user = userEvent.setup()
      const onDiscardRestored = vi.fn()
      const onClose = vi.fn()
      renderCollectionEditor({
        editingCollection: {
          name: 'posts',
          label: 'Posts',
          logicalPath: unsafeAsLogicalPath('content/posts'),
          entries: [{ ...staged, usageCount: 0 }],
        },
        restored: { label: 'Blog posts' },
        onDiscardRestored,
        onClose,
      })

      await user.click(footerButton('Discard changes'))

      expect(onDiscardRestored).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('moves focus to Name once the restored input is discarded', async () => {
      const user = userEvent.setup()
      renderCollectionEditor({ restored: { name: 'posts' }, onDiscardRestored: vi.fn() })

      await user.click(screen.getByRole('button', { name: 'Discard changes' }))

      expect(document.activeElement).toBe(screen.getByLabelText(/^Name/))
    })

    it('keeps what was typed when the restored input is dropped while open', async () => {
      const user = userEvent.setup()
      const { rerender, props } = renderCollectionEditor({ restored: { name: 'posts' } })
      await user.type(screen.getByLabelText(/^Label/), 'Typed')

      rerender(
        <CanopyCMSProvider>
          <CollectionEditor {...props} restored={null} />
        </CanopyCMSProvider>,
      )

      expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('posts')
      expect((screen.getByLabelText(/^Label/) as HTMLInputElement).value).toBe('Typed')
    })
  })
})
