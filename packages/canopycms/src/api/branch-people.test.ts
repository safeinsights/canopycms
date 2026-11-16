import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthPlugin } from '../auth/plugin'
import type { UserSearchResult } from '../auth/types'
import { CachingAuthPlugin } from '../auth/caching-auth-plugin'
import { RESERVED_GROUPS } from '../authorization'
import { createCheckBranchAccess } from '../authorization/branch'
import { buildInitialBranchMetadata, BranchMetadataFileManager } from '../branch-metadata'
import { BRANCH_META_DIR, BRANCH_META_FILE } from '../branch-metadata-file'
import type { BranchSharingConfig, CanopyConfig } from '../config'
import { sanitizeBranchName } from '../paths/branch-name'
import type { BranchName } from '../paths/types'
import { PeopleStore } from '../people-store'
import { mockConsole } from '../test-utils/console-spy'
import type { BranchContext, BranchMetadata } from '../types'
import type { CanopyUser } from '../user'
import { setBranchAccessLogSink } from '../utils/access-log'
import { ADMIN_ROUTES } from './admin'
import { updateBranchAccessHandler, type UpdateBranchAccessBody } from './branch'
import { changeBranchAccess, initialBranchAccess } from './branch-access'
import {
  BRANCH_PEOPLE_ROUTES,
  type BranchAccessResponse,
  type FindPeopleResponse,
} from './branch-people'
import { EMAIL_LOOKUP_LIMIT, resetEmailLookupLimits, type FindPeopleResult } from './people'
import type { ApiContext, ApiResponse } from './types'
import { USER_ROUTES } from './user'

const user = (userId: string, groups: string[] = []): CanopyUser => ({
  type: 'authenticated',
  userId,
  groups,
})
const owner = user('owner', ['writers'])
const member = user('member', ['team'])
const admin = user('admin', [RESERVED_GROUPS.ADMINS])
const reviewer = user('reviewer', [RESERVED_GROUPS.REVIEWERS])

const person = (id: string, name: string, email = `${id}@example.org`): UserSearchResult => ({
  id,
  name,
  email,
})
const carlas = Array.from({ length: 10 }, (_, i) => person(`carla${i}`, `Carla ${i}`))
const directory: UserSearchResult[] = [
  person('owner', 'Olive Owner'),
  person('member', 'Mia Member'),
  person('colleague', 'Cole Ortiz', 'cole@example.org'),
  person('pal', 'Pat Alvarez'),
  person('outsider', 'Otto Outsider', 'otto@example.org'),
  person('orgie', 'Ora Org'),
  person('admin', 'Ada Admin'),
  person('reviewer', 'Rae Reviewer'),
  ...carlas,
]

let workspace: string
let baseRoot: string
let settingsRoot: string
let contexts: BranchContext[]
let config: CanopyConfig
let peopleStore: PeopleStore
let authPlugin: AuthPlugin
let logLines: string[]

const searchUsers = vi.fn(async (query: string, limit = 10) =>
  directory
    .filter((u) => u.name.toLowerCase().includes(query.toLowerCase()) || u.email.includes(query))
    .slice(0, limit),
)

const plainPlugin = (): AuthPlugin => ({
  authenticate: async () => ({ success: false }),
  searchUsers,
  getUserMetadata: async (id) => directory.find((u) => u.id === id) ?? null,
  getGroupMetadata: async (id) => (id === 'org-writers' ? { id, name: 'Writers org' } : null),
  listGroups: async () => [],
})

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

const ctx = (): ApiContext =>
  ({
    services: {
      config,
      checkBranchAccess: (context: BranchContext, u: CanopyUser) =>
        createCheckBranchAccess(config.defaultBranchAccess ?? 'deny', config)(context, u),
      getSettingsBranchRoot: async () => settingsRoot,
      bootstrapAdminIds: new Set<string>(),
      registry: { list: async () => contexts },
      peopleStore,
    },
    authPlugin,
    getBranchContext: async (name: string) => {
      const known = contexts.find((c) => c.branch.name === name)
      if (!known) return null
      return { ...known, branch: (await onDisk(known)) ?? known.branch }
    },
  }) as unknown as ApiContext

const sharing = (branchSharing: BranchSharingConfig) => {
  config = { ...config, branchSharing }
}

const find = (actor: CanopyUser, branch: string, query: string) =>
  BRANCH_PEOPLE_ROUTES.findPeople.handler(
    ctx(),
    { user: actor },
    { branch: branch as BranchName },
    { query },
  ) as Promise<ApiResponse<FindPeopleResult>>

const findForNewBranch = (actor: CanopyUser, query: string) =>
  BRANCH_PEOPLE_ROUTES.findPeopleForNewBranch.handler(
    ctx(),
    { user: actor },
    { query },
  ) as Promise<FindPeopleResponse>

const getAccess = (actor: CanopyUser, branch: string) =>
  BRANCH_PEOPLE_ROUTES.getAccess.handler(
    ctx(),
    { user: actor },
    {
      branch: branch as BranchName,
    },
  ) as Promise<BranchAccessResponse>

const patch = (actor: CanopyUser, branch: string, body: UpdateBranchAccessBody) =>
  updateBranchAccessHandler(ctx(), { user: actor }, { branch: branch as BranchName }, body)

const ids = (res: ApiResponse<FindPeopleResult>) => res.data?.people.map((p) => p.id)

const writeSettings = async (root: string, pathPermissions: unknown[]) => {
  await fs.mkdir(root, { recursive: true })
  const stamp = { updatedAt: new Date().toISOString(), updatedBy: 'admin' }
  await fs.writeFile(
    path.join(root, 'permissions.json'),
    JSON.stringify({ ...stamp, pathPermissions }),
  )
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-branch-people-'))
  baseRoot = path.join(workspace, 'content-branches')
  settingsRoot = path.join(workspace, 'settings')
  contexts = []
  config = { mode: 'dev', defaultBaseBranch: 'main', defaultBranchAccess: 'deny' } as CanopyConfig
  peopleStore = new PeopleStore(path.join(workspace, '.people'), { settleMs: 0 })
  authPlugin = plainPlugin()
  searchUsers.mockClear()
  resetEmailLookupLimits()
  logLines = []
  setBranchAccessLogSink((line) => logLines.push(line))
  await writeSettings(settingsRoot, [
    { path: 'content/**', edit: { allowedGroups: ['org-writers'] } },
  ])
  await fs.writeFile(
    path.join(settingsRoot, 'groups.json'),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      updatedBy: 'admin',
      groups: [
        { id: 'team', name: 'Marketing team', members: ['member'] },
        { id: 'ops', name: 'Operations', members: [] },
      ],
    }),
  )
  // 'colleague' created a branch and 'pal' and the Carlas saved to it: they work in this CMS.
  // 'member' is in an internal group. 'outsider' and 'orgie' only have accounts.
  await addBranch('feature/colleagues-work', {
    createdBy: 'colleague',
    editors: ['pal', ...carlas.map((c) => c.id)],
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(workspace, { recursive: true, force: true })
})

describe('GET /whoami records who opened the editor', () => {
  const whoami = (actor: CanopyUser) => USER_ROUTES.whoami.handler(ctx(), { user: actor })

  it('records someone in an internal group, or in a provider group a path permission names', async () => {
    expect((await whoami(member)).ok).toBe(true)
    expect((await whoami(user('orgie', ['org-writers']))).ok).toBe(true)

    expect(await peopleStore.listSeen()).toEqual(new Set(['member', 'orgie']))
  })

  it('records no one whose only groups are Admins, Reviewers or groups no permission names', async () => {
    await whoami(admin)
    await whoami(reviewer)
    await whoami(user('outsider', ['some-org']))
    await whoami(user('pal'))

    expect(await peopleStore.listSeen()).toEqual(new Set())
  })

  it('still answers when recording fails, and says why in the log', async () => {
    const console = mockConsole()
    try {
      const failing = ctx()
      failing.services.getSettingsBranchRoot = async () => {
        throw new Error('settings unavailable')
      }

      const res = await USER_ROUTES.whoami.handler(failing, { user: member })

      expect(res).toMatchObject({ ok: true, data: { userId: 'member' } })
      expect(console.all().warn.join('\n')).toContain('settings unavailable')
    } finally {
      console.restore()
    }
  })

  it('makes someone a person others can find', async () => {
    await addBranch('feature/x')
    expect(ids(await find(owner, 'feature/x', 'Ora'))).toEqual([])

    await whoami(user('orgie', ['org-writers']))

    expect(ids(await find(owner, 'feature/x', 'Ora'))).toEqual(['orgie'])
  })
})

describe('POST /:branch/access/find', () => {
  it('answers only someone who may add people to the branch', async () => {
    await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'], addBy: 'owner' },
    })

    expect(await find(member, 'feature/x', 'Co')).toMatchObject({
      ok: false,
      status: 403,
      code: 'ACCESS_ADD_FORBIDDEN',
    })
    expect((await find(owner, 'feature/x', 'Co')).ok).toBe(true)
  })

  it('matches the start of a name or a word in it among people who work in this CMS', async () => {
    await addBranch('feature/x')

    expect(await find(owner, 'feature/x', 'C')).toMatchObject({
      ok: true,
      data: { people: [], groups: [] },
    })
    expect(ids(await find(owner, 'feature/x', 'ortiz'))).toEqual(['colleague'])
    expect(ids(await find(owner, 'feature/x', 'rtiz'))).toEqual([])
    // Otto has an account but doesn't work in this CMS.
    expect(ids(await find(owner, 'feature/x', 'Otto'))).toEqual([])
    // Nor is the caller offered, though the list doesn't name them.
    expect(ids(await find(owner, 'feature/x', 'Olive'))).toEqual([])
  })

  it('offers at most 8, never the caller, nor anyone listed or removed', async () => {
    await addBranch('feature/x', {
      access: {
        restricted: true,
        allowedUsers: ['owner', 'carla0'],
        excluded: { carla1: { by: 'owner', at: '2026-01-01T00:00:00.000Z', byAdmin: false } },
      },
    })

    const found = ids(await find(owner, 'feature/x', 'carla'))
    expect(found).toHaveLength(8)
    expect(found).not.toContain('carla0')
    expect(found).not.toContain('carla1')
    expect(ids(await find(owner, 'feature/x', 'Olive'))).toEqual([])
  })

  it('shows a masked email to everyone but admins and reviewers', async () => {
    await addBranch('feature/x')

    const res = await find(owner, 'feature/x', 'Cole')
    expect(res.data?.people).toEqual([
      { id: 'colleague', name: 'Cole Ortiz', maskedEmail: 'c•••@example.org' },
    ])
    expect(JSON.stringify(res)).not.toContain('cole@')
    expect((await find(admin, 'feature/x', 'Cole')).data?.people[0]).toEqual({
      id: 'colleague',
      name: 'Cole Ortiz',
      email: 'cole@example.org',
    })
  })

  it("under 'all-users', matches names across the provider, showing no email for outsiders", async () => {
    sharing({ searchable: 'all-users' })
    await addBranch('feature/x')

    const res = await find(owner, 'feature/x', 'Otto')
    expect(res.data?.people).toEqual([{ id: 'outsider', name: 'Otto Outsider' }])
    // Every address contains it, but only names are matched.
    expect(ids(await find(owner, 'feature/x', 'example'))).toEqual([])
    expect(searchUsers).toHaveBeenCalledWith('example', 50)
  })

  it("under 'all-users', matches names over a caching plugin's whole list", async () => {
    sharing({ searchable: 'all-users' })
    await addBranch('feature/x')
    const cache = {
      getUser: async () => null,
      getGroup: async () => null,
      getAllUsers: async () => directory,
      getAllGroups: async () => [],
      getUserExternalGroups: async () => [],
    }
    authPlugin = new CachingAuthPlugin(async () => null, cache)
    const search = vi.spyOn(authPlugin, 'searchUsers')

    expect(ids(await find(owner, 'feature/x', 'Otto'))).toEqual(['outsider'])
    expect(ids(await find(owner, 'feature/x', 'otto@'))).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })

  it("under 'nobody', finds no one by name, but still by a whole email address", async () => {
    sharing({ searchable: 'nobody' })
    await addBranch('feature/x')

    expect(ids(await find(owner, 'feature/x', 'Cole'))).toEqual([])
    expect(ids(await find(owner, 'feature/x', 'cole@example.org'))).toEqual(['colleague'])
  })

  it('offers the groups the caller belongs to, and an admin every internal group', async () => {
    await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'], allowedGroups: [] },
    })

    expect((await find(member, 'feature/x', 'mark')).data?.groups).toEqual([
      { id: 'team', name: 'Marketing team' },
    ])
    expect((await find(member, 'feature/x', 'oper')).data?.groups).toEqual([])
    expect((await find(admin, 'feature/x', '')).data?.groups).toEqual([
      { id: 'team', name: 'Marketing team' },
      { id: 'ops', name: 'Operations' },
    ])
  })

  it('leaves out groups already listed', async () => {
    await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['member'], allowedGroups: ['team'] },
    })

    expect((await find(member, 'feature/x', 'mark')).data?.groups).toEqual([])
  })

  it("finds anyone by a whole email address under 'all-users', and only CMS users under 'cms-users'", async () => {
    await addBranch('feature/x')

    expect((await find(owner, 'feature/x', 'OTTO@example.org')).data?.people).toEqual([
      { id: 'outsider', name: 'Otto Outsider', addByAddress: true },
    ])
    expect(ids(await find(owner, 'feature/x', 'otto@example'))).toEqual([])

    sharing({ addableByEmail: 'cms-users' })
    expect(ids(await find(owner, 'feature/x', 'otto@example.org'))).toEqual([])
    expect((await find(owner, 'feature/x', 'cole@example.org')).data?.people).toEqual([
      { id: 'colleague', name: 'Cole Ortiz', maskedEmail: 'c•••@example.org' },
    ])
  })

  it('offers no one who opens every branch through their role, by name, address or suggestion', async () => {
    await addBranch('feature/x', { access: { allowedUsers: ['owner', 'member'] } })
    await fs.writeFile(
      path.join(settingsRoot, 'groups.json'),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
        groups: [
          { id: 'team', name: 'Marketing team', members: ['member'] },
          { id: RESERVED_GROUPS.ADMINS, name: 'Admins', members: ['colleague'] },
          { id: RESERVED_GROUPS.REVIEWERS, name: 'Reviewers', members: ['pal'] },
        ],
      }),
    )
    await peopleStore.recordShares('owner', ['colleague', 'pal', 'outsider'])

    expect(ids(await find(owner, 'feature/x', 'Cole'))).toEqual([])
    expect(ids(await find(owner, 'feature/x', 'cole@example.org'))).toEqual([])
    expect(ids(await find(owner, 'feature/x', ''))).not.toContain('pal')
    expect(ids(await find(owner, 'feature/x', ''))).not.toContain('colleague')
    expect(ids(await find(owner, 'feature/x', 'Otto'))).toEqual([])
    expect(ids(await find(owner, 'feature/x', 'Mia'))).toEqual([])
    expect(ids(await find(owner, 'feature/x', 'otto@example.org'))).toEqual(['outsider'])
  })

  it('asks for an add by address only where an id would be out of scope', async () => {
    await addBranch('feature/x', { access: { allowedUsers: ['reviewer', 'member'] } })
    const found = async (actor: CanopyUser, email: string) =>
      (await find(actor, 'feature/x', email)).data?.people[0]

    expect(await found(reviewer, 'cole@example.org')).toEqual({
      id: 'colleague',
      name: 'Cole Ortiz',
      email: 'cole@example.org',
    })
    expect((await found(reviewer, 'otto@example.org'))?.addByAddress).toBe(true)
    expect((await found(member, 'otto@example.org'))?.addByAddress).toBe(true)
    expect(await found(admin, 'otto@example.org')).toEqual({
      id: 'outsider',
      name: 'Otto Outsider',
      email: 'otto@example.org',
    })
  })

  it('refuses email lookups past the limit, and counts no name search', async () => {
    await addBranch('feature/x')
    for (let i = 0; i < EMAIL_LOOKUP_LIMIT; i++) {
      expect((await find(owner, 'feature/x', `nobody${i}@example.org`)).ok).toBe(true)
    }

    expect(await find(owner, 'feature/x', 'cole@example.org')).toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
    })
    expect((await find(owner, 'feature/x', 'Cole')).ok).toBe(true)
    expect((await find(member, 'feature/x', 'cole@example.org')).status).not.toBe(429)
  })

  it('logs each email lookup with who asked and what they were shown, never the address', async () => {
    await addBranch('feature/x')

    await find(owner, 'feature/x', 'otto@example.org')
    await find(owner, 'feature/x', 'ghost@example.org')
    // Neither a name nor part of an address is an email lookup.
    await find(owner, 'feature/x', 'Otto')
    await find(owner, 'feature/x', 'otto@example')

    expect(logLines.map((line) => JSON.parse(line))).toEqual([
      { event: 'people-email-lookup', actor: 'owner', result: 'outsider' },
      { event: 'people-email-lookup', actor: 'owner', result: 'not found' },
    ])
    expect(logLines.join('\n')).not.toContain('@')
  })

  it("suggests recent shares, newest first, then the branch's editors, for an empty query", async () => {
    await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'carla0'] },
      editors: ['carla5', 'owner', 'pal'],
    })
    await peopleStore.recordShares('owner', ['carla3'], new Date(Date.now() - 2000))
    await peopleStore.recordShares('owner', ['colleague', 'carla0'], new Date(Date.now() - 1000))
    // An outsider shared with by email works in no CMS sense, so is never suggested.
    await peopleStore.recordShares('owner', ['outsider'])

    expect(ids(await find(owner, 'feature/x', ''))).toEqual([
      'colleague',
      'carla3',
      'carla5',
      'pal',
    ])
  })

  it('suggests no more than 8', async () => {
    await addBranch('feature/x')
    await peopleStore.recordShares(
      'owner',
      carlas.map((c) => c.id),
    )

    expect(ids(await find(owner, 'feature/x', ''))).toHaveLength(8)
  })
})

describe('POST /branches/access/find', () => {
  beforeEach(async () => {
    await writeSettings(settingsRoot, [
      { path: 'content/**', edit: { allowedGroups: ['writers'] } },
    ])
  })

  it('answers only someone the path permissions let create branches', async () => {
    expect(await findForNewBranch(user('pal'), 'Cole')).toMatchObject({ ok: false, status: 403 })
    expect(ids(await findForNewBranch(owner, 'Cole'))).toEqual(['colleague'])
  })

  it("reads the path permissions from the settings workspace, never the base branch's clone", async () => {
    const main = await addBranch('main', { createdBy: 'owner' })
    await writeSettings(main.branchRoot, [{ path: 'content/**', edit: {} }])

    expect(await findForNewBranch(user('pal'), 'Cole')).toMatchObject({ ok: false, status: 403 })
  })

  it("lets anyone use it when edit defaults to 'allow', beside a narrower rule", async () => {
    config = { ...config, defaultPathAccess: 'allow' }
    await writeSettings(settingsRoot, [
      { path: 'content/legal/**', edit: { allowedUsers: ['colleague'] } },
    ])

    expect(ids(await findForNewBranch(user('pal'), 'Cole'))).toEqual(['colleague'])
  })

  it('leaves it to admins and reviewers when there are no rules and edit defaults to deny', async () => {
    await writeSettings(settingsRoot, [])

    const refused = { ok: false, status: 403, code: 'BRANCH_CREATE_FORBIDDEN' }
    expect(await findForNewBranch(user('pal'), 'Cole')).toMatchObject(refused)
    config = { ...config, defaultPathAccess: { read: 'allow' } }
    expect(await findForNewBranch(user('pal'), 'Cole')).toMatchObject(refused)
    expect((await findForNewBranch(reviewer, 'Cole')).ok).toBe(true)
  })

  it('suggests recent shares with no branch to draw editors from', async () => {
    await peopleStore.recordShares('owner', ['pal'])

    expect(ids(await findForNewBranch(owner, ''))).toEqual(['pal'])
  })

  it("sends the site's sharing settings, which a branch not yet created has no list to carry", async () => {
    config = { ...config, defaultBranchAccess: 'allow' }
    sharing({ searchable: 'nobody', addableByEmail: 'cms-users' })

    expect((await findForNewBranch(owner, '')).data?.newBranch).toEqual({
      defaultAccess: 'allow',
      searchable: 'nobody',
      addableByEmail: 'cms-users',
    })
    expect((await findForNewBranch(admin, '')).data?.newBranch?.addableByEmail).toBe('all-users')
  })
})

describe('GET /:branch/access', () => {
  const shared = () =>
    addBranch('feature/x', {
      access: {
        restricted: true,
        allowedUsers: ['owner', 'colleague', 'outsider', 'ghost'],
        allowedGroups: ['team'],
        entryMeta: {
          'user:colleague': { addedBy: 'owner', addedAt: '2026-11-01T00:00:00.000Z' },
          'user:outsider': { addedBy: 'admin', addedAt: '2026-11-02T00:00:00.000Z' },
          'group:team': { addedBy: 'colleague', addedAt: '2026-11-03T00:00:00.000Z' },
        },
        excluded: { pal: { by: 'admin', at: '2026-11-04T00:00:00.000Z', byAdmin: true } },
      },
    })

  it('names each entry, and tells an owner who added it and who was removed', async () => {
    await shared()

    const res = await getAccess(owner, 'feature/x')

    expect(res.data).toEqual({
      entries: [
        { kind: 'user', id: 'owner', name: 'Olive Owner', maskedEmail: 'o•••@example.org' },
        {
          kind: 'user',
          id: 'colleague',
          name: 'Cole Ortiz',
          maskedEmail: 'c•••@example.org',
          addedBy: { id: 'owner', name: 'Olive Owner' },
          addedAt: '2026-11-01T00:00:00.000Z',
        },
        {
          kind: 'user',
          id: 'outsider',
          name: 'Otto Outsider',
          addedBy: { id: 'admin', name: 'Ada Admin' },
          addedAt: '2026-11-02T00:00:00.000Z',
        },
        { kind: 'user', id: 'ghost', name: 'Name unavailable' },
        {
          kind: 'group',
          id: 'team',
          name: 'Marketing team',
          addedBy: { id: 'colleague', name: 'Cole Ortiz' },
          addedAt: '2026-11-03T00:00:00.000Z',
        },
      ],
      excluded: [
        {
          kind: 'user',
          id: 'pal',
          name: 'Pat Alvarez',
          by: { id: 'admin', name: 'Ada Admin' },
          at: '2026-11-04T00:00:00.000Z',
          byAdmin: true,
        },
      ],
      restricted: true,
      openToEveryone: false,
      defaultAccess: 'deny',
      addBy: 'members',
      rights: { isOwner: true, canAdd: true, canManage: true },
      searchable: 'cms-users',
      addableByEmail: 'all-users',
    })
  })

  it('shows a member only who they added, and no full email', async () => {
    await shared()

    const res = await getAccess(user('colleague'), 'feature/x')

    expect(res.data?.excluded).toBeUndefined()
    expect(res.data?.entries.filter((entry) => entry.addedBy).map((entry) => entry.id)).toEqual([
      'team',
    ])
    expect(res.data?.rights).toEqual({ isOwner: false, canAdd: true, canManage: false })
    expect(JSON.stringify(res)).not.toMatch(/[a-z]+@example\.org/)
  })

  it('shows admins and reviewers full emails', async () => {
    await shared()

    const res = await getAccess(reviewer, 'feature/x')

    expect(res.data?.entries.slice(0, 3)).toMatchObject([
      { id: 'owner', email: 'owner@example.org' },
      { id: 'colleague', email: 'cole@example.org' },
      { id: 'outsider', email: 'otto@example.org' },
    ])
    expect(JSON.stringify(res)).not.toContain('maskedEmail')
  })

  it('still answers when the seen set cannot be read, masking fewer emails, while find fails', async () => {
    await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'colleague', 'orgie'] },
    })
    await fs.mkdir(path.join(workspace, '.people'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.people', 'seen'), 'not a folder')
    const console = mockConsole()
    try {
      const res = await getAccess(owner, 'feature/x')
      await getAccess(owner, 'feature/x')

      expect(res.data?.entries.map((entry) => [entry.id, entry.maskedEmail])).toEqual([
        ['owner', 'o•••@example.org'],
        ['colleague', 'c•••@example.org'],
        ['orgie', undefined],
      ])
      expect(console.all().warn).toHaveLength(1)
    } finally {
      console.restore()
    }
    await expect(find(owner, 'feature/x', 'Ora')).rejects.toThrow()
  })

  it('answers only someone who may open the branch', async () => {
    await shared()

    expect(await getAccess(user('pal'), 'feature/x')).toMatchObject({ ok: false, status: 403 })
  })

  it('says whom search and email find for the viewer, an admin finding anyone by email', async () => {
    await shared()
    sharing({ searchable: 'nobody', addableByEmail: 'cms-users' })

    expect((await getAccess(owner, 'feature/x')).data).toMatchObject({
      searchable: 'nobody',
      addableByEmail: 'cms-users',
    })
    expect((await getAccess(admin, 'feature/x')).data).toMatchObject({
      searchable: 'nobody',
      addableByEmail: 'all-users',
    })
  })
})

describe('PATCH /:branch/access adding by email', () => {
  it('adds someone outside this CMS by exact email, and remembers the share', async () => {
    const context = await addBranch('feature/x')

    const res = await patch(owner, 'feature/x', { add: { emails: ['Otto@Example.org'] } })

    expect(res.ok).toBe(true)
    expect((await onDisk(context))?.access.allowedUsers).toEqual(['owner', 'outsider'])
    expect((await peopleStore.recentShares('owner')).map((share) => share.userId)).toEqual([
      'outsider',
    ])
  })

  it('answers a share at once, recording no suggestion, while the recent-shares lock is busy', async () => {
    const context = await addBranch('feature/x')
    const sharer = createHash('sha256').update('owner').digest('hex')
    await fs.mkdir(path.join(workspace, '.people', 'shares', `${sharer}.json.lock`), {
      recursive: true,
    })
    const console = mockConsole()
    try {
      const started = Date.now()
      const res = await patch(owner, 'feature/x', { add: { users: ['colleague'] } })

      expect(res.ok).toBe(true)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(console.all().warn).toHaveLength(1)
    } finally {
      console.restore()
    }
    expect((await onDisk(context))?.access.allowedUsers).toEqual(['owner', 'colleague'])
    expect(await peopleStore.recentShares('owner')).toEqual([])
  })

  it("refuses an address outside this CMS under 'cms-users', and accepts one inside it", async () => {
    sharing({ addableByEmail: 'cms-users' })
    const context = await addBranch('feature/x')

    expect(
      await patch(owner, 'feature/x', { add: { emails: ['otto@example.org'] } }),
    ).toMatchObject({ ok: false, status: 400, code: 'USER_NOT_FOUND' })
    expect((await onDisk(context))?.access).toEqual({})
    expect((await patch(owner, 'feature/x', { add: { emails: ['cole@example.org'] } })).ok).toBe(
      true,
    )
  })

  it('refuses an address nobody uses, naming no address', async () => {
    const context = await addBranch('feature/x')

    const res = await patch(owner, 'feature/x', {
      add: { users: ['colleague'], emails: ['ghost@example.org'] },
    })

    expect(res).toMatchObject({ ok: false, status: 400, code: 'USER_NOT_FOUND' })
    expect(JSON.stringify(res)).not.toContain('ghost')
    expect((await onDisk(context))?.access).toEqual({})
    expect(await peopleStore.recentShares('owner')).toEqual([])
  })

  it('looks up no address for someone who may not add people', async () => {
    await addBranch('feature/x', {
      access: { restricted: true, allowedUsers: ['owner', 'member'], addBy: 'owner' },
    })

    expect(
      await patch(member, 'feature/x', { add: { emails: ['otto@example.org'] } }),
    ).toMatchObject({ status: 403, code: 'ACCESS_ADD_FORBIDDEN' })
    expect(logLines.filter((line) => line.includes('people-email-lookup'))).toEqual([])
  })

  it('counts each address against the email limit', async () => {
    await addBranch('feature/x')
    const emails = Array.from({ length: EMAIL_LOOKUP_LIMIT }, (_, i) => `n${i}@example.org`)
    await patch(owner, 'feature/x', { add: { emails } })

    expect(
      await patch(owner, 'feature/x', { add: { emails: ['otto@example.org'] } }),
    ).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED' })
  })

  it('lets an owner allow back by id an outsider they added by email and then removed', async () => {
    const context = await addBranch('feature/x')
    expect((await patch(owner, 'feature/x', { add: { emails: ['otto@example.org'] } })).ok).toBe(
      true,
    )
    expect((await patch(owner, 'feature/x', { remove: { users: ['outsider'] } })).ok).toBe(true)
    expect((await onDisk(context))?.access.excluded).toHaveProperty('outsider')

    expect((await patch(owner, 'feature/x', { add: { users: ['outsider'] } })).ok).toBe(true)
    const saved = (await onDisk(context))?.access
    expect(saved?.allowedUsers).toEqual(['owner', 'outsider'])
    expect(saved?.excluded).toBeUndefined()
  })

  it('never names the account an address found when refusing it', async () => {
    await addBranch('feature/x', {
      access: {
        restricted: true,
        allowedUsers: ['owner'],
        excluded: { outsider: { by: 'admin', at: 't', byAdmin: true } },
      },
    })

    const res = await patch(owner, 'feature/x', { add: { emails: ['otto@example.org'] } })

    expect(res).toMatchObject({ ok: false, code: 'USER_EXCLUDED' })
    expect(JSON.stringify(res)).not.toContain('outsider')
  })

  it.each([
    ['a reserved group', { groups: [RESERVED_GROUPS.ADMINS] }],
    ['an unknown id', { users: ['bogus'] }],
  ])(
    'answers a member a removed address beside %s as it answers an unknown one',
    async (_label, more) => {
      await addBranch('feature/x', {
        access: {
          restricted: true,
          allowedUsers: ['owner', 'member'],
          excluded: { outsider: { by: 'owner', at: 't', byAdmin: false } },
        },
      })

      const removed = await patch(member, 'feature/x', {
        add: { emails: ['otto@example.org'], ...more },
      })
      const nobody = await patch(member, 'feature/x', {
        add: { emails: ['ghost@example.org'], ...more },
      })

      expect(removed).toEqual(nobody)
      expect(nobody).toMatchObject({ status: 400, code: 'USER_NOT_FOUND' })
    },
  )

  it('answers a member a removed address as an unknown one when only the list on disk removed it', async () => {
    const context = await addBranch('feature/x', {
      access: {
        restricted: true,
        allowedUsers: ['owner', 'member'],
        excluded: { outsider: { by: 'owner', at: 't', byAdmin: false } },
        excludedGroups: { team: { by: 'owner', at: 't', byAdmin: false } },
      },
    })
    const stale = {
      ...context,
      branch: {
        ...context.branch,
        access: { restricted: true, allowedUsers: ['owner', 'member'] },
      },
    }

    const removed = await changeBranchAccess(ctx(), member, stale, {
      add: { emails: ['otto@example.org'], groups: ['team'] },
    })
    const nobody = await changeBranchAccess(ctx(), member, stale, {
      add: { emails: ['ghost@example.org'], groups: ['team'] },
    })

    expect(removed).toEqual(nobody)
    expect(nobody).toMatchObject({ ok: false, refused: { status: 400, code: 'USER_NOT_FOUND' } })
  })

  it('answers a member an address that finds someone removed as one that finds no one', async () => {
    await addBranch('feature/x', {
      access: {
        restricted: true,
        allowedUsers: ['owner', 'member'],
        excluded: { outsider: { by: 'owner', at: 't', byAdmin: false } },
      },
    })

    const removed = await patch(member, 'feature/x', { add: { emails: ['otto@example.org'] } })
    const nobody = await patch(member, 'feature/x', { add: { emails: ['ghost@example.org'] } })

    expect(removed).toEqual(nobody)
    expect(nobody).toMatchObject({ ok: false, status: 400, code: 'USER_NOT_FOUND' })
  })

  it('still refuses someone outside this CMS by id', async () => {
    await addBranch('feature/x')

    expect(await patch(owner, 'feature/x', { add: { users: ['outsider'] } })).toMatchObject({
      status: 403,
      code: 'USER_OUT_OF_SCOPE',
    })
  })

  it('remembers no share for a change already in effect', async () => {
    await addBranch('feature/x', { access: { restricted: true, allowedUsers: ['owner', 'pal'] } })

    expect((await patch(owner, 'feature/x', { add: { users: ['pal'] } })).ok).toBe(true)
    expect(await peopleStore.recentShares('owner')).toEqual([])
  })
})

describe('initialBranchAccess adding by email', () => {
  it('starts the branch shared with whoever the addresses find', async () => {
    const res = await initialBranchAccess(ctx(), owner, { emails: ['otto@example.org'] })

    expect(res).toMatchObject({
      ok: true,
      access: { restricted: true, allowedUsers: ['owner', 'outsider'] },
      added: ['outsider'],
    })
  })

  it("refuses an address outside this CMS under 'cms-users'", async () => {
    sharing({ addableByEmail: 'cms-users' })

    expect(await initialBranchAccess(ctx(), owner, { emails: ['otto@example.org'] })).toMatchObject(
      { ok: false, refused: { code: 'USER_NOT_FOUND' } },
    )
  })
})

describe('DELETE /admin/people/:userId/seen', () => {
  const remove = (actor: CanopyUser, userId: string) =>
    ADMIN_ROUTES.removeSeen.handler(ctx(), { user: actor }, { userId })

  it('lets an admin take someone out of the seen set, and no one else', async () => {
    await peopleStore.recordSeen('orgie')

    expect(await remove(member, 'orgie')).toMatchObject({ ok: false, status: 403 })
    expect(await peopleStore.listSeen()).toEqual(new Set(['orgie']))

    expect(await remove(admin, 'orgie')).toMatchObject({ ok: true, data: { removed: true } })
    expect(await peopleStore.listSeen()).toEqual(new Set())
    expect(await remove(admin, 'orgie')).toMatchObject({ ok: true, data: { removed: false } })
  })
})
