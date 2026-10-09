import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { ReferencedByList, referencedDeleteMessage } from './ReferencedByList'
import type { EntryReferencedBy } from '../../api/entries'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'

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
})

afterEach(cleanup)

const byAlice = {
  entryPath: unsafeAsLogicalPath('content/posts/by-alice'),
  contentId: unsafeAsContentId('pst1pst1pst1'),
  title: 'By Alice',
  fields: ['author', 'reviewers'],
  links: [],
}
const about = {
  entryPath: unsafeAsLogicalPath('content/pages/about'),
  contentId: unsafeAsContentId('pAGE1pAGE1pA'),
  title: 'About',
  fields: [],
  links: ['body'],
}

const renderList = (referencedBy: EntryReferencedBy, onOpenEntry = vi.fn()) => {
  render(
    <MantineProvider>
      <ReferencedByList referencedBy={referencedBy} onOpenEntry={onOpenEntry} />
    </MantineProvider>,
  )
  return onOpenEntry
}

const listText = () => screen.getByTestId('referenced-by-list').textContent

describe('ReferencedByList', () => {
  it('lists each readable entry with the fields that reference it and labels body links', () => {
    renderList({ entries: [byAlice, about], hiddenCount: 0 })
    expect(listText()).toContain('By Alice (author, reviewers)')
    expect(listText()).toContain('About (linked from body)')
    expect(listText()).not.toContain("can't view")
  })

  it('opens an entry when its title is clicked', () => {
    const onOpenEntry = renderList({ entries: [byAlice], hiddenCount: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'By Alice' }))
    expect(onOpenEntry).toHaveBeenCalledWith('content/posts/by-alice')
  })

  it('lists two entries that share a content id as two rows', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const twin = { ...byAlice, entryPath: unsafeAsLogicalPath('content/posts/twin'), title: 'Twin' }
    const onOpenEntry = renderList({ entries: [byAlice, twin], hiddenCount: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Twin' }))
    expect(onOpenEntry).toHaveBeenCalledWith('content/posts/twin')
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/)
    errors.mockRestore()
  })

  it('counts the entries the user cannot view, after the visible ones', () => {
    renderList({ entries: [byAlice], hiddenCount: 2 })
    expect(listText()).toContain("and 2 entries you can't view")
  })

  it('reads naturally when every referencing entry is hidden', () => {
    renderList({ entries: [], hiddenCount: 1 })
    expect(listText()).toBe("1 entry you can't view")
  })
})

describe('referencedDeleteMessage', () => {
  it('counts visible and hidden referencing entries together', () => {
    expect(referencedDeleteMessage({ entries: [byAlice], hiddenCount: 2 })).toBe(
      'This entry is referenced by 3 other entries. Deleting it leaves those references ' +
        'pointing at nothing. This cannot be undone.',
    )
    expect(referencedDeleteMessage({ entries: [], hiddenCount: 1 })).toBe(
      'This entry is referenced by 1 other entry. Deleting it leaves that reference ' +
        'pointing at nothing. This cannot be undone.',
    )
  })
})
