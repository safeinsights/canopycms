import React, { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import { ApiTimeoutError } from '../../api/request-deadline'
import type { ApiErrorCode } from '../../api/types'
import type { UserSearchResult } from '../../auth/types'
import { RESERVED_GROUPS } from '../../authorization/helpers'
import { ApiClientProvider, type ApiClient } from '../context'
import { accessRefusalMessage } from '../copy'
import { gatewayPage } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import type { UserContext } from '../BranchManager'
import { ShareBranchDialog, type ShareTarget } from './ShareBranchDialog'
import { LISTED_ONLY_LINE, WIDENING_LINE } from './share-copy'
import type { BranchAccess } from './share-staging'

const AT = '2026-11-01T00:00:00.000Z'

const access = (over: Partial<BranchAccess> = {}): BranchAccess => ({
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
      id: 'team',
      name: 'Marketing team',
      addedBy: { id: 'ben', name: 'Ben Ortiz' },
      addedAt: AT,
    },
  ],
  restricted: true,
  openToEveryone: false,
  defaultAccess: 'deny',
  addBy: 'members',
  rights: { isOwner: true, canAdd: true, canManage: true },
  searchable: 'cms-users',
  addableByEmail: 'all-users',
  ...over,
})

const OWNER: UserContext = { userId: 'ana', groups: [] }
const names: Record<string, string> = { dana: 'Dana Park', chen: 'Chen Wu', ana: 'Ana Lee' }
const lookup = async (id: string): Promise<UserSearchResult | null> =>
  names[id] ? { id, name: names[id], email: '' } : null

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data })
const refusal = (status: number, code: ApiErrorCode) => ({
  ok: false as const,
  status,
  error: 'Refused',
  code,
})

interface Setup {
  data?: BranchAccess
  user?: UserContext
  branch?: Partial<ShareTarget>
  client?: MockApiClient
}

function setup({ data = access(), user = OWNER, branch, client }: Setup = {}) {
  const api = client ?? createMockApiClient()
  if (!client) api.branches.getAccess.mockResolvedValue(ok(data))
  const onClose = vi.fn()
  const onChanged = vi.fn()
  const target: ShareTarget = {
    name: 'canopycms/prod/spring',
    shortName: 'spring',
    createdBy: 'ana',
    ...branch,
  }
  const view = render(
    <CanopyCMSProvider>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <ShareBranchDialog
          opened
          onClose={onClose}
          onChanged={onChanged}
          branch={target}
          urlName="spring"
          user={user}
          getUserMetadata={lookup}
        />
      </ApiClientProvider>
    </CanopyCMSProvider>,
  )
  return { api, onClose, onChanged, view }
}

const row = (name: string) => {
  const rows = screen.getAllByRole('listitem')
  const found = rows.find((li) => within(li).queryByText(name, { exact: false }))
  if (!found) throw new Error(`No row for ${name}`)
  return found
}
const status = () => screen.getByTestId('share-status')
const loaded = () => screen.findAllByText(/Ben Ortiz/)
const footerClose = () =>
  screen.getAllByRole('button', { name: 'Close' }).find((button) => button.textContent === 'Close')!

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ShareBranchDialog: rows', () => {
  it('lists an owner their list: masked emails, who added each entry, Owner without a remove', async () => {
    setup()
    await loaded()

    expect(screen.getByRole('dialog', { name: 'Share spring' })).toBeTruthy()
    const ana = row('Ana Lee')
    expect(within(ana).getByText('Ana Lee (you)')).toBeTruthy()
    expect(within(ana).getByText('Owner')).toBeTruthy()
    expect(within(ana).queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(within(row('Ben Ortiz')).getByText('b•••@example.org · Added by you')).toBeTruthy()
    expect(within(row('Marketing team')).getByText('Group · Added by Ben Ortiz')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Ben Ortiz' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Marketing team' })).toBeTruthy()
    expect(screen.getByText(LISTED_ONLY_LINE)).toBeTruthy()
    expect(screen.getByText(/People on this list can open, submit and withdraw/)).toBeTruthy()
  })

  it('gives a member a remove only on what they added, and who can add as text', async () => {
    setup({
      user: { userId: 'ben', groups: [] },
      data: access({
        entries: [
          { kind: 'user', id: 'ana', name: 'Ana Lee' },
          { kind: 'user', id: 'ben', name: 'Ben Ortiz' },
          {
            kind: 'group',
            id: 'team',
            name: 'Marketing team',
            addedBy: { id: 'ben', name: 'Ben Ortiz' },
            addedAt: AT,
          },
        ],
        rights: { isOwner: false, canAdd: true, canManage: false },
      }),
    })
    await loaded()

    expect(
      screen.getAllByRole('button', { name: /^Remove / }).map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Remove Marketing team'])
    expect(screen.getByText('Who can add people: Anyone on this list')).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Who can add people' })).toBeNull()
  })

  it("gives an admin a remove on the owner's row and the Only admins choice", async () => {
    setup({
      user: { userId: 'root', groups: [RESERVED_GROUPS.ADMINS] },
      data: access({ rights: { isOwner: false, canAdd: true, canManage: true } }),
    })
    await loaded()

    expect(screen.getByRole('button', { name: 'Remove Ana Lee' })).toBeTruthy()
    const addBy = screen.getByRole('radiogroup', { name: 'Who can add people' })
    expect(within(addBy).getByRole('radio', { name: 'Only admins' })).toBeTruthy()
    expect(within(addBy).getByRole('radio', { name: 'Only the owner' })).toBeTruthy()
  })

  it('offers an owner who can add, without Only admins', async () => {
    const { api } = setup()
    await loaded()

    const addBy = screen.getByRole('radiogroup', { name: 'Who can add people' })
    expect(within(addBy).queryByRole('radio', { name: 'Only admins' })).toBeNull()
    fireEvent.click(within(addBy).getByRole('radio', { name: 'Only me' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess).toHaveBeenCalledWith(
      { branch: 'canopycms/prod/spring' },
      { addBy: 'owner' },
    )
  })

  it('shows a viewer the server says cannot add the list read-only, closed with Close', async () => {
    setup({
      data: access({ rights: { isOwner: false, canAdd: false, canManage: false } }),
      user: { userId: 'zoe' },
    })
    await loaded()

    expect(screen.queryByTestId('share-people-input')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
    expect(footerClose()).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update access' })).toBeNull()
  })
})

describe('ShareBranchDialog: adding people', () => {
  it('finds people by name, picks one by keyboard, and says so', async () => {
    const { api } = setup()
    api.branches.findPeople.mockImplementation(async (_params, body) =>
      ok(
        body.query === 'Co'
          ? {
              people: [{ id: 'cole', name: 'Cole Ortiz', maskedEmail: 'c•••@example.org' }],
              groups: [],
            }
          : { people: [], groups: [] },
      ),
    )
    await loaded()
    const input = screen.getByRole('textbox', { name: 'Add people or groups' })
    expect(input.getAttribute('placeholder')).toBe('Name or email address')

    await userEvent.type(input, 'Co')
    await screen.findByRole('option', { name: /Cole Ortiz/ })
    await waitFor(() => expect(status().textContent).toBe('1 person found'))
    await userEvent.keyboard('{Enter}')

    expect(within(row('Cole Ortiz')).getByText(/Added by you · Unsaved/)).toBeTruthy()
    expect(status().textContent).toBe('Added Cole Ortiz')
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('says no one matched, and how to add them instead', async () => {
    setup()
    await loaded()

    await userEvent.type(screen.getByRole('textbox', { name: 'Add people or groups' }), 'Zz')

    expect(
      await screen.findByText('No one found. Type their full email address to add them.'),
    ).toBeTruthy()
    await waitFor(() => expect(status().textContent).toBe('0 people found'))
  })

  it('shows suggestions under "Recently shared with" while empty, and groups labelled Group', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({
        people: [{ id: 'cole', name: 'Cole Ortiz' }],
        groups: [{ id: 'design', name: 'Design' }],
      }),
    )
    await loaded()

    fireEvent.focus(screen.getByRole('textbox', { name: 'Add people or groups' }))

    const recent = await screen.findByText('Recently shared with')
    expect(recent).toBeTruthy()
    expect(api.branches.findPeople).toHaveBeenCalledWith(
      { branch: 'canopycms/prod/spring' },
      { query: '' },
    )
    expect(screen.getByRole('option', { name: /Design\s*Group/ })).toBeTruthy()
  })

  it('adds an address by the id its find returned, never looking it up twice', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({
        people: [{ id: 'dana', name: 'Dana Park', maskedEmail: 'd•••@example.org' }],
        groups: [],
      }),
    )
    await loaded()
    const input = screen.getByRole('textbox', { name: 'Add people or groups' })

    await userEvent.type(input, 'dana@example.org')
    await userEvent.click(await screen.findByRole('option', { name: 'Add dana@example.org' }))
    await screen.findByText('Dana Park')
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.findPeople).toHaveBeenCalledWith(expect.anything(), {
      query: 'dana@example.org',
    })
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ add: { users: ['dana'] } })
  })

  it('sends an address as an email only when its find never answered', async () => {
    const { api } = setup()
    api.branches.findPeople.mockRejectedValue(new TypeError('Failed to fetch'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await loaded()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Add people or groups' }),
      'dana@example.org',
    )
    await userEvent.click(await screen.findByRole('option', { name: 'Add dana@example.org' }))
    await waitFor(() => expect(row('dana@example.org')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({
      add: { emails: ['dana@example.org'] },
    })
  })

  it.each([
    [
      'all-users',
      'No account uses that email address yet. Ask them to sign in to the editor once, then try again in about 15 minutes.',
    ],
    ['cms-users', 'No one who works in this editor uses that email address.'],
  ] as const)('says an address under %s found no one', async (scope, message) => {
    const { api } = setup({ data: access({ addableByEmail: scope }) })
    api.branches.findPeople.mockResolvedValue(ok({ people: [], groups: [] }))
    await loaded()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Add people or groups' }),
      'x@example.org',
    )
    await userEvent.click(await screen.findByRole('option', { name: 'Add x@example.org' }))

    expect(await screen.findByText(message)).toBeTruthy()
  })

  it('says when email lookups are over their limit', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(refusal(429, 'RATE_LIMITED'))
    await loaded()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Add people or groups' }),
      'x@example.org',
    )
    await userEvent.click(await screen.findByRole('option', { name: 'Add x@example.org' }))

    expect(
      await screen.findByText('Too many email lookups. Try again in a few minutes.'),
    ).toBeTruthy()
  })

  it("asks only for an address where names can't be searched", async () => {
    setup({ data: access({ searchable: 'nobody' }) })
    await loaded()

    expect(
      screen.getByRole('textbox', { name: 'Add people or groups' }).getAttribute('placeholder'),
    ).toBe('Email address')
  })

  it('hints at what to type when there is nothing to suggest, and Esc closes only the hint', async () => {
    const { api, onClose } = setup()
    api.branches.findPeople.mockResolvedValue(ok({ people: [], groups: [] }))
    await loaded()
    const input = screen.getByRole('textbox', { name: 'Add people or groups' })
    input.focus()
    fireEvent.focus(input)

    expect(await screen.findByText('Type a name or a full email address.')).toBeTruthy()
    expect(input.getAttribute('aria-expanded')).toBe('true')
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(input.getAttribute('aria-expanded')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes only the list on Esc, and the dialog on the next', async () => {
    const { api, onClose } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'cole', name: 'Cole Ortiz' }], groups: [] }),
    )
    await loaded()
    const input = screen.getByRole('textbox', { name: 'Add people or groups' })
    input.focus()
    fireEvent.focus(input)
    await screen.findByRole('option', { name: /Cole Ortiz/ })

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('option', { name: /Cole Ortiz/ })).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ShareBranchDialog: removing and staging', () => {
  it('takes a removed row out, focuses the next remove, and Undo brings it back focused', async () => {
    setup()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))

    expect(screen.queryByText('Ben Ortiz')).toBeNull()
    expect(
      within(screen.getByTestId('share-status-line')).getByText('Removed Ben Ortiz.'),
    ).toBeTruthy()
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove Marketing team' }),
      ),
    )
    expect(status().textContent).toBe('Removed Ben Ortiz')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Ben Ortiz' })),
    )
    expect(status().textContent).toBe('Restored Ben Ortiz')
    expect(screen.queryByTestId('share-status-line')).toBeNull()
  })

  it('focuses the input when no row follows the removed one', async () => {
    setup()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'Add people or groups' }),
      ),
    )
  })

  it('discards staged edits: the dismiss button says so and sends nothing', async () => {
    const { api, onClose } = setup()
    await loaded()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.branches.updateAccess).not.toHaveBeenCalled()
  })

  it('sends every staged change in one PATCH, then closes and reads the list again', async () => {
    const { api, onClose, onChanged } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'cole', name: 'Cole Ortiz' }], groups: [] }),
    )
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Add people or groups' }), 'Co')
    await userEvent.click(await screen.findByRole('option', { name: /Cole Ortiz/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess).toHaveBeenCalledTimes(1)
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({
      add: { users: ['cole'] },
      remove: { users: ['ben'] },
    })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('holds Update access back, with its reason, until something changes', async () => {
    const { api } = setup()
    await loaded()
    const update = screen.getByRole('button', { name: 'Update access' })

    expect(update.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(update)
    await userEvent.hover(update)
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/Nothing has changed yet/)
    expect(api.branches.updateAccess).not.toHaveBeenCalled()
  })

  it("warns, before the update, that the owner can't add back a group they aren't in", async () => {
    setup()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))

    expect(screen.getByText("You can't add Marketing team back yourself.")).toBeTruthy()
  })

  it('does not warn about a group the owner belongs to', async () => {
    setup({ user: { userId: 'ana', groups: ['team'] } })
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))

    expect(screen.queryByText(/back yourself/)).toBeNull()
  })

  it('lists removed people under "Removed (n)", and Allow again stages lifting the exclusion', async () => {
    const { api } = setup({
      data: access({
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
      }),
    })
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Removed (2)' }))
    expect(within(row('Sam Reed')).getByText('Removed by an admin')).toBeTruthy()
    expect(within(row('Sam Reed')).queryByRole('button')).toBeNull()
    expect(within(row('Pat Alvarez')).getByText('Removed by you')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow again: Pat Alvarez' }))

    expect(screen.getByText('Pat Alvarez will be allowed again.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Removed (1)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ unexclude: { users: ['pat'] } })
  })

  it('hides "Removed (n)" from a member', async () => {
    setup({
      user: { userId: 'ben' },
      data: access({
        rights: { isOwner: false, canAdd: true, canManage: false },
        excluded: [
          {
            kind: 'user',
            id: 'pat',
            name: 'Pat Alvarez',
            by: { id: 'ana', name: 'Ana Lee' },
            at: AT,
            byAdmin: false,
          },
        ],
      }),
    })
    await loaded()

    expect(screen.queryByRole('button', { name: /Removed \(/ })).toBeNull()
  })
})

describe("ShareBranchDialog: general access on an 'allow' site", () => {
  const open = access({
    entries: [],
    restricted: false,
    openToEveryone: true,
    defaultAccess: 'allow',
  })

  it('names the editors who would lose access before the first add, and adds them on request', async () => {
    const { api } = setup({ data: open, branch: { editors: ['ana', 'dana', 'chen'] } })
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'cole', name: 'Cole Ortiz' }], groups: [] }),
    )
    await screen.findByRole('radio', { name: 'Anyone who can sign in to the editor' })

    await userEvent.type(screen.getByRole('textbox', { name: 'Add people or groups' }), 'Co')
    await userEvent.click(await screen.findByRole('option', { name: /Cole Ortiz/ }))

    const warning = await screen.findByTestId('share-narrowing')
    await waitFor(() =>
      expect(warning.textContent).toContain(
        'Dana Park and Chen Wu are working on this branch and will lose access.',
      ),
    )
    expect(
      (screen.getByRole('radio', { name: 'Only people listed here' }) as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.click(within(warning).getByRole('button', { name: 'Add them too' }))

    expect(screen.queryByTestId('share-narrowing')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({
      add: { users: ['cole', 'dana', 'chen'] },
    })
  })

  it('warns on switching to "Only people listed here" too, and sends restricted', async () => {
    const { api } = setup({ data: open, branch: { editors: ['dana'] } })
    fireEvent.click(await screen.findByRole('radio', { name: 'Only people listed here' }))

    await waitFor(() =>
      expect(screen.getByTestId('share-narrowing').textContent).toContain(
        'Dana Park is working on this branch',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ restricted: true })
  })

  it('confirms widening in the status line and sends it alone', async () => {
    const { api } = setup({ data: access({ defaultAccess: 'allow' }) })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))

    fireEvent.click(screen.getByRole('radio', { name: 'Anyone who can sign in to the editor' }))

    expect(within(screen.getByTestId('share-status-line')).getByText(WIDENING_LINE)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ restricted: false })
  })

  it("shows a member the branch's general access as text", async () => {
    setup({
      user: { userId: 'ben' },
      data: access({
        defaultAccess: 'allow',
        rights: { isOwner: false, canAdd: true, canManage: false },
      }),
    })
    await loaded()

    expect(screen.queryByRole('radiogroup', { name: 'General access' })).toBeNull()
    expect(screen.getByTestId('share-general-access').textContent).toBe(LISTED_ONLY_LINE)
  })
})

describe('ShareBranchDialog: states', () => {
  it('shows skeleton rows while loading, with the input usable', async () => {
    const api = createMockApiClient()
    api.branches.getAccess.mockReturnValue(new Promise(() => {}))
    setup({
      client: api,
      branch: {
        sharing: {
          isOwner: true,
          canAdd: true,
          canManage: true,
          restricted: true,
          openToEveryone: false,
          addBy: 'members',
        },
      },
    })

    expect(screen.getByTestId('share-loading')).toBeTruthy()
    expect(
      (screen.getByRole('textbox', { name: 'Add people or groups' }) as HTMLInputElement).disabled,
    ).toBe(false)
  })

  it('says the list could not be loaded, above where it goes, and Retry reads it again', async () => {
    const api = createMockApiClient()
    api.branches.getAccess
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'Boom' })
      .mockResolvedValueOnce(ok(access()))
    setup({ client: api })

    const alert = await screen.findByTestId('share-load-failed')
    expect(alert.textContent).toContain("Who has access couldn't be loaded.")
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    await loaded()
    expect(api.branches.getAccess).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['BRANCH_ACCESS_DENIED', 'You no longer have access to this branch.'],
    ['BRANCH_LOCKED_DOWN', 'An admin has limited this branch to admins and reviewers.'],
  ] as const)('turns a %s refusal on load into its sentence, with Close', async (code, message) => {
    const api = createMockApiClient()
    api.branches.getAccess.mockResolvedValue(refusal(403, code))
    const { onClose, onChanged } = setup({ client: api })

    const alert = await screen.findByTestId('share-refused')
    expect(alert.textContent).toBe(message)
    fireEvent.click(footerClose())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('turns a refusal mid-dialog into a yellow notice with Close', async () => {
    const { api } = setup()
    api.branches.updateAccess.mockResolvedValue(refusal(403, 'ACCESS_MANAGE_FORBIDDEN'))
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    expect((await screen.findByTestId('share-refused')).textContent).toBe(
      accessRefusalMessage('ACCESS_MANAGE_FORBIDDEN'),
    )
  })

  it('keeps the staged edits after a refused change, says why, and Retry sends it again', async () => {
    const { api } = setup()
    api.branches.updateAccess.mockResolvedValueOnce(refusal(400, 'USER_EXCLUDED'))
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(problem.textContent).toContain(accessRefusalMessage('USER_EXCLUDED'))
    expect(screen.queryByText('Ben Ortiz')).toBeNull()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy()
    fireEvent.click(within(problem).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(2))
    expect(api.branches.updateAccess.mock.calls[1][1]).toEqual({ remove: { users: ['ben'] } })
  })

  it('reads the list again after an update gets no answer, and closes when it landed', async () => {
    const { api, onClose, onChanged } = setup()
    api.branches.updateAccess.mockResolvedValue(await gatewayPage(504))
    await loaded()
    api.branches.getAccess.mockResolvedValue(
      ok(access({ entries: access().entries.filter((e) => e.id !== 'ben') })),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(api.branches.getAccess).toHaveBeenCalledTimes(2)
  })

  it('warns in yellow when the read after a timeout shows the change has not landed', async () => {
    const { api, onClose } = setup()
    api.branches.updateAccess.mockRejectedValue(new ApiTimeoutError('PATCH', '/x', 1000))
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(problem.textContent).toContain(
      "may have gone through even though the server didn't answer",
    )
    expect(problem.outerHTML).toMatch(/yellow/)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('copies a link to the branch and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    await waitFor(() => expect(status().textContent).toBe('Link copied'))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^http.*\?branch=spring$/))
  })
})

describe('ShareBranchDialog: lockdown', () => {
  it('tells an admin that a locked branch keeps out the people listed', async () => {
    setup({
      user: { userId: 'root', groups: [RESERVED_GROUPS.ADMINS] },
      branch: { access: { managerOrAdminAllowed: true } },
    })
    await loaded()

    expect(screen.getByTestId('share-lockdown').textContent).toMatch(
      /locked to admins and reviewers/,
    )
  })
})

describe('ShareBranchDialog: focus', () => {
  it('returns focus to its opener on close', async () => {
    const api = createMockApiClient()
    api.branches.getAccess.mockResolvedValue(ok(access()))
    function Harness() {
      const [opened, setOpened] = useState(false)
      const opener = React.useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={opener} onClick={() => setOpened(true)}>
            Opener
          </button>
          <ShareBranchDialog
            opened={opened}
            onClose={() => setOpened(false)}
            onChanged={() => {}}
            branch={{ name: 'spring', createdBy: 'ana' }}
            urlName="spring"
            user={OWNER}
            getUserMetadata={lookup}
            returnFocusTo={() => opener.current}
          />
        </>
      )
    }
    render(
      <CanopyCMSProvider>
        <ApiClientProvider client={api as unknown as ApiClient}>
          <Harness />
        </ApiClientProvider>
      </CanopyCMSProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Opener' }))
    await loaded()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Opener' })),
    )
  })
})
