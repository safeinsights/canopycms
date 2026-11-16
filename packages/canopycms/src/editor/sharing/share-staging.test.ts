import { describe, expect, it } from 'vitest'

import {
  accessChangeBody,
  changeLanded,
  editorsLosingAccess,
  joinNames,
  narrows,
  NOTHING_STAGED,
  withAddition,
  type BranchAccess,
} from './share-staging'

const current = (over: Partial<BranchAccess> = {}): BranchAccess => ({
  entries: [
    { kind: 'user', id: 'ana', name: 'Ana' },
    { kind: 'group', id: 'team', name: 'Team' },
  ],
  excluded: [
    {
      kind: 'user',
      id: 'pat',
      name: 'Pat',
      by: { id: 'ana', name: 'Ana' },
      at: '',
      byAdmin: false,
    },
  ],
  restricted: true,
  openToEveryone: false,
  defaultAccess: 'allow',
  addBy: 'members',
  rights: { isOwner: true, canAdd: true, canManage: true },
  searchable: 'cms-users',
  addableByEmail: 'all-users',
  ...over,
})

describe('accessChangeBody', () => {
  it('is empty with nothing staged, or a setting put back to what it was', () => {
    expect(accessChangeBody(NOTHING_STAGED, current())).toEqual({})
    expect(accessChangeBody({ ...NOTHING_STAGED, addBy: 'members' }, current())).toEqual({})
    expect(accessChangeBody({ ...NOTHING_STAGED, restricted: true }, current())).toEqual({})
  })

  it('puts ids, groups and unlooked-up addresses each where the server reads them', () => {
    const body = accessChangeBody(
      {
        add: [
          { kind: 'user', id: 'cole', name: 'Cole' },
          { kind: 'user', email: 'dana@example.org', name: 'dana@example.org' },
          { kind: 'group', id: 'design', name: 'Design' },
        ],
        remove: [{ kind: 'group', id: 'team' }],
        unexclude: [{ kind: 'user', id: 'pat' }],
        addBy: 'owner',
      },
      current(),
    )

    expect(body).toEqual({
      add: { users: ['cole'], groups: ['design'], emails: ['dana@example.org'] },
      remove: { groups: ['team'] },
      unexclude: { users: ['pat'] },
      addBy: 'owner',
    })
  })

  it('opens a branch with nothing else, and restricts an open one', () => {
    expect(
      accessChangeBody(
        { ...NOTHING_STAGED, add: [{ kind: 'user', id: 'x', name: 'X' }], restricted: false },
        current(),
      ),
    ).toEqual({ restricted: false })
    expect(
      accessChangeBody(
        { ...NOTHING_STAGED, restricted: true },
        current({ restricted: false, openToEveryone: true }),
      ),
    ).toEqual({ restricted: true })
  })
})

describe('changeLanded', () => {
  it('reads a change as landed only when the list shows every part of it', () => {
    const landed = current({
      entries: [{ kind: 'user', id: 'cole', name: 'Cole' }],
      excluded: [],
      addBy: 'owner',
    })
    const body = {
      add: { users: ['cole'] },
      remove: { users: ['ana'], groups: ['team'] },
      unexclude: { users: ['pat'] },
      addBy: 'owner' as const,
    }

    expect(changeLanded(body, landed)).toBe(true)
    expect(changeLanded(body, current())).toBe(false)
    expect(changeLanded({ add: { emails: ['x@example.org'] } }, landed)).toBe(false)
    expect(changeLanded({ restricted: false }, current())).toBe(false)
    expect(changeLanded({ remove: { users: ['ana'] } }, current())).toBe(false)
    expect(changeLanded({ unexclude: { users: ['pat'] } }, current())).toBe(false)
  })
})

describe('narrowing an open branch', () => {
  const open = current({ entries: [], restricted: false, openToEveryone: true })

  it('narrows on the first add or a switch to the list, never when opening', () => {
    expect(narrows(NOTHING_STAGED, open)).toBe(false)
    expect(narrows({ ...NOTHING_STAGED, add: [{ kind: 'user', id: 'x', name: 'X' }] }, open)).toBe(
      true,
    )
    expect(narrows({ ...NOTHING_STAGED, restricted: true }, open)).toBe(true)
    expect(narrows({ ...NOTHING_STAGED, restricted: true }, current())).toBe(false)
    expect(
      narrows(
        { ...NOTHING_STAGED, add: [{ kind: 'user', id: 'x', name: 'X' }], restricted: false },
        open,
      ),
    ).toBe(false)
  })

  it('leaves out removed people, system ids and the no-creator placeholder', () => {
    expect(
      editorsLosingAccess(
        ['pat', 'canopycms-system', 'unknown', 'dana'],
        'owner',
        NOTHING_STAGED,
        current({ entries: [] }),
      ),
    ).toEqual(['dana'])
  })

  it('stages an addition once, and never one already listed', () => {
    const cole = { kind: 'user' as const, id: 'cole', name: 'Cole' }
    expect(withAddition([cole], cole)).toEqual([cole])
    expect(withAddition([], cole, new Set(['user:cole']))).toEqual([])
    expect(withAddition([], cole)).toEqual([cole])
  })

  it('names editors not listed, not staged and not the owner', () => {
    expect(
      editorsLosingAccess(
        ['owner', 'ana', 'dana', 'cole', 'dana'],
        'owner',
        { ...NOTHING_STAGED, add: [{ kind: 'user', id: 'cole', name: 'Cole' }] },
        current(),
      ),
    ).toEqual(['dana'])
  })
})

describe('joinNames', () => {
  it('joins with commas and a final "and"', () => {
    expect(joinNames(['Ana'])).toBe('Ana')
    expect(joinNames(['Ana', 'Ben'])).toBe('Ana and Ben')
    expect(joinNames(['Ana', 'Ben', 'Chen'])).toBe('Ana, Ben and Chen')
  })
})
