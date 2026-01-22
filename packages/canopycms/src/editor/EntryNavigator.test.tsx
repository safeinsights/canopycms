// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EntryNavigator, type EntryNavCollection } from './EntryNavigator'
import { CanopyCMSProvider } from './theme'

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

  // Mock scrollIntoView for tree node selection
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderEntryNavigator = (props: Partial<React.ComponentProps<typeof EntryNavigator>> = {}) => {
  const defaultProps: React.ComponentProps<typeof EntryNavigator> = {
    onSelect: vi.fn(),
    ...props,
  }

  return {
    ...render(
      <CanopyCMSProvider>
        <EntryNavigator {...defaultProps} />
      </CanopyCMSProvider>,
    ),
    props: defaultProps,
  }
}

describe('EntryNavigator', () => {
  describe('basic rendering', () => {
    it('renders empty state when no items or collections', () => {
      renderEntryNavigator()
      expect(screen.getByText('No content')).toBeTruthy()
    })

    it('renders flat items', () => {
      renderEntryNavigator({
        items: [
          { path: 'posts/hello', label: 'Hello World' },
          { path: 'posts/goodbye', label: 'Goodbye World' },
        ],
      })

      expect(screen.getByText('Hello World')).toBeTruthy()
      expect(screen.getByText('Goodbye World')).toBeTruthy()
    })

    it('renders collections with entries', () => {
      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: 'posts/hello', label: 'Hello' },
            { path: 'posts/goodbye', label: 'Goodbye' },
          ],
        },
      ]

      renderEntryNavigator({ collections })

      expect(screen.getByText('Posts')).toBeTruthy()
    })

    it('selects entry on click', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()

      renderEntryNavigator({
        items: [{ path: 'posts/hello', label: 'Hello World' }],
        onSelect,
      })

      await user.click(screen.getByText('Hello World'))
      expect(onSelect).toHaveBeenCalledWith('posts/hello')
    })
  })

  describe('collection context menu', () => {
    it('shows context menu button on collections with actions', async () => {
      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          onEdit: vi.fn(),
          onDelete: vi.fn(),
        },
      ]

      renderEntryNavigator({ collections })

      // Should have a menu button for the collection
      expect(screen.getByTestId('collection-menu-posts')).toBeTruthy()
    })

    it('calls onEdit when Edit Collection is clicked', async () => {
      const user = userEvent.setup()
      const onEdit = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          onEdit,
        },
      ]

      renderEntryNavigator({ collections })

      // Open the menu
      await user.click(screen.getByTestId('collection-menu-posts'))

      // Wait for menu to open and click Edit
      await waitFor(() => {
        expect(screen.getByText('Edit Collection')).toBeTruthy()
      })
      await user.click(screen.getByText('Edit Collection'))

      expect(onEdit).toHaveBeenCalled()
    })

    it('calls onAddSubCollection when Add Sub-Collection is clicked', async () => {
      const user = userEvent.setup()
      const onAddSubCollection = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          onAddSubCollection,
        },
      ]

      renderEntryNavigator({ collections })

      await user.click(screen.getByTestId('collection-menu-posts'))

      await waitFor(() => {
        expect(screen.getByText('Add Sub-Collection')).toBeTruthy()
      })
      await user.click(screen.getByText('Add Sub-Collection'))

      expect(onAddSubCollection).toHaveBeenCalled()
    })

    it('calls onDelete when Delete Collection is clicked', async () => {
      const user = userEvent.setup()
      const onDelete = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          onDelete,
        },
      ]

      renderEntryNavigator({ collections })

      await user.click(screen.getByTestId('collection-menu-posts'))

      await waitFor(() => {
        expect(screen.getByText('Delete Collection')).toBeTruthy()
      })
      await user.click(screen.getByText('Delete Collection'))

      expect(onDelete).toHaveBeenCalled()
    })

    it('does not show menu button when no actions provided', () => {
      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
        },
      ]

      renderEntryNavigator({ collections })

      expect(screen.queryByTestId('collection-menu-posts')).toBeNull()
    })
  })

  describe('entry context menu', () => {
    it('shows delete menu on entries when onDeleteEntry is provided', async () => {
      const onDeleteEntry = vi.fn()

      renderEntryNavigator({
        items: [{ path: 'posts/hello', label: 'Hello World' }],
        onDeleteEntry,
      })

      expect(screen.getByTestId('entry-menu-hello-world')).toBeTruthy()
    })

    it('calls onDeleteEntry when Delete Entry is clicked', async () => {
      const user = userEvent.setup()
      const onDeleteEntry = vi.fn()

      renderEntryNavigator({
        items: [{ path: 'posts/hello', label: 'Hello World' }],
        onDeleteEntry,
      })

      await user.click(screen.getByTestId('entry-menu-hello-world'))

      await waitFor(() => {
        expect(screen.getByText('Delete Entry')).toBeTruthy()
      })
      await user.click(screen.getByText('Delete Entry'))

      expect(onDeleteEntry).toHaveBeenCalledWith('posts/hello')
    })

    it('does not show delete menu when onDeleteEntry is not provided', () => {
      renderEntryNavigator({
        items: [{ path: 'posts/hello', label: 'Hello World' }],
      })

      expect(screen.queryByTestId('entry-menu-hello-world')).toBeNull()
    })
  })

  describe('onAdd in menu', () => {
    it('shows Add Entry in collection menu when onAdd is provided', async () => {
      const user = userEvent.setup()
      const onAdd = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          onAdd,
          entries: [{ path: 'posts/hello', label: 'Hello' }],
        },
      ]

      renderEntryNavigator({ collections })

      // Open the collection menu
      await user.click(screen.getByTestId('collection-menu-posts'))

      // Add Entry should be visible in the menu
      await waitFor(() => {
        expect(screen.getByText('Add Entry')).toBeTruthy()
      })
    })

    it('calls onAdd when Add Entry menu item is clicked', async () => {
      const user = userEvent.setup()
      const onAdd = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          onAdd,
          entries: [{ path: 'posts/hello', label: 'Hello' }],
        },
      ]

      renderEntryNavigator({ collections })

      // Open the collection menu
      await user.click(screen.getByTestId('collection-menu-posts'))

      // Click Add Entry menu item
      await waitFor(() => {
        expect(screen.getByText('Add Entry')).toBeTruthy()
      })
      await user.click(screen.getByText('Add Entry'))

      expect(onAdd).toHaveBeenCalled()
    })
  })

  describe('entry status badge', () => {
    it('shows status badge on entries with status', () => {
      renderEntryNavigator({
        items: [{ path: 'posts/hello', label: 'Hello World', status: 'draft' }],
      })

      expect(screen.getByText('draft')).toBeTruthy()
    })
  })

  describe('entry reordering', () => {
    it('does not show move buttons when entries lack contentId', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()
      const onDeleteEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: 'posts/first', label: 'First' }, // No contentId!
            { path: 'posts/second', label: 'Second' }, // No contentId!
          ],
        },
      ]

      renderEntryNavigator({ collections, onReorderEntry, onDeleteEntry })

      // First expand the Posts collection
      await user.click(screen.getByTestId('entry-nav-item-posts'))

      // Wait for entries to appear
      await waitFor(() => {
        expect(screen.getByTestId('entry-nav-item-first')).toBeTruthy()
      })

      // Open the entry menu for the first entry - should still show due to onDeleteEntry
      await user.click(screen.getByTestId('entry-menu-first'))

      // Delete Entry should be visible
      await waitFor(() => {
        expect(screen.getByText('Delete Entry')).toBeTruthy()
      })

      // But Move Up/Down should NOT be visible since contentId is missing
      expect(screen.queryByText('Move Up')).toBeNull()
      expect(screen.queryByText('Move Down')).toBeNull()
    })

    it('shows move up/down buttons when onReorderEntry is provided', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: 'posts/first', label: 'First', contentId: 'abc123456789' },
            { path: 'posts/second', label: 'Second', contentId: 'def456789012' },
          ],
        },
      ]

      renderEntryNavigator({ collections, onReorderEntry })

      // First expand the Posts collection by clicking on it
      await user.click(screen.getByTestId('entry-nav-item-posts'))

      // Wait for entries to appear
      await waitFor(() => {
        expect(screen.getByTestId('entry-nav-item-first')).toBeTruthy()
      })

      // Open the entry menu for the first entry
      await user.click(screen.getByTestId('entry-menu-first'))

      await waitFor(() => {
        expect(screen.getByText('Move Up')).toBeTruthy()
        expect(screen.getByText('Move Down')).toBeTruthy()
      })
    })

    it('calls onReorderEntry with direction up when Move Up is clicked', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: 'posts/first', label: 'First', contentId: 'abc123456789' },
            { path: 'posts/second', label: 'Second', contentId: 'def456789012' },
          ],
        },
      ]

      renderEntryNavigator({ collections, onReorderEntry })

      // First expand the Posts collection
      await user.click(screen.getByTestId('entry-nav-item-posts'))

      // Wait for entries to appear
      await waitFor(() => {
        expect(screen.getByTestId('entry-nav-item-second')).toBeTruthy()
      })

      // Open the entry menu for the second entry
      await user.click(screen.getByTestId('entry-menu-second'))

      await waitFor(() => {
        expect(screen.getByText('Move Up')).toBeTruthy()
      })
      await user.click(screen.getByText('Move Up'))

      expect(onReorderEntry).toHaveBeenCalledWith('posts', 'def456789012', 'up')
    })

    it('calls onReorderEntry with direction down when Move Down is clicked', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: 'posts/first', label: 'First', contentId: 'abc123456789' },
            { path: 'posts/second', label: 'Second', contentId: 'def456789012' },
          ],
        },
      ]

      renderEntryNavigator({ collections, onReorderEntry })

      // First expand the Posts collection
      await user.click(screen.getByTestId('entry-nav-item-posts'))

      // Wait for entries to appear
      await waitFor(() => {
        expect(screen.getByTestId('entry-nav-item-first')).toBeTruthy()
      })

      // Open the entry menu for the first entry
      await user.click(screen.getByTestId('entry-menu-first'))

      await waitFor(() => {
        expect(screen.getByText('Move Down')).toBeTruthy()
      })
      await user.click(screen.getByText('Move Down'))

      expect(onReorderEntry).toHaveBeenCalledWith('posts', 'abc123456789', 'down')
    })

    it('disables Move Up for first entry', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: 'posts/first', label: 'First', contentId: 'abc123456789' },
            { path: 'posts/second', label: 'Second', contentId: 'def456789012' },
          ],
        },
      ]

      renderEntryNavigator({ collections, onReorderEntry })

      // First expand the Posts collection
      await user.click(screen.getByTestId('entry-nav-item-posts'))

      // Wait for entries to appear
      await waitFor(() => {
        expect(screen.getByTestId('entry-nav-item-first')).toBeTruthy()
      })

      // Open the entry menu for the first entry
      await user.click(screen.getByTestId('entry-menu-first'))

      await waitFor(() => {
        const moveUpItem = screen.getByText('Move Up').closest('button')
        // Mantine uses data-disabled for disabled menu items
        expect(moveUpItem?.hasAttribute('data-disabled')).toBe(true)
      })
    })

    it('disables Move Down for last entry', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: 'posts',
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: 'posts/first', label: 'First', contentId: 'abc123456789' },
            { path: 'posts/second', label: 'Second', contentId: 'def456789012' },
          ],
        },
      ]

      renderEntryNavigator({ collections, onReorderEntry })

      // First expand the Posts collection
      await user.click(screen.getByTestId('entry-nav-item-posts'))

      // Wait for entries to appear
      await waitFor(() => {
        expect(screen.getByTestId('entry-nav-item-second')).toBeTruthy()
      })

      // Open the entry menu for the last entry
      await user.click(screen.getByTestId('entry-menu-second'))

      await waitFor(() => {
        const moveDownItem = screen.getByText('Move Down').closest('button')
        // Mantine uses data-disabled for disabled menu items
        expect(moveDownItem?.hasAttribute('data-disabled')).toBe(true)
      })
    })
  })
})
