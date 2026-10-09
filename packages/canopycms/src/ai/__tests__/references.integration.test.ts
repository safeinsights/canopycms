import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../../config-test'
import { flattenSchema } from '../../config'
import { ContentStore } from '../../content-store'
import { extractIdFromFilename } from '../../content-id-index'
import { unsafeAsLogicalPath, unsafeAsSlug } from '../../paths/test-utils'
import { generateAIContent } from '../generate'
import type { AIContentConfig, AIEntry, AIReferenceValue } from '../types'

const authorRef = {
  name: 'author',
  type: 'reference' as const,
  label: 'Author',
  collections: ['people', 'drafts'],
}

const schema = {
  collections: [
    {
      name: 'people',
      path: 'people',
      entries: [
        {
          name: 'person',
          label: 'Person',
          format: 'json' as const,
          default: true,
          schema: [{ name: 'fullName', type: 'string' as const, isTitle: true }],
        },
      ],
    },
    {
      name: 'drafts',
      path: 'drafts',
      entries: [
        {
          name: 'person',
          label: 'Person',
          format: 'json' as const,
          default: true,
          schema: [{ name: 'fullName', type: 'string' as const, isTitle: true }],
        },
      ],
    },
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'md' as const,
          default: true,
          schema: [
            { name: 'title', type: 'string' as const },
            authorRef,
            { ...authorRef, name: 'reviewers', label: 'Reviewers', list: true },
            { ...authorRef, name: 'related', label: 'Related', collections: ['posts'] },
          ],
        },
      ],
    },
    {
      name: 'pages',
      path: 'pages',
      entries: [
        {
          name: 'page',
          format: 'json' as const,
          default: true,
          schema: [
            { name: 'title', type: 'string' as const },
            {
              name: 'sections',
              type: 'block' as const,
              label: 'Sections',
              templates: [{ name: 'byline', label: 'Byline', fields: [authorRef] }],
            },
            {
              name: 'meta',
              type: 'object' as const,
              label: 'Meta',
              fields: [
                authorRef,
                {
                  name: 'credits',
                  type: 'object' as const,
                  label: 'Credits',
                  list: true,
                  fields: [
                    { name: 'role', type: 'string' as const, label: 'Role' },
                    { ...authorRef, name: 'people', label: 'People', list: true },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
} as const

/** A reference as the export renders it: the page link, then the labeled markdown copy. */
const link = (title: string, page: string, base = '/ai') =>
  `[${title}](${page}) ([markdown version](${base}${page}.md))`

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-ai-refs-'))

async function idOf(store: ContentStore, collection: string, slug: string): Promise<string> {
  const listed = await store.getCollectionEntryPaths(unsafeAsLogicalPath(collection))
  const entry = listed.find((e) => e.slug === slug)
  if (!entry) throw new Error(`entry not found: ${collection}/${slug}`)
  return extractIdFromFilename(path.basename(entry.relativePath)) as string
}

describe('generateAIContent: reference fields', () => {
  let root: string
  let flat: ReturnType<typeof flattenSchema>
  let store: ContentStore
  let ids: { alice: string; bob: string; secret: string; second: string }
  const missingId = 'zzzzzzzzzzzz'

  beforeEach(async () => {
    root = await tmpDir()
    const config = defineCanopyTestConfig({ schema })
    flat = flattenSchema(schema, config.contentRoot)
    store = new ContentStore(root, flat)
    const person = (fullName: string) => ({ format: 'json' as const, data: { fullName } })
    await store.write(
      unsafeAsLogicalPath('content/people'),
      unsafeAsSlug('alice'),
      person('Alice Example'),
    )
    await store.write(
      unsafeAsLogicalPath('content/people'),
      unsafeAsSlug('bob'),
      person('Bob Example'),
    )
    await store.write(
      unsafeAsLogicalPath('content/drafts'),
      unsafeAsSlug('secret'),
      person('Secret Draft Person'),
    )
    ids = {
      alice: await idOf(store, 'content/people', 'alice'),
      bob: await idOf(store, 'content/people', 'bob'),
      secret: await idOf(store, 'content/drafts', 'secret'),
      second: '',
    }

    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('second'), {
      format: 'md',
      data: { title: 'Second', author: ids.secret, reviewers: [ids.alice] },
      body: 'Second body.',
    })
    ids.second = await idOf(store, 'content/posts', 'second')
    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('first'), {
      format: 'md',
      data: {
        title: 'First',
        author: ids.alice,
        reviewers: [ids.bob, missingId, ids.secret],
        related: ids.second,
      },
      body: 'First body.',
    })
    await store.write(unsafeAsLogicalPath('content/pages'), unsafeAsSlug('nested'), {
      format: 'json',
      data: {
        title: 'Nested',
        sections: [{ template: 'byline', value: { author: ids.secret } }],
        meta: {
          author: ids.secret,
          credits: [{ role: 'Editor', people: [ids.alice, ids.secret] }],
        },
      },
    })
    await store.write(unsafeAsLogicalPath('content/pages'), unsafeAsSlug('about'), {
      format: 'json',
      data: {
        title: 'About',
        sections: [
          { template: 'byline', value: { author: ids.bob } },
          { template: 'byline', value: { author: missingId } },
        ],
      },
    })
    // A fresh store, so nothing the setup wrote is cached
    store = new ContentStore(root, flat)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  const generate = (config?: AIContentConfig, extra: { entryLinkUrl?: () => string } = {}) =>
    generateAIContent({ store, flatSchema: flat, contentRoot: 'content', config, ...extra })

  it('renders an md byline as a link titled by the target schema, and a list as one line', async () => {
    const { files } = await generate()
    const post = files.get('posts/first.md') ?? ''
    expect(post).toContain(`**Author:** ${link('Alice Example', '/people/alice')}`)
    expect(post).toContain(
      `**Reviewers:** ${link('Bob Example', '/people/bob')}, (missing entry ${missingId}), ${link('Secret Draft Person', '/drafts/secret')}`,
    )
    expect(files.has('people/alice.md')).toBe(true)
    expect(post).not.toContain(`**Author:** ${ids.alice}`)
  })

  it('renders a reference inside a block the same way, missing target included', async () => {
    const { files } = await generate()
    const page = files.get('pages/about.md') ?? ''
    expect(page).toContain(link('Bob Example', '/people/bob'))
    expect(page).toContain(`(missing entry ${missingId})`)
  })

  it('links a reference with entryLinkUrl when one is configured, like body entry links', async () => {
    const { files } = await generate(undefined, { entryLinkUrl: () => '/custom-url' })
    expect(files.get('posts/first.md')).toContain(
      '**Author:** [Alice Example](/custom-url) ([markdown version](/ai/people/alice.md))',
    )
  })

  it('links the markdown copy under the configured mountPath, with or without slashes', async () => {
    for (const mountPath of ['llm', '/llm/']) {
      const { files } = await generate({ mountPath })
      expect(files.get('posts/first.md')).toContain(
        `**Author:** ${link('Alice Example', '/people/alice', '/llm')}`,
      )
    }
  })

  describe('a target whose own markdown fails to render', () => {
    const failSecret: AIContentConfig['fieldTransforms'] = {
      person: {
        fullName: (value) => {
          if (value === 'Secret Draft Person') throw new Error('transform failed')
          return String(value)
        },
      },
    }
    let warn: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    const warnedAbout = (slug: string) =>
      warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes(`"${slug}"`)).length

    it('is masked, so no link points at a file the export did not write', async () => {
      const { files } = await generate({ fieldTransforms: failSecret })
      expect(files.has('drafts/secret.md')).toBe(false)
      expect(warnedAbout('secret')).toBe(1)
      expect(files.get('posts/second.md')).toContain(
        `**Author:** (unavailable entry ${ids.secret})`,
      )
      for (const [file, content] of files) {
        expect(content, file).not.toContain('/drafts/secret')
        expect(content, file).not.toContain('Secret Draft Person')
      }
    })

    it('masks in turn an entry that then fails because of that masking', async () => {
      const { files } = await generate({
        fieldTransforms: {
          ...failSecret,
          post: {
            author: (value) => {
              if ((value as AIReferenceValue).unavailable) throw new Error('needs an author')
              return 'AUTHOR'
            },
          },
        },
      })
      expect(files.has('posts/second.md')).toBe(false)
      expect(warnedAbout('second')).toBe(1)
      const first = files.get('posts/first.md') ?? ''
      expect(first).toContain(`**Related:** (unavailable entry ${ids.second})`)
      for (const [file, content] of files) {
        expect(content, file).not.toContain('/posts/second')
      }
    })

    it('reruns the entry transforms of entries it masks in, and only theirs', async () => {
      const transformed: string[] = []
      const { files } = await generate({
        fieldTransforms: failSecret,
        entryTransforms: {
          post: (entry) => {
            transformed.push(entry.slug)
            const author = entry.data.author as AIReferenceValue | undefined
            return author && !author.unavailable
              ? `Written by ${String(author.fullName)}`
              : undefined
          },
          page: (entry) => void transformed.push(entry.slug),
        },
      })
      expect(files.get('posts/first.md')).toContain('Written by Alice Example')
      for (const [file, content] of files) {
        expect(content, file).not.toContain('Secret Draft Person')
      }
      // `about` references nothing that failed, so its transform runs once
      expect(transformed.filter((slug) => slug === 'about')).toHaveLength(1)
      expect(transformed.filter((slug) => slug === 'second')).toHaveLength(2)
    })
  })

  describe('a target the export leaves out', () => {
    const exclusions: Array<[string, AIContentConfig]> = [
      ['an excluded collection', { exclude: { collections: ['drafts'] } }],
      [
        'an exclude.where predicate',
        { exclude: { where: (e) => e.data.fullName === 'Secret Draft Person' } },
      ],
    ]

    for (const [how, exclude] of exclusions) {
      it(`shows as unavailable and its title appears nowhere, when left out by ${how}`, async () => {
        const config: AIContentConfig = {
          ...exclude,
          bundles: [{ name: 'everything', filter: {} }],
        }
        const { files } = await generate(config)

        const second = files.get('posts/second.md') ?? ''
        expect(second).toContain(`**Author:** (unavailable entry ${ids.secret})`)
        expect(files.get('posts/first.md')).toContain(`(unavailable entry ${ids.secret})`)
        expect(files.has('bundles/everything.md')).toBe(true)
        expect(files.has('posts/all.md')).toBe(true)
        expect(files.has('manifest.json')).toBe(true)
        for (const [file, content] of files) {
          expect(content, file).not.toContain('Secret Draft Person')
          expect(content, file).not.toContain('/drafts/secret')
        }
      })
    }

    it('is masked inside blocks, objects and object lists too', async () => {
      const shown = (await generate()).files.get('pages/nested.md') ?? ''
      expect(shown.match(/\[Secret Draft Person\]\(\/drafts\/secret\)/g)).toHaveLength(3)

      const { files } = await generate({ exclude: { collections: ['drafts'] } })
      const page = files.get('pages/nested.md') ?? ''
      expect(page.match(new RegExp(`\\(unavailable entry ${ids.secret}\\)`, 'g'))).toHaveLength(3)
      expect(page).toContain(link('Alice Example', '/people/alice'))
      expect(page).not.toContain('Secret Draft Person')
    })

    it('reaches entry transforms and field transforms already masked', async () => {
      const seen: unknown[] = []
      const config: AIContentConfig = {
        exclude: { collections: ['drafts'] },
        fieldTransforms: { post: { author: (value) => (seen.push(value), 'AUTHOR') } },
        entryTransforms: { post: (entry: AIEntry) => void seen.push(entry.data.author) },
      }
      await generate(config)
      expect(seen).toContainEqual({ id: ids.secret, unavailable: true, reason: 'excluded' })
      expect(JSON.stringify(seen)).not.toContain('Secret Draft Person')
    })
  })

  it('hands exclude.where and transforms the resolved target, not the stored id', async () => {
    const authors: AIReferenceValue[] = []
    const config: AIContentConfig = {
      exclude: {
        where: (e) => {
          if (e.entryType === 'post') authors.push(e.data.author as AIReferenceValue)
          return false
        },
      },
    }
    await generate(config)
    const alice = authors.find((a) => a.id === ids.alice)
    expect(alice).toMatchObject({
      id: ids.alice,
      fullName: 'Alice Example',
      slug: 'alice',
      urlPath: '/people/alice',
    })
    expect(alice?.unavailable).toBeUndefined()
  })

  it('reads each target once per run, and a later run sees the target as it is now', async () => {
    const spy = vi.spyOn(store, 'resolveReferenceTarget')
    await generate()
    const aliceReads = spy.mock.calls.filter(([id]) => id === ids.alice).length
    expect(aliceReads).toBe(1)

    await store.write(unsafeAsLogicalPath('content/people'), unsafeAsSlug('alice'), {
      format: 'json',
      data: { fullName: 'Alice Renamed' },
    })
    const { files } = await generate()
    expect(files.get('posts/first.md')).toContain(
      `**Author:** ${link('Alice Renamed', '/people/alice')}`,
    )
  })
})
