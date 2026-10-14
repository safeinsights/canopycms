import { useState } from 'react'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { SWRConfig } from 'swr'
import { MemberList } from './MemberList'
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
      <MemberList
        groupId="group-1"
        members={[]}
        onRemoveMember={vi.fn()}
        onAddMember={vi.fn()}
        onGetUserMetadata={async () => null}
        showUserSearch
        searchQuery="a"
        searchResults={searchResults}
        isSearching={false}
        searchError={null}
        onSearchQueryChange={vi.fn()}
        onShowSearch={vi.fn()}
        onHideSearch={vi.fn()}
        canSearch
      />
    </MantineProvider>,
  )

describe('MemberList search results, with a lookup that knows no one', () => {
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

describe('MemberList focus after a removal', () => {
  const people: UserSearchResult[] = [
    { id: 'u1', name: 'Alice Johnson', email: 'alice@example.com' },
    { id: 'u2', name: 'Bob Smith', email: 'bob@example.com' },
    { id: 'u3', name: 'Carol White', email: 'carol@example.com' },
  ]

  /** Holds the members in state, as the group manager does, so a removal re-renders the list. */
  function Harness({ initial }: { initial: string[] }) {
    const [members, setMembers] = useState(initial)
    return (
      <SWRConfig value={{ provider: () => new Map() }}>
        <MantineProvider>
          <MemberList
            groupId="group-1"
            members={members}
            onRemoveMember={(_group, userId) => setMembers((m) => m.filter((id) => id !== userId))}
            onAddMember={vi.fn()}
            onGetUserMetadata={async (id) => people.find((p) => p.id === id) ?? null}
            showUserSearch={false}
            searchQuery=""
            searchResults={[]}
            isSearching={false}
            searchError={null}
            onSearchQueryChange={vi.fn()}
            onShowSearch={vi.fn()}
            onHideSearch={vi.fn()}
            canSearch
          />
        </MantineProvider>
      </SWRConfig>
    )
  }

  const remove = (name: string) => screen.findByRole('button', { name: `Remove ${name}` })
  const expectFocus = (name: string) =>
    waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name })))

  it('draws members light, with an X in the text colour', async () => {
    render(<Harness initial={['u1']} />)
    const button = await remove('Alice Johnson')
    expect(button.closest('.mantine-Badge-root')?.getAttribute('data-variant')).toBe('light')
    expect(button.style.color).toBe('var(--mantine-color-text)')
  })

  it('moves to the next member, for a middle member', async () => {
    render(<Harness initial={['u1', 'u2', 'u3']} />)
    await userEvent.click(await remove('Bob Smith'))
    await expectFocus('Remove Carol White')
  })

  it('moves to the new first member, for the first of three', async () => {
    render(<Harness initial={['u1', 'u2', 'u3']} />)
    await userEvent.click(await remove('Alice Johnson'))
    await expectFocus('Remove Bob Smith')
  })

  it('moves to the previous member, for the last member', async () => {
    render(<Harness initial={['u1', 'u2', 'u3']} />)
    await userEvent.click(await remove('Carol White'))
    await expectFocus('Remove Bob Smith')
  })

  it('moves to "Add member", for the only member', async () => {
    render(<Harness initial={['u1']} />)
    await userEvent.click(await remove('Alice Johnson'))
    await expectFocus('Add member')
  })
})
