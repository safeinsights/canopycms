import { describe, expect, it } from 'vitest'

import { accessPeople, shareControlName, type SharedSummary } from './BranchShareControl'

const rights = { isOwner: true, canAdd: true, canManage: true, addBy: 'members' as const }
const listed = (users: string[], groups: string[] = []): SharedSummary => ({
  createdBy: 'ana',
  access: { users, groups },
  sharing: { ...rights, restricted: true, openToEveryone: false },
})

describe('accessPeople', () => {
  it('is the list, or the owner alone while nothing is listed and the branch is not open', () => {
    expect(accessPeople(listed(['ana', 'ben'], ['design']))).toEqual({
      users: ['ana', 'ben'],
      groups: ['design'],
    })
    expect(
      accessPeople({
        ...listed([]),
        sharing: { ...rights, restricted: false, openToEveryone: false },
      }),
    ).toEqual({ users: ['ana'], groups: [] })
    expect(
      accessPeople({
        ...listed([]),
        sharing: { ...rights, restricted: false, openToEveryone: true },
      }),
    ).toEqual({ users: [], groups: [] })
  })
})

describe('shareControlName', () => {
  it('counts who has access for someone who may share, agreeing in number', () => {
    expect(shareControlName('share', listed(['ana']), [])).toBe('Share…, 1 person has access')
    expect(shareControlName('share', listed(['ana', 'ben']), [])).toBe(
      'Share…, 2 people have access',
    )
    expect(shareControlName('share', listed([], ['design']), [])).toBe('Share…, 1 group has access')
  })

  it('names up to two for someone who may only look, counting the rest', () => {
    expect(shareControlName('view', listed(['ana', 'ben']), ['Ana Lee', 'Ben Ortiz'])).toBe(
      'Who has access: Ana Lee and Ben Ortiz',
    )
    expect(shareControlName('view', listed(['ana', 'ben', 'cole']), ['Ana Lee'])).toBe(
      'Who has access: Ana Lee and 2 others',
    )
    expect(shareControlName('view', listed(['ana', 'ben'], ['design']), [])).toBe(
      'Who has access: 2 people and 1 group',
    )
  })

  it('says a branch open to everyone is open to everyone', () => {
    const open: SharedSummary = {
      ...listed([]),
      sharing: { ...rights, restricted: false, openToEveryone: true },
    }
    expect(shareControlName('share', open, [])).toBe('Share…, anyone who can sign in has access')
    expect(shareControlName('view', open, [])).toBe('Who has access: anyone who can sign in')
  })
})
