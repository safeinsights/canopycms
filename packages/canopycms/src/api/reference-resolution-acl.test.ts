/**
 * A reference target the reader may not read resolves to title + URL tagged `unavailable`,
 * never its data, on every surface that resolves references: the editor's content read, the
 * live-preview resolve endpoint, the request-scoped content reader, and opted-in listings.
 * The fixture uses the real id-suffixed on-disk layout and the real authorization layer.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestServices, defineCanopyTestConfig } from '../config-test'
import { flattenSchema, type PathPermission, type RootCollectionConfig } from '../config'
import { createCheckBranchAccess } from '../authorization'
import { createTestContentAccess, unsafeAsPermissionPath } from '../authorization/test-utils'
import { createContentReader } from '../content-reader'
import { listEntries } from '../content-listing'
import { buildContentTree } from '../content-tree'
import { generateId } from '../id'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { unsafeAsBranchName, unsafeAsLogicalPath, unsafeAsSlug } from '../paths/test-utils'
import type { ContentId, LogicalPath } from '../paths/types'
import type { BranchContext } from '../types'
import type { ApiContext, ApiRequest } from './types'
import { CONTENT_ROUTES } from './content'
import { REFERENCE_OPTIONS_ROUTES } from './reference-options'
import { RESOLVE_REFERENCES_ROUTES } from './resolve-references'

const personSchema = [
  { name: 'heading', type: 'string' as const, isTitle: true },
  { name: 'bio', type: 'string' as const },
  { name: 'secretNote', type: 'string' as const },
]

const pageSchema = [
  { name: 'heading', type: 'string' as const, isTitle: true },
  { name: 'author', type: 'reference' as const, collections: ['people', 'private'] },
  {
    name: 'related',
    type: 'reference' as const,
    collections: ['people', 'private'],
    list: true,
  },
  {
    name: 'sections',
    type: 'block' as const,
    templates: [
      {
        name: 'cta',
        fields: [{ name: 'snippet', type: 'reference' as const, collections: ['private'] }],
      },
    ],
  },
  {
    name: 'meta',
    type: 'object' as const,
    fields: [{ name: 'owner', type: 'reference' as const, collections: ['people'] }],
  },
  {
    name: 'review',
    type: 'group' as const,
    fields: [{ name: 'reviewer', type: 'reference' as const, collections: ['private'] }],
  },
]

const schema: RootCollectionConfig = {
  collections: [
    {
      name: 'pages',
      path: 'pages',
      entries: [{ name: 'page', format: 'json', schema: pageSchema }],
    },
    {
      name: 'people',
      path: 'people',
      entries: [{ name: 'person', format: 'json', schema: personSchema }],
    },
    {
      name: 'private',
      path: 'private',
      entries: [{ name: 'person', format: 'json', schema: personSchema }],
    },
  ],
}

/** Read of `content/private/**` is for the `insiders` group only; everything else is open. */
const rules: PathPermission[] = [
  { path: unsafeAsPermissionPath('content/private/**'), read: { allowedGroups: ['insiders'] } },
]

const SECRETS = ['classified bio', 'launch codes'] as const

const BRANCH = unsafeAsBranchName('main')
const user = (groups: string[] = []): ApiRequest['user'] => ({
  type: 'authenticated',
  userId: 'u1',
  groups,
})

let root: string
let alice: ContentId
let agent: ContentId
let homeFile: string

const writeFixture = async (): Promise<void> => {
  const content = path.join(root, 'content')
  const dirs = {
    pages: path.join(content, `pages.${generateId()}`),
    people: path.join(content, `people.${generateId()}`),
    private: path.join(content, `private.${generateId()}`),
  }
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })

  alice = generateId()
  agent = generateId()
  await fs.writeFile(
    path.join(dirs.people, `person.alice.${alice}.json`),
    JSON.stringify({ heading: 'Alice', bio: 'public bio', secretNote: 'nothing' }),
  )
  await fs.writeFile(
    path.join(dirs.private, `person.agent.${agent}.json`),
    JSON.stringify({ heading: 'Agent X', bio: SECRETS[0], secretNote: SECRETS[1] }),
  )
  const pageData = (heading: string) => ({
    heading,
    author: agent,
    related: [alice, agent],
    sections: [{ template: 'cta', value: { snippet: agent } }],
    meta: { owner: alice },
    reviewer: agent,
  })
  homeFile = path.join(dirs.pages, `page.home.${generateId()}.json`)
  await fs.writeFile(homeFile, JSON.stringify(pageData('Home')))
  await fs.writeFile(
    path.join(dirs.pages, `page.about.${generateId()}.json`),
    JSON.stringify(pageData('About')),
  )
}

/** The exact value a denied reader receives for the private entry: nothing but these keys. */
const restrictedAgent = () => ({
  id: agent,
  slug: 'agent',
  collection: 'content/private',
  urlPath: '/private/agent',
  title: 'Agent X',
  unavailable: true,
  reason: 'restricted',
})

const fullAlice = () => ({
  id: alice,
  slug: 'alice',
  collection: 'content/people',
  urlPath: '/people/alice',
  heading: 'Alice',
  bio: 'public bio',
  secretNote: 'nothing',
})

const fullAgent = () => ({
  id: agent,
  slug: 'agent',
  collection: 'content/private',
  urlPath: '/private/agent',
  heading: 'Agent X',
  bio: SECRETS[0],
  secretNote: SECRETS[1],
})

const config = () =>
  defineCanopyTestConfig({ defaultBranchAccess: 'allow', defaultPathAccess: 'allow', schema })

const createCtx = (): ApiContext => {
  const checkBranchAccess = createCheckBranchAccess('allow')
  const access = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions: vi.fn().mockResolvedValue(rules),
    defaultPathAccess: 'allow',
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve(root),
  })
  return createMockApiContext({
    services: { config: config(), checkBranchAccess, ...access },
    branchContext: {
      ...createMockBranchContext({ branchName: 'main', baseRoot: root, branchRoot: root }),
      flatSchema: flattenSchema(schema, 'content'),
    },
  })
}

const readHome = async (groups: string[] = []) => {
  const res = await CONTENT_ROUTES.read.handler(
    createCtx(),
    { user: user(groups) },
    { branch: BRANCH, path: unsafeAsLogicalPath('content/pages/home') },
  )
  expect(res.status).toBe(200)
  return res.data!
}

/** Every resolved reference in a page's data, by where it sits. */
const referencesIn = (data: Record<string, unknown>) => {
  const sections = data.sections as Array<{ value: Record<string, unknown> }>
  const related = data.related as unknown[]
  return {
    author: data.author,
    relatedAlice: related[0],
    relatedAgent: related[1],
    blockSnippet: sections[0].value.snippet,
    objectOwner: (data.meta as Record<string, unknown>).owner,
    groupReviewer: data.reviewer,
  }
}

const expectDeniedShape = (data: Record<string, unknown>) => {
  const refs = referencesIn(data)
  // Strict equality: the denied value has exactly these keys and no target field.
  expect(refs.author).toStrictEqual(restrictedAgent())
  expect(refs.relatedAgent).toStrictEqual(restrictedAgent())
  expect(refs.blockSnippet).toStrictEqual(restrictedAgent())
  expect(refs.groupReviewer).toStrictEqual(restrictedAgent())
  expect(refs.relatedAlice).toStrictEqual(fullAlice())
  expect(refs.objectOwner).toStrictEqual(fullAlice())
  for (const secret of SECRETS) expect(JSON.stringify(data)).not.toContain(secret)
}

const expectAllowedShape = (data: Record<string, unknown>) => {
  const refs = referencesIn(data)
  expect(refs.author).toStrictEqual(fullAgent())
  expect(refs.relatedAgent).toStrictEqual(fullAgent())
  expect(refs.blockSnippet).toStrictEqual(fullAgent())
  expect(refs.groupReviewer).toStrictEqual(fullAgent())
  expect(refs.relatedAlice).toStrictEqual(fullAlice())
  expect(JSON.stringify(data)).not.toContain('unavailable')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-reference-acl-'))
  await writeFixture()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('reference resolution applies path ACLs to the referenced entry', () => {
  it('lays the fixture out with ids on disk, so a physical-path match could not succeed', async () => {
    const contentDirs = await fs.readdir(path.join(root, 'content'))
    expect(contentDirs.some((d) => /^private\.[1-9A-HJ-NP-Za-km-z]{12}$/.test(d))).toBe(true)
    expect(contentDirs).not.toContain('private')
  })

  describe('the editor content read', () => {
    it('resolves a denied target to title + URL tagged unavailable, at every nesting site', async () => {
      expectDeniedShape((await readHome()).data)
    })

    it('resolves every target in full for a reader the rule admits', async () => {
      expectAllowedShape((await readHome(['insiders'])).data)
    })

    it('leaves every stored reference id intact when a denied editor saves what they read', async () => {
      const read = await readHome()
      const res = await CONTENT_ROUTES.write.handler(
        createCtx(),
        { user: user() },
        { branch: BRANCH, path: unsafeAsLogicalPath('content/pages/home') },
        { format: 'json', data: read.data, expectedVersion: read.version },
      )
      expect(res.status).toBe(200)

      const stored = JSON.parse(await fs.readFile(homeFile, 'utf8'))
      expect(stored.author).toBe(agent)
      expect(stored.related).toEqual([alice, agent])
      expect(stored.sections[0].value.snippet).toBe(agent)
      expect(stored.meta.owner).toBe(alice)
      expect(stored.reviewer).toBe(agent)
    })
  })

  describe('the live-preview resolve endpoint', () => {
    const resolve = (groups: string[] = []) =>
      RESOLVE_REFERENCES_ROUTES.post.handler(
        createCtx(),
        { user: user(groups) },
        { branch: BRANCH },
        { ids: [alice, agent] },
      )

    it('returns the same restricted value read() gives, and the full value for an allowed id', async () => {
      const res = await resolve()
      expect(res.ok).toBe(true)
      expect(res.data?.resolved[agent]).toStrictEqual(restrictedAgent())
      expect(res.data?.resolved[alice]).toStrictEqual(fullAlice())
    })

    it('returns the full value to a reader the rule admits', async () => {
      const res = await resolve(['insiders'])
      expect(res.data?.resolved[agent]).toStrictEqual(fullAgent())
    })
  })

  it('offers no option, and so no title, for an entry the user may not read', async () => {
    const res = await REFERENCE_OPTIONS_ROUTES.get.handler(
      createCtx(),
      { user: user(), query: { collections: 'content/people,content/private' } },
      { branch: BRANCH },
    )
    expect(res.ok).toBe(true)
    const options = res.data?.options ?? []
    expect(options.map((o) => o.id)).toEqual([alice])
    expect(JSON.stringify(options)).not.toContain('Agent X')
  })

  describe('the request-scoped content reader (read / readByUrlPath)', () => {
    const readAs = async (groups: string[]) => {
      await fs.writeFile(
        path.join(root, 'permissions.json'),
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          updatedBy: 'tester',
          pathPermissions: rules,
        }),
      )
      const now = new Date().toISOString()
      const branchContext: BranchContext = {
        baseRoot: root,
        branchRoot: root,
        branch: {
          name: 'main',
          status: 'editing',
          access: {},
          createdBy: 'tester',
          createdAt: now,
          updatedAt: now,
        },
      }
      const reader = createContentReader({
        services: await createTestServices(
          { defaultBranchAccess: 'allow', defaultPathAccess: 'allow', schema },
          { getSettingsBranchRoot: () => Promise.resolve(root) },
        ),
        allowCreateBranch: false,
        getBranchContext: async (branch) => (branch === 'main' ? branchContext : null),
      })
      const result = await reader.read<Record<string, unknown>>({
        entryPath: unsafeAsLogicalPath('content/pages'),
        slug: unsafeAsSlug('home'),
        branch: 'main',
        user: user(groups),
      })
      return result.data
    }

    it('restricts a denied target', async () => {
      expectDeniedShape(await readAs([]))
    })

    it('resolves in full for a reader the rule admits', async () => {
      expectAllowedShape(await readAs(['insiders']))
    })
  })

  describe('opted-in listings', () => {
    const flatSchema = () => flattenSchema(schema, 'content')
    /** The visibility predicate context.ts builds for a reader outside `insiders`. */
    const denyPrivate = {
      shouldInclude: (logicalPath: LogicalPath) => !logicalPath.startsWith('content/private/'),
    }

    it('listEntries restricts a denied target in every referencing entry sharing the cache', async () => {
      const entries = await listEntries(
        root,
        flatSchema(),
        'content',
        { rootPath: 'content/pages', resolveReferences: true },
        denyPrivate,
      )
      expect(entries.map((e) => e.slug).sort()).toEqual(['about', 'home'])
      for (const entry of entries) expectDeniedShape(entry.data)
    })

    it('listEntries without a predicate resolves in full', async () => {
      const entries = await listEntries(root, flatSchema(), 'content', {
        rootPath: 'content/pages',
        resolveReferences: true,
      })
      for (const entry of entries) expectAllowedShape(entry.data)
    })

    it('buildContentTree restricts a denied target', async () => {
      const tree = await buildContentTree(
        root,
        flatSchema(),
        'content',
        { rootPath: 'content/pages', resolveReferences: true },
        denyPrivate,
      )
      const pages = tree.filter((node) => node.kind === 'entry')
      expect(pages).toHaveLength(2)
      for (const page of pages) expectDeniedShape(page.entry!.data)
    })
  })
})
