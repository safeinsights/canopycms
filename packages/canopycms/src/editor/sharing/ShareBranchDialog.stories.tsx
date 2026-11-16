import React, { useMemo, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import type { ApiErrorCode } from '../../api/types'
import type { FindPeopleResult } from '../../api/people'
import type { UserSearchResult } from '../../auth/types'
import { RESERVED_GROUPS } from '../../authorization/helpers'
import type { UserContext } from '../BranchManager'
import { ApiClientProvider, type ApiClient } from '../context'
import { ShareBranchDialog, type ShareTarget } from './ShareBranchDialog'
import type { BranchAccess } from './share-staging'
import { WhoHasAccessPopover } from './WhoHasAccessPopover'

const AT = '2026-11-01T00:00:00.000Z'

const OWNER_LIST: BranchAccess = {
  entries: [
    { kind: 'user', id: 'ana', name: 'Ana Lee', maskedEmail: 'a•••@example.org' },
    {
      kind: 'user',
      id: 'ben',
      name: 'Ben Ortiz',
      maskedEmail: 'b•••@example.org',
      addedBy: { id: 'ana', name: 'Ana Lee' },
      addedAt: AT,
    },
    {
      kind: 'group',
      id: 'marketing',
      name: 'Marketing team',
      addedBy: { id: 'ben', name: 'Ben Ortiz' },
      addedAt: AT,
    },
  ],
  restricted: true,
  openToEveryone: false,
  defaultAccess: 'deny',
  addBy: 'members',
  whoCanAdd: 'members',
  rights: { isOwner: true, canAdd: true, canManage: true },
  searchable: 'cms-users',
  addableByEmail: 'all-users',
}

const PEOPLE: FindPeopleResult = {
  people: [
    { id: 'cole', name: 'Cole Ortiz', maskedEmail: 'c•••@example.org' },
    { id: 'dana', name: 'Dana Park', maskedEmail: 'd•••@example.org' },
  ],
  groups: [{ id: 'design', name: 'Design' }],
}

const NAMES: Record<string, string> = { ana: 'Ana Lee', dana: 'Dana Park', chen: 'Chen Wu' }
const lookup = async (id: string): Promise<UserSearchResult | null> =>
  NAMES[id] ? { id, name: NAMES[id], email: '' } : null

type Load = BranchAccess | 'loading' | 'error' | ApiErrorCode

/** An in-memory stand-in for the access endpoints. */
function fakeClient(load: Load, find: FindPeopleResult = PEOPLE): ApiClient {
  const client = {
    branches: {
      getAccess: async () => {
        if (load === 'loading') return new Promise<never>(() => {})
        if (load === 'error') return { ok: false, status: 503, error: 'Service unavailable' }
        if (typeof load === 'string')
          return { ok: false, status: 403, error: 'Refused', code: load }
        return { ok: true, status: 200, data: load }
      },
      findPeople: async (_params: Record<string, string>, body: { query: string }) => {
        const query = body.query.trim().toLowerCase()
        if (query.includes('@')) return { ok: true, status: 200, data: { people: [], groups: [] } }
        return {
          ok: true,
          status: 200,
          data: {
            people: find.people.filter((p) => p.name.toLowerCase().includes(query)),
            groups: find.groups.filter((g) => g.name.toLowerCase().includes(query)),
          },
        }
      },
      updateAccess: async () => ({ ok: true, status: 200, data: { branch: {} } }),
    },
  }
  return client as unknown as ApiClient
}

const OWNER_SHARING: ShareTarget['sharing'] = {
  isOwner: true,
  canAdd: true,
  canManage: true,
  restricted: true,
  openToEveryone: false,
  addBy: 'members',
}

const Dialog: React.FC<{
  load: Load
  user?: UserContext
  branch?: Partial<ShareTarget>
  find?: FindPeopleResult
}> = ({ load, user = { userId: 'ana', groups: [] }, branch, find }) => {
  const client = useMemo(() => fakeClient(load, find), [load, find])
  const [opened, setOpened] = useState(true)
  // The listing's rights, as the editor has them before the list loads.
  const sharing: ShareTarget['sharing'] =
    typeof load === 'object'
      ? {
          ...load.rights,
          restricted: load.restricted,
          openToEveryone: load.openToEveryone,
          addBy: load.addBy,
        }
      : OWNER_SHARING
  return (
    <ApiClientProvider client={client}>
      <button onClick={() => setOpened(true)}>Open the Share dialog</button>
      <ShareBranchDialog
        opened={opened}
        onClose={() => setOpened(false)}
        onChanged={() => {}}
        branch={{
          name: 'canopycms/prod/spring',
          shortName: 'spring',
          createdBy: 'ana',
          sharing,
          ...branch,
        }}
        urlName="spring"
        user={user}
        getUserMetadata={lookup}
      />
    </ApiClientProvider>
  )
}

const meta: Meta<typeof Dialog> = {
  title: 'Editor/ShareBranchDialog',
  component: Dialog,
  parameters: { layout: 'padded' },
}

export default meta
type Story = StoryObj<typeof Dialog>

const clickLabel = async (label: string): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 300))
  const input = Array.from(document.querySelectorAll<HTMLLabelElement>('label')).find(
    (el) => el.textContent === label,
  )?.control
  input?.click()
}

/** The owner on a site whose branches are open only to listed people. */
export const OwnerOnDenySite: Story = { args: { load: OWNER_LIST } }

/** A member: a remove only on the entry they added, and who can add as text. */
export const Member: Story = {
  args: {
    user: { userId: 'ben', groups: [] },
    load: {
      ...OWNER_LIST,
      entries: [
        { kind: 'user', id: 'ana', name: 'Ana Lee', maskedEmail: 'a•••@example.org' },
        { kind: 'user', id: 'ben', name: 'Ben Ortiz', maskedEmail: 'b•••@example.org' },
        { ...OWNER_LIST.entries[2]! },
      ],
      rights: { isOwner: false, canAdd: true, canManage: false },
    },
  },
}

/** An admin, with "Removed (2)" open: one exclusion by the owner, one by an admin. */
export const AdminWithExclusions: Story = {
  args: {
    user: { userId: 'root', groups: [RESERVED_GROUPS.ADMINS] },
    load: {
      ...OWNER_LIST,
      entries: OWNER_LIST.entries.map((entry) => ({
        ...entry,
        ...(entry.kind === 'user' && { email: `${entry.id}@example.org`, maskedEmail: undefined }),
      })),
      excluded: [
        {
          kind: 'user',
          id: 'pat',
          name: 'Pat Alvarez',
          by: { id: 'ana', name: 'Ana Lee' },
          at: AT,
          byAdmin: false,
        },
        {
          kind: 'user',
          id: 'sam',
          name: 'Sam Reed',
          by: { id: 'root', name: 'Ada Admin' },
          at: AT,
          byAdmin: true,
        },
      ],
      rights: { isOwner: false, canAdd: true, canManage: true },
    },
  },
  play: async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    document.querySelector<HTMLButtonElement>('[data-testid="share-removed-toggle"]')?.click()
  },
}

const OPEN: BranchAccess = {
  ...OWNER_LIST,
  entries: [],
  restricted: false,
  openToEveryone: true,
  defaultAccess: 'allow',
}

/** An open branch on a site whose default lets everyone who can sign in open branches. */
export const AllowSiteOpen: Story = {
  args: { load: OPEN, branch: { editors: ['ana', 'dana', 'chen'] } },
}

/** Limiting that branch to its list names the editors who would lose access. */
export const NarrowingWarning: Story = {
  args: AllowSiteOpen.args,
  play: () => clickLabel('Only people listed here'),
}

/** Loading the owner's list: a row held for each entry the listing names, as OwnerOnDenySite shows. */
export const Loading: Story = {
  args: { load: 'loading', branch: { access: { users: ['ana', 'ben'], groups: ['marketing'] } } },
}

export const LoadError: Story = { args: { load: 'error' } }

/** The viewer lost access since the list was shown. */
export const Refused: Story = { args: { load: 'BRANCH_ACCESS_DENIED' } }

/** A site where names can't be searched: the input asks for an address. */
export const EmailOnly: Story = {
  args: {
    load: { ...OWNER_LIST, searchable: 'nobody' },
    find: { people: [], groups: [] },
  },
}

const Popover: React.FC = () => {
  const client = useMemo(
    () =>
      fakeClient({
        ...OWNER_LIST,
        rights: { isOwner: false, canAdd: false, canManage: false },
      }),
    [],
  )
  const [opened, setOpened] = useState(true)
  return (
    <ApiClientProvider client={client}>
      <WhoHasAccessPopover
        branch={{ name: 'canopycms/prod/spring', createdBy: 'ana' }}
        opened={opened}
        onChange={setOpened}
      >
        <button onClick={() => setOpened((o) => !o)}>
          Access: Ana Lee, Ben Ortiz, Marketing team
        </button>
      </WhoHasAccessPopover>
    </ApiClientProvider>
  )
}

/** "Who has access", for someone who may open the branch but not add people. */
export const ReadOnlyPopover: Story = {
  render: () => <Popover />,
}
