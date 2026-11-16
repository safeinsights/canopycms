import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

import { createMockApiClient } from '../api/__test__/mock-client'
import type { FindPeopleResponse } from '../api/branch-people'
import type { FoundPerson } from '../api/people'
import { BranchManager, type BranchSummary } from './BranchManager'
import { accessRefusalMessage } from './copy'
import { ApiClientProvider, type ApiClient } from './context'
import { NEW_BRANCH_PRIVATE_LINE } from './sharing/ShareWithField'
import { CanopyCMSProvider } from './theme'

const ANA = { userId: 'ana', groups: [] }

const found = (
  defaultAccess: 'allow' | 'deny',
  people: FoundPerson[] = [{ id: 'bob', name: 'Bob Diaz', maskedEmail: 'b•••@example.org' }],
): FindPeopleResponse => ({
  ok: true,
  status: 200,
  data: {
    people,
    groups: [{ id: 'design', name: 'Design' }],
    newBranch: { defaultAccess, searchable: 'cms-users', addableByEmail: 'all-users' },
  },
})

const created: BranchSummary = {
  name: 'canopycms/prod/spring',
  shortName: 'spring',
  status: 'editing',
  createdBy: 'ana',
  access: {},
  sharing: {
    isOwner: true,
    canAdd: true,
    canManage: true,
    restricted: false,
    openToEveryone: false,
    addBy: 'members',
  },
}

function setup(
  onCreate: React.ComponentProps<typeof BranchManager>['onCreate'] = vi.fn(async () => true),
  options: { defaultAccess?: 'allow' | 'deny'; branches?: BranchSummary[] } = {},
) {
  const api = createMockApiClient()
  api.branches.findPeopleForNewBranch.mockResolvedValue(found(options.defaultAccess ?? 'allow'))
  api.branches.getAccess.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      entries: [{ kind: 'user', id: 'ana', name: 'Ana Lee' }],
      restricted: false,
      openToEveryone: false,
      defaultAccess: 'deny',
      addBy: 'members',
      rights: { isOwner: true, canAdd: true, canManage: true },
      searchable: 'cms-users',
      addableByEmail: 'all-users',
    },
  })
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <CanopyCMSProvider>
        <ApiClientProvider client={api as unknown as ApiClient}>
          <BranchManager
            branches={options.branches ?? []}
            mode="prod"
            user={ANA}
            startCreating
            onCreate={onCreate}
          />
        </ApiClientProvider>
      </CanopyCMSProvider>
    </SWRConfig>,
  )
  return { api }
}

const shareWith = () => screen.getByRole('textbox', { name: 'Share with' })
const nameField = () => screen.getByLabelText(/branch name/i) as HTMLInputElement
/** The text of the error "Share with" is described by, if any. */
const fieldError = () =>
  (shareWith().getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id))
    .find((el) => el?.classList.contains('mantine-InputWrapper-error'))?.textContent ?? undefined

/** Opens "Share with" and picks the suggestion named `name`. */
async function choose(name: RegExp) {
  await userEvent.click(shareWith())
  await userEvent.click(await screen.findByRole('option', { name }))
}

describe('New branch: Share with', () => {
  afterEach(() => cleanup())

  it("suggests the user's recent shares from the branchless finder", async () => {
    const { api } = setup()

    await userEvent.click(shareWith())

    expect(await screen.findByText('Recently shared with')).toBeTruthy()
    expect(screen.getByRole('option', { name: /Bob Diaz/ })).toBeTruthy()
    expect(api.branches.findPeopleForNewBranch).toHaveBeenCalledWith({ query: '' })
    expect(api.branches.findPeople).not.toHaveBeenCalled()
  })

  it('shows each choice as a removable chip, focusing the field once the last goes', async () => {
    setup()
    await choose(/Bob Diaz/)
    const chips = screen.getByTestId('share-with-chips')
    expect(within(chips).getByText('Bob Diaz')).toBeTruthy()

    await userEvent.click(within(chips).getByRole('button', { name: 'Remove Bob Diaz' }))

    expect(screen.queryByTestId('share-with-chips')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(shareWith()))
    expect(screen.getByTestId('share-with-status').textContent).toBe('Removed Bob Diaz')
  })

  it('says the branch will be private once anyone is chosen on a site open to everyone', async () => {
    setup()
    await userEvent.click(shareWith())
    await screen.findByRole('option', { name: /Bob Diaz/ })
    expect(screen.queryByText(NEW_BRANCH_PRIVATE_LINE)).toBeNull()

    await userEvent.click(screen.getByRole('option', { name: /Bob Diaz/ }))

    expect(screen.getByText(NEW_BRANCH_PRIVATE_LINE)).toBeTruthy()
  })

  it('says nothing of the kind on a site whose branches are private already', async () => {
    setup(undefined, { defaultAccess: 'deny' })

    await choose(/Bob Diaz/)

    expect(screen.queryByText(NEW_BRANCH_PRIVATE_LINE)).toBeNull()
  })

  it('creates the branch with the people and groups chosen, by id', async () => {
    const onCreate = vi.fn(async () => true)
    setup(onCreate)
    await userEvent.type(nameField(), 'spring')
    await choose(/Bob Diaz/)
    await choose(/Design/)

    await userEvent.click(screen.getByTestId('create-branch-submit'))

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate).toHaveBeenCalledWith({
      name: 'spring',
      access: { add: { users: ['bob'], groups: ['design'] } },
    })
  })

  it('sends someone found outside the editor by the address that found them', async () => {
    const onCreate = vi.fn(async () => true)
    const { api } = setup(onCreate)
    api.branches.findPeopleForNewBranch.mockImplementation(async ({ query }) =>
      query === 'dana@example.org'
        ? found('deny', [{ id: 'dana', name: 'Dana Park', addByAddress: true }])
        : found('deny', []),
    )
    await userEvent.type(nameField(), 'spring')
    await userEvent.type(shareWith(), 'dana@example.org')
    await userEvent.click(await screen.findByRole('option', { name: 'Add dana@example.org' }))
    await screen.findByText('Dana Park')

    await userEvent.click(screen.getByTestId('create-branch-submit'))

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate).toHaveBeenCalledWith({
      name: 'spring',
      access: { add: { emails: ['dana@example.org'] } },
    })
  })

  it('creates with no access when no one is chosen', async () => {
    const onCreate = vi.fn(async () => true)
    setup(onCreate)
    await userEvent.type(nameField(), 'spring')

    await userEvent.click(screen.getByTestId('create-branch-submit'))

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: 'spring' }))
  })

  it('shows why a create was refused to the user, keeping every value', async () => {
    const reason = accessRefusalMessage('BRANCH_CREATE_FORBIDDEN') as string
    setup(vi.fn(async () => ({ refusal: reason, field: 'form' as const })))
    await userEvent.type(nameField(), 'spring')
    await userEvent.type(screen.getByLabelText('Title'), 'Spring launch')
    await choose(/Bob Diaz/)

    await userEvent.click(screen.getByTestId('create-branch-submit'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(reason)
    expect(nameField().value).toBe('spring')
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Spring launch')
    expect(within(screen.getByTestId('share-with-chips')).getByText('Bob Diaz')).toBeTruthy()
  })

  it('shows why the people chosen were refused under "Share with", until the choice changes', async () => {
    const reason = accessRefusalMessage('USER_OUT_OF_SCOPE') as string
    setup(vi.fn(async () => ({ refusal: reason, field: 'shareWith' as const })))
    await userEvent.type(nameField(), 'spring')
    await choose(/Bob Diaz/)

    await userEvent.click(screen.getByTestId('create-branch-submit'))

    await waitFor(() => expect(fieldError()).toBe(reason))
    expect(shareWith().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByTestId('share-with-status').textContent).toBe(reason)
    await userEvent.click(screen.getByRole('button', { name: 'Remove Bob Diaz' }))
    expect(fieldError()).toBeUndefined()
  })

  it('says a branch was created and offers Share… for it, opening its Share dialog', async () => {
    setup(
      vi.fn(async () => ({ created: created.name })),
      { branches: [created] },
    )
    await userEvent.type(nameField(), 'spring')

    await userEvent.click(screen.getByTestId('create-branch-submit'))

    const status = await screen.findByTestId('branch-created-status')
    await waitFor(() => expect(status.textContent).toContain('Branch “spring” created'))
    const share = within(status).getByRole('button', { name: 'Share…' })
    await userEvent.click(share)
    expect(await screen.findByRole('dialog', { name: 'Share spring' })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share spring' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(share))
  })

  it('offers no Share… for a created branch the user cannot share', async () => {
    const unshareable = {
      ...created,
      sharing: { ...created.sharing!, canAdd: false, canManage: false },
    }
    setup(
      vi.fn(async () => ({ created: created.name })),
      { branches: [unshareable] },
    )
    await userEvent.type(nameField(), 'spring')

    await userEvent.click(screen.getByTestId('create-branch-submit'))

    const status = await screen.findByTestId('branch-created-status')
    await waitFor(() => expect(status.textContent).toContain('Branch “spring” created'))
    expect(within(status).queryByRole('button')).toBeNull()
  })
})
