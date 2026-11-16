import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthPlugin } from '../auth/plugin'
import { RESERVED_GROUPS } from '../authorization'
import { createCheckBranchAccess } from '../authorization/branch'
import { buildInitialBranchMetadata, BranchMetadataFileManager } from '../branch-metadata'
import { BRANCH_META_DIR, BRANCH_META_FILE } from '../branch-metadata-file'
import type { CanopyConfig } from '../config'
import { sanitizeBranchName } from '../paths/branch-name'
import type { BranchName } from '../paths/types'
import { SYSTEM_USER_ID } from '../system-users'
import type { BranchContext, BranchMetadata } from '../types'
import type { CanopyUser } from '../user'
import { changeBranchAccess, initialBranchAccess } from './branch-access'
import { setBranchAccessLogSink } from '../utils/access-log'
import { updateBranchAccessHandler, type UpdateBranchAccessBody } from './branch'
import type { ApiContext } from './types'

const user = (userId: string, groups: string[] = []): CanopyUser => ({
  type: 'authenticated',
  userId,
  groups,
})
const owner = user('owner', ['writers'])
const member = user('member')
const admin = user('admin', [RESERVED_GROUPS.ADMINS])

let baseRoot: string
let contexts: BranchContext[]
let config: CanopyConfig
let knownUsers: Set<string>
let auditLines: string[]

const addBranch = async (name: string, fields: Partial<BranchMetadata> = {}) => {
  const branchRoot = path.join(baseRoot, sanitizeBranchName(name))
  const file = buildInitialBranchMetadata({ branch: { name, createdBy: 'owner', ...fields } })
  await fs.mkdir(path.join(branchRoot, BRANCH_META_DIR), { recursive: true })
  await fs.writeFile(path.join(branchRoot, BRANCH_META_DIR, BRANCH_META_FILE), JSON.stringify(file))
  const context: BranchContext = { baseRoot, branchRoot, branch: file.branch }
  contexts.push(context)
  return context
}

const onDisk = async (context: BranchContext) =>
  (await BranchMetadataFileManager.loadOnly(context.branchRoot))?.branch

const authPlugin: AuthPlugin = {
  authenticate: async () => ({ success: false }),
  searchUsers: async () => [],
  getUserMetadata: async (id) =>
    knownUsers.has(id) ? { id, name: `Name of ${id}`, email: `${id}@example.test` } : null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
}

const ctx = (): ApiContext =>
  ({
    services: {
      config,
      checkBranchAccess: (context: BranchContext, u: CanopyUser) =>
        createCheckBranchAccess(config.defaultBranchAccess ?? 'deny', config)(context, u),
      getSettingsBranchRoot: async () => path.join(baseRoot, '.settings'),
      bootstrapAdminIds: new Set<string>(),
      registry: { list: async () => contexts },
    },
    authPlugin,
    getBranchContext: async (name: string) => {
      const known = contexts.find((c) => c.branch.name === name)
      if (!known) return null
      return { ...known, branch: (await onDisk(known)) ?? known.branch }
    },
  }) as unknown as ApiContext

const patch = (actor: CanopyUser, branch: string, body: UpdateBranchAccessBody) =>
  updateBranchAccessHandler(ctx(), { user: actor }, { branch: branch as BranchName }, body)

beforeEach(async () => {
  baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-branch-access-'))
  contexts = []
  config = { mode: 'dev', defaultBaseBranch: 'main', defaultBranchAccess: 'deny' } as CanopyConfig
  knownUsers = new Set(['owner', 'member', 'pal', 'colleague', 'outsider', 'admin'])
  auditLines = []
  setBranchAccessLogSink((line) => auditLines.push(line))
  // 'colleague' works in this CMS: they created a branch. 'outsider' only has an account.
  await addBranch('feature/colleagues-work', { createdBy: 'colleague', editors: ['pal'] })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(baseRoot, { recursive: true, force: true })
})

describe('PATCH /:branch/access', () => {
  it("restricts the branch on its owner's first share, keeps the owner, and says what changed", async () => {
    const context = await addBranch('feature/x')

    const res = await patch(owner, 'feature/x', { add: { users: ['colleague'] } })

    expect(res.ok).toBe(true)
    expect(res.data?.branch.access.allowedUsers).toEqual(['owner', 'colleague'])
    expect(res.data?.branch.sharing).toMatchObject({
      isOwner: true,
      canManage: true,
      restricted: true,
      openToEveryone: false,
    })
    const saved = await onDisk(context)
    expect(saved?.access).toMatchObject({ restricted: true, allowedUsers: ['owner', 'colleague'] })
    expect(saved?.access.entryMeta?.['user:colleague']?.addedBy).toBe('owner')
    const audit = auditLines.find((l) => l.includes('branch-access'))
    expect(JSON.parse(audit ?? '{}')).toMatchObject({
      event: 'branch-access',
      branch: 'feature/x',
      actor: 'owner',
      added: { users: ['colleague'], groups: [] },
    })
  })

  it('refuses a non-admin adding someone who does not work in this CMS, by id', async () => {
    const context = await addBranch('feature/x')

    const res = await patch(owner, 'feature/x', { add: { users: ['outsider'] } })

    expect(res).toMatchObject({ ok: false, status: 403, code: 'USER_OUT_OF_SCOPE' })
    expect((await onDisk(context))?.access).toEqual({})
  })

  it('lets an admin add anyone the sign-in provider knows, and no one it does not', async () => {
    await addBranch('feature/x')

    expect((await patch(admin, 'feature/x', { add: { users: ['outsider'] } })).ok).toBe(true)
    expect(await patch(admin, 'feature/x', { add: { users: ['ghost'] } })).toMatchObject({
      status: 400,
      code: 'USER_NOT_FOUND',
    })
  })

  it('refuses a creator an admin left off the list, so they cannot add themselves back', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['member'] },
    })

    const res = await patch(owner, 'feature/x', { add: { users: ['owner'] } })

    expect(res).toMatchObject({ status: 403, code: 'BRANCH_ACCESS_DENIED' })
    expect((await onDisk(context))?.access.allowedUsers).toEqual(['member'])
  })

  it('refuses a locked-down creator', async () => {
    await addBranch('feature/x', { access: { managerOrAdminAllowed: true } })

    expect(await patch(owner, 'feature/x', { add: { users: ['colleague'] } })).toMatchObject({
      status: 403,
      code: 'BRANCH_LOCKED_DOWN',
    })
  })

  it('keeps a member from adding back an owner an admin removed', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'] },
    })
    expect((await patch(admin, 'feature/x', { remove: { users: ['owner'] } })).ok).toBe(true)

    expect(await patch(member, 'feature/x', { add: { users: ['owner'] } })).toMatchObject({
      status: 403,
      code: 'USER_EXCLUDED',
      ids: ['owner'],
    })
    expect((await onDisk(context))?.access.allowedUsers).toEqual(['member'])
  })

  it('lets a member add people and remove only those they added', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'] },
    })

    expect((await patch(member, 'feature/x', { add: { users: ['pal'] } })).ok).toBe(true)
    expect(await patch(member, 'feature/x', { remove: { users: ['owner'] } })).toMatchObject({
      code: 'ACCESS_MANAGE_FORBIDDEN',
      ids: ['owner'],
    })
    expect((await patch(member, 'feature/x', { remove: { users: ['pal'] } })).ok).toBe(true)
    const saved = await onDisk(context)
    expect(saved?.access.allowedUsers).toEqual(['owner', 'member'])
    expect(saved?.access.excluded).toBeUndefined()
  })

  it.each([
    ['the base branch', 'main', { createdBy: SYSTEM_USER_ID, baseBranch: 'main' }],
    [
      'a system-owned branch it may open',
      'feature/system',
      { createdBy: SYSTEM_USER_ID, access: { restricted: true, allowedUsers: ['owner'] } },
    ],
  ])('refuses sharing %s to a non-admin', async (_label, name, fields) => {
    await addBranch(name, fields)

    expect(await patch(owner, name, { add: { users: ['colleague'] } })).toMatchObject({
      status: 403,
      code: 'BRANCH_NOT_SHAREABLE',
    })
  })

  it('refuses sharing an archived branch, except by an admin', async () => {
    await addBranch('feature/x', { status: 'archived' })

    expect(await patch(owner, 'feature/x', { add: { users: ['colleague'] } })).toMatchObject({
      code: 'BRANCH_ARCHIVED',
    })
    expect((await patch(admin, 'feature/x', { add: { users: ['colleague'] } })).ok).toBe(true)
  })

  it("opens a branch only on an 'allow' site", async () => {
    await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'] },
    })

    expect(await patch(owner, 'feature/x', { restricted: false })).toMatchObject({
      code: 'OPEN_NOT_ALLOWED',
    })
    config = { ...config, defaultBranchAccess: 'allow' }
    const opened = await patch(owner, 'feature/x', { restricted: false })
    expect(opened.data?.branch.access.allowedUsers).toBeUndefined()
    expect(opened.data?.branch.sharing).toMatchObject({ restricted: false, openToEveryone: true })
  })

  it('writes nothing for a change already in effect, so a retry is harmless', async () => {
    const context = await addBranch('feature/x')
    await patch(owner, 'feature/x', { add: { users: ['colleague'] } })
    const first = await onDisk(context)
    auditLines = []

    const again = await patch(owner, 'feature/x', { add: { users: ['colleague'] } })

    expect(again.ok).toBe(true)
    expect(await onDisk(context)).toEqual(first)
    expect(auditLines).toEqual([])
  })

  it('keeps both of two concurrent shares', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'] },
    })
    const staleContext = { ...context }

    await Promise.all([
      changeBranchAccess(ctx(), owner, staleContext, { add: { users: ['colleague'] } }),
      changeBranchAccess(ctx(), member, staleContext, { add: { users: ['pal'] } }),
    ])

    expect([...((await onDisk(context))?.access.allowedUsers ?? [])].sort()).toEqual([
      'colleague',
      'member',
      'owner',
      'pal',
    ])
  })

  it('applies the rules to the list on disk, not the copy the request started from', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'] },
    })
    const before = { ...context, branch: { ...context.branch } }
    expect((await patch(owner, 'feature/x', { remove: { users: ['member'] } })).ok).toBe(true)

    const res = await changeBranchAccess(ctx(), member, before, { add: { users: ['pal'] } })

    expect(res).toMatchObject({ ok: false, refused: { code: 'ACCESS_ADD_FORBIDDEN' } })
    expect((await onDisk(context))?.access.allowedUsers).toEqual(['owner'])
  })
})

describe('PATCH /:branch/access, round-one cases', () => {
  it('treats re-adding someone already listed as done, whoever first added them', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'outsider'] },
    })
    const before = await onDisk(context)

    expect((await patch(owner, 'feature/x', { add: { users: ['outsider'] } })).ok).toBe(true)
    expect(await onDisk(context)).toEqual(before)
  })

  it('refuses an id the request never scope-checked because its copy already listed it', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner'] },
    })
    const stale = {
      ...context,
      branch: {
        ...context.branch,
        access: { restricted: true, allowedUsers: ['owner', 'outsider'] },
      },
    }

    const res = await changeBranchAccess(ctx(), owner, stale, { add: { users: ['outsider'] } })

    expect(res).toMatchObject({ ok: false, refused: { status: 409, code: 'LIST_CHANGED' } })
    expect((await onDisk(context))?.access.allowedUsers).toEqual(['owner'])
  })

  it('looks no one up for a removal that records nothing new, so a retry stays a no-op', async () => {
    const context = await addBranch('feature/x', {
      access: {
        restricted: true,
        allowedUsers: ['owner'],
        excluded: { departed: { by: 'owner', at: 't', byAdmin: false } },
      },
    })
    const before = await onDisk(context)

    expect((await patch(owner, 'feature/x', { remove: { users: ['departed'] } })).ok).toBe(true)
    expect(await onDisk(context)).toEqual(before)
  })

  it('refuses an exclusion the list on disk records but the request never looked up', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner'], addBy: 'members' },
    })
    const stale = {
      ...context,
      branch: { ...context.branch, access: { ...context.branch.access, addBy: 'admins' as const } },
    }

    const res = await changeBranchAccess(ctx(), owner, stale, { remove: { users: ['made-up'] } })

    expect(res).toMatchObject({ ok: false, refused: { status: 409, code: 'LIST_CHANGED' } })
    expect((await onDisk(context))?.access.excluded).toBeUndefined()
  })

  it('refuses excluding an id the sign-in provider does not know', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner'] },
    })

    expect(await patch(owner, 'feature/x', { remove: { users: ['made-up'] } })).toMatchObject({
      status: 400,
      code: 'USER_NOT_FOUND',
    })
    expect((await onDisk(context))?.access.excluded).toBeUndefined()
  })

  it('records no exclusion of someone outside this CMS, so allowing back by id adds no one new', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner'] },
    })

    expect(await patch(owner, 'feature/x', { remove: { users: ['outsider'] } })).toMatchObject({
      status: 403,
      code: 'USER_OUT_OF_SCOPE',
      ids: ['outsider'],
    })
    expect((await onDisk(context))?.access.excluded).toBeUndefined()
    expect(await patch(owner, 'feature/x', { add: { users: ['outsider'] } })).toMatchObject({
      code: 'USER_OUT_OF_SCOPE',
    })
  })

  it('shuts out someone an owner removed even when a group on the list holds them', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner'], allowedGroups: ['team'] },
    })
    expect((await patch(owner, 'feature/x', { remove: { users: ['pal'] } })).ok).toBe(true)

    const onDiskContext = { ...context, branch: (await onDisk(context)) ?? context.branch }
    expect(ctx().services.checkBranchAccess(onDiskContext, user('pal', ['team'])).allowed).toBe(
      false,
    )
  })
})

describe('PATCH /:branch/access, final-review cases', () => {
  it("lets a non-admin add by id anyone a name search finds where it finds 'all-users'", async () => {
    config = { ...config, branchSharing: { searchable: 'all-users' } }
    const context = await addBranch('feature/x')

    expect((await patch(owner, 'feature/x', { add: { users: ['outsider'] } })).ok).toBe(true)
    expect((await onDisk(context))?.access.allowedUsers).toEqual(['owner', 'outsider'])
    expect(await patch(owner, 'feature/x', { add: { users: ['ghost'] } })).toMatchObject({
      status: 400,
      code: 'USER_NOT_FOUND',
    })
    // Excluding someone unlisted still needs them to work in this CMS.
    expect(await patch(owner, 'feature/x', { remove: { users: ['admin'] } })).toMatchObject({
      code: 'USER_OUT_OF_SCOPE',
    })
  })

  it("makes an admin's removal of someone the owner removed stick, as a change", async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'] },
    })
    expect((await patch(owner, 'feature/x', { remove: { users: ['member'] } })).ok).toBe(true)
    auditLines = []

    expect((await patch(admin, 'feature/x', { remove: { users: ['member'] } })).ok).toBe(true)

    expect((await onDisk(context))?.access.excluded?.member).toMatchObject({
      by: 'admin',
      byAdmin: true,
    })
    const audit = JSON.parse(auditLines.find((l) => l.includes('branch-access')) ?? '{}')
    expect(audit).toMatchObject({ actor: 'admin', excluded: ['member'] })
    expect(await patch(owner, 'feature/x', { add: { users: ['member'] } })).toMatchObject({
      code: 'USER_EXCLUDED',
    })
  })

  it('lets a member remove whom they added after the owner keeps adding to themselves', async () => {
    const context = await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'] },
    })
    expect((await patch(member, 'feature/x', { add: { users: ['pal'] } })).ok).toBe(true)
    expect((await patch(owner, 'feature/x', { addBy: 'owner' })).ok).toBe(true)

    expect((await patch(member, 'feature/x', { remove: { users: ['pal'] } })).ok).toBe(true)

    const saved = await onDisk(context)
    expect(saved?.access.allowedUsers).toEqual(['owner', 'member'])
    expect(saved?.access.excluded).toBeUndefined()
  })

  it('reports no change when a retry finds the branch.json gone', async () => {
    const context = await addBranch('feature/x')
    const real = await BranchMetadataFileManager.loadOnly(context.branchRoot)
    vi.spyOn(BranchMetadataFileManager, 'get').mockReturnValue({
      // The first attempt loses an OCC race; the retry finds no file.
      update: async (compute: (existing: typeof real) => unknown) => {
        compute(real)
        return compute(null)
      },
    } as unknown as BranchMetadataFileManager)

    const res = await changeBranchAccess(ctx(), admin, context, { add: { users: ['colleague'] } })

    expect(res).toMatchObject({ ok: true, result: null })
    expect(auditLines.filter((l) => l.includes('branch-access'))).toEqual([])
  })
})

describe('initialBranchAccess (sharing at create)', () => {
  it("lets a non-admin start a branch shared with any known account where search finds 'all-users'", async () => {
    config = { ...config, branchSharing: { searchable: 'all-users' } }

    expect(await initialBranchAccess(ctx(), owner, { users: ['outsider'] })).toMatchObject({
      ok: true,
      access: { allowedUsers: ['owner', 'outsider'] },
      added: ['outsider'],
    })
    expect(await initialBranchAccess(ctx(), owner, { users: ['ghost'] })).toMatchObject({
      ok: false,
      refused: { code: 'USER_NOT_FOUND' },
    })
  })

  it('starts the branch restricted to its creator and the people added', async () => {
    const res = await initialBranchAccess(ctx(), owner, {
      users: ['colleague'],
      groups: ['writers'],
    })

    expect(res).toMatchObject({
      ok: true,
      access: {
        restricted: true,
        allowedUsers: ['owner', 'colleague'],
        allowedGroups: ['writers'],
      },
    })
  })

  it('refuses by the same rules as a later share', async () => {
    expect(await initialBranchAccess(ctx(), owner, { users: ['outsider'] })).toMatchObject({
      ok: false,
      refused: { code: 'USER_OUT_OF_SCOPE' },
    })
    expect(await initialBranchAccess(ctx(), owner, { groups: ['strangers'] })).toMatchObject({
      ok: false,
      refused: { code: 'GROUP_NOT_YOURS' },
    })
  })

  it('leaves the list alone when nobody is added', async () => {
    expect(await initialBranchAccess(ctx(), owner, undefined)).toEqual({
      ok: true,
      access: undefined,
      added: [],
    })
  })
})
