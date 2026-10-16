import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
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
    const rows = screen
      .getAllByRole('listitem')
      .map((row) => [row.querySelector('button')?.textContent, row.querySelector('p')?.textContent])
    expect(rows).toEqual([
      ['By Alice', '(author, reviewers)'],
      ['About', '(linked from body)'],
    ])
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

describe('ReferencedByList layout', () => {
  // jsdom applies only the stylesheets in the document, so the layout is checked against
  // Mantine's own CSS for the components the list renders, plus `List`, so a return to it fails.
  const mantineCss = ['List', 'Anchor', 'Text', 'Stack']
    .map((name) =>
      readFileSync(
        createRequire(import.meta.url).resolve(`@mantine/core/styles/${name}.css`),
        'utf8',
      ),
    )
    .join('\n')
  let style: HTMLStyleElement
  beforeAll(() => {
    style = document.createElement('style')
    style.textContent = mantineCss
    document.head.appendChild(style)
  })
  afterAll(() => style.remove())

  const longTitle = 'a'.repeat(200)
  const longSlugTitle = 'https://example.com/' + 'very-long-slug-'.repeat(15)

  const listElements = () => {
    const list = screen.getByTestId('referenced-by-list')
    return [list, ...Array.from(list.querySelectorAll<HTMLElement>('*'))]
  }

  it('lets a long unbroken title wrap at any character, within the dialog width', () => {
    renderList({
      entries: [
        { ...byAlice, title: longTitle },
        { ...about, title: longSlugTitle },
      ],
      hiddenCount: 0,
    })
    for (const title of [longTitle, longSlugTitle]) {
      const anchor = screen.getByRole('button', { name: title })
      expect(getComputedStyle(anchor).overflowWrap).toBe('anywhere')
      // A `<button>` centres its text by default, which a wrapped title shows.
      expect(getComputedStyle(anchor).textAlign).toBe('start')
    }
    for (const via of ['(author, reviewers)', '(linked from body)']) {
      expect(getComputedStyle(screen.getByText(via)).overflowWrap).toBe('anywhere')
    }
  })

  it('never lays a row out unwrappable or at a fixed width', () => {
    renderList({ entries: [{ ...byAlice, title: longTitle }, about], hiddenCount: 1 })
    const elements = listElements()
    expect(elements.length).toBeGreaterThan(5)
    for (const el of elements) {
      const computed = getComputedStyle(el)
      expect(computed.whiteSpace, el.outerHTML.slice(0, 80)).not.toBe('nowrap')
      expect(computed.display, el.outerHTML.slice(0, 80)).not.toBe('inline-flex')
      expect(computed.width, el.outerHTML.slice(0, 80)).not.toMatch(/px$/)
      expect(computed.minWidth, el.outerHTML.slice(0, 80)).not.toMatch(/^[1-9]\d*px$/)
    }
  })

  it('puts the field label on its own dimmed line under its title', () => {
    renderList({ entries: [byAlice], hiddenCount: 0 })
    const anchor = screen.getByRole('button', { name: 'By Alice' })
    const via = screen.getByText('(author, reviewers)')
    expect(via.tagName).not.toBe('SPAN')
    expect(anchor.nextElementSibling).toBe(via)
    expect(screen.getByTestId('referenced-by-list').getAttribute('role')).toBe('list')
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
