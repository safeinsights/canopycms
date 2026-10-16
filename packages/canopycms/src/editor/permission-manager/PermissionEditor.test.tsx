import { useState } from 'react'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { SWRConfig } from 'swr'
import { PermissionEditor } from './PermissionEditor'
import type { TreeNode, UserSearchResult } from './types'
import type { PathPermission } from '../../config'
import { unsafeAsPermissionPath } from '../../authorization/test-utils'

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
      ResizeObserver as typeof ResizeObserver
  }
})

afterEach(cleanup)

const users: UserSearchResult[] = [
  { id: 'alice', name: 'Alice Johnson', email: 'alice@example.com' },
  { id: 'bob', name: 'Bob Smith', email: 'bob@example.com' },
  { id: 'carol', name: 'Carol White', email: 'carol@example.com' },
]
const groups = [
  { value: 'g1', label: 'Group One', source: 'internal' as const },
  { value: 'g2', label: 'Group Two', source: 'internal' as const },
  { value: 'g3', label: 'Group Three', source: 'internal' as const },
]

/** Holds the node's read rule in state, as the manager does, so a removal re-renders the list. */
function Harness({
  allowedGroups,
  allowedUsers,
}: {
  allowedGroups: string[]
  allowedUsers: string[]
}) {
  const [target, setTarget] = useState({ allowedGroups, allowedUsers })
  const directPermission: PathPermission = {
    path: unsafeAsPermissionPath('content/posts'),
    read: target,
  }
  const node: TreeNode = {
    path: 'content/posts',
    name: 'posts',
    type: 'folder',
    children: [],
    directPermission,
  }
  return (
    <SWRConfig value={{ provider: () => new Map() }}>
      <MantineProvider>
        <PermissionEditor
          node={node}
          activeLevel="read"
          onSetActiveLevel={vi.fn()}
          canEdit
          groups={groups}
          isSelected
          userSearchResults={[]}
          isSearchingUsers={false}
          showUserSearch={false}
          userSearchQuery=""
          userSearchError={null}
          onSearchUsers={vi.fn()}
          onGetUserMetadata={async (id) => users.find((u) => u.id === id) ?? null}
          onToggleUserSearch={vi.fn()}
          onAddUser={vi.fn()}
          onRemoveUser={(_path, _level, userId) =>
            setTarget((t) => ({ ...t, allowedUsers: t.allowedUsers.filter((u) => u !== userId) }))
          }
          showGroupSearch={false}
          groupSearchQuery=""
          filteredGroups={[]}
          onSearchGroups={vi.fn()}
          onToggleGroupSearch={vi.fn()}
          onAddGroup={vi.fn()}
          onRemoveGroup={(_path, _level, groupId) =>
            setTarget((t) => ({
              ...t,
              allowedGroups: t.allowedGroups.filter((g) => g !== groupId),
            }))
          }
        />
      </MantineProvider>
    </SWRConfig>
  )
}

const removeButton = (name: string) => screen.findByRole('button', { name: `Remove ${name}` })
const expectFocus = (name: string) =>
  waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name })))

describe('PermissionEditor labels', () => {
  it('speaks in sentence case', async () => {
    render(<Harness allowedGroups={[]} allowedUsers={[]} />)
    expect(screen.getByRole('button', { name: 'Add groups' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add user' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add anonymous' })).toBeTruthy()
    expect(screen.getByText('Read access')).toBeTruthy()
  })
})

describe('PermissionEditor badges', () => {
  it('draws the group and user badges light, with an X in the text colour', async () => {
    render(<Harness allowedGroups={['g1']} allowedUsers={['alice']} />)
    const group = await removeButton('Group One')
    const user = await removeButton('Alice Johnson')
    for (const button of [group, user]) {
      expect(button.closest('.mantine-Badge-root')?.getAttribute('data-variant')).toBe('light')
    }
    expect(user.style.color).toBe('var(--mantine-color-text)')
    expect(group.querySelector('svg')?.style.color).toBe('var(--mantine-color-text)')
  })
})

describe('PermissionEditor focus after a removal', () => {
  it('moves to the next item, for a middle group', async () => {
    render(<Harness allowedGroups={['g1', 'g2', 'g3']} allowedUsers={[]} />)
    await userEvent.click(await removeButton('Group Two'))
    await expectFocus('Remove Group Three')
  })

  it('moves to the new first item, for the first of three groups', async () => {
    render(<Harness allowedGroups={['g1', 'g2', 'g3']} allowedUsers={[]} />)
    await userEvent.click(await removeButton('Group One'))
    await expectFocus('Remove Group Two')
  })

  it('moves to the previous item, for the last group', async () => {
    render(<Harness allowedGroups={['g1', 'g2', 'g3']} allowedUsers={[]} />)
    await userEvent.click(await removeButton('Group Three'))
    await expectFocus('Remove Group Two')
  })

  it('moves to "Add groups", for the only group', async () => {
    render(<Harness allowedGroups={['g1']} allowedUsers={[]} />)
    await userEvent.click(await removeButton('Group One'))
    await expectFocus('Add groups')
  })

  it('moves to the next user, for a middle user', async () => {
    render(<Harness allowedGroups={['g1']} allowedUsers={['alice', 'bob', 'carol']} />)
    await userEvent.click(await removeButton('Bob Smith'))
    await expectFocus('Remove Carol White')
  })

  it('moves to the previous user, for the last user', async () => {
    render(<Harness allowedGroups={[]} allowedUsers={['alice', 'bob', 'carol']} />)
    await userEvent.click(await removeButton('Carol White'))
    await expectFocus('Remove Bob Smith')
  })

  it('moves to the last group, for the only user after the groups', async () => {
    render(<Harness allowedGroups={['g1', 'g2']} allowedUsers={['alice']} />)
    await userEvent.click(await removeButton('Alice Johnson'))
    await expectFocus('Remove Group Two')
  })

  it('moves to "Add user", for the only user and no groups', async () => {
    render(<Harness allowedGroups={[]} allowedUsers={['alice']} />)
    await userEvent.click(await removeButton('Alice Johnson'))
    await expectFocus('Add user')
  })
})
