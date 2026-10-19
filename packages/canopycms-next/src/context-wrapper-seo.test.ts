import { describe, expect, it, vi } from 'vitest'
import type { CanopyConfig } from 'canopycms'
import type { AuthPlugin } from 'canopycms/auth'
import type { ListEntriesItem } from 'canopycms/server'

// React's cache() is a server-components API not available in the node test environment;
// identity is equivalent for these tests (no per-request scoping). Same pattern as
// context-wrapper-auth.test.ts.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, cache: <T>(fn: T): T => fn }
})

/** One fake routable entry, shaped like listEntries's return for a 'page' entry type. */
const hiddenEntry = {
  urlPath: '/hidden',
  slug: 'hidden' as never,
  entryType: 'page',
  entryPath: 'content/pages/hidden' as never,
  entryId: 'abc' as never,
  collectionPath: 'content/pages' as never,
  format: 'json' as const,
  data: { seo: { noindex: true, metaTitle: 'Hidden page' } },
} satisfies Partial<ListEntriesItem>

// Mock service/context creation so createNextCanopyContext can run without a real
// workspace/filesystem, and so generateContentSitemap's getCanopyForBuild() resolves a fake
// listEntries instead of touching the branch/schema machinery. Both bound helpers read
// `config.seo` from the options, not from these services.
vi.mock('canopycms/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('canopycms/server')>()
  return {
    ...actual,
    createCanopyServices: vi.fn(async (config: CanopyConfig) => ({
      config,
      bootstrapAdminIds: new Set<string>(),
      refreshActiveBranch: vi.fn(),
      resolvePendingBaseBranch: vi.fn(),
    })),
    startDevContentWatcher: vi.fn(),
    createCanopyContext: vi.fn(() => ({
      getContext: async () => ({
        buildContentTree: async () => [],
        listEntries: async () => [hiddenEntry] as unknown as ListEntriesItem[],
        read: async () => ({ data: undefined, path: '' }),
        readByUrlPath: async () => null,
        services: {},
      }),
    })),
  }
})

import { createNextCanopyContext } from './context-wrapper'
import { mergeSeoFieldLocation } from './static'

function config(partial: Partial<CanopyConfig>): CanopyConfig {
  return { mode: 'dev', deployedAs: 'server', ...partial } as CanopyConfig
}

const authPlugin: AuthPlugin = {
  authenticate: async () => ({ success: false, error: 'not used' }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
}

// ---------------------------------------------------------------------------
// mergeSeoFieldLocation — how both helpers combine `config.seo` with a per-call override.
// ---------------------------------------------------------------------------
describe('mergeSeoFieldLocation', () => {
  it('falls through to config.seo when the caller supplies nothing', () => {
    expect(mergeSeoFieldLocation({ group: 'seo' }, undefined)).toEqual({ group: 'seo' })
  })

  it('lets an explicit per-call value override the default', () => {
    expect(mergeSeoFieldLocation({ group: 'seo' }, { group: 'meta' })).toEqual({ group: 'meta' })
  })

  it('merges fields and group independently', () => {
    expect(
      mergeSeoFieldLocation({ group: 'seo', fields: { title: 'metaTitle' } }, { group: 'meta' }),
    ).toEqual({ group: 'meta', fields: { title: 'metaTitle' } })
  })

  it('merges fields name by name, so a per-call rename keeps the configured noindex name', () => {
    expect(
      mergeSeoFieldLocation({ fields: { noindex: 'hidden' } }, { fields: { title: 'headline' } }),
    ).toEqual({ fields: { noindex: 'hidden', title: 'headline' } })
  })

  it('returns an empty location when neither side sets one', () => {
    expect(mergeSeoFieldLocation(undefined, undefined)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// generateContentSitemap and entryToMetadata, as returned from createNextCanopyContext, both
// read config.seo by default.
// ---------------------------------------------------------------------------
describe('createNextCanopyContext: config.seo', () => {
  it('entryToMetadata applies config.seo.group without the caller passing it', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'dev', seo: { group: 'seo' } }),
      authPlugin,
      entrySchemaRegistry: {},
    })

    const metadata = result.entryToMetadata(hiddenEntry.data, { path: '/hidden' })

    expect(metadata.title).toBe('Hidden page')
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })

  it('generateContentSitemap applies the same config.seo.group, excluding the noindex entry', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'dev', seo: { group: 'seo' } }),
      authPlugin,
      entrySchemaRegistry: {},
    })

    const sitemap = await result.generateContentSitemap({ siteUrl: 'https://example.com' })

    // The hidden entry is noindex under config.seo's group, so it is left out here exactly as
    // entryToMetadata suppressed its robots above.
    expect(sitemap.map((u) => u.url)).toEqual([])
  })

  it('a per-call seo override still wins over config.seo', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'dev', seo: { group: 'seo' } }),
      authPlugin,
      entrySchemaRegistry: {},
    })

    // A group that doesn't match the entry's nesting hides the flag for this one call.
    const sitemap = await result.generateContentSitemap({
      siteUrl: 'https://example.com',
      seo: { group: 'somethingElse' },
    })

    expect(sitemap.map((u) => u.url)).toEqual(['https://example.com/hidden'])
  })

  it('a per-call entryToMetadata group still wins over config.seo', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'dev', seo: { group: 'seo' } }),
      authPlugin,
      entrySchemaRegistry: {},
    })

    const metadata = result.entryToMetadata(hiddenEntry.data, { group: 'somethingElse' })

    expect(metadata.robots).toBeUndefined()
  })

  it('without config.seo, both helpers agree the flat/inline convention is invisible for a nested entry', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'dev' }),
      authPlugin,
      entrySchemaRegistry: {},
    })

    const metadata = result.entryToMetadata(hiddenEntry.data, { path: '/hidden' })
    const sitemap = await result.generateContentSitemap({ siteUrl: 'https://example.com' })

    // Same (lack of) default reaches both — neither suppresses the nested-group entry, so there is
    // no drift between the two surfaces even when nothing is configured.
    expect(metadata.robots).toBeUndefined()
    expect(sitemap.map((u) => u.url)).toEqual(['https://example.com/hidden'])
  })
})
