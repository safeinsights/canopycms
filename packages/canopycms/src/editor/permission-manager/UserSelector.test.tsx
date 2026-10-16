import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { UserSelector } from './UserSelector'
import type { UserSearchResult } from './types'

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

const renderWith = (searchResults: UserSearchResult[]) =>
  render(
    <MantineProvider>
      <UserSelector
        searchQuery="a"
        onSearchChange={vi.fn()}
        searchResults={searchResults}
        isSearching={false}
        searchError={null}
        onSelectUser={vi.fn()}
        onGetUserMetadata={async () => null}
      />
    </MantineProvider>,
  )

describe('UserSelector, with a lookup that knows no one', () => {
  it('shows a real name and the email', () => {
    renderWith([{ id: 'user_1', name: 'Alice Smith', email: 'alice@example.com' }])
    expect(screen.getByText('Alice Smith')).toBeTruthy()
    expect(screen.getByText('alice@example.com')).toBeTruthy()
  })

  it.each([
    ['empty', ''],
    ['blank', '  '],
    ['the id', 'user_2ab'],
  ])('shows "Name unavailable" for a name that is %s, never the id', (_label, name) => {
    const { container } = renderWith([{ id: 'user_2ab', name, email: 'someone@example.com' }])
    const fallback = screen.getByText('Name unavailable')
    expect(fallback.style.fontStyle).toBe('italic')
    expect(container.textContent).not.toContain('user_2ab')
    expect(screen.getByText('someone@example.com')).toBeTruthy()
  })
})
