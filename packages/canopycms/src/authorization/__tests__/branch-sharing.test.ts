import { describe, expect, it } from 'vitest'

import {
  accessForViewer,
  applyAccessChange,
  branchSharingRights,
  collectCmsUserIds,
  type ApplyAccessChangeContext,
} from '../branch-sharing'
import { RESERVED_GROUPS } from '../helpers'
import { SYSTEM_USER_ID } from '../../system-users'
import type { BranchAccessControl, BranchMetadata } from '../../types'

const owner = { userId: 'owner', groups: ['writers'] }
const member = { userId: 'member', groups: [] }
const groupMember = { userId: 'gm', groups: ['team'] }
const stranger = { userId: 'stranger', groups: [] }
const admin = { userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] }
const reviewer = { userId: 'rev', groups: [RESERVED_GROUPS.REVIEWERS] }

const branch = (
  access: BranchAccessControl,
  extra: Partial<Pick<BranchMetadata, 'createdBy' | 'status'>> = {},
): Pick<BranchMetadata, 'access' | 'createdBy' | 'status'> => ({
  access,
  createdBy: 'owner',
  status: 'editing',
  ...extra,
})

const rights = (
  user: { userId: string; groups: string[] },
  b: ReturnType<typeof branch>,
  whoCanAdd: 'members' | 'owner' = 'members',
) => branchSharingRights(user, b, { isProtected: false, whoCanAdd })

const shared: BranchAccessControl = {
  restricted: true,
  allowedUsers: ['owner', 'member'],
  allowedGroups: ['team'],
  entryMeta: { 'user:member': { addedBy: 'owner', addedAt: 't0' } },
}

describe('branchSharingRights', () => {
  it('makes the creator of an unshared branch its owner, who may add and manage', () => {
    expect(rights(owner, branch({}))).toEqual({
      isOwner: true,
      isMember: false,
      canAdd: true,
      canRemoveOwn: true,
      canManage: true,
    })
  })

  it('lets a member listed by user or by group add, but not manage', () => {
    for (const user of [member, groupMember]) {
      expect(rights(user, branch(shared))).toMatchObject({
        isMember: true,
        canAdd: true,
        canManage: false,
      })
    }
  })

  it('counts a reviewer on the list as a member, and gives one off it nothing', () => {
    const listed = branch({ ...shared, allowedUsers: ['owner', 'rev'] })
    expect(rights(reviewer, listed)).toMatchObject({ isMember: true, canAdd: true })
    expect(rights(reviewer, branch(shared))).toMatchObject({ canAdd: false, canManage: false })
  })

  it('strips the owner of a creator the list leaves out or an exclusion names', () => {
    expect(rights(owner, branch({ restricted: true, allowedUsers: ['member'] })).isOwner).toBe(
      false,
    )
    const excluded = branch({
      ...shared,
      excluded: { owner: { by: 'admin', at: 't', byAdmin: true } },
    })
    expect(rights(owner, excluded)).toMatchObject({ isOwner: false, canManage: false })
  })

  it('keeps adding to the owner when the site or branch says so', () => {
    expect(rights(member, branch(shared), 'owner').canAdd).toBe(false)
    expect(rights(member, branch({ ...shared, addBy: 'owner' })).canAdd).toBe(false)
    expect(rights(owner, branch({ ...shared, addBy: 'owner' })).canAdd).toBe(true)
  })

  it('leaves the list to admins under addBy admins, the lockdown, a system owner or archiving', () => {
    const cases = [
      branch({ ...shared, addBy: 'admins' }),
      branch({ ...shared, managerOrAdminAllowed: true }),
      branch(shared, { status: 'archived' }),
      branch({}, { createdBy: SYSTEM_USER_ID }),
    ]
    for (const b of cases) {
      expect(rights(owner, b)).toMatchObject({ canAdd: false, canManage: false })
      expect(rights(admin, b)).toMatchObject({ canAdd: true, canManage: true })
    }
  })

  it('gives no one rights on the protected base branch', () => {
    expect(
      branchSharingRights(admin, branch({}), { isProtected: true, whoCanAdd: 'members' }),
    ).toMatchObject({ canAdd: false, canManage: false })
  })
})

const ctxFor = (
  actor: { userId: string; groups: string[] },
  b: ReturnType<typeof branch>,
  extra: Partial<ApplyAccessChangeContext> = {},
): ApplyAccessChangeContext => ({
  actor,
  rights: rights(actor, b),
  creator: b.createdBy,
  defaultAccess: 'deny',
  now: 't1',
  ...extra,
})

const apply = (
  actor: { userId: string; groups: string[] },
  access: BranchAccessControl,
  change: Parameters<typeof applyAccessChange>[1],
  extra: Partial<ApplyAccessChangeContext> = {},
) => applyAccessChange(access, change, ctxFor(actor, branch(access), extra))

const accessOf = (result: ReturnType<typeof apply>): BranchAccessControl => {
  if ('refusal' in result) throw new Error(`refused: ${result.refusal.code}`)
  return result.access
}
const codeOf = (result: ReturnType<typeof apply>): string | undefined =>
  'refusal' in result ? result.refusal.code : undefined

describe('applyAccessChange', () => {
  it("restricts the branch on its owner's first share and keeps the owner on it", () => {
    const access = accessOf(apply(owner, {}, { add: { users: ['member'] } }))
    expect(access.restricted).toBe(true)
    expect(access.allowedUsers).toEqual(['owner', 'member'])
    expect(access.entryMeta?.['user:member']).toEqual({ addedBy: 'owner', addedAt: 't1' })
  })

  it('keeps the branch restricted once everyone is removed, so it never reopens', () => {
    const access = accessOf(
      apply(admin, shared, { remove: { users: ['owner', 'member'], groups: ['team'] } }),
    )
    expect(access.restricted).toBe(true)
    expect(access.allowedUsers).toBeUndefined()
    expect(access.allowedGroups).toBeUndefined()
  })

  it('does not put an owner an admin removed back when a member adds someone', () => {
    const removed = accessOf(apply(admin, shared, { remove: { users: ['owner'] } }))
    expect(removed.excluded?.owner).toEqual({ by: 'admin', at: 't1', byAdmin: true })
    const added = accessOf(apply(member, removed, { add: { users: ['newcomer'] } }))
    expect(added.allowedUsers).toEqual(['member', 'newcomer'])
  })

  it('refuses a member adding back someone the owner or an admin removed', () => {
    const removed = accessOf(apply(owner, shared, { remove: { users: ['member'] } }))
    const viaMember = { ...removed, allowedUsers: [...(removed.allowedUsers ?? []), 'other'] }
    expect(
      codeOf(apply({ userId: 'other', groups: [] }, viaMember, { add: { users: ['member'] } })),
    ).toBe('USER_EXCLUDED')
  })

  it('lets the owner allow back someone they removed, but not someone an admin removed', () => {
    const byOwner = accessOf(apply(owner, shared, { remove: { users: ['member'] } }))
    const back = accessOf(apply(owner, byOwner, { add: { users: ['member'] } }))
    expect(back.excluded).toBeUndefined()
    expect(back.allowedUsers).toContain('member')

    const byAdmin = accessOf(apply(admin, shared, { remove: { users: ['member'] } }))
    expect(codeOf(apply(owner, byAdmin, { add: { users: ['member'] } }))).toBe('USER_EXCLUDED')
    expect(codeOf(apply(owner, byAdmin, { unexclude: { users: ['member'] } }))).toBe(
      'ACCESS_MANAGE_FORBIDDEN',
    )
    expect(
      accessOf(apply(admin, byAdmin, { unexclude: { users: ['member'] } })).excluded,
    ).toBeUndefined()
  })

  it('lets a member remove only what they added, leaving no exclusion behind', () => {
    const withAdd = accessOf(apply(member, shared, { add: { users: ['pal'] } }))
    const undone = accessOf(apply(member, withAdd, { remove: { users: ['pal'] } }))
    expect(undone.allowedUsers).toEqual(['owner', 'member'])
    expect(undone.excluded).toBeUndefined()
    expect(codeOf(apply(member, withAdd, { remove: { groups: ['team'] } }))).toBe(
      'ACCESS_MANAGE_FORBIDDEN',
    )
  })

  it("refuses removing a branch's owner unless an admin does it", () => {
    expect(codeOf(apply(owner, shared, { remove: { users: ['owner'] } }))).toBe(
      'ACCESS_MANAGE_FORBIDDEN',
    )
  })

  it('lets a non-admin add only non-reserved groups they belong to', () => {
    expect(codeOf(apply(owner, shared, { add: { groups: ['strangers'] } }))).toBe('GROUP_NOT_YOURS')
    expect(codeOf(apply(owner, shared, { add: { groups: [RESERVED_GROUPS.REVIEWERS] } }))).toBe(
      'RESERVED_GROUP',
    )
    expect(accessOf(apply(owner, shared, { add: { groups: ['writers'] } })).allowedGroups).toEqual([
      'team',
      'writers',
    ])
    expect(
      accessOf(apply(admin, shared, { add: { groups: ['strangers'] } })).allowedGroups,
    ).toContain('strangers')
  })

  it('refuses adding without the right to, and managing as a member', () => {
    expect(codeOf(apply(stranger, shared, { add: { users: ['x'] } }))).toBe('ACCESS_ADD_FORBIDDEN')
    expect(codeOf(apply(member, shared, { addBy: 'owner' }))).toBe('ACCESS_MANAGE_FORBIDDEN')
    expect(codeOf(apply(owner, shared, { addBy: 'admins' }))).toBe('ACCESS_MANAGE_FORBIDDEN')
    expect(accessOf(apply(admin, shared, { addBy: 'admins' })).addBy).toBe('admins')
  })

  it('refuses one entry both removed and allowed back', () => {
    expect(
      codeOf(
        apply(owner, shared, { remove: { groups: ['team'] }, unexclude: { groups: ['team'] } }),
      ),
    ).toBe('ACCESS_CHANGE_INVALID')
    expect(
      codeOf(
        apply(owner, shared, { remove: { users: ['member'] }, unexclude: { users: ['member'] } }),
      ),
    ).toBe('ACCESS_CHANGE_INVALID')
  })

  it('refuses one entry both added and removed', () => {
    expect(codeOf(apply(owner, shared, { add: { users: ['x'] }, remove: { users: ['x'] } }))).toBe(
      'ACCESS_CHANGE_INVALID',
    )
  })

  it("opens a branch only on an 'allow' site, never with an add, and clears the list", () => {
    expect(codeOf(apply(owner, shared, { restricted: false }))).toBe('OPEN_NOT_ALLOWED')
    expect(
      codeOf(
        apply(
          owner,
          shared,
          { restricted: false, add: { users: ['x'] } },
          { defaultAccess: 'allow' },
        ),
      ),
    ).toBe('ACCESS_CHANGE_INVALID')
    const opened = accessOf(apply(owner, shared, { restricted: false }, { defaultAccess: 'allow' }))
    expect(opened.allowedUsers).toBeUndefined()
    expect(opened.allowedGroups).toBeUndefined()
    expect(opened.entryMeta).toBeUndefined()
    expect(opened.restricted).toBeUndefined()
  })

  it('restricts an unshared branch to its owner on request', () => {
    const access = accessOf(apply(owner, {}, { restricted: true }))
    expect(access).toMatchObject({ restricted: true, allowedUsers: ['owner'] })
  })

  it('reports a change already in effect as unchanged, keeping who first added each entry', () => {
    const first = apply(member, shared, { add: { users: ['pal'] } })
    const again = applyAccessChange(
      accessOf(first),
      { add: { users: ['pal'] } },
      {
        ...ctxFor(owner, branch(accessOf(first))),
        now: 't2',
      },
    )
    expect('refusal' in again).toBe(false)
    if ('refusal' in again) return
    expect(again.changed).toBe(false)
    expect(again.access.entryMeta?.['user:pal']).toEqual({ addedBy: 'member', addedAt: 't1' })
  })

  it('never inserts a system creator', () => {
    const access = accessOf(
      applyAccessChange(
        {},
        { add: { users: ['x'] } },
        ctxFor(admin, branch({}, { createdBy: SYSTEM_USER_ID })),
      ),
    )
    expect(access.allowedUsers).toEqual(['x'])
  })
})

describe('applyAccessChange: exclusions and opening', () => {
  it('excludes someone who reaches the branch through a group, so the group no longer admits them', () => {
    const access = accessOf(apply(owner, shared, { remove: { users: ['gm'] } }))
    expect(access.excluded?.gm).toMatchObject({ by: 'owner' })
    expect(rights(groupMember, branch(access))).toMatchObject({ isMember: false, canAdd: false })
  })

  it('keeps a member from adding back a group an owner removed, but lets the owner', () => {
    const removed = accessOf(apply(owner, shared, { remove: { groups: ['team'] } }))
    expect(removed.excludedGroups?.team).toMatchObject({ by: 'owner', byAdmin: false })
    const viaMember = { ...removed, allowedUsers: ['owner', 'gm'] }
    expect(codeOf(apply(groupMember, viaMember, { add: { groups: ['team'] } }))).toBe(
      'GROUP_EXCLUDED',
    )
    const back = apply(owner, removed, { add: { groups: ['writers'] } })
    expect('refusal' in back).toBe(false)
  })

  it('lets the owner lift a group exclusion they made, and only an admin one an admin made', () => {
    const byOwner = accessOf(apply(owner, shared, { remove: { groups: ['team'] } }))
    expect(
      accessOf(apply(owner, byOwner, { unexclude: { groups: ['team'] } })).excludedGroups,
    ).toBeUndefined()
    const byAdmin = accessOf(apply(admin, shared, { remove: { groups: ['team'] } }))
    expect(codeOf(apply(owner, byAdmin, { unexclude: { groups: ['team'] } }))).toBe(
      'ACCESS_MANAGE_FORBIDDEN',
    )
    expect(
      accessOf(apply(admin, byAdmin, { unexclude: { groups: ['team'] } })).excludedGroups,
    ).toBeUndefined()
  })

  it('refuses only a change that would take a branch past the cap, never one that lifts', () => {
    const atCap = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `gone-${i}`,
        { by: 'owner', at: 't', byAdmin: false },
      ]),
    )
    const full = { ...shared, excluded: atCap }
    expect(
      codeOf(
        apply(owner, full, { unexclude: { users: ['gone-0'] }, remove: { users: ['member'] } }),
      ),
    ).toBeUndefined()
    const over = {
      ...shared,
      excluded: { ...atCap, extra: { by: 'owner', at: 't', byAdmin: false } },
    }
    expect(codeOf(apply(owner, over, { unexclude: { users: ['gone-0'] } }))).toBeUndefined()
    expect(codeOf(apply(owner, over, { add: { users: ['pal'] } }))).toBeUndefined()
  })

  it('caps how many exclusions one branch holds', () => {
    const many = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `gone-${i}`,
        { by: 'owner', at: 't', byAdmin: false },
      ]),
    )
    expect(
      codeOf(apply(owner, { ...shared, excluded: many }, { remove: { users: ['member'] } })),
    ).toBe('EXCLUSION_CAP')
  })

  it('refuses opening a branch together with any other change', () => {
    for (const change of [
      { restricted: false, addBy: 'owner' as const },
      { restricted: false, unexclude: { users: ['x'] } },
      { restricted: false, remove: { users: ['member'] } },
    ]) {
      expect(codeOf(apply(owner, shared, change, { defaultAccess: 'allow' }))).toBe(
        'ACCESS_CHANGE_INVALID',
      )
    }
  })

  it('keeps a legacy list with no restricted flag restricted once emptied', () => {
    const legacy: BranchAccessControl = { allowedUsers: ['owner', 'member'] }
    const access = accessOf(apply(admin, legacy, { remove: { users: ['owner', 'member'] } }))
    expect(access.restricted).toBe(true)
    expect(access.allowedUsers).toBeUndefined()
  })

  it('lets a member take back their own additions once only the owner may add', () => {
    const withAdd = accessOf(apply(member, shared, { add: { users: ['pal'] } }))
    const ownerOnly = { ...withAdd, addBy: 'owner' as const }
    const undone = accessOf(apply(member, ownerOnly, { remove: { users: ['pal'] } }))
    expect(undone.allowedUsers).toEqual(['owner', 'member'])
    expect(undone.excluded).toBeUndefined()
    expect(codeOf(apply(member, ownerOnly, { add: { users: ['other'] } }))).toBe(
      'ACCESS_ADD_FORBIDDEN',
    )
    expect(codeOf(apply(member, ownerOnly, { remove: { groups: ['team'] } }))).toBe(
      'ACCESS_MANAGE_FORBIDDEN',
    )
  })

  it('refuses a member their own additions on a locked-down or archived branch', () => {
    const withAdd = accessOf(apply(member, shared, { add: { users: ['pal'] } }))
    const locked = { ...withAdd, managerOrAdminAllowed: true }
    expect(codeOf(apply(member, locked, { remove: { users: ['pal'] } }))).toBe(
      'ACCESS_MANAGE_FORBIDDEN',
    )
    const archived = applyAccessChange(
      withAdd,
      { remove: { users: ['pal'] } },
      {
        actor: member,
        rights: rights(member, branch(withAdd, { status: 'archived' })),
        creator: 'owner',
        defaultAccess: 'deny',
        now: 't1',
      },
    )
    expect(codeOf(archived)).toBe('ACCESS_MANAGE_FORBIDDEN')
  })

  it("makes an owner's exclusion an admin's when an admin removes the person too", () => {
    const byOwner = accessOf(apply(owner, shared, { remove: { users: ['member'] } }))
    const result = apply(admin, byOwner, { remove: { users: ['member'] } })
    if ('refusal' in result) throw new Error(`refused: ${result.refusal.code}`)
    expect(result.changed).toBe(true)
    expect(result.excluded).toEqual(['member'])
    expect(result.access.excluded?.member).toEqual({ by: 'admin', at: 't1', byAdmin: true })
    expect(codeOf(apply(owner, result.access, { add: { users: ['member'] } }))).toBe(
      'USER_EXCLUDED',
    )
    const again = apply(admin, result.access, { remove: { users: ['member'] } })
    if ('refusal' in again) throw new Error(`refused: ${again.refusal.code}`)
    expect(again.changed).toBe(false)
  })

  it("refuses a member removing their own additions once the list is the admins'", () => {
    const withAdd = accessOf(apply(member, shared, { add: { users: ['pal'] } }))
    const adminsOnly = { ...withAdd, addBy: 'admins' as const }
    expect(codeOf(apply(member, adminsOnly, { remove: { users: ['pal'] } }))).toBe(
      'ACCESS_MANAGE_FORBIDDEN',
    )
  })

  it("treats a member's retried removal as already done", () => {
    const withAdd = accessOf(apply(member, shared, { add: { users: ['pal'] } }))
    const undone = accessOf(apply(member, withAdd, { remove: { users: ['pal'] } }))
    const again = apply(member, undone, { remove: { users: ['pal'] } })
    expect('refusal' in again).toBe(false)
    if (!('refusal' in again)) expect(again.changed).toBe(false)
  })

  it('reads no inherited property as an exclusion', () => {
    const result = apply(owner, shared, { add: { users: ['constructor', 'toString'] } })
    if ('refusal' in result) throw new Error(`refused: ${result.refusal.code}`)
    expect(result.access.allowedUsers).toEqual(['owner', 'member', 'constructor', 'toString'])
    expect(result.access.excluded).toBeUndefined()
    expect(result.unexcluded).toEqual([])
    const withExclusion = { ...shared, excluded: { x: { by: 'owner', at: 't', byAdmin: false } } }
    expect(
      codeOf(apply(member, withExclusion, { add: { users: ['constructor'] } })),
    ).toBeUndefined()
  })

  it('reports only what moved: lifted and recorded exclusions, and a new addBy', () => {
    const removed = apply(owner, shared, { remove: { users: ['member'] } })
    if ('refusal' in removed) throw new Error('refused')
    expect(removed.excluded).toEqual(['member'])
    const back = apply(owner, removed.access, {
      unexclude: { users: ['member', 'nobody'] },
      addBy: 'owner',
    })
    if ('refusal' in back) throw new Error('refused')
    expect(back.unexcluded).toEqual(['member'])
    expect(back.addBy).toBe('owner')
    const same = apply(owner, back.access, { addBy: 'owner' })
    if ('refusal' in same) throw new Error('refused')
    expect(same.changed).toBe(false)
    expect(same.addBy).toBeUndefined()
  })
})

describe('collectCmsUserIds', () => {
  it('takes path-permission users, internal group members, creators and editors, not list members', () => {
    const ids = collectCmsUserIds({
      pathPermissions: [
        {
          path: 'content/**' as never,
          read: { allowedUsers: ['reader'] },
          edit: { allowedUsers: ['writer'] },
          review: { allowedUsers: ['checker'] },
        },
      ],
      internalGroups: [{ members: ['grouped'] }],
      branches: [
        { createdBy: 'creator', editors: ['saver'] },
        { createdBy: SYSTEM_USER_ID },
        { createdBy: 'unknown' },
      ],
    })
    expect([...ids].sort()).toEqual(['checker', 'creator', 'grouped', 'reader', 'saver', 'writer'])
  })
})

describe('accessForViewer', () => {
  const full: BranchAccessControl = {
    ...shared,
    excluded: { gone: { by: 'owner', at: 't', byAdmin: false } },
    entryMeta: {
      'user:member': { addedBy: 'owner', addedAt: 't0' },
      'user:pal': { addedBy: 'member', addedAt: 't1' },
    },
  }

  it('shows owners and admins everything, members only their own additions', () => {
    expect(accessForViewer(full, owner, rights(owner, branch(full)), false)).toEqual(full)
    expect(accessForViewer(full, admin, rights(admin, branch(full)), true)).toEqual(full)
    const seen = accessForViewer(full, member, rights(member, branch(full)), false)
    expect(seen.excluded).toBeUndefined()
    expect(seen.entryMeta).toEqual({ 'user:pal': { addedBy: 'member', addedAt: 't1' } })
    expect(seen.allowedUsers).toEqual(full.allowedUsers)
  })

  it('passes on no field it does not know', () => {
    const extra = { ...full, futureField: 'x' } as BranchAccessControl
    expect(accessForViewer(extra, member, rights(member, branch(extra)), false)).not.toHaveProperty(
      'futureField',
    )
  })
})
