import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FieldConfig, FlatSchemaItem } from '../config'
import type { ListEntriesResponse } from '../api/entries'
import type { EditorEntry } from './Editor'
import {
  buildEntriesFromListResponse,
  buildPreviewSrc,
  buildWritePayload,
  normalizeContentPayload,
  buildCollectionLabels,
  buildBreadcrumbSegments,
  calculatePathToEntry,
} from './editor-utils'
import type { EditorCollection } from './Editor'
import type { TreeNodeData } from '@mantine/core'
import {
  unsafeAsLogicalPath,
  unsafeAsPhysicalPath,
  unsafeAsContentId,
  unsafeAsSlug,
} from '../paths/test-utils'

describe('buildPreviewSrc', () => {
  it('returns the provided preview without modification', () => {
    const result = buildPreviewSrc(
      { previewSrc: '/custom-preview', itemType: 'entry' },
      {
        branchName: 'feature/test',
        previewBaseByCollection: { posts: '/posts' },
      },
    )
    expect(result).toBe('/custom-preview')
  })

  it('applies preview base and branch for entries', () => {
    const result = buildPreviewSrc(
      { collectionPath: 'home', collectionName: 'home', itemType: 'entry' },
      {
        branchName: 'feature/nested',
        previewBaseByCollection: { home: '/preview/' },
      },
    )
    expect(result).toBe('/preview?branch=feature%2Fnested')
  })

  it('falls back to slug-based URLs and encodes branch parameters', () => {
    const result = buildPreviewSrc(
      { slug: 'nested path/post', itemType: 'entry' },
      { branchName: 'feature-1', previewBaseByCollection: undefined },
    )
    expect(result).toBe('/nested%20path/post?branch=feature-1')
  })

  it('includes collection path when building preview URL without base', () => {
    const result = buildPreviewSrc(
      { collectionPath: 'content/docs', slug: 'overview', itemType: 'entry' },
      { branchName: 'main', previewBaseByCollection: undefined },
    )
    expect(result).toBe('/docs/overview?branch=main')
  })

  it('handles nested collection paths correctly', () => {
    const result = buildPreviewSrc(
      { collectionPath: 'content/docs/api', slug: 'intro', itemType: 'entry' },
      { branchName: 'main', previewBaseByCollection: undefined },
    )
    expect(result).toBe('/docs/api/intro?branch=main')
  })

  it('handles root-level collections', () => {
    const result = buildPreviewSrc(
      { collectionPath: 'content/posts', slug: 'my-post', itemType: 'entry' },
      { branchName: 'main', previewBaseByCollection: undefined },
    )
    expect(result).toBe('/posts/my-post?branch=main')
  })

  // An index entry's URL is its COLLECTION's path. This is the same collapse `computeEntryUrl`,
  // `listEntries` and `defaultBuildPath` apply, and `resolveUrlPathCandidates` deliberately
  // refuses to resolve `/x/index` — so a preview URL built by naively joining collection + slug
  // points the iframe at a URL the host app answers with notFound().
  describe('index entries collapse to their collection path', () => {
    it('collapses an index slug when building from the collection path', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'content/docs/guides', slug: 'index', itemType: 'entry' },
        { branchName: 'main', previewBaseByCollection: undefined },
      )
      expect(result).toBe('/docs/guides?branch=main')
    })

    it('collapses an index slug under a configured preview base', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'content/docs', slug: 'index', itemType: 'entry' },
        {
          branchName: 'main',
          previewBaseByCollection: { 'content/docs': '/preview/docs' },
        },
      )
      expect(result).toBe('/preview/docs?branch=main')
    })

    it('leaves a non-index slug alone', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'content/docs/guides', slug: 'indexing', itemType: 'entry' },
        { branchName: 'main', previewBaseByCollection: undefined },
      )
      expect(result).toBe('/docs/guides/indexing?branch=main')
    })
  })

  describe("routes from the entry's own urlPath", () => {
    const route = (
      entry: Parameters<typeof buildPreviewSrc>[0],
      context: Partial<Parameters<typeof buildPreviewSrc>[1]> = {},
    ) =>
      buildPreviewSrc(entry, {
        branchName: 'main',
        contentRoot: 'content',
        trailingSlash: true,
        previewPrefix: '/edit/preview',
        ...context,
      })

    it('previews a root entry at its own path, not the site root', () => {
      expect(route({ collectionPath: 'content', collectionName: 'content', slug: 'about' })).toBe(
        '/edit/preview/about/?branch=main',
      )
    })

    it('previews a root index entry at the site root', () => {
      expect(route({ collectionPath: 'content', slug: 'index' })).toBe('/edit/preview/?branch=main')
    })

    it('collapses a nested index entry onto its collection', () => {
      expect(route({ collectionPath: 'content/docs/guides', slug: 'index' })).toBe(
        '/edit/preview/docs/guides/?branch=main',
      )
    })

    it('previews a root entry under a multi-segment contentRoot', () => {
      expect(
        route({ collectionPath: 'cms/content', slug: 'about' }, { contentRoot: 'cms/content' }),
      ).toBe('/edit/preview/about/?branch=main')
      expect(
        route({ collectionPath: 'cms/content', slug: 'index' }, { contentRoot: '/cms/content/' }),
      ).toBe('/edit/preview/?branch=main')
      expect(
        route({ collectionPath: 'cms/content/docs', slug: 'a' }, { contentRoot: '/cms/content/' }),
      ).toBe('/edit/preview/docs/a/?branch=main')
    })

    it('lowercases the route the way listEntries publishes urlPath', () => {
      expect(route({ collectionPath: 'content', slug: 'About' })).toBe(
        '/edit/preview/about/?branch=main',
      )
    })

    it('lets an entry key win over its collection key, used as-is', () => {
      const bases = { 'content/about': '/about-us', content: '/site' }
      expect(
        route({ collectionPath: 'content', slug: 'about' }, { previewBaseByCollection: bases }),
      ).toBe('/edit/preview/about-us/?branch=main')
      expect(
        route({ collectionPath: 'content', slug: 'team' }, { previewBaseByCollection: bases }),
      ).toBe('/edit/preview/site/team/?branch=main')
    })

    // `<parent>/<name>` names both a landing entry and its same-named sibling collection.
    it('reads a key below the root as a collection key only', () => {
      const bases = { 'content/docs/guides': '/tutorials' }
      expect(
        route(
          { collectionPath: 'content/docs', slug: 'guides' },
          { previewBaseByCollection: bases },
        ),
      ).toBe('/edit/preview/docs/guides/?branch=main')
      expect(
        route(
          { collectionPath: 'content/docs/guides', slug: 'install' },
          { previewBaseByCollection: bases },
        ),
      ).toBe('/edit/preview/tutorials/install/?branch=main')
      expect(
        route(
          { collectionPath: 'content/docs', slug: 'guides' },
          { previewBaseByCollection: { 'content/docs/guides': false } },
        ),
      ).toBe('/edit/preview/docs/guides/?branch=main')
    })

    it('routes a root landing entry and its same-named collection by one key', () => {
      const bases = { 'content/posts': '/blog' }
      expect(
        route({ collectionPath: 'content', slug: 'posts' }, { previewBaseByCollection: bases }),
      ).toBe('/edit/preview/blog/?branch=main')
      expect(
        route({ collectionPath: 'content/posts', slug: 'a' }, { previewBaseByCollection: bases }),
      ).toBe('/edit/preview/blog/a/?branch=main')
    })

    it('treats an empty value as no key, so it never frames the site root', () => {
      expect(
        route(
          { collectionPath: 'content', collectionName: 'site', slug: 'about' },
          { previewBaseByCollection: { 'content/about': '', site: '/pages' } },
        ),
      ).toBe('/edit/preview/pages/about/?branch=main')
      expect(
        route(
          { collectionPath: 'content/posts', collectionName: 'posts', slug: 'hello' },
          { previewBaseByCollection: { 'content/posts': '', posts: '/blog' } },
        ),
      ).toBe('/edit/preview/blog/hello/?branch=main')
    })

    it('lets a collection-path false win over a collection-name route', () => {
      expect(
        route(
          { collectionPath: 'content/posts', collectionName: 'posts', slug: 'hello' },
          { previewBaseByCollection: { 'content/posts': false, posts: '/blog' } },
        ),
      ).toBeUndefined()
    })

    it('percent-encodes default-route segments under a basePath', () => {
      expect(
        route({ collectionPath: 'content/docs/api', slug: 'café notes' }, { basePath: '/base' }),
      ).toBe('/base/edit/preview/docs/api/caf%C3%A9%20notes/?branch=main')
    })

    it('lets a collection-name key apply when no path key matches', () => {
      expect(
        route(
          { collectionPath: 'content/posts', collectionName: 'posts', slug: 'hello' },
          { previewBaseByCollection: { posts: '/articles' } },
        ),
      ).toBe('/edit/preview/articles/hello/?branch=main')
    })

    it('ignores keys inherited from Object.prototype', () => {
      expect(
        route(
          { collectionPath: 'content/constructor', collectionName: 'constructor', slug: 'a' },
          { previewBaseByCollection: {} },
        ),
      ).toBe('/edit/preview/constructor/a/?branch=main')
    })
  })

  describe('an entry with no page', () => {
    it.each([
      ['an entry key', { 'content/settings': false as const }],
      ['a collection path key', { content: false as const }],
      ['a collection name key', { site: false as const }],
    ])('has no preview src when %s is false', (_label, previewBaseByCollection) => {
      expect(
        buildPreviewSrc(
          { collectionPath: 'content', collectionName: 'site', slug: 'settings' },
          {
            branchName: 'main',
            contentRoot: 'content',
            previewPrefix: '/preview',
            previewBaseByCollection,
          },
        ),
      ).toBeUndefined()
    })

    it('still previews a sibling whose own key is a route', () => {
      expect(
        buildPreviewSrc(
          { collectionPath: 'content', slug: 'about' },
          {
            branchName: 'main',
            contentRoot: 'content',
            previewBaseByCollection: { content: false, 'content/about': '/about' },
            trailingSlash: false,
          },
        ),
      ).toBe('/about?branch=main')
    })
  })

  describe('with a configured contentRoot', () => {
    it('strips the whole multi-segment prefix from a collection entry URL', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'cms/content/posts', slug: 'hello', itemType: 'entry' },
        {
          branchName: 'main',
          previewBaseByCollection: undefined,
          contentRoot: 'cms/content',
        },
      )
      // Without the configured root nothing is stripped: /cms/content/posts/hello.
      expect(result).toBe('/posts/hello?branch=main')
    })

    it('leaves the default single-segment root behavior unchanged when contentRoot is undefined', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'content/docs', slug: 'overview', itemType: 'entry' },
        { branchName: 'main', previewBaseByCollection: undefined },
      )
      expect(result).toBe('/docs/overview?branch=main')
    })

    it('previews a root index entry at the site root for a multi-segment contentRoot', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'cms/content', slug: 'index', itemType: 'entry' },
        {
          branchName: 'main',
          previewBaseByCollection: undefined,
          contentRoot: 'cms/content',
        },
      )
      expect(result).toBe('/?branch=main')
    })

    it('uses a custom preview URL for a root entry under a multi-segment contentRoot', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'cms/content', slug: 'about', itemType: 'entry' },
        {
          branchName: 'main',
          previewBaseByCollection: { 'cms/content/about': '/custom-about' },
          contentRoot: 'cms/content',
        },
      )
      expect(result).toBe('/custom-about?branch=main')
    })
  })

  describe('with a basePath (deployment under a Next.js basePath)', () => {
    it('prefixes the default collection/slug URL', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'content/docs', slug: 'overview', itemType: 'entry' },
        { branchName: 'main', previewBaseByCollection: undefined, basePath: '/preview-123' },
      )
      expect(result).toBe('/preview-123/docs/overview?branch=main')
    })

    it('prefixes the root index path', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'content', slug: 'index', itemType: 'entry' },
        {
          branchName: 'main',
          previewBaseByCollection: undefined,
          contentRoot: 'content',
          basePath: '/preview-123',
        },
      )
      // Next redirects `<basePath>/` to the bare `<basePath>` when `trailingSlash` is off.
      expect(result).toBe('/preview-123?branch=main')
    })

    it('prefixes a previewBaseByCollection override -- the collection escape hatch still applies, basePath still wraps it', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'content/docs', slug: 'index', itemType: 'entry' },
        {
          branchName: 'main',
          previewBaseByCollection: { 'content/docs': '/preview/docs' },
          basePath: '/preview-123',
        },
      )
      expect(result).toBe('/preview-123/preview/docs?branch=main')
    })

    it('is a no-op when basePath is unset (regression guard)', () => {
      const result = buildPreviewSrc(
        { collectionPath: 'content/docs', slug: 'overview', itemType: 'entry' },
        { branchName: 'main', previewBaseByCollection: undefined },
      )
      expect(result).toBe('/docs/overview?branch=main')
    })

    it('matches what resolvePreviewPath would compute from a basePath-prefixed window.location', () => {
      // preview-bridge.tsx's resolvePreviewPath falls back to
      // `${window.location.pathname}${window.location.search}` -- and Next.js does NOT strip
      // `basePath` from the raw browser URL, so the served page's location.pathname literally
      // includes it. The two independently-derived strings must match exactly, or draft sync
      // and click-to-focus silently stop working (see usePreviewData's path check).
      const src = buildPreviewSrc(
        { collectionPath: 'content/docs', slug: 'overview', itemType: 'entry' },
        { branchName: 'main', previewBaseByCollection: undefined, basePath: '/preview-123' },
      )
      const windowLocation = {
        pathname: '/preview-123/docs/overview',
        search: '?branch=main',
      }
      const resolvedFromWindow = `${windowLocation.pathname}${windowLocation.search}`
      expect(src).toBe(resolvedFromWindow)
    })
  })

  describe('with a previewPrefix', () => {
    const prefixed = (
      entry: Parameters<typeof buildPreviewSrc>[0],
      context: Partial<Parameters<typeof buildPreviewSrc>[1]> = {},
    ) =>
      buildPreviewSrc(entry, {
        branchName: 'main',
        contentRoot: 'content',
        previewPrefix: '/preview',
        ...context,
      })

    it.each([
      ['content/posts', 'hello', '/preview/posts/hello?branch=main'],
      ['content/docs', 'overview', '/preview/docs/overview?branch=main'],
      ['content/docs/api', 'intro', '/preview/docs/api/intro?branch=main'],
      ['content/docs/guides', 'index', '/preview/docs/guides?branch=main'],
      ['content/new-collection', 'first', '/preview/new-collection/first?branch=main'],
    ])(
      'prefixes every collection with no per-collection key: %s/%s',
      (collectionPath, slug, expected) => {
        expect(prefixed({ collectionPath, slug })).toBe(expected)
      },
    )

    it('prefixes a root entry and the root index', () => {
      expect(prefixed({ collectionPath: 'content', slug: 'about' })).toBe(
        '/preview/about?branch=main',
      )
      expect(prefixed({ collectionPath: 'content', slug: 'index' })).toBe('/preview?branch=main')
    })

    it("prefixes a root entry's previewBase route", () => {
      expect(
        prefixed(
          { collectionPath: 'content', slug: 'about' },
          { previewBaseByCollection: { 'content/about': '/about-us' } },
        ),
      ).toBe('/preview/about-us?branch=main')
    })

    it('prefixes a site-relative previewBase route, which wins over the collection path', () => {
      expect(
        prefixed(
          { collectionPath: 'content/posts', collectionName: 'posts', slug: 'hello' },
          { previewBaseByCollection: { 'content/posts': '/blog' } },
        ),
      ).toBe('/preview/blog/hello?branch=main')
      expect(
        prefixed(
          { collectionPath: 'content/posts', collectionName: 'posts', slug: 'hello' },
          { previewBaseByCollection: { posts: '/articles' } },
        ),
      ).toBe('/preview/articles/hello?branch=main')
    })

    it('leaves an absolute previewBase alone, prefix, basePath and trailing slash included', () => {
      const absolute = (trailingSlash: boolean, base: string, collectionPath = 'content/posts') =>
        prefixed(
          { collectionPath, slug: 'hello' },
          {
            previewBaseByCollection: { [collectionPath]: base, 'content/hello': base },
            basePath: '/base',
            trailingSlash,
          },
        )
      expect(absolute(false, 'https://other.example.com/blog')).toBe(
        'https://other.example.com/blog/hello?branch=main',
      )
      expect(absolute(true, 'https://other.example.com/blog')).toBe(
        'https://other.example.com/blog/hello?branch=main',
      )
      expect(absolute(false, 'https://other.example.com/about/', 'content')).toBe(
        'https://other.example.com/about/?branch=main',
      )
      expect(
        prefixed(
          { collectionPath: 'content/docs', slug: 'index' },
          {
            previewBaseByCollection: { 'content/docs': 'https://other.example.com/docs/' },
            trailingSlash: true,
          },
        ),
      ).toBe('https://other.example.com/docs/?branch=main')
    })

    it('neutralizes a previewBase that only reads as same-origin, then prefixes it', () => {
      expect(
        prefixed(
          { collectionPath: 'content/posts', slug: 'hello' },
          { previewBaseByCollection: { 'content/posts': '/\\evil.example.com/x' } },
        ),
      ).toBe('/preview/x/hello?branch=main')
    })

    it('puts the basePath in front of the prefix', () => {
      expect(prefixed({ collectionPath: 'content/docs', slug: 'a' }, { basePath: '/base' })).toBe(
        '/base/preview/docs/a?branch=main',
      )
    })

    it('uses an absolute prefix as the origin, without the basePath', () => {
      expect(
        prefixed(
          { collectionPath: 'content/docs', slug: 'a' },
          { previewPrefix: 'https://cms.example.com/preview', basePath: '/base' },
        ),
      ).toBe('https://cms.example.com/preview/docs/a?branch=main')
    })

    it("does not prefix an entry's own previewSrc", () => {
      expect(prefixed({ previewSrc: '/custom', collectionPath: 'content/docs', slug: 'a' })).toBe(
        '/custom',
      )
    })

    it('tolerates a trailing slash on the prefix', () => {
      expect(
        prefixed({ collectionPath: 'content/docs', slug: 'a' }, { previewPrefix: '/preview/' }),
      ).toBe('/preview/docs/a?branch=main')
    })
  })

  describe('trailing slash', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    const slashed = (
      entry: Parameters<typeof buildPreviewSrc>[0],
      context: Partial<Parameters<typeof buildPreviewSrc>[1]> = {},
    ) =>
      buildPreviewSrc(entry, {
        branchName: 'main',
        contentRoot: 'content',
        trailingSlash: true,
        ...context,
      })

    it('slashes a collection entry ahead of the query', () => {
      expect(slashed({ collectionPath: 'content/docs', slug: 'overview' })).toBe(
        '/docs/overview/?branch=main',
      )
    })

    it('slashes the root index, a basePath root and a prefix root', () => {
      expect(slashed({ collectionPath: 'content', slug: 'index' })).toBe('/?branch=main')
      expect(slashed({ collectionPath: 'content', slug: 'index' }, { basePath: '/base' })).toBe(
        '/base/?branch=main',
      )
      expect(
        slashed({ collectionPath: 'content', slug: 'index' }, { previewPrefix: '/preview' }),
      ).toBe('/preview/?branch=main')
    })

    it('slashes an absolute prefix', () => {
      expect(
        slashed(
          { collectionPath: 'content/docs', slug: 'a' },
          { previewPrefix: 'https://cms.example.com/preview' },
        ),
      ).toBe('https://cms.example.com/preview/docs/a/?branch=main')
    })

    it('leaves a file-like last segment unslashed, as Next does', () => {
      expect(slashed({ collectionPath: 'content/docs', slug: 'v1.2' })).toBe(
        '/docs/v1.2?branch=main',
      )
    })

    it('keeps a previewBase query and appends the slug and branch around it', () => {
      expect(
        slashed(
          { collectionPath: 'content/posts', slug: 'hello' },
          { previewBaseByCollection: { 'content/posts': '/blog?lang=en' } },
        ),
      ).toBe('/blog/hello/?lang=en&branch=main')
      expect(
        buildPreviewSrc(
          { collectionPath: 'content/posts', slug: 'hello' },
          {
            branchName: 'main',
            previewBaseByCollection: { 'content/posts': '/blog/?lang=en' },
            trailingSlash: false,
          },
        ),
      ).toBe('/blog/hello?lang=en&branch=main')
    })

    it('puts the branch ahead of a previewBase fragment', () => {
      expect(
        slashed(
          { collectionPath: 'content/posts', slug: 'hello' },
          { previewBaseByCollection: { 'content/posts': '/blog#top' } },
        ),
      ).toBe('/blog/hello/?branch=main#top')
    })

    it("does not touch an entry's own previewSrc", () => {
      expect(slashed({ previewSrc: '/custom' })).toBe('/custom')
    })

    it('drops a trailing slash when off', () => {
      expect(
        buildPreviewSrc(
          { collectionPath: 'content', slug: 'index' },
          {
            branchName: 'main',
            contentRoot: 'content',
            previewPrefix: '/preview/',
            trailingSlash: false,
          },
        ),
      ).toBe('/preview?branch=main')
    })

    it('defaults to the build-time CANOPY_TRAILING_SLASH value', () => {
      const entry = { collectionPath: 'content/docs', slug: 'overview' }
      vi.stubEnv('CANOPY_TRAILING_SLASH', 'true')
      expect(buildPreviewSrc(entry, { branchName: 'main' })).toBe('/docs/overview/?branch=main')
      expect(buildPreviewSrc(entry, { branchName: 'main', trailingSlash: false })).toBe(
        '/docs/overview?branch=main',
      )
      vi.stubEnv('CANOPY_TRAILING_SLASH', undefined)
      expect(buildPreviewSrc(entry, { branchName: 'main' })).toBe('/docs/overview?branch=main')
    })
  })
})

describe('normalizeContentPayload', () => {
  it('unwraps data payloads', () => {
    expect(normalizeContentPayload({ data: { title: 'Hello' } })).toEqual({
      title: 'Hello',
    })
  })

  it('includes body from top-level format/data/body payload', () => {
    expect(
      normalizeContentPayload({
        format: 'mdx',
        data: { title: 'Post' },
        body: 'Body content',
      }),
    ).toEqual({ title: 'Post', body: 'Body content' })
  })

  it('handles nested payloads containing format/data/body', () => {
    expect(
      normalizeContentPayload({
        data: { format: 'md', data: { title: 'Post' }, body: 123 },
      }),
    ).toEqual({ title: 'Post', body: '' })
  })

  it('preserves json payloads without injecting a body', () => {
    expect(
      normalizeContentPayload({
        format: 'json',
        data: { title: 'JSON Post' },
        body: 'ignored',
      }),
    ).toEqual({ title: 'JSON Post' })
  })
})

describe('buildWritePayload', () => {
  it('returns the original value when entry data is incomplete', () => {
    const value = { title: 'Draft' }
    expect(buildWritePayload({}, value)).toBe(value)
  })

  it('formats json payloads', () => {
    expect(
      buildWritePayload(
        { collectionPath: 'posts', slug: 'hello', format: 'json' },
        { title: 'Hi' },
      ),
    ).toEqual({
      format: 'json',
      data: { title: 'Hi' },
    })
  })

  it('formats markdown-like payloads and splits body from data', () => {
    expect(
      buildWritePayload(
        { collectionPath: 'posts', slug: 'hello', format: 'mdx' },
        { title: 'Hi', body: 'Copy' },
      ),
    ).toEqual({
      format: 'mdx',
      data: { title: 'Hi' },
      body: 'Copy',
    })

    expect(
      buildWritePayload(
        { collectionPath: 'posts', slug: 'hello', format: 'md' },
        { title: 'Hi', body: 42 },
      ),
    ).toEqual({
      format: 'md',
      data: { title: 'Hi' },
      body: '',
    })
  })
})

describe('buildEntriesFromListResponse', () => {
  const postsSchema: FieldConfig[] = [{ name: 'title', type: 'string' }]
  const pagesSchema: FieldConfig[] = [{ name: 'body', type: 'mdx' }]

  const flatSchema: FlatSchemaItem[] = [
    {
      type: 'entry-type',
      logicalPath: unsafeAsLogicalPath('posts/post'),
      name: 'post',
      parentPath: unsafeAsLogicalPath('posts'),
      format: 'mdx',
      schema: postsSchema,
    },
    {
      type: 'entry-type',
      logicalPath: unsafeAsLogicalPath('pages/page'),
      name: 'page',
      parentPath: unsafeAsLogicalPath('pages'),
      format: 'json',
      schema: pagesSchema,
    },
  ]

  const response: ListEntriesResponse = {
    entries: [
      {
        logicalPath: unsafeAsLogicalPath('posts/hello'),
        contentId: unsafeAsContentId('ghi789RST345'),
        slug: unsafeAsSlug('hello world'),
        collectionPath: unsafeAsLogicalPath('posts'),
        collectionName: 'Posts',
        format: 'mdx',
        entryType: 'post',
        physicalPath: unsafeAsPhysicalPath('content/posts/hello-world'),
        title: 'Hello Title',
        exists: true,
      },
      {
        logicalPath: unsafeAsLogicalPath('pages/home'),
        contentId: unsafeAsContentId('jkl012MNO678'),
        slug: unsafeAsSlug('home'),
        collectionPath: unsafeAsLogicalPath('pages'),
        collectionName: 'Pages',
        format: 'json',
        entryType: 'page',
        physicalPath: unsafeAsPhysicalPath('content/pages/home.json'),
        exists: false,
      },
    ],
    pagination: { hasMore: false, limit: 50 },
  }

  it('maps entries with schema, status, and preview src', () => {
    const resolvePreviewSrc = vi.fn(
      (entry: {
        collectionPath?: string
        collectionName?: string
        slug?: string
        entryType?: string
      }) => `preview-${entry.slug ?? 'home'}`,
    )
    const result = buildEntriesFromListResponse({
      response,
      resolvePreviewSrc,
      flatSchema,
    })

    expect(result).toHaveLength(2)

    const post = result.find((item) => item.collectionPath === 'posts')
    expect(post?.label).toBe('Hello Title')
    expect(post?.schema).toEqual(postsSchema)
    expect(post?.status).toBe('post')
    expect(post?.previewSrc).toBe('preview-hello world')

    const page = result.find((item) => item.collectionPath === 'pages')
    expect(page?.schema).toEqual(pagesSchema)
    expect(page?.status).toBe('missing')
    expect(page?.slug).toBe('home')

    expect(resolvePreviewSrc).toHaveBeenCalledTimes(2)
  })

  it('resolves schema from flatSchema by matching parentPath and entryType', () => {
    const result = buildEntriesFromListResponse({
      response,
      resolvePreviewSrc: () => 'preview',
      flatSchema,
    })

    const page = result.find((item) => item.collectionPath === 'pages')
    expect(page?.schema).toEqual(pagesSchema)

    const post = result.find((item) => item.collectionPath === 'posts')
    expect(post?.schema).toEqual(postsSchema)
  })

  it('returns empty schema when entry type not in flatSchema', () => {
    const result = buildEntriesFromListResponse({
      response: {
        entries: [
          {
            logicalPath: unsafeAsLogicalPath('posts/unknown'),
            contentId: unsafeAsContentId('abc123def456'),
            slug: unsafeAsSlug('unknown'),
            collectionPath: unsafeAsLogicalPath('posts'),
            collectionName: 'Posts',
            format: 'mdx',
            entryType: 'unknown-type',
            physicalPath: unsafeAsPhysicalPath('content/posts/unknown'),
            exists: true,
          },
        ],
        pagination: { hasMore: false, limit: 50 },
      },
      resolvePreviewSrc: () => '',
      flatSchema,
    })

    expect(result[0].schema).toEqual([])
  })

  it('returns empty schema when entry missing entryType', () => {
    const result = buildEntriesFromListResponse({
      response: {
        entries: [
          {
            logicalPath: unsafeAsLogicalPath('posts/no-type'),
            contentId: 'abc123def456',
            slug: 'no-type',
            collectionPath: 'posts',
            collectionName: 'Posts',
            format: 'mdx',
            physicalPath: unsafeAsPhysicalPath('content/posts/no-type'),
            exists: true,
          } as any, // Type assertion needed to test missing entryType
        ],
        pagination: { hasMore: false, limit: 50 },
      },
      resolvePreviewSrc: () => '',
      flatSchema,
    })

    expect(result[0].schema).toEqual([])
  })
})

describe('buildCollectionLabels', () => {
  it('returns empty map when no collections provided', () => {
    expect(buildCollectionLabels(undefined)).toEqual(new Map())
    expect(buildCollectionLabels([])).toEqual(new Map())
  })

  it('builds flat map of collection IDs to labels', () => {
    const collections: EditorCollection[] = [
      {
        path: unsafeAsLogicalPath('posts'),
        name: 'posts',
        label: 'Posts',
        type: 'collection',
        format: 'mdx',
      },
      {
        path: unsafeAsLogicalPath('pages'),
        name: 'pages',
        type: 'collection',
        format: 'mdx',
      },
    ]

    const result = buildCollectionLabels(collections)

    expect(result.get('posts')).toBe('Posts')
    expect(result.get('pages')).toBe('pages') // Falls back to name when label is missing
  })

  it('handles nested collections', () => {
    const collections: EditorCollection[] = [
      {
        path: unsafeAsLogicalPath('content'),
        name: 'content',
        label: 'Content',
        type: 'collection',
        format: 'mdx',
        children: [
          {
            path: unsafeAsLogicalPath('content/docs'),
            name: 'docs',
            label: 'Documentation',
            type: 'collection',
            format: 'mdx',
            children: [
              {
                path: unsafeAsLogicalPath('content/docs/guides'),
                name: 'guides',
                label: 'Guides',
                type: 'collection',
                format: 'mdx',
              },
            ],
          },
        ],
      },
    ]

    const result = buildCollectionLabels(collections)

    expect(result.get('content')).toBe('Content')
    expect(result.get('content/docs')).toBe('Documentation')
    expect(result.get('content/docs/guides')).toBe('Guides')
  })
})

describe('buildBreadcrumbSegments', () => {
  it('returns only "All Files" when no entry is provided', () => {
    const labels = new Map<string, string>()
    expect(buildBreadcrumbSegments(undefined, labels)).toEqual(['All Files'])
  })

  it('returns only "All Files" for entry without collectionPath', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('test'),
      label: 'Test',
      schema: [],
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map<string, string>()
    expect(buildBreadcrumbSegments(entry, labels)).toEqual(['All Files'])
  })

  it('returns "All Files" for single-level collection (root level)', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('posts/hello'),
      label: 'Hello',
      schema: [],
      collectionPath: unsafeAsLogicalPath('posts'),
      slug: 'hello',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([['posts', 'Posts']])
    // Single-level collection: parts = ['posts'], loop starts at i=1 which is >= length, so no segments added
    expect(buildBreadcrumbSegments(entry, labels)).toEqual(['All Files'])
  })

  it('shows hierarchy for nested collections', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/docs/guides/config'),
      label: 'Configuration Guide',
      schema: [],
      collectionPath: unsafeAsLogicalPath('content/docs/guides'),
      slug: 'config',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/docs', 'Documentation'],
      ['content/docs/guides', 'Guides'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    // Should include: All Files, Documentation, Guides (skips 'Content' which is the root)
    expect(result).toEqual(['All Files', 'Documentation', 'Guides'])
  })

  it('shows hierarchy for deeply nested collections', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/docs/api/v2/endpoint'),
      label: 'Endpoint',
      schema: [],
      collectionPath: unsafeAsLogicalPath('content/docs/api/v2'),
      slug: 'endpoint',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/docs', 'Documentation'],
      ['content/docs/api', 'API Reference'],
      ['content/docs/api/v2', 'Version 2'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    expect(result).toEqual(['All Files', 'Documentation', 'API Reference', 'Version 2'])
  })

  it('skips missing labels in hierarchy', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/docs/guides/config'),
      label: 'Configuration Guide',
      schema: [],
      collectionPath: unsafeAsLogicalPath('content/docs/guides'),
      slug: 'config',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([
      ['content', 'Content'],
      // 'content/docs' is missing
      ['content/docs/guides', 'Guides'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    // Should skip the missing 'Documentation' segment
    expect(result).toEqual(['All Files', 'Guides'])
  })

  it('includes slug path segments for nested slugs', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('posts/2024/01/new-year'),
      label: 'New Year Post',
      schema: [],
      collectionPath: unsafeAsLogicalPath('posts'),
      slug: '2024/01/new-year',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([['posts', 'Posts']])

    const result = buildBreadcrumbSegments(entry, labels)

    // Should include slug path segments (minus the last one which is the file name)
    expect(result).toEqual(['All Files', '2024', '01'])
  })

  it('combines collection hierarchy and slug segments', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/posts/2024/01/new-year'),
      label: 'New Year Post',
      schema: [],
      collectionPath: unsafeAsLogicalPath('content/posts'),
      slug: '2024/01/new-year',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/posts', 'Blog Posts'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    // Collection hierarchy + slug segments
    expect(result).toEqual(['All Files', 'Blog Posts', '2024', '01'])
  })

  it('works for root entry types with maxItems: 1', () => {
    const entry: EditorEntry = {
      path: unsafeAsLogicalPath('content/settings'),
      label: 'Site Settings',
      schema: [],
      collectionPath: unsafeAsLogicalPath('content/settings'),
      type: 'entry',
      contentId: unsafeAsContentId('test123456789'),
    }
    const labels = new Map([
      ['content', 'Content'],
      ['content/settings', 'Settings'],
    ])

    const result = buildBreadcrumbSegments(entry, labels)

    expect(result).toEqual(['All Files', 'Settings'])
  })
})

describe('calculatePathToEntry', () => {
  it('returns empty object when no entry ID is provided', () => {
    const treeData: TreeNodeData[] = []
    expect(calculatePathToEntry(undefined, treeData)).toEqual({})
    expect(calculatePathToEntry('', treeData)).toEqual({})
  })

  it('returns empty object when entry is not found in tree', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [{ value: 'posts/hello', label: 'Hello' }],
      },
    ]
    expect(calculatePathToEntry('posts/nonexistent', treeData)).toEqual({})
  })

  it('returns empty object for flat list (no collections)', () => {
    const treeData: TreeNodeData[] = [
      { value: 'entry1', label: 'Entry 1' },
      { value: 'entry2', label: 'Entry 2' },
    ]
    expect(calculatePathToEntry('entry1', treeData)).toEqual({})
  })

  it('expands single parent collection', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [
          { value: 'posts/hello', label: 'Hello' },
          { value: 'posts/world', label: 'World' },
        ],
      },
    ]

    const result = calculatePathToEntry('posts/hello', treeData)

    expect(result).toEqual({
      'collection:posts': true,
    })
  })

  it('expands all ancestor collections for deeply nested entry', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:content',
        label: 'Content',
        children: [
          {
            value: 'collection:content/docs',
            label: 'Documentation',
            children: [
              {
                value: 'collection:content/docs/api',
                label: 'API Reference',
                children: [
                  {
                    value: 'collection:content/docs/api/v1',
                    label: 'v1',
                    children: [
                      {
                        value: 'content/docs/api/v1/endpoint',
                        label: 'Endpoint',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]

    const result = calculatePathToEntry('content/docs/api/v1/endpoint', treeData)

    expect(result).toEqual({
      'collection:content': true,
      'collection:content/docs': true,
      'collection:content/docs/api': true,
      'collection:content/docs/api/v1': true,
    })
  })

  it('expands path across multiple root collections', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [{ value: 'posts/hello', label: 'Hello' }],
      },
      {
        value: 'collection:content',
        label: 'Content',
        children: [
          {
            value: 'collection:content/docs',
            label: 'Documentation',
            children: [{ value: 'content/docs/guide', label: 'Guide' }],
          },
        ],
      },
    ]

    const result = calculatePathToEntry('content/docs/guide', treeData)

    // Should only expand collections in the path, not sibling trees
    expect(result).toEqual({
      'collection:content': true,
      'collection:content/docs': true,
    })
  })

  it('handles entry at root level within collection', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [
          { value: 'posts/entry1', label: 'Entry 1' },
          {
            value: 'collection:posts/nested',
            label: 'Nested',
            children: [{ value: 'posts/nested/entry2', label: 'Entry 2' }],
          },
        ],
      },
    ]

    const result = calculatePathToEntry('posts/entry1', treeData)

    expect(result).toEqual({
      'collection:posts': true,
    })
  })

  it('does not expand unrelated collections', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:posts',
        label: 'Posts',
        children: [{ value: 'posts/hello', label: 'Hello' }],
      },
      {
        value: 'collection:pages',
        label: 'Pages',
        children: [{ value: 'pages/about', label: 'About' }],
      },
      {
        value: 'collection:content',
        label: 'Content',
        children: [
          {
            value: 'collection:content/docs',
            label: 'Documentation',
            children: [{ value: 'content/docs/guide', label: 'Guide' }],
          },
        ],
      },
    ]

    const result = calculatePathToEntry('pages/about', treeData)

    // Should only expand 'pages', not 'posts' or 'content' or 'content/docs'
    expect(result).toEqual({
      'collection:pages': true,
    })
  })

  it('handles complex tree with mixed entries and collections', () => {
    const treeData: TreeNodeData[] = [
      {
        value: 'collection:blog',
        label: 'Blog',
        children: [
          { value: 'blog/post1', label: 'Post 1' },
          {
            value: 'collection:blog/featured',
            label: 'Featured',
            children: [
              { value: 'blog/featured/post2', label: 'Post 2' },
              {
                value: 'collection:blog/featured/archive',
                label: 'Archive',
                children: [{ value: 'blog/featured/archive/post3', label: 'Post 3' }],
              },
            ],
          },
          { value: 'blog/post4', label: 'Post 4' },
        ],
      },
    ]

    // Find entry deep in the tree
    const result = calculatePathToEntry('blog/featured/archive/post3', treeData)

    expect(result).toEqual({
      'collection:blog': true,
      'collection:blog/featured': true,
      'collection:blog/featured/archive': true,
    })
  })
})
