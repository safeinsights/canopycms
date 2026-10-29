// @vitest-environment jsdom
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EntryNavigator,
  type BranchChangesView,
  type EntryFilter,
  type EntryNavCollection,
  type EntryNavItem,
} from './EntryNavigator'
import { CanopyCMSProvider } from './theme'
import { UnsavedMark } from './components/UnsavedMark'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

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

const BRANCH_REASON = 'This branch is in review. Withdraw it to make changes.'

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

/**
 * One entry in each shape the navigator takes it: a flat item, an entry of a collection (as the
 * editor passes it), and a collection node of type "entry".
 */
const ENTRY_SHAPES: Array<
  [string, (entry: EntryNavItem) => Partial<React.ComponentProps<typeof EntryNavigator>>]
> = [
  [
    'a flat item',
    (entry) => ({
      items: [entry, { path: unsafeAsLogicalPath('content/pages/about'), label: 'About' }],
    }),
  ],
  [
    'an entry of a collection',
    (entry) => ({
      collections: [
        {
          path: unsafeAsLogicalPath('content/pages'),
          label: 'Pages',
          type: 'collection',
          entries: [entry, { path: unsafeAsLogicalPath('content/pages/about'), label: 'About' }],
        },
      ],
      expandedStateRef: { current: { 'collection:content/pages': true } },
    }),
  ],
  [
    'an entry node',
    (entry) => ({
      collections: [
        { path: entry.path, label: 'Node', type: 'entry', entries: [entry] },
        {
          path: unsafeAsLogicalPath('content/about'),
          label: 'About',
          type: 'entry',
          entries: [{ path: unsafeAsLogicalPath('content/about'), label: 'About' }],
        },
      ],
    }),
  ],
]

describe('EntryNavigator', () => {
  describe('basic rendering', () => {
    it('renders empty state when no items or collections', () => {
      renderEntryNavigator()
      expect(screen.getByText('No content')).toBeTruthy()
    })

    it('renders flat items', () => {
      renderEntryNavigator({
        items: [
          { path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' },
          {
            path: unsafeAsLogicalPath('posts/goodbye'),
            label: 'Goodbye World',
          },
        ],
      })

      expect(screen.getByText('Hello World')).toBeTruthy()
      expect(screen.getByText('Goodbye World')).toBeTruthy()
    })

    it('renders collections with entries', () => {
      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: unsafeAsLogicalPath('posts/hello'), label: 'Hello' },
            { path: unsafeAsLogicalPath('posts/goodbye'), label: 'Goodbye' },
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
        items: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }],
        onSelect,
      })

      await user.click(screen.getByText('Hello World'))
      expect(onSelect).toHaveBeenCalledWith('posts/hello')
    })
  })

  describe('loading state', () => {
    it('shows a loading indicator instead of "No content" when loading with an empty tree', () => {
      renderEntryNavigator({ loading: true })
      expect(screen.getByText('Loading content…')).toBeTruthy()
      expect(screen.queryByText('No content')).toBeNull()
    })

    it('shows "No content" when not loading and the tree is empty', () => {
      renderEntryNavigator({ loading: false })
      expect(screen.getByText('No content')).toBeTruthy()
      expect(screen.queryByText('Loading content…')).toBeNull()
    })

    it('says a branch it may not open is out of reach, and offers Switch branch…', async () => {
      const onSwitchBranch = vi.fn()
      for (const loading of [false, true]) {
        renderEntryNavigator({ loading, branchNotAvailable: true, onSwitchBranch })
        expect(screen.getByTestId('entry-nav-branch-not-available').textContent).toContain(
          "You don't have access to this branch, or it no longer exists.",
        )
        expect(screen.queryByText('No content')).toBeNull()
        expect(screen.queryByText('Loading content…')).toBeNull()
        await userEvent.click(screen.getByRole('button', { name: 'Switch branch…' }))
        cleanup()
      }
      expect(onSwitchBranch).toHaveBeenCalledTimes(2)
    })

    it('shows content (not the loader) once items have loaded, even if loading is still true', () => {
      renderEntryNavigator({
        loading: true,
        items: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }],
      })
      expect(screen.getByText('Hello World')).toBeTruthy()
      expect(screen.queryByText('Loading content…')).toBeNull()
    })
  })

  describe('collection context menu', () => {
    it('shows context menu button on collections with actions', async () => {
      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
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
          path: unsafeAsLogicalPath('posts'),
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
        expect(screen.getByText('Edit collection…')).toBeTruthy()
      })
      await user.click(screen.getByText('Edit collection…'))

      expect(onEdit).toHaveBeenCalled()
    })

    it('calls onAddSubCollection when Add Sub-Collection is clicked', async () => {
      const user = userEvent.setup()
      const onAddSubCollection = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          onAddSubCollection,
        },
      ]

      renderEntryNavigator({ collections })

      await user.click(screen.getByTestId('collection-menu-posts'))

      await waitFor(() => {
        expect(screen.getByText('Add sub-collection…')).toBeTruthy()
      })
      await user.click(screen.getByText('Add sub-collection…'))

      expect(onAddSubCollection).toHaveBeenCalled()
    })

    it('calls onDelete when Delete Collection is clicked', async () => {
      const user = userEvent.setup()
      const onDelete = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          onDelete,
        },
      ]

      renderEntryNavigator({ collections })

      await user.click(screen.getByTestId('collection-menu-posts'))

      await waitFor(() => {
        expect(screen.getByText('Delete collection')).toBeTruthy()
      })
      await user.click(screen.getByText('Delete collection'))

      expect(onDelete).toHaveBeenCalled()
    })

    it('does not show menu button when no actions provided', () => {
      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
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
        items: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }],
        onDeleteEntry,
      })

      expect(screen.getByTestId('entry-menu-hello-world')).toBeTruthy()
    })

    it('calls onDeleteEntry when Delete Entry is clicked', async () => {
      const user = userEvent.setup()
      const onDeleteEntry = vi.fn()

      renderEntryNavigator({
        items: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }],
        onDeleteEntry,
      })

      await user.click(screen.getByTestId('entry-menu-hello-world'))

      await waitFor(() => {
        expect(screen.getByText('Delete entry')).toBeTruthy()
      })
      await user.click(screen.getByText('Delete entry'))

      expect(onDeleteEntry).toHaveBeenCalledWith('posts/hello')
    })

    it('does not show delete menu when onDeleteEntry is not provided', () => {
      renderEntryNavigator({
        items: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }],
      })

      expect(screen.queryByTestId('entry-menu-hello-world')).toBeNull()
    })
  })

  describe('a collection path rules refuse new entries in', () => {
    const posts = (extra: Partial<EntryNavCollection> = {}): EntryNavCollection => ({
      path: unsafeAsLogicalPath('posts'),
      label: 'Posts',
      type: 'collection',
      entries: [{ path: unsafeAsLogicalPath('posts/first'), label: 'First', readOnly: true }],
      ...extra,
    })

    it('says so once, under the collection', () => {
      renderEntryNavigator({
        collections: [
          posts({ addRefused: true }),
          posts({ path: unsafeAsLogicalPath('pages'), label: 'Pages' }),
        ],
      })

      const messages = screen.getAllByTestId('add-refused-message')
      expect(messages).toHaveLength(1)
      expect(messages[0].textContent).toBe("You can't add entries here.")
      expect(screen.getByTestId('entry-nav-item-posts').contains(messages[0])).toBe(true)
    })

    it('says so above the tree for a hidden root collection', () => {
      renderEntryNavigator({ collections: [posts({ addRefused: true })], hiddenRootPath: 'posts' })

      const message = screen.getByTestId('add-refused-message')
      expect(
        message.compareDocumentPosition(screen.getByTestId('entry-nav-item-first')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })

    it("leaves it to the branch bar's status in a read-only navigator", () => {
      renderEntryNavigator({ collections: [posts({ addRefused: true })], readOnly: true })

      expect(screen.queryByTestId('add-refused-message')).toBeNull()
    })
  })

  describe('unavailable entry types', () => {
    const widgets = (extra: Partial<EntryNavCollection> = {}): EntryNavCollection => ({
      path: unsafeAsLogicalPath('widgets'),
      label: 'Widgets',
      type: 'collection',
      entries: [{ path: unsafeAsLogicalPath('widgets/first'), label: 'First' }],
      ...extra,
    })

    it('shows the shared message once for a collection that has unavailable entry types', () => {
      renderEntryNavigator({
        collections: [widgets({ unavailableSchemaRefs: ['widgetSchema', 'gadgetSchema'] })],
      })

      const messages = screen.getAllByTestId('unavailable-type-message')
      expect(messages).toHaveLength(1)
      expect(messages[0].textContent).toBe(
        "This section uses a content type this editor version doesn't know yet (widgetSchema, gadgetSchema). It usually appears after the editor finishes updating; reload in a few minutes.",
      )
    })

    it('renders a collection without unavailable types with no message', () => {
      renderEntryNavigator({
        collections: [
          widgets(),
          widgets({ path: unsafeAsLogicalPath('other'), unavailableSchemaRefs: [] }),
        ],
      })

      expect(screen.queryByTestId('unavailable-type-message')).toBeNull()
    })

    it('shows the message once above the tree when the hidden root collection has unavailable types', () => {
      renderEntryNavigator({
        collections: [widgets({ unavailableSchemaRefs: ['widgetSchema'] })],
        hiddenRootPath: 'widgets',
      })

      // The root's own row is not rendered; its entries are the top level.
      expect(screen.queryByTestId('entry-nav-item-widgets')).toBeNull()
      const first = screen.getByTestId('entry-nav-item-first')
      const messages = screen.getAllByTestId('unavailable-type-message')
      expect(messages).toHaveLength(1)
      expect(messages[0].textContent).toContain('widgetSchema')
      expect(
        messages[0].compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })

    it('shows no message for a hidden root collection whose types are all available', () => {
      renderEntryNavigator({ collections: [widgets()], hiddenRootPath: 'widgets' })

      expect(screen.getByTestId('entry-nav-item-first')).toBeTruthy()
      expect(screen.queryByTestId('unavailable-type-message')).toBeNull()
    })

    it('offers no entry menu for an unavailable entry, and still offers it for an available one', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        collections: [
          widgets({
            entries: [
              { path: unsafeAsLogicalPath('widgets/first'), label: 'First', unavailable: true },
              { path: unsafeAsLogicalPath('widgets/second'), label: 'Second' },
            ],
          }),
        ],
        onDeleteEntry: vi.fn(),
        onRenameEntry: vi.fn(),
      })

      await user.click(screen.getByTestId('entry-nav-item-widgets'))
      await waitFor(() => expect(screen.getByTestId('entry-nav-item-first')).toBeTruthy())

      expect(screen.getByTestId('entry-menu-second')).toBeTruthy()
      expect(screen.queryByTestId('entry-menu-first')).toBeNull()
    })
  })

  describe('onAdd in menu', () => {
    it('shows Add Entry in collection menu when onAdd is provided', async () => {
      const user = userEvent.setup()
      const onAdd = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          onAdd,
          entries: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello' }],
        },
      ]

      renderEntryNavigator({ collections })

      // Open the collection menu
      await user.click(screen.getByTestId('collection-menu-posts'))

      // Add Entry should be visible in the menu
      await waitFor(() => {
        expect(screen.getByText('Add entry…')).toBeTruthy()
      })
    })

    it('calls onAdd when Add Entry menu item is clicked', async () => {
      const user = userEvent.setup()
      const onAdd = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          onAdd,
          entries: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello' }],
        },
      ]

      renderEntryNavigator({ collections })

      // Open the collection menu
      await user.click(screen.getByTestId('collection-menu-posts'))

      // Click Add Entry menu item
      await waitFor(() => {
        expect(screen.getByText('Add entry…')).toBeTruthy()
      })
      await user.click(screen.getByText('Add entry…'))

      expect(onAdd).toHaveBeenCalled()
    })
  })

  describe('branch lock', () => {
    const post = { path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }
    const collection = (extra: Partial<EntryNavCollection> = {}): EntryNavCollection => ({
      path: unsafeAsLogicalPath('posts'),
      label: 'Posts',
      type: 'collection',
      onAdd: vi.fn(),
      ...extra,
    })

    it('shows a lock with the branch reason, and no menu, on a locked branch', () => {
      renderEntryNavigator({
        items: [post],
        collections: undefined,
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      const row = screen.getByTestId('entry-nav-item-hello-world')
      const lock = within(row).getByTestId('branch-lock')
      expect(lock.getAttribute('aria-label')).toBe('Entry actions')
      expect(lock.getAttribute('aria-disabled')).toBe('true')
      expect(lock.getAttribute('aria-describedby')).toBeTruthy()
      expect(document.getElementById(lock.getAttribute('aria-describedby')!)?.textContent).toBe(
        BRANCH_REASON,
      )
      expect(screen.queryByTestId('entry-menu-hello-world')).toBeNull()
    })

    it('shows the lock on a collection row that would have had a menu', () => {
      renderEntryNavigator({
        collections: [collection()],
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      const row = screen.getByTestId('entry-nav-item-posts')
      expect(within(row).getByTestId('branch-lock').getAttribute('aria-label')).toBe(
        'Collection actions',
      )
      expect(screen.queryByTestId('collection-menu-posts')).toBeNull()
    })

    it('holds an empty slot, not a lock, while the branch reason is not yet known', () => {
      renderEntryNavigator({ items: [post], onDeleteEntry: vi.fn(), readOnly: true })

      const row = screen.getByTestId('entry-nav-item-hello-world')
      expect(within(row).getByTestId('branch-lock-pending')).toBeTruthy()
      expect(screen.queryByTestId('branch-lock')).toBeNull()
      expect(screen.queryByTestId('entry-menu-hello-world')).toBeNull()
    })

    /**
     * The `opacity` the provider's stylesheet gives `element`, read from the rules whose selector
     * matches it. jsdom cannot evaluate `:hover` or `:focus-within`, so a rule using one is matched
     * with the pseudo-class stripped, and only when the state holds: `hovered`, or focus inside the
     * row that the rule's selector names. Every other selector, `:focus >` included, is matched whole.
     */
    const lockOpacities = (element: Element, { hovered = false } = {}): string[] => {
      const sheet = document.querySelector<HTMLStyleElement>('style[data-canopy-styles]')?.sheet
      if (!sheet) throw new Error('no canopy stylesheet')
      const row = element.closest('[data-nav-row]')
      return Array.from(sheet.cssRules).flatMap((rule) => {
        if (!(rule instanceof CSSStyleRule) || rule.style.getPropertyValue('opacity') === '')
          return []
        const applies = rule.selectorText.split(',').some((selector) => {
          const trimmed = selector.trim()
          if (trimmed.includes(':hover')) {
            return hovered && element.matches(trimmed.replace(':hover', ''))
          }
          if (trimmed.includes(':focus >')) return element.matches(trimmed)
          if (trimmed.includes(':focus-within')) {
            return (
              !!row?.contains(document.activeElement) &&
              element.matches(trimmed.replace(':focus-within', ''))
            )
          }
          return element.matches(trimmed)
        })
        return applies ? [rule.style.getPropertyValue('opacity')] : []
      })
    }

    const twoPosts = [post, { path: unsafeAsLogicalPath('posts/second'), label: 'Second' }]

    it('keeps every locked row focusable and named, but draws the lock only on the selected row', () => {
      renderEntryNavigator({
        items: twoPosts,
        collections: undefined,
        selectedPath: post.path,
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      const selectedLock = within(screen.getByTestId('entry-nav-item-hello-world')).getByTestId(
        'branch-lock',
      )
      const otherLock = within(screen.getByTestId('entry-nav-item-second')).getByTestId(
        'branch-lock',
      )

      expect(lockOpacities(otherLock)).toEqual(['0'])
      expect(lockOpacities(selectedLock)).toEqual(['0', '1'])
      expect(lockOpacities(otherLock, { hovered: true })).toEqual(['0', '1'])
      for (const lock of [selectedLock, otherLock]) {
        expect(lock.getAttribute('aria-label')).toBe('Entry actions')
        expect(lock.getAttribute('aria-disabled')).toBe('true')
        expect(lock.getAttribute('tabindex')).not.toBe('-1')
        expect(document.getElementById(lock.getAttribute('aria-describedby')!)?.textContent).toBe(
          BRANCH_REASON,
        )
      }
    })

    it('draws the lock on a row with focus inside it', () => {
      renderEntryNavigator({
        items: twoPosts,
        collections: undefined,
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })
      const locks = screen.getAllByTestId('branch-lock')

      expect(locks.map((lock) => lockOpacities(lock))).toEqual([['0'], ['0']])
      locks[1].focus()

      expect(lockOpacities(locks[0])).toEqual(['0'])
      expect(lockOpacities(locks[1])).toEqual(['0', '1'])
    })

    it('draws the lock on a row whose tree item has focus, not on its neighbours', () => {
      renderEntryNavigator({
        items: twoPosts,
        collections: undefined,
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })
      const locks = screen.getAllByTestId('branch-lock')
      const treeItem = locks[1].closest<HTMLElement>('[role=treeitem]')!
      treeItem.focus()

      expect(document.activeElement).toBe(treeItem)
      expect(lockOpacities(locks[0])).toEqual(['0'])
      expect(lockOpacities(locks[1])).toEqual(['0', '1'])
    })

    it("does not draw a nested row's lock when its parent tree item has focus", () => {
      renderEntryNavigator({
        collections: [
          collection({
            entries: [
              { path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' },
              { path: unsafeAsLogicalPath('posts/second'), label: 'Second' },
            ],
          }),
        ],
        selectedPath: unsafeAsLogicalPath('posts/second'),
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })
      const parentLock = within(screen.getByTestId('entry-nav-item-posts')).getByTestId(
        'branch-lock',
      )
      const childLock = within(screen.getByTestId('entry-nav-item-hello-world')).getByTestId(
        'branch-lock',
      )
      parentLock.closest<HTMLElement>('[role=treeitem]')!.focus()

      expect(lockOpacities(parentLock)).toEqual(['0', '1'])
      expect(lockOpacities(childLock)).toEqual(['0'])
    })

    it('leaves a hidden lock untouchable, so a tap on its slot reaches the row', () => {
      renderEntryNavigator({
        items: twoPosts,
        collections: undefined,
        selectedPath: post.path,
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })
      const sheet = document.querySelector<HTMLStyleElement>('style[data-canopy-styles]')!.sheet!
      const pointerEvents = (lock: HTMLElement) =>
        Array.from(sheet.cssRules).flatMap((rule) =>
          rule instanceof CSSStyleRule &&
          rule.style.getPropertyValue('pointer-events') !== '' &&
          rule.selectorText.split(',').some((selector) => lock.matches(selector.trim()))
            ? [rule.style.getPropertyValue('pointer-events')]
            : [],
        )
      const [selectedLock, otherLock] = screen.getAllByTestId('branch-lock')

      expect(pointerEvents(otherLock)).toEqual(['none'])
      expect(pointerEvents(selectedLock)).toEqual(['none', 'auto'])
    })

    it('hides the lock by opacity, never by display or visibility', () => {
      renderEntryNavigator({
        items: [post],
        collections: undefined,
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })
      const css = document.querySelector('style[data-canopy-styles]')!.textContent!
      const rules = css.match(/[^{}]*\[data-row-lock\][^{}]*\{[^}]*\}/g) ?? []

      expect(rules.length).toBeGreaterThan(0)
      expect(rules.join('')).not.toMatch(/display\s*:|visibility\s*:/)
    })

    it('keeps Space on the lock from expanding or collapsing its row', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        collections: [
          collection({
            entries: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }],
          }),
        ],
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })
      const childShown = () => screen.queryByText('Hello World') !== null

      expect(childShown()).toBe(false)
      screen.getByTestId('branch-lock').focus()
      await user.keyboard(' ')

      expect(childShown()).toBe(false)
    })

    it('shows no lock on a row that would have had no menu anyway', () => {
      renderEntryNavigator({
        items: [post],
        collections: undefined,
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      expect(screen.queryByTestId('branch-lock')).toBeNull()
    })

    it('shows no lock on a collection row with no menu actions', () => {
      renderEntryNavigator({
        collections: [collection({ onAdd: undefined })],
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      expect(screen.getByTestId('entry-nav-item-posts')).toBeTruthy()
      expect(screen.queryByTestId('branch-lock')).toBeNull()
    })

    it('shows no lock on an unavailable entry', () => {
      renderEntryNavigator({
        collections: [collection({ onAdd: undefined, entries: [{ ...post, unavailable: true }] })],
        expandedStateRef: { current: { 'collection:posts': true } },
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      expect(screen.getByTestId('entry-nav-item-hello-world')).toBeTruthy()
      expect(screen.queryByTestId('branch-lock')).toBeNull()
    })

    it('shows the lock on a row whose only menu action is reordering', () => {
      renderEntryNavigator({
        items: [post],
        onReorderEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      expect(
        within(screen.getByTestId('entry-nav-item-hello-world')).getByTestId('branch-lock'),
      ).toBeTruthy()
    })

    it('shows the menu and no lock on an editing branch', () => {
      renderEntryNavigator({
        items: [post],
        onDeleteEntry: vi.fn(),
        readOnlyReason: BRANCH_REASON,
      })

      expect(screen.getByTestId('entry-menu-hello-world')).toBeTruthy()
      expect(screen.queryByTestId('branch-lock')).toBeNull()
    })

    it('opens the reason on keyboard focus', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        items: [post],
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      await user.tab()
      const lock = screen.getByTestId('branch-lock')
      lock.focus()

      expect((await screen.findByRole('tooltip')).textContent).toBe(BRANCH_REASON)
    })

    it('does not select the row when the lock is clicked', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      renderEntryNavigator({
        items: [post],
        selectedPath: post.path,
        onSelect,
        onDeleteEntry: vi.fn(),
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
      })

      await user.click(screen.getByTestId('branch-lock'))
      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  describe('readOnly mode', () => {
    it('hides the entry menu even when onDeleteEntry/onRenameEntry/onReorderEntry are provided', () => {
      renderEntryNavigator({
        items: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }],
        onDeleteEntry: vi.fn(),
        onRenameEntry: vi.fn(),
        onReorderEntry: vi.fn(),
        readOnly: true,
      })

      expect(screen.queryByTestId('entry-menu-hello-world')).toBeNull()
    })

    it('hides the collection menu even when onAdd/onEdit/onDelete are provided', () => {
      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          onAdd: vi.fn(),
          onEdit: vi.fn(),
          onAddSubCollection: vi.fn(),
          onDelete: vi.fn(),
        },
      ]

      renderEntryNavigator({ collections, readOnly: true })

      expect(screen.queryByTestId('collection-menu-posts')).toBeNull()
    })

    it('still allows selecting entries when readOnly', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()

      renderEntryNavigator({
        items: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World' }],
        onSelect,
        readOnly: true,
      })

      await user.click(screen.getByText('Hello World'))
      expect(onSelect).toHaveBeenCalledWith('posts/hello')
    })
  })

  describe('entry detail line', () => {
    const detailLine = (row: HTMLElement) => within(row).queryByTestId('entry-nav-detail')

    it('shows the type dimmed on a second line under the title, with no badge', () => {
      renderEntryNavigator({
        items: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello World', status: 'Post' }],
      })

      const row = screen.getByTestId('entry-nav-item-hello-world')
      const detail = detailLine(row)!
      expect(detail.textContent).toBe('Post')
      expect(detail.querySelector('p')?.getAttribute('style')).toContain('--mantine-color-dimmed')
      expect(
        within(row).getByText('Hello World').compareDocumentPosition(detail) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      expect(row.querySelector('.mantine-Badge-root')).toBeNull()
    })

    it.each(ENTRY_SHAPES)('shows the type and the route, as %s', (_, shape) => {
      renderEntryNavigator(
        shape({
          path: unsafeAsLogicalPath('content/pages/contact'),
          label: 'Contact',
          status: 'Landing page',
          route: '/contact',
        }),
      )

      const detail = detailLine(screen.getByTestId('entry-nav-item-contact'))!
      expect(detail.textContent).toBe('Landing page · /contact')
      expect(detail.querySelector('p')?.getAttribute('style')).toContain('--mantine-color-dimmed')
    })

    it('shows the route alone for an entry whose label already names its type', () => {
      renderEntryNavigator({
        items: [{ path: unsafeAsLogicalPath('home'), label: 'Home', route: '/' }],
      })
      expect(detailLine(screen.getByTestId('entry-nav-item-home'))!.textContent).toBe('/')
    })

    it('shows the type alone for an entry with no page', () => {
      renderEntryNavigator({
        items: [
          {
            path: unsafeAsLogicalPath('settings'),
            label: 'Settings',
            status: 'Site settings',
            route: '/settings',
            noPage: true,
          },
        ],
      })
      expect(detailLine(screen.getByTestId('entry-nav-item-settings'))!.textContent).toBe(
        'Site settings',
      )
    })

    it.each(ENTRY_SHAPES)('shows Missing in error text in place of the type, as %s', (_, shape) => {
      renderEntryNavigator(
        shape({
          path: unsafeAsLogicalPath('content/pages/gone'),
          label: 'Gone',
          status: 'Missing',
          route: '/gone',
          missing: true,
        }),
      )

      const detail = detailLine(screen.getByTestId('entry-nav-item-gone'))!
      expect(detail.textContent).toBe('Missing')
      expect(detail.querySelector('p')?.getAttribute('style')).toContain('--canopy-danger-text')
    })

    it('keeps an entry without a type or route, and a collection, on one line', () => {
      renderEntryNavigator({
        collections: [
          {
            path: unsafeAsLogicalPath('posts'),
            label: 'Posts',
            type: 'collection',
            entries: [{ path: unsafeAsLogicalPath('posts/settings'), label: 'Site settings' }],
          },
        ],
        expandedStateRef: { current: { 'collection:posts': true } },
      })

      expect(detailLine(screen.getByTestId('entry-nav-item-posts'))).toBeNull()
      expect(detailLine(screen.getByTestId('entry-nav-item-site-settings'))).toBeNull()
    })

    it('shows a cut-off detail line in full while its row has focus', async () => {
      renderEntryNavigator({
        items: [
          {
            path: unsafeAsLogicalPath('content/pages/contact'),
            label: 'Contact',
            status: 'Landing page',
            route: '/a/long/route/to/contact',
          },
        ],
      })
      const row = screen.getByTestId('entry-nav-item-contact')
      const text = detailLine(row)!.querySelector('p')!
      // jsdom lays nothing out, so the line reports itself cut off.
      Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 200 })
      Object.defineProperty(text, 'clientWidth', { configurable: true, value: 100 })
      const item = row.closest<HTMLElement>('[role="treeitem"]')!

      act(() => item.focus())

      // After the hover tooltip's delay, so arrowing through the tree doesn't flash one per row.
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(screen.queryByRole('tooltip')).toBeNull()
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip.textContent).toBe('Landing page · /a/long/route/to/contact')
      // Below the row, so its title stays in view: jsdom's empty boxes put a tooltip above at a
      // negative top.
      expect(parseFloat(tooltip.style.top)).toBeGreaterThan(0)
      act(() => item.blur())
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    })

    it('shows no focus tooltip for a detail line that fits', async () => {
      renderEntryNavigator({
        items: [
          {
            path: unsafeAsLogicalPath('content/pages/contact'),
            label: 'Contact',
            status: 'Landing page',
            route: '/contact',
          },
        ],
      })
      const item = screen
        .getByTestId('entry-nav-item-contact')
        .closest<HTMLElement>('[role="treeitem"]')!

      act(() => item.focus())
      await new Promise((resolve) => setTimeout(resolve, 600))

      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it("hides the focused row's tooltip on Escape, taking the key, until focus next arrives", async () => {
      renderEntryNavigator({
        items: [
          {
            path: unsafeAsLogicalPath('content/pages/contact'),
            label: 'Contact',
            status: 'Landing page',
            route: '/a/long/route/to/contact',
          },
        ],
      })
      const row = screen.getByTestId('entry-nav-item-contact')
      const text = detailLine(row)!.querySelector('p')!
      Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 200 })
      Object.defineProperty(text, 'clientWidth', { configurable: true, value: 100 })
      const item = row.closest<HTMLElement>('[role="treeitem"]')!
      act(() => item.focus())
      await screen.findByRole('tooltip')
      // PreviewPane's capture-phase Escape skips a target with this mark, so one press hides only.
      expect(item.getAttribute('data-mantine-stop-propagation')).toBe('true')

      expect(fireEvent.keyDown(item, { key: 'Escape' })).toBe(false)
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
      expect(item.hasAttribute('data-mantine-stop-propagation')).toBe(false)
      // With nothing left to hide, Escape is the panel's again.
      expect(fireEvent.keyDown(item, { key: 'Escape' })).toBe(true)

      act(() => item.blur())
      act(() => item.focus())
      expect((await screen.findByRole('tooltip')).textContent).toBe(
        'Landing page · /a/long/route/to/contact',
      )
    })

    it("hides the focus tooltip when the row's detail changes under it", async () => {
      const contact = (status: string) => [
        {
          path: unsafeAsLogicalPath('content/pages/contact'),
          label: 'Contact',
          status,
          route: '/a/long/route/to/contact',
        },
      ]
      const { rerender, props } = renderEntryNavigator({ items: contact('Landing page') })
      const cutOff = () => {
        const text = detailLine(screen.getByTestId('entry-nav-item-contact'))!.querySelector('p')!
        Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 200 })
        Object.defineProperty(text, 'clientWidth', { configurable: true, value: 100 })
      }
      cutOff()
      const item = screen
        .getByTestId('entry-nav-item-contact')
        .closest<HTMLElement>('[role="treeitem"]')!
      act(() => item.focus())
      await screen.findByRole('tooltip')

      rerender(
        <CanopyCMSProvider>
          <EntryNavigator {...props} items={contact('Article')} />
        </CanopyCMSProvider>,
      )

      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
      expect(item.hasAttribute('data-mantine-stop-propagation')).toBe(false)
    })
  })

  describe('row menus', () => {
    it('calls onRowMenuOpen when an entry or collection menu opens', async () => {
      const user = userEvent.setup()
      const onRowMenuOpen = vi.fn()
      renderEntryNavigator({
        collections: [
          {
            path: unsafeAsLogicalPath('posts'),
            label: 'Posts',
            type: 'collection',
            onAdd: vi.fn(),
            entries: [{ path: unsafeAsLogicalPath('posts/hello'), label: 'Hello' }],
          },
        ],
        expandedStateRef: { current: { 'collection:posts': true } },
        onDeleteEntry: vi.fn(),
        onRowMenuOpen,
      })

      await user.click(screen.getByTestId('collection-menu-posts'))
      expect(onRowMenuOpen).toHaveBeenCalledTimes(1)
      await user.keyboard('{Escape}')
      await user.click(screen.getByTestId('entry-menu-hello'))
      expect(onRowMenuOpen).toHaveBeenCalledTimes(2)
    })
  })

  describe('entry reordering', () => {
    it('does not show move buttons when entries lack contentId', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()
      const onDeleteEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          entries: [
            { path: unsafeAsLogicalPath('posts/first'), label: 'First' }, // No contentId!
            { path: unsafeAsLogicalPath('posts/second'), label: 'Second' }, // No contentId!
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
        expect(screen.getByText('Delete entry')).toBeTruthy()
      })

      // But Move Up/Down should NOT be visible since contentId is missing
      expect(screen.queryByText('Move up')).toBeNull()
      expect(screen.queryByText('Move down')).toBeNull()
    })

    it('shows move up/down buttons when onReorderEntry is provided', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          entries: [
            {
              path: unsafeAsLogicalPath('posts/first'),
              label: 'First',
              contentId: unsafeAsContentId('abc123456789'),
            },
            {
              path: unsafeAsLogicalPath('posts/second'),
              label: 'Second',
              contentId: unsafeAsContentId('def456789012'),
            },
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
        expect(screen.getByText('Move up')).toBeTruthy()
        expect(screen.getByText('Move down')).toBeTruthy()
      })
    })

    it('calls onReorderEntry with direction up when Move Up is clicked', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          entries: [
            {
              path: unsafeAsLogicalPath('posts/first'),
              label: 'First',
              contentId: unsafeAsContentId('abc123456789'),
            },
            {
              path: unsafeAsLogicalPath('posts/second'),
              label: 'Second',
              contentId: unsafeAsContentId('def456789012'),
            },
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
        expect(screen.getByText('Move up')).toBeTruthy()
      })
      await user.click(screen.getByText('Move up'))

      expect(onReorderEntry).toHaveBeenCalledWith('posts', 'def456789012', 'up')
    })

    it('calls onReorderEntry with direction down when Move Down is clicked', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          entries: [
            {
              path: unsafeAsLogicalPath('posts/first'),
              label: 'First',
              contentId: unsafeAsContentId('abc123456789'),
            },
            {
              path: unsafeAsLogicalPath('posts/second'),
              label: 'Second',
              contentId: unsafeAsContentId('def456789012'),
            },
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
        expect(screen.getByText('Move down')).toBeTruthy()
      })
      await user.click(screen.getByText('Move down'))

      expect(onReorderEntry).toHaveBeenCalledWith('posts', 'abc123456789', 'down')
    })

    it('blocks Move up for the first entry, saying why, and does not reorder', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          entries: [
            {
              path: unsafeAsLogicalPath('posts/first'),
              label: 'First',
              contentId: unsafeAsContentId('abc123456789'),
            },
            {
              path: unsafeAsLogicalPath('posts/second'),
              label: 'Second',
              contentId: unsafeAsContentId('def456789012'),
            },
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

      const moveUpItem = (await screen.findByText('Move up')).closest('button')
      // `aria-disabled`, not `disabled`, so the item stays in the menu's keyboard order.
      expect(moveUpItem?.getAttribute('aria-disabled')).toBe('true')
      expect(moveUpItem?.hasAttribute('disabled')).toBe(false)
      expect(within(moveUpItem as HTMLElement).getByText('Already first')).toBeTruthy()
      await user.click(moveUpItem as HTMLElement)
      expect(onReorderEntry).not.toHaveBeenCalled()
    })

    it('blocks Move down for the last entry, saying why, and does not reorder', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()

      const collections: EntryNavCollection[] = [
        {
          path: unsafeAsLogicalPath('posts'),
          label: 'Posts',
          type: 'collection',
          entries: [
            {
              path: unsafeAsLogicalPath('posts/first'),
              label: 'First',
              contentId: unsafeAsContentId('abc123456789'),
            },
            {
              path: unsafeAsLogicalPath('posts/second'),
              label: 'Second',
              contentId: unsafeAsContentId('def456789012'),
            },
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

      const moveDownItem = (await screen.findByText('Move down')).closest('button')
      expect(moveDownItem?.getAttribute('aria-disabled')).toBe('true')
      expect(within(moveDownItem as HTMLElement).getByText('Already last')).toBeTruthy()
      await user.click(moveDownItem as HTMLElement)
      expect(onReorderEntry).not.toHaveBeenCalled()
    })
  })

  describe('filter', () => {
    const lp = unsafeAsLogicalPath
    const cid = unsafeAsContentId
    const filterCollections = (): EntryNavCollection[] => [
      {
        path: lp('content/guides'),
        label: 'Guides',
        type: 'collection',
        order: ['guide0000001', 'guide0000002', 'guide0000003'],
        entries: [
          {
            path: lp('content/guides/getting-started'),
            label: 'Getting started',
            slug: 'getting-started',
            contentId: cid('guide0000001'),
          },
          {
            path: lp('content/guides/data-access'),
            label: 'Data access',
            slug: 'access-rules',
            contentId: cid('guide0000002'),
          },
          {
            path: lp('content/guides/privacy'),
            label: 'Privacy',
            slug: 'privacy',
            contentId: cid('guide0000003'),
          },
        ],
      },
      {
        path: lp('content/news'),
        label: 'News',
        type: 'collection',
        entries: [{ path: lp('content/news/launch'), label: 'Launch day' }],
      },
      {
        path: lp('content/reference'),
        label: 'Reference',
        type: 'collection',
        children: [
          {
            path: lp('content/reference/api'),
            label: 'API',
            type: 'collection',
            entries: [{ path: lp('content/reference/api/auth'), label: 'Authentication' }],
          },
        ],
      },
    ]

    const filterInput = () => screen.getByTestId('entry-nav-filter') as HTMLInputElement
    const isShown = (testId: string) => screen.queryByTestId(testId) !== null

    it('shows no filter box when there is nothing to filter', () => {
      renderEntryNavigator()
      expect(screen.queryByTestId('entry-nav-filter')).toBeNull()
    })

    it('labels the filter box for assistive technology', () => {
      renderEntryNavigator({ collections: filterCollections() })
      expect(screen.getByRole('textbox', { name: 'Find entries' })).toBe(filterInput())
      expect(filterInput().placeholder).toBe('Find entries')
      expect(filterInput().hasAttribute('aria-keyshortcuts')).toBe(false)
      expect(screen.queryByTestId('entry-nav-filter-shortcut')).toBeNull()
    })

    it('names its shortcut in the empty box and in aria-keyshortcuts', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        collections: filterCollections(),
        filterShortcut: { label: '⌘P', keys: 'Meta+P' },
      })
      expect(filterInput().getAttribute('aria-keyshortcuts')).toBe('Meta+P')
      const hint = screen.getByTestId('entry-nav-filter-shortcut')
      expect(hint.textContent).toBe('⌘P')
      expect(hint.getAttribute('aria-hidden')).toBe('true')
      // Never brighter than the placeholder beside it, nor italic as dark dimmed text is.
      expect(hint.getAttribute('style')).toContain('--mantine-color-placeholder')
      expect(hint.getAttribute('style') ?? '').not.toContain('--canopy-dimmed-font-style')

      // The clear button takes its place while the box holds text.
      await user.type(filterInput(), 'a')
      expect(screen.queryByTestId('entry-nav-filter-shortcut')).toBeNull()
      expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy()
    })

    it('calls filterRef with the box', () => {
      const filterRef = React.createRef<HTMLInputElement>()
      renderEntryNavigator({ collections: filterCollections(), filterRef })
      expect(filterRef.current).toBe(filterInput())
    })

    it('matches an entry by title', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({ collections: filterCollections() })

      await user.type(filterInput(), 'launch')

      expect(isShown('entry-nav-item-launch-day')).toBe(true)
      expect(isShown('entry-nav-item-getting-started')).toBe(false)
    })

    it.each(ENTRY_SHAPES)('matches a type-named entry by its title, as %s', async (_, shape) => {
      const user = userEvent.setup()
      renderEntryNavigator(
        shape({
          path: unsafeAsLogicalPath('content/pages/site'),
          label: 'Site settings',
          title: 'Example site',
        }),
      )

      await user.type(filterInput(), 'example')

      expect(isShown('entry-nav-item-site-settings')).toBe(true)
      expect(isShown('entry-nav-item-about')).toBe(false)
    })

    it('matches an entry by slug when the title does not contain the text', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({ collections: filterCollections() })

      await user.type(filterInput(), 'access-rules')

      expect(isShown('entry-nav-item-data-access')).toBe(true)
      expect(isShown('entry-nav-item-privacy')).toBe(false)
    })

    it('keeps the collections above a match, expanded, and hides non-matching siblings', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({ collections: filterCollections() })
      // Nothing is expanded before the filter, so the match can only appear through it.
      expect(isShown('entry-nav-item-authentication')).toBe(false)

      await user.type(filterInput(), 'authentication')

      expect(isShown('entry-nav-item-reference')).toBe(true)
      expect(isShown('entry-nav-item-api')).toBe(true)
      expect(isShown('entry-nav-item-authentication')).toBe(true)
      expect(isShown('entry-nav-item-guides')).toBe(false)
      expect(isShown('entry-nav-item-news')).toBe(false)
    })

    it('shows only the matching entries of a collection that survives through them', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({ collections: filterCollections() })

      await user.type(filterInput(), 'priv')

      expect(isShown('entry-nav-item-guides')).toBe(true)
      expect(isShown('entry-nav-item-privacy')).toBe(true)
      expect(isShown('entry-nav-item-getting-started')).toBe(false)
      expect(isShown('entry-nav-item-data-access')).toBe(false)
    })

    it('keeps every descendant of a collection whose own title matches', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({ collections: filterCollections() })

      await user.type(filterInput(), 'guides')

      expect(isShown('entry-nav-item-getting-started')).toBe(true)
      expect(isShown('entry-nav-item-data-access')).toBe(true)
      expect(isShown('entry-nav-item-privacy')).toBe(true)
      expect(isShown('entry-nav-item-news')).toBe(false)
    })

    it('highlights the matched text', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({ collections: filterCollections() })

      await user.type(filterInput(), 'launch')

      const row = screen.getByTestId('entry-nav-item-launch-day')
      expect(within(row).getByText('Launch').tagName).toBe('MARK')
    })

    it('keeps Move up and Move down right for an entry shown out of its full position', async () => {
      const user = userEvent.setup()
      const onReorderEntry = vi.fn()
      renderEntryNavigator({ collections: filterCollections(), onReorderEntry })

      // "Privacy" is the last of three, so Move down is disabled and Move up is not, even
      // though it is the only entry the filter leaves in its collection.
      await user.type(filterInput(), 'privacy')
      await user.click(screen.getByTestId('entry-menu-privacy'))

      const moveUp = (await screen.findByText('Move up')).closest('button')
      const moveDown = screen.getByText('Move down').closest('button')
      expect(moveUp?.getAttribute('aria-disabled')).toBeNull()
      expect(moveDown?.getAttribute('aria-disabled')).toBe('true')
    })

    it('works on a flat list of items', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        items: [
          { path: lp('posts/hello'), label: 'Hello World' },
          { path: lp('posts/goodbye'), label: 'Goodbye World', slug: 'farewell' },
        ],
      })

      await user.type(filterInput(), 'farewell')

      expect(isShown('entry-nav-item-goodbye-world')).toBe(true)
      expect(isShown('entry-nav-item-hello-world')).toBe(false)
    })

    it('falls back to the last path segment as the slug', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({ items: [{ path: lp('posts/hello-there'), label: 'Greeting' }] })

      await user.type(filterInput(), 'hello-there')

      expect(isShown('entry-nav-item-greeting')).toBe(true)
    })

    describe('keys', () => {
      const renderInsideKeyWatcher = (
        props: Partial<React.ComponentProps<typeof EntryNavigator>> = {},
      ) => {
        const onParentKeyDown = vi.fn()
        render(
          <CanopyCMSProvider>
            <div onKeyDown={onParentKeyDown}>
              <EntryNavigator collections={filterCollections()} onSelect={vi.fn()} {...props} />
            </div>
          </CanopyCMSProvider>,
        )
        return onParentKeyDown
      }
      const escapes = (spy: ReturnType<typeof vi.fn>) =>
        spy.mock.calls.filter(([event]) => (event as KeyboardEvent).key === 'Escape')

      it('clears the filter on Escape without the key bubbling past the input', async () => {
        const user = userEvent.setup()
        const onParentKeyDown = renderInsideKeyWatcher()

        await user.type(filterInput(), 'launch')
        await user.keyboard('{Escape}')

        expect(filterInput().value).toBe('')
        expect(escapes(onParentKeyDown)).toHaveLength(0)
        expect(isShown('entry-nav-item-guides')).toBe(true)
      })

      it('marks the input so the drawer ignores Escape only while it holds text', async () => {
        const user = userEvent.setup()
        renderEntryNavigator({ collections: filterCollections() })

        expect(filterInput().getAttribute('data-mantine-stop-propagation')).toBeNull()
        await user.type(filterInput(), 'a')
        expect(filterInput().getAttribute('data-mantine-stop-propagation')).toBe('true')
      })

      it('lets Escape through when the filter is already empty', async () => {
        const user = userEvent.setup()
        const onParentKeyDown = renderInsideKeyWatcher()

        await user.click(filterInput())
        await user.keyboard('{Escape}')

        expect(escapes(onParentKeyDown)).toHaveLength(1)
      })

      it('selects the first match, in tree order, on Enter', async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        renderEntryNavigator({ collections: filterCollections(), onSelect })

        // Matches "Data access" and "Authentication"; Guides comes first.
        await user.type(filterInput(), 'a{Enter}')

        expect(onSelect).toHaveBeenCalledTimes(1)
        expect(onSelect).toHaveBeenCalledWith('content/guides/getting-started')
      })

      it('selects nothing on Enter when the filter is empty', async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        renderEntryNavigator({ collections: filterCollections(), onSelect })

        await user.click(filterInput())
        await user.keyboard('{Enter}')

        expect(onSelect).not.toHaveBeenCalled()
      })

      it('leaves Enter and Escape to an IME while it is composing', async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        renderEntryNavigator({ collections: filterCollections(), onSelect })
        await user.type(filterInput(), 'a')

        fireEvent.keyDown(filterInput(), { key: 'Enter', isComposing: true })
        fireEvent.keyDown(filterInput(), { key: 'Escape', isComposing: true })

        expect(onSelect).not.toHaveBeenCalled()
        expect(filterInput().value).toBe('a')
      })

      it('selects nothing on Enter when nothing matches', async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        renderEntryNavigator({ collections: filterCollections(), onSelect })

        await user.type(filterInput(), 'zzz{Enter}')

        expect(onSelect).not.toHaveBeenCalled()
      })

      it("hands Enter's match to onFilterEnter in place of onSelect", async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        const onFilterEnter = vi.fn()
        renderEntryNavigator({ collections: filterCollections(), onSelect, onFilterEnter })

        await user.type(filterInput(), 'a{Enter}')

        expect(onFilterEnter).toHaveBeenCalledTimes(1)
        expect(onFilterEnter).toHaveBeenCalledWith('content/guides/getting-started')
        expect(onSelect).not.toHaveBeenCalled()
      })

      it('gives Escape in the empty filter to onFilterEscape, after one clearing it', async () => {
        const user = userEvent.setup()
        const onFilterEscape = vi.fn()
        const onParentKeyDown = renderInsideKeyWatcher({ onFilterEscape })

        await user.type(filterInput(), 'launch')
        await user.keyboard('{Escape}')
        expect(onFilterEscape).not.toHaveBeenCalled()
        expect(filterInput().value).toBe('')

        await user.keyboard('{Escape}')
        expect(onFilterEscape).toHaveBeenCalledTimes(1)
        // Handled, so it closes nothing else.
        expect(escapes(onParentKeyDown)).toHaveLength(0)
      })
    })

    describe('clearing', () => {
      it('shows an empty state with a way back when nothing matches', async () => {
        const user = userEvent.setup()
        renderEntryNavigator({ collections: filterCollections() })

        await user.type(filterInput(), 'zzz')

        const empty = screen.getByTestId('entry-nav-filter-empty')
        expect(empty.textContent).toContain('No entries match “zzz”.')

        await user.click(within(empty).getByRole('button', { name: 'Clear search' }))

        expect(filterInput().value).toBe('')
        expect(screen.queryByTestId('entry-nav-filter-empty')).toBeNull()
        expect(isShown('entry-nav-item-guides')).toBe(true)
      })

      it('clears with the button inside the input, and only while it holds text', async () => {
        const user = userEvent.setup()
        renderEntryNavigator({ collections: filterCollections() })

        expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
        await user.type(filterInput(), 'launch')
        await user.click(screen.getByRole('button', { name: 'Clear search' }))

        expect(filterInput().value).toBe('')
        expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
      })
    })

    describe('expanded state', () => {
      const guidesOpen = () => ({
        current: { 'collection:content/guides': true } as Record<string, boolean>,
      })

      it('restores the expanded state the user had when the filter clears', async () => {
        const user = userEvent.setup()
        renderEntryNavigator({
          collections: filterCollections(),
          expandedStateRef: guidesOpen(),
        })
        expect(isShown('entry-nav-item-privacy')).toBe(true)
        expect(isShown('entry-nav-item-launch-day')).toBe(false)

        await user.type(filterInput(), 'launch')
        expect(isShown('entry-nav-item-launch-day')).toBe(true)

        await user.clear(filterInput())

        expect(isShown('entry-nav-item-privacy')).toBe(true)
        expect(isShown('entry-nav-item-launch-day')).toBe(false)
      })

      it('does not report filter-driven expansion as the user’s choice', async () => {
        const user = userEvent.setup()
        const onExpandedStateChange = vi.fn()
        renderEntryNavigator({
          collections: filterCollections(),
          expandedStateRef: guidesOpen(),
          onExpandedStateChange,
        })

        await user.type(filterInput(), 'launch')
        await user.clear(filterInput())

        expect(onExpandedStateChange).not.toHaveBeenCalled()
      })

      it('lets a collection be collapsed by hand while filtering, without saving it', async () => {
        const user = userEvent.setup()
        const onExpandedStateChange = vi.fn()
        renderEntryNavigator({
          collections: filterCollections(),
          onExpandedStateChange,
        })

        await user.type(filterInput(), 'authentication')
        expect(isShown('entry-nav-item-authentication')).toBe(true)

        await user.click(screen.getByTestId('entry-nav-item-api'))
        expect(isShown('entry-nav-item-authentication')).toBe(false)
        expect(onExpandedStateChange).not.toHaveBeenCalled()

        await user.click(screen.getByTestId('entry-nav-item-api'))
        expect(isShown('entry-nav-item-authentication')).toBe(true)
        expect(onExpandedStateChange).not.toHaveBeenCalled()

        await user.clear(filterInput())
        // Back to the unfiltered state: nothing was ever expanded.
        expect(isShown('entry-nav-item-authentication')).toBe(false)
        expect(isShown('entry-nav-item-privacy')).toBe(false)
      })

      it('does not re-expand the selected entry’s ancestors when the data reloads mid-filter', async () => {
        const user = userEvent.setup()
        const props = { onSelect: vi.fn(), selectedPath: 'content/reference/api/auth' }
        const { rerender } = render(
          <CanopyCMSProvider>
            <EntryNavigator {...props} collections={filterCollections()} />
          </CanopyCMSProvider>,
        )
        await waitFor(() => expect(isShown('entry-nav-item-authentication')).toBe(true))
        await user.type(filterInput(), 'launch')
        expect(isShown('entry-nav-item-authentication')).toBe(false)

        // A fresh `collections` array is what a refetch hands the navigator.
        rerender(
          <CanopyCMSProvider>
            <EntryNavigator {...props} collections={filterCollections()} />
          </CanopyCMSProvider>,
        )

        expect(isShown('entry-nav-item-launch-day')).toBe(true)
        expect(isShown('entry-nav-item-authentication')).toBe(false)
      })

      it('keeps an entry picked while filtering in view once the filter clears', async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        const { rerender } = render(
          <CanopyCMSProvider>
            <EntryNavigator onSelect={onSelect} collections={filterCollections()} />
          </CanopyCMSProvider>,
        )
        expect(isShown('entry-nav-item-authentication')).toBe(false)

        await user.type(filterInput(), 'auth')
        await user.click(screen.getByTestId('entry-nav-item-authentication'))
        rerender(
          <CanopyCMSProvider>
            <EntryNavigator
              onSelect={onSelect}
              selectedPath={onSelect.mock.calls[0][0]}
              collections={filterCollections()}
            />
          </CanopyCMSProvider>,
        )
        await user.clear(filterInput())

        expect(isShown('entry-nav-item-authentication')).toBe(true)
        // Only the picked entry's ancestors open; the rest stay as they were.
        expect(isShown('entry-nav-item-launch-day')).toBe(false)
      })
    })
  })

  describe('markers', () => {
    const lp = unsafeAsLogicalPath
    const markerCollections = (): EntryNavCollection[] => [
      {
        path: lp('posts'),
        label: 'Posts',
        type: 'collection',
        entries: [
          { path: lp('posts/draft'), label: 'Draft' },
          { path: lp('posts/final'), label: 'Final' },
        ],
      },
      {
        path: lp('other'),
        label: 'Other',
        type: 'collection',
        entries: [{ path: lp('other/page'), label: 'Page' }],
      },
    ]
    const open = { current: { 'collection:posts': true, 'collection:other': true } }

    it('puts an unsaved dot on the changed entry and on the collection holding it', () => {
      renderEntryNavigator({
        collections: markerCollections(),
        expandedStateRef: { ...open },
        dirtyPaths: new Set(['posts/draft']),
      })

      const entryDot = within(screen.getByTestId('entry-nav-item-draft')).getByRole('img', {
        name: 'Unsaved changes',
      })
      expect(entryDot.getAttribute('data-testid')).toBe('unsaved-dot')
      // The same mark, so the same colour, as the top bar's.
      const reference = within(
        render(<UnsavedMark data-testid="reference-mark" />, { wrapper: CanopyCMSProvider })
          .container,
      ).getByTestId('reference-mark')
      expect(reference.getAttribute('style')).toContain('--canopy-unsaved-mark')
      expect(entryDot.getAttribute('style')).toBe(reference.getAttribute('style'))
      const collectionDot = within(screen.getByTestId('entry-nav-item-posts')).getByRole('img', {
        name: 'Contains unsaved changes',
      })
      expect(collectionDot.getAttribute('data-testid')).toBe('unsaved-dot')
    })

    it('puts no dot on clean entries or on collections without changes', () => {
      renderEntryNavigator({
        collections: markerCollections(),
        expandedStateRef: { ...open },
        dirtyPaths: new Set(['posts/draft']),
      })

      expect(
        within(screen.getByTestId('entry-nav-item-final')).queryByTestId('unsaved-dot'),
      ).toBeNull()
      expect(
        within(screen.getByTestId('entry-nav-item-other')).queryByTestId('unsaved-dot'),
      ).toBeNull()
      expect(screen.getAllByTestId('unsaved-dot')).toHaveLength(2)
    })

    it('marks a collection that is collapsed over a changed entry', () => {
      renderEntryNavigator({
        collections: markerCollections(),
        dirtyPaths: new Set(['posts/draft']),
      })

      expect(isRow('entry-nav-item-draft')).toBe(false)
      expect(
        within(screen.getByTestId('entry-nav-item-posts')).getByTestId('unsaved-dot'),
      ).toBeTruthy()
    })

    function isRow(testId: string) {
      return screen.queryByTestId(testId) !== null
    }

    it('shows a lock, and no entry menu, on an entry the user cannot edit', () => {
      renderEntryNavigator({
        collections: [
          {
            path: lp('posts'),
            label: 'Posts',
            type: 'collection',
            entries: [
              { path: lp('posts/locked'), label: 'Locked', readOnly: true },
              { path: lp('posts/open'), label: 'Open' },
            ],
          },
        ],
        expandedStateRef: { current: { 'collection:posts': true } },
        onDeleteEntry: vi.fn(),
        onRenameEntry: vi.fn(),
      })

      const lockedRow = screen.getByTestId('entry-nav-item-locked')
      expect(within(lockedRow).getByRole('img', { name: "You can't edit this entry" })).toBe(
        within(lockedRow).getByTestId('entry-lock'),
      )
      expect(screen.queryByTestId('entry-menu-locked')).toBeNull()
      expect(screen.getByTestId('entry-menu-open')).toBeTruthy()
      expect(
        within(screen.getByTestId('entry-nav-item-open')).queryByTestId('entry-lock'),
      ).toBeNull()
    })

    it("keeps an entry's own lock, and leaves its slot empty, on a read-only navigator", () => {
      renderEntryNavigator({
        readOnly: true,
        readOnlyReason: BRANCH_REASON,
        onDeleteEntry: vi.fn(),
        items: [{ path: lp('posts/locked'), label: 'Locked', readOnly: true }],
      })

      const row = screen.getByTestId('entry-nav-item-locked')
      expect(within(row).getAllByTestId('entry-lock')).toHaveLength(1)
      expect(within(row).queryByTestId('branch-lock')).toBeNull()
      expect(within(row).queryByTestId('branch-lock-pending')).toBeNull()
    })
  })

  describe('menu grouping', () => {
    const lp = unsafeAsLogicalPath
    const dividers = () => document.body.querySelectorAll('.mantine-Menu-divider')
    const precedes = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

    const openCollectionMenu = async (extra: Partial<EntryNavCollection>) => {
      const user = userEvent.setup()
      renderEntryNavigator({
        collections: [{ path: lp('posts'), label: 'Posts', type: 'collection', ...extra }],
      })
      await user.click(screen.getByTestId('collection-menu-posts'))
      await screen.findByRole('menu')
    }

    it('lists content actions first, then an Admin group', async () => {
      await openCollectionMenu({
        onAdd: vi.fn(),
        onAddSubCollection: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      })

      const add = screen.getByText('Add entry…')
      const admin = screen.getByText('Admin')
      const sub = screen.getByText('Add sub-collection…')
      const edit = screen.getByText('Edit collection…')
      const del = screen.getByText('Delete collection')
      expect(precedes(add, admin)).toBe(true)
      expect(precedes(admin, sub)).toBe(true)
      expect(precedes(sub, edit)).toBe(true)
      expect(precedes(edit, del)).toBe(true)
      expect(dividers()).toHaveLength(1)
    })

    it('has no Admin group, and no divider, when only content actions are offered', async () => {
      await openCollectionMenu({ onAdd: vi.fn() })

      expect(screen.getByText('Add entry…')).toBeTruthy()
      expect(screen.queryByText('Admin')).toBeNull()
      expect(dividers()).toHaveLength(0)
    })

    it('has the Admin label but no leading divider when only admin actions are offered', async () => {
      await openCollectionMenu({ onEdit: vi.fn() })

      expect(screen.getByText('Admin')).toBeTruthy()
      expect(screen.getByText('Edit collection…')).toBeTruthy()
      expect(dividers()).toHaveLength(0)
    })

    it('orders the entry menu as Change URL, move, then a divider and a red delete', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        collections: [
          {
            path: lp('posts'),
            label: 'Posts',
            type: 'collection',
            entries: [
              {
                path: lp('posts/first'),
                label: 'First',
                contentId: unsafeAsContentId('abc123456789'),
              },
            ],
          },
        ],
        expandedStateRef: { current: { 'collection:posts': true } },
        onRenameEntry: vi.fn(),
        onDeleteEntry: vi.fn(),
        onReorderEntry: vi.fn(),
      })

      await user.click(screen.getByTestId('entry-menu-first'))
      await screen.findByRole('menu')

      const rename = screen.getByText('Change URL…')
      const up = screen.getByText('Move up')
      const down = screen.getByText('Move down')
      const del = screen.getByText('Delete entry')
      expect(precedes(rename, up)).toBe(true)
      expect(precedes(up, down)).toBe(true)
      expect(precedes(down, del)).toBe(true)
      expect(dividers()).toHaveLength(1)
      expect(precedes(down, dividers()[0])).toBe(true)
      expect(precedes(dividers()[0], del)).toBe(true)
    })

    it.each(ENTRY_SHAPES)(
      'offers "Change slug…" for an entry with no page, as %s',
      async (_, shape) => {
        const user = userEvent.setup()
        renderEntryNavigator({
          ...shape({ path: lp('content/pages/settings'), label: 'Settings', noPage: true }),
          onRenameEntry: vi.fn(),
        })

        await user.click(screen.getByTestId('entry-menu-settings'))
        expect((await screen.findByTestId('rename-entry-menu-item')).textContent).toBe(
          'Change slug…',
        )
      },
    )

    it('has no divider in an entry menu that only deletes', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        items: [{ path: lp('posts/first'), label: 'First' }],
        onDeleteEntry: vi.fn(),
      })

      await user.click(screen.getByTestId('entry-menu-first'))
      await screen.findByRole('menu')

      expect(screen.getByText('Delete entry')).toBeTruthy()
      expect(dividers()).toHaveLength(0)
    })
  })

  describe('row menus by keyboard', () => {
    it('keeps the arrow keys inside an open row menu', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        collections: [
          {
            path: unsafeAsLogicalPath('posts'),
            label: 'Posts',
            type: 'collection',
            entries: [
              { path: unsafeAsLogicalPath('posts/a'), label: 'Alpha' },
              { path: unsafeAsLogicalPath('posts/b'), label: 'Beta' },
            ],
          },
        ],
        expandedStateRef: { current: { 'collection:posts': true } },
        onRenameEntry: vi.fn(),
        onDeleteEntry: vi.fn(),
      })

      await user.click(screen.getByTestId('entry-menu-alpha'))
      const menu = await screen.findByRole('menu')
      await user.keyboard('{ArrowDown}')
      await user.keyboard('{ArrowDown}')

      expect(menu.contains(document.activeElement)).toBe(true)
    })

    it('lets every other key from an open row menu reach the document', async () => {
      const user = userEvent.setup()
      renderEntryNavigator({
        items: [{ path: unsafeAsLogicalPath('posts/a'), label: 'Alpha' }],
        onRenameEntry: vi.fn(),
      })
      const reached: string[] = []
      const listen = (event: KeyboardEvent) => reached.push(event.key)
      // Where Mantine's useHotkeys listens, so the Mod+P shortcut among them.
      document.documentElement.addEventListener('keydown', listen)

      try {
        await user.click(screen.getByTestId('entry-menu-alpha'))
        await screen.findByRole('menu')
        await user.keyboard('{ArrowDown}{Control>}p{/Control}{Tab}')
      } finally {
        document.documentElement.removeEventListener('keydown', listen)
      }

      expect(reached).toEqual(expect.arrayContaining(['Control', 'p', 'Tab']))
      expect(reached).not.toContain('ArrowDown')
    })
  })

  describe('row layout', () => {
    const lp = unsafeAsLogicalPath
    const longTitle = 'A very long entry title that cannot fit in a narrow navigator panel'
    const originalScrollWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollWidth',
    )
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    )

    afterEach(() => {
      for (const [name, descriptor] of [
        ['scrollWidth', originalScrollWidth],
        ['clientWidth', originalClientWidth],
      ] as const) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
      }
    })

    // Text is cut when its content is wider than its box; jsdom has no layout, so stand in for it.
    const stubWidths = () => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => 100,
      })
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.textContent === longTitle ? 300 : 40
        },
      })
    }

    const renderRows = () =>
      renderEntryNavigator({
        items: [
          { path: lp('posts/long'), label: longTitle },
          { path: lp('posts/short'), label: 'Short' },
        ],
      })

    it('shows the full title in a tooltip when the title is cut', async () => {
      const user = userEvent.setup()
      stubWidths()
      renderRows()

      await user.hover(
        screen.getByTestId(
          'entry-nav-item-a-very-long-entry-title-that-cannot-fit-in-a-narrow-navigator-panel',
        ),
      )
      await user.hover(screen.getByText(longTitle))

      const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 2000 })
      expect(tooltip.textContent).toBe(longTitle)
    })

    it('still shows the tooltip for a cut title while a filter highlights it', async () => {
      const user = userEvent.setup()
      stubWidths()
      renderRows()

      await user.type(screen.getByTestId('entry-nav-filter'), 'narrow')
      const row = screen.getByTestId(
        'entry-nav-item-a-very-long-entry-title-that-cannot-fit-in-a-narrow-navigator-panel',
      )
      const mark = row.querySelector('mark')
      expect(mark).not.toBeNull()
      await user.hover(row)
      await user.hover(mark!.parentElement!)

      const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 2000 })
      expect(tooltip.textContent).toBe(longTitle)
    })

    it('shows no tooltip for a title that fits', async () => {
      const user = userEvent.setup()
      stubWidths()
      renderRows()

      await user.hover(screen.getByTestId('entry-nav-item-short'))
      await user.hover(screen.getByText('Short'))
      await new Promise((resolve) => setTimeout(resolve, 700))

      expect(screen.queryByRole('tooltip')).toBeNull()
    })
  })
})

describe('EntryNavigator - revealing a collection', () => {
  const nested: EntryNavCollection[] = [
    {
      path: unsafeAsLogicalPath('content/docs'),
      label: 'Docs',
      type: 'collection',
      entries: [{ path: unsafeAsLogicalPath('content/docs/intro'), label: 'Intro' }],
      children: [
        {
          path: unsafeAsLogicalPath('content/docs/guides'),
          label: 'Guides',
          type: 'collection',
          entries: [{ path: unsafeAsLogicalPath('content/docs/guides/setup'), label: 'Setup' }],
        },
      ],
    },
  ]

  it('clears the filter, expands the collection and its ancestors, and focuses its row', async () => {
    const onRevealed = vi.fn()
    const { rerender, props } = renderEntryNavigator({ collections: nested })
    fireEvent.change(screen.getByTestId('entry-nav-filter'), { target: { value: 'intro' } })

    rerender(
      <CanopyCMSProvider>
        <EntryNavigator
          {...props}
          collections={nested}
          reveal={{ kind: 'collection', path: 'content/docs/guides', seq: 1 }}
          onRevealed={onRevealed}
        />
      </CanopyCMSProvider>,
    )

    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1))
    expect((screen.getByTestId('entry-nav-filter') as HTMLInputElement).value).toBe('')
    const row = document.activeElement as HTMLElement
    expect(row.getAttribute('role')).toBe('treeitem')
    expect(row.dataset.value).toBe('collection:content/docs/guides')
    expect(screen.getByText('Setup')).toBeTruthy()
  })

  it('keeps the collection open when the cleared filter had matched inside it', async () => {
    const onRevealed = vi.fn()
    const { rerender, props } = renderEntryNavigator({ collections: nested })
    fireEvent.change(screen.getByTestId('entry-nav-filter'), { target: { value: 'setup' } })
    await screen.findByText('Setup')

    rerender(
      <CanopyCMSProvider>
        <EntryNavigator
          {...props}
          collections={nested}
          reveal={{ kind: 'collection', path: 'content/docs/guides', seq: 1 }}
          onRevealed={onRevealed}
        />
      </CanopyCMSProvider>,
    )

    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((document.activeElement as HTMLElement).dataset.value).toBe(
      'collection:content/docs/guides',
    )
    expect(screen.getByText('Setup')).toBeTruthy()
  })

  it('reports a collection the tree does not show as done, moving no focus', async () => {
    const onRevealed = vi.fn()
    renderEntryNavigator({
      collections: nested,
      reveal: { kind: 'collection', path: 'content/missing', seq: 1 },
      onRevealed,
    })
    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(document.body)
  })
})

describe('EntryNavigator - the Unsaved filter', () => {
  const lp = unsafeAsLogicalPath
  const collections = (): EntryNavCollection[] => [
    {
      path: lp('content/guides'),
      label: 'Guides',
      type: 'collection',
      entries: [
        { path: lp('content/guides/getting-started'), label: 'Getting started' },
        { path: lp('content/guides/privacy'), label: 'Privacy' },
      ],
    },
    {
      path: lp('content/news'),
      label: 'News',
      type: 'collection',
      entries: [{ path: lp('content/news/launch'), label: 'Launch day' }],
    },
    {
      path: lp('content/reference'),
      label: 'Reference',
      type: 'collection',
      children: [
        {
          path: lp('content/reference/api'),
          label: 'API',
          type: 'collection',
          entries: [
            { path: lp('content/reference/api/auth'), label: 'Authentication' },
            { path: lp('content/reference/api/guides-index'), label: 'Guides index' },
          ],
        },
      ],
    },
  ]
  const dirty = new Set(['content/guides/privacy', 'content/reference/api/auth'])

  type Props = Partial<React.ComponentProps<typeof EntryNavigator>> & {
    initialFilter?: EntryFilter
    onChange?: (filter: EntryFilter) => void
  }
  /** The navigator with its filter held as the editor holds it. */
  function Harness({ initialFilter = 'all', onChange, ...props }: Props) {
    const [entryFilter, setEntryFilter] = useState<EntryFilter>(initialFilter)
    return (
      <EntryNavigator
        onSelect={() => {}}
        collections={collections()}
        dirtyPaths={dirty}
        unsavedCount={dirty.size}
        {...props}
        entryFilter={entryFilter}
        onEntryFilterChange={(next) => {
          onChange?.(next)
          setEntryFilter(next)
        }}
      />
    )
  }
  const renderHarness = (props: Props = {}) =>
    render(
      <CanopyCMSProvider>
        <Harness {...props} />
      </CanopyCMSProvider>,
    )
  const shown = (testId: string) => screen.queryByTestId(testId) !== null
  const unsaved = () => screen.getByRole('radio', { name: /^Unsaved/ })
  const filterInput = () => screen.getByTestId('entry-nav-filter') as HTMLInputElement

  it('shows no control without a handler for it', () => {
    renderEntryNavigator({ collections: collections(), dirtyPaths: dirty, unsavedCount: 2 })
    expect(screen.queryByTestId('entry-nav-shown')).toBeNull()
  })

  it('offers All and Unsaved with the unsaved count, All first, and no Changed without the branch changes', () => {
    renderHarness()
    const group = screen.getByRole('radiogroup', { name: 'Entries shown' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['all', 'unsaved'])
    expect(unsaved().closest('div')?.textContent).toBe('Unsaved 2')
    expect(shown('entry-nav-item-news')).toBe(true)
  })

  it('lists only the changed entries, under only the collections that hold them', async () => {
    renderHarness()
    await userEvent.click(unsaved())

    expect(shown('entry-nav-item-privacy')).toBe(true)
    expect(shown('entry-nav-item-authentication')).toBe(true)
    expect(shown('entry-nav-item-api')).toBe(true)
    expect(shown('entry-nav-item-getting-started')).toBe(false)
    expect(shown('entry-nav-item-guides-index')).toBe(false)
    expect(shown('entry-nav-item-news')).toBe(false)
    expect(shown('entry-nav-item-launch-day')).toBe(false)
  })

  it("keeps only a matching collection's changed entries when a query is on too", async () => {
    renderHarness({ initialFilter: 'unsaved' })
    await userEvent.type(filterInput(), 'guides')

    // "Guides" matches by its own title, yet its unchanged entry stays hidden.
    expect(shown('entry-nav-item-privacy')).toBe(true)
    expect(shown('entry-nav-item-getting-started')).toBe(false)
    // "Guides index" matches the query but has no unsaved changes.
    expect(shown('entry-nav-item-guides-index')).toBe(false)
    expect(shown('entry-nav-item-authentication')).toBe(false)
  })

  it('opens the first changed entry on Enter with an empty query', async () => {
    const onSelect = vi.fn()
    renderHarness({ initialFilter: 'unsaved', onSelect })
    filterInput().focus()
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('content/guides/privacy')
  })

  it('keeps Unsaved on when Escape clears the query', async () => {
    const onChange = vi.fn()
    renderHarness({ initialFilter: 'unsaved', onChange })
    await userEvent.type(filterInput(), 'auth{Escape}')
    expect(filterInput().value).toBe('')
    await userEvent.keyboard('{Escape}')
    expect(onChange).not.toHaveBeenCalled()
    expect(unsaved()).toHaveProperty('checked', true)
  })

  it('puts back the folders that were closed once All is chosen again', async () => {
    renderHarness()
    expect(shown('entry-nav-item-authentication')).toBe(false)
    await userEvent.click(unsaved())
    expect(shown('entry-nav-item-authentication')).toBe(true)
    await userEvent.click(screen.getByRole('radio', { name: 'All' }))
    await waitFor(() => expect(shown('entry-nav-item-authentication')).toBe(false))
  })

  it('says nothing is unsaved, with a way back to All', async () => {
    const onChange = vi.fn()
    renderHarness({ initialFilter: 'unsaved', dirtyPaths: new Set(), unsavedCount: 0, onChange })
    const empty = screen.getByTestId('entry-nav-unsaved-none')
    expect(empty.textContent).toContain('No unsaved changes on this branch.')
    expect(unsaved().closest('div')?.textContent).toBe('Unsaved')
    await userEvent.click(within(empty).getByRole('button', { name: 'Show all entries' }))
    expect(onChange).toHaveBeenCalledWith('all')
    expect(document.activeElement).toBe(filterInput())
    expect(shown('entry-nav-unsaved-none')).toBe(false)
    expect(shown('entry-nav-item-news')).toBe(true)
  })

  it('keeps a folder closed under Unsaved while the unsaved set only changes identity', async () => {
    const { rerender } = render(
      <CanopyCMSProvider>
        <Harness initialFilter="unsaved" dirtyPaths={new Set(dirty)} />
      </CanopyCMSProvider>,
    )
    expect(shown('entry-nav-item-privacy')).toBe(true)
    await userEvent.click(screen.getByTestId('entry-nav-item-guides'))
    await waitFor(() => expect(shown('entry-nav-item-privacy')).toBe(false))

    rerender(
      <CanopyCMSProvider>
        <Harness initialFilter="unsaved" dirtyPaths={new Set(dirty)} />
      </CanopyCMSProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(shown('entry-nav-item-privacy')).toBe(false)
  })

  it('opens a folder the user closed again once the query changes', async () => {
    renderHarness()
    await userEvent.type(filterInput(), 'auth')
    expect(shown('entry-nav-item-authentication')).toBe(true)
    await userEvent.click(screen.getByTestId('entry-nav-item-api'))
    await waitFor(() => expect(shown('entry-nav-item-authentication')).toBe(false))

    await userEvent.type(filterInput(), 'e')

    await waitFor(() => expect(shown('entry-nav-item-authentication')).toBe(true))
  })

  it('says the list failed under a query too, when the tree still shows its collections', async () => {
    renderHarness({ initialFilter: 'unsaved', dirtyPaths: new Set(), entryListFailed: true })
    await userEvent.type(filterInput(), 'zzz')
    expect(shown('entry-nav-unsaved-failed')).toBe(true)
    expect(shown('entry-nav-unsaved-no-match')).toBe(false)
  })

  it('offers an unsaved entry with no row that matches the query, and opens it on Enter', async () => {
    const onSelect = vi.fn()
    renderHarness({
      initialFilter: 'unsaved',
      onSelect,
      unsavedCount: 4,
      unsavedEntries: [
        { path: 'content/elsewhere/orphan', label: 'Orphan page' },
        { path: 'content/elsewhere/stray', label: 'Stray note' },
      ],
    })
    await userEvent.type(filterInput(), 'orphan')

    const outside = screen.getByTestId('entry-nav-unsaved-outside')
    expect(
      within(outside)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Orphan page'])
    expect(shown('entry-nav-unsaved-no-match')).toBe(false)
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('content/elsewhere/orphan')
  })

  it('says no unsaved entry matches a query, and offers to search them all', async () => {
    const onChange = vi.fn()
    renderHarness({ initialFilter: 'unsaved', onChange })
    await userEvent.type(filterInput(), 'launch')

    const empty = screen.getByTestId('entry-nav-unsaved-no-match')
    expect(empty.textContent).toContain('No unsaved entries match “launch”.')
    expect(shown('entry-nav-filter-empty')).toBe(false)
    await userEvent.click(within(empty).getByRole('button', { name: 'Search all entries' }))
    expect(onChange).toHaveBeenCalledWith('all')
    expect(filterInput().value).toBe('launch')
    expect(document.activeElement).toBe(filterInput())
    expect(shown('entry-nav-item-launch-day')).toBe(true)
  })

  it('offers an unsaved entry the tree has no row for, which opens it', async () => {
    const onSelect = vi.fn()
    renderHarness({
      initialFilter: 'unsaved',
      onSelect,
      unsavedCount: 3,
      unsavedEntries: [{ path: 'content/elsewhere/orphan', label: 'Orphan page' }],
    })
    const outside = screen.getByTestId('entry-nav-unsaved-outside')
    expect(shown('entry-nav-unsaved-unlisted')).toBe(false)
    await userEvent.click(within(outside).getByRole('button', { name: 'Orphan page' }))
    expect(onSelect).toHaveBeenCalledWith('content/elsewhere/orphan')
  })

  it('says the list failed, never that nothing changed, when it could not load', () => {
    renderHarness({
      initialFilter: 'unsaved',
      collections: [],
      dirtyPaths: new Set(),
      unsavedCount: 2,
      entryListFailed: true,
    })
    expect(screen.getByTestId('entry-nav-shown')).toBeTruthy()
    expect(screen.getByTestId('entry-nav-unsaved-failed').textContent).toContain(
      "The list of entries couldn't be loaded",
    )
    expect(shown('entry-nav-unsaved-none')).toBe(false)
    expect(screen.queryByText('No content')).toBeNull()
  })

  it('names the unsaved entries the tree does not list yet after the ones it does', () => {
    renderHarness({ initialFilter: 'unsaved', unsavedCount: 4 })
    const notice = screen.getByTestId('entry-nav-unsaved-unlisted')
    expect(notice.textContent).toBe('2 more: loading their names…')
    expect(shown('entry-nav-item-privacy')).toBe(true)
  })

  it('says how many are unsaved while none of them is listed yet', () => {
    renderHarness({ initialFilter: 'unsaved', dirtyPaths: new Set(), unsavedCount: 1 })
    expect(screen.getByTestId('entry-nav-unsaved-unlisted').textContent).toBe(
      '1 unsaved entry: loading its name…',
    )
    expect(shown('entry-nav-unsaved-none')).toBe(false)
  })
})

describe('EntryNavigator - revealing an entry', () => {
  const lp = unsafeAsLogicalPath
  const tree: EntryNavCollection[] = [
    {
      path: lp('content/docs'),
      label: 'Docs',
      type: 'collection',
      entries: [{ path: lp('content/docs/intro'), label: 'Intro' }],
      children: [
        {
          path: lp('content/docs/guides'),
          label: 'Guides',
          type: 'collection',
          entries: [{ path: lp('content/docs/guides/setup'), label: 'Setup' }],
        },
      ],
    },
    {
      path: lp('content/news'),
      label: 'News',
      type: 'collection',
      entries: [{ path: lp('content/news/launch'), label: 'Launch day' }],
    },
  ]

  it('switches Unsaved to All, clears the query, opens its folders and focuses its row', async () => {
    const onRevealed = vi.fn()
    const onEntryFilterChange = vi.fn()
    const props = {
      onSelect: vi.fn(),
      collections: tree,
      dirtyPaths: new Set(['content/news/launch']),
      unsavedCount: 1,
      onEntryFilterChange,
      onRevealed,
    }
    const { rerender } = render(
      <CanopyCMSProvider>
        <EntryNavigator {...props} entryFilter="unsaved" />
      </CanopyCMSProvider>,
    )
    fireEvent.change(screen.getByTestId('entry-nav-filter'), { target: { value: 'launch' } })
    const reveal = { kind: 'entry' as const, path: 'content/docs/guides/setup', seq: 1 }
    rerender(
      <CanopyCMSProvider>
        <EntryNavigator {...props} entryFilter="unsaved" reveal={reveal} />
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(onEntryFilterChange).toHaveBeenCalledWith('all'))
    expect((screen.getByTestId('entry-nav-filter') as HTMLInputElement).value).toBe('')
    expect(onRevealed).not.toHaveBeenCalled()

    rerender(
      <CanopyCMSProvider>
        <EntryNavigator {...props} entryFilter="all" reveal={reveal} />
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1))
    const row = document.activeElement as HTMLElement
    expect(row.getAttribute('role')).toBe('treeitem')
    expect(row.dataset.value).toBe('content/docs/guides/setup')
    // News held the filter's match, but was closed before the filter and is again.
    expect(screen.queryByTestId('entry-nav-item-launch-day')).toBeNull()
  })

  it('waits for a loading tree, then focuses the row', async () => {
    const onRevealed = vi.fn()
    const reveal = { kind: 'entry' as const, path: 'content/news/launch', seq: 1 }
    const { rerender } = render(
      <CanopyCMSProvider>
        <EntryNavigator
          onSelect={vi.fn()}
          collections={[]}
          loading
          reveal={reveal}
          onRevealed={onRevealed}
        />
      </CanopyCMSProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onRevealed).not.toHaveBeenCalled()

    rerender(
      <CanopyCMSProvider>
        <EntryNavigator
          onSelect={vi.fn()}
          collections={tree}
          reveal={reveal}
          onRevealed={onRevealed}
        />
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1))
    expect((document.activeElement as HTMLElement).dataset.value).toBe('content/news/launch')
  })

  it('clears the query for the unsaved entries, leaving Unsaved to its owner', async () => {
    const onRevealed = vi.fn()
    const onEntryFilterChange = vi.fn()
    const props = { onSelect: vi.fn(), collections: tree, onEntryFilterChange, onRevealed }
    const { rerender } = render(
      <CanopyCMSProvider>
        <EntryNavigator {...props} />
      </CanopyCMSProvider>,
    )
    fireEvent.change(screen.getByTestId('entry-nav-filter'), { target: { value: 'intro' } })
    rerender(
      <CanopyCMSProvider>
        <EntryNavigator {...props} entryFilter="unsaved" reveal={{ kind: 'unsaved', seq: 1 }} />
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1))
    expect((screen.getByTestId('entry-nav-filter') as HTMLInputElement).value).toBe('')
    expect(onEntryFilterChange).not.toHaveBeenCalled()
  })

  it('reports an entry the tree does not show as done, moving no focus', async () => {
    const onRevealed = vi.fn()
    renderEntryNavigator({
      collections: tree,
      reveal: { kind: 'entry', path: 'content/docs/missing', seq: 1 },
      onRevealed,
    })
    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(document.body)
  })
})

describe('EntryNavigator - the Changed filter', () => {
  const lp = unsafeAsLogicalPath
  const tree: EntryNavCollection[] = [
    {
      path: lp('content'),
      label: 'Content',
      type: 'collection',
      entries: [{ path: lp('content/home'), label: 'Home' }],
      children: [
        {
          path: lp('content/guides'),
          label: 'Guides',
          type: 'collection',
          entries: [
            { path: lp('content/guides/privacy'), label: 'Privacy' },
            { path: lp('content/guides/setup'), label: 'Setup' },
          ],
        },
        {
          path: lp('content/news'),
          label: 'News',
          type: 'collection',
          entries: [{ path: lp('content/news/launch'), label: 'Launch day' }],
        },
      ],
    },
  ]
  const entry = (
    status: 'added' | 'modified' | 'deleted' | 'moved',
    logicalPath: string,
    extra: { title?: string; previousLogicalPath?: string } = {},
  ) => ({
    status,
    logicalPath,
    contentId: 'aB3cD4eF5gH6',
    collectionPath: logicalPath.slice(0, logicalPath.lastIndexOf('/')),
    entryType: 'page',
    ...extra,
  })
  const loaded = (
    data: Partial<NonNullable<BranchChangesView['data']>> = {},
  ): NonNullable<BranchChangesView['data']> => ({
    base: 'main',
    entries: [
      entry('modified', 'content/guides/privacy'),
      entry('added', 'content/news/launch'),
      entry('deleted', 'content/guides/old-faq', { title: 'Old FAQ' }),
      entry('deleted', 'content/guides/untitled-one'),
    ],
    collections: [],
    hiddenChanges: false,
    ...data,
  })

  type Props = Partial<React.ComponentProps<typeof EntryNavigator>> & {
    initialFilter?: EntryFilter
    onChange?: (filter: EntryFilter) => void
    changes?: Partial<BranchChangesView>
  }
  function Harness({ initialFilter = 'changed', onChange, changes, ...props }: Props) {
    const [entryFilter, setEntryFilter] = useState<EntryFilter>(initialFilter)
    return (
      <EntryNavigator
        onSelect={() => {}}
        collections={tree}
        hiddenRootPath="content"
        branchChanges={{ base: 'main', data: loaded(), onRetry: () => {}, ...changes }}
        {...props}
        entryFilter={entryFilter}
        onEntryFilterChange={(next) => {
          onChange?.(next)
          setEntryFilter(next)
        }}
      />
    )
  }
  const renderHarness = (props: Props = {}) =>
    render(
      <CanopyCMSProvider>
        <Harness {...props} />
      </CanopyCMSProvider>,
    )
  const shown = (testId: string) => screen.queryByTestId(testId) !== null
  const changedRadio = () => screen.getByRole('radio', { name: /^Changed/ })
  const filterInput = () => screen.getByTestId('entry-nav-filter') as HTMLInputElement

  it('offers All, Unsaved and Changed, counting the changes once loaded', () => {
    const { rerender } = renderHarness({ initialFilter: 'all', changes: { data: undefined } })
    const group = screen.getByRole('radiogroup', { name: 'Entries shown' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['all', 'unsaved', 'changed'])
    expect(changedRadio().closest('div')?.textContent).toBe('Changed')
    rerender(
      <CanopyCMSProvider>
        <Harness initialFilter="all" />
      </CanopyCMSProvider>,
    )
    expect(changedRadio().closest('div')?.textContent).toBe('Changed 4')
  })

  it('lists only the changed rows, each with a marker in its accessible name, keeping the unsaved dot', () => {
    renderHarness({ dirtyPaths: new Set(['content/guides/privacy']) })
    expect(shown('entry-nav-item-privacy')).toBe(true)
    expect(shown('entry-nav-item-launch-day')).toBe(true)
    expect(shown('entry-nav-item-setup')).toBe(false)
    expect(shown('entry-nav-item-home')).toBe(false)

    const privacy = screen.getByTestId('entry-nav-item-privacy')
    expect(within(privacy).getByTestId('change-marker-modified').textContent).toBe(
      'Edited on this branch',
    )
    expect(within(privacy).getByTestId('unsaved-dot')).toBeTruthy()
    // The treeitem's name is its text, the marker's hidden words included.
    const launch = screen
      .getAllByRole('treeitem', { name: /Launch day.*New on this branch/ })
      .find((item) => item.dataset.value === 'content/news/launch')
    expect(launch).toBeTruthy()
  })

  it('shows no markers under All', () => {
    renderHarness({ initialFilter: 'all' })
    fireEvent.change(filterInput(), { target: { value: 'privacy' } })
    expect(shown('entry-nav-item-privacy')).toBe(true)
    expect(screen.queryByTestId('change-marker-modified')).toBeNull()
  })

  it('marks a moved entry Moved', () => {
    renderHarness({
      changes: {
        data: loaded({
          entries: [
            entry('moved', 'content/guides/setup', { previousLogicalPath: 'content/setup' }),
          ],
        }),
      },
    })
    expect(
      within(screen.getByTestId('entry-nav-item-setup')).getByTestId('change-marker-moved'),
    ).toBeTruthy()
  })

  it("shows a collection whose settings changed with a Settings marker, and the hidden root's beneath", () => {
    renderHarness({
      changes: {
        data: loaded({
          entries: [],
          collections: [
            { status: 'modified', logicalPath: 'content/news' },
            { status: 'modified', logicalPath: 'content' },
          ],
        }),
      },
    })
    const news = screen.getByTestId('entry-nav-item-news')
    const marker = within(news).getByTestId('change-marker-settings')
    expect(marker.textContent).toBe('Settings editedSettings changed on this branch')
    // The visible words are hidden from assistive tech, which reads the sentence instead.
    expect(
      Array.from(marker.querySelectorAll('[aria-hidden]')).map((node) => node.textContent),
    ).toContain('Settings edited')
    expect(shown('entry-nav-item-launch-day')).toBe(false)
    const outside = screen.getByTestId('entry-nav-branch-changed-outside')
    expect(outside.textContent).toContain('Content')
    expect(within(outside).getByTestId('change-marker-settings')).toBeTruthy()
  })

  it('lists deleted entries beneath the tree by title, else slug, as plain text', () => {
    renderHarness()
    const deleted = screen.getByTestId('entry-nav-branch-changed-deleted')
    expect(deleted.textContent).toContain('Deleted on this branch')
    expect(deleted.textContent).toContain('Old FAQ Guides')
    expect(deleted.textContent).toContain('Untitled one Guides')
    const markers = within(deleted).getAllByTestId('change-marker-deleted')
    expect(markers.map((m) => m.textContent)).toEqual(['Deleted', 'Deleted'])
    expect(within(deleted).queryByRole('button')).toBeNull()
  })

  it('offers an added entry the tree has no row for, which opens it', async () => {
    const onSelect = vi.fn()
    renderHarness({
      onSelect,
      changes: { data: loaded({ entries: [entry('added', 'content/news/brand-new')] }) },
    })
    const outside = screen.getByTestId('entry-nav-branch-changed-outside')
    await userEvent.click(within(outside).getByRole('button', { name: /^Brand new/ }))
    expect(onSelect).toHaveBeenCalledWith('content/news/brand-new')
  })

  it('shows skeleton rows while the changes load', () => {
    renderHarness({ changes: { data: undefined } })
    expect(shown('entry-nav-branch-changed-loading')).toBe(true)
    expect(shown('entry-nav-item-privacy')).toBe(false)
    expect(shown('entry-nav-branch-changed-none')).toBe(false)
  })

  it('says nothing differs from the base once loaded, with a way back to All', async () => {
    const onChange = vi.fn()
    renderHarness({ onChange, changes: { data: loaded({ entries: [] }) } })
    const empty = screen.getByTestId('entry-nav-branch-changed-none')
    expect(empty.textContent).toContain('Nothing on this branch differs from main yet.')
    await userEvent.click(within(empty).getByRole('button', { name: 'Show all entries' }))
    expect(onChange).toHaveBeenCalledWith('all')
    expect(shown('entry-nav-item-guides')).toBe(true)
  })

  it('shows a failed load above the list with Retry, keeping what loaded before', async () => {
    const onRetry = vi.fn()
    renderHarness({ changes: { error: { kind: 'failed', message: 'HTTP 500' }, onRetry } })
    const alert = screen.getByTestId('entry-nav-branch-changed-failed')
    expect(alert.textContent).toContain(
      'Couldn’t refresh this branch’s changes. The list may be out of date.',
    )
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(shown('entry-nav-item-privacy')).toBe(true)
  })

  it('shows a failed first load with Retry and no skeleton', () => {
    renderHarness({ changes: { data: undefined, error: { kind: 'failed', message: 'x' } } })
    expect(screen.getByTestId('entry-nav-branch-changed-failed').textContent).toContain(
      'Couldn’t load this branch’s changes.',
    )
    expect(shown('entry-nav-branch-changed-loading')).toBe(false)
  })

  it('says, in yellow, that the branch is syncing', () => {
    renderHarness({ changes: { data: undefined, error: { kind: 'syncing' } } })
    const alert = screen.getByTestId('entry-nav-branch-changed-syncing')
    expect(alert.textContent).toContain(
      'This branch is being synced with main. Try again in a moment.',
    )
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('says some changes are hidden, without a count, and not that nothing changed', () => {
    renderHarness({ changes: { data: loaded({ entries: [], hiddenChanges: true }) } })
    expect(screen.getByTestId('entry-nav-branch-changed-hidden').textContent).toBe(
      'Some changes are in entries you can’t view.',
    )
    expect(shown('entry-nav-branch-changed-none')).toBe(false)
  })

  it('says the base could not be compared', () => {
    renderHarness({ changes: { data: loaded({ entries: [], baseUnavailable: true }) } })
    const unavailable = screen.getByTestId('entry-nav-branch-changed-unavailable')
    expect(unavailable.textContent).toContain(
      'Couldn’t compare this branch with main: they share no history.',
    )
    expect(within(unavailable).getByRole('button', { name: 'Show all entries' })).toBeTruthy()
    expect(shown('entry-nav-branch-changed-none')).toBe(false)
  })

  it('lists other files behind Details only when the answer has them', async () => {
    const { unmount } = renderHarness()
    expect(shown('entry-nav-branch-changed-other')).toBe(false)
    unmount()
    renderHarness({ changes: { data: loaded({ otherFiles: ['README.md', 'site/x.ts'] }) } })
    const other = screen.getByTestId('entry-nav-branch-changed-other')
    expect(other.textContent).toContain('Other files changed')
    expect(other.textContent).not.toContain('README.md')
    const details = within(other).getByRole('button', { name: 'Details' })
    await userEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(other.querySelector('pre, code')?.textContent).toBe('README.md\nsite/x.ts')
  })

  it('searches within the changes, and says when none matches', async () => {
    renderHarness()
    await userEvent.type(filterInput(), 'launch')
    expect(shown('entry-nav-item-launch-day')).toBe(true)
    expect(shown('entry-nav-item-privacy')).toBe(false)
    expect(shown('entry-nav-branch-changed-deleted')).toBe(false)

    await userEvent.clear(filterInput())
    await userEvent.type(filterInput(), 'setup')
    const empty = screen.getByTestId('entry-nav-branch-changed-no-match')
    expect(empty.textContent).toContain('No changed entries match “setup”.')
    expect(shown('entry-nav-filter-empty')).toBe(false)
  })

  it('shows Retry working while a reload runs', () => {
    renderHarness({ changes: { error: { kind: 'syncing' }, retrying: true } })
    const retry = within(screen.getByTestId('entry-nav-branch-changed-syncing')).getByRole(
      'button',
      { name: 'Retry' },
    )
    expect(retry.hasAttribute('data-loading')).toBe(true)
  })

  it('says unsaved entries aren’t included in an empty Changed, and offers Unsaved', async () => {
    const onChange = vi.fn()
    const { unmount } = renderHarness({
      unsavedCount: 1,
      onChange,
      changes: { data: loaded({ entries: [] }) },
    })
    const note = screen.getByTestId('entry-nav-branch-changed-unsaved')
    expect(note.textContent).toBe('1 unsaved entry isn’t included until it’s saved.')
    await userEvent.click(screen.getByRole('button', { name: 'Show unsaved' }))
    expect(onChange).toHaveBeenCalledWith('unsaved')
    unmount()
    renderHarness({ unsavedCount: 3, changes: { data: loaded({ entries: [] }) } })
    expect(screen.getByTestId('entry-nav-branch-changed-unsaved').textContent).toBe(
      '3 unsaved entries aren’t included until they’re saved.',
    )
  })

  it('caps both counts at 99+', () => {
    const many = Array.from({ length: 120 }, (_, i) => entry('modified', `content/news/e${i}`))
    renderHarness({
      initialFilter: 'all',
      unsavedCount: 100,
      changes: { data: loaded({ entries: many }) },
    })
    expect(screen.getByRole('radio', { name: /^Unsaved/ }).closest('div')?.textContent).toBe(
      'Unsaved 99+',
    )
    expect(changedRadio().closest('div')?.textContent).toBe('Changed 99+')
  })

  it('says where a moved row came from, by labels', () => {
    renderHarness({
      changes: {
        data: loaded({
          entries: [
            entry('moved', 'content/guides/setup', {
              previousLogicalPath: 'content/news/old-setup',
            }),
            entry('moved', 'content/guides/privacy', {
              previousLogicalPath: 'content/guides/privacy-policy',
            }),
          ],
        }),
      },
    })
    expect(
      within(screen.getByTestId('entry-nav-item-setup')).getByTestId('change-marker-moved')
        .textContent,
    ).toBe('Moved from News › Old setup')
    expect(
      within(screen.getByTestId('entry-nav-item-privacy')).getByTestId('change-marker-moved')
        .textContent,
    ).toBe('Moved from Privacy policy')
  })

  it('labels rows beneath the tree by title or humanised slug, and settings by collection label', () => {
    renderHarness({
      changes: {
        data: loaded({
          entries: [entry('added', 'content/news/brand-new')],
          collections: [{ status: 'deleted', logicalPath: 'content/news' }],
        }),
      },
    })
    const outside = screen.getByTestId('entry-nav-branch-changed-outside')
    expect(
      within(outside).getByRole('button', { name: /^Brand new New on this branch/ }),
    ).toBeTruthy()
    expect(outside.textContent).toContain('News')
  })

  it('turns the Details chevron and says when the server cut the list', async () => {
    renderHarness({
      changes: { data: loaded({ otherFiles: ['README.md'], otherFilesTruncated: true }) },
    })
    const other = screen.getByTestId('entry-nav-branch-changed-other')
    const details = within(other).getByRole('button', { name: 'Details' })
    const chevron = details.querySelector('svg') as SVGElement
    expect(chevron.style.transform).toBe('')
    await userEvent.click(details)
    expect(chevron.style.transform).toBe('rotate(90deg)')
    expect(other.textContent).toContain('List shows the first 1 files.')
  })

  it('says the base no longer exists, offering All and no Retry', async () => {
    const onChange = vi.fn()
    renderHarness({ onChange, changes: { data: loaded({ entries: [], baseMissing: true }) } })
    const missing = screen.getByTestId('entry-nav-branch-changed-missing')
    expect(missing.textContent).toContain(
      'Couldn’t compare this branch with main: main no longer exists.',
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(shown('entry-nav-branch-changed-none')).toBe(false)
    await userEvent.click(within(missing).getByRole('button', { name: 'Show all entries' }))
    expect(onChange).toHaveBeenCalledWith('all')
  })

  it('shows the server’s words for a 409', () => {
    renderHarness({
      changes: {
        error: {
          kind: 'syncing',
          message: 'This branch changed while its changes were being read. Try again in a moment.',
        },
      },
    })
    expect(screen.getByTestId('entry-nav-branch-changed-syncing').textContent).toContain(
      'This branch changed while its changes were being read. Try again in a moment.',
    )
  })

  it('hands Show unsaved to its owner when given one', async () => {
    const onShowUnsaved = vi.fn()
    const onChange = vi.fn()
    renderHarness({
      unsavedCount: 1,
      onShowUnsaved,
      onChange,
      changes: { data: loaded({ entries: [] }) },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Show unsaved' }))
    expect(onShowUnsaved).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('announces the count once a load is shown, and again only for a new answer', () => {
    const { rerender } = renderHarness({ changes: { data: undefined } })
    const status = screen.getByTestId('entry-nav-branch-changed-status')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe('')
    const data = loaded()
    rerender(
      <CanopyCMSProvider>
        <Harness changes={{ data }} />
      </CanopyCMSProvider>,
    )
    expect(status.textContent).toBe('4 changed entries')
    rerender(
      <CanopyCMSProvider>
        <Harness changes={{ data: loaded({ entries: [entry('added', 'content/news/launch')] }) }} />
      </CanopyCMSProvider>,
    )
    expect(status.textContent).toBe('1 changed entry')
    rerender(
      <CanopyCMSProvider>
        <Harness changes={{ data: loaded({ entries: [] }) }} />
      </CanopyCMSProvider>,
    )
    expect(status.textContent).toBe('No changed entries')
  })
})
