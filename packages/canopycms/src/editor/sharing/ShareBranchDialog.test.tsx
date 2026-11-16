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
  whoCanAdd: 'members',
  rights: { isOwner: true, canAdd: true, canManage: true },
  searchable: 'cms-users',
  addableByEmail: 'all-users',
  ...over,
})

const OWNER: UserContext = { userId: 'ana', groups: [] }
const OWNER_SHARING: NonNullable<ShareTarget['sharing']> = {
  isOwner: true,
  canAdd: true,
  canManage: true,
  restricted: true,
  openToEveryone: false,
  addBy: 'members',
}
const DANA = { id: 'dana', name: 'Dana Park' }
const CHEN = { id: 'chen', name: 'Chen Wu' }
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
/** `text` shows in the status line and is what the live region announced, word for word. */
const said = (text: string) =>
  within(screen.getByTestId('share-status-line')).queryByText(text) !== null &&
  status().textContent === text
const loaded = () => screen.findAllByText(/Ben Ortiz/)
const footerClose = () =>
  screen.getAllByRole('button', { name: 'Close' }).find((button) => button.textContent === 'Close')!
const modalClose = () =>
  screen.getAllByRole('button', { name: 'Close' }).find((button) => button.textContent !== 'Close')!
const picker = () => screen.getByRole('textbox', { name: 'Add people or groups' })
/** A failed add by address closes the list, which would cover the error, leaving focus in the field. */
const expectListClosedOverError = () => {
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.queryByRole('option')).toBeNull()
  expect(document.activeElement).toBe(picker())
}
/** The picker's own error, which names it by `aria-describedby`. */
const fieldError = () =>
  (picker().getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id))
    .find((node) => node?.className.includes('error'))?.textContent
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ShareBranchDialog: rows', () => {
  it('lists an owner their list: masked emails, who added each entry, Owner without a remove', async () => {
    setup()
    await loaded()

    expect(screen.getByRole('dialog', { name: 'Share “spring”' })).toBeTruthy()
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

  it("says only Owner on the owner's row, whoever added them to the list", async () => {
    const [ana, ...rest] = access().entries
    setup({
      data: access({ entries: [{ ...ana, addedBy: { id: 'ana', name: 'Ana Lee' } }, ...rest] }),
    })
    await loaded()

    const owner = row('Ana Lee')
    expect(within(owner).getByText('Owner')).toBeTruthy()
    expect(within(owner).queryByText(/Added by/)).toBeNull()
    expect(within(row('Ben Ortiz')).getByText(/Added by you/)).toBeTruthy()
  })

  it('holds a row in place for each person and group the listing names while loading', async () => {
    const api = createMockApiClient()
    api.branches.getAccess.mockReturnValue(new Promise(() => {}))
    setup({ client: api, branch: { access: { users: ['ana', 'ben'], groups: ['team'] } } })

    expect(await screen.findAllByTestId('share-loading-row')).toHaveLength(3)
  })

  it('holds one row for an owner the listing names alone', async () => {
    const api = createMockApiClient()
    api.branches.getAccess.mockReturnValue(new Promise(() => {}))
    setup({ client: api, branch: { access: { users: [], groups: [] } } })

    expect(await screen.findAllByTestId('share-loading-row')).toHaveLength(1)
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

  it('tells a member who can add as the server answers it, not the setting alone', async () => {
    setup({
      user: { userId: 'ben', groups: [] },
      data: access({
        addBy: 'members',
        whoCanAdd: 'admins',
        rights: { isOwner: false, canAdd: true, canManage: false },
      }),
    })
    await loaded()

    expect(screen.getByText('Who can add people: Only admins')).toBeTruthy()
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

    await userEvent.click(picker())

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

  it('adds someone found outside the editor by the address that found them', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'dana', name: 'Dana Park', addByAddress: true }], groups: [] }),
    )
    await loaded()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Add people or groups' }),
      'dana@example.org',
    )
    await userEvent.click(await screen.findByRole('option', { name: 'Add dana@example.org' }))
    await screen.findByText('Dana Park')
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({
      add: { emails: ['dana@example.org'] },
    })
  })

  it('adds by id someone an admin or reviewer found by address, shown in full', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'dana', name: 'Dana Park', email: 'dana@example.org' }], groups: [] }),
    )
    await loaded()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Add people or groups' }),
      'dana@example.org',
    )
    await userEvent.click(await screen.findByRole('option', { name: 'Add dana@example.org' }))
    await screen.findByText('Dana Park')
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
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
      'No one found for that address, or they already have access or were removed. Someone new signs in to the editor once, then can be found about 15 minutes later.',
    ],
    [
      'cms-users',
      'No one who works in this editor was found for that address, or they already have access or were removed.',
    ],
  ] as const)('says an address under %s found no one', async (scope, message) => {
    const { api } = setup({ data: access({ addableByEmail: scope }) })
    api.branches.findPeople.mockResolvedValue(ok({ people: [], groups: [] }))
    await loaded()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Add people or groups' }),
      'x@example.org',
    )
    await userEvent.click(await screen.findByRole('option', { name: 'Add x@example.org' }))

    await waitFor(() => expect(fieldError()).toBe(message))
    expect(status().textContent).toBe(message)
    expectListClosedOverError()
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

    const message = 'Too many email lookups. Try again in a few minutes.'
    await waitFor(() => expect(fieldError()).toBe(message))
    expect(status().textContent).toBe(message)
    expectListClosedOverError()
  })

  it("asks only for an address where names can't be searched", async () => {
    setup({ data: access({ searchable: 'nobody' }) })
    await loaded()

    expect(picker().getAttribute('placeholder')).toBe('Email address')
  })

  it("sends no name search where names can't be searched, and says so at once", async () => {
    const { api } = setup({ data: access({ searchable: 'nobody' }) })
    await loaded()

    await userEvent.type(picker(), 'Dana')

    expect(await screen.findByText('Type their full email address.')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(api.branches.findPeople).not.toHaveBeenCalledWith(expect.anything(), { query: 'Dana' })
  })

  it('opens no list on focus, only on a click, ArrowDown or typing', async () => {
    setup()
    await loaded()
    const input = picker()
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(input.getAttribute('aria-expanded')).toBeNull()

    await userEvent.keyboard('{ArrowDown}')

    await waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('true'))
  })

  it('looks an address up once however often it is picked while the lookup runs', async () => {
    const { api } = setup()
    const lookup =
      deferred<ReturnType<typeof ok<{ people: { id: string; name: string }[]; groups: never[] }>>>()
    api.branches.findPeople.mockImplementation(async (_params, body) =>
      body.query === 'dana@example.org' ? lookup.promise : ok({ people: [], groups: [] }),
    )
    await loaded()

    await userEvent.type(picker(), 'dana@example.org')
    const option = await screen.findByRole('option', { name: 'Add dana@example.org' })
    fireEvent.click(option)
    fireEvent.click(option)
    lookup.resolve(ok({ people: [{ id: 'dana', name: 'Dana Park' }], groups: [] }))

    await screen.findByText('Dana Park')
    expect(
      api.branches.findPeople.mock.calls.filter(([, body]) => body.query === 'dana@example.org'),
    ).toHaveLength(1)
    expect(screen.getAllByText('Dana Park')).toHaveLength(1)
  })

  it('shows the answer for what is typed now, never a late answer for an earlier query', async () => {
    const { api } = setup()
    const late =
      deferred<ReturnType<typeof ok<{ people: { id: string; name: string }[]; groups: never[] }>>>()
    api.branches.findPeople.mockImplementation(async (_params, body) =>
      body.query === 'Col'
        ? late.promise
        : ok({
            people: body.query === 'Co' ? [{ id: 'cole', name: 'Cole Ortiz' }] : [],
            groups: [],
          }),
    )
    await loaded()

    await userEvent.type(picker(), 'Co')
    await screen.findByRole('option', { name: /Cole Ortiz/ })
    await userEvent.type(picker(), 'l')
    await waitFor(() =>
      expect(api.branches.findPeople).toHaveBeenCalledWith(expect.anything(), { query: 'Col' }),
    )
    await userEvent.type(picker(), '{Backspace}')
    late.resolve(ok({ people: [], groups: [] }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(screen.getByRole('option', { name: /Cole Ortiz/ })).toBeTruthy()
    expect(screen.queryByText('Searching…')).toBeNull()
  })

  it('hints at what to type when there is nothing to suggest, and Esc closes only the hint', async () => {
    const { api, onClose } = setup()
    api.branches.findPeople.mockResolvedValue(ok({ people: [], groups: [] }))
    await loaded()
    const input = picker()
    await userEvent.click(input)

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
    await userEvent.click(picker())
    await screen.findByRole('option', { name: /Cole Ortiz/ })

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('option', { name: /Cole Ortiz/ })).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ShareBranchDialog: removing and staging', () => {
  it('strikes a removed row through with its own Undo, focuses the next remove, and Undo refocuses it', async () => {
    setup()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))

    expect(within(row('Ben Ortiz')).getByText('Will be removed')).toBeTruthy()
    expect(within(row('Ben Ortiz')).getByText('Ben Ortiz').style.textDecoration).toBe(
      'line-through',
    )
    expect(screen.queryByTestId('share-status-line')).toBeNull()
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove Marketing team' }),
      ),
    )
    expect(status().textContent).toBe('Removed Ben Ortiz')

    fireEvent.click(screen.getByRole('button', { name: 'Undo removing Ben Ortiz' }))

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Ben Ortiz' })),
    )
    expect(status().textContent).toBe('Restored Ben Ortiz')
    expect(within(row('Ben Ortiz')).queryByText('Will be removed')).toBeNull()
  })

  it('keeps each staged removal undoable, not only the latest', async () => {
    const { api } = setup()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo removing Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ remove: { groups: ['team'] } })
  })

  it('takes out an unsaved add with Undo in the status line, which refocuses the restored row', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'cole', name: 'Cole Ortiz' }], groups: [] }),
    )
    await loaded()
    await userEvent.type(picker(), 'Co')
    await userEvent.click(await screen.findByRole('option', { name: /Cole Ortiz/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Remove Cole Ortiz' }))
    expect(screen.queryByText('Cole Ortiz')).toBeNull()
    fireEvent.click(
      within(screen.getByTestId('share-status-line')).getByRole('button', { name: 'Undo' }),
    )

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove Cole Ortiz' }),
      ),
    )
  })

  it('stages an add once, even when an Undo puts back what the picker added again', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'cole', name: 'Cole Ortiz' }], groups: [] }),
    )
    await loaded()
    const pick = async () => {
      await userEvent.type(picker(), 'Co')
      await userEvent.click(await screen.findByRole('option', { name: /Cole Ortiz/ }))
    }

    await pick()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cole Ortiz' }))
    await pick()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(screen.getAllByText('Cole Ortiz')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ add: { users: ['cole'] } })
  })

  it("focuses the removed row's own Undo when no row follows it", async () => {
    setup()
    await loaded()

    await userEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Undo removing Marketing team' }),
      ),
    )
  })

  it('focuses the input when the last row was an unsaved add, which leaves no row', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'cole', name: 'Cole Ortiz' }], groups: [] }),
    )
    await loaded()
    await userEvent.type(picker(), 'Co')
    await userEvent.click(await screen.findByRole('option', { name: /Cole Ortiz/ }))
    const removes = screen.getAllByRole('button', { name: /^Remove / })
    expect(removes.at(-1)).toBe(screen.getByRole('button', { name: 'Remove Cole Ortiz' }))

    await userEvent.click(screen.getByRole('button', { name: 'Remove Cole Ortiz' }))

    await waitFor(() => expect(document.activeElement).toBe(picker()))
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

    const warning = screen.getByText("You can't add Marketing team back yourself.")
    expect(warning.parentElement?.querySelector('svg')?.getAttribute('stroke')).toBe(
      'var(--mantine-color-text)',
    )
    expect(status().textContent).toBe(
      "Removed Marketing team. You can't add Marketing team back yourself.",
    )
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
    expect(
      within(row('Sam Reed')).getByText('Removed by an admin. Only an admin can allow them back.'),
    ).toBeTruthy()
    expect(within(row('Sam Reed')).queryByRole('button')).toBeNull()
    expect(within(row('Pat Alvarez')).getByText('Removed by you')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow again: Pat Alvarez' }))

    expect(said('Pat Alvarez will be added back.')).toBe(true)
    expect(within(row('Pat Alvarez')).getByText(/Unsaved/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Removed (1)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ add: { users: ['pat'] } })
  })

  it('tells an owner only an admin can allow back a group an admin removed', async () => {
    setup({
      data: access({
        excluded: [
          {
            kind: 'group',
            id: 'ops',
            name: 'Ops',
            by: { id: 'root', name: 'Ada Admin' },
            at: AT,
            byAdmin: true,
          },
        ],
      }),
    })
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Removed (1)' }))
    expect(
      within(row('Ops')).getByText('Removed by an admin. Only an admin can allow it back.'),
    ).toBeTruthy()
    expect(within(row('Ops')).queryByRole('button')).toBeNull()
  })

  it("gives an admin Allow again on an admin's removal, without saying only an admin can", async () => {
    setup({
      user: { userId: 'root', groups: [RESERVED_GROUPS.ADMINS] },
      data: access({
        rights: { isOwner: false, canAdd: true, canManage: true },
        excluded: [
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

    fireEvent.click(screen.getByRole('button', { name: 'Removed (1)' }))
    expect(within(row('Sam Reed')).getByText('Removed by you')).toBeTruthy()
    expect(within(row('Sam Reed')).queryByText(/Only an admin/)).toBeNull()
    expect(
      within(row('Sam Reed')).getByRole('button', { name: 'Allow again: Sam Reed' }),
    ).toBeTruthy()
  })

  it('only lifts the exclusion of a group the owner is not in, and says it is not added back', async () => {
    const { api } = setup({
      data: access({
        excluded: [
          {
            kind: 'group',
            id: 'ops',
            name: 'Ops',
            by: { id: 'ana', name: 'Ana Lee' },
            at: AT,
            byAdmin: false,
          },
        ],
      }),
    })
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Removed (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow again: Ops' }))

    expect(said('Ops will be allowed again, but not added back to the list.')).toBe(true)
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(screen.getByTestId('share-status-line')).getByRole('button', { name: 'Undo' }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ unexclude: { groups: ['ops'] } })
  })

  it('on an open branch only lifts the exclusion, which lets them open it again', async () => {
    const { api } = setup({
      data: access({
        entries: [],
        restricted: false,
        openToEveryone: true,
        defaultAccess: 'allow',
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
    fireEvent.click(await screen.findByRole('button', { name: 'Removed (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow again: Pat Alvarez' }))

    expect(said('Pat Alvarez will be able to open this branch again.')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ unexclude: { users: ['pat'] } })
  })

  it("focuses the restored row's Remove once someone is allowed back onto the list", async () => {
    setup({
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
        ],
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Removed (1)' }))

    await userEvent.click(screen.getByRole('button', { name: 'Allow again: Pat Alvarez' }))

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove Pat Alvarez' }),
      ),
    )
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
    const { api } = setup({ data: { ...open, losingAccess: [DANA, CHEN] } })
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
    const { api } = setup({ data: { ...open, losingAccess: [DANA] } })
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

    expect(said(WIDENING_LINE)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ restricted: false })
  })

  it('says the removed stay out when widening, opens "Removed", and announces it', async () => {
    const removedBy = { by: { id: 'ana', name: 'Ana Lee' }, at: AT, byAdmin: false }
    setup({
      data: access({
        defaultAccess: 'allow',
        excluded: [{ kind: 'user', id: 'pat', name: 'Pat Alvarez', ...removedBy }],
      }),
    })
    await loaded()
    expect(screen.queryByRole('button', { name: 'Allow again: Pat Alvarez' })).toBeNull()
    expect(
      screen.getByText('Except the 1 person removed from this branch (see "Removed").'),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Anyone who can sign in to the editor' }))

    expect(
      said(
        'Everyone who can sign in will be able to open this branch, except the 1 person removed from this branch (see "Removed"), and the list will be cleared.',
      ),
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Allow again: Pat Alvarez' })).toBeTruthy()
  })

  it('counts removed people and groups in agreement when widening', async () => {
    const removedBy = { by: { id: 'ana', name: 'Ana Lee' }, at: AT, byAdmin: false }
    setup({
      data: access({
        defaultAccess: 'allow',
        excluded: [
          { kind: 'user', id: 'pat', name: 'Pat Alvarez', ...removedBy },
          { kind: 'user', id: 'sam', name: 'Sam Reed', ...removedBy },
          { kind: 'group', id: 'ops', name: 'Operations', ...removedBy },
        ],
      }),
    })
    await loaded()

    fireEvent.click(screen.getByRole('radio', { name: 'Anyone who can sign in to the editor' }))

    expect(
      said(
        'Everyone who can sign in will be able to open this branch, except the 2 people and 1 group removed from this branch (see "Removed"), and the list will be cleared.',
      ),
    ).toBe(true)
  })

  it('gives way to a removal staged after "Anyone who can sign in", sending the removal', async () => {
    const { api } = setup({ data: access({ defaultAccess: 'allow' }) })
    await loaded()
    fireEvent.click(screen.getByRole('radio', { name: 'Anyone who can sign in to the editor' }))

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))

    expect(screen.queryByText(WIDENING_LINE)).toBeNull()
    expect(
      (screen.getByRole('radio', { name: 'Only people listed here' }) as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ remove: { users: ['ben'] } })
  })

  it('gives way to an Allow again staged after "Anyone who can sign in"', async () => {
    const { api } = setup({
      data: access({
        defaultAccess: 'allow',
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
    fireEvent.click(screen.getByRole('radio', { name: 'Anyone who can sign in to the editor' }))

    fireEvent.click(screen.getByRole('button', { name: 'Allow again: Pat Alvarez' }))
    expect(
      said(
        "Pat Alvarez will be added back. Opening the branch to everyone can't be combined with other changes, so it stays limited to the people listed.",
      ),
    ).toBe(true)
    expect(
      (screen.getByRole('radio', { name: 'Only people listed here' }) as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ add: { users: ['pat'] } })
  })

  it('hides who can add people while the branch is open to everyone', async () => {
    setup({ data: open })
    await screen.findByRole('radio', { name: 'Anyone who can sign in to the editor' })

    expect(screen.queryByRole('radiogroup', { name: 'Who can add people' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Only people listed here' }))
    expect(screen.getByRole('radiogroup', { name: 'Who can add people' })).toBeTruthy()
  })

  it('names whom the server says would lose access, less anyone staged to be added', async () => {
    const { api } = setup({
      data: { ...open, losingAccess: [DANA, { id: 'cole', name: 'Cole Ortiz' }] },
    })
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'cole', name: 'Cole Ortiz' }], groups: [] }),
    )
    await screen.findByRole('radio', { name: 'Only people listed here' })

    await userEvent.type(picker(), 'Co')
    await userEvent.click(await screen.findByRole('option', { name: /Cole Ortiz/ }))

    await waitFor(() =>
      expect(screen.getByTestId('share-narrowing').textContent).toContain(
        'Dana Park is working on this branch and will lose access.',
      ),
    )
  })

  it('says editors may lose access when a group being added could hold them', async () => {
    const { api } = setup({ data: { ...open, losingAccess: [DANA] } })
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [], groups: [{ id: 'design', name: 'Design' }] }),
    )
    await screen.findByRole('radio', { name: 'Only people listed here' })

    await userEvent.type(picker(), 'De')
    await userEvent.click(await screen.findByRole('option', { name: /Design/ }))

    await waitFor(() =>
      expect(screen.getByTestId('share-narrowing').textContent).toContain(
        'Dana Park is working on this branch and may lose access.',
      ),
    )
  })

  it('drops a staged "Who can add people" on going back to "Anyone who can sign in"', async () => {
    const { api } = setup({ data: open })
    fireEvent.click(await screen.findByRole('radio', { name: 'Only people listed here' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Only me' }))

    fireEvent.click(screen.getByRole('radio', { name: 'Anyone who can sign in to the editor' }))

    expect(
      screen.getByRole('button', { name: 'Update access' }).getAttribute('aria-disabled'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    expect(api.branches.updateAccess).not.toHaveBeenCalled()
  })

  it("shows a locked, unlisted branch's general access as unlisted to an admin", async () => {
    setup({
      user: { userId: 'root', groups: [RESERVED_GROUPS.ADMINS] },
      branch: { access: { managerOrAdminAllowed: true } },
      data: access({
        entries: [],
        restricted: false,
        openToEveryone: false,
        defaultAccess: 'allow',
        rights: { isOwner: false, canAdd: true, canManage: true },
      }),
    })

    const open = await screen.findByRole('radio', { name: 'Anyone who can sign in to the editor' })
    expect((open as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('share-lockdown')).toBeTruthy()
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
  it('shows skeleton rows while loading, with the input held back and saying why', async () => {
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
    expect((picker() as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('Loading who has access…')).toBeTruthy()
    await userEvent.hover(screen.getByRole('button', { name: 'Update access' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Who has access is still loading.',
    )
  })

  it('says the list could not be loaded, above where it goes, and Retry reads it again', async () => {
    const api = createMockApiClient()
    api.branches.getAccess
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'Boom' })
      .mockResolvedValueOnce(ok(access()))
    setup({ client: api, branch: { sharing: OWNER_SHARING } })

    const alert = await screen.findByTestId('share-load-failed')
    expect(alert.textContent).toContain("Who has access couldn't be loaded.")
    expect((picker() as HTMLInputElement).disabled).toBe(true)
    // The picker sits above its Retry; the tooltip on Update access, below it.
    expect(screen.getAllByText("Who has access hasn't loaded yet. Retry below.")).toHaveLength(1)
    expect(screen.queryByText("Who has access hasn't loaded yet. Retry above.")).toBeNull()
    await userEvent.hover(screen.getByRole('button', { name: 'Update access' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      "Who has access hasn't loaded yet. Retry above.",
    )
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    await loaded()
    expect(api.branches.getAccess).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      'BRANCH_ACCESS_DENIED',
      'You no longer have access to this branch. Choose another branch in "Branches".',
    ],
    ['BRANCH_LOCKED_DOWN', 'An admin has limited this branch to admins and reviewers.'],
  ] as const)('turns a %s refusal on load into its sentence, with Close', async (code, message) => {
    const api = createMockApiClient()
    api.branches.getAccess.mockResolvedValue(refusal(403, code))
    const { onClose, onChanged } = setup({ client: api })

    const alert = await screen.findByTestId('share-refused')
    expect(alert.textContent).toBe(message)
    await waitFor(() => expect(document.activeElement).toBe(footerClose()))
    fireEvent.click(footerClose())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['✕', () => fireEvent.click(modalClose())],
    ['Esc', () => userEvent.keyboard('{Escape}')],
  ])('reads the branch list again when %s closes a refusal', async (_how, dismiss) => {
    const api = createMockApiClient()
    api.branches.getAccess.mockResolvedValue(refusal(403, 'BRANCH_ACCESS_DENIED'))
    const { onClose, onChanged } = setup({ client: api })
    await screen.findByTestId('share-refused')

    await dismiss()

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('turns a refusal mid-dialog into a yellow notice with Close', async () => {
    const { api } = setup()
    api.branches.updateAccess.mockResolvedValue(refusal(403, 'BRANCH_LOCKED_DOWN'))
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    expect((await screen.findByTestId('share-refused')).textContent).toBe(
      accessRefusalMessage('BRANCH_LOCKED_DOWN'),
    )
    await waitFor(() => expect(document.activeElement).toBe(footerClose()))
  })

  it.each([
    ['USER_EXCLUDED', 'Someone you added', 'them'],
    ['GROUP_EXCLUDED', 'A group you added', 'it'],
  ] as const)(
    'tells an owner refused %s that only an admin can allow it back',
    async (code, who, back) => {
      const { api } = setup()
      api.branches.updateAccess.mockResolvedValueOnce({ ...refusal(403, code), ids: ['x'] })
      await loaded()
      fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
      fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

      expect((await screen.findByTestId('share-save-problem')).textContent).toContain(
        `${who} was removed from this branch by an admin, and only an admin can allow ${back} back.`,
      )
    },
  )

  it('tells a member refused USER_EXCLUDED that its owner or an admin can allow them back', async () => {
    const { api } = setup({
      user: { userId: 'ben' },
      data: access({ rights: { isOwner: false, canAdd: true, canManage: false } }),
    })
    api.branches.updateAccess.mockResolvedValueOnce({
      ...refusal(403, 'USER_EXCLUDED'),
      ids: ['x'],
    })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    expect((await screen.findByTestId('share-save-problem')).textContent).toContain(
      accessRefusalMessage('USER_EXCLUDED'),
    )
  })

  it('names whom a refused change concerns, keeps the edits, and offers their Remove, not Retry', async () => {
    const { api } = setup()
    api.branches.findPeople.mockResolvedValue(
      ok({ people: [{ id: 'cole', name: 'Cole Ortiz' }], groups: [] }),
    )
    api.branches.updateAccess.mockResolvedValueOnce({
      ...refusal(403, 'USER_EXCLUDED'),
      ids: ['cole'],
    })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    await userEvent.type(picker(), 'Co')
    await userEvent.click(await screen.findByRole('option', { name: /Cole Ortiz/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(problem.textContent).toContain(accessRefusalMessage('USER_EXCLUDED', true))
    expect(problem.textContent).toContain('Applies to Cole Ortiz.')
    expect(within(problem).queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(within(row('Ben Ortiz')).getByText('Will be removed')).toBeTruthy()
    fireEvent.click(within(problem).getByRole('button', { name: 'Remove Cole Ortiz' }))

    expect(screen.queryByTestId('share-save-problem')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(2))
    expect(api.branches.updateAccess.mock.calls[1][1]).toEqual({ remove: { users: ['ben'] } })
  })

  it('leaves Discard changes to the footer, which closes, for a refusal no retry can pass', async () => {
    const { api, onClose } = setup()
    api.branches.updateAccess.mockResolvedValueOnce(refusal(400, 'ACCESS_CHANGE_INVALID'))
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(within(problem).queryByRole('button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.branches.updateAccess).toHaveBeenCalledTimes(1)
  })

  it('offers Retry after a failure that never reached the server, and sends the edits again', async () => {
    const { api } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.branches.updateAccess.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    fireEvent.click(within(problem).getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(2))
    expect(api.branches.updateAccess.mock.calls[1][1]).toEqual({ remove: { users: ['ben'] } })
  })

  it('offers Retry when the list changed while the update was saved', async () => {
    const { api } = setup()
    api.branches.updateAccess.mockResolvedValueOnce({
      ...refusal(409, 'LIST_CHANGED'),
      ids: ['ben'],
    })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(problem.textContent).toContain('The list changed while this was being saved.')
    expect(problem.outerHTML).toMatch(/yellow/)
    fireEvent.click(within(problem).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(2))
  })

  it('says a person staged for removal is already off the list, keeping the other edits', async () => {
    const { api } = setup()
    api.branches.updateAccess.mockResolvedValueOnce({
      ...refusal(403, 'USER_OUT_OF_SCOPE'),
      ids: ['ben'],
    })
    await loaded()
    api.branches.getAccess.mockResolvedValue(
      ok(access({ entries: access().entries.filter((e) => e.id !== 'ben') })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(problem.textContent).toContain('Ben Ortiz is no longer on the list.')
    expect(problem.outerHTML).toMatch(/yellow/)
    expect(within(problem).queryByRole('button')).toBeNull()
    await waitFor(() => expect(screen.queryByText('Ben Ortiz')).toBeNull())
    expect(within(row('Marketing team')).getByText('Will be removed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(2))
    expect(api.branches.updateAccess.mock.calls[1][1]).toEqual({ remove: { groups: ['team'] } })
  })

  it('drops only the removals the fresh list no longer holds, naming them from it', async () => {
    const cole = { kind: 'user' as const, id: 'cole', name: 'Cole Ortiz' }
    const { api } = setup({ data: access({ entries: [...access().entries, cole] }) })
    api.branches.updateAccess.mockResolvedValueOnce({
      ...refusal(403, 'USER_OUT_OF_SCOPE'),
      ids: ['ben', 'cole'],
    })
    await loaded()
    api.branches.getAccess.mockResolvedValue(
      ok(access({ entries: [...access().entries.filter((e) => e.id !== 'ben'), cole] })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cole Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(problem.textContent).toContain('Ben Ortiz is no longer on the list.')
    expect(problem.textContent).not.toContain('Cole')
    expect(within(row('Cole Ortiz')).getByText('Will be removed')).toBeTruthy()
  })

  it('shows a refusal that names one change as a problem with that change, not a lockout', async () => {
    const { api } = setup()
    api.branches.updateAccess.mockResolvedValueOnce({
      ...refusal(403, 'ACCESS_MANAGE_FORBIDDEN'),
      ids: ['ben'],
    })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(problem.textContent).toContain('Applies to Ben Ortiz.')
    expect(screen.queryByTestId('share-refused')).toBeNull()
  })

  it('holds every editing control while the update is on its way', async () => {
    const { api } = setup()
    const answer = deferred<ReturnType<typeof ok<{ branch: never }>>>()
    api.branches.updateAccess.mockReturnValue(answer.promise as never)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(picker().matches(':disabled')).toBe(true))
    expect(screen.getByRole('button', { name: 'Remove Marketing team' }).matches(':disabled')).toBe(
      true,
    )
    expect(
      screen.getByRole('button', { name: 'Undo removing Ben Ortiz' }).matches(':disabled'),
    ).toBe(true)
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
    expect(within(problem).queryByRole('button')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("warns that the list may be out of date when it can't be read after a timeout", async () => {
    const { api } = setup()
    api.branches.updateAccess.mockRejectedValue(new ApiTimeoutError('PATCH', '/x', 1000))
    await loaded()
    api.branches.getAccess.mockResolvedValue({ ok: false, status: 500, error: 'Boom' })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    const problem = await screen.findByTestId('share-save-problem')
    expect(problem.textContent).toContain(
      'Updating access may have gone through even though the server didn\'t answer, and the list couldn\'t be read again, so it may be out of date. Close this and open "Share…" again to check.',
    )
    expect(problem.textContent).not.toContain('The list shows what the server has now')
  })

  it('drops an address row once the read after a timeout shows that address added', async () => {
    const { api, onClose } = setup()
    api.branches.findPeople.mockResolvedValue({ ok: false, status: 500, error: 'Boom' })
    api.branches.updateAccess.mockRejectedValue(new ApiTimeoutError('PATCH', '/x', 1000))
    await loaded()
    await userEvent.type(picker(), 'dana@example.org')
    await userEvent.click(await screen.findByRole('option', { name: 'Add dana@example.org' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))
    api.branches.getAccess.mockResolvedValue(
      ok(
        access({
          entries: [
            ...access().entries,
            {
              kind: 'user',
              id: 'dana',
              name: 'Dana Park',
              addedBy: { id: 'ana', name: 'Ana Lee' },
            },
          ],
        }),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))

    await screen.findByTestId('share-save-problem')
    expect(screen.getByText('Dana Park')).toBeTruthy()
    expect(screen.queryByText('dana@example.org')).toBeNull()
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
    const copyButton = screen.getByRole('button', { name: 'Link copied' })
    expect(copyButton.querySelector('.tabler-icon-check')).toBeTruthy()
    await waitFor(() => expect(copyButton.querySelector('.tabler-icon-check')).toBeNull(), {
      timeout: 8000,
    })
    expect(copyButton.textContent).toBe('Copy link')
  }, 15_000)

  it('shows the link to copy by hand when copying fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
      configurable: true,
    })
    setup()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    const failed = await screen.findByTestId('share-copy-failed')
    expect(failed.textContent).toContain("Couldn't copy the link.")
    const field = within(failed).getByRole('textbox', {
      name: 'Link to this branch',
    }) as HTMLInputElement
    expect(field.value).toMatch(/\?branch=spring$/)
    // Focused, with the address selected, ready to copy by hand.
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(field.selectionEnd! - field.selectionStart!).toBe(field.value.length)
  })
})

describe("ShareBranchDialog: a 'deny' site", () => {
  it('treats an unlisted branch as list-only: who can add shows, and Allow again adds back', async () => {
    const { api } = setup({
      data: access({
        entries: [],
        restricted: false,
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

    expect(await screen.findByRole('radiogroup', { name: 'Who can add people' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Removed (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow again: Pat Alvarez' }))
    expect(said('Pat Alvarez will be added back.')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
    await waitFor(() => expect(api.branches.updateAccess).toHaveBeenCalledTimes(1))
    expect(api.branches.updateAccess.mock.calls[0][1]).toEqual({ add: { users: ['pat'] } })
  })
})

describe('ShareBranchDialog: lockdown and owner', () => {
  it('says a locked branch keeps out the people listed, in place of the listed-only line', async () => {
    setup({
      user: { userId: 'root', groups: [RESERVED_GROUPS.ADMINS] },
      branch: { access: { managerOrAdminAllowed: true } },
    })
    await loaded()

    expect(screen.getByTestId('share-lockdown').textContent).toMatch(
      /locked to admins and reviewers/,
    )
    expect(screen.queryByText(LISTED_ONLY_LINE)).toBeNull()
  })

  const unlisted = access({ entries: [], restricted: false })

  it('shows the owner of an unlisted branch on a closed site', async () => {
    setup({ data: unlisted })

    expect(await screen.findByText('Ana Lee (you)')).toBeTruthy()
  })

  it.each([
    ['a system user', { branch: { createdBy: 'canopycms-system' } }],
    [
      'removed',
      {
        data: {
          ...unlisted,
          excluded: [
            {
              kind: 'user' as const,
              id: 'ana',
              name: 'Ana Lee',
              by: { id: 'root', name: 'Ada' },
              at: AT,
              byAdmin: true,
            },
          ],
        },
      },
    ],
  ])('shows no Owner row for a creator who is %s', async (_label, over) => {
    setup({ data: unlisted, ...over })

    expect(await screen.findByText('No one is listed yet.')).toBeTruthy()
  })
})

describe('ShareBranchDialog: dismissing with edits staged', () => {
  it.each([
    ['✕', () => fireEvent.click(modalClose())],
    ['Esc', () => userEvent.keyboard('{Escape}')],
  ])(
    '%s closes a refusal shown over staged edits, and reads the branch list again',
    async (_how, dismiss) => {
      const { api, onClose, onChanged } = setup()
      api.branches.updateAccess.mockResolvedValue(refusal(403, 'BRANCH_LOCKED_DOWN'))
      await loaded()
      fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
      fireEvent.click(screen.getByRole('button', { name: 'Update access' }))
      await screen.findByTestId('share-refused')

      await dismiss()

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      expect(onChanged).toHaveBeenCalledTimes(1)
    },
  )

  it('asks again only when asked, once the edits it asked about are gone', async () => {
    setup()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    await userEvent.keyboard('{Escape}')
    await screen.findByTestId('share-discard-confirm')

    fireEvent.click(screen.getByRole('button', { name: 'Undo removing Ben Ortiz' }))
    expect(screen.queryByTestId('share-discard-confirm')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing team' }))

    expect(screen.queryByTestId('share-discard-confirm')).toBeNull()
  })

  it.each([
    ['Esc', () => userEvent.keyboard('{Escape}')],
    ['✕', () => fireEvent.click(modalClose())],
  ])('%s asks before discarding, and Keep editing keeps the edits', async (_how, dismiss) => {
    const { onClose } = setup()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))

    await dismiss()

    const confirm = await screen.findByTestId('share-discard-confirm')
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(confirm).getByRole('button', { name: 'Keep editing' }),
      ),
    )
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByTestId('share-discard-confirm')).toBeNull()
    expect(within(row('Ben Ortiz')).getByText('Will be removed')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("closes on the confirm's Discard changes", async () => {
    const { onClose } = setup()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ben Ortiz' }))
    await userEvent.keyboard('{Escape}')

    const confirm = await screen.findByTestId('share-discard-confirm')
    // The question's own Discard changes is the only one while it asks.
    expect(screen.getAllByRole('button', { name: 'Discard changes' })).toEqual([
      within(confirm).getByRole('button', { name: 'Discard changes' }),
    ])
    fireEvent.click(within(confirm).getByRole('button', { name: 'Discard changes' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Esc at once when nothing is staged', async () => {
    const { onClose } = setup()
    await loaded()

    await userEvent.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ShareBranchDialog: focus', () => {
  it('takes focus from a keyboard opener into the dialog, then to the input once the list loads', async () => {
    const api = createMockApiClient()
    const answer = deferred<ReturnType<typeof ok<BranchAccess>>>()
    api.branches.getAccess.mockReturnValue(answer.promise)
    function Harness() {
      const [opened, setOpened] = useState(false)
      return (
        <>
          <button onClick={() => setOpened(true)}>Opener</button>
          <ShareBranchDialog
            opened={opened}
            onClose={() => setOpened(false)}
            onChanged={() => {}}
            branch={{ name: 'spring', createdBy: 'ana', sharing: OWNER_SHARING }}
            urlName="spring"
            user={OWNER}
            getUserMetadata={lookup}
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
    screen.getByRole('button', { name: 'Opener' }).focus()
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('People with access')))
    answer.resolve(ok(access()))
    await waitFor(() => expect(document.activeElement).toBe(picker()))
  })

  it('pulls focus left behind the dialog into its input once the list loads', async () => {
    const api = createMockApiClient()
    const answer = deferred<ReturnType<typeof ok<BranchAccess>>>()
    api.branches.getAccess.mockReturnValue(answer.promise)
    render(
      <CanopyCMSProvider>
        <button>Behind</button>
        <ApiClientProvider client={api as unknown as ApiClient}>
          <ShareBranchDialog
            opened
            onClose={() => {}}
            onChanged={() => {}}
            branch={{ name: 'spring', createdBy: 'ana', sharing: OWNER_SHARING }}
            urlName="spring"
            user={OWNER}
            getUserMetadata={lookup}
          />
        </ApiClientProvider>
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('People with access')))
    screen.getByText('Behind').focus()

    answer.resolve(ok(access()))

    await waitFor(() => expect(document.activeElement).toBe(picker()))
  })

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
