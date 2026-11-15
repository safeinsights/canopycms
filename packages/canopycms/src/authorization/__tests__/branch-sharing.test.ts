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
    expect(codeOf(apply(owner, byAdmin, { unexclude: ['member'] }))).toBe('ACCESS_MANAGE_FORBIDDEN')
    expect(accessOf(apply(admin, byAdmin, { unexclude: ['member'] })).excluded).toBeUndefined()
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
