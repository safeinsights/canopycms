import { describe, expect, it } from 'vitest'

import { flattenSchema, type RootCollectionConfig } from './config'
import { entryRefFromRepoPath } from './content-listing'

const ID = 'aB3cD4eF5gH6'
const ID2 = 'zY9xW8vU7tS6'
const COL = 'q52DCVPuH4ga'
const NESTED = 'Kp3Lm4Nq5Rs6'

const fields = [{ name: 'title', type: 'string' as const }]
const schema: RootCollectionConfig = {
  entries: [{ name: 'page', format: 'json', schema: fields }],
  collections: [
    {
      name: 'blog',
      path: 'blog',
      entries: [
        { name: 'post', format: 'md', schema: fields },
        { name: 'note', format: 'yaml', schema: fields },
      ],
    },
    {
      name: 'docs',
      path: 'docs',
      entries: [{ name: 'doc', format: 'mdx', schema: fields }],
      collections: [
        {
          name: 'api',
          path: 'docs/api',
          entries: [{ name: 'doc', format: 'json', schema: fields }],
        },
      ],
    },
  ],
}
const flat = flattenSchema(schema, 'content')
const map = (repoPath: string, contentRoot = 'content') =>
  entryRefFromRepoPath(repoPath, flat, contentRoot)

describe('entryRefFromRepoPath', () => {
  it('maps an entry in a collection directory with an id', () => {
    expect(map(`content/blog.${COL}/post.hello.${ID}.md`)).toEqual({
      kind: 'entry',
      logicalPath: 'content/blog/hello',
      contentId: ID,
      entryType: 'post',
      collectionPath: 'content/blog',
      physicalPath: `content/blog.${COL}/post.hello.${ID}.md`,
    })
  })

  it('maps an entry in a collection directory without an id, and in the root collection', () => {
    expect(map(`content/blog/post.hello.${ID}.md`)).toMatchObject({
      kind: 'entry',
      logicalPath: 'content/blog/hello',
    })
    expect(map(`content/page.home.${ID}.json`)).toMatchObject({
      kind: 'entry',
      logicalPath: 'content/home',
      collectionPath: 'content',
    })
  })

  it('keeps a dotted slug whole, lowercased', () => {
    expect(map(`content/blog.${COL}/post.Getting.Started.v2.${ID}.md`)).toMatchObject({
      kind: 'entry',
      logicalPath: 'content/blog/getting.started.v2',
      contentId: ID,
    })
  })

  it('maps a nested collection, and two entry types of one collection by their own extension', () => {
    expect(map(`content/docs.${COL}/api.${NESTED}/doc.endpoints.${ID}.json`)).toMatchObject({
      kind: 'entry',
      logicalPath: 'content/docs/api/endpoints',
      collectionPath: 'content/docs/api',
      entryType: 'doc',
    })
    expect(map(`content/docs.${COL}/doc.intro.${ID}.mdx`)).toMatchObject({
      collectionPath: 'content/docs',
    })
    expect(map(`content/blog.${COL}/note.memo.${ID2}.yaml`)).toMatchObject({
      kind: 'entry',
      entryType: 'note',
      contentId: ID2,
    })
    // A type's file under another type's extension is not that type's entry.
    expect(map(`content/blog.${COL}/note.memo.${ID2}.md`).kind).toBe('other')
  })

  it('maps .collection.json at the root and nested to its collection', () => {
    expect(map('content/.collection.json')).toEqual({
      kind: 'collection-meta',
      collectionPath: 'content',
      physicalPath: 'content/.collection.json',
    })
    expect(map(`content/docs.${COL}/api.${NESTED}/.collection.json`)).toMatchObject({
      kind: 'collection-meta',
      collectionPath: 'content/docs/api',
    })
  })

  it('compares collection directories lowercased', () => {
    expect(map(`content/Blog.${COL}/post.hello.${ID}.md`)).toMatchObject({
      kind: 'entry',
      collectionPath: 'content/blog',
    })
  })

  it.each([
    ['outside the content root', `site/blog.${COL}/post.hello.${ID}.md`],
    ['a sibling of the content root sharing its prefix', `contentx/page.home.${ID}.json`],
    ['the content root itself', 'content'],
    ['a file at the repo root', 'package.json'],
    ['an unknown collection', `content/news.${COL}/post.hello.${ID}.md`],
    ['an unknown entry type', `content/blog.${COL}/page.hello.${ID}.md`],
    ['an untyped filename', `content/blog.${COL}/hello.md`],
    ['an invalid id', 'content/blog/post.hello.BADID.md'],
    ['a README', 'content/README.md'],
    ['a dot segment', `content/./blog/post.hello.${ID}.md`],
    ['a parent segment', `content/../content/page.home.${ID}.json`],
    ['an empty segment', `content//page.home.${ID}.json`],
    ['a directory path', `content/blog.${COL}/`],
  ])('maps %s to other', (_name, repoPath) => {
    const ref = map(repoPath)
    expect(ref.kind).toBe('other')
  })

  it('strips a leading ./ and a trailing slash before mapping', () => {
    expect(map(`./content/page.home.${ID}.json`)).toMatchObject({
      kind: 'entry',
      physicalPath: `content/page.home.${ID}.json`,
    })
    expect(map(`content/page.home.${ID}.json/`)).toMatchObject({ kind: 'entry' })
  })

  it('keeps unicode and spaces in a slug', () => {
    expect(map(`content/blog.${COL}/post.café au lait.${ID}.md`)).toMatchObject({
      kind: 'entry',
      logicalPath: 'content/blog/café au lait',
    })
  })

  it('honours a nested content root and an empty one', () => {
    const nested = flattenSchema(schema, 'site/content')
    expect(
      entryRefFromRepoPath(`site/content/page.home.${ID}.json`, nested, 'site/content'),
    ).toMatchObject({ kind: 'entry', logicalPath: 'site/content/home' })
    expect(entryRefFromRepoPath(`content/page.home.${ID}.json`, nested, 'site/content').kind).toBe(
      'other',
    )
    const bare = flattenSchema(schema, '')
    expect(entryRefFromRepoPath(`blog/post.hello.${ID}.md`, bare, '')).toMatchObject({
      kind: 'entry',
      logicalPath: 'blog/hello',
    })
  })
})
